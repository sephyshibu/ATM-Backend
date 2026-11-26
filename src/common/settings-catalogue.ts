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

  // Working time (clocks count only working hours and days)
  { key: "company.work_days", group: "Working time", label: "Working days", description: "1 = Monday … 7 = Sunday, separated by commas. Holidays are in Lists → Holidays.", type: "text", default: "1,2,3,4,5" },
  { key: "company.work_start", group: "Working time", label: "Working day starts at", description: "In the company time zone.", type: "time", default: "09:00" },
  { key: "company.work_end", group: "Working time", label: "Working day ends at", description: "In the company time zone.", type: "time", default: "18:00" },

  // Knowledge base
  { key: "kb.require_verified_for_target", group: "Knowledge base", label: "Target needs a verified knowledge base", description: "On: a brand moves to Target only when every required fact is verified. Off: it's a warning only.", type: "boolean", default: true },
  { key: "kb.max_file_mb", group: "Knowledge base", label: "Largest dossier file", description: "PDF and Word files bigger than this are refused, uploaded or fetched from a link (50 MB at most).", type: "integer", unit: "MB", min: 1, max: 50, default: 25 },

  // Background jobs
  { key: "jobs.facts_stale_time", group: "Background jobs", label: "Check knowledge bases for stale facts daily at", description: "Facts past their refresh date flag the brand's knowledge base. In the company time zone.", type: "time", default: "06:10" },
  { key: "jobs.lanes_tick_time", group: "Background jobs", label: "Check side-lane dates daily at", description: "Leads come back from Nurture, Parked and On hold on their date; Watch moves to Nurture; Rested brands are flagged when their rest is over. In the company time zone.", type: "time", default: "06:00" },

  // Company
  { key: "company.timezone", group: "Company", label: "Company time zone", description: "For the weekly batch and company-wide dates. Each person's clocks follow their own time zone.", type: "text", default: "Asia/Kolkata" },
]

/** The six gates (design: "Gates and recommendations"). The seed creates them once; names, descriptions and
 *  on/off are then edited in Settings → Gates. Desk gates decide Target; call gates are confirmed after the call. */
export type GateDef = { code: string; name: string; checks: string; stage: "desk" | "call"; rule: "category" | "revenue_band" | "lane" | null }

export const GATES: GateDef[] = [
  { code: "01", name: "Category", checks: "The brand is in a category ATM works in (health supplements, functional food, beauty, pet nutrition).", stage: "desk", rule: "category" },
  { code: "02", name: "Home revenue", checks: "Home-market revenue is inside the target band (Configuration → Gates).", stage: "desk", rule: "revenue_band" },
  { code: "03", name: "Asia position", checks: "Asia is a live plan; it sets the lane (Entry, Expansion or Re-entry).", stage: "desk", rule: "lane" },
  { code: "04", name: "Funded and dated", checks: "A budget exists and there is a date.", stage: "call", rule: null },
  { code: "05", name: "Named owner", checks: "A named person owns the Asia plan.", stage: "call", rule: null },
  { code: "06", name: "Signer reachable", checks: "The person who signs was on the call or is named.", stage: "call", rule: null },
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
      { code: "IMPORT", label: "Brand Register import" },
      { code: "NOT_NEEDED", label: "Not needed for this brand" },
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
    description: "Picked when a lead is disqualified, or not pursued at Register.",
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
    key: "fact_source_tier",
    label: "Fact source tiers",
    description: "How strong a fact's source is. Picked when a fact is entered.",
    values: [
      { code: "COMPANY", label: "Company's own (report, website, filing)" },
      { code: "THIRD_PARTY", label: "Trusted third party (database, press)" },
      { code: "CALL", label: "Said on a call" },
      { code: "ESTIMATE", label: "Estimate or inference" },
    ],
  },
  {
    key: "fact_reject_reason",
    label: "Fact reject reasons",
    description: "Picked when a checker rejects a fact.",
    values: [
      { code: "WRONG_VALUE", label: "Value doesn't match the source" },
      { code: "WEAK_SOURCE", label: "Source isn't good enough" },
      { code: "OUT_OF_DATE", label: "Evidence is too old" },
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
    key: "holidays",
    label: "Holidays",
    description: "Days off: clocks and working-day counts skip them. Start each name with the date, e.g. 2026-12-25 Christmas.",
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

export type FactDef = { key: string; label: string; group: "company" | "asia" | "regulatory" | "outreach"; type: string; options?: string[]; required: boolean; refreshDays: number; help: string; brandField?: string }

/**
 * The knowledge-base form (design: "Upload 2: dossier and knowledge base"). The seed creates these once; labels,
 * help, choices, required and refresh days are then edited in Settings → Facts.
 */
export const FACTS: FactDef[] = [
  { key: "home_revenue", label: "Home revenue (USD)", group: "company", type: "usd", required: false, refreshDays: 365, help: "Latest full-year revenue in the home market. 12.5M or 12,500,000.", brandField: "homeRevenueUsd" },
  { key: "revenue_year", label: "Revenue year", group: "company", type: "number", required: false, refreshDays: 365, help: "The year the revenue figure is for.", brandField: "revenueYear" },
  { key: "headcount", label: "Headcount", group: "company", type: "number", required: false, refreshDays: 365, help: "" },
  { key: "owner_parent", label: "Owner or parent company", group: "company", type: "text", required: false, refreshDays: 365, help: "Who owns the brand: founder-owned, a group, private equity…" },
  { key: "markets_live", label: "Asian markets live", group: "asia", type: "long_text", required: false, refreshDays: 180, help: "Where the brand sells in Asia today, and how.", brandField: "asianMarketsLive" },
  { key: "appointed_vs_grey", label: "Appointed vs grey market", group: "asia", type: "choice", options: ["Appointed partners", "Grey market only", "Both", "Neither"], required: false, refreshDays: 180, help: "" },
  { key: "named_distributors", label: "Named distributors", group: "asia", type: "long_text", required: false, refreshDays: 180, help: "Distributors by market." },
  { key: "registration_holder", label: "Registration holder", group: "asia", type: "text", required: false, refreshDays: 180, help: "Who holds the product registrations in Asia." },
  { key: "halal_exposure", label: "Halal exposure", group: "regulatory", type: "choice", options: ["Certified", "In progress", "Not certified", "Not relevant"], required: false, refreshDays: 365, help: "" },
  { key: "hsa_claim_flag", label: "HSA claim or dosage flag", group: "regulatory", type: "yes_no", required: false, refreshDays: 365, help: "Claims or doses that would need attention in Singapore." },
  { key: "classification_risk", label: "Classification risk", group: "regulatory", type: "choice", options: ["Low", "Medium", "High"], required: false, refreshDays: 365, help: "Risk the products are classed as medicines rather than supplements." },
  { key: "touch_one", label: "Touch-one observation", group: "outreach", type: "long_text", required: false, refreshDays: 90, help: "The specific, recent observation the first email opens with." },
]
