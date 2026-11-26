import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query, Req, Res } from "@nestjs/common"
import { Throttle } from "@nestjs/throttler"
import type { Response } from "express"

import { CurrentUser, Public, RequirePermissions } from "../common/decorators"
import { requestIp, type AppRequest, type RequestUser } from "../common/request-user"
import { BookDto, CancelDto, EventTypeDto, RescheduleDto } from "./scheduling.dto"
import { SchedulingService } from "./scheduling.service"

// Booking pages. Signed-in people manage their own booking pages, bookings and Google Calendar link (each person
// only ever sees their own). The public booking page and the booker's manage link need no sign-in; they are
// rate-limited, and the manage link works only with its long random token.

@Controller("scheduling")
export class SchedulingController {
  constructor(private readonly s: SchedulingService) {}

  @Get("calendar")
  @RequirePermissions("records.view")
  calendar(@CurrentUser() me: RequestUser) {
    return this.s.connection(me)
  }

  /** The Google consent page to open (the browser goes there). */
  @Post("calendar/connect")
  @RequirePermissions("records.view")
  connect(@CurrentUser() me: RequestUser) {
    return this.s.connectUrl(me)
  }

  @Post("calendar/disconnect")
  @RequirePermissions("records.view")
  disconnect(@CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.s.disconnect(me, requestIp(req))
  }

  @Get("event-types")
  @RequirePermissions("records.view")
  eventTypes(@CurrentUser() me: RequestUser) {
    return this.s.eventTypes(me)
  }

  @Post("event-types")
  @RequirePermissions("records.view")
  create(@Body() dto: EventTypeDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.s.createEventType(dto, me, requestIp(req))
  }

  @Put("event-types/:id")
  @RequirePermissions("records.view")
  update(@Param("id", ParseUUIDPipe) id: string, @Body() dto: EventTypeDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.s.updateEventType(id, dto, me, requestIp(req))
  }

  @Post("event-types/:id/archive")
  @RequirePermissions("records.view")
  archive(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.s.archiveEventType(id, true, me, requestIp(req))
  }

  @Post("event-types/:id/restore")
  @RequirePermissions("records.view")
  restore(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.s.archiveEventType(id, false, me, requestIp(req))
  }

  @Get("bookings")
  @RequirePermissions("records.view")
  bookings(@CurrentUser() me: RequestUser, @Query("when") when?: string) {
    return this.s.bookings(me, when === "past" || when === "cancelled" ? when : "upcoming")
  }

  @Post("bookings/:id/cancel")
  @RequirePermissions("records.view")
  cancel(@Param("id", ParseUUIDPipe) id: string, @Body() dto: CancelDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.s.hostCancel(id, dto.reason, me, requestIp(req))
  }
}

/** Google's redirect after "Connect Google Calendar". Plain browser navigation: trusts the signed state. */
@Controller("calendar")
export class CalendarCallbackController {
  constructor(private readonly s: SchedulingService) {}

  @Public()
  @Get("google/callback")
  async callback(@Query("code") code: string | undefined, @Query("state") state: string | undefined, @Query("error") error: string | undefined, @Res() res: Response) {
    res.redirect(await this.s.callback(code, state, error))
  }
}

/** The public booking page and the booker's manage link. No sign-in. */
@Controller("public")
@Throttle({ default: { limit: 60, ttl: 60_000 } })
export class PublicBookingController {
  constructor(private readonly s: SchedulingService) {}

  @Public()
  @Get("book/:handle")
  info(@Param("handle") handle: string) {
    return this.s.publicInfo(handle)
  }

  @Public()
  @Get("book/:handle/slots")
  slots(@Param("handle") handle: string, @Query("from") from?: string, @Query("to") to?: string) {
    return this.s.publicSlots(handle, from, to)
  }

  @Public()
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  @Post("book/:handle")
  book(@Param("handle") handle: string, @Body() dto: BookDto, @Req() req: AppRequest) {
    return this.s.book(handle, dto, requestIp(req))
  }

  @Public()
  @Get("booking/:token")
  manage(@Param("token") token: string) {
    return this.s.manageInfo(token)
  }

  @Public()
  @Get("booking/:token/slots")
  manageSlots(@Param("token") token: string, @Query("from") from?: string, @Query("to") to?: string) {
    return this.s.manageSlots(token, from, to)
  }

  @Public()
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  @Post("booking/:token/reschedule")
  reschedule(@Param("token") token: string, @Body() dto: RescheduleDto, @Req() req: AppRequest) {
    return this.s.reschedule(token, dto.start, requestIp(req))
  }

  @Public()
  @Throttle({ default: { limit: 8, ttl: 60_000 } })
  @Post("booking/:token/cancel")
  cancel(@Param("token") token: string, @Body() dto: CancelDto, @Req() req: AppRequest) {
    return this.s.publicCancel(token, dto.reason, requestIp(req))
  }
}
