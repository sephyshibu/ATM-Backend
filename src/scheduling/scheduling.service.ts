import { randomBytes } from "node:crypto"

import { Injectable, Logger } from "@nestjs/common"
import type { Booking, EventType, Prisma } from "@prisma/client"

import { AuditService } from "../audit/audit.service"
import { badRequest, conflict, notFound } from "../common/errors"
import type { RequestUser } from "../common/request-user"
import { appConfig } from "../config"
import { localDate, zonedToUtc } from "../jobs/clock"
import { MailService } from "../mail/mail.service"
import { PrismaService } from "../prisma/prisma.service"
import { calendarKeyConfigured, decryptSecret, encryptSecret, signState, verifyState } from "./crypto"
import * as google from "./google-calendar"
import type { BookDto, EventTypeDto, QuestionDto } from "./scheduling.dto"
import { computeSlots } from "./slots"

// Booking pages (Calendly-style), as in the Bizinnox CRM:
//   - Each person can connect their own Google Calendar (only the Google account they sign in with). Its busy times
//     are taken out of their booking pages, and each booking becomes an event on it with a Google Meet link; Google
//     emails the invite, so it lands in the booker's calendar too.
//   - Event types: a public link (/book/<name>) that offers times for the next N days (20 by default) from weekly
//     hours, minus existing bookings and calendar busy times, with buffers, a minimum notice and a daily cap.
//   - The booking form is set per event type (text, phone, email, link, number, yes/no, choice), and its answers are
//     stored with the booking. A booker is matched to a person (and their brand) in the CRM by email.
//   - The booker gets a confirmation email with the meeting link, an "add to calendar" link and a link to
//     reschedule or cancel; the host gets an email too. Nothing is deleted: cancelled bookings and archived pages stay.

const SECTION = "Booking pages"
type Db = Prisma.TransactionClient | PrismaService
type Question = { id: string; label: string; type: string; required: boolean; options?: string[]; help?: string }
type Window = { weekday: number; startMinute: number; endMinute: number }
type EventTypeFull = EventType & { availability: Window[] }

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const strip = (v: unknown, max = 2000) =>
  String(v ?? "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/<\/?[a-zA-Z][^>]*>/g, "")
    .trim()
    .slice(0, max)
const validZone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz })
    return true
  } catch {
    return false
  }
}
const isUrl = (v: string) => {
  try {
    const u = new URL(v)
    return u.protocol === "https:" || u.protocol === "http:"
  } catch {
    return false
  }
}
/** International phone numbers: 7 to 15 digits, with an optional + and spaces, dashes, dots or brackets. */
const isPhone = (v: string) => /^\+?[\d\s\-().]{7,25}$/.test(v) && v.replace(/\D/g, "").length >= 7 && v.replace(/\D/g, "").length <= 15
const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
const whenText = (at: Date, tz: string) => `${at.toLocaleString("en-GB", { timeZone: tz, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true })} (${tz})`
const gcalDate = (d: Date) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "")

export const DEFAULT_QUESTIONS: Question[] = [
  { id: "company", label: "Company", type: "text", required: true },
  { id: "phone", label: "Phone", type: "phone", required: false },
  { id: "notes", label: "What would you like to discuss?", type: "textarea", required: false },
]

@Injectable()
export class SchedulingService {
  private readonly log = new Logger("Scheduling")

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  // ================================================================ Calendar connection

  async connection(me: RequestUser) {
    const c = await this.prisma.calendarConnection.findFirst({ where: { userId: me.id, provider: "GOOGLE", removedAt: null } })
    const oauth = google.calendarOAuth()
    return {
      configured: !!oauth && calendarKeyConfigured(),
      missing: [!oauth && "GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET", !calendarKeyConfigured() && "CALENDAR_ENC_KEY"].filter(Boolean),
      callbackUrl: appConfig().calendar.callbackUrl,
      connected: c ? { email: c.email, since: c.createdAt } : null,
    }
  }

  connectUrl(me: RequestUser) {
    if (!google.calendarOAuth() || !calendarKeyConfigured()) throw badRequest("Google Calendar isn't set up on the server yet: add CALENDAR_ENC_KEY (and the Google client) to the backend .env and restart it.")
    return { url: google.authorizeUrl(signState(me.id), me.email) }
  }

