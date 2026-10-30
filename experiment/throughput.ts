// How many entities a batch create carries, and what it costs per entity, on a live chain.
//
// Creates entities in batches, each batch a single transaction, in two sections (SECTIONS, default
// both):
//
// - batches: each iteration sends one batch of each size in BATCH_SIZES (default 10, 50, 100, 200
//   entities). Every batch prints its gas, fee, size in bytes, its block's base fee and how long
//   it took; the section ends with averages per batch size over all iterations.
// - fill: keeps the sender's pool full for FILL_BLOCKS blocks, so many consecutive blocks are
//   filled well above the base fee's target, and shows each block's base fee as it climbs, next
//   to what EIP-1559 would set.
//
// An entity has up to 7 attributes, 3 of them indexed and one of them a body, every value small
// enough for one 32-byte ABI word. Even so the encoding takes 352 bytes per create and 192 per
// attribute, and the RPC refuses requests of 256 KiB, so a batch of 7-attribute entities carries
// at most about 75. Each batch size therefore gets the most attributes with which it still fits
// one transaction: 7 for 10 and 50, 4 for 100, 1 for 200. Sizes that fit with none are refused.
//
// Not a test: it asserts nothing about prices, so it runs against any fee schedule.
//
//   bun experiment/throughput.ts
//
// Everything it prints is also written to results/throughput-<time>.log.
//
// Settings come from the environment; bun reads .env, which git ignores (see .env.example):
//
// - ARKIV_RPC_URL, ARKIV_CHAIN_ID, ARKIV_RPC_ACCESS_KEY and ARKIV_KEYSTORE: as for tokenomics.ts.
// - ITERATIONS: how often the sequence of batch sizes is sent (default 1).
// - BATCH_SIZES: the entities per batch, comma-separated (default 10,50,100,200).
// - PARALLEL: how many batches of a size are sent at once (default 1, at most 16). With 1, each
//   batch waits for the one before it to be mined, so it has its block to itself. With more, the
//   step's batches are sent together at the start of a block, with nonces and fees set here so no
//   send waits on another, and the run shows which blocks they landed in. They come from the one
//   sender, so the block builder takes them in nonce order: one that does not fit the rest of a
//   block holds back all after it.
// - SECTIONS: batches, fill or both (default batches,fill).
// - FILL_BLOCKS: how many consecutive blocks the fill section keeps filling (default 20).
//   FILL_SIZE: the entities per fill batch (default 50; about 9 such batches fill a block).
//   FILL_BUDGET: the GLM after which it stops sending early (default 5); batches still pending
//   then land on top of it. BASE_FEE_ELASTICITY and BASE_FEE_DENOMINATOR (default 2 and 8,
//   Ethereum's): the rule the base fee is compared with.
// - LIFETIME: how long the entities live, in blocks (default 100). Storage is paid per block of
//   lifetime, so this sets much of the fee.
// - GLM_USD prices the fees in dollars (default 0.1). BLOCK_TIME_SAMPLE: how many recent blocks
//   the chain's block time is measured over (default 1000).
//
// The schema is unnamed: a named one adds an indexed `arkiv.schema` attribute to every entity.

