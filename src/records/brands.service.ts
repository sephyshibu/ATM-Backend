import { Injectable } from "@nestjs/common"
import type { Brand, Prisma } from "@prisma/client"

import { AuditService } from "../audit/audit.service"
import { badRequest, conflict, notFound } from "../common/errors"
import type { RequestUser } from "../common/request-user"
import { PrismaService } from "../prisma/prisma.service"
import { OrganisationsService } from "./organisations.service"
import { ProductsService } from "./products.service"
import { archiveData, checkCategory, checkCountries, checkCountry, checkListCode, describe, listLabels, normaliseDomain, normaliseUrl, restoreData, showCountries, showCountry, showUsd } from "./records-common"
import type { ArchiveDto, BrandFields, CreateBrandDto, LinkPersonDto, UpdateBrandDto } from "./records.dto"
import { TagsService } from "./tags.service"

const SECTION = "Records"

const personName = (p: { firstName: string; lastName: string }) => `${p.firstName} ${p.lastName}`.trim()

/** A brand as the screens see it (revenue as a plain number). */
const view = <T extends Brand>(b: T) => ({ ...b, homeRevenueUsd: b.homeRevenueUsd === null ? null : Number(b.homeRevenueUsd), archived: !!b.archivedAt })

/**
 * Brands: the record everything else hangs on (leads, gates, outreach, deals). The website is the duplicate
 * check: two active brands can't share one. Brands are archived, never deleted.
 */
