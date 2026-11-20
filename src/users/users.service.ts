import { Injectable } from "@nestjs/common"
import type { Prisma } from "@prisma/client"

import { AuditService } from "../audit/audit.service"
import { AccessService } from "../auth/access.service"
import { SessionService } from "../auth/session.service"
import { hashToken, newToken } from "../auth/tokens"
import { badRequest, conflict, notFound } from "../common/errors"
import type { RequestUser } from "../common/request-user"
import { appConfig } from "../config"
import { MailService } from "../mail/mail.service"
import { PrismaService } from "../prisma/prisma.service"
import type { InviteUserDto, UpdateUserDto } from "./users.dto"

const DAY = 86_400_000

const LOCKOUT = "At least one active person must keep the power to manage users and roles. Give it to someone else first."

const userInclude = {
  invitedBy: { select: { id: true, name: true } },
  deactivatedBy: { select: { id: true, name: true } },
  roles: { where: { revokedAt: null, role: { archivedAt: null } }, include: { role: { select: { id: true, name: true, testOnly: true } } }, orderBy: { grantedAt: "asc" } },
} satisfies Prisma.UserInclude

type UserRow = Prisma.UserGetPayload<{ include: typeof userInclude }>

/** A person as the screens see them: never the token hash or Google id. */
const view = (u: UserRow) => ({
  id: u.id,
  email: u.email,
  name: u.name,
  title: u.title,
  status: u.status,
  roles: u.roles.map((r) => r.role),
  invitedAt: u.invitedAt,
  invitedBy: u.invitedBy,
  inviteExpiresAt: u.inviteExpiresAt,
  inviteExpired: u.status === "invited" && !!u.inviteExpiresAt && u.inviteExpiresAt.getTime() < Date.now(),
  activatedAt: u.activatedAt,
  lastSignInAt: u.lastSignInAt,
  deactivatedAt: u.deactivatedAt,
  deactivatedBy: u.deactivatedBy,
  deactivationReason: u.deactivationReason,
  googleLinked: !!u.googleSub,
  createdAt: u.createdAt,
})

