import { Module } from "@nestjs/common"

import { BrandsService } from "./brands.service"
import { OrganisationsService } from "./organisations.service"
import { PeopleService } from "./people.service"
import { ProductsService } from "./products.service"
import { RecordsController } from "./records.controller"
import { TagsService } from "./tags.service"

@Module({
  controllers: [RecordsController],
  providers: [BrandsService, OrganisationsService, PeopleService, ProductsService, TagsService],
  exports: [BrandsService, OrganisationsService, PeopleService, ProductsService, TagsService],
})
export class RecordsModule {}
