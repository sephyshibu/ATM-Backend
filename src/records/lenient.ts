// Reading real research sheets. A Brand Register is written by people, so its cells hold estimates, ranges and
// notes: "Est. 5–7M", "$100 - $500 million", "Not publicly disclosed", "11-50", "Tony Costello - Founder CEO".
// These helpers read what can be read and say plainly what couldn't, so the import can keep the row and warn,
// instead of rejecting a whole brand for one untidy cell.

const text = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim())

/** Cells that only say "we don't know": "none", "n/a", "not identified", "not publicly disclosed", "___", "-", "?". */
export function isUnknownText(raw: unknown): boolean {
  const s = text(raw).toLowerCase()
  if (!s) return true
  if (/^[\s_\-—–.?/x]*$/.test(s)) return true
  return /^(none|nil|null|n\/?a|na|tbc|tbd|unknown|not (yet )?(known|identified|indentified|found|available|disclosed|confirmed|stated|public(ly|tly)? disclosed)|undisclosed|private|no data|not public(ly|tly)? disclosed)\b/.test(s)
}

const MULT: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mn: 1e6, mm: 1e6, million: 1e6, millions: 1e6, b: 1e9, bn: 1e9, billion: 1e9, billions: 1e9 }

export type Revenue = { min: number; max: number | null; note: string | null }

/**
 * A revenue cell as whole US dollars: one amount, or a range. "$13.2M", "12,500,000", "Est. 5 -7M",
 * "$100 - $500 million", "est $25-50M". A bare number under 10,000 is read as millions (a brand with revenue of
 * $13 is not a real case; "13.2" in a "USD m" column is). Text with no number ("Not disclosed") is unknown.
 * Returns null for unknown, or { error } when there's a number but it can't be read.
 */
export function parseRevenue(raw: unknown): Revenue | null | { error: string } {
  if (raw === null || raw === undefined || raw === "") return null
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || raw < 0) return { error: `"${raw}" isn't an amount.` }
    return raw < 10_000 ? { min: Math.round(raw * 1e6), max: null, note: `${raw} read as USD ${raw}M.` } : { min: Math.round(raw), max: null, note: null }
  }
  const original = text(raw)
  if (!/\d/.test(original)) return null
  let s = original.toLowerCase()
  s = s.replace(/\b(est(imated)?|approx(imately)?|about|around|circa|ca|c\.|roughly|over|under|more than|less than|up to)\b\.?/g, " ")
  s = s.replace(/us\$|usd|\$|~|≈|\+/g, " ").replace(/,(?=\d{3}\b)/g, "").replace(/\(.*?\)/g, " ")
  const m = /(\d+(?:\.\d+)?)\s*(k|thousand|mn|mm|m|million|millions|bn|b|billion|billions)?\s*(?:(?:-|–|—|to)\s*(\d+(?:\.\d+)?)\s*(k|thousand|mn|mm|m|million|millions|bn|b|billion|billions)?)?/.exec(s)
  if (!m) return { error: `"${original}" isn't an amount.` }
  const unitHi = m[4] ?? m[2]
  const unitLo = m[2] ?? m[4]
  const lo = Number(m[1]) * (unitLo ? MULT[unitLo] : 1)
  const hi = m[3] !== undefined ? Number(m[3]) * (unitHi ? MULT[unitHi] : 1) : null
  const scale = (n: number, hadUnit: boolean) => (!hadUnit && n < 10_000 ? n * 1e6 : n)
  const min = Math.round(scale(lo, !!unitLo))
  const max = hi === null ? null : Math.round(scale(hi, !!unitHi))
  if (max !== null && max < min) return { error: `"${original}": the range runs backwards.` }
  const clean = original.replace(/\s+/g, " ")
  const rewritten = max !== null ? `${usdShort(min)}–${usdShort(max).replace("USD ", "")}` : usdShort(min)
  const plain = /^\$?\s?\d[\d,]*(\.\d+)?\s?(k|m|mn|b|bn)?$/i.test(clean.replace(/usd\s?/i, ""))
  return { min, max: max === min ? null : max, note: plain && max === null ? null : `"${clean}" read as ${rewritten}.` }
}

/** 12500000 → "USD 12.5M". */
export function usdShort(n: number) {
  if (n >= 1e9) return `USD ${trim(n / 1e9)}B`
  if (n >= 1e6) return `USD ${trim(n / 1e6)}M`
  if (n >= 1e3) return `USD ${trim(n / 1e3)}K`
  return `USD ${n}`
}
const trim = (n: number) => String(Number(n.toFixed(2)))

