// Seeds what the CRM needs to start: the permission catalogue, the built-in roles, the configuration values,
// the pick-lists and the first admins (SEED_ADMIN_EMAILS). Safe to run again: it only adds what is missing and
// never overwrites anything someone changed in Settings.
//
//   npx prisma db seed

import "dotenv/config"

import { PrismaClient } from "@prisma/client"

import { BUILT_IN_ROLES, PERMISSIONS } from "../src/common/permissions"
import { LISTS, SETTINGS } from "../src/common/settings-catalogue"
import { hardenDatabase, syncPermissionCatalogue } from "../src/prisma/db-hardening"

const prisma = new PrismaClient()
const SEED = "Seed <system>"

async function seedRoles() {
  const all = PERMISSIONS.filter((p) => !p.retired).map((p) => p.key)
  const ids = new Map<string, string>()
  for (const r of BUILT_IN_ROLES) {
    const existing = await prisma.role.findFirst({ where: { name: r.name, builtIn: true } })
    if (existing) {
      ids.set(r.name, existing.id)
      continue
    }
    const keys = r.permissions === "all" ? all : r.permissions
    const role = await prisma.role.create({ data: { name: r.name, description: r.description, builtIn: true, testOnly: !!r.testOnly } })
    await prisma.rolePermission.createMany({ data: keys.map((k) => ({ roleId: role.id, permissionKey: k })) })
    await prisma.auditEvent.create({ data: { actorLabel: SEED, section: "Roles & permissions", action: `Added the role ${r.name}`, entityType: "role", entityId: role.id, after: `${keys.length} permissions` } })
    ids.set(r.name, role.id)
    console.log(`  role: ${r.name}`)
  }
  return ids
}

/** The Tester role is no longer used: archive it (kept as history) if an earlier seed created it and nobody holds it. */
async function retireTester() {
  const tester = await prisma.role.findFirst({ where: { name: "Tester", builtIn: true, archivedAt: null } })
  if (!tester) return
  const held = await prisma.userRole.count({ where: { roleId: tester.id, revokedAt: null } })
  if (held) {
    console.warn(`  Tester role: ${held} people still hold it; take it off them in Settings, then run the seed again.`)
    return
  }
  await prisma.role.update({ where: { id: tester.id }, data: { archivedAt: new Date(), builtIn: false } })
  await prisma.auditEvent.create({ data: { actorLabel: SEED, section: "Roles & permissions", action: "Archived the role Tester", entityType: "role", entityId: tester.id, before: "Active", after: "Archived", reason: "Not used" } })
  console.log("  role: Tester archived")
}

async function seedSettings() {
  for (const [i, s] of SETTINGS.entries()) {
    const data = { groupName: s.group, label: s.label, description: s.description, type: s.type, unit: s.unit ?? "", min: s.min ?? null, max: s.max ?? null, sortOrder: i }
    // Definitions follow the code; the value is only set the first time.
    await prisma.settingDefinition.upsert({ where: { key: s.key }, create: { key: s.key, ...data }, update: data })
    const has = await prisma.settingValue.findFirst({ where: { key: s.key } })
    if (!has) {
      await prisma.settingValue.create({ data: { key: s.key, version: 1, value: s.default, reason: "Starting value" } })
      console.log(`  setting: ${s.key} = ${s.default}`)
    }
  }
}

async function seedLists() {
  for (const [i, l] of LISTS.entries()) {
    await prisma.listDefinition.upsert({
      where: { key: l.key },
      create: { key: l.key, label: l.label, description: l.description, parentListKey: l.parent ?? null, sortOrder: i },
      update: { label: l.label, description: l.description, parentListKey: l.parent ?? null, sortOrder: i },
    })
    for (const [j, v] of l.values.entries()) {
      const exists = await prisma.listValue.findUnique({ where: { listKey_code: { listKey: l.key, code: v.code } } })
      if (exists) continue
      let parentId: string | null = null
      if (v.parent && l.parent) {
        const parent = await prisma.listValue.findUnique({ where: { listKey_code: { listKey: l.parent, code: v.parent } } })
        parentId = parent?.id ?? null
      }
      await prisma.listValue.create({ data: { listKey: l.key, code: v.code, label: v.label, parentId, sortOrder: (j + 1) * 10 } })
    }
  }
  console.log("  lists: up to date")
}

async function seedAdmins(roleIds: Map<string, string>) {
  const emails = (process.env.SEED_ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean)
  if (!emails.length) {
    console.warn("  SEED_ADMIN_EMAILS is empty: no admin created. Nobody will be able to sign in.")
    return
  }
  const founder = roleIds.get("Founder")!
  for (const email of emails) {
    const existing = await prisma.user.findUnique({ where: { email } })
    if (existing) {
      // Already here: make sure they hold Founder (never touches a deactivated account).
      const holds = await prisma.userRole.findFirst({ where: { userId: existing.id, roleId: founder, revokedAt: null } })
      if (!holds && existing.status !== "deactivated") {
        await prisma.userRole.create({ data: { userId: existing.id, roleId: founder } })
        await prisma.auditEvent.create({ data: { actorLabel: SEED, section: "Users", action: `Changed ${existing.name}`, entityType: "user", entityId: existing.id, after: "Roles: added Founder" } })
        console.log(`  admin: ${email} now holds Founder`)
      }
      continue
    }
    const name = email.split("@")[0].replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
    // Invited with no expiry: the first sign-in with Google turns it into an active account.
    const user = await prisma.user.create({ data: { email, name, status: "invited", invitedAt: new Date() } })
    await prisma.userRole.create({ data: { userId: user.id, roleId: founder } })
    await prisma.auditEvent.create({ data: { actorLabel: SEED, section: "Users", action: `Invited ${name}`, entityType: "user", entityId: user.id, after: `Email: ${email}\nRoles: Founder` } })
    console.log(`  admin: ${email} (Founder) — sign in with Google to activate`)
  }
}

async function main() {
  console.log("Seeding ATM CRM…")
  await hardenDatabase(prisma)
  await syncPermissionCatalogue(prisma)
  const roles = await seedRoles()
  await retireTester()
  await seedSettings()
  await seedLists()
  await seedAdmins(roles)
  console.log("Done.")
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
