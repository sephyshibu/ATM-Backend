import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto"

import { appConfig } from "../config"

// Secrets for the calendar connection.
//   - A calendar refresh token lets the server act on someone's calendar, so it's encrypted at rest with
//     AES-256-GCM (authenticated: a tampered value fails to decrypt), never logged and never sent to the browser.
//   - The Google "connect" request carries a signed state (who started it, when, a nonce), so the callback trusts
//     it without a session and a forged or replayed callback is refused.
// Both use CALENDAR_ENC_KEY (64 hex characters); the signing key is derived from it, so the two never share a key.

export const calendarKeyConfigured = () => /^[0-9a-fA-F]{64}$/.test(appConfig().calendar.encKey)

function encKey(): Buffer {
  if (!calendarKeyConfigured()) throw new Error("CALENDAR_ENC_KEY isn't set.")
  return Buffer.from(appConfig().calendar.encKey, "hex")
}

const signKey = () => createHash("sha256").update(Buffer.concat([Buffer.from("atm-calendar-state:"), encKey()])).digest()

/** `iv.tag.ciphertext`, each base64. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", encKey(), iv)
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${enc.toString("base64")}`
}

export function decryptSecret(blob: string): string {
  const [iv, tag, enc] = blob.split(".")
  if (!iv || !tag || !enc) throw new Error("Malformed encrypted secret.")
  const d = createDecipheriv("aes-256-gcm", encKey(), Buffer.from(iv, "base64"))
  d.setAuthTag(Buffer.from(tag, "base64"))
  return Buffer.concat([d.update(Buffer.from(enc, "base64")), d.final()]).toString("utf8")
}

export function signState(userId: string): string {
  const payload = `${userId}.${Date.now()}.${randomBytes(8).toString("hex")}`
  const sig = createHmac("sha256", signKey()).update(payload).digest("base64url")
  return Buffer.from(`${payload}.${sig}`).toString("base64url")
}

/** The user id from a signed state no older than 10 minutes, or null. */
export function verifyState(state: string, maxAgeMs = 10 * 60 * 1000): string | null {
  try {
    const decoded = Buffer.from(state, "base64url").toString("utf8")
    const cut = decoded.lastIndexOf(".")
    if (cut < 0) return null
    const payload = decoded.slice(0, cut)
    const a = Buffer.from(decoded.slice(cut + 1))
    const b = Buffer.from(createHmac("sha256", signKey()).update(payload).digest("base64url"))
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null
    const [userId, ts] = payload.split(".")
    if (!userId || !ts || Date.now() - Number(ts) > maxAgeMs) return null
    return userId
  } catch {
    return null
  }
}
