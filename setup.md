# Arkiv tokenomics experiment on a live chain

This repository measures what Arkiv entity operations cost on a live chain: gas, storage gas and
fees, for entities of different sizes and lifetimes. The experiment was developed against local
dev nodes in the `Arkiv-Network/arkiv` repository and is being moved here to run against a live
chain.

## What it measures

The script `experiment/tokenomics.ts` goes through the Arkiv TypeScript SDK
(`@arkiv-network/sdk@0.9.0-next.3`) and prints tables. It doesn't assert anything, so it works with
any fee schedule.

- **Creates:** three entity sizes, each with three lifetimes. For each one it reports gas used, the
  storage part of the gas, the fee in GLM and USD, and how many such transactions fit in a block.

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

The script is copied unchanged from the `Arkiv-Network/arkiv` repository, branch
`matthiaszimmermann/feat/tokenomics-init`, commit `70ae602`, file
`kurtosis/integration/experiment/tokenomics.ts`. The dependency versions in `package.json` are
the ones that branch's lockfile resolved to.

## Changes needed before running on a live chain

The script assumes a private dev node. These six changes must be made before it sends anything to
a live chain. [SETUP.md](SETUP.md) gives the agent doing the setup exact instructions for each.

| Dev-node assumption | Change for the live chain |
| --- | --- |
| Falls back to a publicly known dev key | Require a real key from `.env`, which git ignores, and refuse the dev key |
| Reads the maximum lifetime from the local dev genesis file | Require the live chain's genesis file, or its maximum lifetime directly, and check the chain id |
| Storage gas is taken from changes in the pool's balance, assuming no other traffic | Flag any measurement where other Arkiv transactions landed in the same blocks, and leave it out of the averages |
| The block-fill test sends from dev accounts anyone can control | Make the test opt-in, using keys we provide |
| The SDK assumes 2-second blocks | Measure the real block time, and say so if "one week" isn't a calendar week |
| Output only goes to the console | Also save each run to a log file in `results/` |

## How it will be run

The run happens in stages, with approval between them:

1. **Smoke test:** one minimal entity with the short lifetime, to confirm the SDK version works with
   the chain.
2. **Cost estimate:** extrapolated from the smoke test and one big entity, then compared with the
   budget. The big entities with the long lifetime will cost by far the most.
3. **Full run**, once the estimate is approved, starting with one entity per combination.
4. **Block-fill test**, only if explicitly allowed, as a separate run.

## Inputs needed

- RPC URL and chain id
- A funded sender key, put in `.env` by whoever owns it and never pasted into chat or committed
- The chain's genesis file, or its maximum lifetime in blocks
- A budget in GLM, and the GLM price in USD for the dollar figures
- Whether the block-fill test may run, and if so, funded keys for its extra senders
- Whether the chain carries other traffic, which affects how far the storage figures can be trusted

## Side effects

Entities created on a live chain are public and stay until they expire. The long-lived ones last for
the chain's maximum lifetime, about six months at the dev chain's value. Their bodies are random
bytes, so nothing sensitive is written.
