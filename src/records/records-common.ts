import type { Prisma } from "@prisma/client"

import { countryLabel, COUNTRY_CODES } from "../common/countries"
import { badRequest } from "../common/errors"

// Shared by organisations, brands and people: tidy values the way they are stored, check list codes and
// countries, and describe a change as before/after lines for the change log.

type Db = Prisma.TransactionClient

/** "https://www.GlowCo.com/about" → "glowco.com". Null for an empty value; an error for something that isn't a web address. */
export function normaliseDomain(raw: string | null | undefined, label = "Website"): string | null {
  const s = (raw ?? "").trim().toLowerCase()
  if (!s) return null
  const host = s
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, "")
    .replace(/\.$/, "")
  if (!/^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(host)) throw badRequest(`${label}: enter a web address like glowco.com.`)
  return host
}

export function normaliseEmail(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim().toLowerCase()
  if (!s) return null
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) || s.length > 254) throw badRequest("Enter a valid email address.")
  return s
}

export function normaliseUrl(raw: string | null | undefined, label: string): string | null {
  const s = (raw ?? "").trim()
  if (!s) return null
  const url = /^https?:\/\//i.test(s) ? s : `https://${s}`
  try {
    const u = new URL(url)
    if (!u.hostname.includes(".")) throw new Error()
    return u.toString().replace(/\/$/, "")
  } catch {
    throw badRequest(`${label}: enter a full link.`)
  }
}

export function checkCountry(code: string | null | undefined, label: string): string | null {
  const c = (code ?? "").trim().toUpperCase()
  if (!c) return null
  if (!COUNTRY_CODES.has(c)) throw badRequest(`${label}: pick a country from the list.`)
  return c
}

export function checkCountries(codes: string[] | undefined, label: string) {
  if (!codes) return undefined
  return [...new Set(codes.map((c) => checkCountry(c, label)).filter((c): c is string => !!c))].sort()
}

/**
 * A pick-list value by its code. A value that is already on the record may stay even after it was retired;
 * a newly chosen value must be in use. Returns the stored code and its label (for the change log).
 */
export async function checkListCode(db: Db, listKey: string, code: string | null | undefined, current: string | null | undefined, label: string) {
  const c = (code ?? "").trim()
  if (!c) return { code: null, label: "—", parentId: null as string | null }
  const v = await db.listValue.findUnique({ where: { listKey_code: { listKey, code: c } } })
  if (!v || (v.retiredAt && c !== current)) throw badRequest(`${label}: pick a value from the list.`)
  return { code: c, label: v.label, parentId: v.parentId, id: v.id }
}

/** Labels for codes in one go, for screens and the change log. */
export async function listLabels(db: Db, listKey: string) {
  const values = await db.listValue.findMany({ where: { listKey }, select: { code: true, label: true } })
  return new Map(values.map((v) => [v.code, v.label]))
}

export type Change = { label: string; before: unknown; after: unknown; show?: (v: unknown) => string }

const plain = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : Array.isArray(v) ? (v.length ? v.join(", ") : "—") : String(v))

/** Only the fields that changed, as "Label: value" lines before and after. */
export function describe(changes: Change[]) {
  const before: string[] = []
  const after: string[] = []
  for (const c of changes) {
    const show = c.show ?? plain
    const a = show(c.before)
    const b = show(c.after)
    if (a === b) continue
    before.push(`${c.label}: ${a}`)
    after.push(`${c.label}: ${b}`)
  }
  return { changed: after.length > 0, before: before.join("\n"), after: after.join("\n") }
}

export const showCountry = (v: unknown) => countryLabel(v as string | null)
export const showCountries = (v: unknown) => ((v as string[] | null)?.length ? (v as string[]).map((c) => countryLabel(c)).join(", ") : "—")
export const showUsd = (v: unknown) => (v === null || v === undefined ? "—" : `USD ${Number(v).toLocaleString("en-US")}`)

/** Columns every record table shares, for "who archived it" and "who last changed it". */
export const archiveData = (me: { id: string }) => ({ archivedAt: new Date(), archivedById: me.id, updatedById: me.id })
export const restoreData = (me: { id: string }) => ({ archivedAt: null, archivedById: null, updatedById: me.id })
