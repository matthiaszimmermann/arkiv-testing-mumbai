// How many entity creates fit in a block, at whatever block gas limit the chain has right now.
//
// Sends batches of 10 creates, each batch one transaction, at a rate that climbs: one batch per
// block for a few blocks, then two, then three, and so on. Batches sent together don't all land in
// the same block, so blocks below capacity take more or fewer than the rate. Past capacity a
// backlog builds up in the pool and fills every block, and the run stops once RAMP_FULL_BLOCKS
// consecutive blocks are at least RAMP_FULL percent full.
// A line per block shows what it holds: transactions, entities, bytes, gas and fees, for every
// sender's transactions, not only this run's.
//
// Every entity has 5 attributes: category, priority and author indexed; a title, and a payload of
// 300 random bytes.
//
//   bun experiment/ramp.ts
//
// Everything it prints is also written to results/ramp-<time>.log.
//
// One sender may have at most 16 transactions pending, fewer than fill a block. So the batches go
// out from several senders, derived from the ARKIV_KEYSTORE key in memory, funded from it at the
// start and paid back at the end. They are never stored; the same key derives them again.
//
// Settings come from the environment; bun reads .env, which git ignores (see .env.example):
//
// - ARKIV_RPC_URL, ARKIV_CHAIN_ID, ARKIV_RPC_ACCESS_KEY and ARKIV_KEYSTORE: as for tokenomics.ts.
// - RAMP_STEP_BLOCKS: how many blocks each rate lasts before the next (default 3).
// - RAMP_FULL and RAMP_FULL_BLOCKS: the stop, so many consecutive blocks at least so full, in
//   percent (default 90 and 2).
// - RAMP_BUDGET: the GLM after which the run stops early (default 1). The senders get twice as
//   much: the node takes a transaction only if its sender can pay for it and for all the sender's
//   pending ones at their highest fee.
// - RAMP_SENDERS: how many senders (default: enough for 8 batches each per full block).
// - RAMP_MAX_BLOCKS: the most blocks the run lasts (default 300).
// - LIFETIME: how long the entities live, in blocks (default 100).
// - GLM_USD prices the fees in dollars (default 0.1).

import {
  addr,
  createWalletClient,
  defineSchema,
  ExpirationTime,
  str,
  u64,
  bytes as bytesColumn,
  type TxParams,
} from "@arkiv-network/sdk-next"
import { appendFileSync, existsSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import {
  BlockNotFoundError,
  concat,
  createPublicClient,
  createWalletClient as createViemWalletClient,
  defineChain,
  http,
  HttpRequestError,
  keccak256,
  toEventSelector,
  toHex,
  TransactionReceiptNotFoundError,
  type Hex,
} from "viem"
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts"
import { estimateMaxPriorityFeePerGas } from "viem/actions"
import { unlock } from "./keystore"

// The log, the redaction of the access key and the handling of refusals work as in tokenomics.ts.
const RESULTS = resolve(`${import.meta.dir}/../results`)
const LOG = `${RESULTS}/ramp-${new Date().toISOString().replace(/\.\d+Z$/, "Z").replaceAll(":", "-")}.log`
let accessKey = ""
const redact = (text: string) => (accessKey ? text.replaceAll(accessKey, "<access key>") : text)
let logging = false
const print = console.log
console.log = (...args: unknown[]) => {
  const text = redact(args.map(String).join(" "))
  print(text)
  if (logging) appendFileSync(LOG, `${text}\n`)
}

let refusal: string | undefined
function refusedBy(error: unknown): string | undefined {
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (e instanceof HttpRequestError) return refusal ?? `${e.status} ${e.details}`
  }
}

