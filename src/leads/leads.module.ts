import { Module } from "@nestjs/common"

import { JourneyService } from "./journey.service"
import { LeadTimers } from "./lead-timers"
import { LeadsController } from "./leads.controller"

@Module({
  controllers: [LeadsController],
  providers: [JourneyService, LeadTimers],
  exports: [JourneyService],
})
export class LeadsModule {}
