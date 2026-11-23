import { Injectable } from "@nestjs/common"
import type { Prisma } from "@prisma/client"

import { AuditService } from "../audit/audit.service"
import { badRequest } from "../common/errors"
import type { RequestUser } from "../common/request-user"
import { PrismaService } from "../prisma/prisma.service"

// Tags: free labels from the "tag" list (master data in Settings → Lists → Tags) put on an organisation, a brand or
// a product. One record_tag row per tag on a record; taking a tag off sets removed_at, so the history stays.

export type TaggedType = "organisation" | "brand" | "product"
export type TagRef = { code: string; label: string }

const LIST = "tag"

@Injectable()
export class TagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Adds the tag change to a record's change-log lines. */
  static merge(d: { changed: boolean; before: string | null; after: string | null }, t: { before: string; after: string } | null) {
    if (!t) return d
    const join = (a: string | null, b: string) => [a, b].filter(Boolean).join("\n")
    return { changed: true, before: join(d.before, `Tags: ${t.before}`), after: join(d.after, `Tags: ${t.after}`) }
  }

  /** The tags currently on each record, by record id. */
  async forEntities(type: TaggedType, ids: string[], db: Prisma.TransactionClient = this.prisma): Promise<Map<string, TagRef[]>> {
    const out = new Map<string, TagRef[]>(ids.map((id) => [id, []]))
    if (!ids.length) return out
    const rows = await db.recordTag.findMany({
      where: { entityType: type, entityId: { in: ids }, removedAt: null },
      include: { tag: { select: { code: true, label: true } } },
      orderBy: { tag: { label: "asc" } },
    })
    for (const r of rows) out.get(r.entityId)?.push({ code: r.tag.code, label: r.tag.label })
    return out
  }

  async forEntity(type: TaggedType, id: string, db: Prisma.TransactionClient = this.prisma) {
    return (await this.forEntities(type, [id], db)).get(id) ?? []
  }

  /**
   * Makes the record's tags exactly `codes`. New tags must be active list values; a retired tag already on the
   * record may stay. Returns the before/after labels for the caller's change-log line, or null if nothing changed.
   */
  async set(db: Prisma.TransactionClient, type: TaggedType, id: string, codes: string[] | undefined, me: RequestUser) {
    if (codes === undefined) return null
    const wanted = [...new Set(codes.map((c) => c.trim()).filter(Boolean))]
    const current = await db.recordTag.findMany({ where: { entityType: type, entityId: id, removedAt: null }, include: { tag: true } })
    const values = wanted.length ? await db.listValue.findMany({ where: { listKey: LIST, code: { in: wanted } } }) : []
    for (const code of wanted) {
      const v = values.find((x) => x.code === code)
      if (!v) throw badRequest(`There's no tag with the code ${code}.`)
      if (v.retiredAt && !current.some((c) => c.tagId === v.id)) throw badRequest(`The tag ${v.label} is retired. Restore it in Settings → Lists to use it again.`)
    }
    const toRemove = current.filter((c) => !wanted.includes(c.tag.code))
    const toAdd = values.filter((v) => !current.some((c) => c.tagId === v.id))
    if (!toRemove.length && !toAdd.length) return null
    if (toRemove.length) await db.recordTag.updateMany({ where: { id: { in: toRemove.map((r) => r.id) } }, data: { removedAt: new Date(), removedById: me.id } })
    if (toAdd.length) await db.recordTag.createMany({ data: toAdd.map((v) => ({ tagId: v.id, entityType: type, entityId: id, addedById: me.id })) })
    const before = current.map((c) => c.tag.label).sort()
    const after = [...current.filter((c) => !toRemove.includes(c)).map((c) => c.tag.label), ...toAdd.map((v) => v.label)].sort()
    return { before: before.join(", ") || "—", after: after.join(", ") || "—" }
  }

  /** Adds a tag to the master list while tagging. A tag with the same name is reused instead of doubled. */
  async create(label: string, me: RequestUser, ip: string | null): Promise<TagRef> {
    const name = label.trim().replace(/\s+/g, " ")
    if (!name) throw badRequest("Give the tag a name.")
    return this.prisma.$transaction(async (tx) => {
      const same = await tx.listValue.findFirst({ where: { listKey: LIST, label: { equals: name, mode: "insensitive" } } })
      if (same) {
        if (same.retiredAt) throw badRequest(`The tag ${same.label} is retired. Restore it in Settings → Lists to use it again.`)
        return { code: same.code, label: same.label }
      }
      const base = name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "TAG"
      let code = base
      for (let n = 2; await tx.listValue.findUnique({ where: { listKey_code: { listKey: LIST, code } } }); n++) code = `${base.slice(0, 36)}_${n}`
      const last = await tx.listValue.findFirst({ where: { listKey: LIST }, orderBy: { sortOrder: "desc" } })
      const v = await tx.listValue.create({ data: { listKey: LIST, code, label: name, sortOrder: (last?.sortOrder ?? 0) + 10, createdById: me.id, updatedById: me.id } })
      await this.audit.record({ actor: me, section: "Lists", action: `Added ${name} to Tags`, entityType: "list_value", entityId: v.id, after: `Code: ${code}`, ip }, tx)
      return { code: v.code, label: v.label }
    })
  }
}
