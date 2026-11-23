// The configuration values and pick-lists the seed creates (design v1.1). Values are edited in Settings;
// every edit is a new version, so the history of each value stays readable.

export type SettingDef = {
  key: string
  group: string
  label: string
  description: string
  type: "integer" | "text" | "month_day" | "time" | "boolean"
  unit?: string
  min?: number
  max?: number
  default: number | string | boolean
}

export const SETTINGS: SettingDef[] = [
  // Clocks
  { key: "clock.reply_answer_hours", group: "Clocks", label: "Answer a reply within", description: "Working hours from a reply arriving to Mark answered.", type: "integer", unit: "working hours", min: 1, max: 48, default: 4 },
  { key: "clock.call_card_hours", group: "Clocks", label: "Fill the call card within", description: "Hours after the qualifying call.", type: "integer", unit: "hours", min: 1, max: 48, default: 2 },
  { key: "clock.handover_working_days", group: "Clocks", label: "Hand over an SQL within", description: "Working days to book Sam's discovery call after SQL.", type: "integer", unit: "working days", min: 1, max: 10, default: 1 },
  { key: "clock.enquiry_escalate_hours", group: "Clocks", label: "Alert the founders about an untriaged enquiry after", description: "Working hours with no triage.", type: "integer", unit: "working hours", min: 1, max: 48, default: 2 },

  // Booking emails
  { key: "booking.reminder_working_days", group: "Booking emails", label: "Send the booking reminder after", description: "Working days after booking email 1 with no booking.", type: "integer", unit: "working days", min: 1, max: 20, default: 3 },
  { key: "booking.followup_working_days", group: "Booking emails", label: "Create a follow-up task after", description: "Working days after the reminder with no booking.", type: "integer", unit: "working days", min: 1, max: 20, default: 3 },
  { key: "booking.prework_first_hours", group: "Booking emails", label: "First pre-work reminder", description: "Hours before the call.", type: "integer", unit: "hours before", min: 1, max: 168, default: 48 },
  { key: "booking.prework_second_hours", group: "Booking emails", label: "Second pre-work reminder", description: "Hours before the call.", type: "integer", unit: "hours before", min: 1, max: 168, default: 24 },

  // Side lanes
  { key: "lane.verification_reminder_day", group: "Side lanes", label: "Verification Pending: remind on day", description: "Day after the call when the caller is reminded.", type: "integer", unit: "days", min: 1, max: 60, default: 10 },
  { key: "lane.verification_unknown_day", group: "Side lanes", label: "Verification Pending: set gates to Unknown on day", description: "Day after the call when open gates become Unknown.", type: "integer", unit: "days", min: 1, max: 90, default: 15 },
  { key: "lane.watch_to_nurture_days", group: "Side lanes", label: "Watch moves to Nurture after", description: "Days in Watch with nobody named.", type: "integer", unit: "days", min: 1, max: 90, default: 10 },
  { key: "lane.rested_eligible_months", group: "Side lanes", label: "Rested brands are eligible again after", description: "Months after a sequence ends with no reply.", type: "integer", unit: "months", min: 1, max: 36, default: 6 },

  // Quiet period
  { key: "quiet.start", group: "Quiet period", label: "No emails from", description: "Nothing is pushed or sent from this day.", type: "month_day", default: "12-22" },
  { key: "quiet.end", group: "Quiet period", label: "Until", description: "The last quiet day.", type: "month_day", default: "01-01" },
  { key: "quiet.resume", group: "Quiet period", label: "Resume on", description: "Paused campaigns resume, and held touches move to this day.", type: "month_day", default: "01-05" },

  // Weekly batch
  { key: "batch.build_weekday", group: "Weekly batch", label: "Build the batch on", description: "1 = Monday … 7 = Sunday.", type: "integer", unit: "weekday", min: 1, max: 7, default: 1 },
  { key: "batch.build_time", group: "Weekly batch", label: "At", description: "In the company time zone.", type: "time", default: "07:00" },

  // Gates
  { key: "gates.revenue_min_usd", group: "Gates", label: "Gate 02: home revenue from", description: "Lower end of the target band.", type: "integer", unit: "USD", min: 0, max: 1_000_000_000, default: 5_000_000 },
  { key: "gates.revenue_max_usd", group: "Gates", label: "Gate 02: home revenue up to", description: "Upper end of the target band.", type: "integer", unit: "USD", min: 0, max: 1_000_000_000, default: 50_000_000 },

  // Company
  { key: "company.timezone", group: "Company", label: "Company time zone", description: "For the weekly batch and company-wide dates. Each person's clocks follow their own time zone.", type: "text", default: "Asia/Kolkata" },
]

export type ListDef = { key: string; label: string; description: string; parent?: string; values: { code: string; label: string; parent?: string }[] }

