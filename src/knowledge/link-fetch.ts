import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns"
import http from "node:http"
import https from "node:https"
import { isIP, type LookupFunction } from "node:net"

// Fetches a dossier from a link in the Brand Register, safely. A link comes from a spreadsheet, so it is treated
// as untrusted:
//   - only http and https on the normal ports (80, 443);
//   - the address it resolves to must be public: private, loopback, link-local and cloud-metadata addresses are
//     refused at connection time (also after each redirect), so a link can't reach the server's own network;
//   - at most 5 redirects, 60 seconds in all, and no more bytes than the size limit (the download stops there).
// Share links from Google Drive, Google Docs, Dropbox and SharePoint are turned into their direct-download form.
// What comes back is then checked like an upload (file-check.ts).

export type FetchResult = { ok: true; buf: Buffer; fileName: string | null; finalUrl: string } | { ok: false; permanent: boolean; reason: string }

const MAX_REDIRECTS = 5
const TIMEOUT_MS = 60_000

/** True for addresses a fetched link must never reach. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = ip.startsWith("::ffff:") ? ip.slice(7) : ip
  if (isIP(v4) === 4) {
    const [a, b] = v4.split(".").map(Number)
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    )
  }
  const s = ip.toLowerCase()
  return s === "::" || s === "::1" || s.startsWith("fc") || s.startsWith("fd") || s.startsWith("fe8") || s.startsWith("fe9") || s.startsWith("fea") || s.startsWith("feb") || s.startsWith("ff") || s.startsWith("64:ff9b")
}

/** DNS lookup that refuses private addresses: used by the connection itself, so it can't be raced. */
function safeLookup(hostname: string, options: LookupOptions, callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0)
    const list = addresses as unknown as LookupAddress[]
    if (!list.length || list.some((a) => isPrivateAddress(a.address))) {
      const e: NodeJS.ErrnoException = new Error(`${hostname} points to a private network address, which links may not reach.`)
      e.code = "EPRIVATE"
      return callback(e, "", 0)
    }
    if (options.all) callback(null, list)
    else callback(null, list[0].address, list[0].family)
  })
}

/** A Google Drive, Docs, Sheets or Slides link. */
export function isGoogleLink(raw: string) {
  try {
    const host = new URL(raw).hostname.toLowerCase()
    return host === "drive.google.com" || host === "docs.google.com"
  } catch {
    return false
  }
}

/**
 * The Google file behind a Docs/Drive link, or why the link can't be a dossier (a folder, a search, no file id).
 * Not a Google link → null.
 */
export function googleFile(raw: string): { id: string; label: string } | { error: string } | null {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  const host = u.hostname.toLowerCase()
  if (host !== "drive.google.com" && host !== "docs.google.com") return null
  const doc = /^\/(document|spreadsheets|presentation|forms)\/(?:u\/\d+\/)?d\/([\w-]{10,})/.exec(u.pathname)
  if (doc) return { id: doc[2], label: { document: "Google Doc", spreadsheets: "Google Sheet", presentation: "Google Slides", forms: "Google Form" }[doc[1]] ?? "Google file" }
  if (/\/folders\//.test(u.pathname)) return { error: "This is a link to a Google Drive folder. Open the dossier and paste the link of the file itself." }
  const file = /\/file\/(?:u\/\d+\/)?d\/([\w-]{10,})/.exec(u.pathname)?.[1] ?? u.searchParams.get("id")
  if (file && /^[\w-]{10,}$/.test(file)) return { id: file, label: "Google Drive file" }
  return { error: "This Google link doesn't point to a file. Open the dossier in Google and copy its link (Share → Copy link)." }
}

/**
 * What the brand page says for a private Google file. The link is kept and opens in Google with the person's own
 * sign-in; the CRM copies it into storage through its own read-only Google reader account once that is set up.
 * Confidential dossiers are never to be shared as "Anyone with the link" to work around this.
 */
export const GOOGLE_PRIVATE_NOTE = "Opens in Google with your own sign-in. Open it, check it's the right dossier, and mark it as checked."

/** Share links → direct downloads. Anything else is returned as it is. */
export function directLink(raw: string): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return raw
  }
  const host = u.hostname.toLowerCase()
  if (host === "drive.google.com") {
    const id = /\/file\/d\/([\w-]+)/.exec(u.pathname)?.[1] ?? u.searchParams.get("id")
    if (id) return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(id)}`
  }
  if (host === "docs.google.com") {
    const m = /^\/(document|presentation|spreadsheets)\/d\/([\w-]+)/.exec(u.pathname)
    if (m) return `https://docs.google.com/${m[1]}/d/${m[2]}/export?format=pdf`
  }
  if (host === "www.dropbox.com" || host === "dropbox.com") {
    u.searchParams.set("dl", "1")
    return u.toString()
  }
  if (host.endsWith(".sharepoint.com")) {
    u.searchParams.set("download", "1")
    return u.toString()
  }
  return raw
}

