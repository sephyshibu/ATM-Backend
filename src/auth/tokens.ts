import { createHash, randomBytes } from "node:crypto"

/** A long random token for a cookie or an invite link. Only its hash is stored. */
export const newToken = () => randomBytes(32).toString("base64url")

export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex")

export const SESSION_COOKIE = "atm_session"
