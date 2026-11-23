import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req } from "@nestjs/common"

import { COUNTRY_CODES } from "../common/countries"
import { CurrentUser, RequirePermissions } from "../common/decorators"
import { requestIp, type AppRequest, type RequestUser } from "../common/request-user"
import { PrismaService } from "../prisma/prisma.service"
import { BrandsService } from "./brands.service"
import { OrganisationsService } from "./organisations.service"
import { PeopleService } from "./people.service"
import { ProductsService } from "./products.service"
import {
  ArchiveDto,
  CreateBrandDto,
  CreateOrganisationDto,
  CreatePersonDto,
  CreateProductDto,
  CreateTagDto,
  LinkPersonDto,
  UpdateBrandDto,
  UpdateOrganisationDto,
  UpdatePersonDto,
  UpdateProductDto,
} from "./records.dto"
import { TagsService } from "./tags.service"

/** The pick-lists the Records screens use (retired values are included so old records still show their names). */
const LIST_KEYS = ["category", "sub_category", "routing", "tier", "buying_role", "consent_basis", "archive_reason", "tag"]

// Records: brands, organisations and people. Looking needs "View brands and people"; adding and
// changing needs "Edit brands and people"; archiving and restoring needs "Archive and restore records".

@Controller("records")
export class RecordsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly brands: BrandsService,
    private readonly organisations: OrganisationsService,
    private readonly people: PeopleService,
    private readonly products: ProductsService,
    private readonly tags: TagsService,
  ) {}

  /** Adds a tag to the Tags list while tagging (an existing tag with the same name is reused). */
  @Post("tags")
  @RequirePermissions("records.edit")
  createTag(@Body() dto: CreateTagDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.tags.create(dto.label, me, requestIp(req))
  }

  // ---------------------------------------------------------------- Products (each call returns the brand's products)

  @Post("brands/:id/products")
  @RequirePermissions("records.edit")
  createProduct(@Param("id", ParseUUIDPipe) id: string, @Body() dto: CreateProductDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.products.create(id, dto, me, requestIp(req))
  }

  @Patch("products/:id")
  @RequirePermissions("records.edit")
  updateProduct(@Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateProductDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.products.update(id, dto, me, requestIp(req))
  }

  @Post("products/:id/archive")
  @RequirePermissions("records.archive")
  archiveProduct(@Param("id", ParseUUIDPipe) id: string, @Body() dto: ArchiveDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.products.archive(id, dto, me, requestIp(req))
  }

  @Post("products/:id/restore")
  @RequirePermissions("records.archive")
  restoreProduct(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.products.restore(id, me, requestIp(req))
  }

  /** Everything the forms need to draw their choices: lists, countries and the people who can own a brand. */
  @Get("options")
  @RequirePermissions("records.view")
  async options() {
    const [values, users] = await Promise.all([
      this.prisma.listValue.findMany({ where: { listKey: { in: LIST_KEYS } }, orderBy: [{ sortOrder: "asc" }, { label: "asc" }], include: { parent: { select: { code: true } } } }),
      this.prisma.user.findMany({ where: { status: { not: "deactivated" } }, orderBy: { name: "asc" }, select: { id: true, name: true, email: true } }),
    ])
    const lists = Object.fromEntries(
      LIST_KEYS.map((k) => [k, values.filter((v) => v.listKey === k).map((v) => ({ code: v.code, label: v.label, parentCode: v.parent?.code ?? null, retired: !!v.retiredAt }))]),
    )
    return { lists, countries: [...COUNTRY_CODES], owners: users }
  }

  // ---------------------------------------------------------------- Brands

  @Get("brands")
  @RequirePermissions("records.view")
  listBrands(@Query("archived") archived?: string) {
    return this.brands.list(archived === "true")
  }

  /** Duplicate check while typing: ?domain=…&name=…&except=<brand id> */
  @Get("brands/check")
  @RequirePermissions("records.view")
  checkBrand(@Query("domain") domain?: string, @Query("name") name?: string, @Query("except") except?: string, @Query("organisationId") organisationId?: string) {
    const uuid = (v?: string) => (v && /^[0-9a-f-]{36}$/i.test(v) ? v : undefined)
    return this.brands.check(domain, name, uuid(except), uuid(organisationId))
  }

  @Get("brands/:id")
  @RequirePermissions("records.view")
  getBrand(@Param("id", ParseUUIDPipe) id: string) {
    return this.brands.get(id)
  }

  @Get("brands/:id/history")
  @RequirePermissions("records.view")
  brandHistory(@Param("id", ParseUUIDPipe) id: string) {
    return this.brands.history(id)
  }

  @Post("brands")
  @RequirePermissions("records.edit")
  createBrand(@Body() dto: CreateBrandDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.brands.create(dto, me, requestIp(req))
  }

  @Patch("brands/:id")
  @RequirePermissions("records.edit")
  updateBrand(@Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateBrandDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.brands.update(id, dto, me, requestIp(req))
  }

  @Post("brands/:id/archive")
  @RequirePermissions("records.archive")
  archiveBrand(@Param("id", ParseUUIDPipe) id: string, @Body() dto: ArchiveDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.brands.archive(id, dto, me, requestIp(req))
  }

  @Post("brands/:id/restore")
  @RequirePermissions("records.archive")
  restoreBrand(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.brands.restore(id, me, requestIp(req))
  }

  @Post("brands/:id/people")
  @RequirePermissions("records.edit")
  linkPerson(@Param("id", ParseUUIDPipe) id: string, @Body() dto: LinkPersonDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.brands.linkPerson(id, dto, me, requestIp(req))
  }

  @Post("brands/:id/people/:personId/unlink")
  @RequirePermissions("records.edit")
  unlinkPerson(@Param("id", ParseUUIDPipe) id: string, @Param("personId", ParseUUIDPipe) personId: string, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.brands.unlinkPerson(id, personId, me, requestIp(req))
  }

  // ---------------------------------------------------------------- Organisations

  @Get("organisations")
  @RequirePermissions("records.view")
  listOrganisations(@Query("archived") archived?: string) {
    return this.organisations.list(archived === "true")
  }

  @Get("organisations/:id")
  @RequirePermissions("records.view")
  getOrganisation(@Param("id", ParseUUIDPipe) id: string) {
    return this.organisations.get(id)
  }

  @Get("organisations/:id/history")
  @RequirePermissions("records.view")
  organisationHistory(@Param("id", ParseUUIDPipe) id: string) {
    return this.organisations.history(id)
  }

  @Post("organisations")
  @RequirePermissions("records.edit")
  createOrganisation(@Body() dto: CreateOrganisationDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.organisations.create(dto, me, requestIp(req))
  }

  @Patch("organisations/:id")
  @RequirePermissions("records.edit")
  updateOrganisation(@Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateOrganisationDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.organisations.update(id, dto, me, requestIp(req))
  }

  @Post("organisations/:id/archive")
  @RequirePermissions("records.archive")
  archiveOrganisation(@Param("id", ParseUUIDPipe) id: string, @Body() dto: ArchiveDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.organisations.archive(id, dto, me, requestIp(req))
  }

  @Post("organisations/:id/restore")
  @RequirePermissions("records.archive")
  restoreOrganisation(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.organisations.restore(id, me, requestIp(req))
  }

  // ---------------------------------------------------------------- People

  @Get("people")
  @RequirePermissions("records.view")
  listPeople(@Query("archived") archived?: string, @Query("organisationId") organisationId?: string) {
    return this.people.list(archived === "true", organisationId && /^[0-9a-f-]{36}$/i.test(organisationId) ? organisationId : undefined)
  }

  @Get("people/:id")
  @RequirePermissions("records.view")
  getPerson(@Param("id", ParseUUIDPipe) id: string) {
    return this.people.get(id)
  }

  @Post("people")
  @RequirePermissions("records.edit")
  createPerson(@Body() dto: CreatePersonDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.people.create(dto, me, requestIp(req))
  }

  @Patch("people/:id")
  @RequirePermissions("records.edit")
  updatePerson(@Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdatePersonDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.people.update(id, dto, me, requestIp(req))
  }

  @Post("people/:id/archive")
  @RequirePermissions("records.archive")
  archivePerson(@Param("id", ParseUUIDPipe) id: string, @Body() dto: ArchiveDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.people.archive(id, dto, me, requestIp(req))
  }

  @Post("people/:id/restore")
  @RequirePermissions("records.archive")
  restorePerson(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.people.restore(id, me, requestIp(req))
  }
}
