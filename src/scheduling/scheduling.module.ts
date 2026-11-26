import { Module } from "@nestjs/common"

import { MailModule } from "../mail/mail.module"
import { CalendarCallbackController, PublicBookingController, SchedulingController } from "./scheduling.controller"
import { SchedulingService } from "./scheduling.service"

@Module({
  imports: [MailModule],
  controllers: [SchedulingController, CalendarCallbackController, PublicBookingController],
  providers: [SchedulingService],
  exports: [SchedulingService],
})
export class SchedulingModule {}
