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

## Things to know

- Entities are public and stay on the chain until they expire. The long lifetime is the chain's
  maximum, about six months. Bodies are random bytes.
- `MAX_LIFETIME` in `.env` is the dev chain's value; confirm it for rabdi, or set `GENESIS` to
  rabdi's genesis file instead.
- Storage figures marked `*` shared their blocks with other Arkiv transactions and may include
  what those paid. They are left out of the storage averages.
- The SDK counts 2 s per block. The run measures the real block time and says when "one week"
  isn't a calendar week.
