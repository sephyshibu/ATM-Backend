# ATM CRM — Backend

NestJS + Prisma + PostgreSQL. This first slice holds the platform every later module uses: Google sign-in by invite, users, roles and permissions, configuration values and pick-lists, and the append-only change log.

## Run it locally

You need Node.js 22 and PostgreSQL 14 or later.

```bash
npm install
cp .env.example .env            # then fill it in (see below)
createdb atm_crm                # or create the database in pgAdmin
npx prisma migrate dev --name init   # creates the tables from prisma/schema.prisma
npx prisma db seed              # roles, settings, lists and the first admins
npm run start:dev               # API on http://localhost:3000/api/v1
```

Then start the frontend (`../ATM Frontend`, `npm run dev`) and open http://localhost:5173.

### .env essentials

| Key | What to put |
|---|---|
| `DATABASE_URL` | Your PostgreSQL connection string |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | From the OAuth client in Google Cloud (below) |
| `GOOGLE_CALLBACK_URL` | `http://localhost:3000/api/v1/auth/google/callback` (must also be in the client's redirect URIs) |
| `SEED_ADMIN_EMAILS` | `sephy.mathew@staxlabs.in,tjc@bizinnox.com`. The seed makes each one a **Founder** |
| `MAIL_TRANSPORT` | `log` prints invite emails in this console and shows the link in the app; `smtp` sends them |

### Google sign-in setup (once)

1. Google Cloud Console → APIs & Services → Credentials → **Create credentials → OAuth client ID**.
2. Application type **Web application**.
3. **Authorised JavaScript origins**: `http://localhost:5173`.
4. **Authorised redirect URIs**: `http://localhost:3000/api/v1/auth/google/callback` (add the live addresses later).
5. Copy the client ID and secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
6. Optional: `GOOGLE_ALLOWED_DOMAINS=yourcompany.com` lets only company Google accounts in.

## How sign-in works

- **Invite only.** An admin invites an email in Settings → Users. The person gets an email with a link (valid `INVITE_DAYS`, default 7).
- They open the link and click **Sign in with Google**: the browser goes to Google's sign-in page and comes back to `GOOGLE_CALLBACK_URL`, which checks the account and starts the session. The first sign-in turns the invite into an active account and ties it to that Google account. Google Workspace handles the password and two-step sign-in.
- Sessions are stored in the database (a random cookie; only its hash is kept), slide for `SESSION_DAYS`, and end at once on sign-out or deactivation.
- Every request is checked on the server: a valid session, an active person, and the route's permissions.

## Roles and permissions

- Permissions are listed in `src/common/permissions.ts`. Keys are permanent: to drop one, mark it `retired`.
- Roles are built from permissions in Settings. A person can hold several roles; their permissions add up.
- Built-in roles: **Founder** (everything), **BD manager**, **Research analyst**, **Admin**. Founders can change anyone's roles and deactivate them.
- **Lock-out protection:** a change is refused if it would leave no active person able to manage users and roles.

## Data safety

- Nobody and nothing is hard-deleted: people are **deactivated**, roles **archived**, list values **retired**, role grants **revoked** (kept with who and when).
- Configuration changes add a **new version**; the earlier values stay in the history.
- `audit_event` is **append-only**: a database trigger refuses UPDATE and DELETE (installed at every start-up, `src/prisma/db-hardening.ts`).
- Database structure changes only add tables or optional columns, through new Prisma migrations.
- Records (brands, companies, people) are **archived**, never deleted. Unlinking a person from a brand keeps the old link (`removed_at`). A brand's website must be unique among brands, so duplicates are caught when adding.

## Records (Phase 1, step 1)

After pulling this step, once:

```
npx prisma migrate dev --name records   # adds organisation, brand, person, brand_person
npx prisma db seed                      # adds the tier, buying role, consent and archive-reason lists; renames Routing to Lanes
npx prisma migrate dev --name company-group   # adds parent group, legal entity and exclusion to companies
```

Products and tags (after this step, once):

```
npx prisma migrate dev --name products-tags   # adds product and record_tag
npx prisma db seed                            # adds the Tags list; renames the first-version category labels
```

Hierarchy: **organisation** (the legal entity ATM signs with) › **brands** › **products**. Every brand has a
category and a sub-category (Settings → Lists); a product may have its own, or takes the brand's. Tags are values
of the Tags list, put on organisations, brands and products (`record_tag`; taking a tag off keeps the row).

Imports and custom fields (after this step, once):

```
npx prisma migrate dev --name imports-fields   # adds custom_field, import_batch, and custom/import columns
```

Every import has four steps: choose the file, **map each column to a field** (built-in fields plus the custom
fields from Settings → Fields), check (nothing is written; every rejected row gets its exact reasons), import
(good rows are created, rejected rows are skipped and kept in `import_batch.rejected`). Brand imports create
organisations: rows with the same organisation name go under one organisation.

Leads and the journey engine (Phase 1, step 2; once):

```
npx prisma migrate dev --name leads   # adds lead and lead_move
npx prisma db seed                    # updates a list description
```

`src/leads/journey.ts` is the journey as data: stages, side lanes, every move a person can make (with its
permission, required reason or date, and checks) and every buyer event. `JourneyService` is the only code that
changes a lead; every change is a `lead_move` row. Undo reverts the newest move; override forces any position with
a reason. Imported brands get a lead at Register.

Background jobs and the scheduler (Phase 1, step 3; once):

```
npx prisma migrate dev --name jobs   # adds the job table
npx prisma db seed                   # adds Working time and Background jobs settings, and Lists → Holidays
```

`src/jobs/` has the job queue and scheduler (in PostgreSQL, no Redis), and `clock.ts` for time zones and working
time. The worker runs inside the app; set `JOBS_WORKER=off` on an instance that shouldn't run jobs. Settings → Jobs
shows the schedules, recent jobs (with results, errors and retries) and the working-time check.

Brand Register import (Phase 2, step 4; once): `npx prisma migrate dev --name import-mappings` adds
`import_mapping` (saved column mappings, picked automatically for files with the same headings). Brand rows can
carry a main and a second contact; brands already in Records are skipped or, in "update" mode, filled from the
row's non-empty cells. Gate values join the import in step 5.

Gates and the recommendation (Phase 2, step 5; once):

```
npx prisma migrate dev --name gates   # adds gate_definition, gate_result, gate_change; decision columns on lead_move
npx prisma db seed                    # creates the six gates and two gate-change reasons
```

Every lead has the six gates as a checklist (pass / fail / unknown, or unticked as not needed, with a reason).
The Brand Register import fills them from the gate columns. `GatesService` makes the recommendation (desk:
Pursue / Review / Not now; call: SQL / Verification pending / Not now); a decision against it is allowed but
needs an override reason and is flagged on the lead and its move.

Lane is stored in the `routing_code` column and the `routing` list (renaming them would touch existing data); every screen calls it Lane.

## Real Brand Registers, required fields and new gates

```bash
npx prisma migrate dev --name field-rules-and-revenue-ranges   # adds field_rule, home_revenue_max_usd; website optional
```

- **The import reads research sheets as they are.** Revenue can be "Est. 5–7M", "$100–500 million" or "Not
  disclosed" (a range is kept as low and high; text with no figure is left empty). A revenue year like
  "Aug 31-2026" gives 2026. "Tony Costello - Founder CEO" becomes the name and the job title. Headcount ranges
  ("11–50") and choices by their first word ("Low risk" → Low) are understood.
- **A row is rejected only for**: a required field that's empty (Settings → Fields), a duplicate, or an
  organisation problem. Any other cell that can't be read is left empty with a warning on that row: an untidy
  contact is left out (the brand still comes in), and so are unreadable gates, facts and dossier links.
- **Settings → Fields** has a Required switch on each built-in field (a reason is asked, and logged). Locked ones
  (names, organisation) can't be switched. A rule applies to new and imported records, and stops a field being
  emptied; records already saved without it stay as they are and can still be edited.
- **Brand website can be made optional.** Without one, a brand is matched by its name within its organisation.
- **New fields from the mapping step**: a column that isn't mapped can be added there as a brand or organisation
  field, a knowledge-base fact or a gate (choices are taken from the column), and is mapped at once.
- **Settings → Gates → Add a gate**: numbered after the last one, desk or call, checked by hand or from the
  register. It counts in recommendations at once, so leads show it as not checked until someone checks it.

## Knowledge base and dossiers (Phase 2, step 6)

```bash
npm install                           # adds @aws-sdk/client-s3 and @aws-sdk/s3-request-presigner
npx prisma migrate dev --name knowledge-base
npx prisma db seed                    # the 12 fact fields, source tiers, reject reasons and settings
```

Each brand page has a **Knowledge base** card:

- **Dossiers**, two ways in. *Upload* a PDF or Word file (.pdf, .docx, .doc), or *add a link*. The Brand
  Register import also takes a **Dossier link** column (several links per cell are fine). Links are downloaded
  by the background job `dossier.fetch` and stored like uploads; a link that needs a sign-in or opens a web page
  is kept as a link with the exact reason, and can be fetched again.
- **Facts**: the fields in Settings → Facts, grouped like the register (company, Asia position, regulatory,
  outreach). Each fact has a value, a source, a source tier, an evidence date and optionally the dossier it came
  from. The register import fills fact columns too (status Entered).
- **Maker-checker**: a second person verifies or rejects each fact. Verifying your own fact needs
  "Verify own facts" and marks it *self-verified*. A new value is a new version; a verified fact changes only
  with a new source or date and is verified again. Nothing is overwritten or deleted (a database trigger refuses it).
- **Status**: Verified when every required fact is verified; *needs a refresh* when one is past its refresh
  date (evidence date + the field's refresh days), checked daily by `facts.stale`.
- **Target**: blocked until the knowledge base is verified (Configuration → Knowledge base can make it a warning).

### Dossier storage (S3)

1. Create a bucket in **ap-southeast-1** (Singapore). Keep **Block all public access** on, turn on
   **Bucket versioning**, and leave default encryption on (SSE-S3, or SSE-KMS with your key in `S3_KMS_KEY_ID`).
   Optional but recommended: **GuardDuty Malware Protection for S3** on the bucket, to scan every file.
2. Give the server access, with nothing more than this (on AWS, attach it to the server's IAM role; locally,
   to an IAM user whose keys go in `.env`):

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow", "Action": ["s3:PutObject", "s3:GetObject"], "Resource": "arn:aws:s3:::YOUR-BUCKET/*" },
       { "Effect": "Allow", "Action": ["s3:ListBucket"], "Resource": "arn:aws:s3:::YOUR-BUCKET" }
     ]
   }
   ```

   No delete permission: the app never deletes files. Add `kms:GenerateDataKey` and `kms:Decrypt` on the key
   if you use KMS.
3. Set `S3_BUCKET` and `S3_REGION` (and the keys if not on AWS) in `.env`, restart, and check
   **Settings → Facts → Storage**: it says whether the server can reach the bucket.

How files are kept safe: uploads are held in memory (never on the server's disk) and checked by their content
(PDF or Word only; Word files with macros and PDFs with scripts are refused); the S3 key is a random id, never
the file name; each object is encrypted and carries an SHA-256 checksum S3 verifies; downloads are 5-minute
signed links made only for signed-in people who can see the brand, and each download is in the change log.
Links from a spreadsheet are fetched only over http(s) on ports 80/443, never to private network addresses
(checked at connection time and after every redirect), with a time and size limit.

Google Docs/Drive links (the dossier shared drive is private) are kept as links, never downloaded: each person
opens them with their own Google sign-in, and someone marks the dossier as checked (who, when, the version date
they read, a note). Confidential dossiers are never to be shared as "Anyone with the link".

Folders inside the bucket (S3 has no real folders; these are key prefixes, created by the first file):

```
<S3_PREFIX>/
  dossiers/<brand id>/<random id>.pdf|docx|doc                      knowledge-base dossiers
  imports/brands/<yyyy-mm>/<import id>/<random id>.xlsx|csv         the original Brand Register file of each import
  imports/products/<yyyy-mm>/<import id>/<random id>.xlsx|csv       the original product file of each import
  _storage-check.txt                                                written by Settings → Facts → Check again
```

The original Excel/CSV of an import is sent by the browser right after the import and kept with it: only the
person who ran the import can attach it, once, on the same day, and only the same file name; it must be a real
.xlsx without macros or a plain-text .csv (25 MB at most). Its name, size and SHA-256 are on the import record,
and anyone with "Import brands and products" can download it through a 5-minute link (logged).

## Email templates (Phase 3, step 8)

- **Settings → Email templates**: outreach sequences (7 emails: subject, body, days to wait) and booking emails
  (email 1 and the reminder, which waits the working days set in Configuration → Booking emails). Every edit is a
  **draft version**; anyone with `templates.approve` **approves** it, including its author (recorded as
  self-approved); approving replaces
  the version in use for future contacts only. Approved wording can't change (database trigger), and templates,
  versions and matrix cells are never deleted.
- **Settings → Template matrix**: which template a brand gets by category, sub-category and lane. The most specific
  cell wins: category + sub-category + lane → category + sub-category → category + lane → category → default.
  A cell can only point at a template with an approved version.
- **Merge fields** (`{{firstName}}`, `{{brandName}}`, `{{touchOne}}`, `{{bookingLink}}`…): filled from the brand, its
  contact (main contact → signer → first linked), its owner at ATM and its **verified** knowledge base only.
  `{{field|text}}` gives a fallback. When a brand has no verified touch-one observation, the template's **back-up
  opening line** is used and the brand page warns that the first email is generic.
- **Brand page → Emails**: exactly which template and version the brand gets, why, and every email filled in, with
  empty fields highlighted.
- The booking page link is Configuration → Booking emails → Booking page link (run `npx prisma db seed` once to add
  the setting; it never changes existing values).

## API (all under `/api/v1`)

| Method | Path | Permission |
|---|---|---|
| GET | `/auth/config`, `/auth/invite/:token` | public |
| GET | `/auth/google` (to Google) · `/auth/google/callback` (back from Google) | public |
| GET | `/auth/me` · POST `/auth/logout` | signed in |
| GET | `/users`, `/users/:id` | settings.view |
| POST | `/users/invite`, `/users/:id/resend-invite`, `/users/:id/deactivate`, `/users/:id/reactivate` · PATCH `/users/:id` | users.manage |
| GET | `/roles`, `/roles/:id`, `/roles/permissions` | settings.view |
| POST | `/roles`, `/roles/:id/archive`, `/roles/:id/restore` · PATCH `/roles/:id` | roles.manage |
| GET | `/settings/config`, `/settings/config/:key/history`, `/settings/lists` | settings.view |
| PUT | `/settings/config/:key` · POST `/settings/lists/:key/values`, `/settings/list-values/:id/retire`, `/restore` · PATCH `/settings/list-values/:id` | settings.edit |
| GET | `/records/options`, `/records/brands`, `/records/brands/check`, `/records/brands/:id`, `/records/brands/:id/history` | records.view |
| GET | `/records/organisations`, `/records/organisations/:id`, `/records/organisations/:id/history`, `/records/people`, `/records/people/:id` | records.view |
| POST | `/records/brands`, `/records/organisations`, `/records/people`, `/records/brands/:id/people`, `/records/brands/:id/people/:personId/unlink` · PATCH the same records | records.edit |
| POST | `/records/brands/:id/products`, `/records/tags` · PATCH `/records/products/:id` | records.edit |
| GET | `/records/import/{brands,products}/fields` · POST `/records/import/brands/check`, `/records/import/brands`, `/records/brands/:id/products/import/check`, `/records/brands/:id/products/import` | kb.import |
| GET | `/records/fields` · POST `/records/fields`, `/records/fields/:id/retire`, `/restore` · PATCH `/records/fields/:id` | settings.view / settings.edit |
| POST | `/records/{brands,organisations,people,products}/:id/archive`, `.../restore` | records.archive |
| GET | `/leads`, `/leads/journey`, `/leads/:id`, `/leads/brand/:brandId` · POST `/leads/:id/move`, `/leads/bulk-move` (each move checks its own permission) | records.view |
| POST | `/leads/brand/:brandId` (open), `/leads/open-missing` · PATCH `/leads/:id/person` | records.edit |
| POST | `/leads/:id/undo` | control.undo |
| POST | `/leads/:id/override`, `/leads/:id/event` (record a buyer event by hand, for testing) | control.override |
| GET | `/jobs`, `/jobs/calendar` | settings.view |
| POST | `/jobs/schedules/:name/run`, `/jobs/:id/retry`, `/jobs/test` | settings.edit |
| GET | `/leads/:id/gates` · PATCH `/leads/:id/gates/:code` (desk or call gate permission) | records.view |
| GET | `/gates` · POST `/gates` · PATCH `/gates/:code` | settings.view / settings.edit |
| GET | `/records/fields/built-in` · PATCH `/records/fields/built-in/:entity/:key` | settings.view / settings.edit |
| GET | `/knowledge/brands/:brandId`, `/knowledge/dossiers/:id/download`, `/knowledge/definitions` | records.view |
| POST | `/knowledge/brands/:brandId/dossiers` (multipart `file`), `/knowledge/brands/:brandId/links`, `/knowledge/dossiers/:id/{retry,archive,restore}` | kb.enter_facts or kb.import |
| POST | `/knowledge/dossiers/:id/check` (note, versionDate), `/knowledge/dossiers/:id/uncheck` (reason) | kb.enter_facts, kb.import, kb.verify_facts or kb.verify_own_facts; the person who added the dossier may check it (recorded as self-checked) |
| PUT | `/knowledge/brands/:brandId/facts/:key` | kb.enter_facts |
| GET | `/templates`, `/templates/:id`, `/templates/merge-fields`, `/templates/matrix`, `/templates/brands/:brandId` · POST `/templates/preview/:kind` | records.view |
| POST | `/templates` · PUT `/templates/:id/draft` · POST `/templates/versions/:id/discard`, `/templates/:id/{archive,restore}` | templates.write |
| POST | `/templates/versions/:id/approve` | templates.approve (your own version: recorded as self-approved) |
| PUT | `/templates/matrix` · POST `/templates/matrix/:id/remove` | templates.matrix |
| POST | `/knowledge/facts/:id/verify`, `/knowledge/brands/:brandId/facts/verify` | kb.verify_facts (own: kb.verify_own_facts) |
| POST | `/knowledge/facts/:id/reject` | kb.verify_facts |
| POST | `/records/imports/:id/file` · GET `/records/imports/:id/file` | kb.import |
| POST | `/knowledge/definitions` · PATCH `/knowledge/definitions/:key` · GET `/knowledge/storage` | settings.edit / settings.view |
| GET | `/audit`, `/audit/sections` | audit.view |
| GET | `/health` | public |

Every change (POST, PATCH, PUT) must carry the header `X-ATM-Client: web`; the web app always sends it.

## Project layout

```
prisma/schema.prisma      tables
prisma/seed.ts            roles, settings, lists, first admins
src/common/               permissions catalogue, settings catalogue, guards, decorators
src/auth/                 Google sign-in, sessions, access (permissions)
src/users/                invite, edit, deactivate, reactivate
src/roles/                roles and permissions
src/settings/             configuration values and pick-lists
src/records/              organisations, brands, products, people, tags, brand–person links
src/leads/                the journey (journey.ts), the engine that moves leads, and the daily lane check
src/jobs/                 job queue, scheduler, working-time clock
src/audit/                the change log
src/mail/                 invite emails (log or SMTP)
```
