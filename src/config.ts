// Settings that come from the environment (.env), read once and checked at start-up.

/** Every route lives under this: http://localhost:3000/api/v1/… A future v2 can sit beside it. */
export const API_PREFIX = "api/v1"

const list = (v?: string) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export type AppConfig = ReturnType<typeof readConfig>

export function readConfig() {
  const env = process.env
  const appEnv = (env.APP_ENV ?? "development") as "development" | "staging" | "production"
  const production = appEnv === "production"
  const port = num(env.PORT, 3000)
  const config = {
    appEnv,
    production,
    port,
    frontendUrl: (env.FRONTEND_URL ?? "http://localhost:5173").replace(/\/$/, ""),
    google: {
      clientId: env.GOOGLE_CLIENT_ID ?? "",
      clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
      // Must be listed exactly under "Authorised redirect URIs" in Google Cloud Console.
      callbackUrl: env.GOOGLE_CALLBACK_URL ?? `http://localhost:${port}/${API_PREFIX}/auth/google/callback`,
      allowedDomains: list(env.GOOGLE_ALLOWED_DOMAINS),
    },
    /** Google Calendar for booking pages: same OAuth client as sign-in, its own redirect URI and an encryption key. */
    calendar: {
      callbackUrl: (env.GOOGLE_CALENDAR_CALLBACK_URL ?? `http://localhost:${port}/${API_PREFIX}/calendar/google/callback`).trim(),
      /** 64 hex characters (32 bytes). Encrypts stored calendar tokens and signs the connect request. */
      encKey: (env.CALENDAR_ENC_KEY ?? "").trim(),
    },
    seedAdminEmails: list(env.SEED_ADMIN_EMAILS),
    sessionDays: num(env.SESSION_DAYS, 7),
    inviteDays: num(env.INVITE_DAYS, 7),
    mail: {
      transport: env.MAIL_TRANSPORT === "smtp" ? ("smtp" as const) : ("log" as const),
      from: env.MAIL_FROM ?? "ATM CRM <no-reply@example.com>",
      smtpHost: env.SMTP_HOST ?? "",
      smtpPort: num(env.SMTP_PORT, 587),
      smtpUser: env.SMTP_USER ?? "",
      smtpPass: env.SMTP_PASS ?? "",
    },
    /** Dossier files. A private S3 bucket; Singapore (ap-southeast-1) by default, for PDPA. */
    storage: {
      bucket: (env.S3_BUCKET ?? "").trim(),
      region: (env.S3_REGION ?? "ap-southeast-1").trim(),
      /** Leave both empty on AWS (EC2, ECS, Lambda): the server's IAM role is used, with no keys to leak. */
      accessKeyId: (env.S3_ACCESS_KEY_ID ?? "").trim(),
      secretAccessKey: (env.S3_SECRET_ACCESS_KEY ?? "").trim(),
      /** Only for an S3-compatible store in development (MinIO, LocalStack). */
      endpoint: (env.S3_ENDPOINT ?? "").trim() || undefined,
      forcePathStyle: env.S3_FORCE_PATH_STYLE === "true",
      /** A KMS key for encryption at rest; empty = S3-managed keys (AES-256). */
      kmsKeyId: (env.S3_KMS_KEY_ID ?? "").trim() || undefined,
      /** Folder in the bucket, so several environments can share one bucket safely. */
      prefix: (env.S3_PREFIX ?? appEnv).trim().replace(/^\/+|\/+$/g, ""),
    },
  }
  if (production && (!config.google.clientId || !config.google.clientSecret)) throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required when APP_ENV=production.")
  if (!!config.storage.accessKeyId !== !!config.storage.secretAccessKey) throw new Error("Set both S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY, or neither (to use the server's IAM role).")
  if (config.calendar.encKey && !/^[0-9a-fA-F]{64}$/.test(config.calendar.encKey)) throw new Error("CALENDAR_ENC_KEY must be 64 hex characters (run: openssl rand -hex 32).")
  if (config.mail.transport === "smtp" && !config.mail.smtpHost) throw new Error("SMTP_HOST is required when MAIL_TRANSPORT=smtp.")
  return config
}

let cached: AppConfig | undefined
export const appConfig = () => (cached ??= readConfig())
