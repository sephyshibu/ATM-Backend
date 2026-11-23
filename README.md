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

Lane is stored in the `routing_code` column and the `routing` list (renaming them would touch existing data); every screen calls it Lane.

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