import {
  addr,
  createPublicClient,
  createWalletClient,
  defineSchema,
  ExpirationTime,
  i32,
  str,
  u64,
  bytes as bytesColumn,
  type Schema,
  type TxParams,
} from "@arkiv-network/sdk-next"
import { appendFileSync, existsSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import {
  BlockNotFoundError,
  ContractFunctionRevertedError,
  defineChain,
  http,
  HttpRequestError,
  parseAbiItem,
  toHex,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  type Hex,
} from "viem"
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts"
import { estimateMaxPriorityFeePerGas } from "viem/actions"
import { unlock } from "./keystore"

// The log, the redaction of the access key and the handling of refusals work as in tokenomics.ts.
const RESULTS = resolve(`${import.meta.dir}/../results`)
const LOG = `${RESULTS}/throughput-${new Date().toISOString().replace(/\.\d+Z$/, "Z").replaceAll(":", "-")}.log`
let accessKey = ""
const redact = (text: string) => (accessKey ? text.replaceAll(accessKey, "<access key>") : text)
let logging = false
const print = console.log
console.log = (...args: unknown[]) => {
  const text = redact(args.map(String).join(" "))
  print(text)
  if (logging) appendFileSync(LOG, `${text}\n`)
}
function startLog() {
  mkdirSync(RESULTS, { recursive: true })
  logging = true
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

function positiveInteger(name: string, value: string | number): number {
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n <= 0) fail(`${name} is ${value}, not a positive integer`)
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
const CHAIN_ID = positiveInteger("ARKIV_CHAIN_ID", required("ARKIV_CHAIN_ID"))
const KEYSTORE = resolve(required("ARKIV_KEYSTORE"))
if (!existsSync(KEYSTORE)) fail(`ARKIV_KEYSTORE is ${KEYSTORE}, which does not exist; make one with experiment/new-wallet.ts`)
const ITERATIONS = positiveInteger("ITERATIONS", process.env.ITERATIONS ?? 1)
const BATCH_SIZES = (process.env.BATCH_SIZES ?? "10,50,100,200")
  .split(",")
  .map((s) => positiveInteger("BATCH_SIZES", s.trim()))
// reth's pool guarantees 16 pending transactions per sender.
const MAX_PENDING = 16
const PARALLEL = positiveInteger("PARALLEL", process.env.PARALLEL ?? 1)
if (PARALLEL > MAX_PENDING) fail(`PARALLEL is ${PARALLEL}; reth's pool guarantees only ${MAX_PENDING} pending transactions per sender`)
const SECTIONS = (process.env.SECTIONS ?? "batches,fill").split(",").map((s) => s.trim())
for (const section of SECTIONS) {
  if (!["batches", "fill"].includes(section)) fail(`unknown section ${section} in SECTIONS`)
}
const FILL_BLOCKS = positiveInteger("FILL_BLOCKS", process.env.FILL_BLOCKS ?? 20)
const FILL_SIZE = positiveInteger("FILL_SIZE", process.env.FILL_SIZE ?? 50)
const FILL_BUDGET = Number(process.env.FILL_BUDGET ?? 5)
if (!(FILL_BUDGET > 0)) fail(`FILL_BUDGET is ${process.env.FILL_BUDGET}, not a positive number of GLM`)
// The base fee rule the per-block table compares with: Ethereum's, a target of 1/ELASTICITY of the
// gas limit, and a change of at most 1/DENOMINATOR per block.
const BASE_FEE_ELASTICITY = positiveInteger("BASE_FEE_ELASTICITY", process.env.BASE_FEE_ELASTICITY ?? 2)
const BASE_FEE_DENOMINATOR = positiveInteger("BASE_FEE_DENOMINATOR", process.env.BASE_FEE_DENOMINATOR ?? 8)
const LIFETIME = positiveInteger("LIFETIME", process.env.LIFETIME ?? 100)
const GLM_USD = Number(process.env.GLM_USD ?? 0.1)
const BLOCK_TIME_SAMPLE = BigInt(positiveInteger("BLOCK_TIME_SAMPLE", process.env.BLOCK_TIME_SAMPLE ?? 1000))

// A batch's calldata in bytes, from the ABI layout of `execute`: 68 per batch, 352 per create and
// 192 per attribute whose value fits one 32-byte word, as every value here does. The RPC refuses
// requests of 256 KiB, in which the transaction is hex-encoded at twice its size, so the calldata
// has to stay under about 128 KiB.
const BATCH_BYTES = 68
const CREATE_BYTES = 352
const ATTRIBUTE_BYTES = 192
const MAX_CALLDATA = 130_000
const MAX_ATTRIBUTES = 7
const calldata = (size: number, attributes: number) => BATCH_BYTES + size * (CREATE_BYTES + ATTRIBUTE_BYTES * attributes)
// Per batch size, the most attributes, up to 7, with which the batch still fits.
const ATTRIBUTES = new Map(
  [...BATCH_SIZES, FILL_SIZE].map((size) => {
    let n = MAX_ATTRIBUTES
    while (n > 0 && calldata(size, n) > MAX_CALLDATA) n--
    return [size, n]
  }),
)
for (const [size, n] of ATTRIBUTES) {
  if (n === 0) {
    const most = Math.floor((MAX_CALLDATA - BATCH_BYTES) / (CREATE_BYTES + ATTRIBUTE_BYTES))
    fail(`a batch of ${size} is asked for, but at most ${most} entities fit in one transaction`)
  }
}

// The key, decrypted into memory once every other setting is checked.
let FUNDED_KEY: Hex
try {
  FUNDED_KEY = await unlock(KEYSTORE)
} catch (error) {
  fail(`ARKIV_KEYSTORE ${KEYSTORE}: ${error instanceof Error ? error.message : String(error)}`)
}
if (DEV_ADDRESSES.has(privateKeyToAccount(FUNDED_KEY).address.toLowerCase())) {
  fail("ARKIV_KEYSTORE holds one of the publicly known dev keys; use a key of your own")
}

startLog()

const BODY = 32

// The 7 attributes in the order a smaller shape keeps them: the 3 indexed, then the body, then the
// rest. No value is longer than 32 bytes.
const FIELDS: { name: string; column: () => unknown; value: (label: string, i: number, author: Hex) => unknown }[] = [
  { name: "category", column: () => str().indexed(), value: () => "documents" },
  { name: "priority", column: () => u64().indexed(), value: (_, i) => u64(BigInt(i % 3)) },
  { name: "author", column: () => addr().indexed(), value: (_, __, author) => addr(author) },
  { name: "body", column: () => bytesColumn(), value: () => crypto.getRandomValues(new Uint8Array(BODY)) },
  { name: "title", column: () => str(), value: (label, i) => `throughput ${label}-${i}` },
  { name: "summary", column: () => str(), value: () => "A small entity for batch tests." },
  { name: "version", column: () => i32(), value: () => i32(1) },
]
const INDEXED_FIELDS = 3

type Shape = {
  attributes: number
  indexed: number
  schema: Schema
  values: (label: string, i: number) => Record<string, unknown>
}

function shapeOf(attributes: number): Shape {
  const fields = FIELDS.slice(0, attributes)
  return {
    attributes,
    indexed: Math.min(attributes, INDEXED_FIELDS),
    schema: defineSchema(Object.fromEntries(fields.map((f) => [f.name, f.column()])) as never),
    values: (label, i) => Object.fromEntries(fields.map((f) => [f.name, f.value(label, i, account.address)])),
  }
}
const SHAPES = new Map([...new Set(ATTRIBUTES.values())].map((n) => [n, shapeOf(n)]))
const shapeFor = (size: number) => SHAPES.get(ATTRIBUTES.get(size)!)!

// viem retries a rate-limited request without a word, which makes a run crawl; say so, once. It
// retries 8 times, waiting 0.25 s and doubling, about a minute in all, so that a burst of sends
// waits out the access key's limit rather than failing.
let rateLimited = false
const transport = http(RPC_URL, {
  retryCount: 8,
  retryDelay: 250,
  onFetchResponse: async (response) => {
    if (response.ok) return
    refusal = `${response.status} ${(await response.clone().text()).trim().slice(0, 500)}`
    if (response.status === 429 && !rateLimited) {
      rateLimited = true
      console.log(`the RPC rate limits this run, so it will be slow: ${refusal}`)
    }
  },
})
const chainId = await createPublicClient({ transport }).getChainId()
if (chainId !== CHAIN_ID) fail(`${RPC_URL} serves chain ${chainId}, not ARKIV_CHAIN_ID ${CHAIN_ID}`)
const chain = defineChain({
  id: chainId,
  name: `arkiv-${chainId}`,
  nativeCurrency: { name: "Golem", symbol: "GLM", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
})
const publicClient = createPublicClient({ chain, transport })
const account = privateKeyToAccount(FUNDED_KEY)
const wallet = createWalletClient({ chain, transport, account })
const head = await publicClient.getBlock()
const BLOCK_GAS_LIMIT = head.gasLimit
const sampleStart = await publicClient.getBlock({
  blockNumber: head.number > BLOCK_TIME_SAMPLE ? head.number - BLOCK_TIME_SAMPLE : 0n,
})
if (head.number === sampleStart.number) fail(`chain ${chainId} has no blocks to measure the block time over`)
const BLOCK_TIME = Number(head.timestamp - sampleStart.timestamp) / Number(head.number - sampleStart.number)

type Batch = {
  size: number
  txHash: Hex
  block: bigint
  // Blocks from the one current when the batch was sent to the one it landed in.
  waited: bigint
  seconds: number
  // The transaction's calldata, in bytes.
  bytes: number
  gasLimit: bigint
  gasUsed: bigint
  fee: bigint
  // The share of its block's gas limit the whole block used, and the block's base fee.
  blockShare: number
  baseFee: bigint
  firstKey: Hex
  lastKey: Hex
  values: { first: Record<string, unknown>; last: Record<string, unknown> }
}

// The RPC answers from several nodes, not always at the same height: a block or receipt one of them
// has just reported may be missing on the next. So "not found" is asked again for up to 5 s.
async function untilFound<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await read()
    } catch (error) {
      const notFound =
        error instanceof BlockNotFoundError ||
        error instanceof TransactionReceiptNotFoundError ||
        error instanceof TransactionNotFoundError
      if (!notFound || attempt === 20) throw error
      await Bun.sleep(250)
    }
  }
}

