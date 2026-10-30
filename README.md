# Arkiv tokenomics on rabdi

Measures what Arkiv entity operations cost on rabdi, Arkiv's testnet: gas, storage gas and fees
for creates of three sizes and three lifetimes, and for a patch, an extend, a transfer and a delete.

## What it measures

The script, `experiment/tokenomics.ts`, works through the Arkiv TypeScript SDK and prints tables.
It asserts nothing, so it works with any fee schedule.

- **Creates:** three entity sizes, each with three lifetimes. For each, the gas used, the storage
  part of it, the fee in GLM and USD, and how many such transactions fit in a block.

  | Kind | Attributes | Indexed | Body |
  | --- | --- | --- | --- |
  | minimal | 1 | 0 | none |
  | normal | 10 | 4 | 300 bytes |
  | big | 20 | 15 | 100 KiB |

  Lifetimes: short (100 blocks), medium (one week, 302,400 blocks at 2 s per block) and long (the
  chain's maximum lifetime).
- **Operations:** a patch, an extend by one week, a transfer and a delete, for each size.
- **Block fill (optional):** many senders submit at once, and a table shows how many operations fit
  in each block.

## Source

The script started as `kurtosis/integration/experiment/tokenomics.ts` in `Arkiv-Network/arkiv`,
branch `matthiaszimmermann/feat/tokenomics-init`, commit `70ae602`, written against local dev
nodes. Here it is adapted to a live chain: an encrypted wallet instead of dev keys, a chain-id
check, flagging of storage figures that other traffic may have affected, an opt-in block fill with
its own wallets, a measured block time, and a log per run.

The dependency versions are those that branch's lockfile resolved to, except the SDK: that branch
used `@arkiv-network/sdk@0.9.0-next.3`, and this repo uses `0.9.0-next.5`, the first version that
defines the rabdi chain. Between the two, nothing changed in the write path or in `getEntity`,
which are all the script uses.

## Setup

Open the repo in its devcontainer. It has [bun](https://bun.sh) and runs `bun install` on
creation; outside it, install bun 1.3 and run `bun install`.

```sh
cp .env.example .env
```

`.env` comes with rabdi's RPC URL and chain id. Setting an access key
([hub.arkiv.network/access-keys](https://hub.arkiv.network/access-keys)) is recommended, as the
public endpoint is heavily rate limited. The run appends it to the URL and keeps it out of its
output:

```
ARKIV_RPC_ACCESS_KEY=<accessKey>
```

## Wallet

The sender's private key is never stored in plaintext. Make an encrypted wallet:

```sh
bun run new-wallet
```

It generates a key in memory and asks for a password (at least 8 characters). It then writes
`wallets/sender.json`, a standard Ethereum keystore that git ignores, and prints the address.
Fund that address with tGLM. `.env` points at the wallet with `ARKIV_KEYSTORE`.

Every run asks for the password on the terminal and keeps the key in memory only. Runs therefore
need an interactive terminal.

## Running

Each run prints tables and saves them to `results/tokenomics-<time>.log`. The run ends with what
it cost the sender.

1. **Smoke test.** One minimal entity with the shortest lifetime, to confirm the SDK works with
   the chain:

   ```sh
   SECTIONS=creates ONLY=minimal/short COUNT=1 bun run tokenomics
   ```

2. **Cost estimate.** Add one big entity, then extrapolate before spending more. Big entities with
   the long lifetime cost the most:

   ```sh
   SECTIONS=creates ONLY=big/short COUNT=1 bun run tokenomics
   ```

3. **Full run.** All sizes and lifetimes plus the operations, one entity per combination:

   ```sh
   COUNT=1 bun run tokenomics
   ```

4. **Block fill** (optional, only when agreed). It needs extra funded wallets, made with
   `bun run new-wallet wallets/block-01.json` and so on and listed in `BLOCK_KEYSTORES`, and it
   runs on its own:

   ```sh
   SECTIONS=block bun run tokenomics
   ```

`.env.example` lists every setting. Values given on the command line override `.env`.

## Throughput

A second script, `experiment/throughput.ts`, creates entities in batches: each batch is one
transaction. It has two sections, and by default runs both:

- **batches:** each iteration sends one batch of 10, 50, 100 and 200 entities. Each batch's line
  shows its gas, calldata size, fee, wait time, how full its block was and the block's base fee.
  An overview then gives, for each batch size, the gas and fee per entity and how many entities
  fit in a block and in a second.
- **fill:** fills 20 consecutive blocks well above the base fee's target, to see gas get more
  expensive. After one probe batch to learn the gas, it keeps 16 batches of 50 entities pending
  at all times, more than a block takes (5 at a 30M gas limit), and sends new ones as soon as a
  block takes some. A batch the RPC refuses is sent again with the same nonce, as a skipped nonce
  would hold back all batches after it. A line per block shows its fill and base fee as the run
  goes. At the end a table shows each block, from just before the fill to a
  few blocks after, with its base fee's change next to what EIP-1559 would set, and the gas price
  paid by the first batch against the last.

The run is logged to `results/throughput-<time>.log`.

The batch size sets the entities' shape. The RPC refuses requests of 256 KiB or more (a 413), and
a transaction travels in them hex-encoded, at twice its size. The ABI encoding takes 352 bytes per
create and 192 per attribute, however small the values. So each batch size gets as many
attributes, up to 7, as still fit one transaction:

| Batch | Attributes | Indexed | Kept |
| --- | --- | --- | --- |
| 10, 50 | 7 | 3 | category, priority, author, body, title, summary, version |
| 100 | 4 | 3 | category, priority, author, body |
| 200 | 1 | 1 | category |

Every value fits in 32 bytes; the body is 32 random bytes. A batch of more than 238 entities is
refused before the run starts.

Start with one iteration, then add more:

```sh
bun run throughput
ITERATIONS=5 bun run throughput
```

`BATCH_SIZES` changes the sizes and `LIFETIME` sets how many blocks the entities live (default
100, which keeps storage cheap).

By default each batch waits for the one before it to be mined, so every batch has a block to
itself and `entities/block` in the overview is worked out from gas. To see how many actually fit,
send several batches of a size at once:

```sh
PARALLEL=8 bun run throughput
```

Each step then sends 8 batches of one size together at the start of a block, and a line under them
shows which blocks they landed in. The overview's `seen/block` column gives the most entities of
each size seen in one block. All batches come from the one sender, so the chain takes them in nonce
order: a batch that doesn't fit the rest of a block holds back the ones after it. `PARALLEL` is at
most 16, the pending transactions reth guarantees per sender. If a batch in a step fails, the run
stops, since the batches after it may still be pending.

The fill costs the most: a full 30M-gas block takes 0.03 GLM at a base fee of 1 gwei, and more as
the base fee climbs. The run retries requests the access key's rate limit refuses, for about a
minute each, so a burst slows down instead of failing. It stops sending early once it has spent `FILL_BUDGET` (default 5 GLM); the
batches still pending then land on top of that. To run only the fill, or fill for longer:

```sh
SECTIONS=fill bun run throughput
SECTIONS=fill FILL_BLOCKS=50 FILL_BUDGET=10 bun run throughput
```

The expected base fee uses Ethereum's rule: a target of half the block gas limit, and a change of
at most 1/8 per block. If rabdi uses another rule, set `BASE_FEE_ELASTICITY` and
`BASE_FEE_DENOMINATOR`; the `change` column shows what the chain actually did either way.

## Things to know

- Entities are public and stay on the chain until they expire. The long lifetime is the chain's
  maximum, about six months. Bodies are random bytes.
- `MAX_LIFETIME` in `.env` is the dev chain's value; confirm it for rabdi, or set `GENESIS` to
  rabdi's genesis file instead.
- Storage figures marked `*` shared their blocks with other Arkiv transactions and may include
  what those paid. They are left out of the storage averages.
- The SDK counts 2 s per block. The run measures the real block time and says when "one week"
  isn't a calendar week.