  /** Google's redirect. Trusts the signed state, not a session. Returns where to send the browser. */
  async callback(code: string | undefined, state: string | undefined, error: string | undefined) {
    const back = (status: "connected" | "error", reason?: string) => `${appConfig().frontendUrl}/meetings?calendar=${status}${reason ? `&reason=${encodeURIComponent(reason)}` : ""}`
    if (error) return back("error", error === "access_denied" ? "You cancelled on Google's page." : error)
    if (!calendarKeyConfigured() || !google.calendarOAuth()) return back("error", "Google Calendar isn't set up on the server.")
    const userId = verifyState(state ?? "")
    if (!userId || !code) return back("error", "The connect link expired. Try again.")
    try {
      const user = await this.prisma.user.findUnique({ where: { id: userId } })
      if (!user || user.status !== "active") return back("error", "Your account isn't active.")
      const tokens = await google.exchangeCode(code)
      if (!tokens.refreshToken) return back("error", "Google didn't give calendar access. Try again and allow every permission.")
      // Only the Google account you sign in with: bookings always land on your own calendar.
      if ((tokens.email ?? "").toLowerCase() !== user.email.toLowerCase()) {
        await google.revoke(tokens.refreshToken)
        return back("error", `Connect the Google account you sign in with (${user.email}), not ${tokens.email ?? "another one"}.`)
      }
      await this.prisma.$transaction(async (tx) => {
        await tx.calendarConnection.updateMany({ where: { userId, provider: "GOOGLE", removedAt: null }, data: { removedAt: new Date(), refreshToken: "" } })
        await tx.calendarConnection.create({ data: { userId, provider: "GOOGLE", email: tokens.email ?? null, refreshToken: encryptSecret(tokens.refreshToken!), scopes: tokens.scope ?? null } })
        await this.audit.record({ actor: { id: user.id, name: user.name, email: user.email }, section: SECTION, action: `Connected Google Calendar (${tokens.email})`, entityType: "user", entityId: user.id }, tx)
      })
      return back("connected")
    } catch (e) {
      this.log.warn(`Calendar connect failed: ${e instanceof Error ? e.message : String(e)}`)
      return back("error", "Google refused the connection. Try again.")
    }
  }

