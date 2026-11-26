import { createHash, randomUUID } from "node:crypto"

import { Injectable, Logger, type OnModuleInit } from "@nestjs/common"
import type { Dossier, Job, Prisma } from "@prisma/client"

import { AuditService } from "../audit/audit.service"
import { badRequest, conflict, forbidden, notFound } from "../common/errors"
import { actorLabel, type RequestUser } from "../common/request-user"
import { JobQueue } from "../jobs/job-queue.service"
import { localDate } from "../jobs/clock"
import { WorkTimeService } from "../jobs/work-time.service"
import { PrismaService } from "../prisma/prisma.service"
import { checkDossier, DOSSIER_TYPES, type DossierType, extOf, mb, safeFileName } from "./file-check"
import { FactsService } from "./facts.service"
import { checkLink, fetchLink, GOOGLE_PRIVATE_NOTE, googleFile, isGoogleLink } from "./link-fetch"
import { StorageService } from "./storage.service"

// Dossiers: the research files behind a brand's knowledge base. Two ways in:
//   1. Upload by hand on the brand page: a PDF or Word file, checked by its content, stored in S3.
//   2. A Google Docs/Drive link (the dossier drive is private): kept as a link that opens in Google with each
//      person's own sign-in. Nothing is downloaded.
//   3. Any other link: from the Brand Register's dossier column, or added by hand. A background job (dossier.fetch)
//      downloads it safely, checks it like an upload and stores the file in S3. A link that can't be downloaded
//      (it needs a sign-in, it's a web page…) is kept as a link with the exact reason, and can be retried.
// Any dossier can be "marked as checked": someone opened it and confirmed it's the right, correct file. The person
// who added it may check it too (recorded as self-checked). Nothing is deleted: dossiers are archived with a
// reason, and stored files stay in S3.

const SECTION = "Knowledge base"
const SYSTEM = { label: "System (dossier fetch)" }
type Db = Prisma.TransactionClient

export type UploadedFile = { buffer: Buffer; originalname: string; size: number }

/** Multer reads file names as Latin-1; a UTF-8 name (é, –, 中) arrives garbled and is decoded back here. */
export function utf8Name(raw: string) {
  if (![...raw].every((c) => c.charCodeAt(0) <= 0xff)) return raw
  const decoded = Buffer.from(raw, "latin1").toString("utf8")
  return decoded.includes("\ufffd") ? raw : decoded
}

