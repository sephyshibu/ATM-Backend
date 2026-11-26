import { Injectable } from "@nestjs/common"
import type { EmailTemplateVersion, Prisma } from "@prisma/client"

import { AuditService } from "../audit/audit.service"
import { countryLabel } from "../common/countries"
import { badRequest, conflict, forbidden, notFound } from "../common/errors"
import { actorLabel, type RequestUser } from "../common/request-user"
import { WorkTimeService } from "../jobs/work-time.service"
import { PrismaService } from "../prisma/prisma.service"
import { usdShort } from "../records/lenient"
import { checkText, fill, joinAnd, MERGE_FIELDS, type MergeValues } from "./merge"
import type { CreateTemplateDto, SaveDraftDto, SetRuleDto, TemplateKind, TemplateWordingDto } from "./templates.dto"

// Email templates (Step 8).
//   - A template is a 7-step sequence (subject, body, days to wait) or the booking emails (email 1, reminder).
//   - Wording lives in versions. Every edit is a draft; anyone with "Approve templates" approves it, including
//     whoever wrote or edited it (then recorded as self-approved); approving a newer version supersedes the old one. Approved wording never changes,
//     and contacts keep the version they were given, so edits only affect future contacts.
//   - The matrix picks a brand's template by category, sub-category and lane: the most specific rule wins, down to
//     the default. A rule only points at a template with an approved version.
//   - Merge fields are filled from the brand, its contact, its owner and its VERIFIED knowledge base only.
// Nothing is deleted: templates are archived, versions discarded or superseded, matrix rules removed with history.

const SECTION = "Email templates"
type Db = Prisma.TransactionClient

export const STEP_COUNT: Record<TemplateKind, number> = { sequence: 7, booking: 2 }
const KIND_LABEL: Record<TemplateKind, string> = { sequence: "Outreach sequence", booking: "Booking emails" }
const BOOKING_STEPS = ["Booking email 1", "Booking reminder"]

type Step = { subject: string; body: string; delayDays: number }

/** The order the matrix is searched in, most specific first. */
const MATCH_ORDER = [
  { cat: true, sub: true, lane: true, label: "category + sub-category + lane" },
  { cat: true, sub: true, lane: false, label: "category + sub-category" },
  { cat: true, sub: false, lane: true, label: "category + lane" },
  { cat: true, sub: false, lane: false, label: "category" },
  { cat: false, sub: false, lane: false, label: "the default" },
] as const

