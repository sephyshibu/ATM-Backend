import { randomUUID } from "node:crypto"

import { appConfig } from "../config"

// Google Calendar over its REST API (fetch, no SDK). Connecting asks for OFFLINE access to Calendar so the server
// gets a refresh token: it reads the host's busy times (free/busy) and creates the meeting with a Google Meet link,
// letting Google send the invite. Every call is best-effort: a failure never breaks a booking.

const SCOPES = ["openid", "email", "https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.freebusy"].join(" ")

export function calendarOAuth() {
  const c = appConfig()
  if (!c.google.clientId || !c.google.clientSecret || !c.calendar.callbackUrl) return null
  return { clientId: c.google.clientId, clientSecret: c.google.clientSecret, callbackUrl: c.calendar.callbackUrl }
}

export function authorizeUrl(state: string, loginHint?: string) {
  const o = calendarOAuth()!
  const params = new URLSearchParams({
    client_id: o.clientId,
    redirect_uri: o.callbackUrl,
    response_type: "code",
    scope: SCOPES,
    state,
    access_type: "offline",
    // Always show consent, so Google returns a refresh token every time.
    prompt: "consent",
    include_granted_scopes: "true",
  })
  if (loginHint) params.set("login_hint", loginHint)
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}

/** Swaps the one-time code for tokens, server-side. The email is read from the id_token Google just returned. */
export async function exchangeCode(code: string): Promise<{ refreshToken?: string; scope?: string; email?: string }> {
  const o = calendarOAuth()!
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: o.clientId, client_secret: o.clientSecret, redirect_uri: o.callbackUrl, grant_type: "authorization_code" }).toString(),
  })
  const body = (await res.json().catch(() => null)) as { refresh_token?: string; id_token?: string; scope?: string; error?: string; error_description?: string } | null
  if (!res.ok) throw new Error(body?.error_description || body?.error || `Google refused the calendar connection (${res.status}).`)
  let email: string | undefined
  try {
    const payload = JSON.parse(Buffer.from((body?.id_token ?? "").split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: string }
    email = typeof payload.email === "string" ? payload.email : undefined
  } catch {
    email = undefined
  }
  return { refreshToken: body?.refresh_token, scope: body?.scope, email }
}

/** A short-lived access token from the refresh token, or null. */
export async function accessToken(refreshToken: string): Promise<string | null> {
  const o = calendarOAuth()
  if (!o) return null
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: o.clientId, client_secret: o.clientSecret, refresh_token: refreshToken, grant_type: "refresh_token" }).toString(),
    })
    const body = (await res.json().catch(() => null)) as { access_token?: string } | null
    return res.ok && body?.access_token ? body.access_token : null
  } catch {
    return null
  }
}

/** Revokes a refresh token at Google (on disconnect). Best-effort. */
export async function revoke(refreshToken: string) {
  try {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refreshToken)}`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" } })
  } catch {
    /* best-effort */
  }
}

export type Busy = { start: string; end: string }

/** The host's busy times on their primary calendar. */
export async function freeBusy(token: string, fromIso: string, toIso: string): Promise<Busy[]> {
  try {
    const res = await fetch("https://www.googleapis.com/calendar/v3/freeBusy", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ timeMin: fromIso, timeMax: toIso, items: [{ id: "primary" }] }),
    })
    if (!res.ok) return []
    const body = (await res.json().catch(() => null)) as { calendars?: { primary?: { busy?: Busy[] } } } | null
    return body?.calendars?.primary?.busy ?? []
  } catch {
    return []
  }
}

/** Creates the meeting on the host's calendar (with a Meet link when asked); Google emails the invite. */
export async function createEvent(
  token: string,
  p: { summary: string; description?: string; startIso: string; endIso: string; timeZone: string; attendees: string[]; addMeet: boolean; location?: string },
): Promise<{ eventId?: string; meetLink?: string }> {
  try {
    const body: Record<string, unknown> = {
      summary: p.summary,
      description: p.description || undefined,
      location: p.location || undefined,
      start: { dateTime: p.startIso, timeZone: p.timeZone },
      end: { dateTime: p.endIso, timeZone: p.timeZone },
      attendees: p.attendees.filter(Boolean).map((email) => ({ email })),
    }
    if (p.addMeet) body.conferenceData = { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } }
    const res = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
    if (!res.ok) return {}
    const data = (await res.json().catch(() => null)) as { id?: string; hangoutLink?: string; conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] } } | null
    return { eventId: data?.id, meetLink: data?.hangoutLink || data?.conferenceData?.entryPoints?.find((e) => e.entryPointType === "video")?.uri || undefined }
  } catch {
    return {}
  }
}

/** Moves an event (reschedule), keeping its Meet link and guests. */
export async function moveEvent(token: string, eventId: string, startIso: string, endIso: string, timeZone: string) {
  try {
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=all`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ start: { dateTime: startIso, timeZone }, end: { dateTime: endIso, timeZone } }),
    })
    return res.ok
  } catch {
    return false
  }
}

/** Cancels an event; Google tells the guests. */
export async function deleteEvent(token: string, eventId: string) {
  try {
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=all`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } })
    return res.ok || res.status === 410
  } catch {
    return false
  }
}
