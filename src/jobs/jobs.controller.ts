import { Body, Controller, Get, Param, ParseUUIDPipe, Post } from "@nestjs/common"
import { Transform } from "class-transformer"
import { IsInt, IsOptional, Max, Min } from "class-validator"

import { CurrentUser, RequirePermissions } from "../common/decorators"
import { badRequest, notFound } from "../common/errors"
import type { RequestUser } from "../common/request-user"
import { localDateTime } from "./clock"
import { JobQueue } from "./job-queue.service"
import { WorkTimeService } from "./work-time.service"

class TestJobDto {
  /** How many times the test job fails before it works (to see the retries). */
  @Transform(({ value }) => (value === undefined ? 2 : Number(value)))
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5)
  failTimes?: number
}

// Settings → Jobs: the schedules, recent jobs, and the working-time check. Looking needs "View Settings";
// running, retrying and testing need "Change configuration and lists".

@Controller("jobs")
export class JobsController {
  constructor(
    private readonly queue: JobQueue,
    private readonly workTime: WorkTimeService,
  ) {}

  @Get()
  @RequirePermissions("settings.view")
  overview() {
    return this.queue.overview()
  }

  /** The working calendar in action: is it working time now, and what +4 working hours or +3 working days give. */
  @Get("calendar")
  @RequirePermissions("settings.view")
  async calendar() {
    this.workTime.reset()
    const cal = await this.workTime.calendar()
    const now = new Date()
    const show = (d: Date) => localDateTime(d, cal.timezone)
    return {
      timezone: cal.timezone,
      workDays: cal.workDays,
      hours: `${cal.start}–${cal.end}`,
      holidays: [...cal.holidays].sort(),
      now: show(now),
      workingNow: cal.isWorkingTime(now),
      nextWorkingStart: show(cal.nextWorkingStart(now)),
      plus4WorkingHours: show(cal.addWorkingHours(now, 4)),
      plus3WorkingDays: show(cal.addWorkingDays(now, 3)),
    }
  }

  @Post("schedules/:name/run")
  @RequirePermissions("settings.edit")
  async runNow(@Param("name") name: string, @CurrentUser() me: RequestUser) {
    const job = await this.queue.runNow(name, me.id)
    if (!job) throw notFound("That schedule")
    return job
  }

  @Post(":id/retry")
  @RequirePermissions("settings.edit")
  async retry(@Param("id", ParseUUIDPipe) id: string) {
    const job = await this.queue.retry(id)
    if (!job) throw badRequest("Only a failed or dead job can be retried.")
    return job
  }

  /** A job that fails the given number of times, then works: shows the retries on the Jobs screen. */
  @Post("test")
  @RequirePermissions("settings.edit")
  test(@Body() dto: TestJobDto, @CurrentUser() me: RequestUser) {
    return this.queue.enqueue("system.test", { failTimes: dto.failTimes ?? 2 }, { createdById: me.id, maxAttempts: 5 })
  }
}
