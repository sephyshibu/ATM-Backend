import { Injectable, type OnModuleInit } from "@nestjs/common"

import { JobQueue } from "../jobs/job-queue.service"
import { WorkTimeService } from "../jobs/work-time.service"
import { JourneyService } from "./journey.service"

/** Registers the daily lane check (job lanes.tick) and its schedule, at the time set in Configuration. */
@Injectable()
export class LeadTimers implements OnModuleInit {
  constructor(
    private readonly queue: JobQueue,
    private readonly workTime: WorkTimeService,
    private readonly journey: JourneyService,
  ) {}

  onModuleInit() {
    this.queue.register("lanes.tick", "Daily side-lane check", async (payload) => {
      const today = String(payload.date ?? "")
      if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error("The job needs the local date it runs for.")
      const watchDays = await this.workTime.setting("lane.watch_to_nurture_days", 10)
      const restMonths = await this.workTime.setting("lane.rested_eligible_months", 6)
      return this.journey.runTimers(today, watchDays, restMonths)
    })
    this.queue.addSchedule({ name: "lanes.tick", label: "Daily side-lane check", timeSetting: "jobs.lanes_tick_time", defaultTime: "06:00" })
  }
}
