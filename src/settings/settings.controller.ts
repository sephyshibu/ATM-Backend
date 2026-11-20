import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Query, Req } from "@nestjs/common"

import { CurrentUser, RequirePermissions } from "../common/decorators"
import { requestIp, type AppRequest, type RequestUser } from "../common/request-user"
import { ReasonDto } from "../users/users.dto"
import { CreateListValueDto, UpdateListValueDto, UpdateSettingDto } from "./settings.dto"
import { SettingsService } from "./settings.service"

@Controller("settings")
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get("config")
  @RequirePermissions("settings.view")
  config() {
    return this.settings.config()
  }

  @Get("config/:key/history")
  @RequirePermissions("settings.view")
  history(@Param("key") key: string) {
    return this.settings.history(key)
  }

  @Put("config/:key")
  @RequirePermissions("settings.edit")
  update(@Param("key") key: string, @Body() dto: UpdateSettingDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.settings.updateConfig(key, dto.value, dto.reason, me, requestIp(req))
  }

  @Get("lists")
  @RequirePermissions("settings.view")
  lists(@Query("retired") retired?: string) {
    return this.settings.lists(retired === "true")
  }

  @Post("lists/:listKey/values")
  @RequirePermissions("settings.edit")
  addValue(@Param("listKey") listKey: string, @Body() dto: CreateListValueDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.settings.addValue(listKey, dto, me, requestIp(req))
  }

  @Patch("list-values/:id")
  @RequirePermissions("settings.edit")
  updateValue(@Param("id", ParseUUIDPipe) id: string, @Body() dto: UpdateListValueDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.settings.updateValue(id, dto, me, requestIp(req))
  }

  @Post("list-values/:id/retire")
  @RequirePermissions("settings.edit")
  retire(@Param("id", ParseUUIDPipe) id: string, @Body() dto: ReasonDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.settings.retireValue(id, dto.reason, me, requestIp(req))
  }

  @Post("list-values/:id/restore")
  @RequirePermissions("settings.edit")
  restore(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.settings.restoreValue(id, me, requestIp(req))
  }
}
