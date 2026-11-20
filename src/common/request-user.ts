import type { Request } from "express"

/** The signed-in person, as the guards put them on the request. */
export type RequestUser = {
  id: string
  email: string
  name: string
  title: string
  sessionId: string
  roles: { id: string; name: string; testOnly: boolean }[]
  permissions: Set<string>
}

export type AppRequest = Request & { user?: RequestUser }

/** How a person reads in the change log: "Name <email>". */
export const actorLabel = (u: { name: string; email: string }) => `${u.name} <${u.email}>`

export const requestIp = (req: Request) => (req.ip ?? req.socket?.remoteAddress ?? "").slice(0, 64) || null
