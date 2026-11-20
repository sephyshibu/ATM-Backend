import { Controller, Get, HttpCode, Param, Post, Query, Req, Res } from "@nestjs/common"
import { Throttle } from "@nestjs/throttler"
import type { Response } from "express"

import { CurrentUser, Public } from "../common/decorators"
import type { AppRequest, RequestUser } from "../common/request-user"
import { API_PREFIX, appConfig } from "../config"
import { AuthService } from "./auth.service"
import { GoogleService } from "./google.service"
import { newToken, SESSION_COOKIE } from "./tokens"

/** Holds the state, PKCE verifier and return path while the browser is at Google (10 minutes at most). */
const OAUTH_COOKIE = "atm_oauth"
const OAUTH_PATH = `/${API_PREFIX}/auth/google`

/** Only a path inside the app: never another site. */
const safeNext = (next?: string) => (next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next.slice(0, 300) : "/")

@Controller("auth")
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly google: GoogleService,
  ) {}

  /** What the sign-in page needs to draw itself. */
  @Public()
  @Get("config")
  config() {
    return { googleConfigured: this.google.configured(), allowedDomains: appConfig().google.allowedDomains }
  }

  /** Step 1: the "Sign in with Google" button lands here, and the browser goes on to Google. */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get("google")
  async googleStart(@Res() res: Response, @Query("next") next?: string, @Query("login_hint") loginHint?: string) {
    const front = appConfig().frontendUrl
    try {
      const state = newToken()
      const hint = loginHint && /^\S+@\S+\.\S+$/.test(loginHint) ? loginHint.slice(0, 200) : undefined
      const { url, codeVerifier } = await this.google.start(state, hint)
      res.cookie(OAUTH_COOKIE, JSON.stringify({ state, codeVerifier, next: safeNext(next) }), {
        httpOnly: true,
        sameSite: "lax",
        secure: appConfig().appEnv !== "development",
        path: OAUTH_PATH,
        maxAge: 10 * 60_000,
      })
      res.redirect(url)
    } catch (e) {
      res.redirect(`${front}/login?error=${encodeURIComponent(e instanceof Error ? e.message : "Couldn't start Google sign-in.")}`)
    }
  }

  /** Step 2: Google sends the browser back here. Sign in, then return to the app (or to sign-in with the reason). */
  @Public()
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get("google/callback")
  async googleCallback(@Req() req: AppRequest, @Res() res: Response, @Query("code") code?: string, @Query("state") state?: string, @Query("error") googleError?: string) {
    const front = appConfig().frontendUrl
    const fail = (message: string) => res.redirect(`${front}/login?error=${encodeURIComponent(message)}`)

    let saved: { state?: string; codeVerifier?: string; next?: string } = {}
    try {
      saved = JSON.parse(req.cookies?.[OAUTH_COOKIE] ?? "{}")
    } catch {
      saved = {}
    }
    res.clearCookie(OAUTH_COOKIE, { path: OAUTH_PATH })

    if (googleError) return fail(googleError === "access_denied" ? "Sign-in was cancelled." : "Google didn't complete the sign-in. Please try again.")
    if (!code || !state || !saved.state || state !== saved.state || !saved.codeVerifier) return fail("That sign-in link expired. Please try again.")

    try {
      const identity = await this.google.finish(code, saved.codeVerifier)
      await this.auth.signIn(identity, req, res)
      res.redirect(`${front}${safeNext(saved.next)}`)
    } catch (e) {
      fail(e instanceof Error ? e.message : "Sign-in failed. Please try again.")
    }
  }

  @Post("logout")
  @HttpCode(204)
  async signOut(@CurrentUser() user: RequestUser, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    await this.auth.signOut(user, req, res)
  }

  /** The signed-in person, their roles and permissions. Also renews the cookie's lifetime. */
  @Get("me")
  me(@CurrentUser() user: RequestUser, @Req() req: AppRequest, @Res({ passthrough: true }) res: Response) {
    const token = req.cookies?.[SESSION_COOKIE]
    if (token) res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: appConfig().appEnv !== "development", path: "/", maxAge: appConfig().sessionDays * 86_400_000 })
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      title: user.title,
      roles: user.roles,
      permissions: [...user.permissions].sort(),
    }
  }

  @Public()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get("invite/:token")
  invite(@Param("token") token: string) {
    return this.auth.inviteInfo(token)
  }
}