// Mined blocks, fetched once each however many batches landed in them.
const blocks = new Map<bigint, ReturnType<typeof publicClient.getBlock>>()
function blockOf(number: bigint) {
  if (!blocks.has(number)) {
    const block = untilFound(() => publicClient.getBlock({ blockNumber: number }))
    block.catch(() => blocks.delete(number))
    blocks.set(number, block)
  }
  return blocks.get(number)!
}

// The address every Arkiv operation is sent to, and the event each create emits there.
const ARKIV_ADDRESS = "0x4400000000000000000000000000000000000044"
const ENTITY_CREATED = parseAbiItem(
  "event EntityCreated(bytes32 indexed entityKey, address indexed owner, uint64 expiresAt, uint8 creationFlags)",
)

// The entities created in a block, by anyone. A node behind the others answers with no logs rather
// than an error, so a block with transactions but no creates is asked again for up to 2 s.
async function createsIn(block: { hash: Hex | null; transactions: unknown[] }): Promise<number> {
  for (let attempt = 1; ; attempt++) {
    const logs = await publicClient.getLogs({ address: ARKIV_ADDRESS, event: ENTITY_CREATED, blockHash: block.hash! })
    if (logs.length > 0 || block.transactions.length === 0 || attempt === 8) return logs.length
    await Bun.sleep(250)
  }
}