/** Checks a link from a spreadsheet: a full http(s) address. Returns the tidy link or the reason it isn't one. */
export function checkLink(raw: string): { url: string } | { error: string } {
  const s = raw.trim()
  if (!s) return { error: "The link is empty." }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`
  let u: URL
  try {
    u = new URL(withScheme)
  } catch {
    return { error: `"${s.slice(0, 80)}" isn't a web address.` }
  }
  if (!["http:", "https:"].includes(u.protocol)) return { error: `"${s.slice(0, 80)}" isn't a web link (http or https).` }
  if (u.username || u.password) return { error: "Links with a user name or password in them aren't accepted." }
  if (!u.hostname.includes(".") || (isIP(u.hostname.replace(/^\[|\]$/g, "")) && isPrivateAddress(u.hostname.replace(/^\[|\]$/g, "")))) return { error: `"${u.hostname}" isn't a public web address.` }
  if (u.port && !["80", "443"].includes(u.port)) return { error: "Only links on the normal web ports are fetched." }
  if (s.length > 2000) return { error: "The link is longer than 2,000 characters." }
  return { url: u.toString() }
}

function fileNameFrom(disposition: string | undefined, url: URL): string | null {
  if (disposition) {
    const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(disposition)
    if (star) {
      try {
        return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""))
      } catch {
        /* fall through */
      }
    }
    const plain = /filename\s*=\s*"?([^";]+)"?/.exec(disposition)
    if (plain) return plain[1].trim()
  }
  const last = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "")
  return /\.(pdf|docx?|PDF|DOCX?)$/.test(last) ? last : null
}

function once(url: URL, deadline: number, maxBytes: number): Promise<{ redirect: string } | FetchResult> {
  return new Promise((resolve) => {
    // https.request takes the same arguments as http.request.
    const request = (url.protocol === "https:" ? https.request : http.request) as typeof http.request
    const literal = url.hostname.replace(/^\[|\]$/g, "")
    if (isIP(literal) && isPrivateAddress(literal)) return resolve({ ok: false, permanent: true, reason: "The link points to a private network address." })
    const req = request(
      url,
      {
        method: "GET",
        lookup: safeLookup as unknown as LookupFunction,
        headers: { "User-Agent": "ATM-CRM/1.0 (dossier fetch)", Accept: "application/pdf, application/vnd.openxmlformats-officedocument.wordprocessingml.document, application/msword;q=0.9, */*;q=0.1", "Accept-Encoding": "identity" },
        timeout: Math.max(1_000, deadline - Date.now()),
      },
      (res) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()
          return resolve({ redirect: new URL(res.headers.location, url).toString() })
        }
        if (status !== 200) {
          res.resume()
          if (status === 401 || status === 403) return resolve({ ok: false, permanent: true, reason: `The link needs a sign-in (HTTP ${status}). Share the file as "Anyone with the link", or download it and upload it by hand.` })
          if (status === 404 || status === 410) return resolve({ ok: false, permanent: true, reason: `Nothing is at this link any more (HTTP ${status}).` })
          if (status === 429 || status >= 500) return resolve({ ok: false, permanent: false, reason: `The site is busy or failing (HTTP ${status}). Trying again later.` })
          return resolve({ ok: false, permanent: true, reason: `The site refused the download (HTTP ${status}).` })
        }
        const declared = Number(res.headers["content-length"] ?? 0)
        if (declared > maxBytes) {
          res.destroy()
          return resolve({ ok: false, permanent: true, reason: `The file is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit.` })
        }
        const chunks: Buffer[] = []
        let size = 0
        res.on("data", (c: Buffer) => {
          size += c.length
          if (size > maxBytes) {
            res.destroy()
            resolve({ ok: false, permanent: true, reason: `The file is larger than the ${Math.round(maxBytes / 1024 / 1024)} MB limit.` })
          } else chunks.push(c)
        })
        res.on("end", () => resolve({ ok: true, buf: Buffer.concat(chunks), fileName: fileNameFrom(res.headers["content-disposition"], url), finalUrl: url.toString() }))
        res.on("error", (e) => resolve({ ok: false, permanent: false, reason: `The download broke off (${e.message}). Trying again later.` }))
      },
    )
    req.on("timeout", () => req.destroy(new Error("timed out")))
    req.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EPRIVATE") return resolve({ ok: false, permanent: true, reason: e.message })
      if (e.code === "ENOTFOUND") return resolve({ ok: false, permanent: true, reason: `The site ${url.hostname} doesn't exist.` })
      resolve({ ok: false, permanent: false, reason: `Couldn't reach ${url.hostname} (${e.code ?? e.message}). Trying again later.` })
    })
    req.end()
  })
}

/** Downloads a link (following up to 5 redirects) within the size limit. */
export async function fetchLink(raw: string, maxBytes: number): Promise<FetchResult> {
  const checked = checkLink(raw)
  if ("error" in checked) return { ok: false, permanent: true, reason: checked.error }
  const deadline = Date.now() + TIMEOUT_MS
  let current = directLink(checked.url)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (Date.now() > deadline) return { ok: false, permanent: false, reason: "The site took too long to answer. Trying again later." }
    const next = checkLink(current)
    if ("error" in next) return { ok: false, permanent: true, reason: `The link redirects somewhere that can't be fetched: ${next.error}` }
    const r = await once(new URL(next.url), deadline, maxBytes)
    if (!("redirect" in r)) return r
    current = r.redirect
  }
  return { ok: false, permanent: true, reason: "The link redirects too many times." }
}
