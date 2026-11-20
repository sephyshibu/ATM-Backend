import { Injectable } from "@nestjs/common"
import type { Prisma } from "@prisma/client"

import { AuditService } from "../audit/audit.service"
import { AccessService } from "../auth/access.service"
import { badRequest, conflict, notFound } from "../common/errors"
import type { RequestUser } from "../common/request-user"
import { PrismaService } from "../prisma/prisma.service"
import type { CreateRoleDto, UpdateRoleDto } from "./roles.dto"

const LOCKOUT = "At least one active person must keep the power to manage users and roles. This change would take it from the last one."

const roleInclude = {
  permissions: { select: { permissionKey: true } },
  users: { where: { revokedAt: null, user: { status: { not: "deactivated" } } }, select: { user: { select: { id: true, name: true, email: true, status: true } } } },
} satisfies Prisma.RoleInclude

type RoleRow = Prisma.RoleGetPayload<{ include: typeof roleInclude }>

const view = (r: RoleRow) => ({
  id: r.id,
  name: r.name,
  description: r.description,
  builtIn: r.builtIn,
  testOnly: r.testOnly,
  version: r.version,
  archived: !!r.archivedAt,
  archivedAt: r.archivedAt,
  updatedAt: r.updatedAt,
  permissionKeys: r.permissions.map((p) => p.permissionKey).sort(),
  holders: r.users.map((u) => u.user),
})

