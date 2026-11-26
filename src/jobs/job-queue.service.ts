import { hostname } from "node:os"

import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common"
import { type Job, Prisma } from "@prisma/client"

import { PrismaService } from "../prisma/prisma.service"
import { addDays, localDate, localDateTime, zonedToUtc } from "./clock"
import { WorkTimeService } from "./work-time.service"

// The background job queue and the scheduler, both in PostgreSQL.
//
// Queue: modules register a handler by name; anything can enqueue a job. A worker in this app claims due jobs
// one at a time (FOR UPDATE SKIP LOCKED: several app instances never take the same job), runs them, and on failure
// retries after a growing wait (30 s, 1 min, 2 min… up to 1 h) until max attempts, then marks the job dead.
// A job left "running" by a crash is picked up again after 15 minutes.
//
// Scheduler: modules register schedules ("daily at the time in setting X", optionally on the weekday in setting Y).
// Every minute it queues each schedule's run for today once it is due in the company time zone, keyed by
// name + local date, so it runs once a day however often the scheduler ticks or how many instances there are.
// Turn the worker off on an instance with JOBS_WORKER=off.

export type JobHandler = (payload: Record<string, unknown>, job: Job) => Promise<string | void>
export type ScheduleDef = { name: string; label: string; timeSetting: string; defaultTime: string; weekdaySetting?: string; defaultWeekday?: number; payload?: Record<string, unknown> }

const POLL_MS = 5_000
const SCHEDULE_MS = 60_000
const backoff = (attempt: number) => Math.min(30_000 * 2 ** Math.max(0, attempt - 1), 3_600_000)

