import { Injectable } from "@nestjs/common"
import type { Prisma } from "@prisma/client"

import { PrismaService } from "../prisma/prisma.service"

export type AuditInput = {
  actor: { id: string; name: string; email: string } | { id?: undefined; label: string }
  section: string
  action: string
  entityType?: string
  entityId?: string
  before?: string | null
  after?: string | null
  reason?: string | null
  ip?: string | null
}

type Db = PrismaService | Prisma.TransactionClient

/** Writes to the append-only change log. Pass the transaction client so the entry commits with the change. */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: AuditInput, db: Db = this.prisma) {
    const actor = input.actor
    await db.auditEvent.create({
      data: {
        actorId: actor.id ?? null,
        actorLabel: "label" in actor ? actor.label : `${actor.name} <${actor.email}>`,
        section: input.section,
        action: input.action,
        entityType: input.entityType ?? null,
        entityId: input.entityId ?? null,
        before: input.before || null,
        after: input.after || null,
        reason: input.reason || null,
        ip: input.ip ?? null,
      },
    })
  }

  async list(q: { section?: string; actorId?: string; entityType?: string; entityId?: string; search?: string; since?: Date; before?: bigint; limit: number }) {
    const where: Prisma.AuditEventWhereInput = {
      ...(q.section ? { section: q.section } : {}),
      ...(q.actorId ? { actorId: q.actorId } : {}),
      ...(q.entityType ? { entityType: q.entityType } : {}),
      ...(q.entityId ? { entityId: q.entityId } : {}),
      ...(q.since ? { at: { gte: q.since } } : {}),
      ...(q.before ? { id: { lt: q.before } } : {}),
      ...(q.search
        ? {
            OR: [
              { action: { contains: q.search, mode: "insensitive" } },
              { actorLabel: { contains: q.search, mode: "insensitive" } },
              { before: { contains: q.search, mode: "insensitive" } },
              { after: { contains: q.search, mode: "insensitive" } },
              { reason: { contains: q.search, mode: "insensitive" } },
            ],
          }
        : {}),
    }
    const rows = await this.prisma.auditEvent.findMany({ where, orderBy: { id: "desc" }, take: q.limit + 1 })
    const more = rows.length > q.limit
    const page = rows.slice(0, q.limit)
    return {
      entries: page.map((e) => ({ ...e, id: e.id.toString() })),
      next: more ? page[page.length - 1].id.toString() : null,
    }
  }

  async sections() {
    const rows = await this.prisma.auditEvent.findMany({ distinct: ["section"], select: { section: true }, orderBy: { section: "asc" } })
    return rows.map((r) => r.section)
  }
}
