import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from "@nestjs/common"
import { Reflector } from "@nestjs/core"

import { SessionService } from "../../auth/session.service"
import { IS_PUBLIC, PERMISSIONS_KEY } from "../decorators"
import type { AppRequest } from "../request-user"

/**
 * Every request: a valid session for an active person, unless the route is @Public(). Then, if the route lists
 * permissions, the person must hold all of them. Checked on the server for every screen and API call alike.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(ctx: ExecutionContext) {
    const targets = [ctx.getHandler(), ctx.getClass()]
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true

    const req = ctx.switchToHttp().getRequest<AppRequest>()
    const user = await this.sessions.userFromRequest(req)
    if (!user) throw new UnauthorizedException("Please sign in.")
    req.user = user

    const needed = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, targets) ?? []
    const missing = needed.filter((k) => !user.permissions.has(k))
    if (missing.length) throw new ForbiddenException("Your roles don't allow this.")
    return true
  }
}
