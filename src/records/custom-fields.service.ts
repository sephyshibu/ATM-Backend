import { Injectable } from "@nestjs/common"
import type { CustomField, Prisma } from "@prisma/client"

import { AuditService } from "../audit/audit.service"
import { badRequest, conflict, notFound } from "../common/errors"
import type { RequestUser } from "../common/request-user"
import { PrismaService } from "../prisma/prisma.service"
import type { Change } from "./records-common"
import type { CreateCustomFieldDto, UpdateCustomFieldDto } from "./records.dto"

// Custom fields: extra fields for brands and products that admins add in Settings → Fields, e.g. "Shelf life
// (months)" or "Halal certified". Values are stored in the record's `custom` JSON by field key. A field's key and
// type never change once made, and fields are retired rather than deleted, so stored values always keep their meaning.

export const FIELD_TYPES = ["text", "long_text", "number", "date", "yes_no", "choice", "multi_choice"] as const
export type FieldType = (typeof FIELD_TYPES)[number]
export type CustomEntity = "organisation" | "brand" | "product" | "person"
export const CUSTOM_ENTITIES: CustomEntity[] = ["organisation", "brand", "product", "person"]
export type CustomValues = Record<string, string | number | boolean | string[] | null>

const SECTION = "Fields"
const TYPE_LABELS: Record<FieldType, string> = {
  text: "Short text",
  long_text: "Long text",
  number: "Number",
  date: "Date",
  yes_no: "Yes / no",
  choice: "One choice",
  multi_choice: "Several choices",
}

/**
 * A field every record has, for Settings → Fields. `required` is the default; Settings → Fields can switch it for any field that isn't
 * `locked` (the ones the system can't work without, or where "required" means nothing, such as a yes/no).
 */
export type BuiltInField = { key: string; label: string; type: string; required: boolean; locked?: boolean; unique?: string; list?: string; help: string }

export const BUILT_IN_FIELDS: Record<CustomEntity, BuiltInField[]> = {
  organisation: [
    { key: "name", label: "Organisation name", type: "Short text", required: true, locked: true, help: "The legal entity ATM signs with." },
    { key: "legalEntity", label: "Legal entity (registered name)", type: "Short text", required: false, help: "Used on agreements and invoices." },
    { key: "domain", label: "Organisation website", type: "Web address", required: false, unique: "Unique among organisations.", help: "" },
    { key: "hqCountry", label: "Head office country", type: "Country", required: false, help: "" },
    { key: "parent", label: "Parent group", type: "Organisation", required: false, help: "The bigger group it belongs to." },
    { key: "linkedin", label: "LinkedIn page", type: "Web address", required: false, help: "" },
    { key: "excluded", label: "Excluded", type: "Yes / no", required: false, locked: true, help: "Don't approach it or its brands and people. Changing it needs a reason." },
    { key: "notes", label: "Notes", type: "Long text", required: false, help: "" },
    { key: "tags", label: "Tags", type: "Several choices", required: false, locked: true, list: "Tags", help: "" },
  ],
  brand: [
    { key: "organisation", label: "Organisation", type: "Organisation", required: true, locked: true, help: "The legal entity ATM signs with. Imports create it from the organisation name." },
    { key: "name", label: "Brand name", type: "Short text", required: true, locked: true, help: "" },
    { key: "website", label: "Brand website", type: "Web address", required: true, unique: "Unique among brands: it's how duplicates are caught.", help: "If you make it optional, brands without one are matched by name within their organisation." },
    { key: "category", label: "Category", type: "One choice", required: true, list: "Categories", help: "" },
    { key: "subCategory", label: "Sub-category", type: "One choice", required: true, list: "Sub-categories", help: "Must sit under the category." },
    { key: "lane", label: "Lane", type: "One choice", required: false, list: "Lanes", help: "Entry, Expansion or Re-entry." },
    { key: "tier", label: "Tier", type: "One choice", required: false, list: "Brand tiers", help: "" },
    { key: "homeCountry", label: "Home country", type: "Country", required: false, help: "" },
    { key: "homeRevenueUsd", label: "Home revenue (USD)", type: "Number", required: false, help: "Whole US dollars." },
    { key: "revenueYear", label: "Revenue year", type: "Number", required: false, help: "" },
    { key: "asianMarketsLive", label: "Asian markets live", type: "Several countries", required: false, help: "" },
    { key: "owner", label: "Owner at ATM", type: "ATM user", required: false, help: "" },
    { key: "linkedin", label: "LinkedIn page", type: "Web address", required: false, help: "" },
    { key: "description", label: "About the brand", type: "Long text", required: false, help: "" },
    { key: "tags", label: "Tags", type: "Several choices", required: false, locked: true, list: "Tags", help: "New tags can be added while tagging." },
  ],
  product: [
    { key: "name", label: "Product name", type: "Short text", required: true, locked: true, unique: "Unique within its brand.", help: "" },
    { key: "sku", label: "SKU", type: "Short text", required: false, unique: "Unique within its brand.", help: "The brand's product code." },
    { key: "category", label: "Category", type: "One choice", required: false, list: "Categories", help: "Empty: the product takes the brand's." },
    { key: "subCategory", label: "Sub-category", type: "One choice", required: false, list: "Sub-categories", help: "Must sit under the category." },
    { key: "description", label: "Description", type: "Long text", required: false, help: "" },
    { key: "tags", label: "Tags", type: "Several choices", required: false, locked: true, list: "Tags", help: "New tags can be added while tagging." },
  ],
  person: [
    { key: "organisation", label: "Organisation", type: "Organisation", required: true, locked: true, help: "Where they work. A person can work on several of its brands." },
    { key: "firstName", label: "First name", type: "Short text", required: true, locked: true, help: "" },
    { key: "lastName", label: "Last name", type: "Short text", required: false, help: "" },
    { key: "jobTitle", label: "Job title", type: "Short text", required: false, help: "" },
    { key: "email", label: "Work email", type: "Email", required: true, unique: "Unique among people.", help: "" },
    { key: "emailStatus", label: "Email check", type: "One choice", required: false, locked: true, help: "Not checked, Verified, Bounced or invalid." },
    { key: "phone", label: "Phone", type: "Short text", required: false, help: "" },
    { key: "country", label: "Country", type: "Country", required: false, help: "" },
    { key: "linkedin", label: "LinkedIn profile", type: "Web address", required: false, help: "" },
    { key: "buyingRole", label: "Buying role", type: "One choice", required: false, list: "Buying roles", help: "" },
    { key: "consent", label: "Consent to contact", type: "One choice", required: false, list: "Consent to contact", help: "" },
    { key: "notes", label: "Notes", type: "Long text", required: false, help: "" },
  ],
}

