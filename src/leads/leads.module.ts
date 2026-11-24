import { Module } from "@nestjs/common"

import { GatesService } from "./gates.service"
import { JourneyService } from "./journey.service"
import { LeadTimers } from "./lead-timers"
import { GatesController, LeadsController } from "./leads.controller"

@Module({
  controllers: [LeadsController, GatesController],
  providers: [JourneyService, GatesService, LeadTimers],
  exports: [JourneyService, GatesService],
})
export class LeadsModule {}
