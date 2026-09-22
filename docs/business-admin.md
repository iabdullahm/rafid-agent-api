# Oman Business Intelligence — Admin & Data Operations Dashboard

An internal, browser-based operator console for running and maintaining the Oman Business
Intelligence dataset (`docs/business-intelligence.md`) day to day — importing source data,
resolving identity conflicts, recording Tax Oman manual verifications, reviewing stale/unmatched
records and watching data-quality metrics — entirely through a UI, without SQL, the CLI, or a
database client.

This is **not** a fifth paid capability. It lives entirely outside `src/domain/capabilities.ts`,
so it is structurally unreachable from `/agent.json`, `/.well-known/*` discovery, the MCP tool
catalog, the OpenAPI-style capability listing, and the x402 payment-gated route family. It is
never billed, never rate-limited by the public-API limiter, and never authenticated with the
`X-API-Key` mechanism the rest of this project uses — it has its own session-cookie login instead.

It does not reimplement anything: every import, every merge/score calculation and every stored
field comes from the exact same adapters, `CompanyRepository`, and scoring functions the CLI
(`npm run business:import`) and the paid `search_oman_company` / `get_oman_company_profile` /
`analyze_oman_company` / `due_diligence_oman_company` capabilities already use. The dashboard is a
second front door onto the same engine, never a second engine.

## Enabling it

Three environment variables, set together, turn the dashboard on:

```
ADMIN_USERNAME=your-operator-username
ADMIN_PASSWORD_HASH=scrypt:...          # npm run admin:hash-password -- "a strong password"
ADMIN_SESSION_SECRET=...                # a long random string; see .env.example for how to generate one
```

Leaving all three unset disables the dashboard entirely: `/admin/*` and `/api/admin/business/*`
simply don't exist (a plain 404 from the app's own catch-all), never a route that exists but is
silently unauthenticated. Setting only one or two of the three is treated as a misconfiguration
and refuses to start (`loadConfig` throws) — there is no partially-protected state.