// One batch, mined. `sent` is for batches sent together: the nonce and fees to send with, and the
// block current when they went out.
async function sendBatch(size: number, label: string, sent?: { tx: TxParams; at: bigint }): Promise<Batch> {
  const { schema, values: valuesOf } = shapeFor(size)
  const values = Array.from({ length: size }, (_, i) => valuesOf(label, i))
  const creates = values.map((v) => ({ schema, values: v, expiration: ExpirationTime.fromBlocks(LIFETIME) }))
  const sentAt = sent?.at ?? (await publicClient.getBlockNumber({ cacheTime: 0 }))
  const started = performance.now()
  const result = await wallet.executeBatch({ creates } as never, sent?.tx)
  const seconds = (performance.now() - started) / 1000
  // From here on the batch is mined; an error says so, with its hash, so it is not sent again.
  try {
    return await measureBatch(size, result, values, seconds, sentAt, sent?.tx)
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { txHash: result.txHash })
  }
}

async function measureBatch(
  size: number,
  result: { txHash: Hex; createdEntities: Hex[] },
  values: Record<string, unknown>[],
  seconds: number,
  sentAt: bigint,
  sentTx?: TxParams,
): Promise<Batch> {
  if (result.createdEntities.length !== size) {
    throw new Error(`${result.txHash} created ${result.createdEntities.length} entities, not ${size}`)
  }
  const receipt = await untilFound(() => publicClient.getTransactionReceipt({ hash: result.txHash }))
  if (receipt.status !== "success") throw new Error(`${result.txHash} ${receipt.status}`)
  // With the gas given, the transaction holds nothing not known here: its calldata is as
  // `calldata` computes, which the batches section checks against the chain.
  const tx = sentTx?.gas
    ? { gas: sentTx.gas, bytes: calldata(size, shapeFor(size).attributes) }
    : await untilFound(() => publicClient.getTransaction({ hash: result.txHash })).then((t) => ({
        gas: t.gas,
        bytes: (t.input.length - 2) / 2,
      }))
  const block = await blockOf(receipt.blockNumber)
  return {
    size,
    txHash: result.txHash,
    block: receipt.blockNumber,
    waited: receipt.blockNumber - sentAt,
    seconds,
    bytes: tx.bytes,
    gasLimit: tx.gas,
    gasUsed: receipt.gasUsed,
    fee: receipt.gasUsed * receipt.effectiveGasPrice,
    blockShare: Number((block.gasUsed * 1000n) / block.gasLimit) / 10,
    baseFee: block.baseFeePerGas ?? 0n,
    firstKey: result.createdEntities[0]!,
    lastKey: result.createdEntities.at(-1)!,
    values: { first: values[0]!, last: values.at(-1)! },
  }
}

// A failed batch in one line, as in tokenomics.ts.
function describeFailure(error: unknown): string {
  let message = error instanceof Error ? error.message.split("\n")[0] : String(error)
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (e instanceof ContractFunctionRevertedError && e.reason) message += ` (reason: ${e.reason})`
  }
  const refused = refusedBy(error)
  if (refused) message += ` (the RPC answered ${refused})`
  const txHash = (error as { txHash?: Hex }).txHash
  return txHash ? `${message}, mined in ${txHash}` : `${message}, not mined`
}

// The written value as the node returns it: bytes as hex, typed values unwrapped.
function normalize(value: unknown): string {
  if (value instanceof Uint8Array) return toHex(value)
  if (value && typeof value === "object" && "value" in value) return normalize(value.value)
  return String(value).toLowerCase()
}

async function readBack(schema: Schema, entityKey: Hex, written: Record<string, unknown>): Promise<string[]> {
  const entity = (await publicClient.getEntity(entityKey, schema)) as Record<string, unknown>
  return Object.entries(written)
    .filter(([name, value]) => normalize(entity[name]) !== normalize(value))
    .map(([name]) => name)
}

const fmt = (n: bigint | number) => n.toLocaleString("en-US")
const glm = (wei: bigint) => (Number(wei / 1_000_000_000n) / 1e9).toFixed(9)
const usd = (wei: bigint) => `$${((Number(wei / 1_000_000_000n) / 1e9) * GLM_USD).toFixed(6)}`
const line = (cells: [string, number][]) =>
  cells.map(([text, width]) => (width < 0 ? text.padEnd(-width) : text.padStart(width))).join(" ")
const avg = <T,>(rows: T[], pick: (r: T) => bigint) =>
  rows.reduce((sum, r) => sum + pick(r), 0n) / BigInt(rows.length)
const avgNumber = <T,>(rows: T[], pick: (r: T) => number) => rows.reduce((sum, r) => sum + pick(r), 0) / rows.length

