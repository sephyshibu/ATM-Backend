import { Injectable, UnauthorizedException } from "@nestjs/common"
import { CodeChallengeMethod, OAuth2Client } from "google-auth-library"

import { appConfig } from "../config"

export type GoogleIdentity = { sub: string; email: string; name: string; hostedDomain?: string }

/**
 * Google sign-in, the standard way: the browser goes to Google's sign-in page, Google sends it back to our
 * callback with a one-time code, and the server swaps the code for the person's verified identity.
 * PKCE and a random state guard the round trip. Google Workspace handles the password and two-step sign-in.
 */
@Injectable()
export class GoogleService {
  private client?: OAuth2Client

  configured() {
    const g = appConfig().google
    return !!(g.clientId && g.clientSecret)
  }

  private oauth() {
    const g = appConfig().google
    if (!this.configured()) throw new UnauthorizedException("Google sign-in isn't set up on this server yet (GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET).")
    return (this.client ??= new OAuth2Client({ clientId: g.clientId, clientSecret: g.clientSecret, redirectUri: g.callbackUrl }))
  }

  /** Where to send the browser, and the PKCE verifier to keep until Google sends it back. */
  async start(state: string, loginHint?: string) {
    const client = this.oauth()
    const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync()
    const domains = appConfig().google.allowedDomains
    const url = client.generateAuthUrl({
      access_type: "online",
      scope: ["openid", "email", "profile"],
      state,
      code_challenge: codeChallenge,
      code_challenge_method: CodeChallengeMethod.S256,
      prompt: "select_account",
      ...(loginHint ? { login_hint: loginHint } : {}),
      ...(domains.length === 1 ? { hd: domains[0] } : {}),
    })
    return { url, codeVerifier }
  }

  /** Swaps Google's one-time code for the person's identity, checked against our client id. */
  async finish(code: string, codeVerifier: string): Promise<GoogleIdentity> {
    const client = this.oauth()
    let payload
    try {
      const { tokens } = await client.getToken({ code, codeVerifier })
      if (!tokens.id_token) throw new Error("no id token")
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: appConfig().google.clientId })
      payload = ticket.getPayload()
    } catch {
      throw new UnauthorizedException("Google couldn't confirm that sign-in. Please try again.")
    }
    if (!payload?.sub || !payload.email) throw new UnauthorizedException("Google didn't share an email for this account.")
    if (!payload.email_verified) throw new UnauthorizedException("This Google account's email isn't verified.")
    const email = payload.email.toLowerCase()
    const allowed = appConfig().google.allowedDomains
    const domain = (payload.hd ?? email.split("@")[1] ?? "").toLowerCase()
    if (allowed.length && !allowed.includes(domain)) throw new UnauthorizedException(`Sign in with your company Google account (${allowed.join(" or ")}).`)
    return { sub: payload.sub, email, name: payload.name ?? email, hostedDomain: payload.hd }
  }
}