The dashboard also needs a real business database — either `OMAN_BUSINESS_DATABASE_URL` or
`DATABASE_URL` (see `docs/business-intelligence.md`'s "Connecting real data"). Without one, the
admin routes are — by the same design — not mounted at all, regardless of the three `ADMIN_*`
variables. Both conditions are checked once, at process startup, in `src/api/app.ts`.

Optional tuning:

| Variable | Default | Meaning |
| --- | --- | --- |
| `ADMIN_SESSION_TTL_MINUTES` | 60 | How long a login stays valid before requiring re-authentication. |
| `ADMIN_LOGIN_RATE_LIMIT_MAX` | 10 | Failed/attempted logins allowed per window, per source IP. |
| `ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS` | 900000 (15 min) | The login rate-limit window. |

In production (`NODE_ENV=production`), `ADMIN_SESSION_SECRET` must be at least 32 characters and
`ADMIN_PASSWORD_HASH` must actually be a `scrypt:...` hash — a short secret or an unhashed
password refuses to start rather than running insecurely.

### Generating a password hash

```
npm run admin:hash-password -- "a strong password, at least 12 characters"
```

Prints `scrypt:<salt>:<hash>` — paste that into `ADMIN_PASSWORD_HASH`. The plaintext password is
never written to disk, logged, or stored anywhere; only this one-way hash is.

## Logging in

Open `/admin` (redirects to `/admin/business/dashboard` once logged in, or to `/admin/login`
otherwise) and sign in with `ADMIN_USERNAME` / the password you hashed. The session is a signed,
`HttpOnly`, `SameSite=Strict` cookie (`Secure` as well in production) — never a bearer token a
script could read, and never sent cross-site regardless of this app's normal wildcard CORS policy
(see "Security assumptions" below for why that combination is safe). Failed logins are
rate-limited independently of the public API's own limiter; repeated failures from one source get
a `429` rather than an unlimited guessing window.

Every state-changing action (an import, a verification, a conflict resolution, ...) additionally
requires a per-login CSRF token — embedded automatically in every HTML form the dashboard renders,
and required as an `X-CSRF-Token` header on every mutating `fetch()` call the dashboard's own
pages make. A request missing or presenting the wrong token is refused (`403`) before it reaches
any business logic.

## Screens

| Page | Route | Purpose |
| --- | --- | --- |
| Overview | `/admin/business/dashboard` | KPI cards, dataset-progress-vs-target bars, last import per source, source coverage, bulk recalculate. |
| Companies | `/admin/business/companies` | Server-side paginated/filterable/sortable company list. |
| Company detail | `/admin/business/companies/:companyId` | Identity, verification, tax, procurement, risk, sources, field evidence, awards, manual evidence entry, recalculate. |
| Imports | `/admin/business/imports` | Upload → preview → dry run → execute; import history. |
| Tax Verification | `/admin/business/tax-verification` | Queue of companies needing a Tax Oman manual verification outcome recorded. |
| Conflicts | `/admin/business/conflicts` | Companies whose sources disagree on name/address; conservative resolution actions. |
| Stale Data | `/admin/business/stale` | Records past their source's freshness threshold, grouped by source. |
| Review Queue | `/admin/business/review` | Combined "needs attention" queue across every reason, with a deterministic priority. |
| Unmatched Records | `/admin/business/unmatched` | Import rows that couldn't be safely resolved to a company; link/reject. |
| Procurement | `/admin/business/procurement` | Government-supplier/award KPIs. |
| Awards | `/admin/business/awards` | Browse/filter individual award records, including unmatched ones. |
| Data Quality | `/admin/business/data-quality` | Completeness formula, coverage breakdowns by governorate/industry/source/status. |
| Sources | `/admin/business/sources` | Per-source authority, freshness threshold, access mode, automation status, record count. |
| System | `/admin/system` | Safe diagnostics — DB connected, migrations current, admin auth enabled, provider mode, demo data present, latest sync status. Never a secret value. |
| Audit Log | `/admin/business/audit` | Every admin action, who did it, and when. |

Every JSON route above one of these pages also exists under `/api/admin/business/*` (and
`/api/admin/business/system`), used by the dashboard's own client-side JavaScript and available
for scripting/inspection with a valid session cookie — never through MCP, discovery, or any agent
capability.

## Importing data

The Import Center (`/admin/business/imports`) never reimplements parsing or normalization: it
calls the exact same adapter (`runSourceImport()`, shared verbatim with
`npm run business:import`) the CLI uses, for the same five sources:

- `generic` — the original free-form CSV/JSON shape.
- `mociip` — MOCIIP/Invest Easy manual-lookup exports.
- `tax-oman` — Tax Oman manual VATIN-lookup exports.
- `tender-board-suppliers` — Tender Board/Esnad supplier registration exports.
- `tender-board-awards` — Tender Board/Esnad award/contract exports.

See `docs/business-intelligence.md`'s "Production Oman Data Sources" table for exactly what each
source's own access mechanism is and what raw fields it expects — the admin UI accepts the same
CSV/JSON shapes the CLI does.

### The upload itself never touches disk on the server

The browser reads the chosen `.csv`/`.json` file locally (`FileReader`, plain JavaScript already
loaded on the page) and posts its text content as JSON. The server never writes an uploaded file
to a temporary path, so there is no temp file to name safely, size-limit, or clean up — the
file-upload-security requirements (generated temp names, deletion after processing, no arbitrary
path) are satisfied by never needing a temp file in the first place. The server still enforces a
maximum content size (`MAX_IMPORT_FILE_BYTES`) and row count (`MAX_IMPORT_ROWS`), and only accepts
a `fileName` ending in `.csv` or `.json` — anything else is rejected before parsing.

### Preview → dry run → execute is mandatory, not just a UI convention

1. **Select a source, choose a file.** The page shows row/column detail client-side before
   anything is sent.
2. **Preview** (`POST /api/admin/business/imports/preview`) parses and validates every row against
   a scratch, in-memory copy of the repository — never the live database — and reports rows
   detected/valid/invalid, new vs. matched companies, records to update, duplicates skipped,
   identity conflicts, sample normalized rows (input → normalized → resolved), and every rejected
   row with its row number, reason, field and value. This is the dry run; nothing is written.
3. Preview also returns a `previewToken` — a hash of the exact source + file content just
   previewed. **Execute requires this exact token.** If the file changes, or execute is called
   without previewing first, the server rejects it (`409 PREVIEW_REQUIRED`) — this is enforced on
   the server, not only hidden by the UI, so there is no way to import a file that was never
   previewed.
4. **Execute** (`POST /api/admin/business/imports/execute`) runs the same adapter against the real
   repository, records a sync run (visible in Import History), persists any row that failed to
   resolve as an Unmatched Record for later review (never silently dropped), and writes an audit
   log entry.

**Known limitation, disclosed rather than hidden:** preview's "new vs. matched" counts are computed
against a scratch repository seeded only with real companies that share a registration number
found in the uploaded file — an improvement over the CLI's own dry-run (which always compares
against an empty repository and reports everything as new), but still an approximation, not a full
comparison against the entire live dataset. The preview response's own `warnings` array says this
explicitly. A row with no registration number cannot be preview-matched at all.