const gwei = (wei: bigint) => (Number(wei) / 1e9).toFixed(4)
// The shape of a batch's entities, as attributes/indexed.
const shapeLabel = (size: number) => `${shapeFor(size).attributes}/${shapeFor(size).indexed}`

const startBalance = await publicClient.getBalance({ address: account.address })
// The tip the node suggests, for the sends that set their fees here.
const TIP = await estimateMaxPriorityFeePerGas(publicClient as never)
const sizesUsed = [
  ...new Set([...(SECTIONS.includes("batches") ? BATCH_SIZES : []), ...(SECTIONS.includes("fill") ? [FILL_SIZE] : [])]),
]
console.log(
  `${new Date().toISOString()}, log ${LOG}\n` +
    `node ${RPC_URL}, chain ${chainId}, block ${fmt(head.number)}, block gas limit ${fmt(BLOCK_GAS_LIMIT)}, ` +
    `base fee ${gwei(head.baseFeePerGas ?? 0n)} gwei\n` +
    `block time ${BLOCK_TIME.toFixed(3)} s over the last ${fmt(head.number - sampleStart.number)} blocks\n` +
    `sender ${account.address}, balance ${glm(startBalance)} GLM\n` +
    `sections: ${SECTIONS.join(", ")}; lifetime ${fmt(LIFETIME)} blocks; tip ${gwei(TIP)} gwei; GLM at $${GLM_USD}\n` +
    `attributes per batch size, the most up to ${MAX_ATTRIBUTES} that fit one transaction ` +
    `(${fmt(MAX_CALLDATA)} bytes of calldata): ` +
    sizesUsed.map((size) => `${size}: ${FIELDS.slice(0, ATTRIBUTES.get(size)).map((f) => f.name).join(", ")}`).join("; ") +
    `; the body has ${BODY} bytes`,
)

// ---- batches ----

const batches = new Map<number, Batch[]>(BATCH_SIZES.map((size) => [size, []]))
// Per batch size, the most of its entities seen in one block.
const seen = new Map<number, number>(BATCH_SIZES.map((size) => [size, 0]))

function printBatch(iteration: number, size: number, batch: Batch) {
  console.log(
    line([[String(iteration), 4], [String(size), 5], [shapeLabel(size), 8], [fmt(batch.block), 9], [String(batch.waited), 6],
      [batch.seconds.toFixed(1), 7], [fmt(batch.bytes), 8], [fmt(batch.gasLimit), 11], [fmt(batch.gasUsed), 11],
      [fmt(batch.gasUsed / BigInt(size)), 10], [`${batch.blockShare.toFixed(1)}%`, 10], [gwei(batch.baseFee), 9],
      [glm(batch.fee), 13], [batch.txHash, -10]]),
  )
  // The batch sizes rest on the calldata estimate; say so when the chain disagrees with it.
  const expected = calldata(size, shapeFor(size).attributes)
  if (batch.bytes !== expected) console.log(`note: ${fmt(batch.bytes)} bytes of calldata, ${fmt(expected)} expected`)
}

// PARALLEL batches of one size, sent together at the start of a block. Explicit nonces and fees
// let viem send without asking the node for them, so the only round trip before a send is its own
// gas estimate, and all are in the pool within moments. Two base fees of headroom, as viem would
// leave.
async function sendStep(iteration: number, size: number): Promise<{ landed: Batch[]; failed: number }> {
  const baseFee = (await publicClient.getBlock()).baseFeePerGas ?? 0n
  const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" })
  const start = await publicClient.getBlockNumber({ cacheTime: 0 })
  let at = start
  while (at === start) {
    await Bun.sleep(50)
    at = await publicClient.getBlockNumber({ cacheTime: 0 })
  }
  const results = await Promise.allSettled(
    Array.from({ length: PARALLEL }, (_, k) =>
      sendBatch(size, `${iteration}-${size}-${k}`, {
        tx: { nonce: nonce + k, maxFeePerGas: 2n * baseFee + TIP, maxPriorityFeePerGas: TIP },
        at,
      }),
    ),
  )
  const landed: Batch[] = []
  for (const result of results) {
    if (result.status === "fulfilled") {
      landed.push(result.value)
      printBatch(iteration, size, result.value)
    } else {
      console.log(`${String(iteration).padStart(4)} ${String(size).padStart(5)} failed: ${describeFailure(result.reason)}`)
    }
  }
  // Where they landed: this step's batches per block, and how full each block got with all its
  // transactions, others' included.
  const byBlock = Map.groupBy(landed, (b) => b.block)
  for (const [block, group] of [...byBlock].sort(([a], [b]) => Number(a - b))) {
    const entities = group.length * size
    seen.set(size, Math.max(seen.get(size)!, entities))
    console.log(
      `     block ${fmt(block)}: ${group.length} of ${PARALLEL} batches, ${fmt(entities)} entities, ` +
        `${group[0]!.blockShare.toFixed(1)}% full`,
    )
  }
  return { landed, failed: results.length - landed.length }
}

