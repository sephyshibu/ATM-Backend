import type { PrismaClient } from "@prisma/client"

import { PERMISSIONS } from "../common/permissions"

// Run at every start-up (and by the seed). Both steps are safe to repeat.
//
// 1. The change log is append-only: a trigger refuses UPDATE and DELETE on audit_event, whoever asks.
//    For full protection on the live system, also run the app as a database user without TRUNCATE rights.
// 2. The permission catalogue in the database follows src/common/permissions.ts: new keys are added, labels
//    updated, and keys taken out of the code are marked retired (never deleted, so role history stays readable).

const APPEND_ONLY_SQL = [
  `CREATE OR REPLACE FUNCTION audit_event_append_only() RETURNS trigger AS $$
   BEGIN
     RAISE EXCEPTION 'audit_event is append-only: % is not allowed', TG_OP;
   END;
   $$ LANGUAGE plpgsql`,
  // PostgreSQL 14 or later.
  `CREATE OR REPLACE TRIGGER audit_event_no_change BEFORE UPDATE OR DELETE ON audit_event
   FOR EACH ROW EXECUTE FUNCTION audit_event_append_only()`,
]

export async function hardenDatabase(prisma: PrismaClient) {
  for (const sql of APPEND_ONLY_SQL) await prisma.$executeRawUnsafe(sql)
}

export async function syncPermissionCatalogue(prisma: PrismaClient) {
  const known = new Set<string>()
  for (const [i, p] of PERMISSIONS.entries()) {
    known.add(p.key)
    const data = { groupName: p.group, label: p.label, description: p.description, sortOrder: i, retiredAt: p.retired ? new Date() : null }
    await prisma.permission.upsert({ where: { key: p.key }, create: { key: p.key, ...data }, update: data })
  }
  await prisma.permission.updateMany({ where: { key: { notIn: [...known] }, retiredAt: null }, data: { retiredAt: new Date() } })
}
