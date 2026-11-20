import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from "@nestjs/common"

import { CurrentUser, RequirePermissions } from "../common/decorators"
import { requestIp, type AppRequest, type RequestUser } from "../common/request-user"
import { InviteUserDto, ReasonDto, UpdateUserDto } from "./users.dto"
import { UsersService } from "./users.service"

@Controller("users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermissions("settings.view")
  list() {
    return this.users.list()
  }

  @Get(":id")
  @RequirePermissions("settings.view")
  get(@Param("id", ParseUUIDPipe) id: string) {
    return this.users.get(id)
  }

  @Post("invite")
  @RequirePermissions("users.manage")
  invite(@Body() dto: InviteUserDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.users.invite(dto, me, requestIp(req))
  }

  @Patch(":id")
  @RequirePermissions("users.manage")
  update(@Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateUserDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.users.update(id, dto, me, requestIp(req))
  }

  @Post(":id/resend-invite")
  @RequirePermissions("users.manage")
  resend(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.users.resendInvite(id, me, requestIp(req))
  }

  /** Deactivates an active person, or cancels a pending invite. */
  @Post(":id/deactivate")
  @RequirePermissions("users.manage")
  deactivate(@Param("id", ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.users.deactivate(id, dto.reason, me, requestIp(req))
  }

  @Post(":id/reactivate")
  @RequirePermissions("users.manage")
  reactivate(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.users.reactivate(id, me, requestIp(req))
  }
}