/** A year from "2025", 2025.0, "FY2025" or "Aug 31-2026"; unknown for "none". */
export function parseYear(raw: unknown): { year: number | null; note: string | null } | { error: string } {
  if (raw === null || raw === undefined || raw === "") return { year: null, note: null }
  if (typeof raw === "number") return Number.isInteger(raw) && raw >= 1990 && raw <= 2100 ? { year: raw, note: null } : { error: `"${raw}" isn't a year between 1990 and 2100.` }
  const s = text(raw)
  if (isUnknownText(s) || !/\d/.test(s)) return { year: null, note: `Revenue year "${s}" left empty.` }
  const years = [...new Set([...s.matchAll(/(?<!\d)(19\d{2}|20\d{2}|2100)(?!\d)/g)].map((x) => Number(x[1])))]
  if (years.length === 1) return { year: years[0], note: /^\s*(fy)?\s*\d{4}\s*$/i.test(s) ? null : `Revenue year "${s}" read as ${years[0]}.` }
  return { error: `Revenue year "${s}" isn't a year.` }
}

/** "11-50" or "36–40" → "11–50"; "99" → 99; unknown → null. For number facts such as headcount. */
export function parseNumberOrRange(raw: unknown): number | string | null | { error: string } {
  if (raw === null || raw === undefined || raw === "") return null
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : { error: `"${raw}" isn't a number.` }
  const s = text(raw)
  if (isUnknownText(s)) return null
  const r = /^\s*~?\s*(\d[\d,]*(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d[\d,]*(?:\.\d+)?)\s*\+?\s*$/i.exec(s)
  if (r) return `${r[1].replace(/,/g, "")}–${r[2].replace(/,/g, "")}`
  const one = /^\s*~?\s*(\d[\d,]*(?:\.\d+)?)\s*\+?\s*$/.exec(s)
  if (one) return Number(one[1].replace(/,/g, ""))
  return { error: `"${s}" isn't a number or a range like 11–50.` }
}

/**
 * "Tony Costello - Founder CEO" → name "Tony Costello", title "Founder CEO". Also "Andreas Wolf (CEO)",
 * "Jeff Pedersen, Founder". A plain name is returned as it is.
 */
export function splitNameTitle(raw: string): { name: string; title: string } {
  const s = raw.replace(/\s+/g, " ").trim()
  const paren = /^(.+?)\s*\(([^)]+)\)\s*\)?\s*$/.exec(s)
  if (paren) return { name: paren[1].trim(), title: paren[2].trim() }
  const dash = /^(.+?)\s+[-–—|]\s+(.+)$/.exec(s)
  if (dash) return { name: dash[1].trim(), title: dash[2].trim() }
  const TITLE = "(?:co-?founder|founder|ceo|cfo|coo|cto|cmo|chief|director|head|vp|president|owner|managing|general manager|chairman|partner)"
  const trailing = new RegExp(`^(\\S+(?:\\s+\\S+)+?)\\s+(${TITLE}\\b.*)$`, "i").exec(s)
  if (trailing && !new RegExp(`\\b${TITLE}\\b`, "i").test(trailing[1])) return { name: trailing[1].trim(), title: trailing[2].trim() }
  const comma = /^([^,]+),\s*(.+)$/.exec(s)
  if (comma && /\b(ceo|cfo|coo|cto|cmo|founder|director|manager|head|vp|president|owner|partner|chief|lead|officer)\b/i.test(comma[2])) return { name: comma[1].trim(), title: comma[2].trim() }
  return { name: s, title: "" }
}

/**
 * A choice cell against the field's choices: exact (any case), then a choice the cell starts with ("Low risk" →
 * "Low"), then one that starts with the cell ("Grey" → "Grey market only"), only when exactly one matches.
 */
export function matchChoice(options: string[], raw: unknown): string | null {
  const s = text(raw).toLowerCase().replace(/\s+/g, " ")
  if (!s) return null
  const exact = options.find((o) => o.toLowerCase() === s)
  if (exact) return exact
  const starts = options.filter((o) => s.startsWith(`${o.toLowerCase()} `) || s.startsWith(`${o.toLowerCase()}-`) || s.startsWith(`${o.toLowerCase()} -`))
  if (starts.length === 1) return starts[0]
  const prefix = options.filter((o) => o.toLowerCase().startsWith(s))
  if (prefix.length === 1) return prefix[0]
  return null
}

/** Splits a list of places written by hand: "PH, UAE and India", "Kuwait\nSaudi Arabia", "SG / MY". */
export function splitPlaces(raw: unknown): string[] {
  return text(raw)
    .split(/[,;/|\n]+|\s+and\s+|\s*&\s*/i)
    .map((p) => p.replace(/[:.].*$/, "").trim())
    .filter(Boolean)
}
