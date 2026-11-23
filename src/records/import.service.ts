import { Injectable } from "@nestjs/common"
import type { CustomField, Prisma } from "@prisma/client"

import { AuditService } from "../audit/audit.service"
import { COUNTRY_CODES } from "../common/countries"
import { badRequest, notFound } from "../common/errors"
import type { RequestUser } from "../common/request-user"
import { JourneyService } from "../leads/journey.service"
import { PrismaService } from "../prisma/prisma.service"
import { coerceValue, type CustomValues, parseNumber, splitList } from "./custom-fields.service"
import { normaliseDomain, normaliseUrl } from "./records-common"
import type { ImportDto, ImportRow, SaveMappingDto } from "./records.dto"
import { TagsService } from "./tags.service"

// Excel and CSV imports of brands (with their organisations) and of a brand's products.
//
// The screen reads the file, lets the person map each column to a field, and sends the rows as { row, values } by
// field key. Here every row is checked and either accepted or rejected with the exact reasons; nothing is written
// on a check. On import, the rows are checked again inside one transaction, the good rows are created, and the
// batch (mapping, counts and every rejected row with its reasons) is kept in import_batch.

export type ImportKind = "brands" | "products"

export type ImportTarget = {
  key: string
  label: string
  required: boolean
  /** What to put in the column. */
  hint: string
  /** Column headings that map to this field automatically. */
  aliases: string[]
  group: string
}

export type RowResult = { row: number; ok: boolean; action?: "new" | "update"; reasons: string[]; warnings: string[]; summary: string }

const SECTION = "Imports"
const MAX_ROWS = 5000

const BRAND_TARGETS: ImportTarget[] = [
  { key: "organisation", label: "Organisation name", required: true, hint: "The legal entity ATM signs with. Brands with the same organisation name go under one organisation.", aliases: ["organisation", "organization", "organisation name", "organization name", "company", "company name", "parent company"], group: "Organisation" },
  { key: "organisationLegalEntity", label: "Organisation legal entity", required: false, hint: "Registered name, e.g. Glow Cosmetics Pvt Ltd. Used only when the organisation is new.", aliases: ["legal entity", "legal name", "registered name", "organisation legal entity"], group: "Organisation" },
  { key: "organisationWebsite", label: "Organisation website", required: false, hint: "Used only when the organisation is new.", aliases: ["organisation website", "organization website", "company website", "group website"], group: "Organisation" },
  { key: "organisationHq", label: "Organisation head office country", required: false, hint: "Country name or 2-letter code. Used only when the organisation is new.", aliases: ["head office", "hq", "hq country", "head office country", "organisation country"], group: "Organisation" },
  { key: "name", label: "Brand name", required: true, hint: "", aliases: ["brand", "brand name", "name"], group: "Brand" },
  { key: "website", label: "Brand website", required: true, hint: "Used to catch duplicates, e.g. glowco.com.", aliases: ["website", "brand website", "domain", "url", "web"], group: "Brand" },
  { key: "category", label: "Category", required: true, hint: "A category from Settings → Lists. Can be left empty when the sub-category says it.", aliases: ["category", "brand category"], group: "Brand" },
  { key: "subCategory", label: "Sub-category", required: true, hint: "A sub-category of the category.", aliases: ["sub category", "sub-category", "subcategory", "sub cat"], group: "Brand" },
  { key: "lane", label: "Lane", required: false, hint: "Entry, Expansion or Re-entry.", aliases: ["lane", "routing", "route"], group: "Brand" },
  { key: "tier", label: "Tier", required: false, hint: "", aliases: ["tier", "brand tier"], group: "Brand" },
  { key: "homeCountry", label: "Home country", required: false, hint: "Country name or 2-letter code.", aliases: ["home country", "origin country", "country of origin", "country", "home market"], group: "Brand" },
  { key: "homeRevenueUsd", label: "Home revenue (USD)", required: false, hint: "Whole dollars; 12.5M and 12,500,000 both work.", aliases: ["home revenue", "revenue", "revenue usd", "home revenue usd", "annual revenue"], group: "Brand" },
  { key: "revenueYear", label: "Revenue year", required: false, hint: "e.g. 2025", aliases: ["revenue year", "year"], group: "Brand" },
  { key: "asianMarketsLive", label: "Asian markets live", required: false, hint: "Countries separated by commas.", aliases: ["asian markets", "asian markets live", "markets live", "asia markets", "asia presence"], group: "Brand" },
  { key: "owner", label: "Owner at ATM (email)", required: false, hint: "The email of an active ATM user.", aliases: ["owner", "owner email", "analyst", "atm owner"], group: "Brand" },
  { key: "linkedin", label: "LinkedIn page", required: false, hint: "", aliases: ["linkedin", "linkedin url", "linkedin page"], group: "Brand" },
  { key: "description", label: "About the brand", required: false, hint: "", aliases: ["description", "about", "notes", "about the brand"], group: "Brand" },
  { key: "tags", label: "Tags", required: false, hint: "Separated by commas. New tags are added to the Tags list.", aliases: ["tags", "tag", "labels"], group: "Brand" },
]

/** The contact columns of a brand row: the main contact, and a second one (e.g. the signer). */
function contactTargets(prefix: "c1" | "c2"): ImportTarget[] {
  const main = prefix === "c1"
  const group = main ? "Main contact" : "Second contact"
  const al = (...names: string[]) => (main ? names.flatMap((n) => [n, `contact ${n}`, `contact 1 ${n}`, `main contact ${n}`]) : names.flatMap((n) => [`contact 2 ${n}`, `second contact ${n}`, `secondary contact ${n}`]))
  return [
    { key: `${prefix}.name`, label: "Full name", required: false, hint: "Split into first and last name. Or map First name and Last name instead.", aliases: [...al("name", "full name"), ...(main ? ["contact", "contact person"] : ["contact 2", "second contact"])], group },
    { key: `${prefix}.firstName`, label: "First name", required: false, hint: "", aliases: al("first name"), group },
    { key: `${prefix}.lastName`, label: "Last name", required: false, hint: "", aliases: al("last name", "surname"), group },
    { key: `${prefix}.jobTitle`, label: "Job title", required: false, hint: "", aliases: al("job title", "title", "designation", "position"), group },
    { key: `${prefix}.email`, label: "Work email", required: false, hint: "An email already in Records under this organisation links that person; under another organisation the row is rejected.", aliases: al("email", "email address", "work email"), group },
    { key: `${prefix}.emailVerified`, label: "Email verified", required: false, hint: "Yes or No.", aliases: al("email verified", "verified"), group },
    { key: `${prefix}.phone`, label: "Phone", required: false, hint: "", aliases: al("phone", "mobile", "phone number"), group },
    { key: `${prefix}.linkedin`, label: "LinkedIn profile", required: false, hint: "", aliases: al("linkedin profile", "linkedin"), group },
    { key: `${prefix}.country`, label: "Country", required: false, hint: "", aliases: al("country", "location"), group },
    { key: `${prefix}.buyingRole`, label: "Buying role", required: false, hint: "From Lists → Buying roles, e.g. Signer.", aliases: al("buying role", "role"), group },
    { key: `${prefix}.consent`, label: "Consent to contact", required: false, hint: "From Lists → Consent to contact.", aliases: al("consent"), group },
  ]
}

