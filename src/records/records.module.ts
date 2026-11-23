import { Module } from "@nestjs/common"

import { LeadsModule } from "../leads/leads.module"
import { BrandsService } from "./brands.service"
import { CustomFieldsService } from "./custom-fields.service"
import { ImportService } from "./import.service"
import { OrganisationsService } from "./organisations.service"
import { PeopleService } from "./people.service"
import { ProductsService } from "./products.service"
import { RecordsController } from "./records.controller"
import { TagsService } from "./tags.service"

@Module({
  imports: [LeadsModule],
  controllers: [RecordsController],
  providers: [BrandsService, OrganisationsService, PeopleService, ProductsService, TagsService, CustomFieldsService, ImportService],
  exports: [BrandsService, OrganisationsService, PeopleService, ProductsService, TagsService, CustomFieldsService, ImportService],
})
export class RecordsModule {}
