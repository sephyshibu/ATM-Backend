import { Injectable, Logger } from "@nestjs/common"
import nodemailer, { type Transporter } from "nodemailer"

import { appConfig } from "../config"
import { PrismaService } from "../prisma/prisma.service"

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)

/**
 * Sends the system's own emails (invites). Every email is kept in email_outbox. With MAIL_TRANSPORT=log the
 * email is printed in the server console instead of sent, which is enough to test the invite flow.
 */
@Injectable()
export class MailService {
  private readonly log = new Logger("Mail")
  private transporter?: Transporter

  constructor(private readonly prisma: PrismaService) {}

  private smtp() {
    const m = appConfig().mail
    return (this.transporter ??= nodemailer.createTransport({
      host: m.smtpHost,
      port: m.smtpPort,
      secure: m.smtpPort === 465,
      auth: m.smtpUser ? { user: m.smtpUser, pass: m.smtpPass } : undefined,
    }))
  }

  async send(to: string, subject: string, text: string, html: string) {
    const row = await this.prisma.emailOutbox.create({ data: { to, subject, bodyText: text, bodyHtml: html } })
    const cfg = appConfig().mail
    if (cfg.transport === "log") {
      this.log.log(`\n--- Email (not sent: MAIL_TRANSPORT=log) ---\nTo: ${to}\nSubject: ${subject}\n\n${text}\n---`)
      await this.prisma.emailOutbox.update({ where: { id: row.id }, data: { status: "logged", sentAt: new Date() } })
      return { delivered: false as const }
    }
    try {
      await this.smtp().sendMail({ from: cfg.from, to, subject, text, html })
      await this.prisma.emailOutbox.update({ where: { id: row.id }, data: { status: "sent", sentAt: new Date() } })
      return { delivered: true as const }
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      this.log.error(`Couldn't send to ${to}: ${error}`)
      await this.prisma.emailOutbox.update({ where: { id: row.id }, data: { status: "failed", error } })
      return { delivered: false as const, error }
    }
  }

  inviteEmail(p: { name: string; invitedBy: string; roles: string[]; link: string; expires: Date }) {
    const first = p.name.split(/\s+/)[0] || p.name
    const roles = p.roles.length ? p.roles.join(", ") : "no role yet"
    const date = p.expires.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    const subject = `${p.invitedBy} invited you to the ATM CRM`
    const text = [
      `Hi ${first},`,
      ``,
      `${p.invitedBy} invited you to the ATM CRM as ${roles}.`,
      ``,
      `Open this link and sign in with your Google account for this email address:`,
      p.link,
      ``,
      `The invite works until ${date}.`,
    ].join("\n")
    const html = `<div style="font-family:Inter,Arial,sans-serif;font-size:14px;line-height:1.5;color:#101828">
<p>Hi ${escape(first)},</p>
<p>${escape(p.invitedBy)} invited you to the ATM CRM as <strong>${escape(roles)}</strong>.</p>
<p><a href="${escape(p.link)}" style="display:inline-block;background:#2e5bff;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:600">Accept the invite</a></p>
<p style="color:#475467">Sign in with your Google account for this email address. The invite works until ${escape(date)}.</p>
</div>`
    return { subject, text, html }
  }
}
