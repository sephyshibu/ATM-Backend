import { Injectable } from "@nestjs/common"
import type { Prisma } from "@prisma/client"

import { ADMIN_POWER } from "../common/permissions"
import { appConfig } from "../config"
import { PrismaService } from "../prisma/prisma.service"

type Db = PrismaService | Prisma.TransactionClient

export type HeldRole = { id: string; name: string; testOnly: boolean; permissions: string[] }

/**
 * What a person may do: the union of the permissions of every role they hold now (not revoked, not archived).
 * On the live system (APP_ENV=production) a test-only role grants nothing.
 */
@Injectable()
export class AccessService {
  constructor(private readonly prisma: PrismaService) {}

  async heldRoles(userId: string, db: Db = this.prisma): Promise<HeldRole[]> {
    const grants = await db.userRole.findMany({
      where: { userId, revokedAt: null, role: { archivedAt: null } },
      include: { role: { include: { permissions: { where: { permission: { retiredAt: null } } } } } },
      orderBy: { grantedAt: "asc" },
    })
    return grants.map((g) => ({ id: g.role.id, name: g.role.name, testOnly: g.role.testOnly, permissions: g.role.permissions.map((p) => p.permissionKey) }))
  }

  effective(roles: HeldRole[]) {
    const production = appConfig().production
    const out = new Set<string>()
    for (const r of roles) if (!(r.testOnly && production)) r.permissions.forEach((p) => out.add(p))
    return out
  }

  /**
   * Lock-out protection: after a change, at least one active person must still hold every ADMIN_POWER
   * permission, or nobody could manage users and roles again. Run inside the change's transaction.
   */
  async assertSomeoneCanAdminister(db: Db) {
    const production = appConfig().production
    const users = await db.user.findMany({
      where: { status: "active" },
      select: {
        id: true,
        roles: {
          where: { revokedAt: null, role: { archivedAt: null, ...(production ? { testOnly: false } : {}) } },
          select: { role: { select: { permissions: { select: { permissionKey: true } } } } },
        },
      },
    })
    const ok = users.some((u) => {
      const keys = new Set(u.roles.flatMap((r) => r.role.permissions.map((p) => p.permissionKey)))
      return ADMIN_POWER.every((k) => keys.has(k))
    })
    return ok
  }
}
