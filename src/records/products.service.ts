import { Injectable } from "@nestjs/common"
import type { Prisma, Product } from "@prisma/client"

import { AuditService } from "../audit/audit.service"
import { badRequest, conflict, notFound } from "../common/errors"
import type { RequestUser } from "../common/request-user"
import { PrismaService } from "../prisma/prisma.service"
import { archiveData, checkCategory, checkListCode, describe, listLabels, restoreData } from "./records-common"
import type { ArchiveDto, CreateProductDto, ProductFields, UpdateProductDto } from "./records.dto"
import { CustomFieldsService, type CustomValues } from "./custom-fields.service"
import { FieldRulesService } from "./field-rules.service"
import { TagsService } from "./tags.service"

const SECTION = "Records"

/**
 * Products: what a brand sells (Garnier → face wash, body wash). Organisation › brand › products. A product can
 * have its own category and sub-category; when it has none it takes the brand's. Archived, never deleted.
 */
@Injectable()
export class ProductsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly tags: TagsService,
    private readonly customFields: CustomFieldsService,
    private readonly fieldRules: FieldRulesService,
  ) {}

  /** A brand's products with their tags, active first. */
  async forBrand(brandId: string, db: Prisma.TransactionClient = this.prisma) {
    const rows = await db.product.findMany({ where: { brandId }, orderBy: [{ archivedAt: { sort: "desc", nulls: "first" } }, { name: "asc" }] })
    const tags = await this.tags.forEntities("product", rows.map((p) => p.id), db)
    return rows.map((p) => ({ ...p, archived: !!p.archivedAt, tags: tags.get(p.id) ?? [] }))
  }

  private async prepare(dto: ProductFields, current: Product | null, brandId: string, db: Prisma.TransactionClient) {
    const data: Prisma.ProductUncheckedUpdateInput = {}
    if (dto.name !== undefined) {
      const name = dto.name.trim()
      if (!name) throw badRequest("Give the product a name.")
      const clash = await db.product.findFirst({ where: { brandId, archivedAt: null, name: { equals: name, mode: "insensitive" }, ...(current ? { id: { not: current.id } } : {}) } })
      if (clash) throw conflict(`This brand already has a product called ${clash.name}.`)
      data.name = name
    }
    if (dto.sku !== undefined) data.sku = dto.sku
    Object.assign(data, await checkCategory(db, dto, current))
    if (dto.description !== undefined) data.description = dto.description
    if (dto.custom !== undefined || !current) data.custom = (await this.customFields.apply(db, "product", dto.custom, current?.custom ?? {}, !current)).values as Prisma.InputJsonValue
    // Required fields (Settings → Fields): all on a new product; on an edit, none may be emptied.
    const after = (k: keyof Prisma.ProductUncheckedUpdateInput, cur: unknown) => (data[k] !== undefined ? data[k] : cur)
    const values: Record<string, unknown> = { sku: after("sku", current?.sku), category: after("categoryCode", current?.categoryCode), subCategory: after("subCategoryCode", current?.subCategoryCode), description: after("description", current?.description) }
    const was: Record<string, unknown> | null = current ? { sku: current.sku, category: current.categoryCode, subCategory: current.subCategoryCode, description: current.description } : null
    await this.fieldRules.assertFilled(db, "product", values, was)
    return data
  }

  private async changes(before: Partial<Product>, after: Partial<Product>, db: Prisma.TransactionClient) {
    const [cat, sub] = await Promise.all(["category", "sub_category"].map((k) => listLabels(db, k)))
    const label = (m: Map<string, string>) => (v: unknown) => (v ? (m.get(v as string) ?? String(v)) : "Same as brand")
    const pick = <K extends keyof Product>(k: K) => (k in after ? after[k] : before[k])
    const custom = after.custom !== undefined ? this.customFields.changes(await this.customFields.list("product", db), (before.custom ?? {}) as CustomValues, after.custom as CustomValues) : []
    return describe([
      { label: "Name", before: before.name, after: pick("name") },
      { label: "SKU", before: before.sku, after: pick("sku") },
      { label: "Category", before: before.categoryCode, after: pick("categoryCode"), show: label(cat) },
      { label: "Sub-category", before: before.subCategoryCode, after: pick("subCategoryCode"), show: label(sub) },
      { label: "Description", before: before.description, after: pick("description") },
      ...custom,
    ])
  }

  async create(brandId: string, dto: CreateProductDto, me: RequestUser, ip: string | null) {
    if (!dto.name?.trim()) throw badRequest("Give the product a name.")
    await this.prisma.$transaction(async (tx) => {
      const b = await tx.brand.findUnique({ where: { id: brandId } })
      if (!b || b.archivedAt) throw badRequest("That brand doesn't exist or was archived.")
      const data = (await this.prepare(dto, null, brandId, tx)) as Prisma.ProductUncheckedCreateInput
      const p = await tx.product.create({ data: { ...data, name: data.name as string, brandId, createdById: me.id, updatedById: me.id } })
      const t = await this.tags.set(tx, "product", p.id, dto.tagCodes, me)
      const d = await this.changes({}, p, tx)
      await this.audit.record(
        { actor: me, section: SECTION, action: `Added the product ${p.name} to ${b.name}`, entityType: "product", entityId: p.id, after: TagsService.merge(d, t).after || null, ip },
        tx,
      )
    })
    return this.forBrand(brandId)
  }

  async update(id: string, dto: UpdateProductDto, me: RequestUser, ip: string | null) {
    const brandId = await this.prisma.$transaction(async (tx) => {
      const p = await tx.product.findUnique({ where: { id }, include: { brand: true } })
      if (!p) throw notFound("That product")
      if (p.archivedAt) throw badRequest("Restore the product before changing it.")
      const data = await this.prepare(dto, p, p.brandId, tx)
      const d = TagsService.merge(await this.changes(p, data as Partial<Product>, tx), await this.tags.set(tx, "product", id, dto.tagCodes, me))
      if (!d.changed) return p.brandId
      await tx.product.update({ where: { id }, data: { ...data, updatedById: me.id } })
      await this.audit.record({ actor: me, section: SECTION, action: `Changed the product ${(data.name as string) ?? p.name} (${p.brand.name})`, entityType: "product", entityId: id, before: d.before, after: d.after, ip }, tx)
      return p.brandId
    })
    return this.forBrand(brandId)
  }

  async archive(id: string, dto: ArchiveDto, me: RequestUser, ip: string | null) {
    const brandId = await this.prisma.$transaction(async (tx) => {
      const p = await tx.product.findUnique({ where: { id }, include: { brand: true } })
      if (!p) throw notFound("That product")
      if (p.archivedAt) return p.brandId
      const reason = await checkListCode(tx, "archive_reason", dto.reasonCode, null, "Reason")
      await tx.product.update({ where: { id }, data: archiveData(me) })
      await this.audit.record(
        { actor: me, section: SECTION, action: `Archived the product ${p.name} (${p.brand.name})`, entityType: "product", entityId: id, before: "Active", after: "Archived", reason: [reason.code && reason.label, dto.reason].filter(Boolean).join(": ") || null, ip },
        tx,
      )
      return p.brandId
    })
    return this.forBrand(brandId)
  }

  async restore(id: string, me: RequestUser, ip: string | null) {
    const brandId = await this.prisma.$transaction(async (tx) => {
      const p = await tx.product.findUnique({ where: { id }, include: { brand: true } })
      if (!p) throw notFound("That product")
      if (!p.archivedAt) return p.brandId
      if (p.brand.archivedAt) throw badRequest(`Restore the brand ${p.brand.name} first.`)
      const clash = await tx.product.findFirst({ where: { brandId: p.brandId, archivedAt: null, name: { equals: p.name, mode: "insensitive" } } })
      if (clash) throw conflict(`${p.brand.name} now has another product called ${clash.name}. Rename one of them first.`)
      await tx.product.update({ where: { id }, data: restoreData(me) })
      await this.audit.record({ actor: me, section: SECTION, action: `Restored the product ${p.name} (${p.brand.name})`, entityType: "product", entityId: id, before: "Archived", after: "Active", ip }, tx)
      return p.brandId
    })
    return this.forBrand(brandId)
  }
}
