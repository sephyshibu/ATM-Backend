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
  }
  if (production && (!config.google.clientId || !config.google.clientSecret)) throw new Error("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are required when APP_ENV=production.")
  if (config.mail.transport === "smtp" && !config.mail.smtpHost) throw new Error("SMTP_HOST is required when MAIL_TRANSPORT=smtp.")
  return config
}

let cached: AppConfig | undefined
export const appConfig = () => (cached ??= readConfig())
