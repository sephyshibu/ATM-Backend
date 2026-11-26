import { Module } from "@nestjs/common"

import { DossiersService } from "./dossiers.service"
import { FactsService } from "./facts.service"
import { KnowledgeController } from "./knowledge.controller"
import { StorageService } from "./storage.service"

/** Dossiers (S3) and the knowledge base. Used by Records (imports) and Leads (the Target check). */
@Module({
  controllers: [KnowledgeController],
  providers: [StorageService, FactsService, DossiersService],
  exports: [StorageService, FactsService, DossiersService],
})
export class KnowledgeModule {}
