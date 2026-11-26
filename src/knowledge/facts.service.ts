import { Injectable } from "@nestjs/common"
import type { Fact, FactDefinition, Prisma } from "@prisma/client"

import { AuditService } from "../audit/audit.service"
import { countryLabel } from "../common/countries"
import { badRequest, conflict, forbidden, notFound } from "../common/errors"
import { actorLabel, type RequestUser } from "../common/request-user"
import { addDays, localDate } from "../jobs/clock"
import { JobQueue } from "../jobs/job-queue.service"
import { WorkTimeService } from "../jobs/work-time.service"
import { PrismaService } from "../prisma/prisma.service"
import { coerceValue, type CustomValues } from "../records/custom-fields.service"
import { parseNumberOrRange, parseRevenue, usdShort } from "../records/lenient"
import type { CreateFactDefinitionDto, SaveFactDto, UpdateFactDefinitionDto } from "./knowledge.dto"

// The knowledge base: one structured form per brand (Settings → Facts decides its fields). Every fact has a value,
// a source and an evidence date, and goes entered → verified (or rejected) by a second person (maker-checker).
//
//   - A new value is a new version: the old row is kept and marked superseded; nothing is overwritten.
//   - A verified fact changes only with new evidence (a different source or date), and is then verified again.
//   - The person who entered a fact verifies it only with "Verify own facts"; it is then marked self-verified.
//   - A fact is stale after its refresh date (evidence date + the field's refresh days).
//   - The brand's knowledge base is verified when every required field has a verified fact (with no field
//     required: when every entered fact is verified, and at least one is entered); stale when one of them is past
//     its refresh date. The status is recalculated on every change and every day (job facts.stale).

type Db = Prisma.TransactionClient
const SECTION = "Knowledge base"

export const GROUP_LABELS: Record<string, string> = { company: "Company facts", asia: "Asia position", regulatory: "Regulatory", outreach: "Outreach" }
export const KB_STATUS_LABELS: Record<string, string> = { not_started: "Not started", in_progress: "In progress", verified: "Verified", stale: "Verified, needs a refresh" }
const STATUS_LABELS: Record<string, string> = { entered: "Entered", verified: "Verified", rejected: "Rejected" }

/** One fact value in its stored form, or the exact reason it can't be one. Empty is an error: a fact has a value. */
export function coerceFact(def: Pick<FactDefinition, "label" | "type" | "options">, raw: unknown): { value: CustomValues[string] } | { error: string } {
  const empty = raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "") || (Array.isArray(raw) && raw.length === 0)
  if (empty) return { error: `${def.label}: enter the value.` }
  if (def.type === "usd") {
    // One amount, or a range kept as text ("USD 5M–7M").
    if (typeof raw === "string" && /^USD \d[\d.]*[KMB]?–\d/.test(raw)) return { value: raw }
    const r = parseRevenue(raw)
    if (!r) return { error: `${def.label}: enter the value.` }
    if ("error" in r) return { error: `${def.label}: ${r.error} Use an amount like 12.5M or a range like 5–7M.` }
    return { value: r.max !== null ? `${usdShort(r.min)}–${usdShort(r.max).replace("USD ", "")}` : r.min }
  }
  if (def.type === "number") {
    // A number, or a range kept as text ("11–50").
    const r = parseNumberOrRange(raw)
    if (r === null) return { error: `${def.label}: enter the value.` }
    if (typeof r === "object") return { error: `${def.label}: ${r.error}` }
    return { value: r }
  }
  const r = coerceValue({ label: def.label, type: def.type, options: def.options }, raw)
  if ("value" in r && r.value === null) return { error: `${def.label}: enter the value.` }
  return r
}

/** A fact value as text (change log, emails later). */
export function showFact(def: Pick<FactDefinition, "type">, v: unknown): string {
  if (v === null || v === undefined) return "—"
  if (def.type === "usd") return typeof v === "string" ? v : `USD ${Number(v).toLocaleString("en-US")}`
  if (def.type === "yes_no") return v ? "Yes" : "No"
  if (Array.isArray(v)) return v.join(", ")
  return String(v)
}

