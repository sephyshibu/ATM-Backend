import { ForbiddenException, Injectable, NestMiddleware } from "@nestjs/common"
import type { NextFunction, Request, Response } from "express"

/**
 * A simple guard against cross-site requests: every change (POST, PATCH, PUT, DELETE) must carry the header
 * the web app always sends. Browsers don't let another site add custom headers without CORS approval, and CORS
 * only approves FRONTEND_URL. The session cookie is also SameSite=Lax.
 */
@Injectable()
export class CsrfMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next()
    if (req.headers["x-atm-client"] !== "web") throw new ForbiddenException("Missing client header.")
    next()
  }
}
