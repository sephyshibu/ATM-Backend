import { Module } from "@nestjs/common"

import { JourneyService } from "./journey.service"
import { LeadsController } from "./leads.controller"

@Module({
  controllers: [LeadsController],
  providers: [JourneyService],
  exports: [JourneyService],
})
export class LeadsModule {}