process.on("uncaughtException", (error) => {
  const refused = refusedBy(error)
  if (refused) console.log(`stopped: the RPC refused a request: ${refused}`)
  else console.log(`stopped: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  process.exit(2)
})

function fail(message: string): never {
  console.log(`refusing to run: ${message}`)
  process.exit(2)
}

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) fail(`${name} is not set; see .env.example`)
  return value
}

function positiveNumber(name: string, fallback: number): number {
  const value = process.env[name] ?? fallback
  const n = Number(value)
  if (!(n > 0) || !Number.isFinite(n)) fail(`${name} is ${value}, not a positive number`)
  return n
}

// The publicly known dev keys, refused as in tokenomics.ts.
const DEV_MNEMONIC = "test test test test test test test test test test test junk"
const DEV_ADDRESSES = new Set(
  Array.from({ length: 20 }, (_, i) => mnemonicToAccount(DEV_MNEMONIC, { addressIndex: i }).address.toLowerCase()),
)

const RPC_ACCESS_KEY = process.env.ARKIV_RPC_ACCESS_KEY?.trim()
const RPC_URL = RPC_ACCESS_KEY
  ? `${required("ARKIV_RPC_URL").replace(/\/+$/, "")}/${encodeURIComponent(RPC_ACCESS_KEY)}`
  : required("ARKIV_RPC_URL")
try {
  accessKey = new URL(RPC_URL).pathname.replace(/^\/+|\/+$/g, "")
} catch {
  fail(`ARKIV_RPC_URL is not a URL`)
}
const CHAIN_ID = positiveNumber("ARKIV_CHAIN_ID", Number(required("ARKIV_CHAIN_ID")))
const KEYSTORE = resolve(required("ARKIV_KEYSTORE"))
if (!existsSync(KEYSTORE)) fail(`ARKIV_KEYSTORE is ${KEYSTORE}, which does not exist; make one with experiment/new-wallet.ts`)
const STEP_BLOCKS = Math.ceil(positiveNumber("RAMP_STEP_BLOCKS", 3))
const FULL = positiveNumber("RAMP_FULL", 90)
const FULL_BLOCKS = Math.ceil(positiveNumber("RAMP_FULL_BLOCKS", 2))
const BUDGET = BigInt(Math.round(positiveNumber("RAMP_BUDGET", 1) * 1e9)) * 1_000_000_000n
const MAX_BLOCKS = Math.ceil(positiveNumber("RAMP_MAX_BLOCKS", 300))
const LIFETIME = Math.ceil(positiveNumber("LIFETIME", 100))
const GLM_USD = Number(process.env.GLM_USD ?? 0.1)

// The key, decrypted into memory once every other setting is checked.
let FUNDED_KEY: Hex
try {
  FUNDED_KEY = await unlock(KEYSTORE)
} catch (error) {
  fail(`ARKIV_KEYSTORE ${KEYSTORE}: ${error instanceof Error ? error.message : String(error)}`)
}
const account = privateKeyToAccount(FUNDED_KEY)
if (DEV_ADDRESSES.has(account.address.toLowerCase())) {
  fail("ARKIV_KEYSTORE holds one of the publicly known dev keys; use a key of your own")
}

mkdirSync(RESULTS, { recursive: true })
logging = true

const BATCH = 10
const PAYLOAD = 300
// reth's pool takes at most 16 pending transactions per sender; a sender gets at most 8 a block,
// so that a block's worth can wait behind another.
const MAX_PENDING = 16
const PER_SENDER = 8

const schema = defineSchema({
  category: str().indexed(),
  priority: u64().indexed(),
  author: addr().indexed(),
  title: str(),
  payload: bytesColumn(),
})
const createsFrom = (author: Hex, label: string) =>
  Array.from({ length: BATCH }, (_, i) => ({
    schema,
    values: {
      category: "documents",
      priority: u64(BigInt(i % 3)),
      author: addr(author),
      title: `ramp ${label}-${i}`,
      payload: crypto.getRandomValues(new Uint8Array(PAYLOAD)),
    },
    expiration: ExpirationTime.fromBlocks(LIFETIME),
  }))

// viem retries a rate-limited request without a word, which makes a run crawl; say so, once.
let rateLimited = false
const onFetchResponse = async (response: Response) => {
  if (response.ok) return
  refusal = `${response.status} ${(await response.clone().text()).trim().slice(0, 500)}`
  if (response.status === 429 && !rateLimited) {
    rateLimited = true
    console.log(`the RPC rate limits this run, so it will be slow: ${refusal}`)
  }
}
// Sends go one per request: a batch of them would pass the RPC's 256 KiB limit. Reads made
// together go in one request, so a block's receipts cost one round trip.
const transport = http(RPC_URL, { retryCount: 8, retryDelay: 250, onFetchResponse })
const readTransport = http(RPC_URL, { retryCount: 8, retryDelay: 250, onFetchResponse, batch: { batchSize: 100 } })
const chainId = await createPublicClient({ transport }).getChainId()
if (chainId !== CHAIN_ID) fail(`${RPC_URL} serves chain ${chainId}, not ARKIV_CHAIN_ID ${CHAIN_ID}`)
const chain = defineChain({
  id: chainId,
  name: `arkiv-${chainId}`,
  nativeCurrency: { name: "Golem", symbol: "GLM", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
})
const reader = createPublicClient({ chain, transport: readTransport })

// The RPC answers from several nodes, not always at the same height: a block or receipt one of them
// has just reported may be missing on the next. So "not found" is asked again for up to 5 s.
async function untilFound<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read()
    } catch (error) {
      const notFound = error instanceof BlockNotFoundError || error instanceof TransactionReceiptNotFoundError
      if (!notFound || attempt === 20) throw error
      await Bun.sleep(250)
    }
  }
}

const fmt = (n: bigint | number) => n.toLocaleString("en-US")
const glm = (wei: bigint) => (Number(wei / 1_000_000_000n) / 1e9).toFixed(6)
const usd = (wei: bigint) => `$${((Number(wei / 1_000_000_000n) / 1e9) * GLM_USD).toFixed(4)}`
const gwei = (wei: bigint) => (Number(wei) / 1e9).toFixed(4)
const line = (cells: [string, number][]) => cells.map(([text, width]) => text.padStart(width)).join(" ")

// Every message in an error's chain, for matching what the node said.
function said(error: unknown): string {
  const messages: string[] = []
  for (let e: unknown = error; e instanceof Error; e = e.cause) messages.push(e.message)
  return messages.join(" ")
}
const describe = (error: unknown) => {
  const refused = refusedBy(error)
  return `${said(error).split("\n")[0]}${refused ? ` (the RPC answered ${refused})` : ""}`
}

const head = await reader.getBlock()
const startBalance = await reader.getBalance({ address: account.address })
if (startBalance < 2n * BUDGET) fail(`the sender has ${glm(startBalance)} GLM, less than twice RAMP_BUDGET`)
const TIP = await estimateMaxPriorityFeePerGas(reader as never)
const owner = createWalletClient({ chain, transport, account })
const funder = createViemWalletClient({ chain, transport, account })

console.log(
  `${new Date().toISOString()}, log ${LOG}\n` +
    `node ${RPC_URL}, chain ${chainId}, block ${fmt(head.number)}, block gas limit ${fmt(head.gasLimit)}, ` +
    `base fee ${gwei(head.baseFeePerGas ?? 0n)} gwei\n` +
    `sender ${account.address}, balance ${glm(startBalance)} GLM; tip ${gwei(TIP)} gwei; GLM at $${GLM_USD}\n` +
    `batches of ${BATCH} creates: category, priority, author indexed; title; payload of ${PAYLOAD} bytes; ` +
    `lifetime ${fmt(LIFETIME)} blocks`,
)

// One batch sent the usual way, for the gas limit of the rest: with gas, nonce and fees all given,
// a send is one request, with no estimate before it. The same batch needs more gas from one sender
// than from another, 1.11M to 1.16M when tried, so the limit is the node's estimate for the probe
// plus 25%. A batch pays only for the gas it uses; the margin costs at most the end of a block,
// as the builder skips a transaction whose gas limit is more than its block has left.
const probe = await owner.executeBatch({ creates: createsFrom(account.address, "probe") } as never)
const probeReceipt = await untilFound(() => reader.getTransactionReceipt({ hash: probe.txHash }))
const probeTx = await reader.getTransaction({ hash: probe.txHash })
const GAS = (probeTx.gas * 125n) / 100n
const perBlock = Number(head.gasLimit / probeReceipt.gasUsed)
const SENDERS = process.env.RAMP_SENDERS
  ? Math.ceil(positiveNumber("RAMP_SENDERS", 1))
  : Math.max(1, Math.ceil(perBlock / PER_SENDER))
console.log(
  `probe: ${fmt(probeReceipt.gasUsed)} gas used, ${fmt(probeReceipt.gasUsed / BigInt(BATCH))} per entity, ` +
    `${fmt(probeTx.gas)} estimated; batches get ${fmt(GAS)}; about ${perBlock} fit a block of ${fmt(head.gasLimit)}\n` +
    `ramp: 1 batch a block, one more every ${STEP_BLOCKS} blocks; ` +
    `stops after ${FULL_BLOCKS} blocks in a row at least ${FULL}% full, ${MAX_BLOCKS} blocks or ${glm(BUDGET)} GLM`,
)

// The senders, each with an equal share of twice the budget.
type Sender = {
  address: Hex
  account: ReturnType<typeof privateKeyToAccount>
  wallet: ReturnType<typeof createWalletClient>
  nonce: number
  pending: number
}
const senders: Sender[] = []
const share = (2n * BUDGET) / BigInt(SENDERS)
for (let i = 0; i < SENDERS; i++) {
  const senderAccount = privateKeyToAccount(keccak256(concat([FUNDED_KEY, toHex(`ramp sender ${i}`)])))
  const hash = await funder.sendTransaction({ to: senderAccount.address, value: share })
  await reader.waitForTransactionReceipt({ hash })
  senders.push({
    address: senderAccount.address,
    account: senderAccount,
    wallet: createWalletClient({ chain, transport, account: senderAccount }),
    nonce: await reader.getTransactionCount({ address: senderAccount.address, blockTag: "pending" }),
    pending: 0,
  })
}
const ours = new Set(senders.map((s) => s.address.toLowerCase()))
console.log(`${SENDERS} senders, ${glm(share)} GLM each: ${senders.map((s) => s.address).join(", ")}\n`)

// One batch from `sender`, sent until it is mined: a nonce left unused would hold back every batch
// after it. A send the RPC refuses is sent again with the same nonce, up to 3 times; a nonce the
// node already has then means an earlier attempt got through. Any other error, such as a revert,
// is a failure, and stops the run.
let failed = 0
async function send(sender: Sender, maxFeePerGas: bigint) {
  const nonce = sender.nonce++
  const tx = { gas: GAS, nonce, maxFeePerGas, maxPriorityFeePerGas: TIP } as TxParams
  sender.pending++
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await sender.wallet.executeBatch({ creates: createsFrom(sender.address, `${nonce}`) } as never, tx)
        return
      } catch (error) {
        if (attempt > 1 && /nonce too low|lower than the current nonce|already known/i.test(said(error))) return
        if (attempt === 3 || !refusedBy(error)) {
          failed++
          console.log(`batch from ${sender.address} with nonce ${nonce} failed: ${describe(error)}`)
          return
        }
        await Bun.sleep(1000 * attempt)
      }
    }
  } finally {
    sender.pending--
  }
}

// The next sender in turn with room in the pool, if any.
let next = 0
function nextSender(): Sender | undefined {
  for (let tried = 0; tried < SENDERS; tried++) {
    const sender = senders[next++ % SENDERS]!
    if (sender.pending < MAX_PENDING) return sender
  }
}

const ENTITY_CREATED = toEventSelector("EntityCreated(bytes32,address,uint64,uint8)")
const ARKIV_ADDRESS = "0x4400000000000000000000000000000000000044"

console.log(
  line([["block", 9], ["#tx", 4], ["entities", 8], ["bytes", 9], ["gasLimit", 11], ["gasUsed", 11], ["gas/entity", 10],
    ["full", 6], ["base fee", 9], ["fee (GLM)", 10], ["fee (USD)", 9]]),
)

// One block's line.
let spent = 0n
async function report(number: bigint) {
  const block = await untilFound(() => reader.getBlock({ blockNumber: number, includeTransactions: true }))
  const receipts = await Promise.all(
    block.transactions.map((tx) => untilFound(() => reader.getTransactionReceipt({ hash: tx.hash }))),
  )
  const entities = receipts
    .flatMap((r) => r.logs)
    .filter((l) => l.address.toLowerCase() === ARKIV_ADDRESS && l.topics[0] === ENTITY_CREATED).length
  const fee = receipts.reduce((sum, r) => sum + r.gasUsed * r.effectiveGasPrice, 0n)
  spent += receipts.filter((r) => ours.has(r.from.toLowerCase())).reduce((sum, r) => sum + r.gasUsed * r.effectiveGasPrice, 0n)
  const full = Number((block.gasUsed * 1000n) / block.gasLimit) / 10
  console.log(
    line([[fmt(number), 9], [String(block.transactions.length), 4], [fmt(entities), 8], [fmt(block.size), 9],
      [fmt(block.gasLimit), 11], [fmt(block.gasUsed), 11], [entities ? fmt(block.gasUsed / BigInt(entities)) : "-", 10],
      [`${full.toFixed(1)}%`, 6], [gwei(block.baseFeePerGas ?? 0n), 9], [glm(fee), 10], [usd(fee), 9]]),
  )
  return { full, baseFee: block.baseFeePerGas ?? 0n, entities }
}

// On each new block, `rate` batches go out, spread over the senders, except from senders that
// already have MAX_PENDING; then every block not yet shown is. The rate climbs by one every
// STEP_BLOCKS blocks.
const sending: Promise<void>[] = []
const first = await reader.getBlockNumber({ cacheTime: 0 })
let current = first - 1n
let shown = first - 1n
let rate = 0
let rateSince = first
let inARow = 0
let baseFee = head.baseFeePerGas ?? 0n
let saturated = false
let stop = ""
const fullRows: number[] = []
while (!stop) {
  const number = await reader.getBlockNumber({ cacheTime: 0 })
  if (number > current) {
    current = number
    if (rate === 0 || number - rateSince >= BigInt(STEP_BLOCKS)) {
      rate++
      rateSince = number
    }
    for (let i = 0; i < rate; i++) {
      const sender = nextSender()
      if (!sender) {
        if (!saturated) console.log(`every sender has ${MAX_PENDING} batches pending; sending fewer than the rate`)
        saturated = true
        break
      }
      sending.push(send(sender, 2n * baseFee + TIP))
    }
    while (shown < current && !stop) {
      shown++
      const row = await report(shown)
      baseFee = row.baseFee
      if (row.full >= FULL) {
        inARow++
        fullRows.push(row.entities)
      } else {
        inARow = 0
        fullRows.length = 0
      }
      if (inARow >= FULL_BLOCKS) stop = `${FULL_BLOCKS} blocks in a row at least ${FULL}% full`
      else if (spent >= BUDGET) stop = `spent ${glm(spent)} GLM, the budget`
      else if (shown - first >= BigInt(MAX_BLOCKS)) stop = `${MAX_BLOCKS} blocks passed`
      else if (failed > 0) stop = `${failed} batch(es) failed`
    }
  }
  await Bun.sleep(250)
}

// Batches behind a failed one wait for a nonce that never comes, so not for longer than 30 s.
console.log(`\nstopped sending: ${stop}; waiting up to 30 s for the batches still pending`)
await Promise.race([Promise.all(sending), Bun.sleep(30_000)])
const last = await reader.getBlockNumber({ cacheTime: 0 })
while (shown < last) await report(++shown)

if (fullRows.length > 0) {
  const avg = fullRows.reduce((sum, n) => sum + n, 0) / fullRows.length
  console.log(
    `\nentities per block in the ${fullRows.length} full blocks in a row: ${avg.toFixed(1)} on average, ` +
      `${Math.min(...fullRows)} to ${Math.max(...fullRows)}`,
  )
}

// What the senders have left goes back, less the transfer's fee.
for (const sender of senders) {
  const balance = await reader.getBalance({ address: sender.address })
  const block = await reader.getBlock()
  const maxFeePerGas = 2n * (block.baseFeePerGas ?? 0n) + TIP
  const gas = await reader.estimateGas({ account: sender.address, to: account.address, value: 1n })
  const value = balance - gas * maxFeePerGas
  if (value <= 0n) continue
  const wallet = createViemWalletClient({ chain, transport, account: sender.account })
  const hash = await wallet.sendTransaction({ to: account.address, value, gas, maxFeePerGas, maxPriorityFeePerGas: TIP })
  await reader.waitForTransactionReceipt({ hash })
}

const runSpent = startBalance - (await reader.getBalance({ address: account.address }))
console.log(`\nthe run spent ${glm(runSpent)} GLM (${usd(runSpent)}); log ${LOG}`)
process.exit(0)