const dateOnly = (s: string) => new Date(`${s}T00:00:00Z`)
const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null)

@Injectable()
export class FactsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly workTime: WorkTimeService,
    private readonly queue: JobQueue,
  ) {}

  private async today() {
    return localDate(new Date(), await this.workTime.timezone())
  }

  definitions(db: Db = this.prisma, onlyActive = false) {
    return db.factDefinition.findMany({ where: onlyActive ? { active: true } : {}, orderBy: [{ sortOrder: "asc" }, { label: "asc" }] })
  }

  // ---------------------------------------------------------------- Status

  /** The knowledge base status from the current facts, as of today (company time zone). */
  async status(db: Db, brandId: string, today?: string) {
    const day = today ?? (await this.today())
    const [defs, facts] = await Promise.all([db.factDefinition.findMany({ where: { active: true } }), db.fact.findMany({ where: { brandId, supersededAt: null } })])
    return this.statusFrom(defs, facts, day)
  }

  private statusFrom(defs: FactDefinition[], facts: Fact[], today: string) {
    const current = (key: string) => facts.find((f) => f.factKey === key)
    // With no field marked Required (Settings → Facts), the facts that have been entered count instead: the
    // knowledge base is verified once every entered fact is verified, and not started while nothing is entered.
    const anyRequired = defs.some((d) => d.required)
    const required = anyRequired ? defs.filter((d) => d.required) : defs.filter((d) => current(d.key) && current(d.key)!.status !== "rejected")
    const verified = required.filter((d) => current(d.key)?.status === "verified")
    const stale = required.filter((d) => {
      const f = current(d.key)
      return f?.status === "verified" && iso(f.refreshDue)! < today
    })
    const missing = required.filter((d) => !current(d.key) || current(d.key)!.status === "rejected")
    const waiting = required.filter((d) => current(d.key)?.status === "entered")
    const status = !facts.length || !required.length ? "not_started" : verified.length < required.length ? "in_progress" : stale.length ? "stale" : "verified"
    return {
      status,
      label: KB_STATUS_LABELS[status],
      /** "required": the fields marked Required count; "entered": none is required, so the entered facts count. */
      basis: anyRequired ? ("required" as const) : ("entered" as const),
      required: required.length,
      verified: verified.length,
      waiting: waiting.map((d) => d.label),
      missing: missing.map((d) => d.label),
      stale: stale.map((d) => d.label),
    }
  }

  /** Recalculates and stores a brand's status (in the caller's transaction). Logged when it changes. */
  async refresh(db: Db, brandId: string, today?: string) {
    const s = await this.status(db, brandId, today)
    const b = await db.brand.findUnique({ where: { id: brandId }, select: { name: true, kbStatus: true, kbVerifiedAt: true } })
    if (!b || b.kbStatus === s.status) return s
    const becameVerified = s.status === "verified" && b.kbStatus !== "stale"
    await db.brand.update({ where: { id: brandId }, data: { kbStatus: s.status, ...(becameVerified ? { kbVerifiedAt: new Date() } : s.status === "in_progress" || s.status === "not_started" ? { kbVerifiedAt: null } : {}) } })
    await this.audit.record(
      { actor: { label: "System (knowledge base)" }, section: SECTION, action: `${b.name}: knowledge base ${KB_STATUS_LABELS[s.status].toLowerCase()}`, entityType: "brand", entityId: brandId, before: `Knowledge base: ${KB_STATUS_LABELS[b.kbStatus] ?? b.kbStatus}`, after: `Knowledge base: ${s.label}` },
      db,
    )
    return s
  }

  /** For the Target check: blocks while the knowledge base isn't verified (Configuration → Knowledge base). */
  async targetCheck(db: Db, brandId: string) {
    const s = await this.status(db, brandId)
    const required = await this.workTime.setting("kb.require_verified_for_target", true)
    const out = { blockers: [] as string[], warnings: [] as string[] }
    if (s.status === "not_started" || s.status === "in_progress") {
      const parts = [s.missing.length && `missing: ${s.missing.join(", ")}`, s.waiting.length && `waiting for a check: ${s.waiting.join(", ")}`].filter(Boolean).join("; ")
      const line =
        s.basis === "entered" && !s.required
          ? "The knowledge base has no facts yet: enter and verify the brand's facts first."
          : `The knowledge base isn't verified (${s.verified} of ${s.required} ${s.basis === "required" ? "required" : "entered"} facts verified${parts ? `; ${parts}` : ""}).`
      ;(required ? out.blockers : out.warnings).push(line)
    }
    if (s.status === "stale") out.warnings.push(`Past their refresh date: ${s.stale.join(", ")}. Check them again before outreach.`)
    return out
  }

  // ---------------------------------------------------------------- Reading

  /** The brand's knowledge-base form: each field with its current fact, history and stale flag. */
  async forBrand(brandId: string, me: RequestUser) {
    const brand = await this.prisma.brand.findUnique({ where: { id: brandId }, select: { id: true, name: true, archivedAt: true, homeRevenueUsd: true, homeRevenueMaxUsd: true, revenueYear: true, asianMarketsLive: true, kbVerifiedAt: true } })
    if (!brand) throw notFound("That brand")
    const today = await this.today()
    const [defs, facts, tiers] = await Promise.all([
      this.definitions(this.prisma, true),
      this.prisma.fact.findMany({ where: { brandId }, orderBy: { enteredAt: "desc" }, include: { dossier: { select: { id: true, title: true, archivedAt: true } } } }),
      this.prisma.listValue.findMany({ where: { listKey: "fact_source_tier" }, select: { code: true, label: true } }),
    ])
    const current = facts.filter((f) => !f.supersededAt)
    const status = this.statusFrom(defs, current, today)
    const view = (f: (typeof facts)[number]) => ({
      id: f.id,
      value: f.value,
      source: f.source,
      sourceTierCode: f.sourceTierCode,
      sourceTier: tiers.find((t) => t.code === f.sourceTierCode)?.label ?? null,
      evidenceDate: iso(f.evidenceDate),
      refreshDue: iso(f.refreshDue),
      stale: f.status === "verified" && !f.supersededAt && iso(f.refreshDue)! < today,
      status: f.status,
      origin: f.origin,
      note: f.note,
      dossier: f.dossier ? { id: f.dossier.id, title: f.dossier.title, archived: !!f.dossier.archivedAt } : null,
      enteredBy: f.enteredByLabel.replace(/\s*<[^>]*>$/, ""),
      enteredAt: f.enteredAt,
      mine: f.enteredById === me.id,
      verifiedBy: f.verifiedByLabel?.replace(/\s*<[^>]*>$/, "") ?? null,
      verifiedAt: f.verifiedAt,
      selfVerified: f.selfVerified,
      rejectedBy: f.rejectedByLabel?.replace(/\s*<[^>]*>$/, "") ?? null,
      rejectedAt: f.rejectedAt,
      rejectReason: f.rejectReason,
      supersededAt: f.supersededAt,
    })
    const suggest = (d: FactDefinition) => {
      if (d.brandField === "homeRevenueUsd" && brand.homeRevenueUsd !== null)
        return brand.homeRevenueMaxUsd !== null ? `${usdShort(Number(brand.homeRevenueUsd))}–${usdShort(Number(brand.homeRevenueMaxUsd)).replace("USD ", "")}` : Number(brand.homeRevenueUsd)
      if (d.brandField === "revenueYear" && brand.revenueYear !== null) return brand.revenueYear
      if (d.brandField === "asianMarketsLive" && brand.asianMarketsLive.length) return brand.asianMarketsLive.map((c) => countryLabel(c)).join(", ")
      return null
    }
    const groups = Object.keys(GROUP_LABELS)
      .map((code) => ({
        code,
        label: GROUP_LABELS[code],
        fields: defs
          .filter((d) => d.groupCode === code)
          .map((d) => {
            const cur = current.find((f) => f.factKey === d.key)
            return { key: d.key, label: d.label, help: d.help, type: d.type, options: d.options, required: d.required, refreshDays: d.refreshDays, suggested: cur ? null : suggest(d), current: cur ? view(cur) : null, history: facts.filter((f) => f.factKey === d.key && f.supersededAt).map(view) }
          }),
      }))
      .filter((g) => g.fields.length)
    return {
      status: { ...status, verifiedAt: brand.kbVerifiedAt },
      groups,
      archived: !!brand.archivedAt,
      can: { enter: me.permissions.has("kb.enter_facts") && !brand.archivedAt, verify: me.permissions.has("kb.verify_facts"), verifyOwn: me.permissions.has("kb.verify_own_facts") },
      today,
    }
  }

  // ---------------------------------------------------------------- Changing facts

  private async lockBrand(db: Prisma.TransactionClient, brandId: string) {
    const rows = await db.$queryRaw<{ id: string }[]>`SELECT id FROM "brand" WHERE id = ${brandId}::uuid FOR UPDATE`
    if (!rows.length) throw notFound("That brand")
    return (await db.brand.findUnique({ where: { id: brandId }, select: { id: true, name: true, archivedAt: true } }))!
  }

  /** Enters a fact (a new version). Needs "Enter facts". */
  async save(brandId: string, key: string, dto: SaveFactDto, me: RequestUser, ip: string | null) {
    if (!me.permissions.has("kb.enter_facts")) throw forbidden("Your roles don't allow entering facts.")
    await this.prisma.$transaction(async (tx) => {
      const brand = await this.lockBrand(tx, brandId)
      if (brand.archivedAt) throw badRequest(`${brand.name} is archived. Restore it to change its knowledge base.`)
      const def = await tx.factDefinition.findUnique({ where: { key } })
      if (!def || !def.active) throw badRequest("That field isn't in the knowledge base.")
      const v = coerceFact(def, dto.value)
      if ("error" in v) throw badRequest(v.error)
      const today = await this.today()
      if (dto.evidenceDate > addDays(today, 1)) throw badRequest("The evidence date is in the future.")
      if (dto.evidenceDate < "1990-01-01") throw badRequest("The evidence date is before 1990.")
      if (Number.isNaN(dateOnly(dto.evidenceDate).getTime())) throw badRequest("That evidence date doesn't exist.")
      if (dto.sourceTierCode) {
        const t = await tx.listValue.findUnique({ where: { listKey_code: { listKey: "fact_source_tier", code: dto.sourceTierCode } } })
        if (!t || t.retiredAt) throw badRequest("Pick a source tier from the list.")
      }
      if (dto.dossierId) {
        const d = await tx.dossier.findUnique({ where: { id: dto.dossierId } })
        if (!d || d.brandId !== brandId || d.archivedAt) throw badRequest("Pick one of this brand's dossiers.")
      }
      const cur = await tx.fact.findFirst({ where: { brandId, factKey: key, supersededAt: null } })
      const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
      if (cur && same(cur.value, v.value) && cur.source === dto.source && iso(cur.evidenceDate) === dto.evidenceDate && (cur.sourceTierCode ?? null) === (dto.sourceTierCode ?? null) && (cur.dossierId ?? null) === (dto.dossierId ?? null) && cur.note === (dto.note ?? "") && cur.status !== "rejected")
        return
      if (cur?.status === "verified" && cur.source === dto.source && iso(cur.evidenceDate) === dto.evidenceDate)
        throw conflict(`${def.label} is verified. A change needs new evidence: give the new source or the date of the new evidence.`)
      if (cur) await tx.fact.update({ where: { id: cur.id }, data: { supersededAt: new Date() } })
      await tx.fact.create({
        data: {
          brandId,
          factKey: key,
          value: v.value as Prisma.InputJsonValue,
          source: dto.source,
          sourceTierCode: dto.sourceTierCode ?? null,
          dossierId: dto.dossierId ?? null,
          evidenceDate: dateOnly(dto.evidenceDate),
          refreshDue: dateOnly(addDays(dto.evidenceDate, def.refreshDays)),
          note: dto.note ?? "",
          origin: "manual",
          enteredById: me.id,
          enteredByLabel: actorLabel(me),
        },
      })
      await this.audit.record(
        {
          actor: me,
          section: SECTION,
          action: `${brand.name}: entered ${def.label}`,
          entityType: "brand",
          entityId: brandId,
          before: cur ? `${def.label}: ${showFact(def, cur.value)} (${STATUS_LABELS[cur.status]})` : null,
          after: `${def.label}: ${showFact(def, v.value)}\nSource: ${dto.source}\nEvidence date: ${dto.evidenceDate}`,
          ip,
        },
        tx,
      )
      await this.refresh(tx, brandId, today)
    })
  }

  /** Verifies facts (maker-checker). Others' facts need "Verify facts"; your own need "Verify own facts". */
  private async verifyIn(tx: Prisma.TransactionClient, fact: Fact, def: FactDefinition, brandName: string, me: RequestUser, ip: string | null) {
    if (fact.supersededAt) throw conflict(`${def.label} has a newer version. Reload to see it.`)
    if (fact.status !== "entered") throw conflict(`${def.label} is already ${STATUS_LABELS[fact.status].toLowerCase()}.`)
    const own = fact.enteredById === me.id
    if (own && !me.permissions.has("kb.verify_own_facts")) throw forbidden(`You entered ${def.label}, so someone else must check it (maker-checker).`)
    if (!own && !me.permissions.has("kb.verify_facts")) throw forbidden("Your roles don't allow verifying facts.")
    await tx.fact.update({ where: { id: fact.id }, data: { status: "verified", verifiedById: me.id, verifiedByLabel: actorLabel(me), verifiedAt: new Date(), selfVerified: own } })
    await this.audit.record({ actor: me, section: SECTION, action: `${brandName}: verified ${def.label}${own ? " (self-verified)" : ""}`, entityType: "brand", entityId: fact.brandId, after: `${def.label}: ${showFact(def, fact.value)}\nSource: ${fact.source}`, ip }, tx)
  }

  async verify(factId: string, me: RequestUser, ip: string | null) {
    await this.prisma.$transaction(async (tx) => {
      const f = await tx.fact.findUnique({ where: { id: factId }, include: { definition: true } })
      if (!f) throw notFound("That fact")
      const brand = await this.lockBrand(tx, f.brandId)
      await this.verifyIn(tx, f, f.definition, brand.name, me, ip)
      await this.refresh(tx, f.brandId)
    })
  }

  /** Verifies several facts of one brand; the ones this person may not verify are skipped with the reason. */
  async verifyMany(brandId: string, factIds: string[], me: RequestUser, ip: string | null) {
    const skipped: string[] = []
    let verified = 0
    await this.prisma.$transaction(async (tx) => {
      const brand = await this.lockBrand(tx, brandId)
      const facts = await tx.fact.findMany({ where: { id: { in: factIds }, brandId }, include: { definition: true } })
      for (const f of facts) {
        try {
          await this.verifyIn(tx, f, f.definition, brand.name, me, ip)
          verified++
        } catch (e) {
          skipped.push(e instanceof Error ? e.message : String(e))
        }
      }
      await this.refresh(tx, brandId)
    })
    return { verified, skipped }
  }

  async reject(factId: string, dto: { reasonCode: string; reason: string }, me: RequestUser, ip: string | null) {
    if (!me.permissions.has("kb.verify_facts")) throw forbidden("Your roles don't allow checking facts.")
    await this.prisma.$transaction(async (tx) => {
      const f = await tx.fact.findUnique({ where: { id: factId }, include: { definition: true } })
      if (!f) throw notFound("That fact")
      const brand = await this.lockBrand(tx, f.brandId)
      if (f.supersededAt) throw conflict(`${f.definition.label} has a newer version. Reload to see it.`)
      if (f.status !== "entered") throw conflict(`${f.definition.label} is already ${STATUS_LABELS[f.status].toLowerCase()}.`)
      const code = await tx.listValue.findUnique({ where: { listKey_code: { listKey: "fact_reject_reason", code: dto.reasonCode } } })
      if (!code || code.retiredAt) throw badRequest("Pick a reason from the list.")
      const why = `${code.label}: ${dto.reason}`
      await tx.fact.update({ where: { id: f.id }, data: { status: "rejected", rejectedById: me.id, rejectedByLabel: actorLabel(me), rejectedAt: new Date(), rejectReason: why } })
      await this.audit.record({ actor: me, section: SECTION, action: `${brand.name}: rejected ${f.definition.label}`, entityType: "brand", entityId: f.brandId, before: `${f.definition.label}: ${showFact(f.definition, f.value)}`, reason: why, ip }, tx)
      await this.refresh(tx, f.brandId)
    })
  }

  /**
   * A Brand Register import: each filled fact column becomes a new version (status entered, origin import) unless
   * the current fact already has the same value. Runs inside the import's transaction.
   */
  async applyImport(tx: Prisma.TransactionClient, brandId: string, entries: { key: string; value: CustomValues[string] }[], opts: { source: string; evidenceDate: string; batchId: string; me: RequestUser }) {
    if (!entries.length) return 0
    await this.lockBrand(tx, brandId)
    const defs = await tx.factDefinition.findMany({ where: { key: { in: entries.map((e) => e.key) }, active: true } })
    let written = 0
    for (const e of entries) {
      const def = defs.find((d) => d.key === e.key)
      if (!def) continue
      const cur = await tx.fact.findFirst({ where: { brandId, factKey: e.key, supersededAt: null } })
      if (cur && cur.status !== "rejected" && JSON.stringify(cur.value) === JSON.stringify(e.value)) continue
      if (cur) await tx.fact.update({ where: { id: cur.id }, data: { supersededAt: new Date() } })
      await tx.fact.create({
        data: {
          brandId,
          factKey: e.key,
          value: e.value as Prisma.InputJsonValue,
          source: opts.source,
          evidenceDate: dateOnly(opts.evidenceDate),
          refreshDue: dateOnly(addDays(opts.evidenceDate, def.refreshDays)),
          origin: "import",
          importBatchId: opts.batchId,
          enteredById: opts.me.id,
          enteredByLabel: actorLabel(opts.me),
        },
      })
      written++
    }
    if (written) await this.refresh(tx, brandId)
    return written
  }

  /** The daily job: recalculates every brand's status, so facts past their refresh date flag the brand. */
  async refreshAll(today?: string) {
    const day = today ?? (await this.today())
    const brands = await this.prisma.brand.findMany({ where: { OR: [{ facts: { some: {} } }, { kbStatus: { not: "not_started" } }] }, select: { id: true, kbStatus: true } })
    let changed = 0
    let stale = 0
    for (const b of brands) {
      const s = await this.refresh(this.prisma, b.id, day)
      if (s.status !== b.kbStatus) changed++
      if (s.status === "stale") stale++
    }
    return `${brands.length} brands checked; ${changed} changed status; ${stale} need a refresh.`
  }

  // ---------------------------------------------------------------- Settings → Facts

  private slug(label: string) {
    return (
      label
        .toLowerCase()
        .normalize("NFKD")
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 40) || "fact"
    )
  }

  async createDefinition(dto: CreateFactDefinitionDto, me: RequestUser, ip: string | null) {
    const options = [...new Set((dto.options ?? []).map((o) => o.trim()).filter(Boolean))]
    if ((dto.type === "choice" || dto.type === "multi_choice") && options.length < 2) throw badRequest("A choice field needs at least two choices.")
    return this.prisma.$transaction(async (tx) => {
      let key = this.slug(dto.label)
      for (let i = 2; await tx.factDefinition.findUnique({ where: { key } }); i++) key = `${this.slug(dto.label)}_${i}`
      const last = await tx.factDefinition.findFirst({ orderBy: { sortOrder: "desc" } })
      const d = await tx.factDefinition.create({
        data: { key, label: dto.label, groupCode: dto.groupCode, type: dto.type, options: dto.type === "choice" || dto.type === "multi_choice" ? options : [], help: dto.help ?? "", required: dto.required ?? false, refreshDays: dto.refreshDays ?? 180, sortOrder: (last?.sortOrder ?? 0) + 10, updatedById: me.id },
      })
      await this.audit.record({ actor: me, section: "Facts", action: `Added the fact field ${d.label}`, entityType: "fact_definition", entityId: d.key, after: [`Group: ${GROUP_LABELS[d.groupCode]}`, `Type: ${d.type}`, `Required: ${d.required ? "Yes" : "No"}`, `Refresh after: ${d.refreshDays} days`].join("\n"), ip }, tx)
      if (d.required) await this.queue.enqueue("facts.stale", { date: await this.today(), reason: "field added" }, { db: tx })
      return d
    })
  }

  async updateDefinition(key: string, dto: UpdateFactDefinitionDto, me: RequestUser, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const d = await tx.factDefinition.findUnique({ where: { key } })
      if (!d) throw notFound("That fact field")
      const next = {
        label: dto.label ?? d.label,
        groupCode: dto.groupCode ?? d.groupCode,
        help: dto.help ?? d.help,
        options: dto.options ? [...new Set(dto.options.map((o) => o.trim()).filter(Boolean))] : d.options,
        required: dto.required ?? d.required,
        refreshDays: dto.refreshDays ?? d.refreshDays,
        active: dto.active ?? d.active,
        sortOrder: dto.sortOrder ?? d.sortOrder,
      }
      if ((d.type === "choice" || d.type === "multi_choice") && next.options.length < 2) throw badRequest("A choice field needs at least two choices.")
      const rulesChanged = next.required !== d.required || next.active !== d.active
      const lines: [string, string][] = []
      const add = (label: string, a: unknown, b: unknown) => {
        const x = Array.isArray(a) ? a.join(", ") : String(a)
        const y = Array.isArray(b) ? b.join(", ") : String(b)
        if (x !== y) lines.push([`${label}: ${x || "—"}`, `${label}: ${y || "—"}`])
      }
      add("Name", d.label, next.label)
      add("Group", GROUP_LABELS[d.groupCode], GROUP_LABELS[next.groupCode])
      add("Help", d.help, next.help)
      add("Choices", d.options, next.options)
      add("Required", d.required ? "Yes" : "No", next.required ? "Yes" : "No")
      add("Refresh after (days)", d.refreshDays, next.refreshDays)
      add("In use", d.active ? "Yes" : "No", next.active ? "Yes" : "No")
      add("Order", d.sortOrder, next.sortOrder)
      if (!lines.length) return d
      const updated = await tx.factDefinition.update({ where: { key }, data: { ...next, updatedById: me.id } })
      await this.audit.record({ actor: me, section: "Facts", action: `Changed the fact field ${updated.label}`, entityType: "fact_definition", entityId: key, before: lines.map((l) => l[0]).join("\n"), after: lines.map((l) => l[1]).join("\n"), reason: dto.reason?.trim() || null, ip }, tx)
      // Which fields count changed: every brand's status is recalculated in the background.
      if (rulesChanged) await this.queue.enqueue("facts.stale", { date: await this.today(), reason: "field rules changed" }, { db: tx })
      return updated
    })
  }
}

