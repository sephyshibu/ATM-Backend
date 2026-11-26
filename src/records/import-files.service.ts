import { createHash, randomUUID } from "node:crypto"

import { Injectable } from "@nestjs/common"

import { AuditService } from "../audit/audit.service"
import { badRequest, conflict, forbidden, notFound } from "../common/errors"
import type { RequestUser } from "../common/request-user"
import { type UploadedFile, utf8Name } from "../knowledge/dossiers.service"
import { checkSheet, mb, safeFileName, SHEET_TYPES } from "../knowledge/file-check"
import { StorageService } from "../knowledge/storage.service"
import { PrismaService } from "../prisma/prisma.service"

// The original Excel or CSV file behind an import, kept in S3 so every import can be traced back to the exact
// file. The rows are imported first (the browser reads the file and sends the mapped rows); the browser then sends
// the file itself, and it's stored at:
//   <prefix>/imports/<brands|products>/<yyyy-mm>/<import id>/<random id>.<xlsx|csv>
// The key is made by the system, never from the file name; the name is kept in the database and used for the
// download. Only the person who ran the import can attach its file, once, within a day, and only a file with the
// same name. Nothing is ever deleted.

const SECTION = "Records"
export const IMPORT_FILE_MAX_BYTES = 25 * 1024 * 1024
const ATTACH_WITHIN_MS = 24 * 60 * 60 * 1000

@Injectable()
export class ImportFilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  async attach(batchId: string, file: UploadedFile | undefined, me: RequestUser, ip: string | null) {
    const batch = await this.prisma.importBatch.findUnique({ where: { id: batchId } })
    if (!batch) throw notFound("That import")
    if (batch.createdById !== me.id) throw forbidden("Only the person who ran this import can attach its file.")
    if (Date.now() - batch.createdAt.getTime() > ATTACH_WITHIN_MS) throw badRequest("The file can only be attached on the day of the import.")
    if (batch.fileStatus === "stored") throw conflict("This import's file is already stored.")
    if (!file?.buffer) throw badRequest("Choose the Excel or CSV file you imported.")
    const fileName = safeFileName(utf8Name(file.originalname), "import")
    if (fileName !== safeFileName(batch.fileName, "import")) throw badRequest(`This import came from ${batch.fileName}; attach that file, not ${fileName}.`)
    const checked = checkSheet(file.buffer, fileName, IMPORT_FILE_MAX_BYTES)
    if ("error" in checked) throw badRequest(`${fileName}: ${checked.error}`)
    if (!this.storage.configured) {
      await this.prisma.importBatch.update({ where: { id: batchId }, data: { fileStatus: "failed", fileStatusNote: "File storage isn't set up." } })
      throw badRequest("File storage isn't set up, so the file wasn't kept. The import itself is complete.")
    }
    const type = SHEET_TYPES[checked.type]
    const sha = createHash("sha256").update(file.buffer).digest("hex")
    const month = batch.createdAt.toISOString().slice(0, 7)
    const key = this.storage.key("imports", batch.kind, month, batch.id, `${randomUUID()}.${type.ext}`)
    try {
      await this.storage.put(key, file.buffer, type.contentType, { import: batch.id, kind: batch.kind, "uploaded-by": me.email })
    } catch (e) {
      await this.prisma.importBatch.update({ where: { id: batchId }, data: { fileStatus: "failed", fileStatusNote: (e instanceof Error ? e.message : String(e)).slice(0, 500) } })
      throw e
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.importBatch.update({ where: { id: batchId }, data: { fileKey: key, fileType: checked.type, fileSizeBytes: file.buffer.length, fileSha256: sha, fileStatus: "stored", fileStatusNote: null, fileStoredAt: new Date() } })
      await this.audit.record({ actor: me, section: SECTION, action: `Stored the imported file ${fileName}`, entityType: "import_batch", entityId: batchId, after: `${type.label}, ${mb(file.buffer.length)}\nSHA-256 ${sha}`, ip }, tx)
    })
    return { stored: true, fileName, size: file.buffer.length }
  }

  /** A short-lived download link for an import's original file. */
  async download(batchId: string, me: RequestUser, ip: string | null) {
    const batch = await this.prisma.importBatch.findUnique({ where: { id: batchId } })
    if (!batch) throw notFound("That import")
    if (batch.fileStatus !== "stored" || !batch.fileKey) throw badRequest("The file for this import isn't stored.")
    const link = await this.storage.downloadLink(batch.fileKey, batch.fileName, SHEET_TYPES[(batch.fileType as "xlsx" | "csv") ?? "xlsx"].contentType)
    await this.audit.record({ actor: me, section: SECTION, action: `Downloaded the imported file ${batch.fileName}`, entityType: "import_batch", entityId: batchId, ip })
    return link
  }
}