const PRODUCT_TARGETS: ImportTarget[] = [
  { key: "name", label: "Product name", required: true, hint: "", aliases: ["product", "product name", "name", "item", "item name"], group: "Product" },
  { key: "sku", label: "SKU", required: false, hint: "The brand's product code. Must be unique within the brand.", aliases: ["sku", "sku number", "sku no", "product code", "code", "item code"], group: "Product" },
  { key: "category", label: "Category", required: false, hint: "Leave empty to use the brand's.", aliases: ["category", "product category"], group: "Product" },
  { key: "subCategory", label: "Sub-category", required: false, hint: "A sub-category of the category.", aliases: ["sub category", "sub-category", "subcategory"], group: "Product" },
  { key: "description", label: "Description", required: false, hint: "", aliases: ["description", "about", "details"], group: "Product" },
  { key: "tags", label: "Tags", required: false, hint: "Separated by commas. New tags are added to the Tags list.", aliases: ["tags", "tag", "labels"], group: "Product" },
]

const regionNames = new Intl.DisplayNames(["en"], { type: "region" })
const COUNTRY_ALIASES: Record<string, string> = { uk: "GB", england: "GB", "great britain": "GB", usa: "US", "u.s.": "US", "u.s.a.": "US", america: "US", uae: "AE", korea: "KR", "south korea": "KR", vietnam: "VN", "viet nam": "VN", russia: "RU", taiwan: "TW", "hong kong": "HK", macau: "MO", "czech republic": "CZ", holland: "NL" }
const COUNTRY_BY_NAME = new Map<string, string>([...COUNTRY_CODES].map((c) => [(regionNames.of(c) ?? c).toLowerCase(), c]))

/** "Singapore", "SG" or "sg" → "SG". */
function parseCountry(raw: string): string | undefined {
  const s = raw.trim()
  if (/^[a-z]{2}$/i.test(s) && COUNTRY_CODES.has(s.toUpperCase())) return s.toUpperCase()
  const l = s.toLowerCase()
  return COUNTRY_ALIASES[l] ?? COUNTRY_BY_NAME.get(l)
}

/** "USD 12.5M", "$12,500,000", "12500000" → 12500000. */
function parseUsd(raw: unknown): number | null | undefined {
  if (raw === null || raw === undefined || raw === "") return null
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? Math.round(raw) : undefined
  const s = String(raw).trim().toLowerCase().replace(/usd|us\$|\$/g, "").replace(/[,\s]/g, "")
  const m = /^(\d+(?:\.\d+)?)(k|m|mn|b|bn)?$/.exec(s)
  if (!m) return undefined
  const mult = { k: 1e3, m: 1e6, mn: 1e6, b: 1e9, bn: 1e9 }[m[2] as "k"] ?? 1
  return Math.round(Number(m[1]) * mult)
}

const text = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim())
const lower = (s: string) => s.trim().toLowerCase()

type ListRef = { code: string; label: string; parentCode: string | null; retired: boolean }

/** Everything the checks look up, loaded once per check. */
type Ref = {
  lists: Record<"category" | "sub_category" | "routing" | "tier" | "tag" | "buying_role" | "consent_basis", ListRef[]>
  fields: CustomField[]
  orgFields: CustomField[]
  users: { id: string; email: string; name: string }[]
  orgs: { id: string; name: string; domain: string | null; excluded: boolean; archived: boolean }[]
  brands: Map<string, ExistingBrand>
  people: Map<string, { id: string; name: string; organisationId: string; organisationName: string }>
}

type ExistingBrand = Prisma.BrandGetPayload<{ include: { organisation: { select: { id: true; name: true; excluded: true } }; people: { where: { removedAt: null }; select: { personId: true; isPrimary: true } }; leads: { select: { id: true } } } }>

type ContactPlan = {
  primary: boolean
  existingId: string | null
  data: { firstName: string; lastName: string; jobTitle: string; email: string | null; emailStatus: string; phone: string | null; linkedinUrl: string | null; country: string | null; buyingRoleCode: string | null; consentCode: string | null }
}

type BrandFieldsPlan = {
  name: string
  categoryCode: string | null
  subCategoryCode: string | null
  routingCode: string | null
  tierCode: string | null
  homeCountry: string | null
  homeRevenueUsd: number | null
  revenueYear: number | null
  asianMarketsLive: string[]
  ownerId: string | null
  linkedinUrl: string | null
  description: string
  custom: CustomValues
}

type CategoryPick = { categoryCode: string | null; subCategoryCode: string | null }

type BrandPlan = {
  row: number
  /** new: create the brand; update: fill an existing brand from the row. */
  action: "new" | "update"
  existing: ExistingBrand | null
  domain: string
  org: { id: string } | { newName: string; legalEntity: string | null; domain: string | null; hqCountry: string | null; custom: CustomValues }
  data: BrandFieldsPlan
  tags: string[]
  contacts: ContactPlan[]
}

export type ImportMode = "skip" | "update"

type ProductPlan = { row: number; data: { name: string; sku: string | null; categoryCode: string | null; subCategoryCode: string | null; description: string; custom: CustomValues }; tags: string[] }