/**
 * Users: invite, edit details and roles, resend or cancel an invite, deactivate and reactivate.
 * Nobody is ever deleted: a deactivated person can't sign in, and their name stays on everything they did.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
    private readonly sessions: SessionService,
    private readonly mail: MailService,
  ) {}

  async list() {
    const users = await this.prisma.user.findMany({ include: userInclude, orderBy: [{ status: "asc" }, { name: "asc" }] })
    return users.map(view)
  }

  async get(id: string) {
    const u = await this.prisma.user.findUnique({ where: { id }, include: userInclude })
    if (!u) throw notFound("That person")
    return view(u)
  }

  private async checkRoles(roleIds: string[], db: Prisma.TransactionClient) {
    const unique = [...new Set(roleIds)]
    const roles = await db.role.findMany({ where: { id: { in: unique }, archivedAt: null }, select: { id: true, name: true } })
    if (roles.length !== unique.length) throw badRequest("One of those roles doesn't exist or was archived. Refresh and try again.")
    return roles
  }

  private inviteLink(token: string) {
    return `${appConfig().frontendUrl}/invite/${token}`
  }

  private async sendInvite(user: { name: string; email: string }, token: string, expires: Date, roles: string[], invitedBy: string) {
    const link = this.inviteLink(token)
    const mail = this.mail.inviteEmail({ name: user.name, invitedBy, roles, link, expires })
    const sent = await this.mail.send(user.email, mail.subject, mail.text, mail.html)
    // When emails are only logged (development), hand the link back so the admin can pass it on.
    return { delivered: sent.delivered, inviteLink: appConfig().mail.transport === "log" ? link : undefined }
  }

  async invite(dto: InviteUserDto, me: RequestUser, ip: string | null) {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } })
    if (existing?.status === "invited") throw conflict(`${dto.email} is already invited. Send the invite again from their row.`)
    if (existing?.status === "deactivated") throw conflict(`${dto.email} has an account that was deactivated. Reactivate it instead.`)
    if (existing) throw conflict(`${dto.email} already has an account.`)

    const token = newToken()
    const expires = new Date(Date.now() + appConfig().inviteDays * DAY)
    const created = await this.prisma.$transaction(async (tx) => {
      const roles = await this.checkRoles(dto.roleIds, tx)
      const user = await tx.user.create({
        data: { email: dto.email, name: dto.name, title: dto.title ?? "", status: "invited", invitedAt: new Date(), invitedById: me.id, inviteTokenHash: hashToken(token), inviteExpiresAt: expires },
      })
      if (roles.length) await tx.userRole.createMany({ data: roles.map((r) => ({ userId: user.id, roleId: r.id, grantedById: me.id })) })
      await this.audit.record(
        {
          actor: me,
          section: "Users",
          action: `Invited ${user.name}`,
          entityType: "user",
          entityId: user.id,
          after: [`Email: ${user.email}`, `Title: ${user.title || "—"}`, `Roles: ${roles.map((r) => r.name).join(", ") || "No role yet"}`].join("\n"),
          ip,
        },
        tx,
      )
      return { user, roles }
    })
    const delivery = await this.sendInvite(created.user, token, expires, created.roles.map((r) => r.name), me.name)
    return { user: await this.get(created.user.id), ...delivery }
  }

  async resendInvite(id: string, me: RequestUser, ip: string | null) {
    const user = await this.prisma.user.findUnique({ where: { id }, include: userInclude })
    if (!user) throw notFound("That person")
    if (user.status !== "invited") throw badRequest("Only people who haven't accepted their invite yet can get it again.")
    const token = newToken()
    const expires = new Date(Date.now() + appConfig().inviteDays * DAY)
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({ where: { id }, data: { inviteTokenHash: hashToken(token), inviteExpiresAt: expires, invitedAt: new Date(), invitedById: me.id } })
      await this.audit.record({ actor: me, section: "Users", action: `Sent ${user.name}'s invite again`, entityType: "user", entityId: id, after: `Valid until ${expires.toISOString().slice(0, 10)}. Earlier links no longer work.`, ip }, tx)
    })
    const delivery = await this.sendInvite(user, token, expires, user.roles.map((r) => r.role.name), me.name)
    return { user: await this.get(id), ...delivery }
  }

  async update(id: string, dto: UpdateUserDto, me: RequestUser, ip: string | null) {
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id }, include: userInclude })
      if (!user) throw notFound("That person")
      if (user.status === "deactivated") throw badRequest("Reactivate them before changing their details or roles.")

      const before: string[] = []
      const after: string[] = []
      const data: Prisma.UserUpdateInput = {}
      if (dto.name !== undefined && dto.name !== user.name) {
        data.name = dto.name
        before.push(`Name: ${user.name}`)
        after.push(`Name: ${dto.name}`)
      }
      if (dto.title !== undefined && dto.title !== user.title) {
        data.title = dto.title
        before.push(`Title: ${user.title || "—"}`)
        after.push(`Title: ${dto.title || "—"}`)
      }
      if (Object.keys(data).length) await tx.user.update({ where: { id }, data })

      if (dto.roleIds) {
        const wanted = await this.checkRoles(dto.roleIds, tx)
        const held = user.roles.map((r) => r.role)
        const add = wanted.filter((r) => !held.some((h) => h.id === r.id))
        const remove = held.filter((h) => !wanted.some((r) => r.id === h.id))
        if (add.length || remove.length) {
          if (remove.length)
            await tx.userRole.updateMany({ where: { userId: id, roleId: { in: remove.map((r) => r.id) }, revokedAt: null }, data: { revokedAt: new Date(), revokedById: me.id } })
          if (add.length) await tx.userRole.createMany({ data: add.map((r) => ({ userId: id, roleId: r.id, grantedById: me.id })) })
          before.push(`Roles: ${held.map((r) => r.name).join(", ") || "No role"}`)
          after.push(`Roles: ${wanted.map((r) => r.name).join(", ") || "No role"}`)
          if (!(await this.access.assertSomeoneCanAdminister(tx))) throw badRequest(LOCKOUT)
        }
      }
      if (!after.length) return
      await this.audit.record({ actor: me, section: "Users", action: `Changed ${dto.name ?? user.name}`, entityType: "user", entityId: id, before: before.join("\n"), after: after.join("\n"), ip }, tx)
    })
    return this.get(id)
  }

  async deactivate(id: string, reason: string | undefined, me: RequestUser, ip: string | null) {
    if (id === me.id) throw badRequest("You can't deactivate yourself. Ask another admin.")
    await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id } })
      if (!user) throw notFound("That person")
      if (user.status === "deactivated") return
      const wasInvite = user.status === "invited"
      await tx.user.update({ where: { id }, data: { status: "deactivated", deactivatedAt: new Date(), deactivatedById: me.id, deactivationReason: reason || null, inviteTokenHash: null } })
      if (!(await this.access.assertSomeoneCanAdminister(tx))) throw badRequest(LOCKOUT)
      await this.audit.record(
        { actor: me, section: "Users", action: wasInvite ? `Cancelled ${user.name}'s invite` : `Deactivated ${user.name}`, entityType: "user", entityId: id, before: wasInvite ? "Invited" : "Active", after: "Deactivated", reason, ip },
        tx,
      )
    })
    await this.sessions.endAllFor(id)
    return this.get(id)
  }

  /**
   * Back to active if they had signed in before; otherwise back to invited with a fresh invite (the old link
   * was cancelled when they were deactivated).
   */
  async reactivate(id: string, me: RequestUser, ip: string | null) {
    const user = await this.prisma.user.findUnique({ where: { id }, include: userInclude })
    if (!user) throw notFound("That person")
    if (user.status !== "deactivated") throw badRequest("They're not deactivated.")
    const signedInBefore = !!user.activatedAt
    const token = newToken()
    const expires = new Date(Date.now() + appConfig().inviteDays * DAY)
    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id },
        data: {
          status: signedInBefore ? "active" : "invited",
          deactivatedAt: null,
          deactivatedById: null,
          deactivationReason: null,
          ...(signedInBefore ? {} : { inviteTokenHash: hashToken(token), inviteExpiresAt: expires, invitedAt: new Date(), invitedById: me.id }),
        },
      })
      await this.audit.record({ actor: me, section: "Users", action: `Reactivated ${user.name}`, entityType: "user", entityId: id, before: "Deactivated", after: signedInBefore ? "Active" : "Invited (new invite sent)", ip }, tx)
    })
    const delivery = signedInBefore ? {} : await this.sendInvite(user, token, expires, user.roles.map((r) => r.role.name), me.name)
    return { user: await this.get(id), ...delivery }
  }
}
