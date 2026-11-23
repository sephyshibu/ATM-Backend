import { Injectable } from "@nestjs/common"
import type { Prisma, SettingDefinition } from "@prisma/client"

import { AuditService } from "../audit/audit.service"
import { badRequest, conflict, notFound } from "../common/errors"
import type { RequestUser } from "../common/request-user"
import { PrismaService } from "../prisma/prisma.service"
import type { CreateListValueDto, UpdateListValueDto } from "./settings.dto"

const show = (v: unknown) => (v === null || v === undefined ? "—" : typeof v === "string" ? v : JSON.stringify(v))

/** Checks a value against its definition and returns it in its stored form. */
function validate(def: SettingDefinition, value: unknown): string | number | boolean {
  switch (def.type) {
    case "integer": {
      const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value
      if (typeof n !== "number" || !Number.isInteger(n)) throw badRequest(`${def.label}: enter a whole number.`)
      if (def.min !== null && n < def.min) throw badRequest(`${def.label}: the lowest allowed is ${def.min}.`)
      if (def.max !== null && n > def.max) throw badRequest(`${def.label}: the highest allowed is ${def.max}.`)
      return n
    }
    case "boolean":
      if (typeof value !== "boolean") throw badRequest(`${def.label}: choose on or off.`)
      return value
    case "month_day": {
      const s = String(value ?? "").trim()
      const m = /^(\d{2})-(\d{2})$/.exec(s)
      const ok = m && Number(m[1]) >= 1 && Number(m[1]) <= 12 && Number(m[2]) >= 1 && Number(m[2]) <= new Date(2024, Number(m[1]), 0).getDate()
      if (!ok) throw badRequest(`${def.label}: pick a day of the year.`)
      return s
    }
    case "time": {
      const s = String(value ?? "").trim()
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) throw badRequest(`${def.label}: enter a time like 07:00.`)
      return s
    }
    default: {
      const s = String(value ?? "").trim()
      if (!s) throw badRequest(`${def.label} can't be empty.`)
      if (s.length > 200) throw badRequest(`${def.label} is too long.`)
      if (def.key === "company.timezone") {
        try {
          new Intl.DateTimeFormat("en", { timeZone: s })
        } catch {
          throw badRequest(`${s} isn't a time zone. Use a name like Asia/Kolkata or Europe/London.`)
        }
      }
      if (def.key === "company.work_days") {
        const days = s.split(",").map((d) => d.trim())
        if (!days.length || days.some((d) => !/^[1-7]$/.test(d)) || new Set(days).size !== days.length) throw badRequest("Working days: numbers 1 (Monday) to 7 (Sunday), separated by commas, e.g. 1,2,3,4,5.")
        return [...days].sort().join(",")
      }
      return s
    }
  }
}

/**
 * Configuration values and pick-lists. A value change adds a new version (the old ones stay as history); a list
 * value is retired, never deleted, so records that use it still read right.
 */
