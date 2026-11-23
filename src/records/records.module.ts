import { Module } from "@nestjs/common"

import { BrandsService } from "./brands.service"
import { OrganisationsService } from "./organisations.service"
import { PeopleService } from "./people.service"
import { RecordsController } from "./records.controller"

@Module({
  controllers: [RecordsController],
  providers: [BrandsService, OrganisationsService, PeopleService],
  exports: [BrandsService, OrganisationsService, PeopleService],
})
export class RecordsModule {}
