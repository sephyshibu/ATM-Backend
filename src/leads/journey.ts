// The lead journey as data: the stages, the side lanes, every move a person may make and every buyer event that
// moves a lead by itself (design: "Lead state transitions"). The journey engine refuses anything not listed here,
// unless someone with "Override a recommendation" forces it with a reason.

export const STAGES = ["register", "target", "contacted", "warm", "hot", "sql"] as const
export type Stage = (typeof STAGES)[number]

export const LANES = ["nurture", "watch", "verification_pending", "parked", "on_hold", "rested", "not_pursued", "disqualified", "suppressed", "closed_enquiry"] as const
export type Lane = (typeof LANES)[number]

export const STAGE_LABELS: Record<Stage, string> = { register: "Register", target: "Target", contacted: "Contacted", warm: "Warm", hot: "Hot", sql: "SQL" }
export const LANE_LABELS: Record<Lane, string> = {
  nurture: "Nurture",
  watch: "Watch",
  verification_pending: "Verification pending",
  parked: "Parked",
  on_hold: "On hold",
  rested: "Rested",
  not_pursued: "Not pursued",
  disqualified: "Disqualified",
  suppressed: "Suppressed",
  closed_enquiry: "Closed enquiry",
}

/** Lanes a lead never comes back from by itself: the journey is over. */
export const CLOSED_LANES: Lane[] = ["not_pursued", "disqualified", "suppressed", "closed_enquiry"]

export const FLAG_LABELS: Record<string, string> = {
  reply_received: "Reply received: mark its outcome",
  no_signer: "No signer named: check before the call",
  override: "Moved by override",
  eligible_again: "Rest is over: it can start again",
}

export type Pos = { stage: Stage; lane: Lane | null }
export const posLabel = (p: { stage: string; lane: string | null }) => (p.lane ? `${LANE_LABELS[p.lane as Lane] ?? p.lane} (from ${STAGE_LABELS[p.stage as Stage] ?? p.stage})` : (STAGE_LABELS[p.stage as Stage] ?? p.stage))
export const isClosed = (p: { stage: string; lane: string | null }) => p.stage === "sql" || (!!p.lane && (CLOSED_LANES as string[]).includes(p.lane))

const at = (stage: Stage, lane: Lane | null = null) => (p: Pos) => p.stage === stage && p.lane === lane
const inLane = (lane: Lane) => (p: Pos) => p.lane === lane
const live = (p: Pos) => !p.lane && p.stage !== "sql"

export type MoveDef = {
  key: string
  /** Button text. */
  label: string
  /** One line under the button: what happens. */
  help: string
  permission: string
  from: (p: Pos) => boolean
  to: (p: Pos) => Pos
  /** A reason picked from this list is required. */
  reasonList?: string
  /** A written reason is required (otherwise optional). */
  reasonRequired?: boolean
  /** A return or recheck date is required. */
  untilRequired?: boolean
  /** Flags this move clears or sets. */
  clear?: string[]
  set?: string[]
  /** Checked before moving; refused with the reasons if not met. */
  check?: "target_ready"
  /** Shown in red: it ends the journey. */
  ends?: boolean
}

