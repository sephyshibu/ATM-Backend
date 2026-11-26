import { addDays, localDate, weekdayOf, zonedToUtc } from "../jobs/clock"

// The open times on a booking page:
//   weekly hours (in the host's time zone)
//   ∩ [now + minimum notice, now + days ahead] ∩ the requested window
//   − existing bookings − the host's Google Calendar busy times (each padded by the buffers)
//   − days that already reached the daily cap.
// Weekly hours are wall-clock ("Mon 09:00") turned into UTC per day, so 09:00 stays 09:00 across daylight saving.
// Everything returned is UTC ISO; the booking page shows it in the invitee's own time zone.

export type SlotSettings = {
  durationMins: number
  slotIncrementMins: number
  bufferBeforeMins: number
  bufferAfterMins: number
  minNoticeMins: number
  dateRangeDays: number
  maxPerDay: number | null
  timezone: string
}
export type Window = { weekday: number; startMinute: number; endMinute: number }
export type Busy = { start: string; end: string }

const MIN = 60_000
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`

export function computeSlots(p: { settings: SlotSettings; availability: Window[]; existing: Busy[]; externalBusy: Busy[]; fromIso: string; toIso: string; now?: Date }): string[] {
  const s = p.settings
  const zone = s.timezone || "UTC"
  const now = (p.now ?? new Date()).getTime()
  const earliest = now + s.minNoticeMins * MIN
  const latest = now + s.dateRangeDays * 24 * 60 * MIN
  const from = Date.parse(p.fromIso)
  const to = Date.parse(p.toIso)
  const start = Math.max(Number.isFinite(from) ? from : now, earliest)
  const end = Math.min(Number.isFinite(to) ? to : latest, latest)
  if (end <= start) return []

  const busy = [...p.existing, ...p.externalBusy].map((b) => ({ s: Date.parse(b.start), e: Date.parse(b.end) })).filter((b) => Number.isFinite(b.s) && Number.isFinite(b.e) && b.e > b.s)
  const perDay = new Map<string, number>()
  for (const b of p.existing) {
    const d = localDate(new Date(b.start), zone)
    perDay.set(d, (perDay.get(d) ?? 0) + 1)
  }

  const out = new Set<number>()
  const lastDay = localDate(new Date(end), zone)
  for (let day = localDate(new Date(start), zone); day <= lastDay; day = addDays(day, 1)) {
    const weekday = weekdayOf(day) % 7 // 1 = Mon … 7 = Sun → 0 = Sun … 6 = Sat
    if (s.maxPerDay !== null && (perDay.get(day) ?? 0) >= s.maxPerDay) continue
    for (const w of p.availability.filter((r) => r.weekday === weekday)) {
      let t = zonedToUtc(day, hhmm(w.startMinute), zone).getTime()
      const close = w.endMinute >= 1440 ? zonedToUtc(addDays(day, 1), "00:00", zone).getTime() : zonedToUtc(day, hhmm(w.endMinute), zone).getTime()
      while (t + s.durationMins * MIN <= close) {
        if (t < start || t >= end) {
          t += s.slotIncrementMins * MIN
          continue
        }
        const cs = t - s.bufferBeforeMins * MIN
        const ce = t + (s.durationMins + s.bufferAfterMins) * MIN
        const clash = busy.find((b) => b.s < ce && cs < b.e)
        if (clash) {
          // Start again right after the busy block (plus the buffer), not on the fixed grid.
          const resume = clash.e + s.bufferBeforeMins * MIN
          t = resume > t ? resume : t + s.slotIncrementMins * MIN
          continue
        }
        out.add(t)
        t += s.slotIncrementMins * MIN
      }
    }
  }
  return [...out].sort((a, b) => a - b).map((t) => new Date(t).toISOString())
}