@Injectable()
export class DossiersService implements OnModuleInit {
  private readonly log = new Logger("Dossiers")

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly queue: JobQueue,
    private readonly workTime: WorkTimeService,
    private readonly facts: FactsService,
  ) {}

  onModuleInit() {
    this.queue.register("dossier.fetch", "Fetch a dossier link into storage", (payload, job) => this.fetchJob(String(payload.dossierId ?? ""), job))
    this.queue.register("facts.stale", "Daily knowledge-base check (stale facts)", async (payload) => this.facts.refreshAll(typeof payload.date === "string" ? payload.date : undefined))
    this.queue.addSchedule({ name: "facts.stale", label: "Daily knowledge-base check (stale facts)", timeSetting: "jobs.facts_stale_time", defaultTime: "06:10" })
  }

  async maxBytes() {
    return Math.min(50, Math.max(1, await this.workTime.setting("kb.max_file_mb", 25))) * 1024 * 1024
  }

  private canAttach(me: RequestUser) {
    if (!me.permissions.has("kb.enter_facts") && !me.permissions.has("kb.import")) throw forbidden("Your roles don't allow attaching dossiers.")
  }

  private async brand(db: Db, brandId: string) {
    const b = await db.brand.findUnique({ where: { id: brandId }, select: { id: true, name: true, archivedAt: true } })
    if (!b) throw notFound("That brand")
    if (b.archivedAt) throw badRequest(`${b.name} is archived. Restore it to attach dossiers.`)
    return b
  }

  view(d: Dossier, people: Map<string, string>) {
    return {
      id: d.id,
      kind: d.kind,
      title: d.title,
      sourceUrl: d.sourceUrl,
      fileName: d.fileName,
      fileType: d.fileType,
      fileTypeLabel: d.fileType ? DOSSIER_TYPES[d.fileType as DossierType]?.label ?? d.fileType : null,
      sizeBytes: d.sizeBytes,
      size: d.sizeBytes ? mb(d.sizeBytes) : null,
      status: d.status,
      statusNote: d.statusNote,
      origin: d.origin,
      note: d.note,
      createdAt: d.createdAt,
      createdBy: d.createdById ? (people.get(d.createdById) ?? null) : null,
      storedAt: d.storedAt,
      archivedAt: d.archivedAt,
      archiveReason: d.archiveReason,
      google: !!d.googleFileId,
      checked: d.checkedAt ? { at: d.checkedAt, by: d.checkedByLabel, note: d.checkNote, versionDate: d.checkVersionDate ? d.checkVersionDate.toISOString().slice(0, 10) : null, self: d.selfChecked } : null,
    }
  }

  /** A brand's dossiers, newest first; archived ones last. */
  async list(brandId: string) {
    const rows = await this.prisma.dossier.findMany({ where: { brandId }, orderBy: [{ archivedAt: { sort: "desc", nulls: "first" } }, { createdAt: "desc" }] })
    const ids = [...new Set(rows.map((r) => r.createdById).filter((x): x is string => !!x))]
    const people = new Map((await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]))
    return { dossiers: rows.map((r) => this.view(r, people)), storage: { configured: this.storage.configured }, maxMb: (await this.maxBytes()) / 1024 / 1024 }
  }

  // ---------------------------------------------------------------- Upload

  /** Stores an uploaded PDF or Word file for the brand. */
  async upload(brandId: string, file: UploadedFile | undefined, note: string, me: RequestUser, ip: string | null) {
    this.canAttach(me)
    if (!file?.buffer) throw badRequest("Choose a PDF or Word file to upload.")
    const b = await this.brand(this.prisma, brandId)
    const fileName = safeFileName(utf8Name(file.originalname))
    const checked = checkDossier(file.buffer, fileName, await this.maxBytes())
    if ("error" in checked) throw badRequest(`${fileName}: ${checked.error}`)
    const sha = createHash("sha256").update(file.buffer).digest("hex")
    const twin = await this.prisma.dossier.findFirst({ where: { brandId, sha256: sha, archivedAt: null, status: "stored" } })
    if (twin) throw conflict(`This file is already attached to ${b.name} as "${twin.title}".`)
    const type = DOSSIER_TYPES[checked.type]
    const key = this.storage.key("dossiers", brandId, `${randomUUID()}.${type.ext}`)
    // The row first (status uploading), then the file: a failed upload is visible, never a file nobody knows about.
    const row = await this.prisma.dossier.create({
      data: { brandId, kind: "file", title: fileName, fileKey: key, fileName, fileType: checked.type, contentType: type.contentType, sizeBytes: file.buffer.length, sha256: sha, status: "uploading", origin: "upload", note, createdById: me.id },
    })
    try {
      await this.storage.put(key, file.buffer, type.contentType, { brand: brandId, dossier: row.id, "uploaded-by": me.email })
    } catch (e) {
      await this.prisma.dossier.update({ where: { id: row.id }, data: { status: "failed", statusNote: e instanceof Error ? e.message : String(e) } })
      throw e
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.dossier.update({ where: { id: row.id }, data: { status: "stored", storedAt: new Date() } })
      await this.audit.record({ actor: me, section: SECTION, action: `${b.name}: uploaded the dossier ${fileName}`, entityType: "brand", entityId: brandId, after: `${type.label}, ${mb(file.buffer.length)}\nSHA-256 ${sha}${note ? `\nNote: ${note}` : ""}`, ip }, tx)
    })
    return this.list(brandId)
  }

  // ---------------------------------------------------------------- Links

  /** Adds a link (by hand or from an import) and queues its download. Pass `db` to add it inside a transaction. */
  async addLinkIn(db: Prisma.TransactionClient, brandId: string, rawUrl: string, opts: { title?: string; origin: "link" | "import"; importBatchId?: string | null; me: RequestUser; ip: string | null; brandName: string }) {
    const checked = checkLink(rawUrl)
    if ("error" in checked) throw badRequest(checked.error)
    const g = googleFile(checked.url)
    if (g && "error" in g) throw badRequest(g.error)
    if (g) {
      // A private Google file: kept as a link, opened with each person's own sign-in. Nothing is downloaded.
      const gTwin = await db.dossier.findFirst({ where: { brandId, googleFileId: g.id, archivedAt: null } })
      if (gTwin) return { dossier: gTwin, added: false }
      const gTitle = safeFileName(opts.title?.trim() || `${g.label} dossier`, "Google dossier")
      const gd = await db.dossier.create({
        data: { brandId, kind: "link", title: gTitle, sourceUrl: checked.url, googleFileId: g.id, status: "linked", origin: opts.origin, importBatchId: opts.importBatchId ?? null, createdById: opts.me.id },
      })
      await this.audit.record({ actor: opts.me, section: SECTION, action: `${opts.brandName}: added the ${g.label} link ${gTitle}${opts.origin === "import" ? " (import)" : ""}`, entityType: "brand", entityId: brandId, after: checked.url, ip: opts.ip }, db)
      return { dossier: gd, added: true }
    }
    const twin = await db.dossier.findFirst({ where: { brandId, sourceUrl: checked.url, archivedAt: null } })
    if (twin) return { dossier: twin, added: false }
    const title = safeFileName(opts.title?.trim() || this.titleFor(checked.url), "Dossier link")
    const stored = this.storage.configured
    const d = await db.dossier.create({
      data: {
        brandId,
        kind: "link",
        title,
        sourceUrl: checked.url,
        status: stored ? "queued" : "link_only",
        statusNote: stored ? null : "File storage isn't set up yet, so the link is kept as a link. Fetch it again once S3 is set up.",
        origin: opts.origin,
        importBatchId: opts.importBatchId ?? null,
        createdById: opts.me.id,
      },
    })
    if (stored) await this.queue.enqueue("dossier.fetch", { dossierId: d.id }, { db, maxAttempts: 4, createdById: opts.me.id })
    await this.audit.record({ actor: opts.me, section: SECTION, action: `${opts.brandName}: added the dossier link ${title}${opts.origin === "import" ? " (import)" : ""}`, entityType: "brand", entityId: brandId, after: checked.url, ip: opts.ip }, db)
    return { dossier: d, added: true }
  }

  async addLink(brandId: string, url: string, title: string | undefined, me: RequestUser, ip: string | null) {
    this.canAttach(me)
    await this.prisma.$transaction(async (tx) => {
      const b = await this.brand(tx, brandId)
      const r = await this.addLinkIn(tx, brandId, url, { title, origin: "link", me, ip, brandName: b.name })
      if (!r.added) throw conflict(`This link is already attached to ${b.name} as "${r.dossier.title}".`)
    })
    return this.list(brandId)
  }

  private titleFor(url: string) {
    try {
      const u = new URL(url)
      const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "")
      return /\.(pdf|docx?)$/i.test(last) ? last : `Dossier from ${u.hostname.replace(/^www\./, "")}`
    } catch {
      return "Dossier link"
    }
  }

  /** The background download of a link. Temporary failures are retried by the queue; lasting ones keep the link. */
  private async fetchJob(id: string, job: Job) {
    const d = await this.prisma.dossier.findUnique({ where: { id }, include: { brand: { select: { name: true } } } })
    if (!d) return "The dossier is gone."
    if (d.kind !== "link" || !d.sourceUrl || d.archivedAt || d.status === "stored" || d.googleFileId) return `Nothing to do (${d.archivedAt ? "archived" : d.googleFileId ? "Google link" : d.status}).`
    await this.prisma.dossier.update({ where: { id }, data: { status: "fetching", fetchAttempts: { increment: 1 } } })
    const keepLink = async (reason: string) => {
      await this.prisma.dossier.update({ where: { id }, data: { status: "link_only", statusNote: reason } })
      await this.audit.record({ actor: SYSTEM, section: SECTION, action: `${d.brand.name}: couldn't fetch the dossier link ${d.title}`, entityType: "brand", entityId: d.brandId, after: d.sourceUrl, reason })
      return `Kept as a link: ${reason}`
    }
    const maxBytes = await this.maxBytes()
    const r = await fetchLink(d.sourceUrl, maxBytes)
    const google = isGoogleLink(d.sourceUrl)
    if (!r.ok) {
      // A private Google file is a normal case (the shared drive is locked), not a failure: keep the link, calmly.
      if (google && /sign-in|HTTP 40[13]/.test(r.reason)) return keepLink(GOOGLE_PRIVATE_NOTE)
      if (r.permanent || job.attempts >= job.maxAttempts) return keepLink(r.reason)
      await this.prisma.dossier.update({ where: { id }, data: { status: "queued", statusNote: r.reason } })
      throw new Error(r.reason)
    }
    const checked = checkDossier(r.buf, null, maxBytes)
    if ("error" in checked && google && checked.error === "This is a web page, not a file.") return keepLink(GOOGLE_PRIVATE_NOTE)
    if ("error" in checked) return keepLink(checked.error === "This is a web page, not a file." ? "The link opens a web page, not a file (often a sign-in or preview page). Share the file as \"Anyone with the link\", use its direct download link, or download it and upload it by hand." : checked.error)
    const sha = createHash("sha256").update(r.buf).digest("hex")
    const twin = await this.prisma.dossier.findFirst({ where: { brandId: d.brandId, sha256: sha, archivedAt: null, status: "stored", id: { not: id } } })
    if (twin) return keepLink(`It's the same file as "${twin.title}", which is already attached.`)
    const type = DOSSIER_TYPES[checked.type]
    const named = r.fileName ? safeFileName(r.fileName) : null
    const fileName = named && extOf(named) === type.ext ? named : `${(named ?? d.title).replace(/\.[a-z0-9]{1,8}$/i, "")}.${type.ext}`
    const key = this.storage.key("dossiers", d.brandId, `${randomUUID()}.${type.ext}`)
    try {
      await this.storage.put(key, r.buf, type.contentType, { brand: d.brandId, dossier: id, source: d.sourceUrl.slice(0, 200) })
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      if (job.attempts >= job.maxAttempts) {
        await this.prisma.dossier.update({ where: { id }, data: { status: "failed", statusNote: why } })
        return `Storage failed: ${why}`
      }
      await this.prisma.dossier.update({ where: { id }, data: { status: "queued", statusNote: why } })
      throw e
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.dossier.update({ where: { id }, data: { status: "stored", statusNote: null, storedAt: new Date(), fileKey: key, fileName, fileType: checked.type, contentType: type.contentType, sizeBytes: r.buf.length, sha256: sha } })
      await this.audit.record({ actor: SYSTEM, section: SECTION, action: `${d.brand.name}: stored the dossier ${fileName} from its link`, entityType: "brand", entityId: d.brandId, after: `${type.label}, ${mb(r.buf.length)}\nFrom ${r.finalUrl}\nSHA-256 ${sha}` }, tx)
    })
    this.log.log(`Stored ${fileName} for ${d.brand.name} (${mb(r.buf.length)}).`)
    return `Stored ${fileName} (${mb(r.buf.length)}).`
  }

  /** Tries a link again (after it was shared publicly, or once storage is set up). */
  async retry(id: string, me: RequestUser, ip: string | null) {
    this.canAttach(me)
    const d = await this.prisma.dossier.findUnique({ where: { id }, include: { brand: { select: { name: true } } } })
    if (!d) throw notFound("That dossier")
    if (d.kind !== "link" || d.archivedAt) throw badRequest("Only links can be fetched again.")
    if (d.googleFileId || isGoogleLink(d.sourceUrl ?? "")) throw badRequest("Google links are kept as links: they open in Google with your own sign-in. To keep a copy in storage, upload the PDF.")
    if (!["link_only", "failed"].includes(d.status)) throw conflict("This link is already stored or being fetched.")
    if (!this.storage.configured) throw badRequest("File storage isn't set up yet: add S3_BUCKET to the server's .env first.")
    await this.prisma.$transaction(async (tx) => {
      await tx.dossier.update({ where: { id }, data: { status: "queued", statusNote: null } })
      await this.queue.enqueue("dossier.fetch", { dossierId: id }, { db: tx, maxAttempts: 4, createdById: me.id })
      await this.audit.record({ actor: me, section: SECTION, action: `${d.brand.name}: fetch the dossier link ${d.title} again`, entityType: "brand", entityId: d.brandId, after: d.sourceUrl, ip }, tx)
    })
    return this.list(d.brandId)
  }

  // ---------------------------------------------------------------- Reading, archiving

  /** A 5-minute download link, logged. */
  async download(id: string, me: RequestUser, ip: string | null) {
    const d = await this.prisma.dossier.findUnique({ where: { id }, include: { brand: { select: { name: true } } } })
    if (!d) throw notFound("That dossier")
    if (d.status !== "stored" || !d.fileKey) throw badRequest(d.kind === "link" ? "This dossier is only a link: open the link instead." : "This file isn't stored.")
    const link = await this.storage.downloadLink(d.fileKey, d.fileName ?? d.title, d.contentType ?? "application/octet-stream")
    await this.audit.record({ actor: me, section: SECTION, action: `${d.brand.name}: downloaded the dossier ${d.fileName ?? d.title}`, entityType: "brand", entityId: d.brandId, ip })
    return link
  }

  // ---------------------------------------------------------------- Mark as checked

  private canCheck(me: RequestUser) {
    const ok = ["kb.enter_facts", "kb.import", "kb.verify_facts", "kb.verify_own_facts"].some((p) => me.permissions.has(p))
    if (!ok) throw forbidden("Your roles don't allow checking dossiers.")
  }

  /**
   * Marks a dossier as checked: the person opened it (a Google link with their own sign-in, or the stored file) and
   * confirmed it's the right, correct dossier for the brand. `versionDate` is the version they read (Google's
   * "Last edit" date). The person who added it may check it; that is recorded as self-checked.
   */
  async check(id: string, dto: { note?: string; versionDate?: string | null }, me: RequestUser, ip: string | null) {
    this.canCheck(me)
    const d = await this.prisma.dossier.findUnique({ where: { id }, include: { brand: { select: { name: true } } } })
    if (!d) throw notFound("That dossier")
    if (d.archivedAt) throw badRequest("This dossier is archived. Restore it first.")
    if (!["stored", "linked", "link_only"].includes(d.status)) throw badRequest("This dossier isn't ready to check yet.")
    if (d.checkedAt) throw conflict(`This dossier was already checked by ${d.checkedByLabel ?? "someone"}.`)
    const today = localDate(new Date(), await this.workTime.timezone())
    const versionDate = dto.versionDate || null
    if (versionDate && (!/^\d{4}-\d{2}-\d{2}$/.test(versionDate) || Number.isNaN(Date.parse(versionDate)))) throw badRequest("Enter the version date as a date.")
    if (versionDate && versionDate > today) throw badRequest("The version date can't be in the future.")
    const self = d.createdById === me.id
    const note = (dto.note ?? "").trim().slice(0, 1000)
    await this.prisma.$transaction(async (tx) => {
      await tx.dossier.update({ where: { id }, data: { checkedAt: new Date(), checkedById: me.id, checkedByLabel: actorLabel(me), checkNote: note, checkVersionDate: versionDate ? new Date(`${versionDate}T00:00:00Z`) : null, selfChecked: self } })
      await this.audit.record(
        { actor: me, section: SECTION, action: `${d.brand.name}: marked the dossier ${d.title} as checked${self ? " (self-checked)" : ""}`, entityType: "brand", entityId: d.brandId, after: [versionDate && `Version of ${versionDate}`, note && `Note: ${note}`].filter(Boolean).join("\n") || undefined, ip },
        tx,
      )
    })
    return this.list(d.brandId)
  }

  /** Takes a check back (it was the wrong file, or it changed), with a reason. The earlier check stays in the change log. */
  async uncheck(id: string, reason: string, me: RequestUser, ip: string | null) {
    this.canCheck(me)
    const d = await this.prisma.dossier.findUnique({ where: { id }, include: { brand: { select: { name: true } } } })
    if (!d) throw notFound("That dossier")
    if (!d.checkedAt) return this.list(d.brandId)
    await this.prisma.$transaction(async (tx) => {
      await tx.dossier.update({ where: { id }, data: { checkedAt: null, checkedById: null, checkedByLabel: null, checkNote: "", checkVersionDate: null, selfChecked: false } })
      await this.audit.record(
        { actor: me, section: SECTION, action: `${d.brand.name}: took back the check on the dossier ${d.title}`, entityType: "brand", entityId: d.brandId, before: `Checked by ${d.checkedByLabel ?? "someone"} on ${d.checkedAt!.toISOString().slice(0, 10)}${d.checkNote ? `\nNote: ${d.checkNote}` : ""}`, reason, ip },
        tx,
      )
    })
    return this.list(d.brandId)
  }

  async archive(id: string, reason: string, me: RequestUser, ip: string | null) {
    this.canAttach(me)
    const d = await this.prisma.dossier.findUnique({ where: { id }, include: { brand: { select: { name: true } } } })
    if (!d) throw notFound("That dossier")
    if (d.archivedAt) return this.list(d.brandId)
    await this.prisma.$transaction(async (tx) => {
      await tx.dossier.update({ where: { id }, data: { archivedAt: new Date(), archivedById: me.id, archiveReason: reason } })
      await this.audit.record({ actor: me, section: SECTION, action: `${d.brand.name}: archived the dossier ${d.title}`, entityType: "brand", entityId: d.brandId, reason, ip }, tx)
    })
    return this.list(d.brandId)
  }

  async restore(id: string, me: RequestUser, ip: string | null) {
    this.canAttach(me)
    const d = await this.prisma.dossier.findUnique({ where: { id }, include: { brand: { select: { name: true } } } })
    if (!d) throw notFound("That dossier")
    if (!d.archivedAt) return this.list(d.brandId)
    await this.prisma.$transaction(async (tx) => {
      await tx.dossier.update({ where: { id }, data: { archivedAt: null, archivedById: null, archiveReason: null } })
      await this.audit.record({ actor: me, section: SECTION, action: `${d.brand.name}: restored the dossier ${d.title}`, entityType: "brand", entityId: d.brandId, ip }, tx)
    })
    return this.list(d.brandId)
  }
}