let mismatches = 0

if (SECTIONS.includes("batches")) {
  const total = ITERATIONS * PARALLEL * BATCH_SIZES.reduce((sum, size) => sum + size, 0)
  console.log(
    `\nbatches: ${ITERATIONS} iteration(s) of ${BATCH_SIZES.join(", ")} entities, ${PARALLEL} at once, ` +
      `${fmt(total)} entities in all`,
  )
  console.log(
    line([["iter", 4], ["size", 5], ["attr/idx", 8], ["block", 9], ["waited", 6], ["seconds", 7], ["bytes", 8],
      ["gasLimit", 11], ["gasUsed", 11], ["gas/entity", 10], ["block full", 10], ["base fee", 9], ["tx fee (GLM)", 13],
      ["txHash", -10]]),
  )
  batchLoop: for (let iteration = 1; iteration <= ITERATIONS; iteration++) {
    for (const size of BATCH_SIZES) {
      if (PARALLEL === 1) {
        try {
          const batch = await sendBatch(size, `${iteration}-${size}`)
          batches.get(size)!.push(batch)
          seen.set(size, size)
          printBatch(iteration, size, batch)
        } catch (error) {
          console.log(`${String(iteration).padStart(4)} ${String(size).padStart(5)} failed: ${describeFailure(error)}`)
        }
        continue
      }
      const { landed, failed } = await sendStep(iteration, size)
      batches.get(size)!.push(...landed)
      // A batch that failed before it was sent leaves its nonce unused, and the sender's later
      // transactions wait in the pool behind it; what comes next would fill the gap and could not
      // be told apart from them. So the batches stop here.
      if (failed > 0) {
        console.log(`stopping: ${failed} of ${PARALLEL} batches failed; any still pending may land later`)
        break batchLoop
      }
    }
  }

  // Per entity, and how many entities would fit in a block, by gas, made of batches of this size;
  // per second at the measured block time. `seen/block` is the most of this size's entities that
  // actually landed in one block.
  console.log(`\noverview, average per batch size, ${PARALLEL} batch(es) sent at once`)
  console.log(
    line([["size", 5], ["attr/idx", 8], ["gasUsed", 11], ["gas/entity", 10], ["bytes", 8], ["seconds", 7], ["batches/block", 13],
      ["entities/block", 14], ["entities/s", 10], ["seen/block", 10], ["fee/entity (GLM)", 17], ["USD/1000", 10], ["ok", 7]]),
  )
  for (const size of BATCH_SIZES) {
    const rows = batches.get(size)!
    if (rows.length === 0) {
      console.log(line([[String(size), 5], [shapeLabel(size), 8], ["no successful batch", 30]]))
      continue
    }
    const gasUsed = avg(rows, (r) => r.gasUsed)
    const perBlock = BLOCK_GAS_LIMIT / gasUsed
    const entitiesPerBlock = perBlock * BigInt(size)
    const feePerEntity = avg(rows, (r) => r.fee) / BigInt(size)
    console.log(
      line([[String(size), 5], [shapeLabel(size), 8], [fmt(gasUsed), 11], [fmt(gasUsed / BigInt(size)), 10],
        [fmt(Math.round(avgNumber(rows, (r) => r.bytes))), 8], [avgNumber(rows, (r) => r.seconds).toFixed(1), 7],
        [fmt(perBlock), 13], [fmt(entitiesPerBlock), 14], [(Number(entitiesPerBlock) / BLOCK_TIME).toFixed(1), 10],
        [fmt(seen.get(size)!), 10], [glm(feePerEntity), 17], [usd(feePerEntity * 1000n), 10],
        [`${rows.length}/${ITERATIONS * PARALLEL}`, 7]]),
    )
  }

  // The first and last entity of each size's first batch, to check the batch wrote what it was
  // given in the order it was given.
  console.log("\nread back, first and last entity of each size's first batch")
  for (const size of BATCH_SIZES) {
    const batch = batches.get(size)![0]
    if (!batch) continue
    const { schema } = shapeFor(size)
    const wrong = [
      ...(await readBack(schema, batch.firstKey, batch.values.first)).map((name) => `first.${name}`),
      ...(await readBack(schema, batch.lastKey, batch.values.last)).map((name) => `last.${name}`),
    ]
    mismatches += wrong.length
    console.log(`${String(size).padStart(5)} ${wrong.length === 0 ? "matches what was written" : `differs in ${wrong.join(", ")}`}`)
  }
}

// ---- fill ----