@Injectable()
export class TemplatesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly workTime: WorkTimeService,
  ) {}

  // ---------------------------------------------------------------- Checks

  private need(me: RequestUser, permission: string, what: string) {
    if (!me.permissions.has(permission)) throw forbidden(`Your roles don't allow ${what}.`)
  }

  /** The wording, tidied and checked: the right number of steps, no empty step, only known merge fields. */
  private wording(kind: TemplateKind, dto: TemplateWordingDto): { steps: Step[]; openingFallback: string; note: string } {
    const count = STEP_COUNT[kind]
    if (dto.steps.length !== count) throw badRequest(kind === "sequence" ? "A sequence has 7 emails." : "Booking templates have 2 emails: email 1 and the reminder.")
    const problems: string[] = []
    const steps = dto.steps.map((s, i) => {
      const name = kind === "booking" ? BOOKING_STEPS[i] : `Email ${i + 1}`
      const subject = s.subject.trim()
      const body = s.body.replace(/[ \t]+$/gm, "").trim()
      if (!subject) problems.push(`${name}: write a subject.`)
      if (!body) problems.push(`${name}: write the email.`)
      for (const p of [...checkText(subject), ...checkText(body)]) problems.push(`${name}: ${p}`)
      // The first email goes out on the release day; a booking reminder waits for the configured working days.
      const delayDays = i === 0 || kind === "booking" ? 0 : s.delayDays
      if (kind === "sequence" && i > 0 && delayDays < 1) problems.push(`${name}: wait at least 1 day after the previous email.`)
      return { subject, body, delayDays }
    })
    const openingFallback = (dto.openingFallback ?? "").trim()
    for (const p of checkText(openingFallback)) problems.push(`Back-up opening line: ${p}`)
    if (/\{\{\s*touchOne/.test(openingFallback)) problems.push("Back-up opening line: it's used when there's no touch-one, so it can't contain {{touchOne}}.")
    if (problems.length) throw badRequest(problems.slice(0, 8).join(" "))
    return { steps, openingFallback, note: (dto.note ?? "").trim() }
  }

  // ---------------------------------------------------------------- Reading

  async list() {
    const [templates, rules] = await Promise.all([
      this.prisma.emailTemplate.findMany({ orderBy: [{ kind: "asc" }, { name: "asc" }], include: { versions: { orderBy: { version: "desc" } } } }),
      this.prisma.templateRule.findMany({ where: { removedAt: null }, select: { templateId: true } }),
    ])
    return templates.map((t) => {
      const live = t.versions.find((v) => v.status === "approved")
      const draft = t.versions.find((v) => v.status === "draft")
      return {
        id: t.id,
        kind: t.kind,
        name: t.name,
        description: t.description,
        archived: !!t.archivedAt,
        live: live ? { version: live.version, approvedAt: live.approvedAt, approvedBy: live.approvedByLabel } : null,
        draft: draft ? { id: draft.id, version: draft.version, by: draft.createdByLabel, updatedAt: draft.updatedAt } : null,
        usedIn: rules.filter((r) => r.templateId === t.id).length,
      }
    })
  }

  private versionView(v: EmailTemplateVersion, me: RequestUser) {
    return {
      id: v.id,
      version: v.version,
      status: v.status,
      steps: v.steps as Step[],
      openingFallback: v.openingFallback,
      note: v.note,
      createdAt: v.createdAt,
      createdBy: v.createdByLabel,
      updatedAt: v.updatedAt,
      approvedAt: v.approvedAt,
      approvedBy: v.approvedByLabel,
      supersededAt: v.supersededAt,
      discardedAt: v.discardedAt,
      mine: v.editorIds.includes(me.id),
      selfApproved: !!v.approvedById && v.editorIds.includes(v.approvedById),
    }
  }

  async get(id: string, me: RequestUser) {
    const t = await this.prisma.emailTemplate.findUnique({ where: { id }, include: { versions: { orderBy: { version: "desc" } }, rules: { where: { removedAt: null } } } })
    if (!t) throw notFound("That template")
    return {
      id: t.id,
      kind: t.kind,
      name: t.name,
      description: t.description,
      archived: !!t.archivedAt,
      usedIn: t.rules.length,
      versions: t.versions.map((v) => this.versionView(v, me)),
      can: { write: me.permissions.has("templates.write"), approve: me.permissions.has("templates.approve") },
    }
  }

  mergeFields() {
    return MERGE_FIELDS
  }

  // ---------------------------------------------------------------- Writing

  async create(dto: CreateTemplateDto, me: RequestUser, ip: string | null) {
    this.need(me, "templates.write", "writing templates")
    const w = this.wording(dto.kind, dto)
    return this.prisma.$transaction(async (tx) => {
      const twin = await tx.emailTemplate.findFirst({ where: { kind: dto.kind, name: { equals: dto.name, mode: "insensitive" }, archivedAt: null } })
      if (twin) throw conflict(`There's already a template called ${twin.name}.`)
      const t = await tx.emailTemplate.create({ data: { kind: dto.kind, name: dto.name, description: dto.description ?? "", createdById: me.id } })
      await tx.emailTemplateVersion.create({ data: { templateId: t.id, version: 1, status: "draft", steps: w.steps as Prisma.InputJsonValue, openingFallback: w.openingFallback, note: w.note || "First version", createdById: me.id, createdByLabel: actorLabel(me), editorIds: [me.id] } })
      await this.audit.record({ actor: me, section: SECTION, action: `Added the template ${t.name} (draft version 1)`, entityType: "email_template", entityId: t.id, after: `${KIND_LABEL[dto.kind]}\n${w.steps.map((s, i) => `${i + 1}. ${s.subject}`).join("\n")}`, ip }, tx)
      return { id: t.id }
    })
  }

  /** Saves the draft: edits the open draft, or starts a new one from the given wording. Approved wording never changes. */
  async saveDraft(id: string, dto: SaveDraftDto, me: RequestUser, ip: string | null) {
    this.need(me, "templates.write", "writing templates")
    return this.prisma.$transaction(async (tx) => {
      const t = await tx.emailTemplate.findUnique({ where: { id }, include: { versions: { orderBy: { version: "desc" } } } })
      if (!t) throw notFound("That template")
      if (t.archivedAt) throw badRequest("This template is archived. Restore it first.")
      const w = this.wording(t.kind as TemplateKind, dto)
      const changes: string[] = []
      if (dto.name && dto.name !== t.name) {
        const twin = await tx.emailTemplate.findFirst({ where: { kind: t.kind, name: { equals: dto.name, mode: "insensitive" }, archivedAt: null, id: { not: id } } })
        if (twin) throw conflict(`There's already a template called ${twin.name}.`)
        changes.push(`Name: ${t.name} → ${dto.name}`)
      }
      if (dto.description !== undefined && dto.description !== t.description) changes.push("Description changed")
      if (changes.length) await tx.emailTemplate.update({ where: { id }, data: { name: dto.name ?? t.name, description: dto.description ?? t.description } })
      const draft = t.versions.find((v) => v.status === "draft")
      let version: number
      if (draft) {
        await tx.emailTemplateVersion.update({
          where: { id: draft.id },
          data: { steps: w.steps as Prisma.InputJsonValue, openingFallback: w.openingFallback, note: w.note || draft.note, editorIds: draft.editorIds.includes(me.id) ? draft.editorIds : [...draft.editorIds, me.id] },
        })
        version = draft.version
      } else {
        version = (t.versions[0]?.version ?? 0) + 1
        await tx.emailTemplateVersion.create({ data: { templateId: id, version, status: "draft", steps: w.steps as Prisma.InputJsonValue, openingFallback: w.openingFallback, note: w.note, createdById: me.id, createdByLabel: actorLabel(me), editorIds: [me.id] } })
      }
      await this.audit.record({ actor: me, section: SECTION, action: `${t.name}: saved draft version ${version}`, entityType: "email_template", entityId: id, after: [...changes, w.note && `Note: ${w.note}`].filter(Boolean).join("\n") || undefined, ip }, tx)
      return { version }
    })
  }

  /** Approves a draft (its author may approve it: recorded as self-approved). The approved version before it is superseded. */
  async approve(versionId: string, me: RequestUser, ip: string | null) {
    this.need(me, "templates.approve", "approving templates")
    return this.prisma.$transaction(async (tx) => {
      const v = await tx.emailTemplateVersion.findUnique({ where: { id: versionId }, include: { template: true } })
      if (!v) throw notFound("That version")
      if (v.status !== "draft") throw conflict(`Version ${v.version} is ${v.status}, not a draft.`)
      if (v.template.archivedAt) throw badRequest("This template is archived. Restore it first.")
      const self = v.editorIds.includes(me.id)
      this.wording(v.template.kind as TemplateKind, { steps: v.steps as Step[], openingFallback: v.openingFallback })
      const before = await tx.emailTemplateVersion.findFirst({ where: { templateId: v.templateId, status: "approved" } })
      if (before) await tx.emailTemplateVersion.update({ where: { id: before.id }, data: { status: "superseded", supersededAt: new Date() } })
      await tx.emailTemplateVersion.update({ where: { id: v.id }, data: { status: "approved", approvedAt: new Date(), approvedById: me.id, approvedByLabel: actorLabel(me) } })
      await this.audit.record(
        { actor: me, section: SECTION, action: `${v.template.name}: approved version ${v.version}${self ? " (self-approved)" : ""}`, entityType: "email_template", entityId: v.templateId, before: before ? `Version ${before.version} in use` : "No version in use", after: `Version ${v.version} in use (written by ${v.createdByLabel})`, ip },
        tx,
      )
      return { ok: true }
    })
  }

  async discard(versionId: string, me: RequestUser, ip: string | null) {
    this.need(me, "templates.write", "writing templates")
    return this.prisma.$transaction(async (tx) => {
      const v = await tx.emailTemplateVersion.findUnique({ where: { id: versionId }, include: { template: true } })
      if (!v) throw notFound("That version")
      if (v.status !== "draft") throw conflict("Only a draft can be discarded.")
      await tx.emailTemplateVersion.update({ where: { id: v.id }, data: { status: "discarded", discardedAt: new Date() } })
      await this.audit.record({ actor: me, section: SECTION, action: `${v.template.name}: discarded draft version ${v.version}`, entityType: "email_template", entityId: v.templateId, ip }, tx)
      return { ok: true }
    })
  }

  async archive(id: string, me: RequestUser, ip: string | null) {
    this.need(me, "templates.write", "writing templates")
    return this.prisma.$transaction(async (tx) => {
      const t = await tx.emailTemplate.findUnique({ where: { id }, include: { rules: { where: { removedAt: null } } } })
      if (!t) throw notFound("That template")
      if (t.archivedAt) return { ok: true }
      if (t.rules.length) throw conflict(`${t.name} is used in the template matrix (${t.rules.length} ${t.rules.length === 1 ? "cell" : "cells"}). Point those at another template first.`)
      await tx.emailTemplate.update({ where: { id }, data: { archivedAt: new Date(), archivedById: me.id } })
      await this.audit.record({ actor: me, section: SECTION, action: `Archived the template ${t.name}`, entityType: "email_template", entityId: id, ip }, tx)
      return { ok: true }
    })
  }

  async restore(id: string, me: RequestUser, ip: string | null) {
    this.need(me, "templates.write", "writing templates")
    return this.prisma.$transaction(async (tx) => {
      const t = await tx.emailTemplate.findUnique({ where: { id } })
      if (!t) throw notFound("That template")
      if (!t.archivedAt) return { ok: true }
      const twin = await tx.emailTemplate.findFirst({ where: { kind: t.kind, name: { equals: t.name, mode: "insensitive" }, archivedAt: null } })
      if (twin) throw conflict(`There's already a template called ${twin.name}. Rename that one first.`)
      await tx.emailTemplate.update({ where: { id }, data: { archivedAt: null, archivedById: null } })
      await this.audit.record({ actor: me, section: SECTION, action: `Restored the template ${t.name}`, entityType: "email_template", entityId: id, ip }, tx)
      return { ok: true }
    })
  }

  // ---------------------------------------------------------------- The matrix

  async matrix() {
    const rules = await this.prisma.templateRule.findMany({ where: { removedAt: null }, include: { template: { select: { id: true, name: true, archivedAt: true, versions: { where: { status: "approved" }, select: { version: true } } } } } })
    const order = (r: (typeof rules)[number]) => (r.categoryCode ? 0 : 1) * 100 + (r.subCategoryCode ? 0 : 10) + (r.routingCode ? 0 : 1)
    return rules
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.categoryCode.localeCompare(b.categoryCode) || a.subCategoryCode.localeCompare(b.subCategoryCode) || order(a) - order(b) || a.routingCode.localeCompare(b.routingCode))
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        categoryCode: r.categoryCode,
        subCategoryCode: r.subCategoryCode,
        routingCode: r.routingCode,
        template: { id: r.template.id, name: r.template.name, archived: !!r.template.archivedAt, liveVersion: r.template.versions[0]?.version ?? null },
        updatedAt: r.updatedAt,
      }))
  }

  private async listValue(db: Db, listKey: string, code: string) {
    return db.listValue.findFirst({ where: { listKey, code, retiredAt: null } })
  }

  /** Points one cell of the matrix at a template (the cell's earlier rule is kept as removed history). */
  async setRule(dto: SetRuleDto, me: RequestUser, ip: string | null) {
    this.need(me, "templates.matrix", "editing the template matrix")
    const cat = dto.categoryCode ?? ""
    const sub = dto.subCategoryCode ?? ""
    const lane = dto.routingCode ?? ""
    if (sub && !cat) throw badRequest("Pick the category of the sub-category.")
    if (lane && !cat) throw badRequest("A lane needs a category; for every brand in a lane, set the default instead.")
    return this.prisma.$transaction(async (tx) => {
      const c = cat ? await this.listValue(tx, "category", cat) : null
      if (cat && !c) throw badRequest("That category isn't in Lists (or it's retired).")
      if (sub) {
        const s = await this.listValue(tx, "sub_category", sub)
        if (!s || s.parentId !== c!.id) throw badRequest("That sub-category isn't under the category.")
      }
      if (lane && !(await this.listValue(tx, "routing", lane))) throw badRequest("That lane isn't in Lists (or it's retired).")
      const t = await tx.emailTemplate.findUnique({ where: { id: dto.templateId }, include: { versions: { where: { status: "approved" } } } })
      if (!t || t.kind !== dto.kind) throw badRequest(`Pick ${dto.kind === "sequence" ? "an outreach sequence" : "a booking"} template.`)
      if (t.archivedAt) throw badRequest(`${t.name} is archived.`)
      if (!t.versions.length) throw badRequest(`${t.name} has no approved version yet. Approve one first.`)
      const cell = await tx.templateRule.findFirst({ where: { kind: dto.kind, categoryCode: cat, subCategoryCode: sub, routingCode: lane, removedAt: null }, include: { template: { select: { name: true } } } })
      if (cell?.templateId === t.id) return { ok: true }
      if (cell) await tx.templateRule.update({ where: { id: cell.id }, data: { removedAt: new Date(), removedById: me.id } })
      await tx.templateRule.create({ data: { kind: dto.kind, categoryCode: cat, subCategoryCode: sub, routingCode: lane, templateId: t.id, createdById: me.id, updatedById: me.id } })
      await this.audit.record(
        { actor: me, section: SECTION, action: `Template matrix (${KIND_LABEL[dto.kind].toLowerCase()}): ${await this.cellLabel(tx, cat, sub, lane)} → ${t.name}`, entityType: "template_rule", entityId: `${dto.kind}:${cat}:${sub}:${lane}`, before: cell ? cell.template.name : "Not set", after: t.name, ip },
        tx,
      )
      return { ok: true }
    })
  }

  async removeRule(id: string, me: RequestUser, ip: string | null) {
    this.need(me, "templates.matrix", "editing the template matrix")
    return this.prisma.$transaction(async (tx) => {
      const r = await tx.templateRule.findUnique({ where: { id }, include: { template: { select: { name: true } } } })
      if (!r) throw notFound("That matrix cell")
      if (r.removedAt) return { ok: true }
      await tx.templateRule.update({ where: { id }, data: { removedAt: new Date(), removedById: me.id } })
      await this.audit.record({ actor: me, section: SECTION, action: `Template matrix (${KIND_LABEL[r.kind as TemplateKind].toLowerCase()}): removed ${await this.cellLabel(tx, r.categoryCode, r.subCategoryCode, r.routingCode)}`, entityType: "template_rule", entityId: `${r.kind}:${r.categoryCode}:${r.subCategoryCode}:${r.routingCode}`, before: r.template.name, after: "Not set", ip }, tx)
      return { ok: true }
    })
  }

  private async cellLabel(db: Db, cat: string, sub: string, lane: string) {
    if (!cat && !sub && !lane) return "the default"
    const label = async (key: string, code: string) => (await db.listValue.findFirst({ where: { listKey: key, code } }))?.label ?? code
    return [cat && (await label("category", cat)), sub && (await label("sub_category", sub)), lane && `${await label("routing", lane)} lane`].filter(Boolean).join(" · ")
  }

  // ---------------------------------------------------------------- What a brand gets

  /** The template a brand gets for a kind, with the reason; null when no rule fits. */
  private async resolve(db: Db, brand: { categoryCode: string | null; subCategoryCode: string | null; routingCode: string | null }, kind: TemplateKind) {
    const rules = await db.templateRule.findMany({
      where: { kind, removedAt: null },
      include: { template: { include: { versions: { where: { status: "approved" } } } } },
    })
    const cat = brand.categoryCode ?? ""
    const sub = brand.subCategoryCode ?? ""
    const lane = brand.routingCode ?? ""
    const tried: string[] = []
    for (const step of MATCH_ORDER) {
      if ((step.cat && !cat) || (step.sub && !sub) || (step.lane && !lane)) continue
      const rule = rules.find((r) => r.categoryCode === (step.cat ? cat : "") && r.subCategoryCode === (step.sub ? sub : "") && r.routingCode === (step.lane ? lane : ""))
      if (!rule) {
        tried.push(step.label)
        continue
      }
      const live = rule.template.versions[0]
      if (rule.template.archivedAt || !live) {
        tried.push(`${step.label} (${rule.template.name} has no approved version)`)
        continue
      }
      return { template: rule.template, version: live, matchedBy: step.label, tried }
    }
    return { template: null, version: null, matchedBy: null, tried }
  }

  /** The values for a brand's merge fields, and who the contact is. Facts are used only when verified. */
  private async valuesFor(db: Db, brandId: string) {
    const b = await db.brand.findUnique({
      where: { id: brandId },
      include: {
        organisation: { select: { name: true, legalEntity: true } },
        owner: { select: { name: true } },
        people: { where: { removedAt: null, person: { archivedAt: null } }, include: { person: true }, orderBy: { addedAt: "asc" } },
      },
    })
    if (!b) throw notFound("That brand")
    const links = b.people
    const contactLink = links.find((l) => l.isPrimary) ?? links.find((l) => l.person.buyingRoleCode === "SIGNER") ?? links[0] ?? null
    const p = contactLink?.person ?? null
    const contactWhy = !contactLink ? null : contactLink.isPrimary ? "main contact" : contactLink.person.buyingRoleCode === "SIGNER" ? "signer" : "first person linked"
    const labels = await db.listValue.findMany({ where: { OR: [{ listKey: "category", code: b.categoryCode ?? "" }, { listKey: "sub_category", code: b.subCategoryCode ?? "" }, { listKey: "routing", code: b.routingCode ?? "" }] } })
    const label = (key: string, code: string | null) => (code ? (labels.find((l) => l.listKey === key && l.code === code)?.label ?? code) : null)
    const touch = await db.fact.findFirst({ where: { brandId, factKey: "touch_one", supersededAt: null, status: "verified" }, orderBy: { enteredAt: "desc" } })
    const touchAny = touch ? null : await db.fact.findFirst({ where: { brandId, factKey: "touch_one", supersededAt: null, status: { not: "rejected" } } })
    const country = (c: string | null) => (c ? countryLabel(c).replace(/ \([A-Z]{2}\)$/, "") : null)
    const revenue = b.homeRevenueUsd !== null ? (b.homeRevenueMaxUsd !== null ? `${usdShort(Number(b.homeRevenueUsd))}–${usdShort(Number(b.homeRevenueMaxUsd)).replace("USD ", "")}` : usdShort(Number(b.homeRevenueUsd))) : null
    const owner = b.owner?.name ?? null
    const values: MergeValues = {
      firstName: p?.firstName || null,
      lastName: p?.lastName || null,
      fullName: p ? `${p.firstName} ${p.lastName}`.trim() : null,
      jobTitle: p?.jobTitle || null,
      brandName: b.name,
      organisationName: b.organisation.legalEntity || b.organisation.name,
      category: label("category", b.categoryCode),
      subCategory: label("sub_category", b.subCategoryCode),
      lane: label("routing", b.routingCode),
      homeCountry: country(b.homeCountry),
      asianMarkets: b.asianMarketsLive.length ? joinAnd(b.asianMarketsLive.map((c) => country(c) ?? c)) : null,
      homeRevenue: revenue,
      revenueYear: b.revenueYear ? String(b.revenueYear) : null,
      touchOne: touch && typeof touch.value === "string" ? touch.value.trim() : null,
      senderFirstName: owner ? owner.split(/\s+/)[0] : null,
      senderName: owner,
      bookingLink: (await this.workTime.setting("booking.url", "")) || null,
    }
    return {
      brand: b,
      values,
      contact: p ? { id: p.id, name: `${p.firstName} ${p.lastName}`.trim(), email: p.email, why: contactWhy } : null,
      touchOne: touch ? "verified" : touchAny ? "not_verified" : "missing",
    }
  }

  private render(kind: TemplateKind, steps: Step[], openingFallback: string, values: MergeValues) {
    const missing = new Set<string>()
    let usedFallbackOpening = false
    let usesTouchOne = false
    const rendered = steps.map((s, i) => {
      const subject = fill(s.subject, values, openingFallback)
      const body = fill(s.body, values, openingFallback)
      for (const m of [...subject.missing, ...body.missing]) missing.add(m)
      if (subject.usedFallbackOpening || body.usedFallbackOpening) usedFallbackOpening = true
      if ([...subject.used, ...body.used].includes("touchOne")) usesTouchOne = true
      return { step: i + 1, name: kind === "booking" ? BOOKING_STEPS[i] : `Email ${i + 1}`, delayDays: s.delayDays, subject: subject.text, body: body.text }
    })
    return { steps: rendered, missing: [...missing], usedFallbackOpening, usesTouchOne }
  }

  /** What a brand gets: the template and version for each kind, the reason, and every email filled in. */
  async forBrand(brandId: string) {
    const v = await this.valuesFor(this.prisma, brandId)
    const reminderDays = await this.workTime.setting("booking.reminder_working_days", 3)
    const out = []
    for (const kind of ["sequence", "booking"] as TemplateKind[]) {
      const r = await this.resolve(this.prisma, v.brand, kind)
      if (!r.template || !r.version) {
        out.push({ kind, template: null, version: null, matchedBy: null, tried: r.tried, steps: [], warnings: [`No ${kind === "sequence" ? "outreach" : "booking"} template fits this brand. Tried: ${r.tried.join("; ") || "nothing (the brand has no category)"}. Set one in Settings → Template matrix.`] })
        continue
      }
      const rendered = this.render(kind, r.version.steps as Step[], r.version.openingFallback, v.values)
      const warnings: string[] = []
      if (!v.contact) warnings.push("The brand has no contact, so the contact's name and title are empty.")
      if (rendered.usesTouchOne && v.touchOne !== "verified")
        warnings.push(
          v.touchOne === "not_verified"
            ? `The touch-one observation isn't verified yet, so ${rendered.usedFallbackOpening ? "the back-up opening line is used" : "the first email has no opening line"}.`
            : `No touch-one observation, so ${rendered.usedFallbackOpening ? "the first email uses the back-up opening line (generic)" : "the first email has no opening line"}.`,
        )
      if (rendered.missing.length) warnings.push(`Empty: ${rendered.missing.join(", ")}. These show as ⟦…⟧ below; fill them on the brand, or give the field a fallback in the template ({{field|text}}).`)
      if (r.matchedBy !== MATCH_ORDER[0].label && r.tried.length) warnings.push(`Nothing set for ${r.tried[0]}, so the template for ${r.matchedBy} is used.`)
      out.push({
        kind,
        template: { id: r.template.id, name: r.template.name },
        version: r.version.version,
        matchedBy: r.matchedBy,
        tried: r.tried,
        steps: rendered.steps.map((s, i) => ({ ...s, delayDays: kind === "booking" && i === 1 ? reminderDays : s.delayDays, delayUnit: kind === "booking" ? "working days" : "days" })),
        warnings,
      })
    }
    return { contact: v.contact, touchOne: v.touchOne, results: out }
  }

  /** Fills unsaved wording with a brand's values: the editor's preview. */
  async preview(kind: TemplateKind, dto: TemplateWordingDto & { brandId: string }) {
    const v = await this.valuesFor(this.prisma, dto.brandId)
    const steps = dto.steps.map((s) => ({ subject: s.subject ?? "", body: s.body ?? "", delayDays: s.delayDays ?? 0 }))
    const r = this.render(kind, steps, (dto.openingFallback ?? "").trim(), v.values)
    const problems = steps.flatMap((s, i) => [...checkText(s.subject), ...checkText(s.body)].map((p) => `${kind === "booking" ? BOOKING_STEPS[i] : `Email ${i + 1}`}: ${p}`))
    return { contact: v.contact, touchOne: v.touchOne, steps: r.steps, missing: r.missing, usedFallbackOpening: r.usedFallbackOpening, problems }
  }
}
