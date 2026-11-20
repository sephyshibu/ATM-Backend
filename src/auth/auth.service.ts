import { ForbiddenException, Injectable } from "@nestjs/common"
import type { Request, Response } from "express"

import { AuditService } from "../audit/audit.service"
import { requestIp } from "../common/request-user"
import { PrismaService } from "../prisma/prisma.service"
import type { GoogleIdentity } from "./google.service"
import { SessionService } from "./session.service"
import { hashToken } from "./tokens"

/**
 * Invite-only sign-in. Nobody can sign up: an admin invites an email, and the person signs in with the Google
 * account for that email. The first sign-in turns the invite into an active account and ties it to that Google
 * account; a different Google account with the same email is refused afterwards.
 */
@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  async signIn(identity: GoogleIdentity, req: Request, res: Response) {
    const email = identity.email.trim().toLowerCase()
    const user = await this.prisma.user.findUnique({ where: { email } })
    const ip = requestIp(req)

    const refuse = async (message: string, why: string) => {
      await this.audit.record({ actor: { label: email }, section: "Sign-in", action: "Sign-in refused", after: why, ip })
      throw new ForbiddenException(message)
    }

    if (!user) return refuse(`${email} hasn't been invited to the ATM CRM. Ask an admin to invite you.`, "Not invited")
    if (user.status === "deactivated") return refuse("Your account has been deactivated. Ask an admin if you need access again.", "Deactivated")
    if (user.status === "invited" && user.inviteExpiresAt && user.inviteExpiresAt.getTime() < Date.now())
      return refuse("Your invite has expired. Ask an admin to send it again.", "Invite expired")
    if (user.googleSub && user.googleSub !== identity.sub)
      return refuse("This email is already linked to a different Google account.", "Different Google account")

    const first = user.status === "invited"
    const now = new Date()
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          lastSignInAt: now,
          ...(first ? { status: "active", activatedAt: now, inviteTokenHash: null } : {}),
          ...(!user.googleSub ? { googleSub: identity.sub } : {}),
        },
      })
      await this.audit.record(
        { actor: user, section: "Sign-in", action: first ? "Accepted the invite and signed in" : "Signed in", after: "via Google", entityType: "user", entityId: user.id, ip },
        tx,
      )
    })
    await this.sessions.start(user.id, req, res)
  }

  async signOut(user: { id: string; name: string; email: string }, req: Request, res: Response) {
    await this.sessions.end(req, res)
    await this.audit.record({ actor: user, section: "Sign-in", action: "Signed out", entityType: "user", entityId: user.id, ip: requestIp(req) })
  }

  /** What the invite link shows before signing in: who invited whom, as what. Nothing private. */
  async inviteInfo(token: string) {
    const user = await this.prisma.user.findUnique({
      where: { inviteTokenHash: hashToken(token) },
      include: { invitedBy: { select: { name: true } }, roles: { where: { revokedAt: null, role: { archivedAt: null } }, include: { role: { select: { name: true } } } } },
    })
    if (!user || user.status !== "invited") return { valid: false as const, reason: "used_or_unknown" as const }
    if (user.inviteExpiresAt && user.inviteExpiresAt.getTime() < Date.now()) return { valid: false as const, reason: "expired" as const }
    return {
      valid: true as const,
      name: user.name,
      email: user.email,
      invitedBy: user.invitedBy?.name ?? "ATM",
      roles: user.roles.map((r) => r.role.name),
      expiresAt: user.inviteExpiresAt,
    }
  }
}
