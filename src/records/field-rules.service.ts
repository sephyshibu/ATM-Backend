import { Injectable } from "@nestjs/common"
import type { Prisma } from "@prisma/client"

import { AuditService } from "../audit/audit.service"
import { badRequest } from "../common/errors"
import type { RequestUser } from "../common/request-user"
import { PrismaService } from "../prisma/prisma.service"
import { BUILT_IN_FIELDS, CUSTOM_ENTITIES, type CustomEntity } from "./custom-fields.service"

// Settings → Fields: which built-in fields are required. The code gives each field a default (BUILT_IN_FIELDS);
// a person with Settings rights can switch it for any field that isn't locked, and it is logged.
// A rule applies to records added or imported from then on, and to a field when someone edits it: records that are
// already saved are never changed, and editing some other field of an old record isn't blocked by it.

type Db = Prisma.TransactionClient

const isEmpty = (v: unknown) => v === null || v === undefined || (typeof v === "string" && v.trim() === "") || (Array.isArray(v) && v.length === 0)

@Injectable()
export class FieldRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The keys of an entity's built-in fields that are required now. */
  async required(db: Db, entity: CustomEntity): Promise<Set<string>> {
    const rules = await db.fieldRule.findMany({ where: { entity } })
    const out = new Set<string>()
    for (const f of BUILT_IN_FIELDS[entity]) {
      const r = f.locked ? undefined : rules.find((x) => x.key === f.key)
      if (r ? r.required : f.required) out.add(f.key)
    }
    return out
  }

  /** Every entity's required keys (for the forms and the import). */
  async requiredAll(db: Db = this.prisma) {
    const rules = await db.fieldRule.findMany()
    return Object.fromEntries(
      CUSTOM_ENTITIES.map((entity) => [
        entity,
        BUILT_IN_FIELDS[entity]
          .filter((f) => {
            const r = f.locked ? undefined : rules.find((x) => x.entity === entity && x.key === f.key)
            return r ? r.required : f.required
          })
          .map((f) => f.key),
      ]),
    ) as Record<CustomEntity, string[]>
  }

  /** Settings → Fields: the built-in fields with their current rule. */
  async list() {
    const rules = await this.prisma.fieldRule.findMany()
    return Object.fromEntries(
      CUSTOM_ENTITIES.map((entity) => [
        entity,
        BUILT_IN_FIELDS[entity].map((f) => {
          const r = f.locked ? undefined : rules.find((x) => x.entity === entity && x.key === f.key)
          return { ...f, defaultRequired: f.required, required: r ? r.required : f.required, locked: !!f.locked }
        }),
      ]),
    )
  }

  /** Switches one field's Required (logged; a reason is optional). */
  async set(entity: string, key: string, required: boolean, reason: string, me: RequestUser, ip: string | null) {
    if (!CUSTOM_ENTITIES.includes(entity as CustomEntity)) throw badRequest("That isn't a kind of record.")
    const field = BUILT_IN_FIELDS[entity as CustomEntity].find((f) => f.key === key)
    if (!field) throw badRequest("That field doesn't exist.")
    if (field.locked) throw badRequest(`${field.label} can't be changed: the system needs it ${field.required ? "on every record" : "as it is"}.`)
    await this.prisma.$transaction(async (tx) => {
      const before = (await this.required(tx, entity as CustomEntity)).has(key)
      if (before === required) return
      await tx.fieldRule.upsert({ where: { entity_key: { entity, key } }, create: { entity, key, required, updatedById: me.id }, update: { required, updatedById: me.id } })
      const kind = { organisation: "Organisation", brand: "Brand", product: "Product", person: "Person" }[entity as CustomEntity]
      await this.audit.record({ actor: me, section: "Fields", action: `${kind} field ${field.label}: ${required ? "required" : "optional"}`, entityType: "field_rule", entityId: `${entity}.${key}`, before: `Required: ${before ? "Yes" : "No"}`, after: `Required: ${required ? "Yes" : "No"}`, reason: reason.trim() || null, ip }, tx)
    })
    return this.list()
  }

  /**
   * Refuses a record that leaves a required field empty. `after` holds each field as it will be (by built-in key).
   * On an edit (`before` given) a field is refused only when it had a value and is being emptied, so records saved
   * before a field became required can still be edited and get the value when someone has it.
   */
  async assertFilled(db: Db, entity: CustomEntity, after: Record<string, unknown>, before: Record<string, unknown> | null) {
    const required = await this.required(db, entity)
    const missing = BUILT_IN_FIELDS[entity].filter((f) => required.has(f.key) && f.key in after && isEmpty(after[f.key]) && (before === null || !isEmpty(before[f.key])))
    if (missing.length) throw badRequest(`${missing.map((f) => f.label).join(", ")} ${missing.length === 1 ? "is" : "are"} required. (Settings → Fields says which fields are required.)`)
  }
}