**Known limitation:** import-run statuses are `running` / `succeeded` / `failed` — there is no
separate `partial` or `dry_run` status value stored. An execute with some row-level errors is
recorded as `succeeded`, with the error count in `errorMessage`; those failed rows are the ones
that land in Unmatched Records. A `failed` sync run only occurs if the import itself throws
(unexpected), not for ordinary row-validation failures.

## Tax Oman manual verification

The Tax Verification queue (`/admin/business/tax-verification`) lists companies with no recorded
Tax Oman outcome, or one due for re-verification. For each, the company detail page (and the queue
itself) show a **Company Name / CR** helper with a **Copy CR** button and, when a Tax Oman URL is
on file, a link that opens the public Tax Oman lookup tool **in a new tab** — the operator performs
the lookup themselves, including solving any CAPTCHA. The dashboard never automates the CAPTCHA,
never embeds Tax Oman credentials, and never scrapes the resulting page.

Recording the outcome (`Verified` / `Not Registered` / `Could Not Verify` / `Needs Review`,
optionally a VAT number and a note) goes through `normalizeTaxOmanRecord()` — the exact function
`taxOmanProvider.ts`'s own batch importer calls per row — never a hand-rolled write directly into
merged company fields. The new evidence is persisted first (attached to the company as a new
`tax_authority`-sourced row); the merged view then reflects it automatically the next time it's
read, because nothing about the merged view is ever cached.

## Conflict resolution

The Conflict Review Queue (`/admin/business/conflicts`) lists every company whose contributing
sources disagree on its name or address (`mergeCompanyRows()`'s own conflict detection — not a
separate check). Side-by-side evidence is shown per row. Actions are deliberately conservative:

- **Mark reviewed** — acknowledges the conflict without changing any data; removes it from the
  outstanding queue.
- **Confirm same company** — same effect, when the operator has positively confirmed both rows
  describe one real company.
- **Keep separate** — splits one selected row out into its own new company identity
  (`relinkRow`), for when the conflict is actually two different companies that were wrongly
  merged.
- **Flag source record as incorrect** — marks one row `rejected`; it is excluded from all future
  merge/scoring computation but never deleted, and stays visible (clearly marked) on the company
  detail page for auditability.
- **Needs further verification** — leaves it flagged for follow-up.

There is no auto-merge, and no action here ever permanently deletes evidence. Every resolution is
written to the audit log with the action taken, the row involved (if any), and any note.

## Demo data

A dataset with any `sourceType: "demo"` company shows a visible warning banner at the top of the
Overview page (never silent) and a "Demo Companies" KPI. The Companies list can filter to
`Real` or `Demo` explicitly. Demo companies can never be created, updated, or re-imported through
any admin action — `importCompanyRecords()` (the same generic pipeline both the CLI and the
dashboard use) refuses `sourceType: "demo"` outright — and no admin action ever deletes a real
company record; the closest available action is flagging a specific row `rejected` (excluded from
computation, kept for audit).

## Security assumptions

- **Never public without authentication.** The dashboard 404s entirely (routes not mounted) unless
  `ADMIN_USERNAME`/`ADMIN_PASSWORD_HASH`/`ADMIN_SESSION_SECRET` are all set; every page and every
  `/api/admin/business/*` route additionally requires a valid session.
- **Session cookie**: `HttpOnly` (unreadable by page JavaScript), `Secure` in production,
  `SameSite=Strict` (never sent on a cross-site request or navigation — this is what keeps
  `src/api/app.ts`'s wildcard `Access-Control-Allow-Origin` for the rest of the API honest even
  though the admin cookie is the one exception to "no route relies on ambient cookie auth"),
  HMAC-SHA256-signed and expiring (`ADMIN_SESSION_TTL_MINUTES`) — Node's built-in `crypto` only, no
  new dependency.