/** Moves a person makes. Grouped on screen by where the lead is. */
export const MOVES: MoveDef[] = [
  // Register: the Target checkpoint
  { key: "to_target", label: "Move to Target", help: "Ready for the next weekly batch.", permission: "leads.move_target", from: at("register"), to: () => ({ stage: "target", lane: null }), check: "target_ready" },
  { key: "park", label: "Park", help: "Not now; look again on the recheck date.", permission: "leads.move_target", from: at("register"), to: (p) => ({ ...p, lane: "parked" }), untilRequired: true },
  { key: "not_pursued", label: "Not pursued", help: "Ends this journey, with a reason.", permission: "leads.move_target", from: at("register"), to: (p) => ({ ...p, lane: "not_pursued" }), reasonList: "disqualify_reason", ends: true },
  { key: "unpark", label: "Back to Register", help: "Look at it again now.", permission: "leads.move_target", from: inLane("parked"), to: (p) => ({ ...p, lane: null }) },
  { key: "back_to_register", label: "Back to Register", help: "Take it out of Target before it is sent.", permission: "leads.move_target", from: at("target"), to: () => ({ stage: "register", lane: null }) },

  // Contacted: one click for each reply's outcome (the reply itself only sets "Reply received")
  { key: "reply_interested", label: "Reply: Interested", help: "Moves to Warm; the booking email goes out (once outreach is connected).", permission: "outreach.handle_replies", from: at("contacted"), to: () => ({ stage: "warm", lane: null }), clear: ["reply_received"] },
  { key: "reply_not_now", label: "Reply: Not now", help: "To Nurture until the date they gave.", permission: "outreach.handle_replies", from: at("contacted"), to: (p) => ({ ...p, lane: "nurture" }), untilRequired: true, clear: ["reply_received"] },
  { key: "reply_not_interested", label: "Reply: Not interested", help: "Disqualified, with a reason.", permission: "outreach.handle_replies", from: at("contacted"), to: (p) => ({ ...p, lane: "disqualified" }), reasonList: "disqualify_reason", clear: ["reply_received"], ends: true },
  { key: "reply_wrong_person", label: "Reply: Wrong person", help: "Stays Contacted; add the right contact.", permission: "outreach.handle_replies", from: (p) => at("contacted")(p), to: (p) => p, clear: ["reply_received"] },
  { key: "reply_out_of_office", label: "Reply: Out of office", help: "Stays Contacted; the sequence resumes later.", permission: "outreach.handle_replies", from: (p) => at("contacted")(p), to: (p) => p, clear: ["reply_received"] },

  // Warm
  { key: "warm_nurture", label: "Nurture", help: "Interested, but later: to Nurture until the date.", permission: "outreach.handle_replies", from: at("warm"), to: (p) => ({ ...p, lane: "nurture" }), untilRequired: true },
  { key: "warm_disqualify", label: "Disqualify", help: "Ends this journey, with a reason.", permission: "outreach.handle_replies", from: at("warm"), to: (p) => ({ ...p, lane: "disqualified" }), reasonList: "disqualify_reason", ends: true },

  // Hot: the call
  { key: "mark_sql", label: "Mark SQL", help: "Qualified on the call: hands over to Sales.", permission: "calls.do", from: at("hot"), to: () => ({ stage: "sql", lane: null }), clear: ["no_signer"] },
  { key: "verification_pending", label: "Verification pending", help: "A gate still needs evidence after the call.", permission: "calls.do", from: at("hot"), to: (p) => ({ ...p, lane: "verification_pending" }) },
  { key: "hot_nurture", label: "Not now", help: "To Nurture until the date.", permission: "calls.do", from: at("hot"), to: (p) => ({ ...p, lane: "nurture" }), untilRequired: true },
  { key: "hot_disqualify", label: "Disqualify", help: "Ends this journey, with a reason.", permission: "calls.do", from: at("hot"), to: (p) => ({ ...p, lane: "disqualified" }), reasonList: "disqualify_reason", ends: true },
  { key: "vp_sql", label: "Mark SQL", help: "The evidence came in.", permission: "calls.do", from: inLane("verification_pending"), to: () => ({ stage: "sql", lane: null }), clear: ["no_signer"] },
  { key: "vp_nurture", label: "Nurture", help: "To Nurture until the date.", permission: "calls.do", from: inLane("verification_pending"), to: (p) => ({ ...p, lane: "nurture" }), untilRequired: true },
  { key: "vp_disqualify", label: "Disqualify", help: "Ends this journey, with a reason.", permission: "calls.do", from: inLane("verification_pending"), to: (p) => ({ ...p, lane: "disqualified" }), reasonList: "disqualify_reason", ends: true },

  // Coming back from a lane
  { key: "nurture_return", label: "Return from Nurture", help: "Back to the stage it left.", permission: "outreach.handle_replies", from: inLane("nurture"), to: (p) => ({ ...p, lane: null }) },
  { key: "watch_to_nurture", label: "Move to Nurture", help: "Somebody is named now, or ten days passed.", permission: "outreach.handle_replies", from: inLane("watch"), to: (p) => ({ ...p, lane: "nurture" }), untilRequired: true },
  { key: "rested_restart", label: "Start again at Register", help: "The six months' rest is over.", permission: "leads.move_target", from: inLane("rested"), to: () => ({ stage: "register", lane: null }) },

  // Any live stage
  { key: "hold", label: "Put on hold", help: "Pause until the date; it comes back to the same stage.", permission: "records.edit", from: live, to: (p) => ({ ...p, lane: "on_hold" }), untilRequired: true, reasonRequired: true },
  { key: "resume", label: "Resume", help: "Back to the stage it was paused at.", permission: "records.edit", from: inLane("on_hold"), to: (p) => ({ ...p, lane: null }) },
]

export type EventDef = {
  type: string
  label: string
  /** Where the lead must be; elsewhere the event is recorded but nothing moves. */
  from: (p: Pos) => boolean
  to: (p: Pos) => Pos
  set?: string[]
  clear?: string[]
  /** Set no_signer when the brand has no signer. */
  signerCheck?: boolean
}

/** Buyer events: they move a lead by themselves (rules 3, 4, 7, 9, 10). Outreach and bookings send them later. */
export const EVENTS: EventDef[] = [
  { type: "email_sent", label: "First email delivered", from: at("target"), to: () => ({ stage: "contacted", lane: null }) },
  { type: "reply_received", label: "Reply received", from: at("contacted"), to: (p) => p, set: ["reply_received"] },
  { type: "unsubscribed", label: "Unsubscribed", from: (p) => !isClosed(p), to: (p) => ({ ...p, lane: "suppressed" }) },
  { type: "bounced", label: "Email bounced", from: (p) => !isClosed(p), to: (p) => ({ ...p, lane: "suppressed" }) },
  { type: "sequence_finished", label: "Sequence finished, no reply", from: at("contacted"), to: (p) => ({ ...p, lane: "rested" }) },
  { type: "booking_created", label: "Call booked", from: at("warm"), to: () => ({ stage: "hot", lane: null }), signerCheck: true },
  { type: "booking_cancelled", label: "Booking cancelled", from: at("hot"), to: () => ({ stage: "warm", lane: null }), clear: ["no_signer"] },
  { type: "no_show", label: "No-show", from: at("hot"), to: () => ({ stage: "warm", lane: null }), clear: ["no_signer"] },
]

/** Date rules the daily lane check applies (job lanes.tick). */
export const TIMERS: Record<string, string> = {
  nurture_due: "Nurture date reached: back to its stage",
  parked_due: "Recheck date reached: back to Register",
  hold_due: "Hold date reached: resumed",
  watch_due: "Days in Watch reached: moved to Nurture",
  rest_over: "Rest is over: flagged to start again",
}

/** The name of a move, an event or a timer, as the history shows it. */
export function moveLabel(key: string) {
  if (key === "open") return "Lead opened"
  if (key === "undo") return "Undo"
  if (key === "override") return "Override"
  if (key.startsWith("timer.")) return TIMERS[key.slice(6)] ?? key
  if (key.startsWith("event.")) return EVENTS.find((e) => e.type === key.slice(6))?.label ?? key
  return MOVES.find((m) => m.key === key)?.label ?? key
}