/** Roles carry permissions; people hold roles. Roles are archived, never deleted. */
@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly access: AccessService,
  ) {}

  async catalogue() {
    const perms = await this.prisma.permission.findMany({ where: { retiredAt: null }, orderBy: { sortOrder: "asc" } })
    return perms.map(({ key, groupName, label, description }) => ({ key, group: groupName, label, description }))
  }

  async list(includeArchived: boolean) {
    const roles = await this.prisma.role.findMany({ where: includeArchived ? {} : { archivedAt: null }, include: roleInclude, orderBy: [{ builtIn: "desc" }, { name: "asc" }] })
    return roles.map(view)
  }

  async get(id: string) {
    const r = await this.prisma.role.findUnique({ where: { id }, include: roleInclude })
    if (!r) throw notFound("That role")
    return view(r)
  }

  private async checkName(name: string, exceptId: string | null, db: Prisma.TransactionClient) {
    const clash = await db.role.findFirst({ where: { name: { equals: name, mode: "insensitive" }, archivedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) } })
    if (clash) throw conflict(`Another role is already called ${clash.name}.`)
  }

  private async checkPermissions(keys: string[], db: Prisma.TransactionClient) {
    const unique = [...new Set(keys)]
    const found = await db.permission.findMany({ where: { key: { in: unique }, retiredAt: null }, select: { key: true, label: true } })
    if (found.length !== unique.length) throw badRequest("One of those permissions doesn't exist. Refresh and try again.")
    return found
  }

  async create(dto: CreateRoleDto, me: RequestUser, ip: string | null) {
    const id = await this.prisma.$transaction(async (tx) => {
      await this.checkName(dto.name, null, tx)
      const perms = await this.checkPermissions(dto.permissionKeys, tx)
      const role = await tx.role.create({ data: { name: dto.name, description: dto.description ?? "", createdById: me.id, updatedById: me.id } })
      if (perms.length) await tx.rolePermission.createMany({ data: perms.map((p) => ({ roleId: role.id, permissionKey: p.key })) })
      await this.audit.record(
        { actor: me, section: "Roles & permissions", action: `Added the role ${role.name}`, entityType: "role", entityId: role.id, after: perms.map((p) => p.label).join("\n") || "No permissions", ip },
        tx,
      )
      return role.id
    })
    return this.get(id)
  }

  async update(id: string, dto: UpdateRoleDto, me: RequestUser, ip: string | null) {
    await this.prisma.$transaction(async (tx) => {
      const role = await tx.role.findUnique({ where: { id }, include: { permissions: { include: { permission: true } } } })
      if (!role) throw notFound("That role")
      if (role.archivedAt) throw badRequest("Restore the role before changing it.")

      const before: string[] = []
      const after: string[] = []
      const data: Prisma.RoleUpdateInput = {}
      if (dto.name !== undefined && dto.name !== role.name) {
        if (role.builtIn) throw badRequest("Built-in roles keep their name. Change the description or the permissions instead.")
        await this.checkName(dto.name, id, tx)
        data.name = dto.name
        before.push(`Name: ${role.name}`)
        after.push(`Name: ${dto.name}`)
      }
      if (dto.description !== undefined && dto.description !== role.description) {
        data.description = dto.description
        before.push(`Description: ${role.description || "—"}`)
        after.push(`Description: ${dto.description || "—"}`)
      }

      let permsChanged = false
      if (dto.permissionKeys) {
        const wanted = await this.checkPermissions(dto.permissionKeys, tx)
        const held = role.permissions.map((p) => ({ key: p.permissionKey, label: p.permission.label }))
        const add = wanted.filter((p) => !held.some((h) => h.key === p.key))
        const remove = held.filter((h) => !wanted.some((p) => p.key === h.key))
        if (add.length || remove.length) {
          permsChanged = true
          if (remove.length) await tx.rolePermission.deleteMany({ where: { roleId: id, permissionKey: { in: remove.map((p) => p.key) } } })
          if (add.length) await tx.rolePermission.createMany({ data: add.map((p) => ({ roleId: id, permissionKey: p.key })) })
          if (remove.length) before.push(...remove.map((p) => `Can: ${p.label}`))
          if (add.length) after.push(...add.map((p) => `Can: ${p.label}`))
        }
      }
      if (!before.length && !after.length) return
      await tx.role.update({ where: { id }, data: { ...data, version: { increment: 1 }, updatedById: me.id } })
      if (permsChanged && !(await this.access.assertSomeoneCanAdminister(tx))) throw badRequest(LOCKOUT)
      await this.audit.record(
        { actor: me, section: "Roles & permissions", action: `Changed the role ${dto.name ?? role.name}`, entityType: "role", entityId: id, before: before.join("\n") || null, after: after.join("\n") || null, ip },
        tx,
      )
    })
    return this.get(id)
  }

  async archive(id: string, reason: string | undefined, me: RequestUser, ip: string | null) {
    await this.prisma.$transaction(async (tx) => {
      const role = await tx.role.findUnique({ where: { id }, include: roleInclude })
      if (!role) throw notFound("That role")
      if (role.archivedAt) return
      if (role.builtIn) throw badRequest("Built-in roles can't be archived.")
      if (role.users.length) throw badRequest(`${role.users.length === 1 ? "1 person holds" : `${role.users.length} people hold`} this role. Take it off them first.`)
      await tx.role.update({ where: { id }, data: { archivedAt: new Date(), archivedById: me.id, updatedById: me.id } })
      await this.audit.record({ actor: me, section: "Roles & permissions", action: `Archived the role ${role.name}`, entityType: "role", entityId: id, before: "Active", after: "Archived", reason, ip }, tx)
    })
    return this.get(id)
  }

  async restore(id: string, me: RequestUser, ip: string | null) {
    await this.prisma.$transaction(async (tx) => {
      const role = await tx.role.findUnique({ where: { id } })
      if (!role) throw notFound("That role")
      if (!role.archivedAt) return
      await this.checkName(role.name, id, tx)
      await tx.role.update({ where: { id }, data: { archivedAt: null, archivedById: null, updatedById: me.id } })
      await this.audit.record({ actor: me, section: "Roles & permissions", action: `Restored the role ${role.name}`, entityType: "role", entityId: id, before: "Archived", after: "Active", ip }, tx)
    })
    return this.get(id)
  }
}
