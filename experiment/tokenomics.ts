// What entity operations cost through SDK-next on a live chain, in three sections (SECTIONS,
// default creates,ops):
//
// - creates: entities of three sizes and three lifetimes, each with the SDK's gas limit, the gas
//   used, how much of it was storage gas (paid into the pool at ARKIV_ADDRESS), the fee, and how
//   many of it fit in a block. Ends with an overview of the 9 combinations.
// - ops: per kind, a patch, an extend by a week, a transfer and a delete, measured the same way.
// - block: many senders send creates, patches and extends at once, and a table shows how many of
//   each landed in which block and how full each block got. Opt-in, and only as a run of its own.
//
// Not a test: it asserts nothing about prices, so it runs against any fee schedule.
//
//   bun experiment/tokenomics.ts
//
// Everything it prints is also written to results/tokenomics-<time>.log.
//
// Settings come from the environment; bun reads .env, which git ignores (see .env.example):
//
// - ARKIV_RPC_URL and ARKIV_CHAIN_ID: the chain, required. The run stops if the RPC serves
//   another chain id.
// - ARKIV_KEYSTORE: the sender's encrypted keystore file, required, made with
//   experiment/new-wallet.ts. The run asks for its password on the terminal and keeps the key in
//   memory only. The publicly known dev keys are refused.
// - GENESIS or MAX_LIFETIME: the node does not serve its fee schedule, so the longest lifetime,
//   `max_lifetime` in blocks, comes from the chain's genesis file or is given directly. One of
//   the two is required; if both are given they must agree, and the genesis must be for
//   ARKIV_CHAIN_ID.
// - COUNT entities per combination (default 3). ONLY limits the creates to some combinations,
//   e.g. ONLY=big/long,normal/short. GLM_USD prices the fees in dollars (default 0.1).
// - BLOCK_TIME_SAMPLE: how many recent blocks the chain's block time is measured over (default
//   1000). The SDK turns durations into blocks at 2 s each; the run says what they last instead.
//
// The block section sends from BLOCK_KEYSTORES, comma-separated keystore files of funded accounts,
// one sender each; keystores that share the sender's password are not asked for again. Each sends BLOCK_CREATES, BLOCK_PATCHES and BLOCK_EXTENDS of the normal kind
// (default 5 each). reth's pool guarantees 16 pending transactions per sender, so the three
// together may not exceed that.
//
// The schemas are unnamed: a named one adds an indexed `arkiv.schema` attribute to every entity,
// which would change the counts below. Every kind carries exactly the attributes listed.

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
  type Lifetime,
  type Schema,
} from "@arkiv-network/sdk-next"
import { appendFileSync, existsSync, mkdirSync } from "node:fs"
import { resolve } from "node:path"
import { ContractFunctionRevertedError, defineChain, http, toHex, type Hex } from "viem"
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts"
import { unlock } from "./keystore"

