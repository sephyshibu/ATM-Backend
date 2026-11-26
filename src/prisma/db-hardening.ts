import type { PrismaClient } from "@prisma/client"

import { PERMISSIONS } from "../common/permissions"

// Run at every start-up (and by the seed). Both steps are safe to repeat.
//
// 1. The change log is append-only: a trigger refuses UPDATE and DELETE on audit_event, whoever asks.
//    For full protection on the live system, also run the app as a database user without TRUNCATE rights.
// 2. The permission catalogue in the database follows src/common/permissions.ts: new keys are added, labels
//    updated, and keys taken out of the code are marked retired (never deleted, so role history stays readable).
// 3. The knowledge base keeps its history: a saved fact's value, source and evidence can't be changed (a new
//    version is added instead), and facts and dossiers are never deleted. Skipped until the migration has created
//    the tables. (Only triggers here: an index made outside Prisma's migrations would look like drift to it.)

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

const KNOWLEDGE_SQL = [
  `CREATE OR REPLACE FUNCTION fact_keep_history() RETURNS trigger AS $$
   BEGIN
     IF TG_OP = 'DELETE' THEN
       RAISE EXCEPTION 'facts are never deleted';
     END IF;
     IF NEW.value IS DISTINCT FROM OLD.value OR NEW.source IS DISTINCT FROM OLD.source
        OR NEW.evidence_date IS DISTINCT FROM OLD.evidence_date OR NEW.brand_id IS DISTINCT FROM OLD.brand_id
        OR NEW.fact_key IS DISTINCT FROM OLD.fact_key OR NEW.entered_by_id IS DISTINCT FROM OLD.entered_by_id
        OR NEW.entered_at IS DISTINCT FROM OLD.entered_at THEN
       RAISE EXCEPTION 'a saved fact can''t be changed: add a new version instead';
     END IF;
     RETURN NEW;
   END;
   $$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE TRIGGER fact_keep_history BEFORE UPDATE OR DELETE ON fact FOR EACH ROW EXECUTE FUNCTION fact_keep_history()`,
  `CREATE OR REPLACE FUNCTION dossier_no_delete() RETURNS trigger AS $$
   BEGIN
     RAISE EXCEPTION 'dossiers are archived, never deleted';
   END;
   $$ LANGUAGE plpgsql`,
  `CREATE OR REPLACE TRIGGER dossier_no_delete BEFORE DELETE ON dossier FOR EACH ROW EXECUTE FUNCTION dossier_no_delete()`,
]

export async function hardenDatabase(prisma: PrismaClient) {
  for (const sql of APPEND_ONLY_SQL) await prisma.$executeRawUnsafe(sql)
  const [{ ready }] = await prisma.$queryRaw<{ ready: boolean }[]>`SELECT to_regclass('public.fact') IS NOT NULL AND to_regclass('public.dossier') IS NOT NULL AS ready`
  if (ready) for (const sql of KNOWLEDGE_SQL) await prisma.$executeRawUnsafe(sql)
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
