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
import type { ImportDto, ImportRow } from "./records.dto"
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

export type RowResult = { row: number; ok: boolean; reasons: string[]; warnings: string[]; summary: string }

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
  lists: Record<"category" | "sub_category" | "routing" | "tier" | "tag", ListRef[]>
  fields: CustomField[]
  orgFields: CustomField[]
  users: { id: string; email: string; name: string }[]
  orgs: { id: string; name: string; domain: string | null; excluded: boolean; archived: boolean }[]
  brandDomains: Map<string, { name: string; archived: boolean }>
}

type CategoryPick = { categoryCode: string | null; subCategoryCode: string | null }

type BrandPlan = {
  row: number
  org: { id: string } | { newName: string; legalEntity: string | null; domain: string | null; hqCountry: string | null; custom: CustomValues }
  data: {
    name: string
    domain: string
    categoryCode: string
    subCategoryCode: string
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
  tags: string[]
}

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
    return [...orgBase, ...orgTargets, ...base.filter((t) => t.group !== "Organisation"), ...own]
  }

  // ---------------------------------------------------------------- Shared lookups

  private async load(db: Prisma.TransactionClient, entity: "brand" | "product"): Promise<Ref> {
    const [values, fields, orgFields, users, orgs, brands] = await Promise.all([
      db.listValue.findMany({ where: { listKey: { in: ["category", "sub_category", "routing", "tier", "tag"] } }, include: { parent: { select: { code: true } } } }),
      db.customField.findMany({ where: { entityType: entity } }),
      entity === "brand" ? db.customField.findMany({ where: { entityType: "organisation" } }) : Promise.resolve([]),
      db.user.findMany({ where: { status: { not: "deactivated" } }, select: { id: true, email: true, name: true } }),
      entity === "brand" ? db.organisation.findMany({ select: { id: true, name: true, domain: true, excluded: true, archivedAt: true } }) : Promise.resolve([]),
      entity === "brand" ? db.brand.findMany({ select: { name: true, domain: true, archivedAt: true } }) : Promise.resolve([]),
    ])
    const list = (k: string) => values.filter((v) => v.listKey === k).map((v) => ({ code: v.code, label: v.label, parentCode: v.parent?.code ?? null, retired: !!v.retiredAt }))
    return {
      lists: { category: list("category"), sub_category: list("sub_category"), routing: list("routing"), tier: list("tier"), tag: list("tag") },
      fields,
      orgFields,
      users,
      orgs: orgs.map((o) => ({ id: o.id, name: o.name, domain: o.domain, excluded: o.excluded, archived: !!o.archivedAt })),
      brandDomains: new Map(brands.map((b) => [b.domain, { name: b.name, archived: !!b.archivedAt }])),
    }
  }

  /** A list value by its name or code; the exact reason if it isn't one. */
  private pickList(ref: Ref, key: "category" | "sub_category" | "routing" | "tier", raw: string, label: string, listName: string, reasons: string[], parentCode?: string | null) {
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

  private planBrands(ref: Ref, rows: ImportRow[]) {
    const results: RowResult[] = []
    const plans: BrandPlan[] = []
    const seenDomains = new Map<string, number>()
    const newOrgs = new Map<string, number>()
    for (const { row, values: v } of rows) {
      const reasons: string[] = []
      const warnings: string[] = []
      const orgName = text(v.organisation)
      const name = text(v.name)
      if (!orgName) reasons.push("Organisation name is empty.")
      if (!name) reasons.push("Brand name is empty.")

      let domain: string | null = null
      if (!text(v.website)) reasons.push("Brand website is empty. It's how duplicates are caught.")
      else {
        try {
          domain = normaliseDomain(text(v.website), "Brand website")
        } catch (e) {
          reasons.push(e instanceof Error ? e.message : `Brand website "${text(v.website)}" isn't a website.`)
        }
      }
      if (domain) {
        const existing = ref.brandDomains.get(domain)
        if (existing) reasons.push(existing.archived ? `${existing.name} (archived) already uses ${domain}. Restore it in Records instead of importing it again.` : `${existing.name} is already in Records with ${domain}.`)
        const first = seenDomains.get(domain)
        if (first !== undefined) reasons.push(`Same brand website as row ${first} in this file.`)
        else seenDomains.set(domain, row)
      }

      const cat = this.pickCategory(ref, text(v.category), text(v.subCategory), reasons)
      if (!text(v.category) && !text(v.subCategory)) reasons.push("Category and sub-category are empty.")
      else if (cat.categoryCode && !cat.subCategoryCode && !text(v.subCategory)) reasons.push("Sub-category is empty.")
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

      // The organisation: an existing one with the same name, or one new organisation per name in the file.
      let org: BrandPlan["org"] | null = null
      if (orgName) {
        const same = ref.orgs.filter((o) => lower(o.name) === lower(orgName))
        const active = same.filter((o) => !o.archived)
        if (active.length > 1) reasons.push(`${active.length} organisations in Records are called ${orgName}. Rename one of them in Records, then import again.`)
        else if (active.length === 1) {
          org = { id: active[0].id }
          if (active[0].excluded) warnings.push(`Organisation ${active[0].name} is excluded: don't approach this brand.`)
          if (text(v.organisationLegalEntity) || text(v.organisationWebsite) || text(v.organisationHq) || ref.orgFields.some((f) => text(v[`org.custom.${f.key}`]))) warnings.push(`${active[0].name} is already in Records, so the organisation columns in this row are not used.`)
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

      const tags = this.pickTags(ref, v.tags, reasons, warnings)
      const custom = this.pickCustom(ref, v, reasons)

      const ok = reasons.length === 0
      const orgText = org && "id" in org ? `under ${orgName}` : `under new organisation ${orgName}`
      results.push({ row, ok, reasons, warnings, summary: ok ? `${name} ${orgText}` : "" })
      if (ok && org && domain)
        plans.push({
          row,
          org,
          tags,
          data: {
            name,
            domain,
            categoryCode: cat.categoryCode!,
            subCategoryCode: cat.subCategoryCode!,
            routingCode,
            tierCode,
            homeCountry,
            homeRevenueUsd: revenue ?? null,
            revenueYear,
            asianMarketsLive: markets,
            ownerId,
            linkedinUrl,
            description: text(v.description),
            custom,
          },
        })
    }
    return { results, plans, newOrganisations: [...new Set(plans.filter((p) => "newName" in p.org).map((p) => lower((p.org as { newName: string }).newName)))].length }
  }

  async checkBrands(dto: ImportDto) {
    this.checkRows(dto.rows)
    const ref = await this.load(this.prisma, "brand")
    const { results, newOrganisations } = this.planBrands(ref, dto.rows)
    return this.summary(results, { newOrganisations })
  }

  async importBrands(dto: ImportDto, me: RequestUser, ip: string | null) {
    this.checkRows(dto.rows)
    return this.prisma.$transaction(
      async (tx) => {
        const ref = await this.load(tx, "brand")
        const { results, plans } = this.planBrands(ref, dto.rows)
        const batch = await tx.importBatch.create({ data: { kind: "brands", fileName: dto.fileName, mapping: (dto.mapping ?? {}) as Prisma.InputJsonValue, rowCount: dto.rows.length, createdCount: 0, rejectedCount: 0, createdById: me.id } })
        const orgIds = new Map<string, string>()
        let orgsMade = 0
        let leadsOpened = 0
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
          const { homeRevenueUsd, custom, ...rest } = p.data
          const b = await tx.brand.create({
            data: { ...rest, homeRevenueUsd: homeRevenueUsd === null ? null : BigInt(homeRevenueUsd), custom: custom as Prisma.InputJsonValue, organisationId, source: "import", importBatchId: batch.id, createdById: me.id, updatedById: me.id },
          })
          if (p.tags.length) await this.tags.set(tx, "brand", b.id, (await this.tags.ensure(tx, p.tags, me, ip)).map((t) => t.code), me)
          await this.audit.record({ actor: me, section: "Records", action: `Added the brand ${b.name} (import)`, entityType: "brand", entityId: b.id, after: `From ${dto.fileName}, row ${p.row}`, ip }, tx)
          // Every imported brand starts its journey at Register (not for excluded organisations).
          const excluded = "id" in p.org && ref.orgs.find((o) => o.id === organisationId)?.excluded
          if (!excluded) {
            await this.journey.openIn(tx, b.id, { importBatchId: batch.id }, me, ip)
            leadsOpened++
          }
        }
        return this.finish(tx, batch.id, results, me, ip, `Imported ${plans.length} brand${plans.length === 1 ? "" : "s"} from ${dto.fileName}`, { newOrganisations: orgsMade, leadsOpened })
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

  /** Past imports, newest first. */
  async history(kind?: ImportKind, brandId?: string) {
    const rows = await this.prisma.importBatch.findMany({ where: { ...(kind ? { kind } : {}), ...(brandId ? { brandId } : {}) }, orderBy: { createdAt: "desc" }, take: 50 })
    const users = await this.prisma.user.findMany({ where: { id: { in: rows.map((r) => r.createdById).filter((x): x is string => !!x) } }, select: { id: true, name: true } })
    return rows.map((r) => ({ ...r, by: users.find((u) => u.id === r.createdById)?.name ?? null }))
  }
}