// Everything printed also goes to a log of its own per run, appended line by line so that a run
// which stops halfway keeps what it measured, and the error it stopped with. The log starts once
// the settings are checked, so a run refused for them leaves none.
const RESULTS = resolve(`${import.meta.dir}/../results`)
const LOG = `${RESULTS}/tokenomics-${new Date().toISOString().replace(/\.\d+Z$/, "Z").replaceAll(":", "-")}.log`
function startLog() {
  mkdirSync(RESULTS, { recursive: true })
  const print = console.log
  console.log = (...args: unknown[]) => {
    print(...args)
    appendFileSync(LOG, `${args.map(String).join(" ")}\n`)
  }
}
process.on("uncaughtException", (error) => {
  console.log(`stopped: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
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

// The mnemonic hardhat, anvil and the dev genesis fund their accounts from. Anyone can derive
// its keys, so on a live chain whatever those accounts hold is anyone's to take.
const DEV_MNEMONIC = "test test test test test test test test test test test junk"
const DEV_ADDRESSES = new Set(
  Array.from({ length: 20 }, (_, i) => mnemonicToAccount(DEV_MNEMONIC, { addressIndex: i }).address.toLowerCase()),
)

function keystorePath(name: string, path: string): string {
  const full = resolve(path)
  if (!existsSync(full)) fail(`${name} is ${full}, which does not exist; make one with experiment/new-wallet.ts`)
  return full
}

// A private key as decrypted; the error names where it came from, never the key.
function liveKey(name: string, key: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) fail(`${name} is not a 0x-prefixed 32-byte hex private key`)
  if (DEV_ADDRESSES.has(privateKeyToAccount(key as Hex).address.toLowerCase())) {
    fail(`${name} is one of the publicly known dev keys; use a key of your own`)
  }
  return key as Hex
}

const RPC_URL = required("ARKIV_RPC_URL")
const CHAIN_ID = positiveInteger("ARKIV_CHAIN_ID", required("ARKIV_CHAIN_ID"))
const KEYSTORE = keystorePath("ARKIV_KEYSTORE", required("ARKIV_KEYSTORE"))
const GENESIS = process.env.GENESIS?.trim() ? resolve(process.env.GENESIS.trim()) : undefined
const COUNT = positiveInteger("COUNT", process.env.COUNT ?? 3)
const ONLY = process.env.ONLY?.split(",").map((s) => s.trim())
const SECTIONS = (process.env.SECTIONS ?? "creates,ops").split(",").map((s) => s.trim())
const GLM_USD = Number(process.env.GLM_USD ?? 0.1)
const BLOCK_TIME_SAMPLE = BigInt(positiveInteger("BLOCK_TIME_SAMPLE", process.env.BLOCK_TIME_SAMPLE ?? 1000))
const BLOCK_CREATES = Number(process.env.BLOCK_CREATES ?? 5)
const BLOCK_PATCHES = Number(process.env.BLOCK_PATCHES ?? 5)
const BLOCK_EXTENDS = Number(process.env.BLOCK_EXTENDS ?? 5)

for (const section of SECTIONS) {
  if (!["creates", "ops", "block"].includes(section)) fail(`unknown section ${section} in SECTIONS`)
}
// The block section floods the chain from several accounts, so it runs only when asked for by
// name, on its own, with keystores given for it.
const BLOCK_KEYSTORES = SECTIONS.includes("block")
  ? required("BLOCK_KEYSTORES").split(",").map((path, i) => keystorePath(`BLOCK_KEYSTORES[${i}]`, path.trim()))
  : []
if (SECTIONS.includes("block") && SECTIONS.length > 1) fail("run SECTIONS=block on its own")
if (new Set(BLOCK_KEYSTORES).size !== BLOCK_KEYSTORES.length) fail("BLOCK_KEYSTORES lists the same file twice")

// The pool storage gas is paid into: `base_fee × storage_gas` per transaction. It is also the
// address every Arkiv operation is sent to.
const POOL = "0x4400000000000000000000000000000000000044"

const genesis = GENESIS ? await Bun.file(GENESIS).json() : undefined
if (genesis && genesis.config?.chainId !== CHAIN_ID) {
  fail(`${GENESIS} is for chain ${genesis.config?.chainId}, not ARKIV_CHAIN_ID ${CHAIN_ID}`)
}
const WEIGHTS: Record<string, number> = genesis?.config.arkiv.golemdb.metering.weights ?? {}
const GENESIS_MAX_LIFETIME = WEIGHTS["host.arkiv.max_lifetime"]
if (genesis && GENESIS_MAX_LIFETIME === undefined) fail(`${GENESIS} has no host.arkiv.max_lifetime`)
if (!genesis && !process.env.MAX_LIFETIME) fail("set GENESIS or MAX_LIFETIME; see .env.example")
const MAX_LIFETIME = positiveInteger("MAX_LIFETIME", process.env.MAX_LIFETIME?.trim() || GENESIS_MAX_LIFETIME!)
if (GENESIS_MAX_LIFETIME !== undefined && MAX_LIFETIME !== GENESIS_MAX_LIFETIME) {
  fail(`MAX_LIFETIME ${MAX_LIFETIME} differs from ${GENESIS_MAX_LIFETIME} in ${GENESIS}`)
}
const HOST_WEIGHTS = Object.fromEntries(Object.entries(WEIGHTS).filter(([name]) => name.startsWith("host.")))

// The keys, decrypted into memory once every other setting is checked, so a run refused for one
// of those asks for no password. Keystores that share a password are asked for once.
async function unlockKey(name: string, path: string, remembered: { password?: string }): Promise<Hex> {
  try {
    return liveKey(name, await unlock(path, remembered))
  } catch (error) {
    fail(`${name} ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
const remembered: { password?: string } = {}
const FUNDED_KEY = await unlockKey("ARKIV_KEYSTORE", KEYSTORE, remembered)
const BLOCK_KEYS: Hex[] = []
for (const [i, path] of BLOCK_KEYSTORES.entries()) {
  BLOCK_KEYS.push(await unlockKey(`BLOCK_KEYSTORES[${i}]`, path, remembered))
}
if (new Set(BLOCK_KEYS.map((key) => key.toLowerCase())).size !== BLOCK_KEYS.length) {
  fail("BLOCK_KEYSTORES holds the same key twice")
}

startLog()

// In blocks. The SDK turns durations into blocks at a fixed 2 s block time, so "a week" is
// 302,400 blocks whatever the chain's block time; the run measures that and says what they last.
const SDK_BLOCK_TIME = 2
const LIFETIMES: { name: string; blocks: number; expiration: Lifetime }[] = [
  { name: "short", blocks: 100, expiration: ExpirationTime.fromBlocks(100) },
  { name: "medium", blocks: 7 * 24 * 60 * 30, expiration: ExpirationTime.fromWeeks(1) },
  { name: "long", blocks: MAX_LIFETIME, expiration: ExpirationTime.fromBlocks(MAX_LIFETIME) },
]

// 1 attribute, not indexed.
const Minimal = defineSchema({
  note: str(),
})

// 10 attributes, 4 indexed, plus a body of a few hundred bytes.
const Normal = defineSchema({
  category: str().indexed(),
  priority: u64().indexed(),
  author: addr().indexed(),
  status: str().indexed(),
  title: str(),
  summary: str(),
  language: str(),
  source: str(),
  version: i32(),
  size: u64(),
  body: bytesColumn(),
})

// 20 attributes, 15 indexed, plus a body of 100 KiB.
const Big = defineSchema({
  tag01: str().indexed(),
  tag02: str().indexed(),
  tag03: str().indexed(),
  tag04: str().indexed(),
  tag05: str().indexed(),
  tag06: str().indexed(),
  tag07: str().indexed(),
  tag08: str().indexed(),
  num01: u64().indexed(),
  num02: u64().indexed(),
  num03: u64().indexed(),
  num04: u64().indexed(),
  num05: u64().indexed(),
  party1: addr().indexed(),
  party2: addr().indexed(),
  title: str(),
  summary: str(),
  license: str(),
  revision: i32(),
  checksum: u64(),
  body: bytesColumn(),
})

const NORMAL_BODY = 300
const BIG_BODY = 100 * 1024

function randomBytes(length: number): Uint8Array {
  // getRandomValues fills at most 64 KiB per call.
  const out = new Uint8Array(length)
  for (let offset = 0; offset < length; offset += 65536) {
    crypto.getRandomValues(out.subarray(offset, Math.min(offset + 65536, length)))
  }
  return out
}

function minimalValues(i: number) {
  return { note: `minimal entity ${i}` }
}

function normalValues(i: number, author: Hex) {
  return {
    category: "documents",
    priority: u64(BigInt(i % 3)),
    author: addr(author),
    status: i % 2 ? "draft" : "published",
    title: `Normal entity number ${i}`,
    summary: "An entity of the size a typical application writes, with a small body.",
    language: "en",
    source: "experiment/tokenomics.ts",
    version: i32(1),
    size: u64(BigInt(NORMAL_BODY)),
    body: randomBytes(NORMAL_BODY),
  }
}

function bigValues(i: number, author: Hex) {
  return {
    tag01: "alpha",
    tag02: "bravo",
    tag03: "charlie",
    tag04: "delta",
    tag05: "echo",
    tag06: "foxtrot",
    tag07: "golf",
    tag08: `big-${i}`,
    num01: u64(BigInt(i)),
    num02: u64(2n),
    num03: u64(3n),
    num04: u64(4n),
    num05: u64(5n),
    party1: addr(author),
    party2: addr("0x70997970C51812dc3A010C7d01b50e0d17dc79C8"),
    title: `Big entity number ${i}`,
    summary: "Twenty attributes, fifteen of them indexed, and a body of 100 KiB.",
    license: "CC-BY-4.0",
    revision: i32(7),
    checksum: u64(123_456_789n),
    body: randomBytes(BIG_BODY),
  }
}

const transport = http(RPC_URL)
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
// The chain's block time, averaged over the last BLOCK_TIME_SAMPLE blocks' timestamps.
const sampleStart = await publicClient.getBlock({
  blockNumber: head.number > BLOCK_TIME_SAMPLE ? head.number - BLOCK_TIME_SAMPLE : 0n,
})
if (head.number === sampleStart.number) fail(`chain ${chainId} has no blocks to measure the block time over`)
const BLOCK_TIME = Number(head.timestamp - sampleStart.timestamp) / Number(head.number - sampleStart.number)
// An address with no key, to transfer entities to.
const TRANSFER_TO = "0x000000000000000000000000000000000000dEaD"

type Kind = {
  name: string
  schema: Schema
  values: (i: number) => Record<string, unknown>
  // A patch that changes one attribute, and what it changes.
  patch: (i: number) => Record<string, unknown>
  patchLabel: string
  cells: number
  indexed: number
  bodyBytes: number
}

const KINDS: Kind[] = [
  {
    name: "minimal",
    schema: Minimal,
    values: minimalValues,
    patch: (i) => ({ note: `minimal entity ${i}, patched` }),
    patchLabel: "patch note (unindexed)",
    cells: 1,
    indexed: 0,
    bodyBytes: 0,
  },
  {
    name: "normal",
    schema: Normal,
    values: (i) => normalValues(i, account.address),
    patch: (i) => ({ status: `archived-${i}` }),
    patchLabel: "patch status (indexed)",
    cells: 11,
    indexed: 4,
    bodyBytes: NORMAL_BODY,
  },
  {
    name: "big",
    schema: Big,
    values: (i) => bigValues(i, account.address),
    patch: (i) => ({ tag08: `big-${i}-patched` }),
    patchLabel: "patch tag08 (indexed)",
    cells: 21,
    indexed: 15,
    bodyBytes: BIG_BODY,
  },
]
const NORMAL = KINDS[1]!

type Cost = {
  gasLimit: bigint
  gasUsed: bigint
  storage: bigint
  fee: bigint
  // Other transactions to ARKIV_ADDRESS in the blocks the measurement spans; with any, `storage`
  // may include what they paid into the pool.
  others: number
}

type Row = Cost & {
  entityKey: Hex
  values: Record<string, unknown>
}

// The pool's balance at `latest`, and the block numbers seen just before and after reading it:
// the balance is that of one of the blocks in between.
async function readPool(): Promise<{ balance: bigint; from: bigint; to: bigint }> {
  const from = await publicClient.getBlockNumber({ cacheTime: 0 })
  const balance = await publicClient.getBalance({ address: POOL })
  const to = await publicClient.getBlockNumber({ cacheTime: 0 })
  return { balance, from, to }
}

// One transaction, with the pool read at `latest` around it: GolemDB serves no past state. On a
// live chain other Arkiv transactions may pay into the pool between the two reads, so every block
// that may lie between them is searched for transactions to ARKIV_ADDRESS other than this one.
// The fee is what the sender paid, gasUsed × the effective gas price, of which
// `storage × base fee` went to the pool.
async function measure<T extends { txHash: Hex }>(send: () => Promise<T>): Promise<{ result: T; cost: Cost }> {
  const before = await readPool()
  const result = await send()
  const after = await readPool()
  const receipt = await publicClient.getTransactionReceipt({ hash: result.txHash })
  if (receipt.status !== "success") throw new Error(`${result.txHash} ${receipt.status}`)
  const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber })
  const tx = await publicClient.getTransaction({ hash: result.txHash })
  const baseFee = block.baseFeePerGas ?? 0n
  if (baseFee === 0n) throw new Error(`block ${receipt.blockNumber} has no base fee`)
  if (receipt.blockNumber <= before.from || receipt.blockNumber > after.to) {
    throw new Error(`${result.txHash} landed in block ${receipt.blockNumber}, outside the pool reads`)
  }
  let others = 0
  for (let number = before.from + 1n; number <= after.to; number++) {
    const { transactions } = await publicClient.getBlock({ blockNumber: number, includeTransactions: true })
    others += transactions.filter((t) => t.to?.toLowerCase() === POOL.toLowerCase() && t.hash !== result.txHash).length
  }
  return {
    result,
    cost: {
      gasLimit: tx.gas,
      gasUsed: receipt.gasUsed,
      storage: (after.balance - before.balance) / baseFee,
      fee: receipt.gasUsed * receipt.effectiveGasPrice,
      others,
    },
  }
}

async function create(kind: Kind, expiration: Lifetime, i: number): Promise<Row> {
  const values = kind.values(i)
  const { result, cost } = await measure(() =>
    wallet.createEntity(kind.schema, values as never, { expiration }),
  )
  return { ...cost, entityKey: result.entityKey, values }
}

// A failed operation in one line. The SDK names a plain `Error(string)` revert only as "Error",
// so the reason is taken from the revert in its cause chain; a transaction hash means it was
// mined and its gas paid.
function describeFailure(error: unknown): string {
  let message = error instanceof Error ? error.message.split("\n")[0] : String(error)
  for (let e: unknown = error; e instanceof Error; e = e.cause) {
    if (e instanceof ContractFunctionRevertedError && e.reason) message += ` (reason: ${e.reason})`
  }
  const txHash = (error as { txHash?: Hex }).txHash
  return txHash ? `${message}, mined in ${txHash}` : `${message}, not mined`
}

// The written value as the node returns it: bytes as hex, typed values unwrapped.
function normalize(value: unknown): string {
  if (value instanceof Uint8Array) return toHex(value)
  if (value && typeof value === "object" && "value" in value) return normalize(value.value)
  return String(value).toLowerCase()
}

async function readBack(kind: Kind, row: Row): Promise<string[]> {
  const entity = (await publicClient.getEntity(row.entityKey, kind.schema)) as Record<string, unknown>
  return Object.entries(row.values)
    .filter(([name, written]) => normalize(entity[name]) !== normalize(written))
    .map(([name]) => name)
}

const fmt = (n: bigint | number) => n.toLocaleString("en-US")
// Wei as GLM, to the gwei, and in dollars at GLM_USD.
const glm = (wei: bigint) => (Number(wei / 1_000_000_000n) / 1e9).toFixed(9)
const usd = (wei: bigint) => `$${((Number(wei / 1_000_000_000n) / 1e9) * GLM_USD).toFixed(6)}`
// How many of a transaction fit in one block, by gas.
const perBlock = (gasUsed: bigint) => fmt(gasUsed === 0n ? 0n : BLOCK_GAS_LIMIT / gasUsed)
const line = (cells: [string, number][]) =>
  cells.map(([text, width]) => (width < 0 ? text.padEnd(-width) : text.padStart(width))).join(" ")
const avg = <T,>(rows: T[], pick: (r: T) => bigint) =>
  rows.reduce((sum, r) => sum + pick(r), 0n) / BigInt(rows.length)
// A measurement's storage split, marked `*` when other Arkiv transactions shared its blocks.
const storageOf = (cost: Cost) => (cost.others ? `*${fmt(cost.storage)}` : fmt(cost.storage))
const otherOf = (cost: Cost) => (cost.others ? `*${fmt(cost.gasUsed - cost.storage)}` : fmt(cost.gasUsed - cost.storage))

// A number of blocks as the time they last at the measured block time.
const days = (blocks: number) => `${((blocks * BLOCK_TIME) / 86400).toFixed(2)} days`

const startBalance = await publicClient.getBalance({ address: account.address })
console.log(
  `${new Date().toISOString()}, log ${LOG}\n` +
    `node ${RPC_URL}, chain ${chainId}, block ${fmt(head.number)}, block gas limit ${fmt(BLOCK_GAS_LIMIT)}\n` +
    `sender ${account.address}, balance ${glm(startBalance)} GLM\n` +
    (genesis
      ? `schedule from ${GENESIS}: ${JSON.stringify(HOST_WEIGHTS)}, base fee ${genesis.baseFeePerGas ?? "default"}\n`
      : `max_lifetime ${fmt(MAX_LIFETIME)} blocks from MAX_LIFETIME, no genesis file\n`) +
    `sections: ${SECTIONS.join(", ")}; GLM at $${GLM_USD}`,
)
console.log(
  `block time ${BLOCK_TIME.toFixed(3)} s over the last ${fmt(head.number - sampleStart.number)} blocks; ` +
    `the SDK counts ${SDK_BLOCK_TIME} s`,
)
for (const lifetime of LIFETIMES) console.log(`  ${lifetime.name.padEnd(8)} ${fmt(lifetime.blocks).padStart(11)} blocks = ${days(lifetime.blocks)}`)
// The SDK's "week" is a calendar week only at its own block time; say so when the chain's is off
// by more than 1%.
if (Math.abs(BLOCK_TIME - SDK_BLOCK_TIME) / SDK_BLOCK_TIME > 0.01) {
  console.log(
    `note: the block time is not ${SDK_BLOCK_TIME} s, so "medium" and "extend +1 week" last ` +
      `${days(7 * 24 * 60 * 30)}, not a calendar week`,
  )
}

let mismatches = 0

// ---- creates ----

if (SECTIONS.includes("creates")) {
  console.log(`\ncreates, ${COUNT} per kind and lifetime`)
  console.log(
    line([["kind", -8], ["lifetime", -8], ["blocks", 9], ["cells", 5], ["indexed", 7], ["bytes", 9],
      ["gasLimit", 10], ["gasUsed", 10], ["storage", 10], ["other", 10], ["others", 6], ["entityKey", -10]]),
  )

  const results = new Map<string, Row[]>()
  for (const kind of KINDS) {
    for (const lifetime of LIFETIMES) {
      if (ONLY && !ONLY.includes(`${kind.name}/${lifetime.name}`)) continue
      const rows: Row[] = []
      for (let i = 0; i < COUNT; i++) {
        try {
          const row = await create(kind, lifetime.expiration, i)
          rows.push(row)
          console.log(
            line([[kind.name, -8], [lifetime.name, -8], [fmt(lifetime.blocks), 9], [String(kind.cells), 5],
              [String(kind.indexed), 7], [fmt(kind.bodyBytes), 9], [fmt(row.gasLimit), 10],
              [fmt(row.gasUsed), 10], [storageOf(row), 10], [otherOf(row), 10], [String(row.others), 6],
              [row.entityKey, -10]]),
          )
        } catch (error) {
          console.log(`${kind.name.padEnd(8)} ${lifetime.name.padEnd(8)} create ${i} failed: ${describeFailure(error)}`)
        }
      }
      results.set(`${kind.name}/${lifetime.name}`, rows)
    }
  }

  // Gas and fees come from the receipts and hold for every create; the storage split only for the
  // clean ones, those no other Arkiv transaction shared blocks with.
  console.log("\noverview, average per create; storage and other over the clean creates only")
  console.log(
    line([["kind", -8], ["lifetime", -8], ["blocks", 9], ["gasUsed", 10], ["storage", 10], ["other", 10],
      ["per block", 9], ["tx fee (GLM)", 13], ["USD", 10], ["ok", 5], ["clean", 5]]),
  )
  for (const kind of KINDS) {
    for (const lifetime of LIFETIMES) {
      if (ONLY && !ONLY.includes(`${kind.name}/${lifetime.name}`)) continue
      const rows = results.get(`${kind.name}/${lifetime.name}`) ?? []
      if (rows.length === 0) {
        console.log(line([[kind.name, -8], [lifetime.name, -8], [fmt(lifetime.blocks), 9], ["no successful create", 45]]))
        continue
      }
      const gasUsed = avg(rows, (r) => r.gasUsed)
      const fee = avg(rows, (r) => r.fee)
      const clean = rows.filter((r) => r.others === 0)
      console.log(
        line([[kind.name, -8], [lifetime.name, -8], [fmt(lifetime.blocks), 9], [fmt(gasUsed), 10],
          [clean.length ? fmt(avg(clean, (r) => r.storage)) : "-", 10],
          [clean.length ? fmt(avg(clean, (r) => r.gasUsed - r.storage)) : "-", 10],
          [perBlock(gasUsed), 9], [glm(fee), 13], [usd(fee), 10], [`${rows.length}/${COUNT}`, 5],
          [`${clean.length}/${rows.length}`, 5]]),
      )
    }
  }

  console.log("\nread back, first entity of each kind")
  for (const kind of KINDS) {
    const row = LIFETIMES.map((l) => results.get(`${kind.name}/${l.name}`)?.[0]).find((r) => r)
    if (!row) continue
    const wrong = await readBack(kind, row)
    mismatches += wrong.length
    console.log(`${kind.name.padEnd(8)} ${wrong.length === 0 ? "matches what was written" : `differs in ${wrong.join(", ")}`}`)
  }
}

// ---- ops ----

if (SECTIONS.includes("ops")) {
  console.log("\nops, one each per kind, on entities created for 100 blocks")
  console.log(
    line([["kind", -8], ["op", -24], ["gasLimit", 10], ["gasUsed", 10], ["storage", 10], ["other", 10],
      ["others", 6], ["per block", 9], ["tx fee (GLM)", 13], ["USD", 10]]),
  )
  for (const kind of KINDS) {
    const short = { expiration: ExpirationTime.fromBlocks(100) }
    let target: Hex
    let transferred: Hex
    try {
      target = (await wallet.createEntity(kind.schema, kind.values(0) as never, short)).entityKey
      transferred = (await wallet.createEntity(kind.schema, kind.values(1) as never, short)).entityKey
    } catch (error) {
      console.log(`${kind.name.padEnd(8)} setup failed: ${describeFailure(error)}`)
      continue
    }
    const ops: [string, () => Promise<{ txHash: Hex }>][] = [
      [kind.patchLabel, () => wallet.patchEntity(kind.schema, target, { set: kind.patch(0) as never })],
      ["extend +1 week", () => wallet.extendEntity({ entityKey: target, expiration: ExpirationTime.fromWeeks(1) })],
      ["transfer", () => wallet.changeOwnership({ entityKey: transferred, newOwner: TRANSFER_TO })],
      ["delete", () => wallet.deleteEntity({ entityKey: target })],
    ]
    for (const [label, send] of ops) {
      try {
        const { cost } = await measure(send)
        console.log(
          line([[kind.name, -8], [label, -24], [fmt(cost.gasLimit), 10], [fmt(cost.gasUsed), 10],
            [storageOf(cost), 10], [otherOf(cost), 10], [String(cost.others), 6], [perBlock(cost.gasUsed), 9],
            [glm(cost.fee), 13], [usd(cost.fee), 10]]),
        )
      } catch (error) {
        console.log(`${kind.name.padEnd(8)} ${label.padEnd(24)} failed: ${describeFailure(error)}`)
      }
    }
  }
}

// ---- block ----

// Many senders at once, so the pool holds more than one block takes: the table shows where the
// block gas limit cut each block off. Every op is a transaction of its own, sent with a gas limit
// 10% above what one of its kind used, so the builder packs them about as tightly as it can.
if (SECTIONS.includes("block")) {
  const perSender = BLOCK_CREATES + BLOCK_PATCHES + BLOCK_EXTENDS
  if (perSender > 16) throw new Error(`${perSender} transactions per sender; reth's pool guarantees 16`)
  const senders = BLOCK_KEYS.map((key) => createWalletClient({ chain, transport, account: privateKeyToAccount(key) }))
  const kind = NORMAL
  const week = { expiration: ExpirationTime.fromWeeks(1) }
  console.log(
    `\nblock: ${senders.length} senders × (${BLOCK_CREATES} creates, ${BLOCK_PATCHES} patches, ` +
      `${BLOCK_EXTENDS} extends) of ${kind.name} entities = ${fmt(senders.length * perSender)} transactions`,
  )
  const senderBalances = await Promise.all(senders.map((s) => publicClient.getBalance({ address: s.account.address })))
  for (const [i, s] of senders.entries()) console.log(`  sender ${s.account.address}, balance ${glm(senderBalances[i]!)} GLM`)

  // One of each, measured, for the gas limits.
  const probe = senders[0]!
  const probeKey = (await probe.createEntity(kind.schema, kind.values(0) as never, week)).entityKey
  const gasOf = async (send: () => Promise<{ txHash: Hex }>) =>
    (await publicClient.getTransactionReceipt({ hash: (await send()).txHash })).gasUsed
  const limits = {
    create: await gasOf(() => probe.createEntity(kind.schema, kind.values(1) as never, week)),
    patch: await gasOf(() => probe.patchEntity(kind.schema, probeKey, { set: kind.patch(0) as never })),
    extend: await gasOf(() =>
      probe.extendEntity({ entityKey: probeKey, expiration: ExpirationTime.fromWeeks(2) }),
    ),
  }
  for (const op of ["create", "patch", "extend"] as const) limits[op] = (limits[op] * 11n) / 10n
  console.log(`gas limits: create ${fmt(limits.create)}, patch ${fmt(limits.patch)}, extend ${fmt(limits.extend)}`)

  // The entities each sender patches and extends, its own, in one batch per sender.
  const targets = await Promise.all(
    senders.map(async (sender) => {
      const creates = Array.from({ length: BLOCK_PATCHES + BLOCK_EXTENDS }, (_, i) => ({
        schema: kind.schema,
        values: normalValues(i, sender.account.address),
        ...week,
      }))
      if (creates.length === 0) return []
      return (await sender.executeBatch({ creates } as never)).createdEntities
    }),
  )
  console.log(`targets: ${fmt(targets.flat().length)} entities created to patch and extend`)

  // Explicit fees and nonces: the SDK then sends without estimating, so every transaction is in
  // the pool within moments. Two base fees of headroom, as viem would leave.
  const baseFee = (await publicClient.getBlock()).baseFeePerGas ?? 0n
  const tip = 1_000_000_000n
  const fees = { maxFeePerGas: 2n * baseFee + tip, maxPriorityFeePerGas: tip }
  const nonces = await Promise.all(
    senders.map((s) => publicClient.getTransactionCount({ address: s.account.address, blockTag: "pending" })),
  )

  type Sent = { op: string; txHash?: Hex; error?: string }
  const jobs: (() => Promise<Sent>)[] = []
  senders.forEach((sender, s) => {
    let nonce = nonces[s]!
    const own = targets[s]!
    const send = (op: string, gas: bigint, run: (tx: { gas: bigint; nonce: number }) => Promise<{ txHash: Hex }>) => {
      const tx = { gas, nonce: nonce++, ...fees }
      jobs.push(() =>
        run(tx).then(
          (r) => ({ op, txHash: r.txHash }),
          (e) => ({ op, error: describeFailure(e), txHash: (e as { txHash?: Hex }).txHash }),
        ),
      )
    }
    for (let i = 0; i < BLOCK_CREATES; i++) {
      send("create", limits.create, (tx) =>
        sender.createEntity(kind.schema, normalValues(100 + i, sender.account.address) as never, week, tx),
      )
    }
    for (let i = 0; i < BLOCK_PATCHES; i++) {
      send("patch", limits.patch, (tx) =>
        sender.patchEntity(kind.schema, own[i]!, { set: kind.patch(i) as never }, tx),
      )
    }
    for (let i = 0; i < BLOCK_EXTENDS; i++) {
      send("extend", limits.extend, (tx) =>
        sender.extendEntity({ entityKey: own[BLOCK_PATCHES + i]!, expiration: ExpirationTime.fromWeeks(2) }, tx),
      )
    }
  })

  // Start at the beginning of a block, to give the sends the whole slot.
  const start = await publicClient.getBlockNumber()
  while ((await publicClient.getBlockNumber()) === start) await Bun.sleep(50)
  const fired = performance.now()
  const sent = await Promise.all(jobs.map((job) => job()))
  console.log(`all ${fmt(sent.length)} receipts in after ${((performance.now() - fired) / 1000).toFixed(1)} s`)

  const failed = sent.filter((s) => s.error)
  for (const f of failed.slice(0, 3)) console.log(`failed ${f.op}: ${f.error}`)
  if (failed.length > 3) console.log(`… and ${failed.length - 3} more failed`)

  type BlockRow = { creates: number; patches: number; extends: number; gas: bigint }
  const byBlock = new Map<bigint, BlockRow>()
  for (const s of sent.filter((s) => s.txHash)) {
    const receipt = await publicClient.getTransactionReceipt({ hash: s.txHash! })
    const row = byBlock.get(receipt.blockNumber) ?? { creates: 0, patches: 0, extends: 0, gas: 0n }
    if (s.op === "create") row.creates++
    if (s.op === "patch") row.patches++
    if (s.op === "extend") row.extends++
    row.gas += receipt.gasUsed
    byBlock.set(receipt.blockNumber, row)
  }
  console.log(
    line([["block", 7], ["ops", 5], ["creates", 8], ["patches", 8], ["extends", 8], ["block gasUsed", 14],
      ["of limit", 9]]),
  )
  let fullest = { ops: 0, share: 0 }
  for (const number of [...byBlock.keys()].sort((a, b) => Number(a - b))) {
    const row = byBlock.get(number)!
    const block = await publicClient.getBlock({ blockNumber: number })
    const ops = row.creates + row.patches + row.extends
    const share = Number((block.gasUsed * 1000n) / block.gasLimit) / 10
    if (ops > fullest.ops) fullest = { ops, share }
    console.log(
      line([[String(number), 7], [String(ops), 5], [String(row.creates), 8], [String(row.patches), 8],
        [String(row.extends), 8], [fmt(block.gasUsed), 14], [`${share.toFixed(1)}%`, 9]]),
    )
  }
  console.log(
    `${fmt(sent.length - failed.length)} of ${fmt(sent.length)} ops landed in ${byBlock.size} block(s); ` +
      `the fullest held ${fullest.ops} ops at ${fullest.share.toFixed(1)}% of the block gas limit`,
  )
  const senderSpent = (
    await Promise.all(senders.map(async (s, i) => senderBalances[i]! - (await publicClient.getBalance({ address: s.account.address }))))
  ).reduce((sum, spent) => sum + spent, 0n)
  console.log(`block senders spent ${glm(senderSpent)} GLM (${usd(senderSpent)}) together`)
}

// What the run cost the sender, for comparing with the budget.
const spent = startBalance - (await publicClient.getBalance({ address: account.address }))
console.log(`\nsender spent ${glm(spent)} GLM (${usd(spent)}) in this run; log ${LOG}`)

process.exit(mismatches === 0 ? 0 : 1)
