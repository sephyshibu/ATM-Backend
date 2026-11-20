import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query, Req } from "@nestjs/common"

import { CurrentUser, RequirePermissions } from "../common/decorators"
import { requestIp, type AppRequest, type RequestUser } from "../common/request-user"
import { ReasonDto } from "../users/users.dto"
import { CreateRoleDto, UpdateRoleDto } from "./roles.dto"
import { RolesService } from "./roles.service"

@Controller("roles")
export class RolesController {
  constructor(private readonly roles: RolesService) {}

  /** The permission catalogue, in display order, grouped by `group`. */
  @Get("permissions")
  @RequirePermissions("settings.view")
  catalogue() {
    return this.roles.catalogue()
  }

  @Get()
  @RequirePermissions("settings.view")
  list(@Query("archived") archived?: string) {
    return this.roles.list(archived === "true")
  }

  @Get(":id")
  @RequirePermissions("settings.view")
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.roles.get(id)
  }

  @Post()
  @RequirePermissions("roles.manage")
  create(@Body() dto: CreateRoleDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.roles.create(dto, me, requestIp(req))
  }

  @Patch(":id")
  @RequirePermissions("roles.manage")
  update(@Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateRoleDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.roles.update(id, dto, me, requestIp(req))
  }

  @Post(":id/archive")
  @RequirePermissions("roles.manage")
  archive(@Param("id", ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.roles.archive(id, dto.reason, me, requestIp(req))
  }

  @Post(":id/restore")
  @RequirePermissions("roles.manage")
  restore(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.roles.restore(id, me, requestIp(req))
  }
}
