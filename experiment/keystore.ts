// Private keys at rest as Ethereum keystore v3 files (Web3 Secret Storage: scrypt and
// aes-128-ctr), the format geth, MetaMask and foundry's `cast wallet` read and write, and the
// password read from the terminal without echoing it. Keys only ever exist in memory.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { concat, keccak256, toHex, type Hex } from "viem"
import { privateKeyToAccount } from "viem/accounts"

type ScryptParams = { dklen: number; n: number; r: number; p: number; salt: string }

export type Keystore = {
  version: 3
  id: string
  address: string
  crypto: {
    cipher: "aes-128-ctr"
    cipherparams: { iv: string }
    ciphertext: string
    kdf: "scrypt"
    kdfparams: ScryptParams
    mac: string
  }
}

// geth's standard parameters: about 0.4 s and 256 MiB per derivation.
const N = 262144
const R = 8
const P = 1

function derive(password: string, params: ScryptParams): Buffer {
  return scryptSync(password, Buffer.from(params.salt, "hex"), params.dklen, {
    N: params.n,
    r: params.r,
    p: params.p,
    maxmem: 2 * 128 * params.n * params.r * params.p,
  })
}

// keccak256 of the derived key's second half and the ciphertext, as the format defines it.
const macOf = (derived: Buffer, ciphertext: Buffer) => keccak256(concat([derived.subarray(16, 32), ciphertext])).slice(2)

export function encrypt(privateKey: Hex, password: string): Keystore {
  const kdfparams = { dklen: 32, n: N, r: R, p: P, salt: randomBytes(32).toString("hex") }
  const derived = derive(password, kdfparams)
  const iv = randomBytes(16)
  const cipher = createCipheriv("aes-128-ctr", derived.subarray(0, 16), iv)
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(privateKey.slice(2), "hex")), cipher.final()])
  return {
    version: 3,
    id: crypto.randomUUID(),
    address: privateKeyToAccount(privateKey).address.slice(2).toLowerCase(),
    crypto: {
      cipher: "aes-128-ctr",
      cipherparams: { iv: iv.toString("hex") },
      ciphertext: ciphertext.toString("hex"),
      kdf: "scrypt",
      kdfparams,
      mac: macOf(derived, ciphertext),
    },
  }
}

export function decrypt(keystore: Keystore, password: string): Hex {
  const { crypto: c } = keystore
  if (keystore.version !== 3 || c?.kdf !== "scrypt" || c.cipher !== "aes-128-ctr") {
    throw new Error("not a version 3 keystore with scrypt and aes-128-ctr")
  }
  const derived = derive(password, c.kdfparams)
  const ciphertext = Buffer.from(c.ciphertext, "hex")
  if (!timingSafeEqual(Buffer.from(macOf(derived, ciphertext), "hex"), Buffer.from(c.mac, "hex"))) {
    throw new WrongPasswordError()
  }
  const decipher = createDecipheriv("aes-128-ctr", derived.subarray(0, 16), Buffer.from(c.cipherparams.iv, "hex"))
  const privateKey = toHex(Buffer.concat([decipher.update(ciphertext), decipher.final()]))
  if (privateKeyToAccount(privateKey).address.slice(2).toLowerCase() !== keystore.address.toLowerCase()) {
    throw new Error(`the key decrypts, but not to the keystore's address 0x${keystore.address}`)
  }
  return privateKey
}

export class WrongPasswordError extends Error {
  constructor() {
    super("wrong password")
    this.name = "WrongPasswordError"
  }
}

export const readKeystore = (path: string): Keystore => JSON.parse(readFileSync(path, "utf8"))

// Readable by its owner only, and never over an existing file.
export function writeKeystore(path: string, keystore: Keystore) {
  writeFileSync(path, `${JSON.stringify(keystore, null, 2)}\n`, { mode: 0o600, flag: "wx" })
}

// A line from the terminal, not echoed. Refuses when there is no terminal, rather than reading a
// password from a pipe or file.
export function readPassword(question: string): Promise<string> {
  const stdin = process.stdin
  if (!stdin.isTTY) return Promise.reject(new Error(`no terminal to ask for the password on: ${question}`))
  process.stdout.write(question)
  stdin.setRawMode(true)
  stdin.setEncoding("utf8")
  stdin.resume()
  return new Promise((resolve, reject) => {
    let password = ""
    const done = () => {
      stdin.off("data", onData)
      stdin.setRawMode(false)
      stdin.pause()
      process.stdout.write("\n")
    }
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          done()
          resolve(password)
          return
        }
        if (char === "\u0003" || char === "\u0004") {
          done()
          reject(new Error("cancelled"))
          return
        }
        password = char === "\u007f" || char === "\b" ? password.slice(0, -1) : password + char
      }
    }
    stdin.on("data", onData)
  })
}

// Decrypts a keystore file, asking for its password until it is right or given up on.
// `remembered` is tried first, so several keystores with one password are asked for only once.
export async function unlock(path: string, remembered?: { password?: string }): Promise<Hex> {
  const keystore = readKeystore(path)
  if (remembered?.password !== undefined) {
    try {
      return decrypt(keystore, remembered.password)
    } catch (error) {
      if (!(error instanceof WrongPasswordError)) throw error
    }
  }
  for (let attempt = 1; ; attempt++) {
    const password = await readPassword(`password for ${path} (0x${keystore.address}): `)
    try {
      const privateKey = decrypt(keystore, password)
      if (remembered) remembered.password = password
      return privateKey
    } catch (error) {
      if (!(error instanceof WrongPasswordError) || attempt === 3) throw error
      console.log("wrong password")
    }
  }
}