- **Passwords** are never stored or logged in plaintext — only a one-way `scrypt` hash
  (`ADMIN_PASSWORD_HASH`), compared in constant time.
- **CSRF**: a per-login synchronizer token, required on every mutating request.
- **Login rate limiting**: independent from, and in addition to, the public API's own limiter.
- **Structural isolation from agent surfaces**: the admin router is a plain `express.Router()`
  mounted directly in `app.ts`, never added to `src/domain/capabilities.ts` — so it is
  unreachable from `/agent.json`, `/.well-known/ai-plugin.json`, `/llms.txt`,
  `/api/v1/capabilities`, MCP's `tools/list`/`tools/call`, or the x402 payment-gated route family.
  It is never metered by the billing hook (which keys off `res.locals.toolName`, never set here).
- **Errors**: admin routes throw the same `ApiError` type and flow through the app's one shared
  error-handling middleware — no stack traces, SQL text, or secrets are ever included in a
  response body.
- **Secrets never surfaced**: `/admin/system` and `GET /api/admin/business/system` report only
  booleans/enums (DB connected, migrations current, admin auth enabled, provider mode, demo data
  present, latest sync status) — never a connection string, session secret, or password hash, even
  partially.
- **File uploads**: `.csv`/`.json` only, size- and row-capped, never written to a server-side temp
  path (see "Importing data" above) — there is no arbitrary-path or executable-upload surface.
- **No destructive bulk operations in this phase.** There is no bulk delete, bulk "mark verified",
  or bulk CR change. The only bulk action is bulk recalculation (pure re-read, never a write to
  stored data). Nothing in the admin UI permanently deletes historical source evidence; a
  problematic row is flagged `rejected` (excluded from computation, retained for audit) instead.
- **Manual evidence is capped in authority.** An operator can never set `sourceAuthority = 1.0` (or
  any value) directly — authority always comes from the centralized `sourceTrust.ts` table, and
  every manually-entered row is written as `sourceType: "admin_manual"` (authority 0.20, the floor
  of the trust model), so it can never outrank or silently override a real source's field.

## Audit trail

Every login (success and failure), logout, import start/execute/failure, manual Tax Oman
verification, manual company creation, manual evidence entry, conflict resolution, row flag
change, unmatched-record resolution, and per-company/bulk recalculation is written to
`business_admin_audit_log` with a timestamp, the admin username, the action, the affected entity
type/id, and non-sensitive metadata. Passwords, session cookies, access tokens, and full
uploaded-file contents are never logged — metadata is limited to things like row counts, action
names, and ids.

## Backup considerations

The admin dashboard reads and writes through the same `oman_companies` /
`oman_company_awards` / `business_source_sync_runs` tables (plus two new ones,
`business_unmatched_records` and `business_admin_audit_log`, added by `businessSchemaV3`) that the
paid capabilities and the CLI already use — there is no separate database to back up. Standard
Postgres backup/point-in-time-recovery practice for the existing database covers the admin
dashboard's data automatically. Because no admin action ever hard-deletes historical evidence
(rows are flagged, not removed), a restore never has to reconcile a destructive admin operation
against source data that no longer exists.

## Outstanding limitations (honestly disclosed)

- Import preview's match detection is an approximation against a scratch-seeded copy, not the full
  live dataset (see "Importing data" above).
- Sync-run status is `running`/`succeeded`/`failed` only — no distinct `partial` status; row-level
  import errors are recorded within a `succeeded` run's `errorMessage` and as Unmatched Records.
- "Linking" an Unmatched Record to an existing company records the resolution and audit trail; it
  does not automatically re-attempt writing the original (previously-invalid) payload as new
  evidence for that company. Re-import corrected data through the normal Import Center instead.
- CSV export currently covers the Company List. The other queues (review, stale, conflicts,
  unmatched, tax verification) are inspected and act-on-able in the UI, but do not yet each have
  their own CSV export button.
- There is a dedicated Review Queue page combining every "needs attention" reason, but no
  additional navigation split beyond what's listed above (e.g. no separate saved-filter views).
- The admin dashboard's own read paths (`adminListAllRows`, etc.) are full in-memory scans sized
  for this project's current dataset targets (thousands of rows, see
  `src/business-data/config/datasetTargets.ts`) — appropriate for this MVP's scale, and documented
  in `companyRepository.ts` as a seam a future scale-up could replace with materialized aggregates
  without changing any calling code's shape.
