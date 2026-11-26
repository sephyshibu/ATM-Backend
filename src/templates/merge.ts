// Merge fields: the {{placeholders}} in email templates, filled per brand when a template is previewed (and, later,
// when contacts are sent to lemlist). Values come from the brand, its contact, its owner at ATM and its VERIFIED
// knowledge base only: an unverified fact is never put in an email.
//
// Syntax:
//   {{firstName}}            the value; when it's empty the email shows ⟦First name⟧ and a warning is raised
//   {{firstName|there}}      the value, or "there" when it's empty (no warning)
//   {{touchOne}}             the brand's verified touch-one observation, or the template's back-up opening line

export type MergeField = { key: string; label: string; group: "Contact" | "Brand" | "Knowledge base" | "ATM"; example: string; help: string }

export const MERGE_FIELDS: MergeField[] = [
  { key: "firstName", label: "First name", group: "Contact", example: "Tony", help: "The brand's contact: the main contact, else the signer, else the first person linked." },
  { key: "lastName", label: "Last name", group: "Contact", example: "Costello", help: "" },
  { key: "fullName", label: "Full name", group: "Contact", example: "Tony Costello", help: "" },
  { key: "jobTitle", label: "Job title", group: "Contact", example: "Co-Founder and CEO", help: "" },
  { key: "brandName", label: "Brand name", group: "Brand", example: "Rule 1 Proteins", help: "" },
  { key: "organisationName", label: "Company name", group: "Brand", example: "Rule One Proteins, LLC", help: "The organisation's legal entity, else its name." },
  { key: "category", label: "Category", group: "Brand", example: "Health supplements", help: "" },
  { key: "subCategory", label: "Sub-category", group: "Brand", example: "Sports nutrition", help: "" },
  { key: "lane", label: "Lane", group: "Brand", example: "Expansion", help: "Entry, Expansion or Re-entry." },
  { key: "homeCountry", label: "Home country", group: "Brand", example: "United States", help: "" },
  { key: "asianMarkets", label: "Asian markets live", group: "Brand", example: "Malaysia, Thailand and India", help: "" },
  { key: "homeRevenue", label: "Home revenue", group: "Brand", example: "USD 5M–7M", help: "" },
  { key: "revenueYear", label: "Revenue year", group: "Brand", example: "2025", help: "" },
  { key: "touchOne", label: "Touch-one observation", group: "Knowledge base", example: "Nutrition Depot in Thailand carries 34 of your lines and not one pre-workout…", help: "Only when verified. Without it, the template's back-up opening line is used." },
  { key: "senderFirstName", label: "Sender first name", group: "ATM", example: "Sephy", help: "The brand's owner at ATM." },
  { key: "senderName", label: "Sender full name", group: "ATM", example: "Sephy Mathew", help: "The brand's owner at ATM." },
  { key: "bookingLink", label: "Booking link", group: "ATM", example: "https://…", help: "Configuration → Booking emails → Booking page link." },
]

const KEYS = new Set(MERGE_FIELDS.map((f) => f.key))
const LABEL = new Map(MERGE_FIELDS.map((f) => [f.key, f.label]))
const PLACEHOLDER = /\{\{\s*([A-Za-z]+)\s*(?:\|([^}]*))?\}\}/g

/** Placeholders that aren't merge fields ({{fristName}}), and broken braces. */
export function checkText(text: string): string[] {
  const problems: string[] = []
  for (const m of text.matchAll(PLACEHOLDER)) if (!KEYS.has(m[1])) problems.push(`{{${m[1]}}} isn't a merge field.`)
  const stripped = text.replace(PLACEHOLDER, "")
  if (/\{\{|\}\}/.test(stripped)) problems.push("A merge field isn't closed: write it like {{firstName}}.")
  return problems
}

export type MergeValues = Record<string, string | null>

/**
 * Fills a text. Missing values: the |fallback when given; for {{touchOne}} the back-up opening line; otherwise a
 * visible ⟦Label⟧ marker, listed in `missing`.
 */
export type Filled = { text: string; missing: string[]; used: string[]; usedFallbackOpening: boolean }

export function fill(text: string, values: MergeValues, openingFallback: string): Filled {
  const missing = new Set<string>()
  const used = new Set<string>()
  let usedFallbackOpening = false
  const out: string = text.replace(PLACEHOLDER, (whole: string, key: string, fallback?: string): string => {
    if (!KEYS.has(key)) return whole
    used.add(key)
    const v = values[key]
    if (v && v.trim()) return v
    if (fallback !== undefined) return fallback.trim()
    if (key === "touchOne" && openingFallback.trim()) {
      usedFallbackOpening = true
      return fill(openingFallback, values, "").text
    }
    missing.add(key)
    return `⟦${LABEL.get(key) ?? key}⟧`
  })
  return { text: out, missing: [...missing].map((k) => LABEL.get(k) ?? k), used: [...used], usedFallbackOpening }
}

/** "A, B and C". */
export const joinAnd = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`)
