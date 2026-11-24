import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Req } from "@nestjs/common"

import { CurrentUser, RequirePermissions } from "../common/decorators"
import { requestIp, type AppRequest, type RequestUser } from "../common/request-user"
import { JourneyService } from "./journey.service"
import { GatesService } from "./gates.service"
import { BulkMoveDto, EventDto, MoveDto, OpenLeadDto, OverrideDto, SetGateDto, SetPersonDto, UndoDto, UpdateGateDefinitionDto } from "./leads.dto"

// Leads: one brand in one journey, Register → Target → Contacted → Warm → Hot → SQL, with side lanes. Looking
// needs "View brands and people". Each move checks its own permission in the journey engine (Target moves,
// reply outcomes, call outcomes); undo and override need their own permissions.

@Controller("leads")
export class LeadsController {
  constructor(
    private readonly journey: JourneyService,
    private readonly gates: GatesService,
  ) {}

  @Get()
  @RequirePermissions("records.view")
  list() {
    return this.journey.list()
  }

  @Get("journey")
  @RequirePermissions("records.view")
  stages() {
    return this.journey.journey()
  }

  @Get("brand/:brandId")
  @RequirePermissions("records.view")
  forBrand(@Param("brandId", ParseUUIDPipe) brandId: string, @CurrentUser() me: RequestUser) {
    return this.journey.forBrand(brandId, me)
  }

  @Post("brand/:brandId")
  @RequirePermissions("records.edit")
  open(@Param("brandId", ParseUUIDPipe) brandId: string, @Body() dto: OpenLeadDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.journey.open(brandId, dto, me, requestIp(req))
  }

  /** Opens a Register lead for every active brand that never had one. */
  @Post("open-missing")
  @RequirePermissions("records.edit")
  openMissing(@CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.journey.openMissing(me, requestIp(req))
  }

  @Post("bulk-move")
  @RequirePermissions("records.view")
  bulkMove(@Body() dto: BulkMoveDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    const { leadIds, ...move } = dto
    return this.journey.bulkMove(leadIds, move, me, requestIp(req))
  }

  @Get(":id")
  @RequirePermissions("records.view")
  get(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser) {
    return this.journey.get(id, me)
  }

  /** The lead's gates (a checklist), both recommendations and each gate's history. */
  @Get(":id/gates")
  @RequirePermissions("records.view")
  leadGates(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser) {
    return this.gates.forLead(id, me)
  }

  /** Sets a gate's value, tick or evidence. Desk gates need "Change desk gates", call gates "Change call gates". */
  @Patch(":id/gates/:code")
  @RequirePermissions("records.view")
  async setGate(@Param("id", ParseUUIDPipe) id: string, @Param("code") code: string, @Body() dto: SetGateDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    await this.gates.set(id, code, dto, me, requestIp(req))
    return this.gates.forLead(id, me)
  }

  @Post(":id/move")
  @RequirePermissions("records.view")
  move(@Param("id", ParseUUIDPipe) id: string, @Body() dto: MoveDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.journey.move(id, dto, me, requestIp(req))
  }

  /** Records a buyer event by hand, to test the journey before outreach and bookings are connected. */
  @Post(":id/event")
  @RequirePermissions("control.override")
  event(@Param("id", ParseUUIDPipe) id: string, @Body() dto: EventDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.journey.event(id, dto, me, requestIp(req))
  }

  @Post(":id/override")
  @RequirePermissions("control.override")
  override(@Param("id", ParseUUIDPipe) id: string, @Body() dto: OverrideDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.journey.override(id, dto, me, requestIp(req))
  }

  @Post(":id/undo")
  @RequirePermissions("control.undo")
  undo(@Param("id", ParseUUIDPipe) id: string, @Body() dto: UndoDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.journey.undo(id, dto, me, requestIp(req))
  }

  @Patch(":id/person")
  @RequirePermissions("records.edit")
  setPerson(@Param("id", ParseUUIDPipe) id: string, @Body() dto: SetPersonDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.journey.setPerson(id, dto.personId ?? null, me, requestIp(req))
  }
}

/** Settings → Gates: the six gate definitions. */
@Controller("gates")
export class GatesController {
  constructor(private readonly gates: GatesService) {}

  @Get()
  @RequirePermissions("settings.view")
  list() {
    return this.gates.definitions()
  }

  @Patch(":code")
  @RequirePermissions("settings.edit")
  update(@Param("code") code: string, @Body() dto: UpdateGateDefinitionDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.gates.updateDefinition(code, dto, me, requestIp(req))
  }
}
