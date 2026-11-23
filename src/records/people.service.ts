import { Injectable } from "@nestjs/common"
import type { Person, Prisma } from "@prisma/client"

import { AuditService } from "../audit/audit.service"
import { badRequest, conflict, notFound } from "../common/errors"
import type { RequestUser } from "../common/request-user"
import { PrismaService } from "../prisma/prisma.service"
import { archiveData, checkCountry, checkListCode, describe, listLabels, normaliseEmail, normaliseUrl, restoreData, showCountry } from "./records-common"
import type { ArchiveDto, CreatePersonDto, PersonFields, UpdatePersonDto } from "./records.dto"

const SECTION = "Records"
const nameOf = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`.trim()

const linksInclude = {
  organisation: { select: { id: true, name: true } },
  brands: { where: { removedAt: null }, select: { isPrimary: true, brand: { select: { id: true, name: true, archivedAt: true } } } },
} satisfies Prisma.PersonInclude

type Row = Prisma.PersonGetPayload<{ include: typeof linksInclude }>
const view = ({ brands, ...p }: Row) => ({ ...p, archived: !!p.archivedAt, brands: brands.map((l) => ({ ...l.brand, isPrimary: l.isPrimary })) })

/** People at a brand's organisation: contacts for outreach and calls. An email belongs to one active person. */
@Injectable()
export class PeopleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async list(archived: boolean, organisationId?: string) {
    const rows = await this.prisma.person.findMany({
      where: { ...(archived ? {} : { archivedAt: null }), ...(organisationId ? { organisationId } : {}) },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
      include: linksInclude,
    })
    return rows.map(view)
  }

  async get(id: string) {
    const p = await this.prisma.person.findUnique({ where: { id }, include: linksInclude })
    if (!p) throw notFound("That person")
    return view(p)
  }

  private async prepare(dto: PersonFields, current: Person | null, db: Prisma.TransactionClient) {
    const data: Prisma.PersonUncheckedUpdateInput = {}
    if (dto.firstName !== undefined) {
      if (!dto.firstName.trim()) throw badRequest("Add a first name.")
      data.firstName = dto.firstName.trim()
    }
    if (dto.lastName !== undefined) data.lastName = dto.lastName
    if (dto.jobTitle !== undefined) data.jobTitle = dto.jobTitle
    if (dto.email !== undefined) {
      const email = normaliseEmail(dto.email)
      if (email) {
        const clash = await db.person.findFirst({ where: { email, archivedAt: null, ...(current ? { id: { not: current.id } } : {}) }, include: { organisation: true } })
        if (clash) throw conflict(`${email} already belongs to ${nameOf(clash)} at ${clash.organisation.name}.`)
      }
      data.email = email
      // A new address hasn't been checked yet.
      if (email !== current?.email && dto.emailStatus === undefined) data.emailStatus = "unknown"
    }
    if (dto.emailStatus !== undefined) data.emailStatus = dto.emailStatus
    if (dto.phone !== undefined) data.phone = dto.phone
    if (dto.linkedinUrl !== undefined) data.linkedinUrl = normaliseUrl(dto.linkedinUrl, "LinkedIn")
    if (dto.country !== undefined) data.country = checkCountry(dto.country, "Country")
    if (dto.buyingRoleCode !== undefined) data.buyingRoleCode = (await checkListCode(db, "buying_role", dto.buyingRoleCode, current?.buyingRoleCode, "Buying role")).code
    if (dto.consentCode !== undefined) data.consentCode = (await checkListCode(db, "consent_basis", dto.consentCode, current?.consentCode, "Consent")).code
    if (dto.notes !== undefined) data.notes = dto.notes
    return data
  }

  private async changes(before: Partial<Person>, after: Partial<Person>, db: Prisma.TransactionClient) {
    const [roles, consent] = await Promise.all([listLabels(db, "buying_role"), listLabels(db, "consent_basis")])
    const label = (m: Map<string, string>) => (v: unknown) => (v ? (m.get(v as string) ?? String(v)) : "—")
    const pick = <K extends keyof Person>(k: K) => (k in after ? after[k] : before[k])
    return describe([
      { label: "First name", before: before.firstName, after: pick("firstName") },
      { label: "Last name", before: before.lastName, after: pick("lastName") },
      { label: "Job title", before: before.jobTitle, after: pick("jobTitle") },
      { label: "Email", before: before.email, after: pick("email") },
      { label: "Email check", before: before.emailStatus, after: pick("emailStatus") },
      { label: "Phone", before: before.phone, after: pick("phone") },
      { label: "LinkedIn", before: before.linkedinUrl, after: pick("linkedinUrl") },
      { label: "Country", before: before.country, after: pick("country"), show: showCountry },
      { label: "Buying role", before: before.buyingRoleCode, after: pick("buyingRoleCode"), show: label(roles) },
      { label: "Consent", before: before.consentCode, after: pick("consentCode"), show: label(consent) },
      { label: "Notes", before: before.notes, after: pick("notes") },
    ])
  }

  async create(dto: CreatePersonDto, me: RequestUser, ip: string | null) {
    if (!dto.firstName?.trim()) throw badRequest("Add a first name.")
    const id = await this.prisma.$transaction(async (tx) => {
      const org = await tx.organisation.findUnique({ where: { id: dto.organisationId } })
      if (!org || org.archivedAt) throw badRequest("That organisation doesn't exist or was archived.")
      const brandIds = [...new Set(dto.brandIds ?? [])]
      const brands = brandIds.length ? await tx.brand.findMany({ where: { id: { in: brandIds }, organisationId: org.id, archivedAt: null } }) : []
      if (brands.length !== brandIds.length) throw badRequest("A person can only be linked to active brands of their own organisation.")
      const data = (await this.prepare(dto, null, tx)) as Prisma.PersonUncheckedCreateInput
      const p = await tx.person.create({ data: { ...data, firstName: dto.firstName!.trim(), organisationId: org.id, createdById: me.id, updatedById: me.id } })
      if (brands.length) await tx.brandPerson.createMany({ data: brands.map((b) => ({ brandId: b.id, personId: p.id, addedById: me.id })) })
      const d = await this.changes({}, p, tx)
      await this.audit.record(
        { actor: me, section: SECTION, action: `Added ${nameOf(p)} at ${org.name}`, entityType: "person", entityId: p.id, after: [d.after, brands.length ? `Brands: ${brands.map((b) => b.name).join(", ")}` : ""].filter(Boolean).join("\n") || null, ip },
        tx,
      )
      return p.id
    })
    return this.get(id)
  }

  async update(id: string, dto: UpdatePersonDto, me: RequestUser, ip: string | null) {
    await this.prisma.$transaction(async (tx) => {
      const p = await tx.person.findUnique({ where: { id } })
      if (!p) throw notFound("That person")
      if (p.archivedAt) throw badRequest("Restore the person before changing them.")
      const data = await this.prepare(dto, p, tx)
      const d = await this.changes(p, data as Partial<Person>, tx)
      if (!d.changed) return
      await tx.person.update({ where: { id }, data: { ...data, updatedById: me.id } })
      await this.audit.record({ actor: me, section: SECTION, action: `Changed ${nameOf({ firstName: (data.firstName as string) ?? p.firstName, lastName: (data.lastName as string) ?? p.lastName })}`, entityType: "person", entityId: id, before: d.before, after: d.after, ip }, tx)
    })
    return this.get(id)
  }

  /** Archived people drop off every brand page; their brand links stay, so restoring brings them back. */
  async archive(id: string, dto: ArchiveDto, me: RequestUser, ip: string | null) {
    await this.prisma.$transaction(async (tx) => {
      const p = await tx.person.findUnique({ where: { id } })
      if (!p) throw notFound("That person")
      if (p.archivedAt) return
      const reason = await checkListCode(tx, "archive_reason", dto.reasonCode, null, "Reason")
      await tx.person.update({ where: { id }, data: archiveData(me) })
      await this.audit.record({ actor: me, section: SECTION, action: `Archived ${nameOf(p)}`, entityType: "person", entityId: id, before: "Active", after: "Archived", reason: [reason.code && reason.label, dto.reason].filter(Boolean).join(": ") || null, ip }, tx)
    })
    return this.get(id)
  }

  async restore(id: string, me: RequestUser, ip: string | null) {
    await this.prisma.$transaction(async (tx) => {
      const p = await tx.person.findUnique({ where: { id }, include: { organisation: true } })
      if (!p) throw notFound("That person")
      if (!p.archivedAt) return
      if (p.organisation.archivedAt) throw badRequest(`Restore the organisation ${p.organisation.name} first.`)
      if (p.email) {
        const clash = await tx.person.findFirst({ where: { email: p.email, archivedAt: null } })
        if (clash) throw conflict(`${p.email} now belongs to ${nameOf(clash)}. Change one of the emails first.`)
      }
      await tx.person.update({ where: { id }, data: restoreData(me) })
      await this.audit.record({ actor: me, section: SECTION, action: `Restored ${nameOf(p)}`, entityType: "person", entityId: id, before: "Archived", after: "Active", ip }, tx)
    })
    return this.get(id)
  }
}
