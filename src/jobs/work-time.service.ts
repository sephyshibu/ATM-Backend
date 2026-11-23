import { Injectable } from "@nestjs/common"

import { PrismaService } from "../prisma/prisma.service"
import { WorkCalendar } from "./clock"

// Reads the Configuration values the clocks and schedules use (the newest version of each), and builds the
// company's working calendar. Cached for 30 seconds, so a change in Settings takes effect within a minute.

const TTL = 30_000

@Injectable()
export class WorkTimeService {
  private cache: { at: number; values: Map<string, unknown>; holidays: Set<string> } | null = null

  constructor(private readonly prisma: PrismaService) {}

  private async load() {
    if (this.cache && Date.now() - this.cache.at < TTL) return this.cache
    const [rows, holidays] = await Promise.all([
      this.prisma.$queryRaw<{ key: string; value: unknown }[]>`SELECT DISTINCT ON (key) key, value FROM "setting_value" ORDER BY key, version DESC`,
      this.prisma.listValue.findMany({ where: { listKey: "holidays", retiredAt: null }, select: { code: true, label: true } }),
    ])
    const dates = new Set<string>()
    for (const h of holidays) {
      const m = /(\d{4}-\d{2}-\d{2})/.exec(h.label) ?? /(\d{4})_(\d{2})_(\d{2})/.exec(h.code)
      if (m) dates.add(m.length === 4 ? `${m[1]}-${m[2]}-${m[3]}` : m[1])
    }
    this.cache = { at: Date.now(), values: new Map(rows.map((r) => [r.key, r.value])), holidays: dates }
    return this.cache
  }

  /** Forget cached values (after a change, or in tests). */
  reset() {
    this.cache = null
  }

  async setting<T extends string | number | boolean>(key: string, fallback: T): Promise<T> {
    const v = (await this.load()).values.get(key)
    return v === undefined || v === null || typeof v !== typeof fallback ? fallback : (v as T)
  }

  async timezone() {
    const tz = await this.setting("company.timezone", "Asia/Kolkata")
    try {
      new Intl.DateTimeFormat("en", { timeZone: tz })
      return tz
    } catch {
      return "Asia/Kolkata"
    }
  }

  async calendar() {
    const c = await this.load()
    const days = String(await this.setting("company.work_days", "1,2,3,4,5"))
      .split(",")
      .map((d) => Number(d.trim()))
      .filter((d) => d >= 1 && d <= 7)
    return new WorkCalendar(await this.timezone(), days.length ? days : [1, 2, 3, 4, 5], await this.setting("company.work_start", "09:00"), await this.setting("company.work_end", "18:00"), c.holidays)
  }
}
