import { Controller, Get, Query } from "@nestjs/common"

import { RequirePermissions } from "../common/decorators"
import { AuditService } from "./audit.service"

@Controller("audit")
@RequirePermissions("audit.view")
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /** The change log, newest first, a page at a time (pass `before` = the last id you got). */
  @Get()
  list(
    @Query("section") section?: string,
    @Query("actorId") actorId?: string,
    @Query("entityType") entityType?: string,
    @Query("entityId") entityId?: string,
    @Query("search") search?: string,
    @Query("days") days?: string,
    @Query("before") before?: string,
    @Query("limit") limit?: string,
  ) {
    const d = Number(days)
    const l = Math.min(Math.max(Number(limit) || 100, 1), 500)
    return this.audit.list({
      section: section || undefined,
      actorId: actorId || undefined,
      entityType: entityType || undefined,
      entityId: entityId || undefined,
      search: search?.trim() || undefined,
      since: Number.isFinite(d) && d > 0 ? new Date(Date.now() - d * 86_400_000) : undefined,
      before: before && /^\d+$/.test(before) ? BigInt(before) : undefined,
      limit: l,
    })
  }

  @Get("sections")
  sections() {
    return this.audit.sections()
  }
}
