// A new account, its private key generated in memory and stored only encrypted, as a keystore v3
// file under a password asked for on the terminal. Prints the address to fund, never the key.
//
//   bun experiment/new-wallet.ts [path]       (default wallets/sender.json)
//
// Then point ARKIV_KEYSTORE (or one of BLOCK_KEYSTORES) in .env at the file. The path must be one
// git ignores, as wallets/ is, and an existing file is never overwritten.

import { existsSync, mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { decrypt, encrypt, readPassword, readKeystore, writeKeystore } from "./keystore"

const MIN_PASSWORD = 8

function fail(message: string): never {
  console.log(`no wallet made: ${message}`)
  process.exit(1)
}

const path = resolve(process.argv[2] ?? "wallets/sender.json")
if (existsSync(path)) fail(`${path} exists; pick another path`)
mkdirSync(dirname(path), { recursive: true })

// Inside a git work tree the file must be ignored, so it cannot be committed by accident. Exit 1
// means not ignored; 128, not in a work tree.
const ignored = Bun.spawnSync(["git", "check-ignore", "-q", path], { cwd: dirname(path) })
if (ignored.exitCode === 1) fail(`git does not ignore ${path}; put it under wallets/ or outside the repo`)

const ask = (question: string) => readPassword(question).catch((error: Error) => fail(error.message))
const password = await ask(`new password (at least ${MIN_PASSWORD} characters): `)
if (password.length < MIN_PASSWORD) fail(`the password has ${password.length} characters, fewer than ${MIN_PASSWORD}`)
if ((await ask("same password again: ")) !== password) fail("the passwords differ")

const privateKey = generatePrivateKey()
// Read back what was written before saying it worked.
writeKeystore(path, encrypt(privateKey, password))
if (decrypt(readKeystore(path), password) !== privateKey) fail(`${path} does not decrypt to the key`)

console.log(`address ${privateKeyToAccount(privateKey).address}\nkeystore ${path}`)
process.exit(0)