@Injectable()
export class JobQueue implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("Jobs")
  private readonly handlers = new Map<string, { label: string; run: JobHandler }>()
  private readonly schedules: ScheduleDef[] = []
  private timers: NodeJS.Timeout[] = []
  private busy = false
  readonly workerId = `${hostname()}:${process.pid}`
  readonly workerOn = process.env.JOBS_WORKER !== "off"

  constructor(
    private readonly prisma: PrismaService,
    private readonly workTime: WorkTimeService,
  ) {}

  onModuleInit() {
    if (!this.workerOn) {
      this.log.warn("JOBS_WORKER=off: this instance doesn't run background jobs.")
      return
    }
    this.timers.push(setInterval(() => void this.work(), POLL_MS))
    this.timers.push(setInterval(() => void this.schedule(), SCHEDULE_MS))
    this.timers.push(setTimeout(() => void this.schedule(), 5_000))
    this.log.log(`Worker ${this.workerId} started.`)
  }

  onModuleDestroy() {
    for (const t of this.timers) clearInterval(t)
    this.timers = []
  }

  register(name: string, label: string, run: JobHandler) {
    this.handlers.set(name, { label, run })
  }

  addSchedule(def: ScheduleDef) {
    if (!this.schedules.some((s) => s.name === def.name)) this.schedules.push(def)
  }

  label(name: string) {
    return this.handlers.get(name)?.label ?? name
  }

  /**
   * Queues a job. With a uniqueKey that's already used, nothing is queued and the existing job is returned. Pass
   * `db` (a transaction) to queue it with a change, so the job exists only if the change commits.
   */
  async enqueue(name: string, payload: Record<string, unknown> = {}, opts: { runAt?: Date; uniqueKey?: string; maxAttempts?: number; createdById?: string | null; db?: Prisma.TransactionClient } = {}) {
    try {
      return await (opts.db ?? this.prisma).job.create({
        data: { name, payload: payload as Prisma.InputJsonValue, runAt: opts.runAt ?? new Date(), uniqueKey: opts.uniqueKey ?? null, maxAttempts: opts.maxAttempts ?? 5, createdById: opts.createdById ?? null },
      })
    } catch (e) {
      if (opts.uniqueKey && e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return this.prisma.job.findUnique({ where: { uniqueKey: opts.uniqueKey } })
      throw e
    }
  }

  // ---------------------------------------------------------------- Worker

  private async work() {
    if (this.busy) return
    this.busy = true
    try {
      await this.prisma.$executeRaw`UPDATE "job" SET status = 'failed', locked_at = NULL, locked_by = NULL, run_at = now(), last_error = 'Stopped while running (the app restarted?). Trying again.' WHERE status = 'running' AND locked_at < now() - interval '15 minutes'`
      for (let i = 0; i < 20; i++) {
        const job = await this.claim()
        if (!job) break
        await this.run(job)
      }
    } catch (e) {
      this.log.error(`Worker error: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      this.busy = false
    }
  }

  private async claim() {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE "job" SET status = 'running', locked_at = now(), locked_by = ${this.workerId}, started_at = now(), attempts = attempts + 1
      WHERE id = (SELECT id FROM "job" WHERE status IN ('queued', 'failed') AND run_at <= now() ORDER BY run_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id`
    return rows[0] ? this.prisma.job.findUnique({ where: { id: rows[0].id } }) : null
  }

  private async run(job: Job) {
    const handler = this.handlers.get(job.name)
    if (!handler) {
      await this.prisma.job.update({ where: { id: job.id }, data: { status: "dead", lastError: `Nothing handles jobs called ${job.name}.`, lockedAt: null, lockedBy: null, finishedAt: new Date() } })
      return
    }
    try {
      const result = await handler.run((job.payload ?? {}) as Record<string, unknown>, job)
      await this.prisma.job.update({ where: { id: job.id }, data: { status: "done", result: result ? String(result).slice(0, 2000) : null, lastError: null, lockedAt: null, lockedBy: null, finishedAt: new Date() } })
    } catch (e) {
      const message = (e instanceof Error ? e.message : String(e)).slice(0, 2000)
      const dead = job.attempts >= job.maxAttempts
      await this.prisma.job.update({
        where: { id: job.id },
        data: { status: dead ? "dead" : "failed", lastError: message, lockedAt: null, lockedBy: null, ...(dead ? { finishedAt: new Date() } : { runAt: new Date(Date.now() + backoff(job.attempts)) }) },
      })
      this.log.warn(`${job.name} failed (attempt ${job.attempts} of ${job.maxAttempts})${dead ? ", giving up" : ""}: ${message}`)
    }
  }

  // ---------------------------------------------------------------- Scheduler

  /** When a schedule runs next, as a UTC moment and as local text. */
  private async next(s: ScheduleDef, now: Date) {
    const tz = await this.workTime.timezone()
    const time = await this.workTime.setting(s.timeSetting, s.defaultTime)
    const weekday = s.weekdaySetting ? await this.workTime.setting(s.weekdaySetting, s.defaultWeekday ?? 1) : null
    const today = localDate(now, tz)
    const runsOn = (date: string) => weekday === null || new Date(`${date}T12:00:00Z`).getUTCDay() === weekday % 7
    let date = today
    for (let i = 0; i < 8; i++) {
      const at = zonedToUtc(date, time, tz)
      if (runsOn(date) && (date !== today || at > now)) return { date, at, local: localDateTime(at, tz), tz }
      date = addDays(date, 1)
    }
    return { date, at: zonedToUtc(date, time, tz), local: `${date} ${time}`, tz }
  }

  /** Queues today's run of each schedule once it is due (and not yet queued today). */
  async schedule() {
    try {
      const now = new Date()
      const tz = await this.workTime.timezone()
      const today = localDate(now, tz)
      for (const s of this.schedules) {
        const time = await this.workTime.setting(s.timeSetting, s.defaultTime)
        const weekday = s.weekdaySetting ? await this.workTime.setting(s.weekdaySetting, s.defaultWeekday ?? 1) : null
        if (weekday !== null && new Date(`${today}T12:00:00Z`).getUTCDay() !== weekday % 7) continue
        if (now < zonedToUtc(today, time, tz)) continue
        await this.enqueue(s.name, { ...(s.payload ?? {}), date: today }, { uniqueKey: `${s.name}:${today}` })
      }
    } catch (e) {
      this.log.error(`Scheduler error: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // ---------------------------------------------------------------- For the Jobs screen

  async overview() {
    const now = new Date()
    const tz = await this.workTime.timezone()
    const jobs = await this.prisma.job.findMany({ orderBy: { createdAt: "desc" }, take: 100 })
    const schedules = await Promise.all(
      this.schedules.map(async (s) => {
        const next = await this.next(s, now)
        const last = await this.prisma.job.findFirst({ where: { name: s.name }, orderBy: { createdAt: "desc" } })
        const time = await this.workTime.setting(s.timeSetting, s.defaultTime)
        const weekday = s.weekdaySetting ? await this.workTime.setting(s.weekdaySetting, s.defaultWeekday ?? 1) : null
        const days = ["", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
        return { name: s.name, label: s.label, when: `${weekday ? `Every ${days[weekday]}` : "Every day"} at ${time} (${tz})`, setting: s.timeSetting, nextRun: next.local, lastRun: last ? { status: last.status, at: last.finishedAt ?? last.createdAt, result: last.result, error: last.lastError } : null }
      }),
    )
    return {
      worker: { on: this.workerOn, id: this.workerId },
      timezone: tz,
      now: localDateTime(now, tz),
      schedules,
      jobs: jobs.map((j) => ({ ...j, label: this.label(j.name) })),
      counts: {
        queued: await this.prisma.job.count({ where: { status: "queued" } }),
        failed: await this.prisma.job.count({ where: { status: "failed" } }),
        dead: await this.prisma.job.count({ where: { status: "dead" } }),
      },
    }
  }

  /** Runs a schedule now, outside its time (for checking it). */
  async runNow(name: string, createdById: string) {
    const s = this.schedules.find((x) => x.name === name)
    if (!s) return null
    const today = localDate(new Date(), await this.workTime.timezone())
    return this.enqueue(s.name, { ...(s.payload ?? {}), date: today, byHand: true }, { createdById })
  }

  /** Queues a failed or dead job again, now, with one more attempt allowed. */
  async retry(id: string) {
    const job = await this.prisma.job.findUnique({ where: { id } })
    if (!job || !["failed", "dead"].includes(job.status)) return null
    return this.prisma.job.update({ where: { id }, data: { status: "queued", runAt: new Date(), maxAttempts: Math.max(job.maxAttempts, job.attempts + 1), finishedAt: null } })
  }
}
