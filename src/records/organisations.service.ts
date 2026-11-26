import { Injectable } from "@nestjs/common"
import type { Organisation, Prisma } from "@prisma/client"

import { AuditService } from "../audit/audit.service"
import { badRequest, conflict, notFound } from "../common/errors"
import type { RequestUser } from "../common/request-user"
import { PrismaService } from "../prisma/prisma.service"
import { archiveData, checkCountry, checkListCode, describe, normaliseDomain, normaliseUrl, restoreData, showCountry } from "./records-common"
import type { ArchiveDto, CreateOrganisationDto, UpdateOrganisationDto } from "./records.dto"
import { CustomFieldsService, showCustom, type CustomValues } from "./custom-fields.service"
import { FieldRulesService } from "./field-rules.service"
import { TagsService } from "./tags.service"

const SECTION = "Records"

/**
 * Organisations: the legal entity ATM signs with. It holds one or more brands (a brand that signs on its own is
 * registered as its own organisation). Organisation › brands › products.
 */
@Injectable()
export class OrganisationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tags: TagsService,
    private readonly customFields: CustomFieldsService,
    private readonly fieldRules: FieldRulesService,
  ) {}

  async list(archived: boolean) {
    const rows = await this.prisma.organisation.findMany({
      where: archived ? {} : { archivedAt: null },
      orderBy: { name: "asc" },
      include: { parent: { select: { id: true, name: true } }, _count: { select: { brands: { where: { archivedAt: null } }, people: { where: { archivedAt: null } } } } },
    })
    const tags = await this.tags.forEntities("organisation", rows.map((o) => o.id))
    return rows.map(({ _count, ...o }) => ({ ...o, archived: !!o.archivedAt, brandCount: _count.brands, peopleCount: _count.people, tags: tags.get(o.id) ?? [] }))
  }

  async get(id: string) {
    const o = await this.prisma.organisation.findUnique({
      where: { id },
      include: {
        brands: { orderBy: { name: "asc" }, select: { id: true, name: true, domain: true, categoryCode: true, routingCode: true, archivedAt: true } },
        people: { orderBy: [{ firstName: "asc" }, { lastName: "asc" }], select: { id: true, firstName: true, lastName: true, jobTitle: true, email: true, archivedAt: true } },
        parent: { select: { id: true, name: true, domain: true, excluded: true, archivedAt: true } },
        members: { orderBy: { name: "asc" }, select: { id: true, name: true, domain: true, excluded: true, archivedAt: true } },
      },
    })
    if (!o) throw notFound("That organisation")
    return { ...o, archived: !!o.archivedAt, tags: await this.tags.forEntity("organisation", id) }
  }

  /** Tidies and checks the fields; a domain must not belong to another active organisation. */
  async prepare(dto: CreateOrganisationDto | UpdateOrganisationDto, db: Prisma.TransactionClient, exceptId: string | null, current: Organisation | null = null) {
    const data: Prisma.OrganisationUncheckedUpdateInput = {}
    if (dto.name !== undefined) {
      if (!dto.name.trim()) throw badRequest("Give the organisation a name.")
      data.name = dto.name.trim()
    }
    if (dto.domain !== undefined) {
      const domain = normaliseDomain(dto.domain, "Organisation website")
      if (domain) {
        const clash = await db.organisation.findFirst({ where: { domain, archivedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) } })
        if (clash) throw conflict(`${clash.name} already uses ${domain}.`)
      }
      data.domain = domain
    }
    if (dto.hqCountry !== undefined) data.hqCountry = checkCountry(dto.hqCountry, "Head office country")
    if (dto.linkedinUrl !== undefined) data.linkedinUrl = normaliseUrl(dto.linkedinUrl, "LinkedIn")
    if (dto.notes !== undefined) data.notes = dto.notes
    if (dto.legalEntity !== undefined) data.legalEntity = dto.legalEntity
    if (dto.parentId !== undefined && dto.parentId !== (current?.parentId ?? null)) data.parentId = await this.checkParent(db, dto.parentId ?? null, exceptId)
    if (dto.excluded !== undefined && dto.excluded !== (current?.excluded ?? false)) {
      const why = dto.exclusionReason?.trim()
      if (!why) throw badRequest(dto.excluded ? "Say why this organisation is excluded." : "Say why this organisation is no longer excluded.")
      data.excluded = dto.excluded
      data.exclusionReason = dto.excluded ? why : null
    } else if (dto.exclusionReason !== undefined && current?.excluded && dto.exclusionReason.trim()) {
      data.exclusionReason = dto.exclusionReason.trim()
    }
    if (dto.custom !== undefined || !current) data.custom = (await this.customFields.apply(db, "organisation", dto.custom, current?.custom ?? {}, !current)).values as Prisma.InputJsonValue
    // Required fields (Settings → Fields): all on a new organisation; on an edit, none may be emptied.
    const after = (k: keyof Prisma.OrganisationUncheckedUpdateInput, cur: unknown) => (data[k] !== undefined ? data[k] : cur)
    const values: Record<string, unknown> = {
      legalEntity: after("legalEntity", current?.legalEntity),
      domain: after("domain", current?.domain),
      hqCountry: after("hqCountry", current?.hqCountry),
      parent: after("parentId", current?.parentId),
      linkedin: after("linkedinUrl", current?.linkedinUrl),
      notes: after("notes", current?.notes),
    }
    const was: Record<string, unknown> | null = current
      ? { legalEntity: current.legalEntity, domain: current.domain, hqCountry: current.hqCountry, parent: current.parentId, linkedin: current.linkedinUrl, notes: current.notes }
      : exceptId
        ? values
        : null
    await this.fieldRules.assertFilled(db, "organisation", values, was)
    return data
  }

  /** A parent group must be another active organisation, and can't be one of this organisation's own members (no loops). */
  private async checkParent(db: Prisma.TransactionClient, parentId: string | null, selfId: string | null) {
    if (!parentId) return null
    if (parentId === selfId) throw badRequest("An organisation can't be its own parent group.")
    const parent = await db.organisation.findUnique({ where: { id: parentId } })
    if (!parent) throw badRequest("That parent group doesn't exist.")
    if (parent.archivedAt) throw badRequest(`${parent.name} is archived. Restore it first, or pick another parent group.`)
    if (selfId) {
      let up: string | null = parent.parentId
      for (let i = 0; up && i < 50; i++) {
        if (up === selfId) throw badRequest(`${parent.name} is already inside this organisation's group, so it can't also be its parent.`)
        up = (await db.organisation.findUnique({ where: { id: up }, select: { parentId: true } }))?.parentId ?? null
      }
    }
    return parentId
  }

  private async nameOf(db: Prisma.TransactionClient, id: string | null | undefined) {
    if (!id) return null
    return (await db.organisation.findUnique({ where: { id }, select: { name: true } }))?.name ?? null
  }

  /** "Field: value" lines for an organisation's own fields, for the change log. */
  private async customLines(db: Prisma.TransactionClient, values: unknown) {
    const v = (values ?? {}) as CustomValues
    const fields = await this.customFields.list("organisation", db)
    return fields.filter((f) => v[f.key] !== undefined && v[f.key] !== null).map((f) => `${f.label}: ${showCustom(v[f.key])}`)
  }

  /** Inside a caller's transaction (adding a brand can make its organisation). */
  async createIn(db: Prisma.TransactionClient, dto: CreateOrganisationDto, me: RequestUser, ip: string | null) {
    if (!dto.name?.trim()) throw badRequest("Give the organisation a name.")
    const data = (await this.prepare(dto, db, null)) as Prisma.OrganisationUncheckedCreateInput
    const o = await db.organisation.create({ data: { ...data, name: dto.name.trim(), createdById: me.id, updatedById: me.id, ...(data.excluded ? { excludedAt: new Date(), excludedById: me.id } : {}) } })
    const parentName = await this.nameOf(db, o.parentId)
    const t = await this.tags.set(db, "organisation", o.id, dto.tagCodes, me)
    await this.audit.record(
      {
        actor: me,
        section: SECTION,
        action: `Added the organisation ${o.name}`,
        entityType: "organisation",
        entityId: o.id,
        after: [o.domain && `Website: ${o.domain}`, o.hqCountry && `Head office: ${showCountry(o.hqCountry)}`, parentName && `Parent group: ${parentName}`, o.legalEntity && `Legal entity: ${o.legalEntity}`, o.excluded && "Excluded", t && `Tags: ${t.after}`, ...(await this.customLines(db, o.custom))].filter(Boolean).join("\n") || null,
        reason: o.excluded ? o.exclusionReason : null,
        ip,
      },
      db,
    )
    return o
  }

  async create(dto: CreateOrganisationDto, me: RequestUser, ip: string | null) {
    const o = await this.prisma.$transaction((tx) => this.createIn(tx, dto, me, ip))
    return this.get(o.id)
  }

  async update(id: string, dto: UpdateOrganisationDto, me: RequestUser, ip: string | null) {
    await this.prisma.$transaction(async (tx) => {
      const o = await tx.organisation.findUnique({ where: { id } })
      if (!o) throw notFound("That organisation")
      if (o.archivedAt) throw badRequest("Restore the organisation before changing it.")
      const data = await this.prepare(dto, tx, id, o)
      const parentAfter = data.parentId !== undefined ? (data.parentId as string | null) : o.parentId
      const d = describe([
        { label: "Name", before: o.name, after: data.name ?? o.name },
        { label: "Website", before: o.domain, after: data.domain !== undefined ? data.domain : o.domain },
        { label: "Head office", before: o.hqCountry, after: data.hqCountry !== undefined ? data.hqCountry : o.hqCountry, show: showCountry },
        { label: "LinkedIn", before: o.linkedinUrl, after: data.linkedinUrl !== undefined ? data.linkedinUrl : o.linkedinUrl },
        { label: "Notes", before: o.notes, after: data.notes ?? o.notes },
        { label: "Parent group", before: await this.nameOf(tx, o.parentId), after: await this.nameOf(tx, parentAfter) },
        { label: "Legal entity", before: o.legalEntity, after: data.legalEntity !== undefined ? data.legalEntity : o.legalEntity },
        { label: "Exclusion", before: o.excluded, after: data.excluded ?? o.excluded, show: (v) => (v ? "Excluded" : "Not excluded") },
        { label: "Exclusion reason", before: o.exclusionReason, after: data.exclusionReason !== undefined ? data.exclusionReason : o.exclusionReason },
        ...(data.custom !== undefined ? this.customFields.changes(await this.customFields.list("organisation", tx), o.custom as CustomValues, data.custom as CustomValues) : []),
      ])
      const t = await this.tags.set(tx, "organisation", id, dto.tagCodes, me)
      if (t) Object.assign(d, TagsService.merge(d, t))
      if (!d.changed) return
      const exclusionChanged = data.excluded !== undefined
      const stamps = exclusionChanged ? (data.excluded ? { excludedAt: new Date(), excludedById: me.id } : { excludedAt: null, excludedById: null }) : {}
      await tx.organisation.update({ where: { id }, data: { ...data, ...stamps, updatedById: me.id } })
      const name = (data.name as string) ?? o.name
      await this.audit.record(
        {
          actor: me,
          section: SECTION,
          action: exclusionChanged ? (data.excluded ? `Excluded the organisation ${name}` : `Lifted the exclusion on ${name}`) : `Changed the organisation ${name}`,
          entityType: "organisation",
          entityId: id,
          before: d.before,
          after: d.after,
          reason: exclusionChanged ? (dto.exclusionReason?.trim() ?? null) : null,
          ip,
        },
        tx,
      )
    })
    return this.get(id)
  }

  async archive(id: string, dto: ArchiveDto, me: RequestUser, ip: string | null) {
    await this.prisma.$transaction(async (tx) => {
      const o = await tx.organisation.findUnique({ where: { id }, include: { _count: { select: { brands: { where: { archivedAt: null } }, people: { where: { archivedAt: null } } } } } })
      if (!o) throw notFound("That organisation")
      if (o.archivedAt) return
      const members = await tx.organisation.count({ where: { parentId: id, archivedAt: null } })
      if (members) throw badRequest(`${members} organisation${members === 1 ? " is" : "s are"} in this group. Move or archive ${members === 1 ? "it" : "them"} first.`)
      const { brands, people } = o._count
      if (brands || people) throw badRequest(`Archive its ${[brands && `${brands} brand${brands === 1 ? "" : "s"}`, people && `${people} ${people === 1 ? "person" : "people"}`].filter(Boolean).join(" and ")} first.`)
      const reason = await checkListCode(tx, "archive_reason", dto.reasonCode, null, "Reason")
      await tx.organisation.update({ where: { id }, data: archiveData(me) })
      await this.audit.record({ actor: me, section: SECTION, action: `Archived the organisation ${o.name}`, entityType: "organisation", entityId: id, before: "Active", after: "Archived", reason: [reason.code && reason.label, dto.reason].filter(Boolean).join(": ") || null, ip }, tx)
    })
    return this.get(id)
  }

  async restore(id: string, me: RequestUser, ip: string | null) {
    await this.prisma.$transaction(async (tx) => {
      const o = await tx.organisation.findUnique({ where: { id } })
      if (!o) throw notFound("That organisation")
      if (!o.archivedAt) return
      if (o.domain) {
        const clash = await tx.organisation.findFirst({ where: { domain: o.domain, archivedAt: null } })
        if (clash) throw conflict(`${clash.name} now uses ${o.domain}. Change one of them first.`)
      }
      await tx.organisation.update({ where: { id }, data: restoreData(me) })
      await this.audit.record({ actor: me, section: SECTION, action: `Restored the organisation ${o.name}`, entityType: "organisation", entityId: id, before: "Archived", after: "Active", ip }, tx)
    })
    return this.get(id)
  }

  /** Everything that happened to the organisation, its brands and its people, newest first. */
  async history(id: string) {
    const o = await this.prisma.organisation.findUnique({ where: { id }, select: { brands: { select: { id: true, products: { select: { id: true } } } }, people: { select: { id: true } } } })
    if (!o) throw notFound("That organisation")
    return this.audit.forEntities([
      { type: "organisation", ids: [id] },
      { type: "brand", ids: o.brands.map((b) => b.id) },
      { type: "person", ids: o.people.map((p) => p.id) },
      { type: "product", ids: o.brands.flatMap((b) => b.products.map((p) => p.id)) },
    ])
  }
}