@Injectable()
export class ImportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tags: TagsService,
    private readonly journey: JourneyService,
  ) {}

  /** The fields a file's columns can be mapped to: the built-in ones, then the custom fields from Settings → Fields. */
  async targets(kind: ImportKind): Promise<ImportTarget[]> {
    const fields = await this.prisma.customField.findMany({ where: { entityType: kind === "brands" ? "brand" : "product", retiredAt: null }, orderBy: [{ sortOrder: "asc" }, { label: "asc" }] })
    const orgFields = kind === "brands" ? await this.prisma.customField.findMany({ where: { entityType: "organisation", retiredAt: null }, orderBy: [{ sortOrder: "asc" }, { label: "asc" }] }) : []
    const base = kind === "brands" ? BRAND_TARGETS : PRODUCT_TARGETS
    const hintFor = (f: CustomField) =>
      [f.help, f.type === "choice" || f.type === "multi_choice" ? `Choices: ${f.options.join(", ")}` : "", f.type === "date" ? "2026-03-31 or 31/03/2026" : "", f.type === "yes_no" ? "Yes or No" : ""].filter(Boolean).join(" · ")
    const orgTargets = orgFields.map((f) => ({
      key: `org.custom.${f.key}`,
      label: `Organisation: ${f.label}`,
      required: false,
      hint: [f.required ? "Needed when the organisation is new." : "Used only when the organisation is new.", hintFor(f)].filter(Boolean).join(" "),
      aliases: [`organisation ${f.label.toLowerCase()}`, `organization ${f.label.toLowerCase()}`],
      group: "Organisation",
    }))
    const own = fields.map((f) => ({ key: `custom.${f.key}`, label: f.label, required: f.required, hint: hintFor(f), aliases: [f.label.toLowerCase(), f.key.replace(/_/g, " ")], group: kind === "brands" ? "Brand: your fields" : "Product: your fields" }))
    const orgBase = base.filter((t) => t.group === "Organisation")
    const contacts = kind === "brands" ? [...contactTargets("c1"), ...contactTargets("c2")] : []
    return [...orgBase, ...orgTargets, ...base.filter((t) => t.group !== "Organisation"), ...own, ...contacts]
  }

  // ---------------------------------------------------------------- Shared lookups

  private async load(db: Prisma.TransactionClient, entity: "brand" | "product"): Promise<Ref> {
    const brandEntity = entity === "brand"
    const [values, fields, orgFields, users, orgs, brands, people] = await Promise.all([
      db.listValue.findMany({ where: { listKey: { in: ["category", "sub_category", "routing", "tier", "tag", "buying_role", "consent_basis"] } }, include: { parent: { select: { code: true } } } }),
      db.customField.findMany({ where: { entityType: entity } }),
      brandEntity ? db.customField.findMany({ where: { entityType: "organisation" } }) : Promise.resolve([]),
      db.user.findMany({ where: { status: { not: "deactivated" } }, select: { id: true, email: true, name: true } }),
      brandEntity ? db.organisation.findMany({ select: { id: true, name: true, domain: true, excluded: true, archivedAt: true } }) : Promise.resolve([]),
      brandEntity
        ? db.brand.findMany({ include: { organisation: { select: { id: true, name: true, excluded: true } }, people: { where: { removedAt: null }, select: { personId: true, isPrimary: true } }, leads: { select: { id: true } } } })
        : Promise.resolve([] as ExistingBrand[]),
      brandEntity ? db.person.findMany({ where: { archivedAt: null, email: { not: null } }, select: { id: true, email: true, firstName: true, lastName: true, organisationId: true, organisation: { select: { name: true } } } }) : Promise.resolve([]),
    ])
    const list = (k: string) => values.filter((v) => v.listKey === k).map((v) => ({ code: v.code, label: v.label, parentCode: v.parent?.code ?? null, retired: !!v.retiredAt }))
    return {
      lists: { category: list("category"), sub_category: list("sub_category"), routing: list("routing"), tier: list("tier"), tag: list("tag"), buying_role: list("buying_role"), consent_basis: list("consent_basis") },
      fields,
      orgFields,
      users,
      orgs: orgs.map((o) => ({ id: o.id, name: o.name, domain: o.domain, excluded: o.excluded, archived: !!o.archivedAt })),
      brands: new Map(brands.map((b) => [b.domain, b])),
      people: new Map(people.map((p) => [p.email!, { id: p.id, name: `${p.firstName} ${p.lastName}`.trim(), organisationId: p.organisationId, organisationName: p.organisation.name }])),
    }
  }

  /** A list value by its name or code; the exact reason if it isn't one. */
  private pickList(ref: Ref, key: "category" | "sub_category" | "routing" | "tier" | "buying_role" | "consent_basis", raw: string, label: string, listName: string, reasons: string[], parentCode?: string | null) {
    if (!raw) return null
    const pool = ref.lists[key].filter((v) => parentCode === undefined || v.parentCode === parentCode)
    const hit = pool.find((v) => lower(v.label) === lower(raw) || lower(v.code) === lower(raw))
    if (hit && !hit.retired) return hit.code
    const choices = pool.filter((v) => !v.retired).map((v) => v.label)
    if (hit) reasons.push(`${label} "${raw}" is retired in Settings → Lists → ${listName}.`)
    else reasons.push(`${label} "${raw}" isn't in Settings → Lists → ${listName}.${choices.length ? ` Use one of: ${choices.slice(0, 15).join(", ")}${choices.length > 15 ? "…" : ""}.` : ""}`)
    return null
  }

  /** Category and sub-category: the sub-category must sit under the category; a lone sub-category names its category. */
  private pickCategory(ref: Ref, rawCat: string, rawSub: string, reasons: string[]): CategoryPick {
    let categoryCode: string | null = null
    if (rawCat) categoryCode = this.pickList(ref, "category", rawCat, "Category", "Categories", reasons)
    else if (rawSub) {
      const subs = ref.lists.sub_category.filter((v) => !v.retired && (lower(v.label) === lower(rawSub) || lower(v.code) === lower(rawSub)))
      if (subs.length === 1) categoryCode = subs[0].parentCode
      else if (subs.length > 1) reasons.push(`Sub-category "${rawSub}" exists under more than one category. Fill in the category too.`)
    }
    if (rawCat && !categoryCode) return { categoryCode: null, subCategoryCode: null }
    let subCategoryCode: string | null = null
    if (rawSub && categoryCode) {
      const catLabel = ref.lists.category.find((c) => c.code === categoryCode)?.label ?? categoryCode
      const before = reasons.length
      subCategoryCode = this.pickList(ref, "sub_category", rawSub, "Sub-category", `Sub-categories under ${catLabel}`, reasons, categoryCode)
      if (!subCategoryCode && reasons.length > before) reasons[reasons.length - 1] = reasons[reasons.length - 1].replace(`isn't in Settings → Lists → Sub-categories under ${catLabel}.`, `isn't a sub-category of ${catLabel}.`)
    } else if (rawSub && !rawCat && !categoryCode && !reasons.length) reasons.push(`Sub-category "${rawSub}" isn't in Settings → Lists → Sub-categories.`)
    return { categoryCode, subCategoryCode }
  }

  private pickTags(ref: Ref, raw: unknown, reasons: string[], warnings: string[]) {
    const names = splitList(raw)
    const fresh: string[] = []
    for (const n of names) {
      const hit = ref.lists.tag.find((t) => lower(t.label) === lower(n) || lower(t.code) === lower(n))
      if (hit?.retired) reasons.push(`Tag "${n}" is retired in Settings → Lists → Tags.`)
      else if (!hit) fresh.push(n)
    }
    if (fresh.length) warnings.push(`New tag${fresh.length === 1 ? "" : "s"} ${fresh.map((f) => `"${f}"`).join(", ")} will be added to the Tags list.`)
    return names
  }

  private pickCustom(ref: Ref, values: Record<string, unknown>, reasons: string[]) {
    const out: CustomValues = {}
    for (const f of ref.fields) {
      if (f.retiredAt) continue
      const r = coerceValue(f, values[`custom.${f.key}`])
      if ("error" in r) reasons.push(r.error)
      else if (r.value !== null) out[f.key] = r.value
      else if (f.required) reasons.push(`${f.label} is required.`)
    }
    return out
  }

  private checkRows(rows: ImportRow[]) {
    if (!Array.isArray(rows) || !rows.length) throw badRequest("The file has no rows to import.")
    if (rows.length > MAX_ROWS) throw badRequest(`One import can have up to ${MAX_ROWS.toLocaleString("en-US")} rows. Split the file and import it in parts.`)
    for (const r of rows) if (typeof r?.row !== "number" || !r.values || typeof r.values !== "object") throw badRequest("Each row needs its row number and values.")
  }

  // ---------------------------------------------------------------- Brands

  /** A contact's columns (c1 or c2) as a person to add or link, or the reasons it can't be. Empty columns: null. */
  private pickContact(ref: Ref, v: Record<string, unknown>, prefix: "c1" | "c2", orgId: string | null, orgKey: string, seenEmails: Map<string, { row: number; orgKey: string }>, row: number, reasons: string[], warnings: string[]): ContactPlan | null {
    const who = prefix === "c1" ? "Main contact" : "Second contact"
    const get = (k: string) => text(v[`${prefix}.${k}`])
    const keys = ["name", "firstName", "lastName", "jobTitle", "email", "emailVerified", "phone", "linkedin", "country", "buyingRole", "consent"]
    if (!keys.some((k) => get(k))) return null
    const before = reasons.length
    let firstName = get("firstName")
    let lastName = get("lastName")
    if (!firstName && get("name")) {
      const parts = get("name").split(/\s+/)
      firstName = parts.length > 1 ? parts.slice(0, -1).join(" ") : parts[0]
      lastName = lastName || (parts.length > 1 ? parts[parts.length - 1] : "")
    }
    if (!firstName) reasons.push(`${who}: add a name (Full name or First name).`)
    let email: string | null = null
    if (get("email")) {
      email = get("email").toLowerCase()
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 254) {
        reasons.push(`${who}: "${get("email")}" isn't an email address.`)
        email = null
      }
    }
    let existingId: string | null = null
    if (email) {
      const seen = seenEmails.get(email)
      if (seen && seen.orgKey !== orgKey) reasons.push(`${who}: ${email} is also on row ${seen.row} under a different organisation.`)
      else if (!seen) seenEmails.set(email, { row, orgKey })
      const known = ref.people.get(email)
      if (known) {
        if (orgId && known.organisationId === orgId) {
          existingId = known.id
          warnings.push(`${who}: ${known.name} (${email}) is already in Records and will be linked to this brand.`)
        } else reasons.push(`${who}: ${email} already belongs to ${known.name} at ${known.organisationName}.`)
      }
    }
    const verified = get("emailVerified").toLowerCase()
    if (verified && !["yes", "y", "true", "1", "no", "n", "false", "0"].includes(verified)) reasons.push(`${who}: Email verified "${get("emailVerified")}" should be Yes or No.`)
    let linkedinUrl: string | null = null
    try {
      linkedinUrl = normaliseUrl(get("linkedin") || null, `${who} LinkedIn`)
    } catch (e) {
      reasons.push(e instanceof Error ? e.message : `${who}: LinkedIn isn't a web address.`)
    }
    let country: string | null = null
    if (get("country")) {
      country = parseCountry(get("country")) ?? null
      if (!country) reasons.push(`${who}: country "${get("country")}" isn't a country.`)
    }
    const buyingRoleCode = this.pickList(ref, "buying_role", get("buyingRole"), `${who} buying role`, "Buying roles", reasons)
    const consentCode = this.pickList(ref, "consent_basis", get("consent"), `${who} consent`, "Consent to contact", reasons)
    if (reasons.length > before) return null
    return {
      primary: prefix === "c1",
      existingId,
      data: {
        firstName,
        lastName,
        jobTitle: get("jobTitle"),
        email,
        emailStatus: ["yes", "y", "true", "1"].includes(verified) ? "verified" : "unknown",
        phone: get("phone") || null,
        linkedinUrl,
        country,
        buyingRoleCode,
        consentCode,
      },
    }
  }

  /**
   * Checks every brand row. A brand already in Records (same website) is rejected in "skip" mode, and in "update"
   * mode is filled from the row's non-empty cells (nothing is ever emptied). Brands with the same organisation
   * name go under one organisation; a new name makes one new organisation.
   */
  private planBrands(ref: Ref, rows: ImportRow[], mode: ImportMode) {
    const results: RowResult[] = []
    const plans: BrandPlan[] = []
    const seenDomains = new Map<string, number>()
    const seenEmails = new Map<string, { row: number; orgKey: string }>()
    const newOrgs = new Map<string, number>()
    for (const { row, values: v } of rows) {
      const reasons: string[] = []
      const warnings: string[] = []
      const orgName = text(v.organisation)
      const name = text(v.name)

      // The website decides whether the brand is new or already in Records.
      let domain: string | null = null
      if (!text(v.website)) reasons.push("Brand website is empty. It's how duplicates are caught.")
      else {
        try {
          domain = normaliseDomain(text(v.website), "Brand website")
        } catch (e) {
          reasons.push(e instanceof Error ? e.message : `Brand website "${text(v.website)}" isn't a website.`)
        }
      }
      let existing: ExistingBrand | null = null
      if (domain) {
        const first = seenDomains.get(domain)
        if (first !== undefined) reasons.push(`Same brand website as row ${first} in this file.`)
        else seenDomains.set(domain, row)
        const found = ref.brands.get(domain)
        if (found?.archivedAt) reasons.push(`${found.name} (archived) already uses ${domain}. Restore it in Records first.`)
        else if (found && mode === "skip") reasons.push(`${found.name} is already in Records with ${domain}. Choose "Update brands already in Records" to update it from this file.`)
        else if (found) existing = found
      }
      const action: "new" | "update" = existing ? "update" : "new"

      if (action === "new") {
        if (!orgName) reasons.push("Organisation name is empty.")
        if (!name) reasons.push("Brand name is empty.")
      }

      const cat = this.pickCategory(ref, text(v.category), text(v.subCategory), reasons)
      if (action === "new") {
        if (!text(v.category) && !text(v.subCategory)) reasons.push("Category and sub-category are empty.")
        else if (cat.categoryCode && !cat.subCategoryCode && !text(v.subCategory)) reasons.push("Sub-category is empty.")
      } else if (text(v.category) && !text(v.subCategory) && cat.categoryCode && cat.categoryCode !== existing!.categoryCode) reasons.push("A new category needs its sub-category too.")
      const routingCode = this.pickList(ref, "routing", text(v.lane), "Lane", "Lanes", reasons)
      const tierCode = this.pickList(ref, "tier", text(v.tier), "Tier", "Brand tiers", reasons)

      const country = (raw: unknown, label: string) => {
        const s = text(raw)
        if (!s) return null
        const c = parseCountry(s)
        if (!c) reasons.push(`${label} "${s}" isn't a country. Use a country name or its 2-letter code (e.g. Singapore or SG).`)
        return c ?? null
      }
      const homeCountry = country(v.homeCountry, "Home country")
      const markets: string[] = []
      for (const m of splitList(v.asianMarketsLive)) {
        const c = parseCountry(m)
        if (!c) reasons.push(`Asian market "${m}" isn't a country.`)
        else if (!markets.includes(c)) markets.push(c)
      }
      const revenue = parseUsd(v.homeRevenueUsd)
      if (revenue === undefined) reasons.push(`Home revenue "${text(v.homeRevenueUsd)}" isn't an amount. Use whole dollars, e.g. 12500000 or 12.5M.`)
      const yearNum = parseNumber(v.revenueYear)
      const revenueYear = yearNum === null || yearNum === undefined ? null : yearNum
      if (yearNum === undefined || (revenueYear !== null && (!Number.isInteger(revenueYear) || revenueYear < 1990 || revenueYear > 2100))) reasons.push(`Revenue year "${text(v.revenueYear)}" isn't a year between 1990 and 2100.`)
      let ownerId: string | null = null
      if (text(v.owner)) {
        const u = ref.users.find((x) => lower(x.email) === lower(text(v.owner)) || lower(x.name) === lower(text(v.owner)))
        if (!u) reasons.push(`Owner "${text(v.owner)}" isn't an active ATM user. Use their sign-in email.`)
        else ownerId = u.id
      }
      let linkedinUrl: string | null = null
      try {
        linkedinUrl = normaliseUrl(text(v.linkedin) || null, "LinkedIn page")
      } catch (e) {
        reasons.push(e instanceof Error ? e.message : "LinkedIn page isn't a web address.")
      }

      // The organisation: the existing brand's; or an existing one with the same name; or one new one per name.
      let org: BrandPlan["org"] | null = null
      const hasOrgColumns = !!(text(v.organisationLegalEntity) || text(v.organisationWebsite) || text(v.organisationHq) || ref.orgFields.some((f) => text(v[`org.custom.${f.key}`])))
      if (existing) {
        org = { id: existing.organisationId }
        if (orgName && lower(orgName) !== lower(existing.organisation.name)) warnings.push(`${existing.name} stays under ${existing.organisation.name}; the organisation "${orgName}" in this row is not used.`)
        else if (hasOrgColumns) warnings.push(`${existing.organisation.name} is already in Records, so the organisation columns in this row are not used.`)
        if (existing.organisation.excluded) warnings.push(`Organisation ${existing.organisation.name} is excluded: don't approach this brand.`)
      } else if (orgName) {
        const same = ref.orgs.filter((o) => lower(o.name) === lower(orgName))
        const active = same.filter((o) => !o.archived)
        if (active.length > 1) reasons.push(`${active.length} organisations in Records are called ${orgName}. Rename one of them in Records, then import again.`)
        else if (active.length === 1) {
          org = { id: active[0].id }
          if (active[0].excluded) warnings.push(`Organisation ${active[0].name} is excluded: don't approach this brand.`)
          if (hasOrgColumns) warnings.push(`${active[0].name} is already in Records, so the organisation columns in this row are not used.`)
        } else if (same.length) reasons.push(`Organisation ${orgName} is archived. Restore it in Records first, or use another name.`)
        else {
          let orgDomain: string | null = null
          try {
            orgDomain = normaliseDomain(text(v.organisationWebsite) || null, "Organisation website")
          } catch (e) {
            reasons.push(e instanceof Error ? e.message : "Organisation website isn't a website.")
          }
          if (orgDomain) {
            const clash = ref.orgs.find((o) => o.domain === orgDomain && !o.archived)
            if (clash) reasons.push(`Organisation website ${orgDomain} belongs to ${clash.name}. Use that organisation name instead.`)
          }
          // The organisation's own fields: checked, and required ones needed, only when it is new.
          const orgCustom: CustomValues = {}
          for (const f of ref.orgFields) {
            if (f.retiredAt) continue
            const r = coerceValue(f, v[`org.custom.${f.key}`])
            if ("error" in r) reasons.push(`Organisation ${r.error}`)
            else if (r.value !== null) orgCustom[f.key] = r.value
            else if (f.required && !newOrgs.has(lower(orgName))) reasons.push(`Organisation ${f.label} is required for the new organisation ${orgName}.`)
          }
          org = { newName: orgName, legalEntity: text(v.organisationLegalEntity) || null, domain: orgDomain, hqCountry: country(v.organisationHq, "Organisation head office"), custom: orgCustom }
          if (!newOrgs.has(lower(orgName))) newOrgs.set(lower(orgName), row)
        }
      }

      const orgId = org && "id" in org ? org.id : null
      const orgKey = orgId ?? `new:${lower(orgName)}`
      const contacts = (["c1", "c2"] as const).map((p) => this.pickContact(ref, v, p, orgId, orgKey, seenEmails, row, reasons, warnings)).filter((c): c is ContactPlan => !!c)
      if (contacts.length === 2 && contacts[0].data.email && contacts[0].data.email === contacts[1].data.email) reasons.push("Main and second contact have the same email.")

      const tags = this.pickTags(ref, v.tags, reasons, warnings)
      // Custom fields: on a new brand every required one is needed; on an update only the cells filled in count.
      const custom = action === "new" ? this.pickCustom(ref, v, reasons) : this.pickCustomFilled(ref, v, reasons)

      const ok = reasons.length === 0
      let summary = ""
      if (ok && existing) {
        const changed = this.brandChanges(ref, existing, { name, categoryCode: cat.categoryCode, subCategoryCode: cat.subCategoryCode, routingCode, tierCode, homeCountry, homeRevenueUsd: revenue ?? null, revenueYear, asianMarketsLive: markets, ownerId, linkedinUrl, description: text(v.description), custom })
        const added = contacts.filter((c) => !c.existingId || !existing!.people.some((p) => p.personId === c.existingId)).length
        summary = `Update ${existing.name}: ${changed.length ? changed.map((c) => c.label).join(", ") : "no field changes"}${added ? `; ${added} contact${added === 1 ? "" : "s"}` : ""}${tags.length ? "; tags" : ""}`
      } else if (ok) summary = `${name} under ${org && "id" in org ? orgName : `new organisation ${orgName}`}${contacts.length ? ` · ${contacts.length} contact${contacts.length === 1 ? "" : "s"}` : ""}`
      results.push({ row, ok, action: ok ? action : undefined, reasons, warnings, summary })
      if (ok && org && domain)
        plans.push({
          row,
          action,
          existing,
          domain,
          org,
          tags,
          contacts,
          data: { name, categoryCode: cat.categoryCode, subCategoryCode: cat.subCategoryCode, routingCode, tierCode, homeCountry, homeRevenueUsd: revenue ?? null, revenueYear, asianMarketsLive: markets, ownerId, linkedinUrl, description: text(v.description), custom },
        })
    }
    const counts = {
      new: plans.filter((p) => p.action === "new").length,
      updates: plans.filter((p) => p.action === "update").length,
      newOrganisations: new Set(plans.filter((p) => "newName" in p.org).map((p) => lower((p.org as { newName: string }).newName))).size,
      contacts: plans.reduce((n, p) => n + p.contacts.length, 0),
    }
    return { results, plans, counts }
  }

  /** Custom values from the cells that are filled in (for updates: an empty cell never clears a value). */
  private pickCustomFilled(ref: Ref, values: Record<string, unknown>, reasons: string[]) {
    const out: CustomValues = {}
    for (const f of ref.fields) {
      if (f.retiredAt || !text(values[`custom.${f.key}`])) continue
      const r = coerceValue(f, values[`custom.${f.key}`])
      if ("error" in r) reasons.push(r.error)
      else if (r.value !== null) out[f.key] = r.value
    }
    return out
  }

  /** What an update changes on an existing brand: only filled cells that differ. */
  private brandChanges(ref: Ref, b: ExistingBrand, d: BrandFieldsPlan) {
    const out: { label: string; field: string; before: string; after: string; value: unknown }[] = []
    const label = (key: "category" | "sub_category" | "routing" | "tier", code: string | null) => (code ? (ref.lists[key].find((v) => v.code === code)?.label ?? code) : "—")
    const add = (field: string, lbl: string, before: unknown, after: unknown, show: (x: unknown) => string = (x) => (x === null || x === undefined || x === "" ? "—" : String(x))) => {
      if (after === null || after === undefined || after === "" || (Array.isArray(after) && !after.length)) return
      if (JSON.stringify(before ?? null) === JSON.stringify(after)) return
      out.push({ label: lbl, field, before: show(before), after: show(after), value: after })
    }
    add("name", "Name", b.name, d.name)
    add("categoryCode", "Category", b.categoryCode, d.categoryCode, (x) => label("category", x as string | null))
    add("subCategoryCode", "Sub-category", b.subCategoryCode, d.subCategoryCode, (x) => label("sub_category", x as string | null))
    add("routingCode", "Lane", b.routingCode, d.routingCode, (x) => label("routing", x as string | null))
    add("tierCode", "Tier", b.tierCode, d.tierCode, (x) => label("tier", x as string | null))
    add("homeCountry", "Home country", b.homeCountry, d.homeCountry)
    add("homeRevenueUsd", "Home revenue", b.homeRevenueUsd === null ? null : Number(b.homeRevenueUsd), d.homeRevenueUsd)
    add("revenueYear", "Revenue year", b.revenueYear, d.revenueYear)
    add("asianMarketsLive", "Asian markets live", b.asianMarketsLive, d.asianMarketsLive.length ? [...new Set([...b.asianMarketsLive, ...d.asianMarketsLive])] : [], (x) => (Array.isArray(x) && x.length ? x.join(", ") : "—"))
    add("ownerId", "Owner", b.ownerId, d.ownerId, (x) => ref.users.find((u) => u.id === x)?.name ?? "—")
    add("linkedinUrl", "LinkedIn", b.linkedinUrl, d.linkedinUrl)
    add("description", "About", b.description, d.description)
    const current = (b.custom ?? {}) as CustomValues
    for (const [k, val] of Object.entries(d.custom)) add(`custom.${k}`, ref.fields.find((f) => f.key === k)?.label ?? k, current[k] ?? null, val, (x) => (Array.isArray(x) ? x.join(", ") : x === null || x === undefined ? "—" : typeof x === "boolean" ? (x ? "Yes" : "No") : String(x)))
    return out
  }

  async checkBrands(dto: ImportDto) {
    this.checkRows(dto.rows)
    const ref = await this.load(this.prisma, "brand")
    const { results, counts } = this.planBrands(ref, dto.rows, dto.mode ?? "skip")
    return this.summary(results, { newBrands: counts.new, updates: counts.updates, newOrganisations: counts.newOrganisations, contacts: counts.contacts })
  }

  async importBrands(dto: ImportDto, me: RequestUser, ip: string | null) {
    this.checkRows(dto.rows)
    const mode = dto.mode ?? "skip"
    return this.prisma.$transaction(
      async (tx) => {
        const ref = await this.load(tx, "brand")
        const { results, plans } = this.planBrands(ref, dto.rows, mode)
        const batch = await tx.importBatch.create({ data: { kind: "brands", fileName: dto.fileName, mapping: { columns: dto.mapping ?? {}, mode } as Prisma.InputJsonValue, rowCount: dto.rows.length, createdCount: 0, rejectedCount: 0, createdById: me.id } })
        const orgIds = new Map<string, string>()
        let orgsMade = 0
        let leadsOpened = 0
        let peopleAdded = 0
        let created = 0
        let updated = 0
        for (const p of plans) {
          let organisationId: string
          if ("id" in p.org) organisationId = p.org.id
          else {
            const key = lower(p.org.newName)
            if (!orgIds.has(key)) {
              const o = await tx.organisation.create({ data: { name: p.org.newName, legalEntity: p.org.legalEntity, domain: p.org.domain, hqCountry: p.org.hqCountry, custom: p.org.custom as Prisma.InputJsonValue, createdById: me.id, updatedById: me.id } })
              await this.audit.record(
                { actor: me, section: "Records", action: `Added the organisation ${o.name} (import)`, entityType: "organisation", entityId: o.id, after: [`From ${dto.fileName}, row ${p.row}`, o.legalEntity && `Legal entity: ${o.legalEntity}`, o.domain && `Website: ${o.domain}`].filter(Boolean).join("\n"), ip },
                tx,
              )
              orgIds.set(key, o.id)
              orgsMade++
            }
            organisationId = orgIds.get(key)!
          }

          let brandId: string
          if (p.action === "new") {
            const { homeRevenueUsd, custom, ...rest } = p.data
            const b = await tx.brand.create({
              data: {
                ...rest,
                categoryCode: rest.categoryCode!,
                subCategoryCode: rest.subCategoryCode!,
                domain: p.domain,
                homeRevenueUsd: homeRevenueUsd === null ? null : BigInt(homeRevenueUsd),
                custom: custom as Prisma.InputJsonValue,
                organisationId,
                source: "import",
                importBatchId: batch.id,
                createdById: me.id,
                updatedById: me.id,
              },
            })
            brandId = b.id
            created++
            if (p.tags.length) await this.tags.set(tx, "brand", b.id, (await this.tags.ensure(tx, p.tags, me, ip)).map((t) => t.code), me)
            await this.audit.record({ actor: me, section: "Records", action: `Added the brand ${b.name} (import)`, entityType: "brand", entityId: b.id, after: `From ${dto.fileName}, row ${p.row}`, ip }, tx)
          } else {
            const b = p.existing!
            brandId = b.id
            const changes = this.brandChanges(ref, b, p.data)
            const data: Prisma.BrandUncheckedUpdateInput = { updatedById: me.id }
            const custom = { ...((b.custom ?? {}) as CustomValues) }
            for (const c of changes) {
              if (c.field.startsWith("custom.")) custom[c.field.slice(7)] = c.value as CustomValues[string]
              else if (c.field === "homeRevenueUsd") data.homeRevenueUsd = BigInt(c.value as number)
              else (data as Record<string, unknown>)[c.field] = c.value
            }
            if (changes.some((c) => c.field.startsWith("custom."))) data.custom = custom as Prisma.InputJsonValue
            // A new category without a sub-category clears the old one (the row check requires both in that case).
            if (data.categoryCode && !p.data.subCategoryCode) data.subCategoryCode = null
            let tagLine: { before: string; after: string } | null = null
            if (p.tags.length) {
              const current = await this.tags.forEntity("brand", b.id, tx)
              const wanted = (await this.tags.ensure(tx, p.tags, me, ip)).map((t) => t.code)
              tagLine = await this.tags.set(tx, "brand", b.id, [...new Set([...current.map((t) => t.code), ...wanted])], me)
            }
            if (changes.length) await tx.brand.update({ where: { id: b.id }, data })
            if (changes.length || tagLine)
              await this.audit.record(
                {
                  actor: me,
                  section: "Records",
                  action: `Updated the brand ${b.name} (import)`,
                  entityType: "brand",
                  entityId: b.id,
                  before: [...changes.map((c) => `${c.label}: ${c.before}`), tagLine && `Tags: ${tagLine.before}`].filter(Boolean).join("\n") || null,
                  after: [`From ${dto.fileName}, row ${p.row}`, ...changes.map((c) => `${c.label}: ${c.after}`), tagLine && `Tags: ${tagLine.after}`].filter(Boolean).join("\n"),
                  ip,
                },
                tx,
              )
            updated++
          }

          // Contacts: new people under the organisation, or existing ones linked; the main contact becomes primary
          // unless the brand already has one.
          const links = await tx.brandPerson.findMany({ where: { brandId, removedAt: null } })
          let hasPrimary = links.some((l) => l.isPrimary)
          for (const c of p.contacts) {
            let personId = c.existingId
            if (personId) {
              const again = await tx.person.findFirst({ where: { email: c.data.email!, archivedAt: null } })
              if (!again || again.organisationId !== organisationId) throw new Error(`Row ${p.row}: ${c.data.email} changed in Records during the import. Check the file again.`)
            } else {
              const dupe = c.data.email ? await tx.person.findFirst({ where: { email: c.data.email, archivedAt: null } }) : null
              if (dupe && dupe.organisationId !== organisationId) throw new Error(`Row ${p.row}: ${c.data.email} belongs to someone at another organisation.`)
              if (dupe) personId = dupe.id
              else {
                const person = await tx.person.create({ data: { ...c.data, organisationId, createdById: me.id, updatedById: me.id } })
                personId = person.id
                peopleAdded++
                await this.audit.record({ actor: me, section: "Records", action: `Added ${`${person.firstName} ${person.lastName}`.trim()} (import)`, entityType: "person", entityId: person.id, after: `From ${dto.fileName}, row ${p.row}`, ip }, tx)
              }
            }
            if (!links.some((l) => l.personId === personId)) {
              const primary = c.primary && !hasPrimary
              await tx.brandPerson.create({ data: { brandId, personId: personId!, isPrimary: primary, addedById: me.id } })
              links.push({ id: "", brandId, personId: personId!, isPrimary: primary, addedAt: new Date(), addedById: me.id, removedAt: null, removedById: null })
              if (primary) hasPrimary = true
            }
          }

          // Every imported brand starts its journey at Register: new brands, and existing ones that never had a lead
          // (not for excluded organisations).
          const excluded = ref.orgs.find((o) => o.id === organisationId)?.excluded ?? false
          const neverHadLead = p.action === "new" || !p.existing!.leads.length
          if (!excluded && neverHadLead) {
            await this.journey.openIn(tx, brandId, { importBatchId: batch.id }, me, ip)
            leadsOpened++
          }
        }
        return this.finish(tx, batch.id, results, me, ip, `Imported ${created} new and ${updated} updated brand${created + updated === 1 ? "" : "s"} from ${dto.fileName}`, { newBrands: created, updates: updated, newOrganisations: orgsMade, leadsOpened, contacts: peopleAdded })
      },
      { timeout: 300_000, maxWait: 20_000 },
    )
  }

  // ---------------------------------------------------------------- Products

  private async planProducts(db: Prisma.TransactionClient, ref: Ref, brandId: string, rows: ImportRow[]) {
    const existing = await db.product.findMany({ where: { brandId, archivedAt: null }, select: { name: true, sku: true } })
    const results: RowResult[] = []
    const plans: ProductPlan[] = []
    const seenNames = new Map<string, number>()
    const seenSkus = new Map<string, number>()
    for (const { row, values: v } of rows) {
      const reasons: string[] = []
      const warnings: string[] = []
      const name = text(v.name)
      const sku = text(v.sku) || null
      if (!name) reasons.push("Product name is empty.")
      else {
        if (name.length > 200) reasons.push("Product name is longer than 200 characters.")
        const same = existing.find((p) => lower(p.name) === lower(name))
        if (same) reasons.push(`This brand already has a product called ${same.name}.`)
        const first = seenNames.get(lower(name))
        if (first !== undefined) reasons.push(`Same product name as row ${first} in this file.`)
        else seenNames.set(lower(name), row)
      }
      if (sku) {
        const same = existing.find((p) => p.sku && lower(p.sku) === lower(sku))
        if (same) reasons.push(`SKU ${sku} is already used by ${same.name}.`)
        const first = seenSkus.get(lower(sku))
        if (first !== undefined) reasons.push(`Same SKU as row ${first} in this file.`)
        else seenSkus.set(lower(sku), row)
      }
      const cat = this.pickCategory(ref, text(v.category), text(v.subCategory), reasons)
      const tags = this.pickTags(ref, v.tags, reasons, warnings)
      const custom = this.pickCustom(ref, v, reasons)
      const ok = reasons.length === 0
      results.push({ row, ok, reasons, warnings, summary: ok ? `${name}${sku ? ` (${sku})` : ""}` : "" })
      if (ok) plans.push({ row, tags, data: { name, sku, categoryCode: cat.categoryCode, subCategoryCode: cat.subCategoryCode, description: text(v.description), custom } })
    }
    return { results, plans }
  }

  private async brandFor(db: Prisma.TransactionClient, brandId: string) {
    const b = await db.brand.findUnique({ where: { id: brandId } })
    if (!b) throw notFound("That brand")
    if (b.archivedAt) throw badRequest(`${b.name} is archived. Restore it before importing products.`)
    return b
  }

  async checkProducts(brandId: string, dto: ImportDto) {
    this.checkRows(dto.rows)
    await this.brandFor(this.prisma, brandId)
    const ref = await this.load(this.prisma, "product")
    const { results } = await this.planProducts(this.prisma, ref, brandId, dto.rows)
    return this.summary(results)
  }

  async importProducts(brandId: string, dto: ImportDto, me: RequestUser, ip: string | null) {
    this.checkRows(dto.rows)
    return this.prisma.$transaction(
      async (tx) => {
        const brand = await this.brandFor(tx, brandId)
        const ref = await this.load(tx, "product")
        const { results, plans } = await this.planProducts(tx, ref, brandId, dto.rows)
        const batch = await tx.importBatch.create({ data: { kind: "products", brandId, fileName: dto.fileName, mapping: (dto.mapping ?? {}) as Prisma.InputJsonValue, rowCount: dto.rows.length, createdCount: 0, rejectedCount: 0, createdById: me.id } })
        for (const p of plans) {
          const { custom, ...rest } = p.data
          const product = await tx.product.create({ data: { ...rest, custom: custom as Prisma.InputJsonValue, brandId, source: "import", importBatchId: batch.id, createdById: me.id, updatedById: me.id } })
          if (p.tags.length) await this.tags.set(tx, "product", product.id, (await this.tags.ensure(tx, p.tags, me, ip)).map((t) => t.code), me)
          await this.audit.record({ actor: me, section: "Records", action: `Added the product ${product.name} to ${brand.name} (import)`, entityType: "product", entityId: product.id, after: `From ${dto.fileName}, row ${p.row}`, ip }, tx)
        }
        return this.finish(tx, batch.id, results, me, ip, `Imported ${plans.length} product${plans.length === 1 ? "" : "s"} into ${brand.name} from ${dto.fileName}`)
      },
      { timeout: 300_000, maxWait: 20_000 },
    )
  }

  // ---------------------------------------------------------------- Results

  private summary(results: RowResult[], extra: Record<string, number> = {}) {
    const ok = results.filter((r) => r.ok).length
    return { total: results.length, ready: ok, rejected: results.length - ok, ...extra, rows: results }
  }

  private async finish(tx: Prisma.TransactionClient, batchId: string, results: RowResult[], me: RequestUser, ip: string | null, action: string, extra: Record<string, number> = {}) {
    const rejected = results.filter((r) => !r.ok).map((r) => ({ row: r.row, reasons: r.reasons }))
    const created = results.length - rejected.length
    await tx.importBatch.update({ where: { id: batchId }, data: { createdCount: created, rejectedCount: rejected.length, rejected: rejected as Prisma.InputJsonValue } })
    await this.audit.record(
      { actor: me, section: SECTION, action, entityType: "import_batch", entityId: batchId, after: `${results.length} rows: ${created} imported, ${rejected.length} rejected`, ip },
      tx,
    )
    return { batchId, ...this.summary(results, extra), imported: created }
  }

  // ---------------------------------------------------------------- Saved mappings

  async mappings(kind: ImportKind) {
    const rows = await this.prisma.importMapping.findMany({ where: { kind, retiredAt: null }, orderBy: { updatedAt: "desc" } })
    return rows
  }

  /** Saves a mapping under a name; the same name replaces it (the change is logged). */
  async saveMapping(kind: ImportKind, dto: SaveMappingDto, me: RequestUser, ip: string | null) {
    const targets = new Set((await this.targets(kind)).map((t) => t.key))
    const clean: Record<string, string> = {}
    for (const [heading, key] of Object.entries(dto.mapping ?? {})) {
      if (typeof key !== "string" || !targets.has(key)) continue
      clean[String(heading).slice(0, 200)] = key
    }
    if (!Object.keys(clean).length) throw badRequest("Map at least one column before saving.")
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.importMapping.findUnique({ where: { kind_name: { kind, name: dto.name } } })
      const row = existing
        ? await tx.importMapping.update({ where: { id: existing.id }, data: { headers: dto.headers, mapping: clean, retiredAt: null, updatedById: me.id } })
        : await tx.importMapping.create({ data: { kind, name: dto.name, headers: dto.headers, mapping: clean, createdById: me.id, updatedById: me.id } })
      await this.audit.record({ actor: me, section: SECTION, action: `${existing ? "Updated" : "Saved"} the ${kind === "brands" ? "brand" : "product"} import mapping ${dto.name}`, entityType: "import_mapping", entityId: row.id, after: `${Object.keys(clean).length} columns mapped`, ip }, tx)
      return row
    })
  }

  async retireMapping(id: string, me: RequestUser, ip: string | null) {
    const m = await this.prisma.importMapping.findUnique({ where: { id } })
    if (!m) throw notFound("That mapping")
    await this.prisma.$transaction(async (tx) => {
      await tx.importMapping.update({ where: { id }, data: { retiredAt: new Date(), updatedById: me.id } })
      await this.audit.record({ actor: me, section: SECTION, action: `Retired the import mapping ${m.name}`, entityType: "import_mapping", entityId: id, ip }, tx)
    })
    return { ok: true }
  }

  /** Past imports, newest first. */
  async history(kind?: ImportKind, brandId?: string) {
    const rows = await this.prisma.importBatch.findMany({ where: { ...(kind ? { kind } : {}), ...(brandId ? { brandId } : {}) }, orderBy: { createdAt: "desc" }, take: 50 })
    const users = await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.createdById).filter((x): x is string => !!x) } }, select: { id: true, name: true } })
    return rows.map((r) => ({ ...r, by: users.find((u) => u.id === r.createdById)?.name ?? null }))
  }
}
