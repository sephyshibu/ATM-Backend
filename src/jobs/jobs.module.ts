import { Global, Module, type OnModuleInit } from "@nestjs/common"

import { JobQueue } from "./job-queue.service"
import { JobsController } from "./jobs.controller"
import { WorkTimeService } from "./work-time.service"

/** The job queue, the scheduler and working time, available to every module. */
@Global()
@Module({
  controllers: [JobsController],
  providers: [JobQueue, WorkTimeService],
  exports: [JobQueue, WorkTimeService],
})
export class JobsModule implements OnModuleInit {
  constructor(private readonly queue: JobQueue) {}

  onModuleInit() {
    // The test job: fails `failTimes` times, then works.
    this.queue.register("system.test", "Test job", async (payload, job) => {
      const failTimes = Number(payload.failTimes ?? 0)
      if (job.attempts <= failTimes) throw new Error(`Test failure ${job.attempts} of ${failTimes} (on purpose).`)
      return `Worked on attempt ${job.attempts}.`
    })
  }
}
