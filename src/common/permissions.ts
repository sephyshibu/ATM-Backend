// The permission catalogue: every action the CRM checks. Roles are built from these keys in Settings.
// Keys are permanent: to drop one, mark it retired here (it then shows nowhere new), never rename or reuse it.
// Several keys belong to Marketing screens still to be built; they exist now so roles can be set up once.

export type PermissionDef = { key: string; group: string; label: string; description: string; retired?: boolean }

export const PERMISSIONS: PermissionDef[] = [
  // Records
  { key: "records.view", group: "Records", label: "View brands and people", description: "Open the Records area and read brands, organisations and people." },
  { key: "records.edit", group: "Records", label: "Edit brands and people", description: "Add and change records. Every change is kept in history." },
  { key: "records.archive", group: "Records", label: "Archive and restore records", description: "Hide a record from lists without erasing it, and bring it back." },
  { key: "records.room_only", group: "Records", label: "See room-only fields", description: "Client names and pricing history. Founders only, by default." },

  // Imports and knowledge base
  { key: "kb.import", group: "Imports and knowledge base", label: "Import brands and products", description: "Upload Excel or CSV files of brands (with their organisations) and products, map the columns and confirm the import." },
  { key: "kb.enter_facts", group: "Imports and knowledge base", label: "Enter facts", description: "Fill the knowledge base with a source and a date for each fact." },
  { key: "kb.verify_facts", group: "Imports and knowledge base", label: "Verify other people's facts", description: "Check facts entered by someone else against the dossier." },
  { key: "kb.verify_own_facts", group: "Imports and knowledge base", label: "Verify own facts", description: "Verify facts you entered yourself. They are marked self-verified." },

  // Gates and Target
  { key: "gates.edit_desk", group: "Gates and Target", label: "Change desk gates (01 to 03)", description: "Change a desk gate value, always with a reason." },
  { key: "gates.edit_call", group: "Gates and Target", label: "Change call gates (04 to 06)", description: "Change a call gate value, always with a reason." },
  { key: "leads.move_target", group: "Gates and Target", label: "Move brands to Target", description: "Tick brands into Target, or park them." },

  // Templates
  { key: "templates.write", group: "Email templates", label: "Write templates", description: "Create and edit email templates. Edits make a new draft version." },
  { key: "templates.approve", group: "Email templates", label: "Approve templates", description: "Approve a draft so it can be used. Nobody approves their own." },
  { key: "templates.matrix", group: "Email templates", label: "Edit the template matrix", description: "Choose which template each category, sub-category and lane gets." },

  // Outreach
  { key: "outreach.approve_batch", group: "Outreach", label: "Approve the weekly batch", description: "Approve or hold brands before they go to lemlist." },
  { key: "outreach.handle_replies", group: "Outreach", label: "Handle replies", description: "Mark each reply's outcome and mark it answered." },
  { key: "outreach.triage", group: "Outreach", label: "Triage enquiries", description: "Sort website enquiries: Fit, Prospective, Partner or Not relevant." },

  // Calls
  { key: "calls.do", group: "Calls", label: "Do qualifying calls", description: "Fill the call card, confirm gates 04 to 06 and mark SQL." },

  // Control
  { key: "control.undo", group: "Control", label: "Undo automatic moves", description: "Put a lead back to its previous stage, with a reason." },
  { key: "control.override", group: "Control", label: "Override a recommendation", description: "Decide differently from the system's recommendation, with a reason." },

  // Administration
  { key: "settings.view", group: "Administration", label: "View Settings", description: "Open Settings and read every section." },
  { key: "settings.edit", group: "Administration", label: "Change configuration and lists", description: "Change configuration values and pick-lists." },
  { key: "roles.manage", group: "Administration", label: "Manage roles and permissions", description: "Add, change and archive roles." },
  { key: "users.manage", group: "Administration", label: "Manage users", description: "Invite people, give or remove roles, deactivate and reactivate." },
  { key: "audit.view", group: "Administration", label: "View the change log", description: "Read every change and sign-in." },
]

export const PERMISSION_KEYS = new Set(PERMISSIONS.map((p) => p.key))
export const ACTIVE_PERMISSION_KEYS = PERMISSIONS.filter((p) => !p.retired).map((p) => p.key)

/** The permissions that keep the system manageable: at least one active person must hold all of them. */
export const ADMIN_POWER = ["users.manage", "roles.manage", "settings.view"] as const

export type BuiltInRole = { name: string; description: string; testOnly?: boolean; permissions: string[] | "all" }

/** The starting roles (design v1.1, section 8). They can be edited in Settings; they can't be archived. */
export const BUILT_IN_ROLES: BuiltInRole[] = [
  { name: "Founder", description: "Everything, including undo and room-only fields. Sam and John.", permissions: "all" },
  {
    name: "BD manager",
    description: "Runs Marketing: Target, the weekly batch, replies, triage, calls and overrides.",
    permissions: [
      "records.view", "records.edit", "kb.verify_facts", "gates.edit_desk", "gates.edit_call", "leads.move_target",
      "templates.write", "templates.matrix", "outreach.approve_batch", "outreach.handle_replies", "outreach.triage",
      "calls.do", "control.override",
    ],
  },
  {
    name: "Research analyst",
    description: "Imports the Brand Register, enters and verifies facts, and sets desk gates.",
    permissions: ["records.view", "records.edit", "kb.import", "kb.enter_facts", "kb.verify_facts", "gates.edit_desk"],
  },
  {
    name: "Admin",
    description: "Settings, roles and users. Room-only fields only if the founders agree.",
    permissions: ["settings.view", "settings.edit", "roles.manage", "users.manage", "audit.view"],
  },
]
