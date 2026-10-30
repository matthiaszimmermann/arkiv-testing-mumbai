# Arkiv tokenomics on rabdi

Measures what Arkiv entity operations cost on rabdi, Arkiv's testnet: gas, storage gas and fees
for creates of three sizes and three lifetimes, and for a patch, an extend, a transfer and a delete.
[setup.md](setup.md) has the background: what is measured, where the script comes from, and how it
differs from the dev-node original.

## Setup

Open the repo in its devcontainer. It has [bun](https://bun.sh) and runs `bun install` on
creation; outside it, install bun 1.3 and run `bun install`.

```sh
cp .env.example .env
```

`.env` comes with rabdi's RPC URL and chain id. Adding an access key
([hub.arkiv.network/access-keys](https://hub.arkiv.network/access-keys)) to the URL is recommended,
as the public endpoint is heavily rate limited:

```
ARKIV_RPC_URL=https://rpc.rabdi.db-chain.testnet.arkiv.network/<accessKey>
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