export const LISTS: ListDef[] = [
  {
    key: "category",
    label: "Categories",
    description: "Every brand has one category and one sub-category. Add more categories here any time.",
    values: [
      { code: "HW", label: "Health supplements" },
      { code: "FF", label: "Functional food & beverages" },
      { code: "BE", label: "Beauty & wellness" },
      { code: "PN", label: "Pet nutrition" },
    ],
  },
  {
    key: "sub_category",
    label: "Sub-categories",
    description: "Each sits under one category; a category can have any number. The template is picked by category + sub-category + lane, falling back to the category template.",
    parent: "category",
    values: [
      { code: "HW_VITAMINS", label: "Vitamins and minerals", parent: "HW" },
      { code: "HW_PROTEIN", label: "Protein powder", parent: "HW" },
      { code: "HW_SPORTS", label: "Sports nutrition", parent: "HW" },
      { code: "HW_HERBAL", label: "Herbal and traditional", parent: "HW" },
      { code: "HW_GUT", label: "Probiotics and gut health", parent: "HW" },
      { code: "FF_DRINKS", label: "Functional drinks", parent: "FF" },
      { code: "FF_PROTEIN", label: "Protein snacks", parent: "FF" },
      { code: "FF_PLANT", label: "Plant-based foods", parent: "FF" },
      { code: "FF_INFANT", label: "Baby and infant nutrition", parent: "FF" },
      { code: "BE_SKINCARE", label: "Skincare", parent: "BE" },
      { code: "BE_HAIRCARE", label: "Haircare", parent: "BE" },
      { code: "BE_MAKEUP", label: "Makeup", parent: "BE" },
      { code: "BE_FRAGRANCE", label: "Fragrance", parent: "BE" },
      { code: "BE_MENS", label: "Men's grooming", parent: "BE" },
      { code: "PN_FOOD", label: "Pet food", parent: "PN" },
      { code: "PN_SUPPLEMENTS", label: "Pet supplements", parent: "PN" },
      { code: "PN_TREATS", label: "Treats and chews", parent: "PN" },
    ],
  },
  {
    key: "routing",
    label: "Lanes",
    description: "The route a brand takes: Entry (new to Asia), Expansion (already in an Asian market), Re-entry (was in Asia and left). Each lane will get its own template of deliverables and plan at onboarding. Stored under the key \"routing\".",
    values: [
      { code: "ENTRY", label: "Entry" },
      { code: "EXPANSION", label: "Expansion" },
      { code: "REENTRY", label: "Re-entry" },
    ],
  },
  {
    key: "tier",
    label: "Brand tiers",
    description: "How much attention a brand gets. Needed before Target.",
    values: [
      { code: "T1", label: "Tier 1" },
      { code: "T2", label: "Tier 2" },
      { code: "T3", label: "Tier 3" },
    ],
  },
  {
    key: "buying_role",
    label: "Buying roles",
    description: "A person's part in the decision.",
    values: [
      { code: "SIGNER", label: "Signer" },
      { code: "OWNER", label: "Owner of the Asia plan" },
      { code: "CHAMPION", label: "Champion" },
      { code: "INFLUENCER", label: "Influencer" },
      { code: "OTHER", label: "Other" },
    ],
  },
  {
    key: "consent_basis",
    label: "Consent to contact",
    description: "Why ATM may email a person (PDPA and GDPR).",
    values: [
      { code: "LEGITIMATE_INTEREST", label: "Legitimate interest" },
      { code: "CONSENTED", label: "Gave consent" },
      { code: "UNKNOWN", label: "Not checked yet" },
    ],
  },
  {
    key: "gate_change_reason",
    label: "Gate change reasons",
    description: "Picked whenever someone changes a gate value.",
    values: [
      { code: "NEW_EVIDENCE", label: "New evidence found" },
      { code: "REGISTER_WRONG", label: "Register value was wrong" },
      { code: "CALL_CONFIRMED", label: "Confirmed on the call" },
      { code: "CALL_CONTRADICTED", label: "Contradicted on the call" },
      { code: "OTHER", label: "Other" },
    ],
  },
  {
    key: "override_reason",
    label: "Override reasons",
    description: "Picked when a decision differs from the recommendation.",
    values: [
      { code: "STRATEGIC", label: "Strategic account" },
      { code: "TIMING", label: "Timing is right despite the gates" },
      { code: "EVIDENCE_PENDING", label: "Evidence is on its way" },
      { code: "OTHER", label: "Other" },
    ],
  },
  {
    key: "disqualify_reason",
    label: "Disqualify reasons",
    description: "Picked when a lead is disqualified.",
    values: [
      { code: "NOT_INTERESTED", label: "Not interested" },
      { code: "NO_ASIA_PLAN", label: "No Asia plan" },
      { code: "TOO_SMALL", label: "Too small" },
      { code: "COMPETITOR", label: "Works with a competitor" },
      { code: "OTHER", label: "Other" },
    ],
  },
  {
    key: "batch_hold_reason",
    label: "Weekly batch hold reasons",
    description: "Picked when a brand is held from the weekly batch.",
    values: [
      { code: "MISSING_FIELD", label: "A merge field is empty" },
      { code: "STALE_FACTS", label: "Facts need checking again" },
      { code: "TIMING", label: "Not the right week" },
      { code: "OTHER", label: "Other" },
    ],
  },
  {
    key: "tag",
    label: "Tags",
    description: "Free labels for organisations, brands and products (e.g. Halal, Vegan, Trade show 2026). Anyone who can edit records can add a new tag while tagging; rename or retire them here.",
    values: [],
  },
  {
    key: "archive_reason",
    label: "Archive reasons",
    description: "Picked when a brand, company or person is archived.",
    values: [
      { code: "DUPLICATE", label: "Duplicate record" },
      { code: "CLOSED", label: "Company closed or merged" },
      { code: "LEFT", label: "Person left the company" },
      { code: "WRONG", label: "Added by mistake" },
      { code: "OTHER", label: "Other" },
    ],
  },
]

/**
 * Labels the first version of the catalogue used. The seed renames a value only while it still has its old label,
 * so a name someone changed in Settings is never overwritten.
 */
export const LIST_RELABELS: { listKey: string; code: string; from: string; to: string }[] = [
  { listKey: "category", code: "HW", from: "Health and wellness", to: "Health supplements" },
  { listKey: "category", code: "FF", from: "Functional food", to: "Functional food & beverages" },
  { listKey: "category", code: "BE", from: "Beauty", to: "Beauty & wellness" },
  { listKey: "sub_category", code: "HW_VITAMINS", from: "Vitamins and supplements", to: "Vitamins and minerals" },
]
