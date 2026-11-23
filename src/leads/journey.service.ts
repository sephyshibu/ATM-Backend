import { randomUUID } from "node:crypto"

import { Injectable } from "@nestjs/common"
import type { Lead, LeadMove, Prisma } from "@prisma/client"

import { AuditService } from "../audit/audit.service"
import { badRequest, conflict, forbidden, notFound } from "../common/errors"
import { actorLabel, type RequestUser } from "../common/request-user"
import { PrismaService } from "../prisma/prisma.service"
import { EVENTS, FLAG_LABELS, isClosed, LANE_LABELS, LANES, moveLabel, MOVES, type Lane, type MoveDef, type Pos, posLabel, STAGE_LABELS, STAGES, type Stage } from "./journey"
import type { EventDto, MoveDto, OpenLeadDto, OverrideDto, UndoDto } from "./leads.dto"

// The journey engine: the only code that changes a lead's stage, lane or flags. Every change is checked against
// the journey (journey.ts), written as a lead_move row with who or what made it and why, and logged. Moves can be
// undone (newest first) by people with "Undo automatic moves"; anything else can be forced with "Override".

const SECTION = "Leads"
type Db = Prisma.TransactionClient

const brandSelect = { id: true, name: true, domain: true, archivedAt: true, routingCode: true, tierCode: true, organisation: { select: { id: true, name: true, excluded: true } } } as const

const pos = (l: Pick<Lead, "stage" | "lane">): Pos => ({ stage: l.stage as Stage, lane: (l.lane as Lane | null) ?? null })
const dateOnly = (s: string | undefined | null) => {
  if (!s) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) throw badRequest("Use a date like 2026-03-31.")
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  if (Number.isNaN(d.getTime())) throw badRequest("That date doesn't exist.")
  return d
}
const showDate = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null)