@Injectable()
export class BrandsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly organisations: OrganisationsService,
    private readonly products: ProductsService,
    private readonly tags: TagsService,
  ) {}

  async list(archived: boolean) {
    const rows = await this.prisma.brand.findMany({
      where: archived ? {} : { archivedAt: null },
      orderBy: { name: "asc" },
      include: {
        organisation: { select: { id: true, name: true, excluded: true } },
        owner: { select: { id: true, name: true } },
        _count: { select: { people: { where: { removedAt: null, person: { archivedAt: null } } }, products: { where: { archivedAt: null } } } },
      },
    })
    const tags = await this.tags.forEntities("brand", rows.map((b) => b.id))
    return rows.map(({ _count, ...b }) => ({ ...view(b), peopleCount: _count.people, productCount: _count.products, tags: tags.get(b.id) ?? [] }))
  }

  async get(id: string) {
    const b = await this.prisma.brand.findUnique({
      where: { id },
      include: {
        organisation: { include: { parent: { select: { id: true, name: true } } } },
        owner: { select: { id: true, name: true, email: true } },
        people: {
          where: { removedAt: null, person: { archivedAt: null } },
          orderBy: [{ isPrimary: "desc" }, { addedAt: "asc" }],
          include: { person: true },
        },
      },
    })
    if (!b) throw notFound("That brand")
    const { people, ...rest } = b
    const [tags, orgTags, products] = await Promise.all([this.tags.forEntity("brand", id), this.tags.forEntity("organisation", b.organisationId), this.products.forBrand(id)])
    return {
      ...view(rest),
      organisation: { ...rest.organisation, tags: orgTags },
      tags,
      products,
      people: people.map((l) => ({ ...l.person, isPrimary: l.isPrimary, linkedAt: l.addedAt })),
    }
  }

  /** Before adding or renaming: a brand already on this website, and brands with a similar name. */
  async check(rawDomain: string | undefined, name: string | undefined, exceptId?: string, organisationId?: string) {
    let domain: string | null = null
    try {
      domain = normaliseDomain(rawDomain)
    } catch {
      domain = null
    }
    const sameDomain = domain
      ? await this.prisma.brand.findMany({ where: { domain, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true, name: true, domain: true, archivedAt: true, organisation: { select: { name: true } } } })
      : []
    const words = (name ?? "").trim()
    const similar =
      words.length >= 3
        ? await this.prisma.brand.findMany({
            where: { name: { contains: words, mode: "insensitive" }, archivedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}), ...(domain ? { domain: { not: domain } } : {}) },
            take: 5,
            select: { id: true, name: true, domain: true, organisation: { select: { name: true } } },
          })
        : []
    return { domain, sameDomain: sameDomain.map((b) => ({ ...b, archived: !!b.archivedAt })), similar, sameGroup: await this.sameGroup(organisationId, exceptId) }
  }

  /**
   * Brands of other organisations in the same parent group as `organisationId`, so two people don't approach one
   * group separately. The group is the organisation's parent group (or the organisation itself when it is the parent).
   */
  private async sameGroup(organisationId: string | undefined, exceptId?: string) {
    if (!organisationId) return null
    const org = await this.prisma.organisation.findUnique({ where: { id: organisationId }, select: { id: true, parentId: true } })
    if (!org) return null
    const rootId = org.parentId ?? org.id
    const root = await this.prisma.organisation.findUnique({ where: { id: rootId }, select: { id: true, name: true, members: { select: { id: true } } } })
    if (!root) return null
    const groupOrgs = [root.id, ...root.members.map((m) => m.id)].filter((id) => id !== org.id)
    if (!groupOrgs.length) return null
    const brands = await this.prisma.brand.findMany({
      where: { organisationId: { in: groupOrgs }, archivedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
      orderBy: { name: "asc" },
      take: 10,
      select: { id: true, name: true, domain: true, organisation: { select: { name: true } } },
    })
    return brands.length ? { group: { id: root.id, name: root.name }, brands } : null
  }

  /** Tidies and checks every field that was sent, against lists, countries and people. */
  private async prepare(dto: BrandFields, current: Brand | null, db: Prisma.TransactionClient) {
    const data: Prisma.BrandUncheckedUpdateInput = {}
    if (dto.name !== undefined) {
      if (!dto.name.trim()) throw badRequest("Give the brand a name.")
      data.name = dto.name.trim()
    }
    if (dto.domain !== undefined) {
      const domain = normaliseDomain(dto.domain, "Brand website")
      if (!domain) throw badRequest("Add the brand's website. It's how duplicates are caught.")
      const clash = await db.brand.findFirst({ where: { domain, ...(current ? { id: { not: current.id } } : {}) }, orderBy: { archivedAt: { sort: "asc", nulls: "first" } } })
      if (clash && !clash.archivedAt) throw conflict(`${clash.name} already uses ${domain}. Open that brand instead of adding it twice.`)
      if (clash) throw conflict(`${clash.name} (archived) uses ${domain}. Restore it instead of adding it again.`)
      data.domain = domain
    }
    Object.assign(data, await checkCategory(db, dto, current))
    // Every brand has a category and a sub-category: they can be changed, never emptied.
    if (!current || dto.categoryCode !== undefined || dto.subCategoryCode !== undefined) {
      const cat = data.categoryCode !== undefined ? data.categoryCode : current?.categoryCode
      const sub = data.subCategoryCode !== undefined ? data.subCategoryCode : current?.subCategoryCode
      if (!cat || !sub) throw badRequest("Pick the brand's category and sub-category.")
    }
    if (dto.routingCode !== undefined) data.routingCode = (await checkListCode(db, "routing", dto.routingCode, current?.routingCode, "Lane")).code
    if (dto.tierCode !== undefined) data.tierCode = (await checkListCode(db, "tier", dto.tierCode, current?.tierCode, "Tier")).code
    if (dto.homeCountry !== undefined) data.homeCountry = checkCountry(dto.homeCountry, "Home country")
    if (dto.homeRevenueUsd !== undefined) data.homeRevenueUsd = dto.homeRevenueUsd === null ? null : BigInt(dto.homeRevenueUsd)
    if (dto.revenueYear !== undefined) data.revenueYear = dto.revenueYear
    if (dto.asianMarketsLive !== undefined) data.asianMarketsLive = checkCountries(dto.asianMarketsLive, "Asian markets")
    if (dto.ownerId !== undefined) {
      if (dto.ownerId) {
        const owner = await db.user.findUnique({ where: { id: dto.ownerId } })
        if (!owner || (owner.status === "deactivated" && owner.id !== current?.ownerId)) throw badRequest("Owner: pick an active person.")
      }
      data.ownerId = dto.ownerId
    }
    if (dto.description !== undefined) data.description = dto.description
    if (dto.linkedinUrl !== undefined) data.linkedinUrl = normaliseUrl(dto.linkedinUrl, "LinkedIn")
    return data
  }

  /** The change-log lines for a brand's fields, with list names and country names instead of codes. */
  private async changes(before: Partial<Brand>, after: Partial<Brand>, db: Prisma.TransactionClient) {
    const [cat, sub, routing, tier] = await Promise.all(["category", "sub_category", "routing", "tier"].map((k) => listLabels(db, k)))
    const owners = await db.user.findMany({ where: { id: { in: [before.ownerId, after.ownerId].filter((x): x is string => !!x) } }, select: { id: true, name: true } })
    const ownerName = (id: unknown) => (id ? (owners.find((o) => o.id === id)?.name ?? "—") : "—")
    const orgs = await db.organisation.findMany({ where: { id: { in: [before.organisationId, after.organisationId].filter((x): x is string => !!x) } }, select: { id: true, name: true } })
    const orgName = (id: unknown) => (id ? (orgs.find((o) => o.id === id)?.name ?? "—") : "—")
    const label = (m: Map<string, string>) => (v: unknown) => (v ? (m.get(v as string) ?? String(v)) : "—")
    const pick = <K extends keyof Brand>(k: K) => (k in after ? after[k] : before[k])
    return describe([
      { label: "Name", before: before.name, after: pick("name") },
      { label: "Organisation", before: before.organisationId, after: pick("organisationId"), show: orgName },
      { label: "Website", before: before.domain, after: pick("domain") },
      { label: "Category", before: before.categoryCode, after: pick("categoryCode"), show: label(cat) },
      { label: "Sub-category", before: before.subCategoryCode, after: pick("subCategoryCode"), show: label(sub) },
      { label: "Lane", before: before.routingCode, after: pick("routingCode"), show: label(routing) },
      { label: "Tier", before: before.tierCode, after: pick("tierCode"), show: label(tier) },
      { label: "Home country", before: before.homeCountry, after: pick("homeCountry"), show: showCountry },
      { label: "Home revenue", before: before.homeRevenueUsd, after: pick("homeRevenueUsd"), show: showUsd },
      { label: "Revenue year", before: before.revenueYear, after: pick("revenueYear") },
      { label: "Asian markets live", before: before.asianMarketsLive, after: pick("asianMarketsLive"), show: showCountries },
      { label: "Owner", before: before.ownerId, after: pick("ownerId"), show: ownerName },
      { label: "Description", before: before.description, after: pick("description") },
      { label: "LinkedIn", before: before.linkedinUrl, after: pick("linkedinUrl") },
    ])
  }

  async create(dto: CreateBrandDto, me: RequestUser, ip: string | null) {
    if (!dto.name?.trim()) throw badRequest("Give the brand a name.")
    if (!dto.domain?.trim()) throw badRequest("Add the brand's website. It's how duplicates are caught.")
    if (!dto.organisationId === !dto.newOrganisation) throw badRequest("Pick the organisation the brand belongs to, or add a new one.")
    const id = await this.prisma.$transaction(async (tx) => {
      let organisationId = dto.organisationId
      if (organisationId) {
        const org = await tx.organisation.findUnique({ where: { id: organisationId } })
        if (!org || org.archivedAt) throw badRequest("That organisation doesn't exist or was archived.")
      } else {
        organisationId = (await this.organisations.createIn(tx, dto.newOrganisation!, me, ip)).id
      }
      const data = (await this.prepare(dto, null, tx)) as Prisma.BrandUncheckedCreateInput
      const b = await tx.brand.create({ data: { ...data, name: dto.name!.trim(), domain: data.domain as string, organisationId, source: "manual", createdById: me.id, updatedById: me.id } })
      const t = await this.tags.set(tx, "brand", b.id, dto.tagCodes, me)
      const d = TagsService.merge(await this.changes({}, b, tx), t)
      await this.audit.record({ actor: me, section: SECTION, action: `Added the brand ${b.name}`, entityType: "brand", entityId: b.id, after: d.after || null, ip }, tx)
      return b.id
    })
    return this.get(id)
  }

  async update(id: string, dto: UpdateBrandDto, me: RequestUser, ip: string | null) {
    await this.prisma.$transaction(async (tx) => {
      const b = await tx.brand.findUnique({ where: { id } })
      if (!b) throw notFound("That brand")
      if (b.archivedAt) throw badRequest("Restore the brand before changing it.")
      const data = await this.prepare(dto, b, tx)
      if (dto.organisationId && dto.organisationId !== b.organisationId) {
        const org = await tx.organisation.findUnique({ where: { id: dto.organisationId } })
        if (!org || org.archivedAt) throw badRequest("That organisation doesn't exist or was archived.")
        const linked = await tx.brandPerson.count({ where: { brandId: id, removedAt: null } })
        if (linked) throw badRequest("Unlink the brand's people before moving it to another organisation: people belong to their organisation.")
        data.organisationId = dto.organisationId
      }
      const d = TagsService.merge(await this.changes(b, data as Partial<Brand>, tx), await this.tags.set(tx, "brand", id, dto.tagCodes, me))
      if (!d.changed) return
      await tx.brand.update({ where: { id }, data: { ...data, updatedById: me.id } })
      await this.audit.record({ actor: me, section: SECTION, action: `Changed the brand ${(data.name as string) ?? b.name}`, entityType: "brand", entityId: id, before: d.before, after: d.after, ip }, tx)
    })
    return this.get(id)
  }

  async archive(id: string, dto: ArchiveDto, me: RequestUser, ip: string | null) {
    await this.prisma.$transaction(async (tx) => {
      const b = await tx.brand.findUnique({ where: { id } })
      if (!b) throw notFound("That brand")
      if (b.archivedAt) return
      const reason = await checkListCode(tx, "archive_reason", dto.reasonCode, null, "Reason")
      await tx.brand.update({ where: { id }, data: archiveData(me) })
      await this.audit.record({ actor: me, section: SECTION, action: `Archived the brand ${b.name}`, entityType: "brand", entityId: id, before: "Active", after: "Archived", reason: [reason.code && reason.label, dto.reason].filter(Boolean).join(": ") || null, ip }, tx)
    })
    return this.get(id)
  }

  async restore(id: string, me: RequestUser, ip: string | null) {
    await this.prisma.$transaction(async (tx) => {
      const b = await tx.brand.findUnique({ where: { id }, include: { organisation: true } })
      if (!b) throw notFound("That brand")
      if (!b.archivedAt) return
      if (b.organisation.archivedAt) throw badRequest(`Restore the organisation ${b.organisation.name} first.`)
      const clash = await tx.brand.findFirst({ where: { domain: b.domain, archivedAt: null } })
      if (clash) throw conflict(`${clash.name} now uses ${b.domain}. Archive or change one of them first.`)
      await tx.brand.update({ where: { id }, data: restoreData(me) })
      await this.audit.record({ actor: me, section: SECTION, action: `Restored the brand ${b.name}`, entityType: "brand", entityId: id, before: "Archived", after: "Active", ip }, tx)
    })
    return this.get(id)
  }

  /** Links a person of the brand's organisation to the brand, or changes whether they're the main contact. */
  async linkPerson(brandId: string, dto: LinkPersonDto, me: RequestUser, ip: string | null) {
    await this.prisma.$transaction(async (tx) => {
      const b = await tx.brand.findUnique({ where: { id: brandId } })
      if (!b || b.archivedAt) throw badRequest("That brand doesn't exist or was archived.")
      const p = await tx.person.findUnique({ where: { id: dto.personId } })
      if (!p || p.archivedAt) throw badRequest("That person doesn't exist or was archived.")
      if (p.organisationId !== b.organisationId) throw badRequest(`${personName(p)} works for another organisation. Add them to this brand's organisation first.`)
      const existing = await tx.brandPerson.findFirst({ where: { brandId, personId: p.id, removedAt: null } })
      const primary = dto.isPrimary ?? existing?.isPrimary ?? false
      if (primary) await tx.brandPerson.updateMany({ where: { brandId, removedAt: null, isPrimary: true, personId: { not: p.id } }, data: { isPrimary: false } })
      if (existing) {
        if (existing.isPrimary === primary) return
        await tx.brandPerson.update({ where: { id: existing.id }, data: { isPrimary: primary } })
      } else {
        await tx.brandPerson.create({ data: { brandId, personId: p.id, isPrimary: primary, addedById: me.id } })
      }
      await this.audit.record(
        {
          actor: me,
          section: SECTION,
          action: existing ? (primary ? `Made ${personName(p)} the main contact for ${b.name}` : `${personName(p)} is no longer the main contact for ${b.name}`) : `Linked ${personName(p)} to ${b.name}`,
          entityType: "brand",
          entityId: brandId,
          after: primary ? "Main contact" : null,
          ip,
        },
        tx,
      )
    })
    return this.get(brandId)
  }

  /** Takes a person off a brand; the link is kept as history (removed_at). */
  async unlinkPerson(brandId: string, personId: string, me: RequestUser, ip: string | null) {
    await this.prisma.$transaction(async (tx) => {
      const link = await tx.brandPerson.findFirst({ where: { brandId, personId, removedAt: null }, include: { brand: true, person: true } })
      if (!link) return
      await tx.brandPerson.update({ where: { id: link.id }, data: { removedAt: new Date(), removedById: me.id, isPrimary: false } })
      await this.audit.record({ actor: me, section: SECTION, action: `Unlinked ${personName(link.person)} from ${link.brand.name}`, entityType: "brand", entityId: brandId, ip }, tx)
    })
    return this.get(brandId)
  }

  /** Everything that happened to the brand, its organisation and its people, newest first. */
  async history(id: string) {
    const b = await this.prisma.brand.findUnique({ where: { id }, select: { organisationId: true, people: { select: { personId: true } }, products: { select: { id: true } } } })
    if (!b) throw notFound("That brand")
    return this.audit.forEntities([
      { type: "brand", ids: [id] },
      { type: "organisation", ids: [b.organisationId] },
      { type: "person", ids: [...new Set(b.people.map((p) => p.personId))] },
      { type: "product", ids: b.products.map((p) => p.id) },
    ])
  }
}
