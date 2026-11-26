import { Module } from "@nestjs/common"

import { KnowledgeModule } from "../knowledge/knowledge.module"
import { GatesService } from "./gates.service"
import { JourneyService } from "./journey.service"
import { LeadTimers } from "./lead-timers"
import { GatesController, LeadsController } from "./leads.controller"

@Module({
  imports: [KnowledgeModule],
  controllers: [LeadsController, GatesController],
  providers: [JourneyService, GatesService, LeadTimers],
  exports: [JourneyService, GatesService],
})
export class LeadsModule {}