// The base fee the chain should set after `parent`, by EIP-1559 with BASE_FEE_ELASTICITY and
// BASE_FEE_DENOMINATOR: up when the parent used more than its target, down when less.
function nextBaseFee(parent: { gasUsed: bigint; gasLimit: bigint; baseFeePerGas: bigint | null }): bigint {
  const base = parent.baseFeePerGas ?? 0n
  const target = parent.gasLimit / BigInt(BASE_FEE_ELASTICITY)
  const denominator = BigInt(BASE_FEE_DENOMINATOR)
  if (parent.gasUsed > target) {
    const delta = (base * (parent.gasUsed - target)) / target / denominator
    return base + (delta > 1n ? delta : 1n)
  }
  return base - (base * (target - parent.gasUsed)) / target / denominator
}

// Many consecutive blocks filled well above the base fee's target, to see the base fee climb. The
// sender keeps MAX_PENDING batches pending at all times: on every new block it counts its mined
// transactions and sends as many new batches as were mined, with fees for the current base fee.
// After FILL_BLOCKS blocks, or once it has spent FILL_BUDGET, it stops sending and waits for what
// is pending; then a table shows every block from just before to a few after, with its fill and
// its base fee next to what EIP-1559 would set.
if (SECTIONS.includes("fill")) {
  const target = BLOCK_GAS_LIMIT / BigInt(BASE_FEE_ELASTICITY)
  const budget = BigInt(Math.round(FILL_BUDGET * 1e9)) * 1_000_000_000n
  const fullBlock = BLOCK_GAS_LIMIT * ((head.baseFeePerGas ?? 0n) + TIP)
  console.log(
    `\nfill: batches of ${FILL_SIZE} (${shapeLabel(FILL_SIZE)} attr/idx), ${MAX_PENDING} pending at a time, ` +
      `for ${FILL_BLOCKS} blocks or ${FILL_BUDGET} GLM\n` +
      `base fee target ${fmt(target)} gas, 1/${BASE_FEE_ELASTICITY} of the block gas limit; ` +
      `a full block costs ${glm(fullBlock)} GLM at the starting base fee, more as it climbs`,
  )
  const fillBalance = await publicClient.getBalance({ address: account.address })
  // One batch sent the usual way, for the gas limit of the rest: with gas, nonce and fees all
  // given, a send is one request, with no estimate before it. It also takes the sender's next
  // nonce, which releases any transactions an earlier run left waiting behind a gap.
  const probe = await sendBatch(FILL_SIZE, "f-probe")
  const gas = (probe.gasUsed * 11n) / 10n
  console.log(`probe: ${fmt(probe.gasUsed)} gas in block ${fmt(probe.block)}; fill batches get ${fmt(gas)}`)

  // #tx and #creates count every sender's, not only this run's.
  console.log(
    line([["block", 9], ["#tx", 4], ["#creates", 8], ["full", 7], ["base fee", 9], ["mined", 6], ["pending", 7],
      ["spent (GLM)", 12]]),
  )
  const startNonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" })
  let nonce = startNonce
  const sending: Promise<void>[] = []
  const landed: Batch[] = []
  let failed = 0
  let taken = 0
  let unmeasured = 0
  let stop = ""

  // A fill batch, sent until it is mined or its nonce is taken: a nonce left unused would hold
  // back every batch after it. A send the RPC refuses is sent again, up to 3 times; a nonce an
  // earlier transaction took, one an earlier run left waiting, is counted and given up.
  const sendFill = async (n: number, tx: TxParams, at: bigint) => {
    for (let attempt = 1; ; attempt++) {
      try {
        landed.push(await sendBatch(FILL_SIZE, `f-${n}`, { tx: { ...tx, nonce: n }, at }))
        return
      } catch (error) {
        const said: string[] = []
        for (let e: unknown = error; e instanceof Error; e = e.cause) said.push(e.message)
        if (/nonce too low|lower than the current nonce|already known|replacement transaction underpriced/i.test(said.join(" "))) {
          taken++
          console.log(`fill batch with nonce ${n}: nonce taken by an earlier transaction`)
          return
        }
        // Mined, its nonce used, but not measured: no gap, so the fill goes on.
        if ((error as { txHash?: Hex }).txHash) {
          unmeasured++
          console.log(`fill batch with nonce ${n}, not measured: ${describeFailure(error)}`)
          return
        }
        if (attempt === 3) {
          failed++
          console.log(`fill batch with nonce ${n} failed: ${describeFailure(error)}`)
          return
        }
        console.log(`fill batch with nonce ${n}, attempt ${attempt} failed, sending again: ${describeFailure(error)}`)
        await Bun.sleep(1000 * attempt)
      }
    }
  }

  const first = await publicClient.getBlockNumber({ cacheTime: 0 })
  let current = first - 1n
  while (!stop) {
    const number = await publicClient.getBlockNumber({ cacheTime: 0 })
    if (number !== current) {
      current = number
      const block = await blockOf(number)
      // The sender's mined transactions so far: fill batches from startNonce on.
      const minedNonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "latest" })
      const spent = fillBalance - (await publicClient.getBalance({ address: account.address }))
      console.log(
        line([[fmt(number), 9], [String(block.transactions.length), 4], [fmt(await createsIn(block)), 8],
          [`${(Number((block.gasUsed * 1000n) / block.gasLimit) / 10).toFixed(1)}%`, 7],
          [gwei(block.baseFeePerGas ?? 0n), 9], [String(Math.max(0, minedNonce - startNonce)), 6],
          [String(nonce - minedNonce), 7], [glm(spent), 12]]),
      )
      if (number >= first + BigInt(FILL_BLOCKS)) stop = `${FILL_BLOCKS} blocks passed`
      else if (spent >= budget) stop = `spent ${glm(spent)} GLM, the budget is ${FILL_BUDGET}`
      else if (failed > 0) stop = `${failed} batch(es) failed`
      else {
        const tx = { gas, maxFeePerGas: 2n * (block.baseFeePerGas ?? 0n) + TIP, maxPriorityFeePerGas: TIP }
        while (nonce - minedNonce < MAX_PENDING) sending.push(sendFill(nonce++, tx, number))
      }
    }
    await Bun.sleep(500)
  }
  console.log(`stopped sending: ${stop}; waiting for the batches still pending`)
  await Promise.all(sending)
  if (taken > 0) console.log(`${taken} nonce(s) were taken by earlier transactions`)
  if (unmeasured > 0) console.log(`${unmeasured} batch(es) were mined but not measured`)

  // A few blocks after the last batch, to see the base fee come back down.
  const lastLanded = landed.reduce((max, b) => (b.block > max ? b.block : max), first)
  const end = lastLanded + 3n
  while ((await publicClient.getBlockNumber({ cacheTime: 0 })) < end) await Bun.sleep(500)

  // Each block's base fee follows from its parent: `change` is what it did, `expected` what
  // EIP-1559 would have done given the parent's fill.
  console.log(
    `\nfill, per block: base fee in gwei; change and expected (elasticity ${BASE_FEE_ELASTICITY}, ` +
      `denominator ${BASE_FEE_DENOMINATOR}) relative to the block before`,
  )
  console.log(
    line([["block", 9], ["#tx", 4], ["#creates", 8], ["ours", 5], ["gasUsed", 11], ["full", 7], ["base fee", 9],
      ["change", 8], ["expected", 8]]),
  )
  const pct = (to: bigint, from: bigint) => (from === 0n ? "-" : `${((Number(to - from) / Number(from)) * 100).toFixed(2)}%`)
  let parent = await blockOf(first - 3n)
  const rows: { ours: number; full: number; aboveTarget: boolean }[] = []
  for (let number = first - 2n; number <= end; number++) {
    const block = await blockOf(number)
    const ours = landed.filter((b) => b.block === number).length
    const full = Number((block.gasUsed * 1000n) / block.gasLimit) / 10
    const base = block.baseFeePerGas ?? 0n
    const parentBase = parent.baseFeePerGas ?? 0n
    console.log(
      line([[fmt(number), 9], [String(block.transactions.length), 4], [fmt(await createsIn(block)), 8],
        [String(ours), 5], [fmt(block.gasUsed), 11], [`${full.toFixed(1)}%`, 7], [gwei(base), 9], [pct(base, parentBase), 8],
        [pct(nextBaseFee(parent), parentBase), 8]]),
    )
    if (ours > 0) rows.push({ ours, full, aboveTarget: block.gasUsed > target })
    parent = block
  }

  if (landed.length > 0) {
    const inOrder = [...landed].sort((a, b) => Number(a.block - b.block))
    const priceOf = (b: Batch) => b.fee / b.gasUsed
    const firstPrice = priceOf(inOrder[0]!)
    const lastPrice = priceOf(inOrder.at(-1)!)
    const fillSpent = landed.reduce((sum, b) => sum + b.fee, 0n)
    console.log(
      `\n${landed.length} batches, ${fmt(landed.length * FILL_SIZE)} entities, in ${rows.length} blocks; ` +
        `${rows.filter((r) => r.aboveTarget).length} of them above the target, ` +
        `${avgNumber(rows, (r) => r.full).toFixed(1)}% full on average\n` +
        `gas price paid: ${gwei(firstPrice)} gwei in block ${fmt(inOrder[0]!.block)}, ` +
        `${gwei(lastPrice)} gwei in block ${fmt(inOrder.at(-1)!.block)} ` +
        `(${(Number(lastPrice) / Number(firstPrice)).toFixed(2)}×)\n` +
        `fill spent ${glm(fillSpent)} GLM (${usd(fillSpent)}), ` +
        `${glm(fillSpent / BigInt(landed.length * FILL_SIZE))} GLM per entity`,
    )
  }
}

const spent = startBalance - (await publicClient.getBalance({ address: account.address }))
console.log(`\nsender spent ${glm(spent)} GLM (${usd(spent)}) in this run; log ${LOG}`)

process.exit(mismatches === 0 ? 0 : 1)
