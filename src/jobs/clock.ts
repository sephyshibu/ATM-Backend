// Time zones and working time, with no library: the Intl API knows every time zone and its daylight saving.
//
// Everything is stored in UTC. These helpers read a UTC moment as local time in a zone, turn a local time back into
// UTC, and count working days and working hours (company working days and hours, minus holidays).

export type LocalParts = { y: number; m: number; d: number; h: number; mi: number; s: number; weekday: number }

const formatters = new Map<string, Intl.DateTimeFormat>()
const WEEKDAYS: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }
const pad = (n: number) => String(n).padStart(2, "0")

function formatter(tz: string) {
  let f = formatters.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", weekday: "short" })
    formatters.set(tz, f)
  }
  return f
}

/** A UTC moment as local date and time parts in `tz`. Weekday: 1 = Monday … 7 = Sunday. */
export function localParts(at: Date, tz: string): LocalParts {
  const parts = Object.fromEntries(formatter(tz).formatToParts(at).map((p) => [p.type, p.value]))
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), h: Number(parts.hour) % 24, mi: Number(parts.minute), s: Number(parts.second), weekday: WEEKDAYS[parts.weekday] ?? 1 }
}

/** "2026-11-23", the local date in `tz`. */
export const localDate = (at: Date, tz: string) => {
  const p = localParts(at, tz)
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`
}

/** "2026-11-23 07:00", the local date and time in `tz`. */
export const localDateTime = (at: Date, tz: string) => {
  const p = localParts(at, tz)
  return `${p.y}-${pad(p.m)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}`
}

/** The UTC moment of a local date and time in `tz` (daylight saving included). */
export function zonedToUtc(date: string, time: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number)
  const [h, mi] = time.split(":").map(Number)
  const target = Date.UTC(y, m - 1, d, h, mi)
  let guess = target
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(guess), tz)
    const seen = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi)
    const diff = target - seen
    if (diff === 0) break
    guess += diff
  }
  return new Date(guess)
}

/** "2026-11-23" plus n days (calendar days). */
export function addDays(date: string, n: number) {
  const [y, m, d] = date.split("-").map(Number)
  const t = new Date(Date.UTC(y, m - 1, d + n))
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`
}

/** 1 = Monday … 7 = Sunday, for a "2026-11-23" date. */
export function weekdayOf(date: string) {
  const [y, m, d] = date.split("-").map(Number)
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
  return w === 0 ? 7 : w
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number)
  return h * 60 + m
}

/** The company's working time: zone, working weekdays, daily hours and holidays. */
export class WorkCalendar {
  constructor(
    readonly timezone: string,
    readonly workDays: number[],
    readonly start: string,
    readonly end: string,
    readonly holidays: Set<string>,
  ) {}

  isWorkingDay(date: string) {
    return this.workDays.includes(weekdayOf(date)) && !this.holidays.has(date)
  }

  /** Is this moment inside working hours on a working day? */
  isWorkingTime(at: Date) {
    const date = localDate(at, this.timezone)
    if (!this.isWorkingDay(date)) return false
    const p = localParts(at, this.timezone)
    const now = p.h * 60 + p.mi
    return now >= minutes(this.start) && now < minutes(this.end)
  }

  /** The next working day after `date` (or `date` itself when `inclusive`). */
  nextWorkingDay(date: string, inclusive = false) {
    let d = inclusive ? date : addDays(date, 1)
    for (let i = 0; i < 400 && !this.isWorkingDay(d); i++) d = addDays(d, 1)
    return d
  }

  /** The start of the next working period: now if it is working time. */
  nextWorkingStart(at: Date) {
    if (this.isWorkingTime(at)) return at
    const date = localDate(at, this.timezone)
    const p = localParts(at, this.timezone)
    const before = this.isWorkingDay(date) && p.h * 60 + p.mi < minutes(this.start)
    return zonedToUtc(before ? date : this.nextWorkingDay(date), this.start, this.timezone)
  }

  /** `at` plus n working days, at the same local time (e.g. 3 working days after a Friday → Wednesday). */
  addWorkingDays(at: Date, n: number) {
    let date = localDate(at, this.timezone)
    const p = localParts(at, this.timezone)
    for (let i = 0; i < n; i++) date = this.nextWorkingDay(date)
    return zonedToUtc(date, `${pad(p.h)}:${pad(p.mi)}`, this.timezone)
  }

  /** `at` plus n working hours: counts only inside working hours on working days (the reply and enquiry clocks). */
  addWorkingHours(at: Date, n: number) {
    let left = Math.round(n * 60)
    let cursor = this.nextWorkingStart(at)
    for (let i = 0; i < 800 && left > 0; i++) {
      const date = localDate(cursor, this.timezone)
      const endOfDay = zonedToUtc(date, this.end, this.timezone)
      const available = Math.max(0, Math.floor((endOfDay.getTime() - cursor.getTime()) / 60_000))
      if (left <= available) return new Date(cursor.getTime() + left * 60_000)
      left -= available
      cursor = zonedToUtc(this.nextWorkingDay(date), this.start, this.timezone)
    }
    return cursor
  }
}