  async disconnect(me: RequestUser, ip: string | null) {
    const c = await this.prisma.calendarConnection.findFirst({ where: { userId: me.id, provider: "GOOGLE", removedAt: null } })
    if (!c) return this.connection(me)
    try {
      await google.revoke(decryptSecret(c.refreshToken))
    } catch {
      /* best-effort */
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.calendarConnection.update({ where: { id: c.id }, data: { removedAt: new Date(), refreshToken: "" } })
      await this.audit.record({ actor: me, section: SECTION, action: `Disconnected Google Calendar (${c.email})`, entityType: "user", entityId: me.id, ip }, tx)
    })
    return this.connection(me)
  }

  /** A short-lived Google access token for a host, or null when not connected (or it fails). */
  private async hostToken(hostUserId: string) {
    if (!calendarKeyConfigured()) return null
    const c = await this.prisma.calendarConnection.findFirst({ where: { userId: hostUserId, provider: "GOOGLE", removedAt: null } })
    if (!c) return null
    try {
      return await google.accessToken(decryptSecret(c.refreshToken))
    } catch {
      return null
    }
  }

  // ================================================================ Event types (the host's booking pages)

  private cleanQuestions(input: QuestionDto[]): Question[] {
    const out: Question[] = []
    const seen = new Set(["name", "email"])
    for (const q of input) {
      const label = strip(q.label, 200)
      if (!label) continue
      let id = (strip(q.id, 60) || label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "q").slice(0, 60)
      if (seen.has(id)) id = `${id}_${out.length + 1}`
      seen.add(id)
      const item: Question = { id, label, type: q.type, required: !!q.required }
      if (q.help) item.help = strip(q.help, 300)
      if (q.type === "select") {
        const opts = [...new Map((q.options ?? []).map((o) => strip(o, 200)).filter(Boolean).map((o) => [o.toLowerCase(), o])).values()].slice(0, 25)
        if (!opts.length) throw badRequest(`"${label}" is a choice question: add at least one option.`)
        item.options = opts
      }
      out.push(item)
    }
    return out
  }

  private cleanWindows(input: Window[]) {
    const rows = input.filter((w) => w.startMinute < w.endMinute)
    if (!rows.length) throw badRequest("Set at least one day with available hours.")
    return rows
  }

  private async uniqueSlug(db: Db, name: string, exceptId?: string) {
    const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "meeting"
    let slug = base
    for (let n = 2; await db.eventType.findFirst({ where: { slug, ...(exceptId ? { id: { not: exceptId } } : {}) } }); n++) slug = `${base}-${n}`
    return slug
  }

  private check(dto: EventTypeDto) {
    if (!validZone(dto.timezone)) throw badRequest(`${dto.timezone} isn't a time zone. Use a name like Asia/Kolkata.`)
    if (dto.conferencing === "CUSTOM_LINK" && !(dto.customLink && isUrl(dto.customLink))) throw badRequest("Add the meeting link (starting with https://), or pick Google Meet.")
    if (dto.durationMins % 5) throw badRequest("Meeting length must be in steps of 5 minutes.")
  }

  private view(et: EventTypeFull & { _count?: { bookings: number } }) {
    return {
      id: et.id,
      name: et.name,
      description: et.description,
      slug: et.slug,
      link: `${appConfig().frontendUrl}/book/${et.slug}`,
      durationMins: et.durationMins,
      conferencing: et.conferencing,
      customLink: et.customLink,
      bufferBeforeMins: et.bufferBeforeMins,
      bufferAfterMins: et.bufferAfterMins,
      minNoticeMins: et.minNoticeMins,
      dateRangeDays: et.dateRangeDays,
      slotIncrementMins: et.slotIncrementMins,
      maxPerDay: et.maxPerDay,
      timezone: et.timezone,
      questions: et.questions as Question[],
      availability: et.availability.map((w) => ({ weekday: w.weekday, startMinute: w.startMinute, endMinute: w.endMinute })).sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute),
      active: et.active,
      archived: !!et.archivedAt,
      upcoming: et._count?.bookings ?? 0,
      updatedAt: et.updatedAt,
    }
  }

  async eventTypes(me: RequestUser) {
    const rows = await this.prisma.eventType.findMany({
      where: { hostUserId: me.id },
      orderBy: [{ archivedAt: { sort: "asc", nulls: "first" } }, { createdAt: "asc" }],
      include: { availability: true, _count: { select: { bookings: { where: { status: "confirmed", startsAt: { gte: new Date() } } } } } },
    })
    return rows.map((r) => this.view(r))
  }

  private async own(db: Db, id: string, me: RequestUser) {
    const et = await db.eventType.findUnique({ where: { id }, include: { availability: true } })
    if (!et || et.hostUserId !== me.id) throw notFound("That booking page")
    return et
  }

  async createEventType(dto: EventTypeDto, me: RequestUser, ip: string | null) {
    this.check(dto)
    const questions = this.cleanQuestions(dto.questions)
    const windows = this.cleanWindows(dto.availability)
    return this.prisma.$transaction(async (tx) => {
      const et = await tx.eventType.create({
        data: {
          hostUserId: me.id,
          token: randomBytes(12).toString("hex"),
          slug: await this.uniqueSlug(tx, dto.name),
          name: dto.name,
          description: dto.description ?? "",
          durationMins: dto.durationMins,
          conferencing: dto.conferencing,
          customLink: dto.conferencing === "CUSTOM_LINK" ? dto.customLink! : null,
          bufferBeforeMins: dto.bufferBeforeMins,
          bufferAfterMins: dto.bufferAfterMins,
          minNoticeMins: dto.minNoticeMins,
          dateRangeDays: dto.dateRangeDays,
          slotIncrementMins: dto.slotIncrementMins,
          maxPerDay: dto.maxPerDay ?? null,
          timezone: dto.timezone,
          questions: questions as unknown as Prisma.InputJsonValue,
          active: dto.active ?? true,
          availability: { create: windows },
        },
        include: { availability: true },
      })
      await this.audit.record({ actor: me, section: SECTION, action: `Added the booking page ${et.name}`, entityType: "event_type", entityId: et.id, after: `/book/${et.slug} · ${et.durationMins} min · next ${et.dateRangeDays} days`, ip }, tx)
      return this.view(et)
    })
  }

  async updateEventType(id: string, dto: EventTypeDto, me: RequestUser, ip: string | null) {
    this.check(dto)
    const questions = this.cleanQuestions(dto.questions)
    const windows = this.cleanWindows(dto.availability)
    return this.prisma.$transaction(async (tx) => {
      const before = await this.own(tx, id, me)
      if (before.archivedAt) throw badRequest("This booking page is archived. Restore it first.")
      const slug = dto.name !== before.name ? await this.uniqueSlug(tx, dto.name, id) : before.slug
      // The weekly hours are replaced whole (they're settings, not records).
      await tx.availabilityRule.deleteMany({ where: { eventTypeId: id } })
      const et = await tx.eventType.update({
        where: { id },
        data: {
          name: dto.name,
          slug,
          description: dto.description ?? "",
          durationMins: dto.durationMins,
          conferencing: dto.conferencing,
          customLink: dto.conferencing === "CUSTOM_LINK" ? dto.customLink! : null,
          bufferBeforeMins: dto.bufferBeforeMins,
          bufferAfterMins: dto.bufferAfterMins,
          minNoticeMins: dto.minNoticeMins,
          dateRangeDays: dto.dateRangeDays,
          slotIncrementMins: dto.slotIncrementMins,
          maxPerDay: dto.maxPerDay ?? null,
          timezone: dto.timezone,
          questions: questions as unknown as Prisma.InputJsonValue,
          active: dto.active ?? before.active,
          availability: { create: windows },
        },
        include: { availability: true },
      })
      const changes = [
        before.name !== et.name && `Name: ${before.name} → ${et.name} (link /book/${before.slug} → /book/${et.slug}; the old token link still works)`,
        before.durationMins !== et.durationMins && `Length: ${before.durationMins} → ${et.durationMins} min`,
        before.dateRangeDays !== et.dateRangeDays && `Days ahead: ${before.dateRangeDays} → ${et.dateRangeDays}`,
        before.active !== et.active && (et.active ? "Switched on" : "Switched off"),
        JSON.stringify(before.questions) !== JSON.stringify(et.questions) && "Booking form changed",
        "Settings saved",
      ].filter(Boolean)
      await this.audit.record({ actor: me, section: SECTION, action: `Changed the booking page ${et.name}`, entityType: "event_type", entityId: id, after: changes.join("\n"), ip }, tx)
      return this.view(et)
    })
  }

  async archiveEventType(id: string, archive: boolean, me: RequestUser, ip: string | null) {
    return this.prisma.$transaction(async (tx) => {
      const et = await this.own(tx, id, me)
      if (!!et.archivedAt === archive) return this.view(et)
      const updated = await tx.eventType.update({ where: { id }, data: { archivedAt: archive ? new Date() : null, active: archive ? false : et.active }, include: { availability: true } })
      await this.audit.record({ actor: me, section: SECTION, action: `${archive ? "Archived" : "Restored"} the booking page ${et.name}`, entityType: "event_type", entityId: id, ip }, tx)
      return this.view(updated)
    })
  }

  // ================================================================ The host's bookings

  async bookings(me: RequestUser, when: "upcoming" | "past" | "cancelled") {
    const now = new Date()
    const where: Prisma.BookingWhereInput =
      when === "cancelled" ? { hostUserId: me.id, status: "cancelled" } : when === "past" ? { hostUserId: me.id, status: "confirmed", endsAt: { lt: now } } : { hostUserId: me.id, status: "confirmed", endsAt: { gte: now } }
    const rows = await this.prisma.booking.findMany({ where, orderBy: { startsAt: when === "upcoming" ? "asc" : "desc" }, take: 200, include: { eventType: { select: { name: true } } } })
    const brands = await this.prisma.brand.findMany({ where: { id: { in: rows.map((r) => r.brandId).filter((x): x is string => !!x) } }, select: { id: true, name: true } })
    return rows.map((b) => this.bookingView(b, brands))
  }

  private bookingView(b: Booking & { eventType: { name: string } }, brands: { id: string; name: string }[]) {
    const qs = (b.questions as Question[]) ?? []
    const answers = (b.answers as Record<string, string>) ?? {}
    return {
      id: b.id,
      eventName: b.eventType.name,
      inviteeName: b.inviteeName,
      inviteeEmail: b.inviteeEmail,
      inviteeTimezone: b.inviteeTimezone,
      startsAt: b.startsAt,
      endsAt: b.endsAt,
      status: b.status,
      meetingUrl: b.meetingUrl,
      onCalendar: !!b.externalEventId,
      answers: qs.filter((q) => answers[q.id]).map((q) => ({ label: q.label, value: answers[q.id] })),
      brand: b.brandId ? (brands.find((x) => x.id === b.brandId) ?? null) : null,
      personId: b.personId,
      cancelledBy: b.cancelledBy,
      cancelReason: b.cancelReason,
      rescheduledFrom: b.rescheduledFrom,
      createdAt: b.createdAt,
    }
  }

  async hostCancel(id: string, reason: string | undefined, me: RequestUser, ip: string | null) {
    const b = await this.prisma.booking.findUnique({ where: { id }, include: { eventType: true } })
    if (!b || b.hostUserId !== me.id) throw notFound("That booking")
    await this.cancel(b, `${me.name} (host)`, reason, ip, me)
    return { ok: true }
  }

  // ================================================================ The public booking page

  private async load(handle: string): Promise<EventTypeFull> {
    const h = strip(handle, 100)
    const et = await this.prisma.eventType.findFirst({ where: { OR: [{ slug: h }, { token: h }] }, include: { availability: true } })
    if (!et || !et.active || et.archivedAt) throw notFound("This booking page")
    return et
  }

  async publicInfo(handle: string) {
    const et = await this.load(handle)
    const host = await this.prisma.user.findUnique({ where: { id: et.hostUserId }, select: { name: true, title: true } })
    return {
      name: et.name,
      description: et.description,
      durationMins: et.durationMins,
      conferencing: et.conferencing,
      timezone: et.timezone,
      dateRangeDays: et.dateRangeDays,
      hostName: host?.name ?? "ATM",
      hostTitle: host?.title ?? "",
      questions: (et.questions as Question[]).map((q) => ({ id: q.id, label: q.label, type: q.type, required: q.required, options: q.options, help: q.help })),
    }
  }

  private async openSlots(et: EventTypeFull, fromIso: string, toIso: string, ignoreBookingId?: string) {
    const from = new Date(Date.parse(fromIso) - 24 * 3600_000)
    const to = new Date(Date.parse(toIso) + 24 * 3600_000)
    // Every confirmed booking of this host counts as busy, whichever page it came from.
    const existing = await this.prisma.booking.findMany({ where: { hostUserId: et.hostUserId, status: "confirmed", startsAt: { lt: to }, endsAt: { gt: from }, ...(ignoreBookingId ? { id: { not: ignoreBookingId } } : {}) }, select: { startsAt: true, endsAt: true } })
    let external: google.Busy[] = []
    const token = await this.hostToken(et.hostUserId)
    if (token) external = await google.freeBusy(token, from.toISOString(), to.toISOString())
    return computeSlots({ settings: et, availability: et.availability, existing: existing.map((b) => ({ start: b.startsAt.toISOString(), end: b.endsAt.toISOString() })), externalBusy: external, fromIso, toIso })
  }

  private range(from?: string, to?: string, days = 20) {
    const now = Date.now()
    const f = from && Number.isFinite(Date.parse(from)) ? new Date(from) : new Date(now)
    const t = to && Number.isFinite(Date.parse(to)) ? new Date(to) : new Date(now + days * 86400_000)
    return { fromIso: f.toISOString(), toIso: t.toISOString() }
  }

  async publicSlots(handle: string, from?: string, to?: string) {
    const et = await this.load(handle)
    const r = this.range(from, to, et.dateRangeDays)
    return { slots: await this.openSlots(et, r.fromIso, r.toIso), timezone: et.timezone, durationMins: et.durationMins }
  }

  /** Is `start` still an open time for this page (computed fresh for that day)? */
  private async stillOpen(et: EventTypeFull, start: Date, ignoreBookingId?: string) {
    const day = localDate(start, et.timezone)
    const dayFrom = zonedToUtc(day, "00:00", et.timezone).toISOString()
    const dayTo = new Date(zonedToUtc(day, "00:00", et.timezone).getTime() + 26 * 3600_000).toISOString()
    const open = await this.openSlots(et, dayFrom, dayTo, ignoreBookingId)
    return open.some((s) => Date.parse(s) === start.getTime())
  }

  /** Checks the booking form's answers against the page's questions; returns them cleaned. */
  private answers(questions: Question[], raw: Record<string, unknown>) {
    const out: Record<string, string> = {}
    for (const q of questions) {
      let v = strip(raw[q.id], q.type === "textarea" ? 4000 : 500)
      if (q.required && !v) throw badRequest(`${q.label} is required.`)
      if (!v) continue
      if (q.type === "phone" && !isPhone(v)) throw badRequest(`${q.label}: enter a valid phone number.`)
      if (q.type === "email" && !EMAIL.test(v)) throw badRequest(`${q.label}: enter a valid email address.`)
      if (q.type === "url" && !isUrl(v)) throw badRequest(`${q.label}: enter a full link starting with https://.`)
      if (q.type === "number" && !Number.isFinite(Number(v.replace(/,/g, "")))) throw badRequest(`${q.label}: enter a number.`)
      if (q.type === "yesno") {
        const yn = v.toLowerCase() === "yes" ? "Yes" : v.toLowerCase() === "no" ? "No" : null
        if (!yn) throw badRequest(`${q.label}: choose Yes or No.`)
        v = yn
      }
      if (q.type === "select" && !(q.options ?? []).includes(v)) throw badRequest(`${q.label}: choose one of the options.`)
      out[q.id] = v
    }
    return out
  }

  async book(handle: string, dto: BookDto, ip: string | null) {
    const et = await this.load(handle)
    const name = strip(dto.name, 200)
    const email = dto.email.trim().toLowerCase()
    if (!name) throw badRequest("Your name is required.")
    if (!EMAIL.test(email)) throw badRequest("Enter a valid email address.")
    const start = new Date(dto.start)
    if (!Number.isFinite(start.getTime())) throw badRequest("Pick a time.")
    const end = new Date(start.getTime() + et.durationMins * 60_000)
    const questions = et.questions as Question[]
    const answers = this.answers(questions, dto.answers ?? {})
    const tz = dto.timezone && validZone(dto.timezone) ? dto.timezone : null
    if (!(await this.stillOpen(et, start))) throw conflict("That time is no longer available. Please pick another.")

    // Match the booker to a person in the CRM (and their brand) by email.
    const person = await this.prisma.person.findFirst({ where: { email, archivedAt: null }, select: { id: true, brands: { where: { removedAt: null }, orderBy: [{ isPrimary: "desc" }, { addedAt: "asc" }], select: { brandId: true } } } })

    const booking = await this.prisma.$transaction(async (tx) => {
      // One booking at a time per host, so two people can't take the same time.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${et.hostUserId}))`
      const clash = await tx.booking.findFirst({ where: { hostUserId: et.hostUserId, status: "confirmed", startsAt: { lt: end }, endsAt: { gt: start } } })
      if (clash) throw conflict("That time was just taken. Please pick another.")
      const b = await tx.booking.create({
        data: {
          eventTypeId: et.id,
          hostUserId: et.hostUserId,
          inviteeName: name,
          inviteeEmail: email,
          inviteeTimezone: tz,
          answers,
          questions: questions as unknown as Prisma.InputJsonValue,
          startsAt: start,
          endsAt: end,
          status: "confirmed",
          meetingUrl: et.conferencing === "CUSTOM_LINK" ? et.customLink : null,
          manageToken: randomBytes(24).toString("base64url"),
          personId: person?.id ?? null,
          brandId: person?.brands[0]?.brandId ?? null,
        },
        include: { eventType: { select: { name: true } } },
      })
      await this.audit.record({ actor: { label: `Booking page (${name} <${email}>)` }, section: SECTION, action: `${name} booked ${et.name}`, entityType: "booking", entityId: b.id, after: `${whenText(start, et.timezone)}${person ? "\nMatched to a person in Records" : ""}`, ip }, tx)
      return b
    })

    const meetingUrl = await this.afterBooking(et, booking, answers, questions)
    return { ok: true, startsAt: booking.startsAt, endsAt: booking.endsAt, meetingUrl, manageUrl: `${appConfig().frontendUrl}/booking/${booking.manageToken}` }
  }

  /** Puts the meeting on the host's calendar (with Meet), then emails the booker and the host. Never undoes the booking. */
  private async afterBooking(et: EventTypeFull, b: Booking, answers: Record<string, string>, questions: Question[]) {
    const host = await this.prisma.user.findUnique({ where: { id: et.hostUserId }, select: { name: true, email: true } })
    const answersText = questions.filter((q) => answers[q.id]).map((q) => `${q.label}: ${answers[q.id]}`).join("\n")
    let meetingUrl = b.meetingUrl ?? undefined
    let onCalendar = false
    try {
      const token = await this.hostToken(et.hostUserId)
      if (token) {
        const created = await google.createEvent(token, {
          summary: `${et.name}: ${b.inviteeName}`,
          description: [et.description, `Booked by ${b.inviteeName} <${b.inviteeEmail}>`, answersText, `Manage: ${appConfig().frontendUrl}/booking/${b.manageToken}`].filter(Boolean).join("\n\n"),
          startIso: b.startsAt.toISOString(),
          endIso: b.endsAt.toISOString(),
          timeZone: et.timezone,
          attendees: [b.inviteeEmail],
          addMeet: et.conferencing === "GOOGLE_MEET",
          location: et.conferencing === "CUSTOM_LINK" ? (et.customLink ?? undefined) : undefined,
        })
        if (created.eventId) {
          onCalendar = true
          meetingUrl = created.meetLink ?? meetingUrl
          await this.prisma.booking.update({ where: { id: b.id }, data: { externalEventId: created.eventId, meetingUrl: meetingUrl ?? null } })
        }
      }
    } catch (e) {
      this.log.warn(`Calendar event for booking ${b.id} failed: ${e instanceof Error ? e.message : String(e)}`)
    }
    await this.sendConfirmation(et, b, meetingUrl, host?.name ?? "ATM", answersText, "booked", onCalendar).catch(() => undefined)
    if (host) {
      const when = whenText(b.startsAt, et.timezone)
      const text = [`${b.inviteeName} <${b.inviteeEmail}> booked ${et.name}.`, `When: ${when}`, meetingUrl && `Meeting link: ${meetingUrl}`, answersText && `\nTheir answers:\n${answersText}`, `\nAll bookings: ${appConfig().frontendUrl}/meetings`].filter(Boolean).join("\n")
      await this.mail.send(host.email, `New booking: ${et.name} with ${b.inviteeName}`, text, `<pre style="font-family:Inter,Arial,sans-serif;font-size:14px;white-space:pre-wrap">${escape(text)}</pre>`).catch(() => undefined)
    }
    return meetingUrl
  }

  private async sendConfirmation(et: EventType, b: Booking, meetingUrl: string | undefined, hostName: string, answersText: string, kind: "booked" | "moved", onCalendar: boolean) {
    const tz = b.inviteeTimezone || et.timezone
    const when = whenText(b.startsAt, tz)
    const manage = `${appConfig().frontendUrl}/booking/${b.manageToken}`
    const addToCalendar = `https://calendar.google.com/calendar/render?${new URLSearchParams({ action: "TEMPLATE", text: `${et.name} with ${hostName}`, dates: `${gcalDate(b.startsAt)}/${gcalDate(b.endsAt)}`, details: [meetingUrl && `Join: ${meetingUrl}`, `Reschedule or cancel: ${manage}`].filter(Boolean).join("\n"), location: meetingUrl ?? "" }).toString()}`
    const first = b.inviteeName.split(/\s+/)[0] || b.inviteeName
    const subject = kind === "booked" ? `Confirmed: ${et.name} with ${hostName}, ${when}` : `Moved: ${et.name} with ${hostName}, now ${when}`
    const text = [
      `Hi ${first},`,
      ``,
      kind === "booked" ? `Your ${et.name} with ${hostName} is booked.` : `Your ${et.name} with ${hostName} has moved.`,
      `When: ${when}`,
      meetingUrl ? `Join: ${meetingUrl}` : "",
      onCalendar ? `A calendar invite is on its way from Google.` : `Add it to your calendar: ${addToCalendar}`,
      answersText ? `\nWhat you told us:\n${answersText}` : "",
      ``,
      `Need to change it? Reschedule or cancel here: ${manage}`,
    ]
      .filter((l) => l !== "")
      .join("\n")
    const html = `<div style="font-family:Inter,Arial,sans-serif;font-size:14px;line-height:1.5;color:#101828">
<p>Hi ${escape(first)},</p>
<p>${kind === "booked" ? "Your" : "Your"} <strong>${escape(et.name)}</strong> with ${escape(hostName)} ${kind === "booked" ? "is booked" : "has moved"}.</p>
<p><strong>${escape(when)}</strong></p>
${meetingUrl ? `<p><a href="${escape(meetingUrl)}" style="display:inline-block;background:#2e5bff;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600">Join the meeting</a></p>` : ""}
<p>${onCalendar ? "A calendar invite is on its way from Google." : `<a href="${escape(addToCalendar)}">Add it to your Google Calendar</a>`}</p>
${answersText ? `<p style="color:#475467;white-space:pre-wrap">${escape(answersText)}</p>` : ""}
<p style="color:#475467">Need to change it? <a href="${escape(manage)}">Reschedule or cancel</a>.</p>
</div>`
    await this.mail.send(b.inviteeEmail, subject, text, html)
  }

  // ================================================================ Manage a booking (the booker's link)

  private async byManageToken(token: string) {
    const b = await this.prisma.booking.findUnique({ where: { manageToken: strip(token, 100) }, include: { eventType: { include: { availability: true } } } })
    if (!b) throw notFound("This booking link")
    return b
  }

  async manageInfo(token: string) {
    const b = await this.byManageToken(token)
    const host = await this.prisma.user.findUnique({ where: { id: b.hostUserId }, select: { name: true } })
    return {
      eventName: b.eventType.name,
      hostName: host?.name ?? "ATM",
      durationMins: b.eventType.durationMins,
      timezone: b.eventType.timezone,
      inviteeName: b.inviteeName,
      inviteeTimezone: b.inviteeTimezone,
      startsAt: b.startsAt,
      endsAt: b.endsAt,
      status: b.status,
      meetingUrl: b.status === "confirmed" ? b.meetingUrl : null,
      canChange: b.status === "confirmed" && b.startsAt.getTime() > Date.now() && b.eventType.active && !b.eventType.archivedAt,
    }
  }

  async manageSlots(token: string, from?: string, to?: string) {
    const b = await this.byManageToken(token)
    if (b.status !== "confirmed" || !b.eventType.active || b.eventType.archivedAt) throw badRequest("This booking can't be moved.")
    const r = this.range(from, to, b.eventType.dateRangeDays)
    return { slots: await this.openSlots(b.eventType, r.fromIso, r.toIso, b.id), timezone: b.eventType.timezone, durationMins: b.eventType.durationMins }
  }

  async reschedule(token: string, startRaw: string, ip: string | null) {
    const b = await this.byManageToken(token)
    if (b.status !== "confirmed" || b.startsAt.getTime() <= Date.now()) throw badRequest("This booking can't be moved.")
    const et = b.eventType
    const start = new Date(startRaw)
    if (!Number.isFinite(start.getTime())) throw badRequest("Pick a time.")
    const end = new Date(start.getTime() + et.durationMins * 60_000)
    if (!(await this.stillOpen(et, start, b.id))) throw conflict("That time is no longer available. Please pick another.")
    const moved = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${et.hostUserId}))`
      const clash = await tx.booking.findFirst({ where: { hostUserId: et.hostUserId, status: "confirmed", id: { not: b.id }, startsAt: { lt: end }, endsAt: { gt: start } } })
      if (clash) throw conflict("That time was just taken. Please pick another.")
      const u = await tx.booking.update({ where: { id: b.id }, data: { startsAt: start, endsAt: end, rescheduledFrom: b.startsAt } })
      await this.audit.record({ actor: { label: `Booking page (${b.inviteeName} <${b.inviteeEmail}>)` }, section: SECTION, action: `${b.inviteeName} moved ${et.name}`, entityType: "booking", entityId: b.id, before: whenText(b.startsAt, et.timezone), after: whenText(start, et.timezone), ip }, tx)
      return u
    })
    try {
      const t = moved.externalEventId ? await this.hostToken(et.hostUserId) : null
      if (t && moved.externalEventId) await google.moveEvent(t, moved.externalEventId, start.toISOString(), end.toISOString(), et.timezone)
    } catch {
      /* best-effort */
    }
    const host = await this.prisma.user.findUnique({ where: { id: et.hostUserId }, select: { name: true, email: true } })
    await this.sendConfirmation(et, moved, moved.meetingUrl ?? undefined, host?.name ?? "ATM", "", "moved", !!moved.externalEventId).catch(() => undefined)
    if (host) await this.mail.send(host.email, `Booking moved: ${et.name} with ${b.inviteeName}`, `${b.inviteeName} moved ${et.name} from ${whenText(b.startsAt, et.timezone)} to ${whenText(start, et.timezone)}.`, `<p>${escape(b.inviteeName)} moved ${escape(et.name)} from ${escape(whenText(b.startsAt, et.timezone))} to <strong>${escape(whenText(start, et.timezone))}</strong>.</p>`).catch(() => undefined)
    return { ok: true, startsAt: start }
  }

  async publicCancel(token: string, reason: string | undefined, ip: string | null) {
    const b = await this.byManageToken(token)
    await this.cancel(b, `${b.inviteeName} (booker)`, reason, ip)
    return { ok: true }
  }

  private async cancel(b: Booking & { eventType: EventType }, by: string, reason: string | undefined, ip: string | null, me?: RequestUser) {
    if (b.status === "cancelled") return
    const why = strip(reason, 500) || null
    await this.prisma.$transaction(async (tx) => {
      await tx.booking.update({ where: { id: b.id }, data: { status: "cancelled", cancelledAt: new Date(), cancelledBy: by, cancelReason: why } })
      await this.audit.record({ actor: me ?? { label: `Booking page (${b.inviteeName} <${b.inviteeEmail}>)` }, section: SECTION, action: `Cancelled ${b.eventType.name} with ${b.inviteeName}`, entityType: "booking", entityId: b.id, before: whenText(b.startsAt, b.eventType.timezone), reason: why, ip }, tx)
    })
    try {
      const t = b.externalEventId ? await this.hostToken(b.hostUserId) : null
      if (t && b.externalEventId) await google.deleteEvent(t, b.externalEventId)
    } catch {
      /* best-effort */
    }
    const host = await this.prisma.user.findUnique({ where: { id: b.hostUserId }, select: { name: true, email: true } })
    const when = whenText(b.startsAt, b.inviteeTimezone || b.eventType.timezone)
    await this.mail.send(b.inviteeEmail, `Cancelled: ${b.eventType.name}, ${when}`, `Your ${b.eventType.name} on ${when} is cancelled.${why ? `\nReason: ${why}` : ""}\n\nBook another time: ${appConfig().frontendUrl}/book/${b.eventType.slug}`, `<p>Your ${escape(b.eventType.name)} on ${escape(when)} is cancelled.${why ? `<br>Reason: ${escape(why)}` : ""}</p><p><a href="${escape(`${appConfig().frontendUrl}/book/${b.eventType.slug}`)}">Book another time</a></p>`).catch(() => undefined)
    if (host && !me) await this.mail.send(host.email, `Booking cancelled: ${b.eventType.name} with ${b.inviteeName}`, `${b.inviteeName} cancelled ${b.eventType.name} on ${whenText(b.startsAt, b.eventType.timezone)}.${why ? `\nReason: ${why}` : ""}`, `<p>${escape(b.inviteeName)} cancelled ${escape(b.eventType.name)} on ${escape(whenText(b.startsAt, b.eventType.timezone))}.${why ? `<br>Reason: ${escape(why)}` : ""}</p>`).catch(() => undefined)
  }
}
