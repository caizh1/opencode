import { randomBytes } from "node:crypto"

export function createNonce(length = 32) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  const bytes = randomBytes(length)
  let nonce = ""
  for (const byte of bytes) nonce += alphabet[byte % alphabet.length]
  return nonce
}
