import { createParamDecorator, ExecutionContext, SetMetadata } from "@nestjs/common"

import type { AppRequest, RequestUser } from "../request-user"

export const IS_PUBLIC = "atm:public"
export const PERMISSIONS_KEY = "atm:permissions"

/** No sign-in needed (the sign-in endpoints themselves, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true)

/** The signed-in person must hold every listed permission. */
export const RequirePermissions = (...keys: string[]) => SetMetadata(PERMISSIONS_KEY, keys)

/** The signed-in person (always set behind the session guard). */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): RequestUser => {
  const req = ctx.switchToHttp().getRequest<AppRequest>()
  return req.user!
})
