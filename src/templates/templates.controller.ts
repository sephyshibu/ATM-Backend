import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Req } from "@nestjs/common"

import { CurrentUser, RequirePermissions } from "../common/decorators"
import { badRequest } from "../common/errors"
import { requestIp, type AppRequest, type RequestUser } from "../common/request-user"
import { CreateTemplateDto, PreviewDto, SaveDraftDto, SetRuleDto, TEMPLATE_KINDS, type TemplateKind } from "./templates.dto"
import { TemplatesService } from "./templates.service"

// Email templates and the template matrix. Looking needs "View brands and people"; writing needs "Write
// templates", approving "Approve templates" (never one's own), and the matrix "Edit the template matrix" (checked
// in the service, so the screens can show what each person may do).

@Controller("templates")
export class TemplatesController {
  constructor(private readonly templates: TemplatesService) {}

  @Get()
  @RequirePermissions("records.view")
  list() {
    return this.templates.list()
  }

  @Get("merge-fields")
  @RequirePermissions("records.view")
  mergeFields() {
    return this.templates.mergeFields()
  }

  @Get("matrix")
  @RequirePermissions("records.view")
  matrix() {
    return this.templates.matrix()
  }

  @Put("matrix")
  @RequirePermissions("records.view")
  setRule(@Body() dto: SetRuleDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.templates.setRule(dto, me, requestIp(req))
  }

  @Post("matrix/:id/remove")
  @RequirePermissions("records.view")
  removeRule(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.templates.removeRule(id, me, requestIp(req))
  }

  /** Which templates a brand gets, why, and every email filled with its details. */
  @Get("brands/:brandId")
  @RequirePermissions("records.view")
  forBrand(@Param("brandId", ParseUUIDPipe) brandId: string) {
    return this.templates.forBrand(brandId)
  }

  /** Unsaved wording filled with a brand's details (the editor's preview). Writes nothing. */
  @Post("preview/:kind")
  @RequirePermissions("records.view")
  preview(@Param("kind") kind: string, @Body() dto: PreviewDto) {
    if (!TEMPLATE_KINDS.includes(kind as TemplateKind)) throw badRequest("Unknown template kind.")
    return this.templates.preview(kind as TemplateKind, dto)
  }

  @Post()
  @RequirePermissions("records.view")
  create(@Body() dto: CreateTemplateDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.templates.create(dto, me, requestIp(req))
  }

  @Get(":id")
  @RequirePermissions("records.view")
  get(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser) {
    return this.templates.get(id, me)
  }

  /** Saves the draft (a new draft version when none is open). */
  @Put(":id/draft")
  @RequirePermissions("records.view")
  saveDraft(@Param("id", ParseUUIDPipe) id: string, @Body() dto: SaveDraftDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.templates.saveDraft(id, dto, me, requestIp(req))
  }

  @Post("versions/:id/approve")
  @RequirePermissions("records.view")
  approve(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.templates.approve(id, me, requestIp(req))
  }

  @Post("versions/:id/discard")
  @RequirePermissions("records.view")
  discard(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.templates.discard(id, me, requestIp(req))
  }

  @Post(":id/archive")
  @RequirePermissions("records.view")
  archive(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.templates.archive(id, me, requestIp(req))
  }

  @Post(":id/restore")
  @RequirePermissions("records.view")
  restore(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.templates.restore(id, me, requestIp(req))
  }
}
