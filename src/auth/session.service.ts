import { Injectable } from "@nestjs/common"
import type { CookieOptions, Request, Response } from "express"

import type { RequestUser } from "../common/request-user"
import { appConfig } from "../config"
import { PrismaService } from "../prisma/prisma.service"
import { AccessService } from "./access.service"
import { hashToken, newToken, SESSION_COOKIE } from "./tokens"

const DAY = 86_400_000
/** Don't write last-seen on every request: once every few minutes is enough to keep the session sliding. */
const TOUCH_EVERY = 5 * 60_000

/**
 * Sign-in sessions live in the database, so deactivating someone or signing out ends them at once.
 * The cookie holds a random token; the database keeps only its hash. Sessions slide: each use pushes the
 * expiry SESSION_DAYS ahead.
 */
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: AccessService,
  ) {}

  private cookieOptions(): CookieOptions {
    return { httpOnly: true, sameSite: "lax", secure: appConfig().appEnv !== "development", path: "/", maxAge: appConfig().sessionDays * DAY }
  }

  async start(userId: string, req: Request, res: Response) {
    const token = newToken()
    await this.prisma.session.create({
      data: {
        tokenHash: hashToken(token),
        userId,
        expiresAt: new Date(Date.now() + appConfig().sessionDays * DAY),
        ip: (req.ip ?? "").slice(0, 64) || null,
        userAgent: (req.headers["user-agent"] ?? "").slice(0, 300) || null,
      },
    })
    res.cookie(SESSION_COOKIE, token, this.cookieOptions())
  }

  async end(req: Request, res: Response) {
    const token = req.cookies?.[SESSION_COOKIE]
    if (token) await this.prisma.session.updateMany({ where: { tokenHash: hashToken(token), revokedAt: null }, data: { revokedAt: new Date() } })
    res.clearCookie(SESSION_COOKIE, { ...this.cookieOptions(), maxAge: undefined })
  }

  /** Ends every session a person has (deactivation). */
  async endAllFor(userId: string) {
    await this.prisma.session.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } })
  }

  async userFromRequest(req: Request): Promise<RequestUser | null> {
    const token = req.cookies?.[SESSION_COOKIE]
    if (!token || typeof token !== "string") return null
    const session = await this.prisma.session.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } })
    const now = Date.now()
    if (!session || session.revokedAt || session.expiresAt.getTime() <= now || session.user.status !== "active") return null

    if (now - session.lastSeenAt.getTime() > TOUCH_EVERY) {
      await this.prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date(now), expiresAt: new Date(now + appConfig().sessionDays * DAY) } })
    }
    const roles = await this.access.heldRoles(session.userId)
    const u = session.user
    return {
      id: u.id,
      email: u.email,
      name: u.name,
      title: u.title,
      sessionId: session.id,
      roles: roles.map(({ id, name, testOnly }) => ({ id, name, testOnly })),
      permissions: this.access.effective(roles),
    }
  }
}
