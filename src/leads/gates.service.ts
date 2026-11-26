import { Injectable } from "@nestjs/common"
import type { GateDefinition, GateResult, Prisma } from "@prisma/client"

import { AuditService } from "../audit/audit.service"
import { badRequest, conflict, forbidden, notFound } from "../common/errors"
import { actorLabel, type RequestUser } from "../common/request-user"
import { WorkTimeService } from "../jobs/work-time.service"
import { PrismaService } from "../prisma/prisma.service"

// Gates: six checks on every lead, kept as a checklist. Each gate is pass, fail or unknown, and can be unticked
// ("not needed for this brand", with a reason) so it doesn't count. Values come from the Brand Register import or
// are set by hand; once a value has been set, changing it needs a reason code and one line, and is logged.
//
// The recommendation is made from the ticked gates, by rules (no AI), and never blocks anything:
//   desk gates 01–03: any fail → Not now; else any unknown → Review; else Pursue (ready for Target)
//   call gates 04–06: any fail → Not now; else any unknown → Verification pending; else SQL
// A decision that differs from the recommendation is an override: it needs a reason and is flagged.

type Db = Prisma.TransactionClient
export type GateValue = "pass" | "fail" | "unknown"
export const GATE_VALUES: GateValue[] = ["pass", "fail", "unknown"]
const SECTION = "Gates"
const VALUE_LABEL: Record<string, string> = { pass: "Pass", fail: "Fail", unknown: "Not checked" }
const FIELD_LABEL: Record<string, string> = { value: "Value", applies: "Needed", evidence: "Evidence", note: "Note" }

export type Recommendation = { value: string; label: string; reasons: string[] }

export const DESK_LABELS: Record<string, string> = { pursue: "Pursue: ready for Target", review: "Review", not_now: "Not now" }
export const CALL_LABELS: Record<string, string> = { sql: "SQL", verification_pending: "Verification pending", not_now: "Not now" }

/** Pass / fail / unknown / not applicable from a register cell: "Pass", "Y", "✓", "no", "?", "N/A"… */
export function parseGateCell(raw: unknown): { value: GateValue; applies: boolean } | null | "invalid" {
  const s = String(raw ?? "").trim().toLowerCase()
  if (!s) return null
  if (["pass", "p", "yes", "y", "✓", "✔", "true", "1", "ok"].includes(s)) return { value: "pass", applies: true }
  if (["fail", "f", "no", "n", "✗", "✘", "x", "false", "0"].includes(s)) return { value: "fail", applies: true }
  if (["unknown", "u", "?", "tbc", "tbd", "unk"].includes(s)) return { value: "unknown", applies: true }
  if (["n/a", "na", "not applicable", "not needed", "-", "—"].includes(s)) return { value: "unknown", applies: false }
  return "invalid"
}