@Injectable()
export class SettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- Configuration values

  async config() {
    const defs = await this.prisma.settingDefinition.findMany({ orderBy: { sortOrder: "asc" }, include: { values: { orderBy: { version: "desc" }, take: 1 } } })
    const people = await this.peopleNames(defs.map((d) => d.values[0]?.createdById))
    return defs.map((d) => {
      const cur = d.values[0]
      return {
        key: d.key,
        group: d.groupName,
        label: d.label,
        description: d.description,
        type: d.type,
        unit: d.unit,
        min: d.min,
        max: d.max,
        value: cur?.value ?? null,
        version: cur?.version ?? 0,
        changedAt: cur?.createdAt ?? null,
        changedBy: cur?.createdById ? (people.get(cur.createdById) ?? null) : null,
      }
    })
  }

  async history(key: string) {
    const def = await this.prisma.settingDefinition.findUnique({ where: { key } })
    if (!def) throw notFound("That setting")
    const rows = await this.prisma.settingValue.findMany({ where: { key }, orderBy: { version: "desc" } })
    const people = await this.peopleNames(rows.map((r) => r.createdById))
    return rows.map((r) => ({ version: r.version, value: r.value, reason: r.reason, at: r.createdAt, by: r.createdById ? (people.get(r.createdById) ?? null) : "Seed" }))
  }

  async updateConfig(key: string, raw: unknown, reason: string | undefined, me: RequestUser, ip: string | null) {
    await this.prisma.$transaction(async (tx) => {
      const def = await tx.settingDefinition.findUnique({ where: { key } })
      if (!def) throw notFound("That setting")
      const value = validate(def, raw)
      const cur = await tx.settingValue.findFirst({ where: { key }, orderBy: { version: "desc" } })
      if (cur && cur.value === value) return
      await tx.settingValue.create({ data: { key, version: (cur?.version ?? 0) + 1, value, reason: reason ?? "", createdById: me.id } })
      await this.audit.record(
        { actor: me, section: "Configuration", action: `Changed ${def.label.toLowerCase()}`, entityType: "setting", entityId: key, before: `${show(cur?.value)} ${def.unit}`.trim(), after: `${show(value)} ${def.unit}`.trim(), reason, ip },
        tx,
      )
    })
    return (await this.config()).find((c) => c.key === key)
  }

  // ---------------------------------------------------------------- Pick-lists

  async lists(includeRetired: boolean) {
    const lists = await this.prisma.listDefinition.findMany({
      orderBy: { sortOrder: "asc" },
      include: { values: { where: includeRetired ? {} : { retiredAt: null }, orderBy: [{ sortOrder: "asc" }, { label: "asc" }] } },
    })
    return lists.map((l) => ({
      key: l.key,
      label: l.label,
      description: l.description,
      parentListKey: l.parentListKey,
      values: l.values.map((v) => ({ id: v.id, code: v.code, label: v.label, description: v.description, parentId: v.parentId, sortOrder: v.sortOrder, retired: !!v.retiredAt, retiredAt: v.retiredAt, updatedAt: v.updatedAt })),
    }))
  }

  private async listValue(id: string, db: Prisma.TransactionClient) {
    const v = await db.listValue.findUnique({ where: { id }, include: { list: true } })
    if (!v) throw notFound("That value")
    return v
  }

  async addValue(listKey: string, dto: CreateListValueDto, me: RequestUser, ip: string | null) {
    const id = await this.prisma.$transaction(async (tx) => {
      const list = await tx.listDefinition.findUnique({ where: { key: listKey } })
      if (!list) throw notFound("That list")
      let parentLabel: string | undefined
      let parentCode = ""
      if (list.parentListKey) {
        if (!dto.parentId) throw badRequest(`Choose which ${list.parentListKey.replace(/_/g, " ")} it belongs to.`)
        const parent = await tx.listValue.findUnique({ where: { id: dto.parentId } })
        if (!parent || parent.listKey !== list.parentListKey || parent.retiredAt) throw badRequest("That parent value doesn't exist or was retired.")
        parentLabel = parent.label
        parentCode = `${parent.code}_`
      } else if (dto.parentId) throw badRequest("This list has no parent.")

      const sameLabel = await tx.listValue.findFirst({ where: { listKey, retiredAt: null, label: { equals: dto.label, mode: "insensitive" }, parentId: dto.parentId ?? null } })
      if (sameLabel) throw conflict(`${sameLabel.label} is already in the list.`)

      // A stable code from the label (a sub-category's starts with its category's code: BE_SKINCARE).
      const base = (dto.code ?? `${parentCode}${dto.label}`.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")).slice(0, 40) || "VALUE"
      let code = base
      for (let n = 2; await tx.listValue.findUnique({ where: { listKey_code: { listKey, code } } }); n++) {
        if (dto.code) throw conflict(`The code ${dto.code} is taken in this list.`)
        code = `${base.slice(0, 36)}_${n}`
      }
      const last = await tx.listValue.findFirst({ where: { listKey }, orderBy: { sortOrder: "desc" } })
      const v = await tx.listValue.create({
        data: { listKey, code, label: dto.label, description: dto.description ?? "", parentId: dto.parentId ?? null, sortOrder: (last?.sortOrder ?? 0) + 10, createdById: me.id, updatedById: me.id },
      })
      await this.audit.record(
        { actor: me, section: "Lists", action: `Added ${v.label} to ${list.label}`, entityType: "list_value", entityId: v.id, after: [`Code: ${code}`, parentLabel ? `Under: ${parentLabel}` : ""].filter(Boolean).join("\n"), ip },
        tx,
      )
      return v.id
    })
    return this.prisma.listValue.findUnique({ where: { id } })
  }

  async updateValue(id: string, dto: UpdateListValueDto, me: RequestUser, ip: string | null) {
    await this.prisma.$transaction(async (tx) => {
      const v = await this.listValue(id, tx)
      const before: string[] = []
      const after: string[] = []
      const data: Prisma.ListValueUpdateInput = {}
      if (dto.label !== undefined && dto.label !== v.label) {
        const clash = await tx.listValue.findFirst({ where: { listKey: v.listKey, retiredAt: null, id: { not: id }, parentId: v.parentId, label: { equals: dto.label, mode: "insensitive" } } })
        if (clash) throw conflict(`${clash.label} is already in the list.`)
        data.label = dto.label
        before.push(`Name: ${v.label}`)
        after.push(`Name: ${dto.label}`)
      }
      if (dto.description !== undefined && dto.description !== v.description) {
        data.description = dto.description
        before.push(`Description: ${v.description || "—"}`)
        after.push(`Description: ${dto.description || "—"}`)
      }
      if (dto.sortOrder !== undefined && dto.sortOrder !== v.sortOrder) data.sortOrder = dto.sortOrder
      if (!Object.keys(data).length) return
      await tx.listValue.update({ where: { id }, data: { ...data, updatedById: me.id } })
      if (before.length)
        await this.audit.record({ actor: me, section: "Lists", action: `Changed ${v.label} in ${v.list.label}`, entityType: "list_value", entityId: id, before: before.join("\n"), after: after.join("\n"), ip }, tx)
    })
    return this.prisma.listValue.findUnique({ where: { id } })
  }

  async retireValue(id: string, reason: string | undefined, me: RequestUser, ip: string | null) {
    await this.prisma.$transaction(async (tx) => {
      const v = await this.listValue(id, tx)
      if (v.retiredAt) return
      const children = await tx.listValue.count({ where: { parentId: id, retiredAt: null } })
      if (children) throw badRequest(`${children === 1 ? "1 value sits" : `${children} values sit`} under ${v.label}. Retire or move them first.`)
      const left = await tx.listValue.count({ where: { listKey: v.listKey, retiredAt: null, id: { not: id } } })
      if (!left) throw badRequest(`${v.list.label} needs at least one value.`)
      await tx.listValue.update({ where: { id }, data: { retiredAt: new Date(), retiredById: me.id, updatedById: me.id } })
      await this.audit.record({ actor: me, section: "Lists", action: `Retired ${v.label} from ${v.list.label}`, entityType: "list_value", entityId: id, before: "In use", after: "Retired", reason, ip }, tx)
    })
    return this.prisma.listValue.findUnique({ where: { id } })
  }

  async restoreValue(id: string, me: RequestUser, ip: string | null) {
    await this.prisma.$transaction(async (tx) => {
      const v = await this.listValue(id, tx)
      if (!v.retiredAt) return
      if (v.parentId) {
        const parent = await tx.listValue.findUnique({ where: { id: v.parentId } })
        if (parent?.retiredAt) throw badRequest(`Restore ${parent.label} first.`)
      }
      const clash = await tx.listValue.findFirst({ where: { listKey: v.listKey, retiredAt: null, parentId: v.parentId, label: { equals: v.label, mode: "insensitive" } } })
      if (clash) throw conflict(`${clash.label} is already in the list. Rename one of them first.`)
      await tx.listValue.update({ where: { id }, data: { retiredAt: null, retiredById: null, updatedById: me.id } })
      await this.audit.record({ actor: me, section: "Lists", action: `Restored ${v.label} in ${v.list.label}`, entityType: "list_value", entityId: id, before: "Retired", after: "In use", ip }, tx)
    })
    return this.prisma.listValue.findUnique({ where: { id } })
  }

  private async peopleNames(ids: (string | null | undefined)[]) {
    const unique = [...new Set(ids.filter((x): x is string => !!x))]
    const users = unique.length ? await this.prisma.user.findMany({ where: { id: { in: unique } }, select: { id: true, name: true } }) : []
    return new Map(users.map((u) => [u.id, u.name]))
  }
}
