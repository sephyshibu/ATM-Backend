import { Module } from "@nestjs/common"

import { KnowledgeModule } from "../knowledge/knowledge.module"
import { LeadsModule } from "../leads/leads.module"
import { BrandsService } from "./brands.service"
import { CustomFieldsService } from "./custom-fields.service"
import { FieldRulesService } from "./field-rules.service"
import { ImportFilesService } from "./import-files.service"
import { ImportService } from "./import.service"
import { OrganisationsService } from "./organisations.service"
import { PeopleService } from "./people.service"
import { ProductsService } from "./products.service"
import { RecordsController } from "./records.controller"
import { TagsService } from "./tags.service"

@Module({
  imports: [LeadsModule, KnowledgeModule],
  controllers: [RecordsController],
  providers: [BrandsService, OrganisationsService, PeopleService, ProductsService, TagsService, CustomFieldsService, ImportService, FieldRulesService, ImportFilesService],
  exports: [BrandsService, OrganisationsService, PeopleService, ProductsService, TagsService, CustomFieldsService, ImportService, FieldRulesService],
})
export class RecordsModule {}