@Injectable()
export class GatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly workTime: WorkTimeService,
  ) {}

  definitions(db: Db = this.prisma) {
    return db.gateDefinition.findMany({ orderBy: [{ sortOrder: "asc" }, { code: "asc" }] })
  }

  /** Makes sure a lead has a row for every gate that's switched on (missing ones start Unknown, ticked). */
  async ensure(db: Db, leadId: string) {
    const defs = await db.gateDefinition.findMany({ where: { active: true } })
    const have = await db.gateResult.findMany({ where: { leadId }, select: { gateCode: true } })
    const missing = defs.filter((d) => !have.some((h) => h.gateCode === d.code))
    if (missing.length) await db.gateResult.createMany({ data: missing.map((d) => ({ leadId, gateCode: d.code })), skipDuplicates: true })
  }

  /** On a new lead: the gates, with the register's values when it came from an import. */
  async initFor(db: Db, leadId: string, values: Record<string, { value: GateValue; applies: boolean }>, origin: { me: RequestUser; note: string } | null) {
    const defs = await db.gateDefinition.findMany({ where: { active: true } })
    for (const d of defs) {
      // An empty or "unknown" register cell counts as no value: the brand's details fill it below.
      const raw = values[d.code]
      const v = raw && (raw.value !== "unknown" || !raw.applies) ? raw : undefined
      await db.gateResult.upsert({
        where: { leadId_gateCode: { leadId, gateCode: d.code } },
        create: {
          leadId,
          gateCode: d.code,
          value: v?.value ?? "unknown",
          applies: v?.applies ?? true,
          notApplicableReason: v && !v.applies ? "Marked not applicable in the register." : null,
          evidence: v && origin ? origin.note : "",
          source: v ? "import" : "default",
          setById: v && origin ? origin.me.id : null,
        },
        update: {},
      })
      if (v && origin)
        await db.gateChange.create({
          data: { leadId, gateCode: d.code, field: v.applies ? "value" : "applies", before: null, after: v.applies ? v.value : "not applicable", reasonCode: "Brand Register import", reason: origin.note, source: "import", actorId: origin.me.id, actorLabel: actorLabel(origin.me) },
        })
    }
    await this.syncAuto(db, leadId)
  }

  /**
   * Fills gates that have a rule (01 category, 02 home revenue, 03 lane) from the brand's own details: a value
   * there → Pass (or Fail, for revenue outside the band); no value → Not checked. Only gates nobody has set by
   * hand, by import or on the call are touched, so a person's decision is never overwritten. Runs when a lead
   * opens and whenever the brand is saved.
   */
  async syncAuto(db: Db, leadId: string) {
    const lead = await db.lead.findUnique({ where: { id: leadId }, select: { id: true, brandId: true, closedAt: true } })
    if (!lead || lead.closedAt) return
    await this.ensure(db, leadId)
    const [defs, results, checks] = await Promise.all([db.gateDefinition.findMany({ where: { active: true, rule: { not: null } } }), db.gateResult.findMany({ where: { leadId } }), this.ruleChecks(db, lead.brandId)])
    for (const d of defs) {
      const r = results.find((x) => x.gateCode === d.code)
      const check = d.rule ? checks[d.rule] : undefined
      if (!r || !check || !r.applies || !["default", "auto"].includes(r.source)) continue
      if (r.value === check.value && r.evidence === check.why && r.source === "auto") continue
      await db.gateResult.update({ where: { id: r.id }, data: { value: check.value, evidence: check.why, source: "auto", setById: null, setAt: new Date() } })
      if (r.value !== check.value)
        await db.gateChange.create({ data: { leadId, gateCode: d.code, field: "value", before: VALUE_LABEL[r.value], after: VALUE_LABEL[check.value], reason: check.why, source: "auto", actorLabel: "System (from the brand's details)" } })
    }
  }

  /** After a brand is saved: refresh the automatic gates of its open lead. */
  async syncBrand(db: Db, brandId: string) {
    const open = await db.lead.findMany({ where: { brandId, closedAt: null }, select: { id: true } })
    for (const l of open) await this.syncAuto(db, l.id)
  }

  // ---------------------------------------------------------------- The recommendation

  /** What the brand's own fields say for gates with a rule (01 category, 02 revenue band, 03 lane). */
  private async ruleChecks(db: Db, brandId: string) {
    const b = await db.brand.findUnique({ where: { id: brandId }, select: { categoryCode: true, homeRevenueUsd: true, homeRevenueMaxUsd: true, routingCode: true } })
    const min = await this.workTime.setting("gates.revenue_min_usd", 5_000_000)
    const max = await this.workTime.setting("gates.revenue_max_usd", 50_000_000)
    const usd = (n: number) => (n >= 1e6 ? `USD ${+(n / 1e6).toFixed(1)}M` : `USD ${n.toLocaleString("en-US")}`)
    const out: Record<string, { value: GateValue; why: string }> = {}
    if (!b) return out
    out.category = b.categoryCode ? { value: "pass", why: "The brand has a category." } : { value: "unknown", why: "The brand has no category yet." }
    if (b.homeRevenueUsd === null) out.revenue_band = { value: "unknown", why: "No home revenue on the brand." }
    else {
      // A range ("5–7M") passes when all of it is inside the band, fails when all of it is outside, and is
      // unknown when it crosses the band's edge.
      const lo = Number(b.homeRevenueUsd)
      const hi = b.homeRevenueMaxUsd === null ? lo : Number(b.homeRevenueMaxUsd)
      const shown = hi === lo ? usd(lo) : `${usd(lo)}–${usd(hi).replace("USD ", "")}`
      const band = `${usd(min)}–${usd(max).replace("USD ", "")}`
      out.revenue_band =
        lo >= min && hi <= max
          ? { value: "pass", why: `${shown} is inside ${band}.` }
          : hi < min || lo > max
            ? { value: "fail", why: `${shown} is outside ${band}.` }
            : { value: "unknown", why: `${shown} crosses the edge of ${band}: check the figure.` }
    }
    out.lane = b.routingCode ? { value: "pass", why: "The brand has a lane." } : { value: "unknown", why: "The brand has no lane yet." }
    return out
  }

  private recommend(defs: GateDefinition[], results: GateResult[], stage: "desk" | "call"): Recommendation {
    const counted = defs
      .filter((d) => d.active && d.stage === stage)
      .map((d) => ({ d, r: results.find((x) => x.gateCode === d.code) }))
      .filter((x) => x.r?.applies !== false)
    const reasons: string[] = []
    const fails = counted.filter((x) => x.r?.value === "fail")
    const unknown = counted.filter((x) => !x.r || x.r.value === "unknown")
    for (const x of fails) reasons.push(`Gate ${x.d.code} ${x.d.name}: fail`)
    for (const x of unknown) reasons.push(`Gate ${x.d.code} ${x.d.name}: not checked`)
    const value = fails.length ? "not_now" : unknown.length ? (stage === "desk" ? "review" : "verification_pending") : stage === "desk" ? "pursue" : "sql"
    if (!counted.length) reasons.push("No gates are ticked.")
    return { value, label: (stage === "desk" ? DESK_LABELS : CALL_LABELS)[value], reasons }
  }

  /** Both recommendations for a lead, from its current gate values. */
  async recommendations(db: Db, leadId: string) {
    const [defs, results] = await Promise.all([this.definitions(db), db.gateResult.findMany({ where: { leadId } })])
    return { desk: this.recommend(defs, results, "desk"), call: this.recommend(defs, results, "call") }
  }

  /** The desk recommendation for many leads at once (the Leads list). */
  async recommendMany(leadIds: string[]) {
    const out = new Map<string, Recommendation>()
    if (!leadIds.length) return out
    const [defs, results] = await Promise.all([this.definitions(), this.prisma.gateResult.findMany({ where: { leadId: { in: leadIds } } })])
    const byLead = new Map<string, GateResult[]>()
    for (const r of results) byLead.set(r.leadId, [...(byLead.get(r.leadId) ?? []), r])
    for (const id of leadIds) out.set(id, this.recommend(defs, byLead.get(id) ?? [], "desk"))
    return out
  }

  // ---------------------------------------------------------------- Reading

  /** The lead's gates for the brand page: each gate with its value, tick, source, rule check and history. */
  async forLead(leadId: string, me: RequestUser) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId }, select: { id: true, brandId: true } })
    if (!lead) throw notFound("That lead")
    await this.ensure(this.prisma, leadId)
    await this.syncAuto(this.prisma, leadId)
    const [defs, results, changes, checks] = await Promise.all([
      this.definitions(),
      this.prisma.gateResult.findMany({ where: { leadId } }),
      this.prisma.gateChange.findMany({ where: { leadId }, orderBy: { at: "desc" }, take: 200 }),
      this.ruleChecks(this.prisma, lead.brandId),
    ])
    const setters = await this.prisma.user.findMany({ where: { id: { in: results.map((r) => r.setById).filter((x): x is string => !!x) } }, select: { id: true, name: true } })
    const gates = defs
      .filter((d) => d.active)
      .map((d) => {
        const r = results.find((x) => x.gateCode === d.code)!
        const check = d.rule ? checks[d.rule] : undefined
        return {
          code: d.code,
          name: d.name,
          checks: d.checks,
          stage: d.stage,
          value: r.value,
          applies: r.applies,
          notApplicableReason: r.notApplicableReason,
          evidence: r.evidence,
          note: r.note,
          source: r.source,
          setBy: setters.find((s) => s.id === r.setById)?.name ?? null,
          setAt: r.source === "default" ? null : r.setAt,
          ruleCheck: check ?? null,
          /** The brand's fields say otherwise: shown as a flag, never changed silently. */
          disagrees: !!check && r.source !== "auto" && r.applies && r.value !== "unknown" && check.value !== "unknown" && check.value !== r.value,
          canEdit: me.permissions.has(d.stage === "desk" ? "gates.edit_desk" : "gates.edit_call"),
          needsReason: r.source !== "default" && r.source !== "auto",
          history: changes.filter((c) => c.gateCode === d.code),
        }
      })
    return { gates, ...(await this.recommendations(this.prisma, leadId)) }
  }

  // ---------------------------------------------------------------- Changing

  /**
   * Sets a gate's value, tick or evidence on a lead. The first value on a gate nobody has set yet needs no reason;
   * any change after that needs a reason code (Lists → Gate change reasons) and one line. Unticking always needs
   * a reason. Desk gates need "Change desk gates", call gates "Change call gates".
   */
  async set(
    leadId: string,
    gateCode: string,
    dto: { value?: string; applies?: boolean; evidence?: string; note?: string; reasonCode?: string | null; reason?: string; source?: "manual" | "call" },
    me: RequestUser,
    ip: string | null,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const lead = await tx.lead.findUnique({ where: { id: leadId }, include: { brand: { select: { name: true } } } })
      if (!lead) throw notFound("That lead")
      if (lead.closedAt) throw badRequest("This journey is closed, so its gates can't change.")
      const def = await tx.gateDefinition.findUnique({ where: { code: gateCode } })
      if (!def || !def.active) throw badRequest("That gate isn't in use.")
      if (!me.permissions.has(def.stage === "desk" ? "gates.edit_desk" : "gates.edit_call")) throw forbidden(`Your roles don't allow changing ${def.stage} gates.`)
      await this.ensure(tx, leadId)
      const r = (await tx.gateResult.findUnique({ where: { leadId_gateCode: { leadId, gateCode } } }))!

      const value = dto.value === undefined ? r.value : dto.value
      if (!GATE_VALUES.includes(value as GateValue)) throw badRequest("A gate is Pass, Fail or Unknown.")
      const applies = dto.applies === undefined ? r.applies : dto.applies
      const evidence = dto.evidence === undefined ? r.evidence : dto.evidence.trim().slice(0, 500)
      const note = dto.note === undefined ? r.note : dto.note.trim().slice(0, 2000)
      const reason = dto.reason?.trim() || null
      const valueChanged = value !== r.value
      const tickChanged = applies !== r.applies
      if (!valueChanged && !tickChanged && evidence === r.evidence && note === r.note) return

      let reasonLabel: string | null = null
      if (dto.reasonCode) {
        const v = await tx.listValue.findUnique({ where: { listKey_code: { listKey: "gate_change_reason", code: dto.reasonCode } } })
        if (!v || v.retiredAt) throw badRequest("Pick a reason from the list.")
        reasonLabel = v.label
      }
      if (tickChanged && !applies && !reason) throw badRequest(`Say why gate ${def.code} ${def.name} isn't needed for ${lead.brand.name}.`)
      if (valueChanged && r.source !== "default" && r.source !== "auto" && (!reasonLabel || !reason)) throw badRequest(`Changing gate ${def.code} needs a reason and one line about it.`)

      const source = dto.source ?? (def.stage === "call" && lead.stage === "hot" ? "call" : "manual")
      await tx.gateResult.update({
        where: { id: r.id },
        data: { value, applies, notApplicableReason: applies ? null : reason, evidence, note, ...(valueChanged || tickChanged ? { source, setById: me.id, setAt: new Date() } : {}) },
      })
      const rows: { field: string; before: string; after: string }[] = []
      if (valueChanged) rows.push({ field: "value", before: VALUE_LABEL[r.value], after: VALUE_LABEL[value] })
      if (tickChanged) rows.push({ field: "applies", before: r.applies ? "Needed" : "Not needed", after: applies ? "Needed" : "Not needed" })
      if (evidence !== r.evidence) rows.push({ field: "evidence", before: r.evidence || "—", after: evidence || "—" })
      if (note !== r.note) rows.push({ field: "note", before: r.note || "—", after: note || "—" })
      for (const c of rows) await tx.gateChange.create({ data: { leadId, gateCode, field: c.field, before: c.before, after: c.after, reasonCode: reasonLabel, reason, source, actorId: me.id, actorLabel: actorLabel(me) } })
      await this.audit.record(
        {
          actor: me,
          section: SECTION,
          action: `${lead.brand.name}: gate ${def.code} ${def.name}`,
          entityType: "lead",
          entityId: leadId,
          before: rows.map((c) => `${FIELD_LABEL[c.field]}: ${c.before}`).join("\n"),
          after: rows.map((c) => `${FIELD_LABEL[c.field]}: ${c.after}`).join("\n"),
          reason: [reasonLabel, reason].filter(Boolean).join(": ") || null,
          ip,
        },
        tx,
      )
    })
  }

  /** Gate notes from a Brand Register import: a filled cell replaces the note (logged in the gate's history). */
  async importNotes(db: Db, brandId: string, notes: Record<string, string>, me: RequestUser) {
    if (!Object.keys(notes).length) return
    const lead = await db.lead.findFirst({ where: { brandId, closedAt: null }, orderBy: { createdAt: "desc" } })
    if (!lead) return
    await this.ensure(db, lead.id)
    const results = await db.gateResult.findMany({ where: { leadId: lead.id } })
    for (const [code, raw] of Object.entries(notes)) {
      const note = raw.trim().slice(0, 2000)
      const r = results.find((x) => x.gateCode === code)
      if (!r || !note || r.note === note) continue
      await db.gateResult.update({ where: { id: r.id }, data: { note } })
      await db.gateChange.create({ data: { leadId: lead.id, gateCode: code, field: "note", before: r.note || "—", after: note, source: "import", actorId: me.id, actorLabel: actorLabel(me) } })
    }
  }

  /** A Brand Register import updating an open lead's gates: only cells that differ, logged as the import. */
  async applyImport(db: Db, leadId: string, values: Record<string, { value: GateValue; applies: boolean }>, me: RequestUser, note: string) {
    await this.ensure(db, leadId)
    const results = await db.gateResult.findMany({ where: { leadId } })
    for (const [code, v] of Object.entries(values)) {
      if (v.applies && v.value === "unknown") continue
      const r = results.find((x) => x.gateCode === code)
      if (!r || (r.value === v.value && r.applies === v.applies)) continue
      await db.gateResult.update({ where: { id: r.id }, data: { value: v.value, applies: v.applies, notApplicableReason: v.applies ? null : "Marked not applicable in the register.", evidence: note, source: "import", setById: me.id, setAt: new Date() } })
      await db.gateChange.create({
        data: { leadId, gateCode: code, field: r.value !== v.value ? "value" : "applies", before: r.applies ? VALUE_LABEL[r.value] : "Not needed", after: v.applies ? VALUE_LABEL[v.value] : "Not needed", reasonCode: "Brand Register import", reason: note, source: "import", actorId: me.id, actorLabel: actorLabel(me) },
      })
    }
  }

  // ---------------------------------------------------------------- Settings → Gates

  async updateDefinition(code: string, dto: { name?: string; checks?: string; active?: boolean; reason?: string }, me: RequestUser, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const d = await tx.gateDefinition.findUnique({ where: { code } })
      if (!d) throw notFound("That gate")
      const name = dto.name?.trim() ?? d.name
      if (!name) throw badRequest("Give the gate a name.")
      const checks = dto.checks?.trim() ?? d.checks
      const active = dto.active ?? d.active
      if (active !== d.active && !dto.reason?.trim()) throw badRequest(`Say why gate ${code} is being switched ${active ? "on" : "off"}.`)
      const lines = [name !== d.name && [`Name: ${d.name}`, `Name: ${name}`], checks !== d.checks && [`Checks: ${d.checks || "—"}`, `Checks: ${checks || "—"}`], active !== d.active && [`In use: ${d.active ? "Yes" : "No"}`, `In use: ${active ? "Yes" : "No"}`]].filter((x): x is string[] => !!x)
      if (!lines.length) return d
      const updated = await tx.gateDefinition.update({ where: { code }, data: { name, checks, active, updatedById: me.id } })
      await this.audit.record({ actor: me, section: SECTION, action: `Changed gate ${code}`, entityType: "gate_definition", entityId: code, before: lines.map((l) => l[0]).join("\n"), after: lines.map((l) => l[1]).join("\n"), reason: dto.reason?.trim() || null, ip }, tx)
      return updated
    })
  }

  /**
   * Adds a gate (Settings → Gates). It gets the next number, is checked by hand or from the Brand Register (no
   * automatic rule), and counts in its stage's recommendation at once: until someone checks it, leads show it as
   * not checked. Gates are switched off, never deleted.
   */
  async createDefinition(dto: { name: string; checks?: string; stage: string }, me: RequestUser, ip: string | null) {
    const name = dto.name.trim()
    if (!name) throw badRequest("Give the gate a name.")
    if (!["desk", "call"].includes(dto.stage)) throw badRequest("Pick when the gate is checked: at the desk (before Target) or on the call.")
    return this.prisma.$transaction(async (tx) => {
      const all = await tx.gateDefinition.findMany()
      if (all.some((g) => g.name.trim().toLowerCase() === name.toLowerCase())) throw conflict(`There's already a gate called ${name}.`)
      const next = Math.max(0, ...all.map((g) => Number(g.code)).filter((n) => Number.isInteger(n))) + 1
      const code = String(next).padStart(2, "0")
      const created = await tx.gateDefinition.create({ data: { code, name, checks: dto.checks?.trim() ?? "", stage: dto.stage, rule: null, active: true, sortOrder: Math.max(0, ...all.map((g) => g.sortOrder)) + 10, updatedById: me.id } })
      await this.audit.record({ actor: me, section: SECTION, action: `Added gate ${code} ${name}`, entityType: "gate_definition", entityId: code, after: [`Name: ${name}`, `Checked: ${dto.stage === "desk" ? "at the desk (before Target)" : "on the call"}`, created.checks && `Checks: ${created.checks}`].filter(Boolean).join("\n"), ip }, tx)
      return created
    })
  }
}