const YES = new Set(["yes", "y", "true", "1", "x"])
const NO = new Set(["no", "n", "false", "0"])

/** "12,500" → 12500; a number stays a number; anything else is not a number. */
export function parseNumber(raw: unknown): number | null | undefined {
  if (raw === null || raw === undefined || raw === "") return null
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined
  const n = Number(String(raw).replace(/[,\s]/g, ""))
  return Number.isFinite(n) ? n : undefined
}

/** 2026-03-31, 31/03/2026 or 31-03-2026 → "2026-03-31". */
export function parseDate(raw: unknown): string | null | undefined {
  if (raw === null || raw === undefined || raw === "") return null
  const s = String(raw).trim()
  let y: number, m: number, d: number
  let match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(s)
  if (match) [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])]
  else if ((match = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s))) [d, m, y] = [Number(match[1]), Number(match[2]), Number(match[3])]
  else return undefined
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return undefined
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
}

/** Splits "a, b; c" (or takes an array) into trimmed, non-empty parts. */
export const splitList = (raw: unknown): string[] =>
  (Array.isArray(raw) ? raw.map(String) : String(raw ?? "").split(/[,;\n]/))
    .map((s) => s.trim())
    .filter(Boolean)

/** One value for one field: the stored form, or the exact reason it can't be stored. */
export function coerceValue(field: Pick<CustomField, "label" | "type" | "options">, raw: unknown): { value: CustomValues[string] } | { error: string } {
  const empty = raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "") || (Array.isArray(raw) && raw.length === 0)
  if (empty) return { value: null }
  const shown = Array.isArray(raw) ? raw.join(", ") : String(raw)
  switch (field.type as FieldType) {
    case "text":
    case "long_text": {
      const v = String(raw).trim()
      if (field.type === "text" && v.length > 500) return { error: `${field.label}: keep it under 500 characters.` }
      return { value: v.slice(0, 10_000) }
    }
    case "number": {
      const n = parseNumber(raw)
      return n === undefined ? { error: `${field.label}: "${shown}" isn't a number.` } : { value: n }
    }
    case "date": {
      const d = parseDate(raw)
      return d === undefined ? { error: `${field.label}: "${shown}" isn't a date. Use 2026-03-31 or 31/03/2026.` } : { value: d }
    }
    case "yes_no": {
      if (typeof raw === "boolean") return { value: raw }
      const s = String(raw).trim().toLowerCase()
      if (YES.has(s)) return { value: true }
      if (NO.has(s)) return { value: false }
      return { error: `${field.label}: "${shown}" should be Yes or No.` }
    }
    case "choice": {
      const hit = field.options.find((o) => o.toLowerCase() === String(raw).trim().toLowerCase())
      return hit ? { value: hit } : { error: `${field.label}: "${shown}" isn't one of the choices (${field.options.join(", ")}).` }
    }
    case "multi_choice": {
      const out: string[] = []
      for (const part of splitList(raw)) {
        const hit = field.options.find((o) => o.toLowerCase() === part.toLowerCase())
        if (!hit) return { error: `${field.label}: "${part}" isn't one of the choices (${field.options.join(", ")}).` }
        if (!out.includes(hit)) out.push(hit)
      }
      return { value: out }
    }
    default:
      return { error: `${field.label}: unknown field type.` }
  }
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0)

