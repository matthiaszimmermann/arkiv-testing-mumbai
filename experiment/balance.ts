// The GLM balance of the ARKIV_KEYSTORE wallet, or of the keystore given as the first argument.
// A keystore holds its address in the clear, so this needs no password.
//
//   bun experiment/balance.ts [keystore]

import { readFileSync } from "node:fs"
import { createPublicClient, formatEther, getAddress, http } from "viem"

const path = process.argv[2] ?? process.env.ARKIV_KEYSTORE
const url = process.env.ARKIV_RPC_URL?.trim()
if (!path || !url) {
  console.log("ARKIV_KEYSTORE and ARKIV_RPC_URL need to be set; see .env.example")
  process.exit(2)
}
const key = process.env.ARKIV_RPC_ACCESS_KEY?.trim()
const client = createPublicClient({
  transport: http(key ? `${url.replace(/\/+$/, "")}/${encodeURIComponent(key)}` : url),
})
const address = getAddress(`0x${JSON.parse(readFileSync(path, "utf8")).address}`)
console.log(`${address} ${formatEther(await client.getBalance({ address }))} GLM`)
