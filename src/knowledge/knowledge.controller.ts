import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Put, Req, UploadedFile, UseInterceptors } from "@nestjs/common"
import { FileInterceptor } from "@nestjs/platform-express"

import { CurrentUser, RequirePermissions } from "../common/decorators"
import { requestIp, type AppRequest, type RequestUser } from "../common/request-user"
import { DossiersService, type UploadedFile as Uploaded } from "./dossiers.service"
import { FactsService } from "./facts.service"
import { AddLinkDto, ArchiveDossierDto, CheckDossierDto, CreateFactDefinitionDto, RejectFactDto, SaveFactDto, UncheckDossierDto, UpdateFactDefinitionDto, UploadDossierDto, VerifyManyDto } from "./knowledge.dto"
import { StorageService } from "./storage.service"

// The knowledge base: a brand's dossiers (files in S3, or links) and its facts. Looking needs "View brands and
// people". Attaching dossiers and entering facts need "Enter facts" (or "Import brands and products" for
// dossiers); verifying needs "Verify facts" (others') or "Verify own facts". Settings → Facts needs Settings rights.

/**
 * Uploads are held in memory (never written to the server's disk) and stop at 50 MB before they reach the service;
 * the Configuration limit (up to 50 MB) is checked there.
 */
const UPLOAD_LIMIT = { limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 5, parts: 7 } }

@Controller("knowledge")
export class KnowledgeController {
  constructor(
    private readonly facts: FactsService,
    private readonly dossiers: DossiersService,
    private readonly storage: StorageService,
  ) {}

  // ---------------------------------------------------------------- A brand's knowledge base

  /** Status, every field with its current fact and history, and the brand's dossiers. */
  @Get("brands/:brandId")
  @RequirePermissions("records.view")
  async forBrand(@Param("brandId", ParseUUIDPipe) brandId: string, @CurrentUser() me: RequestUser) {
    const [kb, files] = await Promise.all([this.facts.forBrand(brandId, me), this.dossiers.list(brandId)])
    return { ...kb, ...files, can: { ...kb.can, attach: !kb.archived && (me.permissions.has("kb.enter_facts") || me.permissions.has("kb.import")) } }
  }

  /** Uploads a PDF or Word file (multipart field "file"). */
  @Post("brands/:brandId/dossiers")
  @RequirePermissions("records.view")
  @UseInterceptors(FileInterceptor("file", UPLOAD_LIMIT))
  upload(@Param("brandId", ParseUUIDPipe) brandId: string, @UploadedFile() file: Uploaded | undefined, @Body() dto: UploadDossierDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.dossiers.upload(brandId, file, dto.note ?? "", me, requestIp(req))
  }

  /** Adds a link; the file behind it is fetched into storage in the background. */
  @Post("brands/:brandId/links")
  @RequirePermissions("records.view")
  addLink(@Param("brandId", ParseUUIDPipe) brandId: string, @Body() dto: AddLinkDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.dossiers.addLink(brandId, dto.url, dto.title, me, requestIp(req))
  }

  @Get("dossiers/:id/download")
  @RequirePermissions("records.view")
  download(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.dossiers.download(id, me, requestIp(req))
  }

  @Post("dossiers/:id/retry")
  @RequirePermissions("records.view")
  retry(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.dossiers.retry(id, me, requestIp(req))
  }

  /** Marks a dossier as checked (the person who added it may check it too: recorded as self-checked). */
  @Post("dossiers/:id/check")
  @RequirePermissions("records.view")
  check(@Param("id", ParseUUIDPipe) id: string, @Body() dto: CheckDossierDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.dossiers.check(id, dto, me, requestIp(req))
  }

  @Post("dossiers/:id/uncheck")
  @RequirePermissions("records.view")
  uncheck(@Param("id", ParseUUIDPipe) id: string, @Body() dto: UncheckDossierDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.dossiers.uncheck(id, dto.reason, me, requestIp(req))
  }

  @Post("dossiers/:id/archive")
  @RequirePermissions("records.view")
  archive(@Param("id", ParseUUIDPipe) id: string, @Body() dto: ArchiveDossierDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.dossiers.archive(id, dto.reason, me, requestIp(req))
  }

  @Post("dossiers/:id/restore")
  @RequirePermissions("records.view")
  restore(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.dossiers.restore(id, me, requestIp(req))
  }

  /** Enters a fact: a new version, status Entered, waiting for a second person. */
  @Put("brands/:brandId/facts/:key")
  @RequirePermissions("kb.enter_facts")
  async saveFact(@Param("brandId", ParseUUIDPipe) brandId: string, @Param("key") key: string, @Body() dto: SaveFactDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    await this.facts.save(brandId, key, dto, me, requestIp(req))
    return { ok: true }
  }

  @Post("brands/:brandId/facts/verify")
  @RequirePermissions("records.view")
  verifyMany(@Param("brandId", ParseUUIDPipe) brandId: string, @Body() dto: VerifyManyDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.facts.verifyMany(brandId, dto.factIds, me, requestIp(req))
  }

  @Post("facts/:id/verify")
  @RequirePermissions("records.view")
  async verify(@Param("id", ParseUUIDPipe) id: string, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    await this.facts.verify(id, me, requestIp(req))
    return { ok: true }
  }

  @Post("facts/:id/reject")
  @RequirePermissions("kb.verify_facts")
  async reject(@Param("id", ParseUUIDPipe) id: string, @Body() dto: RejectFactDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    await this.facts.reject(id, dto, me, requestIp(req))
    return { ok: true }
  }

  // ---------------------------------------------------------------- Settings → Facts

  @Get("definitions")
  @RequirePermissions("records.view")
  definitions() {
    return this.facts.definitions()
  }

  @Post("definitions")
  @RequirePermissions("settings.edit")
  createDefinition(@Body() dto: CreateFactDefinitionDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.facts.createDefinition(dto, me, requestIp(req))
  }

  @Patch("definitions/:key")
  @RequirePermissions("settings.edit")
  updateDefinition(@Param("key") key: string, @Body() dto: UpdateFactDefinitionDto, @CurrentUser() me: RequestUser, @Req() req: AppRequest) {
    return this.facts.updateDefinition(key, dto, me, requestIp(req))
  }

  /** Is S3 set up and reachable? For Settings → Facts. */
  @Get("storage")
  @RequirePermissions("settings.view")
  storageStatus() {
    return this.storage.status()
  }
}
