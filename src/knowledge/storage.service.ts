import { createHash } from "node:crypto"

import { GetObjectCommand, HeadBucketCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"
import { Injectable, Logger, ServiceUnavailableException } from "@nestjs/common"

import { appConfig } from "../config"

// File storage: Amazon S3. The bucket is private (Block Public Access on); nothing is ever served from it directly.
// Every object is written with server-side encryption (S3-managed AES-256, or a KMS key) and an SHA-256 checksum
// that S3 verifies on arrival. Files are read through short-lived signed links (5 minutes), which the server makes
// only for someone allowed to see the brand, and each one is written to the change log.
//
// Keys are made by the system (<prefix>/dossiers/<brand id>/<random id>.<ext>), never from a file name, so a name
// can't reach another folder or overwrite a file. Objects are never deleted by the app.

const LINK_SECONDS = 300

@Injectable()
export class StorageService {
  private readonly log = new Logger("Storage")
  private readonly cfg = appConfig().storage
  private client: S3Client | null = null

  /** True when S3_BUCKET is set. Without it, uploads are refused with a clear message (links are still kept). */
  get configured() {
    return !!this.cfg.bucket
  }

  private s3() {
    if (!this.configured) throw new ServiceUnavailableException("File storage isn't set up yet: add S3_BUCKET (and S3_REGION) to the server's .env and restart it.")
    this.client ??= new S3Client({
      region: this.cfg.region,
      endpoint: this.cfg.endpoint,
      forcePathStyle: this.cfg.forcePathStyle,
      credentials: this.cfg.accessKeyId ? { accessKeyId: this.cfg.accessKeyId, secretAccessKey: this.cfg.secretAccessKey } : undefined,
      maxAttempts: 3,
    })
    return this.client
  }

  key(...parts: string[]) {
    return [this.cfg.prefix, ...parts].filter(Boolean).join("/")
  }

  /** Stores a file. Returns its SHA-256 (hex). Throws a readable error when S3 refuses. */
  async put(key: string, body: Buffer, contentType: string, meta: Record<string, string> = {}) {
    const sha = createHash("sha256").update(body).digest()
    try {
      await this.s3().send(
        new PutObjectCommand({
          Bucket: this.cfg.bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          ContentLength: body.length,
          ChecksumSHA256: sha.toString("base64"),
          ServerSideEncryption: this.cfg.kmsKeyId ? "aws:kms" : "AES256",
          SSEKMSKeyId: this.cfg.kmsKeyId,
          // Metadata must be plain ASCII.
          Metadata: Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, v.replace(/[^\x20-\x7e]/g, "?").slice(0, 200)])),
        }),
      )
    } catch (e) {
      if (e instanceof ServiceUnavailableException) throw e
      const message = e instanceof Error ? e.message : String(e)
      this.log.error(`Upload to s3://${this.cfg.bucket}/${key} failed: ${message}`)
      throw new ServiceUnavailableException(`The file couldn't be stored (${message}). Try again; if it keeps failing, check Settings → Facts → Storage.`, { cause: e })
    }
    return sha.toString("hex")
  }

  /** A link that downloads the file for the next 5 minutes, under its own name. */
  async downloadLink(key: string, fileName: string, contentType: string) {
    const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_")
    const disposition = `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
    const url = await getSignedUrl(this.s3(), new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key, ResponseContentDisposition: disposition, ResponseContentType: contentType }), { expiresIn: LINK_SECONDS })
    return { url, expiresInSeconds: LINK_SECONDS }
  }

  /**
   * For Settings: is storage set up, and does it work? First asks for the bucket; whatever the answer, then writes
   * a tiny test file (<prefix>/_storage-check.txt, overwritten each time), because uploading is what matters and
   * keys limited to one folder often can't look at the bucket itself. Errors are turned into plain reasons.
   */
  async status() {
    const base = { configured: this.configured, bucket: this.cfg.bucket || null, region: this.cfg.region, prefix: this.cfg.prefix, encryption: this.cfg.kmsKeyId ? "KMS key" : "S3-managed (AES-256)" }
    if (!this.configured) return { ...base, ok: false, error: "S3_BUCKET isn't set in the server's .env.", note: null as string | null }
    let bucketNote: string | null = null
    try {
      await this.s3().send(new HeadBucketCommand({ Bucket: this.cfg.bucket }))
    } catch (e) {
      const why = this.explain(e)
      // A wrong region or a missing bucket won't be fixed by the write test: say so now.
      if (why.fatal) return { ...base, ok: false, error: why.text, note: null }
      bucketNote = why.text
    }
    try {
      await this.put(this.key("_storage-check.txt"), Buffer.from(`ATM CRM storage check ${new Date().toISOString()}\n`), "text/plain")
      return { ...base, ok: true, error: null, note: bucketNote ? "Uploads work. (The keys can't look at the bucket itself, which is fine.)" : null }
    } catch (e) {
      const cause = (e as { cause?: unknown }).cause ?? e
      return { ...base, ok: false, error: `Uploading a test file failed: ${this.explain(cause).text}`, note: null }
    }
  }

  /** An S3 error as a sentence someone can act on. */
  private explain(e: unknown): { text: string; fatal: boolean } {
    const err = e as { name?: string; Code?: string; message?: string; $metadata?: { httpStatusCode?: number }; $response?: { headers?: Record<string, string> } }
    const code = err.Code ?? err.name ?? ""
    const status = err.$metadata?.httpStatusCode
    const realRegion = err.$response?.headers?.["x-amz-bucket-region"]
    const msg = err.message ?? String(e)
    if (realRegion && realRegion !== this.cfg.region) return { text: `The bucket is in ${realRegion}, not ${this.cfg.region}. Set S3_REGION=${realRegion} in .env and restart.`, fatal: true }
    if (status === 301 || code === "PermanentRedirect" || code === "AuthorizationHeaderMalformed" || /region/i.test(msg)) return { text: `The bucket isn't in ${this.cfg.region}. Ask which region it's in and set S3_REGION to that. (${code || status})`, fatal: true }
    if (status === 404 || code === "NoSuchBucket" || code === "NotFound") return { text: `There's no bucket called ${this.cfg.bucket}. Check S3_BUCKET.`, fatal: true }
    if (code === "InvalidAccessKeyId") return { text: "AWS doesn't know this access key. Check S3_ACCESS_KEY_ID (no spaces or quotes), or the key was deleted.", fatal: false }
    if (code === "SignatureDoesNotMatch") return { text: "The secret key doesn't match the access key. Check S3_SECRET_ACCESS_KEY: no spaces or quotes around it, nothing missing.", fatal: false }
    if (code === "AccessDenied" || code === "Forbidden" || status === 403) return { text: `The keys aren't allowed to do this. They need s3:PutObject and s3:GetObject on ${this.cfg.bucket}/${this.cfg.prefix}/* (and s3:ListBucket to check the bucket).`, fatal: false }
    if (code === "InvalidArgument" || /encrypt|kms/i.test(msg)) return { text: `The bucket wants a different encryption setting (${msg}). If it uses a KMS key, set S3_KMS_KEY_ID.`, fatal: false }
    if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|getaddrinfo/i.test(msg)) return { text: `The server can't reach AWS (${msg}). Check its internet connection.`, fatal: true }
    return { text: `${code || "Error"}${status ? ` (HTTP ${status})` : ""}: ${msg}`, fatal: false }
  }
}