export const showCustom = (v: unknown) => (isEmpty(v) ? "—" : Array.isArray(v) ? v.join(", ") : typeof v === "boolean" ? (v ? "Yes" : "No") : String(v))

@Injectable()
export class CustomFieldsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** All fields (retired ones too, so old values still show their names), in order. */
  list(entityType?: CustomEntity, db: Prisma.TransactionClient = this.prisma) {
    return db.customField.findMany({ where: entityType ? { entityType } : {}, orderBy: [{ entityType: "asc" }, { sortOrder: "asc" }, { label: "asc" }] })
  }

  /**
   * Checks the values sent for a record and merges them into what it already has. Values for unknown or retired
   * fields are refused (a retired field's existing value is kept). On create, required fields must have a value;
   * on update, a required field can't be emptied.
   */
  async apply(db: Prisma.TransactionClient, entityType: CustomEntity, input: Record<string, unknown> | undefined, current: unknown, creating: boolean) {
    const fields = await this.list(entityType, db)
    const before = (current && typeof current === "object" && !Array.isArray(current) ? current : {}) as CustomValues
    const after: CustomValues = { ...before }
    for (const [key, raw] of Object.entries(input ?? {})) {
      const field = fields.find((f) => f.key === key)
      if (!field) throw badRequest(`There's no field called ${key}.`)
      if (field.retiredAt) {
        if (JSON.stringify(before[key] ?? null) !== JSON.stringify(raw ?? null)) throw badRequest(`${field.label} is retired. Restore it in Settings → Fields to change it.`)
        continue
      }
      const r = coerceValue(field, raw)
      if ("error" in r) throw badRequest(r.error)
      if (r.value === null) delete after[key]
      else after[key] = r.value
    }
    for (const f of fields) {
      if (!f.required || f.retiredAt) continue
      if ((creating || (input && f.key in input)) && isEmpty(after[f.key])) throw badRequest(`${f.label} is required.`)
    }
    return { values: after, changes: this.changes(fields, before, after) }
  }

  /** Change-log lines for custom values. */
  changes(fields: CustomField[], before: CustomValues, after: CustomValues): Change[] {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    return keys.map((k) => ({ label: fields.find((f) => f.key === k)?.label ?? k, before: before[k] ?? null, after: after[k] ?? null, show: showCustom }))
  }

  // ---------------------------------------------------------------- Settings → Fields

  async create(dto: CreateCustomFieldDto, me: RequestUser, ip: string | null) {
    const label = dto.label.trim()
    if (!label) throw badRequest("Give the field a name.")
    const options = this.cleanOptions(dto.type, dto.options)
    return this.prisma.$transaction(async (tx) => {
      const same = await tx.customField.findFirst({ where: { entityType: dto.entityType, label: { equals: label, mode: "insensitive" } } })
      if (same) throw conflict(same.retiredAt ? `${same.label} already exists but is retired. Restore it instead.` : `There's already a ${dto.entityType} field called ${same.label}.`)
      const base = label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "field"
      let key = base
      for (let n = 2; await tx.customField.findUnique({ where: { entityType_key: { entityType: dto.entityType, key } } }); n++) key = `${base.slice(0, 36)}_${n}`
      const last = await tx.customField.findFirst({ where: { entityType: dto.entityType }, orderBy: { sortOrder: "desc" } })
      const f = await tx.customField.create({
        data: { entityType: dto.entityType, key, label, type: dto.type, options, required: !!dto.required, help: dto.help?.trim() ?? "", sortOrder: (last?.sortOrder ?? 0) + 10, createdById: me.id, updatedById: me.id },
      })
      await this.audit.record(
        {
          actor: me,
          section: SECTION,
          action: `Added the ${dto.entityType} field ${label}`,
          entityType: "custom_field",
          entityId: f.id,
          after: [`Type: ${TYPE_LABELS[dto.type]}`, options.length ? `Choices: ${options.join(", ")}` : "", f.required ? "Required" : ""].filter(Boolean).join("\n"),
          ip,
        },
        tx,
      )
      return f
    })
  }

  async update(id: string, dto: UpdateCustomFieldDto, me: RequestUser, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const f = await tx.customField.findUnique({ where: { id } })
      if (!f) throw notFound("That field")
      const data: Prisma.CustomFieldUpdateInput = {}
      if (dto.label !== undefined) {
        const label = dto.label.trim()
        if (!label) throw badRequest("Give the field a name.")
        const same = await tx.customField.findFirst({ where: { entityType: f.entityType, id: { not: id }, label: { equals: label, mode: "insensitive" } } })
        if (same) throw conflict(`There's already a ${f.entityType} field called ${same.label}.`)
        data.label = label
      }
      if (dto.options !== undefined) {
        const options = this.cleanOptions(f.type as FieldType, dto.options)
        // Choices already stored on records stay valid: a choice can be renamed only by adding the new one.
        const dropped = f.options.filter((o) => !options.includes(o))
        if (dropped.length) {
          const used = await this.usedChoices(tx, f, dropped)
          if (used.length) throw badRequest(`${used.join(", ")} ${used.length === 1 ? "is" : "are"} used on records, so ${used.length === 1 ? "it" : "they"} can't be removed.`)
        }
        data.options = options
      }
      if (dto.required !== undefined) data.required = dto.required
      if (dto.help !== undefined) data.help = dto.help.trim()
      if (dto.sortOrder !== undefined) data.sortOrder = dto.sortOrder
      const lines = [
        dto.label !== undefined && dto.label.trim() !== f.label && [`Name: ${f.label}`, `Name: ${dto.label.trim()}`],
        data.options !== undefined && (data.options as string[]).join(", ") !== f.options.join(", ") && [`Choices: ${f.options.join(", ") || "—"}`, `Choices: ${(data.options as string[]).join(", ") || "—"}`],
        dto.required !== undefined && dto.required !== f.required && [`Required: ${f.required ? "Yes" : "No"}`, `Required: ${dto.required ? "Yes" : "No"}`],
        dto.help !== undefined && dto.help.trim() !== f.help && [`Help: ${f.help || "—"}`, `Help: ${dto.help.trim() || "—"}`],
      ].filter((x): x is string[] => !!x)
      const updated = await tx.customField.update({ where: { id }, data: { ...data, updatedById: me.id } })
      if (lines.length)
        await this.audit.record(
          { actor: me, section: SECTION, action: `Changed the ${f.entityType} field ${updated.label}`, entityType: "custom_field", entityId: id, before: lines.map((l) => l[0]).join("\n"), after: lines.map((l) => l[1]).join("\n"), ip },
          tx,
        )
      return updated
    })
  }

  async retire(id: string, retire: boolean, me: RequestUser, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const f = await tx.customField.findUnique({ where: { id } })
      if (!f) throw notFound("That field")
      if (!!f.retiredAt === retire) return f
      const updated = await tx.customField.update({ where: { id }, data: retire ? { retiredAt: new Date(), retiredById: me.id, updatedById: me.id } : { retiredAt: null, retiredById: null, updatedById: me.id } })
      await this.audit.record(
        { actor: me, section: SECTION, action: `${retire ? "Retired" : "Restored"} the ${f.entityType} field ${f.label}`, entityType: "custom_field", entityId: id, before: retire ? "In use" : "Retired", after: retire ? "Retired" : "In use", ip },
        tx,
      )
      return updated
    })
  }

  private cleanOptions(type: FieldType, options: string[] | undefined) {
    const list = [...new Set((options ?? []).map((o) => o.trim()).filter(Boolean))]
    const choice = type === "choice" || type === "multi_choice"
    if (choice && !list.length) throw badRequest("Add at least one choice.")
    if (choice && list.some((o) => /[,;]/.test(o))) throw badRequest("Choices can't contain commas or semicolons (they separate choices in imports).")
    return choice ? list : []
  }

  private async usedChoices(db: Prisma.TransactionClient, f: CustomField, choices: string[]) {
    const table = ({ organisation: "organisation", brand: "brand", product: "product", person: "person" } as Record<string, string>)[f.entityType]
    if (!table) return []
    const rows = await db.$queryRawUnsafe<{ v: unknown }[]>(`SELECT custom -> $1 AS v FROM "${table}" WHERE custom ? $1`, f.key)
    const used = new Set<string>()
    for (const r of rows) for (const v of Array.isArray(r.v) ? r.v : [r.v]) if (typeof v === "string") used.add(v)
    return choices.filter((c) => used.has(c))
  }
}