@Injectable()
export class JourneyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- Reading

  /** Every lead with its brand, main contact and last move: the Leads screen filters on the page. */
  async list() {
    const leads = await this.prisma.lead.findMany({
      orderBy: { stageChangedAt: "desc" },
      include: { brand: { select: brandSelect }, moves: { orderBy: { at: "desc" }, take: 1 } },
    })
    const people = await this.prisma.person.findMany({ where: { id: { in: leads.map((l) => l.personId).filter((x): x is string => !!x) } }, select: { id: true, firstName: true, lastName: true, email: true, emailStatus: true } })
    return leads.map(({ moves, ...l }) => ({ ...this.view(l), person: people.find((p) => p.id === l.personId) ?? null, lastMove: moves[0] ? this.moveView(moves[0]) : null }))
  }

  /** A brand's leads, newest first, each with its moves and the moves this person can make now. */
  async forBrand(brandId: string, me: RequestUser) {
    const leads = await this.prisma.lead.findMany({ where: { brandId }, orderBy: { createdAt: "desc" }, include: { moves: { orderBy: { at: "desc" } } } })
    return Promise.all(leads.map((l) => this.detail(l, me)))
  }

  async get(id: string, me: RequestUser) {
    const l = await this.prisma.lead.findUnique({ where: { id }, include: { moves: { orderBy: { at: "desc" } } } })
    if (!l) throw notFound("That lead")
    return this.detail(l, me)
  }

  private async detail(l: Lead & { moves: LeadMove[] }, me: RequestUser) {
    const p = pos(l)
    const person = l.personId ? await this.prisma.person.findUnique({ where: { id: l.personId }, select: { id: true, firstName: true, lastName: true, email: true, emailStatus: true, linkedinUrl: true, buyingRoleCode: true } }) : null
    const lastUndoable = l.moves.find((m) => !m.undoneAt && m.kind !== "undo")
    const moves = MOVES.filter((m) => m.from(p))
    const targetCheck = moves.some((m) => m.check === "target_ready") ? await this.targetReady(this.prisma, l) : null
    return {
      ...this.view(l),
      person,
      moves: l.moves.map((m) => this.moveView(m)),
      available: moves.map((m) => ({
        key: m.key,
        label: m.label,
        help: m.help,
        allowed: me.permissions.has(m.permission),
        reasonList: m.reasonList ?? null,
        reasonRequired: !!m.reasonRequired,
        untilRequired: !!m.untilRequired,
        ends: !!m.ends,
        to: posLabel(m.to(p)),
        blockers: m.check === "target_ready" ? (targetCheck?.blockers ?? []) : [],
        warnings: m.check === "target_ready" ? (targetCheck?.warnings ?? []) : [],
      })),
      events: EVENTS.filter((e) => e.from(p)).map((e) => ({ type: e.type, label: e.label, to: posLabel(e.to(p)) })),
      canUndo: !!lastUndoable && lastUndoable.fromStage !== null && me.permissions.has("control.undo"),
      undoLabel: lastUndoable && lastUndoable.fromStage ? `Back to ${posLabel({ stage: lastUndoable.fromStage, lane: lastUndoable.fromLane })}` : null,
    }
  }

  private view(l: Lead) {
    return { ...l, laneUntil: showDate(l.laneUntil), closed: isClosed(l), position: posLabel(l), flagLabels: l.flags.map((f) => FLAG_LABELS[f] ?? f) }
  }

  private moveView(m: LeadMove) {
    return {
      ...m,
      fromUntil: showDate(m.fromUntil),
      toUntil: showDate(m.toUntil),
      from: m.fromStage ? posLabel({ stage: m.fromStage, lane: m.fromLane }) : null,
      to: posLabel({ stage: m.toStage, lane: m.toLane }),
      label: moveLabel(m.moveKey),
    }
  }

  // ---------------------------------------------------------------- Checks

  /**
   * Before Target (SRS MKT-03): lane and tier set, the organisation not excluded, and a main contact with a
   * verified email and a LinkedIn profile. No signer named is a warning: it is flagged at the call, not blocked.
   */
  private async targetReady(db: Db, l: Pick<Lead, "brandId" | "personId">) {
    const blockers: string[] = []
    const warnings: string[] = []
    const b = await db.brand.findUnique({
      where: { id: l.brandId },
      select: { ...brandSelect, people: { where: { removedAt: null, person: { archivedAt: null } }, select: { isPrimary: true, person: { select: { id: true, firstName: true, lastName: true, email: true, emailStatus: true, linkedinUrl: true, buyingRoleCode: true } } } } },
    })
    if (!b) return { blockers: ["The brand wasn't found."], warnings }
    if (b.archivedAt) blockers.push("The brand is archived.")
    if (b.organisation.excluded) blockers.push(`${b.organisation.name} is excluded: don't approach it.`)
    if (!b.routingCode) blockers.push("Set the brand's lane.")
    if (!b.tierCode) blockers.push("Set the brand's tier.")
    const contact = b.people.find((x) => x.person.id === l.personId)?.person ?? b.people.find((x) => x.isPrimary)?.person
    if (!contact) blockers.push("Link a main contact to the brand.")
    else {
      const name = `${contact.firstName} ${contact.lastName}`.trim()
      if (!contact.email) blockers.push(`Add ${name}'s email.`)
      else if (contact.emailStatus !== "verified") blockers.push(`Verify ${name}'s email (${contact.email}).`)
      if (!contact.linkedinUrl) blockers.push(`Add ${name}'s LinkedIn profile.`)
    }
    if (!b.people.some((x) => x.person.buyingRoleCode === "SIGNER")) warnings.push("No signer is named yet. It will be flagged when a call is booked.")
    return { blockers, warnings }
  }

  private async hasSigner(db: Db, brandId: string) {
    return (await db.brandPerson.count({ where: { brandId, removedAt: null, person: { archivedAt: null, buyingRoleCode: "SIGNER" } } })) > 0
  }

  /** Locks the lead row for this transaction, so two moves can't race. */
  private async lock(db: Db, id: string) {
    await db.$queryRaw`SELECT id FROM "lead" WHERE id = ${id}::uuid FOR UPDATE`
    const l = await db.lead.findUnique({ where: { id }, include: { brand: { select: { name: true } } } })
    if (!l) throw notFound("That lead")
    return l
  }

  // ---------------------------------------------------------------- Changing

  /** Writes the new position and its move row, and logs it. */
  private async apply(
    db: Db,
    l: Lead & { brand: { name: string } },
    to: Pos,
    flags: string[],
    until: Date | null,
    move: { moveKey: string; kind: "person" | "system" | "override" | "undo"; reasonCode?: string | null; reason?: string | null; eventKey?: string | null; actorId: string | null; actorLabel: string; undoOfId?: string; by: RequestUser | null },
    ip: string | null,
  ) {
    const stageChanged = to.stage !== l.stage
    const toUntil = to.lane ? until : null
    const closed = isClosed(to)
    await db.lead.update({
      where: { id: l.id },
      data: { stage: to.stage, lane: to.lane, laneUntil: toUntil, flags, ...(stageChanged || to.lane !== l.lane ? { stageChangedAt: new Date() } : {}), closedAt: closed ? (l.closedAt ?? new Date()) : null },
    })
    const row = await db.leadMove.create({
      data: {
        leadId: l.id,
        moveKey: move.moveKey,
        kind: move.kind,
        fromStage: l.stage,
        fromLane: l.lane,
        fromUntil: l.laneUntil,
        fromFlags: l.flags,
        toStage: to.stage,
        toLane: to.lane,
        toUntil,
        toFlags: flags,
        reasonCode: move.reasonCode ?? null,
        reason: move.reason ?? null,
        eventKey: move.eventKey ?? null,
        actorId: move.actorId,
        actorLabel: move.actorLabel,
        undoOfId: move.undoOfId ?? null,
      },
    })
    const before = [posLabel(l), showDate(l.laneUntil) && `Until ${showDate(l.laneUntil)}`, l.flags.length ? `Flags: ${l.flags.join(", ")}` : ""].filter(Boolean).join("\n")
    const after = [posLabel(to), toUntil && `Until ${showDate(toUntil)}`, flags.length ? `Flags: ${flags.join(", ")}` : ""].filter(Boolean).join("\n")
    await this.audit.record(
      {
        actor: move.by ?? { label: move.actorLabel },
        section: SECTION,
        action: `${l.brand.name}: ${move.kind === "undo" ? "undid the last move" : moveLabel(move.moveKey)}`,
        entityType: "lead",
        entityId: l.id,
        before,
        after,
        reason: [move.reasonCode, move.reason].filter(Boolean).join(": ") || null,
        ip,
      },
      db,
    )
    return row
  }

  /** A new journey for a brand, at Register. A brand has one open lead at a time. */
  async openIn(db: Db, brandId: string, opts: { personId?: string | null; source?: string; importBatchId?: string | null }, me: RequestUser, ip: string | null) {
    const b = await db.brand.findUnique({ where: { id: brandId }, select: { ...brandSelect, people: { where: { removedAt: null, isPrimary: true }, select: { personId: true } } } })
    if (!b) throw notFound("That brand")
    if (b.archivedAt) throw badRequest(`${b.name} is archived.`)
    if (b.organisation.excluded) throw badRequest(`${b.organisation.name} is excluded, so no lead can be opened for ${b.name}.`)
    const open = await db.lead.findFirst({ where: { brandId, closedAt: null } })
    if (open) throw conflict(`${b.name} already has an open lead at ${posLabel(open)}.`)
    let personId = opts.personId ?? b.people[0]?.personId ?? null
    if (opts.personId) {
      const link = await db.brandPerson.findFirst({ where: { brandId, personId: opts.personId, removedAt: null } })
      if (!link) throw badRequest("The main contact must be one of the brand's people.")
      personId = opts.personId
    }
    const lead = await db.lead.create({ data: { brandId, personId, source: opts.source ?? "outbound", stage: "register", importBatchId: opts.importBatchId ?? null, createdById: me.id } })
    await db.leadMove.create({ data: { leadId: lead.id, moveKey: "open", kind: "person", toStage: "register", actorId: me.id, actorLabel: actorLabel(me) } })
    await this.audit.record({ actor: me, section: SECTION, action: `${b.name}: lead opened at Register`, entityType: "lead", entityId: lead.id, after: `Source: ${lead.source}`, ip }, db)
    return lead
  }

  async open(brandId: string, dto: OpenLeadDto, me: RequestUser, ip: string | null) {
    const lead = await this.prisma.$transaction((tx) => this.openIn(tx, brandId, dto, me, ip))
    return this.get(lead.id, me)
  }

  /** Opens a Register lead for every active brand that never had one (brands added before leads existed). */
  async openMissing(me: RequestUser, ip: string | null) {
    const brands = await this.prisma.brand.findMany({ where: { archivedAt: null, leads: { none: {} }, organisation: { excluded: false, archivedAt: null } }, select: { id: true } })
    let opened = 0
    for (const b of brands) {
      await this.prisma.$transaction((tx) => this.openIn(tx, b.id, {}, me, ip))
      opened++
    }
    return { opened }
  }

  /** A person's move: checked against the journey, their permission, the required reason or date, and any check. */
  async move(id: string, dto: MoveDto, me: RequestUser, ip: string | null) {
    await this.prisma.$transaction((tx) => this.moveIn(tx, id, dto, me, ip))
    return this.get(id, me)
  }

  private async moveIn(db: Db, id: string, dto: MoveDto, me: RequestUser, ip: string | null) {
    const def: MoveDef | undefined = MOVES.find((m) => m.key === dto.moveKey)
    if (!def) throw badRequest(`There's no move called ${dto.moveKey}.`)
    if (!me.permissions.has(def.permission)) throw forbidden(`Your roles don't allow "${def.label}".`)
    const l = await this.lock(db, id)
    const from = pos(l)
    if (!def.from(from)) throw conflict(`${l.brand.name} is at ${posLabel(from)}, so "${def.label}" isn't possible. Reload to see where it is now.`)
    let reasonCode: string | null = null
    if (def.reasonList) {
      if (!dto.reasonCode) throw badRequest("Pick a reason.")
      const v = await db.listValue.findUnique({ where: { listKey_code: { listKey: def.reasonList, code: dto.reasonCode } } })
      if (!v || v.retiredAt) throw badRequest("Pick a reason from the list.")
      reasonCode = v.label
    }
    const reason = dto.reason?.trim() || null
    if (def.reasonRequired && !reason) throw badRequest("Say why.")
    const until = dateOnly(dto.until)
    if (def.untilRequired && !until) throw badRequest("Pick the date.")
    if (until && until.getTime() < Date.now() - 86_400_000) throw badRequest("The date is in the past.")
    if (def.check === "target_ready") {
      const r = await this.targetReady(db, l)
      if (r.blockers.length) throw badRequest(`${l.brand.name} isn't ready for Target: ${r.blockers.join(" ")}`)
    }
    const flags = [...new Set([...l.flags.filter((f) => !(def.clear ?? []).includes(f)), ...(def.set ?? [])])]
    await this.apply(db, l, def.to(from), flags, until, { moveKey: def.key, kind: "person", reasonCode, reason, actorId: me.id, actorLabel: actorLabel(me), by: me }, ip)
  }

  /** The same move for many leads; each lead succeeds or fails on its own, with the reason. */
  async bulkMove(ids: string[], dto: MoveDto, me: RequestUser, ip: string | null) {
    const results: { id: string; ok: boolean; message: string }[] = []
    for (const id of [...new Set(ids)]) {
      try {
        await this.prisma.$transaction((tx) => this.moveIn(tx, id, dto, me, ip))
        results.push({ id, ok: true, message: "" })
      } catch (e) {
        results.push({ id, ok: false, message: e instanceof Error ? e.message : String(e) })
      }
    }
    return { moved: results.filter((r) => r.ok).length, refused: results.filter((r) => !r.ok).length, results }
  }

  /**
   * A buyer event (delivered, reply, booking…). Each event is applied once, keyed by its id. Outreach and bookings
   * will send these; until then people with "Override" can record one by hand to test the journey.
   */
  async event(id: string, dto: EventDto, actor: RequestUser | null, ip: string | null) {
    const def = EVENTS.find((e) => e.type === dto.type)
    if (!def) throw badRequest(`There's no event called ${dto.type}.`)
    const eventKey = dto.eventKey?.trim() || `manual:${randomUUID()}`
    const result = await this.prisma.$transaction(async (tx) => {
      if (await tx.leadMove.findUnique({ where: { eventKey } })) return { ignored: true }
      const l = await this.lock(tx, id)
      const from = pos(l)
      if (!def.from(from)) throw conflict(`"${def.label}" doesn't apply to a lead at ${posLabel(from)}.`)
      let flags = [...new Set([...l.flags.filter((f) => !(def.clear ?? []).includes(f)), ...(def.set ?? [])])]
      if (def.signerCheck && !(await this.hasSigner(tx, l.brandId))) flags = [...new Set([...flags, "no_signer"])]
      const label = actor ? `System (recorded by ${actor.name})` : "System"
      await this.apply(tx, l, def.to(from), flags, l.laneUntil, { moveKey: `event.${def.type}`, kind: "system", reason: dto.note?.trim() || null, eventKey, actorId: null, actorLabel: label, by: actor }, ip)
      return { ignored: false }
    })
    return actor ? { ...result, lead: await this.get(id, actor) } : result
  }

  /** Puts a lead anywhere, outside the journey's moves. Needs "Override" and a reason; flagged on the lead. */
  async override(id: string, dto: OverrideDto, me: RequestUser, ip: string | null) {
    if (!(STAGES as readonly string[]).includes(dto.stage)) throw badRequest("Pick a stage.")
    if (dto.lane && !(LANES as readonly string[]).includes(dto.lane)) throw badRequest("Pick a side lane, or none.")
    const reason = dto.reason?.trim()
    if (!reason) throw badRequest("Say why you're overriding.")
    const until = dateOnly(dto.until)
    await this.prisma.$transaction(async (tx) => {
      const l = await this.lock(tx, id)
      const to: Pos = { stage: dto.stage as Stage, lane: (dto.lane as Lane) || null }
      if (to.stage === l.stage && to.lane === l.lane) throw badRequest(`It's already at ${posLabel(to)}.`)
      if (isClosed(l) && !isClosed(to)) {
        const other = await tx.lead.findFirst({ where: { brandId: l.brandId, closedAt: null, id: { not: l.id } } })
        if (other) throw conflict(`${l.brand.name} already has another open lead at ${posLabel(other)}.`)
      }
      await this.apply(tx, l, to, [...new Set([...l.flags, "override"])], until, { moveKey: "override", kind: "override", reason, actorId: me.id, actorLabel: actorLabel(me), by: me }, ip)
    })
    return this.get(id, me)
  }

  /** Undoes the newest move that isn't undone yet: the lead goes back exactly where it was before it. */
  async undo(id: string, dto: UndoDto, me: RequestUser, ip: string | null) {
    const reason = dto.reason?.trim()
    if (!reason) throw badRequest("Say why you're undoing it.")
    await this.prisma.$transaction(async (tx) => {
      const l = await this.lock(tx, id)
      const last = await tx.leadMove.findFirst({ where: { leadId: id, undoneAt: null, kind: { not: "undo" } }, orderBy: { at: "desc" } })
      if (!last) throw badRequest("There's nothing to undo.")
      if (!last.fromStage) throw badRequest("Opening a lead can't be undone. Mark it Not pursued instead.")
      if (last.toStage !== l.stage || last.toLane !== l.lane) throw conflict("The lead moved since; reload and try again.")
      const back: Pos = { stage: last.fromStage as Stage, lane: (last.fromLane as Lane | null) ?? null }
      if (isClosed(l) && !isClosed(back)) {
        const other = await tx.lead.findFirst({ where: { brandId: l.brandId, closedAt: null, id: { not: l.id } } })
        if (other) throw conflict(`${l.brand.name} already has another open lead at ${posLabel(other)}.`)
      }
      await tx.leadMove.update({ where: { id: last.id }, data: { undoneAt: new Date(), undoneById: me.id } })
      await this.apply(tx, l, back, last.fromFlags, last.fromUntil, { moveKey: "undo", kind: "undo", reason, actorId: me.id, actorLabel: actorLabel(me), undoOfId: last.id, by: me }, ip)
    })
    return this.get(id, me)
  }

  /** Changes the lead's main contact (one of the brand's people). */
  async setPerson(id: string, personId: string | null, me: RequestUser, ip: string | null) {
    await this.prisma.$transaction(async (tx) => {
      const l = await this.lock(tx, id)
      if (personId) {
        const link = await tx.brandPerson.findFirst({ where: { brandId: l.brandId, personId, removedAt: null }, include: { person: true } })
        if (!link) throw badRequest("The main contact must be one of the brand's people.")
      }
      if (l.personId === personId) return
      const names = await tx.person.findMany({ where: { id: { in: [l.personId, personId].filter((x): x is string => !!x) } }, select: { id: true, firstName: true, lastName: true } })
      const nameOf = (pid: string | null) => {
        const p = names.find((n) => n.id === pid)
        return p ? `${p.firstName} ${p.lastName}`.trim() : "—"
      }
      await tx.lead.update({ where: { id }, data: { personId } })
      await this.audit.record({ actor: me, section: SECTION, action: `${l.brand.name}: changed the lead's main contact`, entityType: "lead", entityId: id, before: nameOf(l.personId), after: nameOf(personId), ip }, tx)
    })
    return this.get(id, me)
  }

  // ---------------------------------------------------------------- Date rules (the daily lane check)

  /**
   * Applies the date rules for `today` (a local date in the company time zone): Nurture, Parked and On hold come
   * back on their date; Watch moves to Nurture after `watchDays`; Rested is flagged after `restMonths`. Each rule
   * applies once per lead per day (keyed), so running it twice changes nothing. Returns a one-line summary.
   */
  async runTimers(today: string, watchDays: number, restMonths: number) {
    const day = new Date(`${today}T00:00:00Z`)
    const watchCutoff = new Date(day.getTime() - watchDays * 86_400_000)
    const restCutoff = new Date(day)
    restCutoff.setUTCMonth(restCutoff.getUTCMonth() - restMonths)
    const due = await this.prisma.lead.findMany({
      where: {
        closedAt: null,
        OR: [
          { lane: { in: ["nurture", "parked", "on_hold"] }, laneUntil: { lte: day } },
          { lane: "watch", stageChangedAt: { lte: watchCutoff } },
          { lane: "rested", stageChangedAt: { lte: restCutoff }, NOT: { flags: { has: "eligible_again" } } },
        ],
      },
      select: { id: true, lane: true },
    })
    const counts: Record<string, number> = {}
    const errors: string[] = []
    for (const d of due) {
      const rule = d.lane === "nurture" ? "nurture_due" : d.lane === "parked" ? "parked_due" : d.lane === "on_hold" ? "hold_due" : d.lane === "watch" ? "watch_due" : "rest_over"
      try {
        const moved = await this.prisma.$transaction((tx) => this.timerIn(tx, d.id, rule, today))
        if (moved) counts[rule] = (counts[rule] ?? 0) + 1
      } catch (e) {
        errors.push(`${d.id}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }
    if (errors.length) throw new Error(`${errors.length} of ${due.length} leads failed: ${errors.slice(0, 3).join("; ")}`)
    const parts = Object.entries(counts).map(([k, n]) => `${n} × ${moveLabel(`timer.${k}`)}`)
    return parts.length ? parts.join("; ") : "Nothing due today."
  }

  private async timerIn(db: Db, id: string, rule: string, today: string) {
    const eventKey = `timer:${rule}:${id}:${today}`
    if (await db.leadMove.findUnique({ where: { eventKey } })) return false
    const l = await this.lock(db, id)
    const from = pos(l)
    let to: Pos = from
    let flags = l.flags
    if (rule === "nurture_due" && from.lane === "nurture") to = { ...from, lane: null }
    else if (rule === "parked_due" && from.lane === "parked") to = { stage: "register", lane: null }
    else if (rule === "hold_due" && from.lane === "on_hold") to = { ...from, lane: null }
    else if (rule === "watch_due" && from.lane === "watch") to = { ...from, lane: "nurture" }
    else if (rule === "rest_over" && from.lane === "rested" && !l.flags.includes("eligible_again")) flags = [...l.flags, "eligible_again"]
    else return false
    if (to.lane !== "rested") flags = flags.filter((f) => f !== "eligible_again")
    await this.apply(db, l, to, flags, null, { moveKey: `timer.${rule}`, kind: "system", eventKey, actorId: null, actorLabel: "System (daily lane check)", by: null }, null)
    return true
  }

  /** The journey for the screens: stages, lanes and labels. */
  journey() {
    return {
      stages: STAGES.map((s) => ({ key: s, label: STAGE_LABELS[s] })),
      lanes: LANES.map((l) => ({ key: l, label: LANE_LABELS[l] })),
      events: EVENTS.map((e) => ({ type: e.type, label: e.label })),
      flags: FLAG_LABELS,
    }
  }
}
