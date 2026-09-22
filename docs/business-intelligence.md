# Oman Business Intelligence

Four new capabilities add company-level business intelligence for Oman to the existing
agent-monetization platform: `search_oman_company`, `get_oman_company_profile`,
`analyze_oman_company` and `due_diligence_oman_company`. They are wired into the exact same
capability registry (`src/domain/capabilities.ts`) that already drives REST, x402, MCP and every
discovery endpoint (`/agent.json`, `/.well-known/agent.json`, `/llms.txt`,
`/api/v1/capabilities`), so no separate routing, payment or discovery code was written for them.

Running and maintaining this dataset day to day — importing source files, resolving identity
conflicts, recording Tax Oman manual verifications, reviewing stale/unmatched records — is done
through the **Admin & Data Operations Dashboard**, a separate, internal, authenticated
browser UI at `/admin` (never reachable through `/agent.json`, MCP, or any paid capability). See
**`docs/business-admin.md`** for how to enable it, log in, and run the full import/verification/
conflict-resolution workflow without SQL or the CLI. It reuses this document's adapters,
repository and scoring functions verbatim — it is a second front door onto the same engine, not a
second ingestion engine.

## What it does

Given a company name, registration number or `companyId`, an agent can:

1. **Search** (`search_oman_company`, $0.05) — deterministic, weighted ranking (exact
   registration number > exact normalized name > prefix > fuzzy > location/industry bonus) over
   candidate company records, returning a `companyId` and a confidence score per match.
2. **Profile** (`get_oman_company_profile`, $0.25) — the merged, canonical view of one company
   (by `companyId`), with full source provenance: which source backed which field, and when it
   was observed.
3. **Analyze** (`analyze_oman_company`, $0.75) — commercial signals (years active, business
   maturity, digital presence, data completeness), a deterministic risk assessment, and a
   confidence score with plain-language reasons.
4. **Due diligence** (`due_diligence_oman_company`, $2.00) — a transaction-aware checklist
   (supplier contract / partnership / investment / customer credit / other), identity
   verification status, and an explicit `missingInformation` list — never a fabricated field.

None of this pipeline calls an LLM. Matching, scoring, risk and confidence are all fixed,
documented formulas over structured data — reproducible and auditable, and valuable on their own
even without any generative summarization layer on top.

## Architecture

```
src/business-data/
  types.ts               shared vocabulary (source types, statuses, OmanCompanySourceRecord, ...)
  config.ts               OMAN_BUSINESS_DATA_MODE / cache TTL / threshold env reads
  config/
    freshnessPolicy.ts    per-source-type staleness thresholds (Phase 10)
  normalizers/
    companyName.ts        deterministic legal-form canonicalization (Section 3)
    location.ts            Oman governorate/wilayat normalization (EN/AR aliases)
  sources/
    companyRepository.ts  CompanyRepository interface + MemoryCompanyRepository (tests/dev);
                            also SyncRunRecord/CompanyAwardInput types (Phase 6/13)
    adapterUtils.ts         shared sanitize/date-parsing helpers for the 3 source adapters below
    omanBusinessProvider.ts MOCIIP manual-import adapter (Phase 4)
    taxOmanProvider.ts      Tax Oman manual-import adapter (Phase 5)
    tenderBoardProvider.ts  Tender Board/Esnad manual-import adapter — suppliers + awards (Phase 6)
    fixtures.ts            the curated demo dataset (sourceType "demo" on every row)
    provider.ts             CompanyDataProvider seam: Demo / Database / LicensedFeed / Composite
  matching/
    search.ts               rankCompanies() — the weighted search engine (Section 4)
    merge.ts                 mergeCompanyRows() — multi-source field merge + conflict detection;
                              also derives the merged verificationStatus (Phase 3/9)
  scoring/
    sourceTrust.ts           the ONE source-authority table (Phase 2) — sourceAuthority()
    verification.ts          per-row/merged VerificationStatus derivation (Phase 3)
    signals.ts               commercial + procurement signals (Phase 17)
    risk.ts                   assessCompanyRisk() — the weighted risk engine (Section 7/18)
    confidence.ts             computeCompanyConfidence() — Section 6/9's confidence model
    recommendations.ts       positive signals / recommended checks / due-diligence checklist
  ingestion/
    importPipeline.ts        generic CSV/JSON → validated CompanyRecordInput → upsertCompanies()

src/db/businessSchema.ts, businessStore.ts   PostgreSQL-backed CompanyRepository, multi-version
                                                MIGRATIONS ledger (businessSchema v1 + businessSchemaV2)
src/schemas/businessInputs.ts, businessOutputs.ts   zod strictObject contracts
src/services/omanBusiness.ts   builds the active provider, wires the 4 capability entry points
src/domain/capabilities.ts     registers the 4 capabilities (the single source of truth)
src/businessImportCli.ts       `npm run business:import -- [--source=...] [--dry-run] <file>`
```

This mirrors the existing Oman property-market domain's architecture (`src/domain/oman/`,
`src/db/marketStore.ts`, `src/services/omanProperty.ts`) file-for-file: a `*DataProvider` seam
over a `*Repository`, a `Composite*Provider` for real-data-wins-over-demo merging, its own
migration ledger and advisory lock, and a `run*(input, activeProvider)` / bare-wrapper split so
tests can inject a provider without env vars.

## Identity model

Unlike the property domain, business intelligence needs to reconcile facts about the same real
company reported by different sources. One row is stored per ingested `(source, source record)`;
rows that represent the same real company share a `companyId`, resolved deterministically and in
this fixed order — never by fuzzy guessing or an LLM:

1. an existing row with the exact same non-null `registrationNumber` (authoritative key)
2. an existing row with the exact same `normalizedName` + `governorate` (soft key)
3. otherwise, a new `companyId`

`mergeCompanyRows()` then combines every row for one `companyId` into a single canonical view,
field by field, always preferring an authoritative source over a merely-reported one and the most
recent row among equally-authoritative candidates — and it explicitly detects (never silently
resolves) two sources disagreeing on the company's name or address, surfaced as risk flags.

## Database schema

New migration ledger `rafid_business_migrations` (advisory lock `74382003`), independent of the
customer/billing (`rafid_migrations`, lock `74382001`) and property-market
(`rafid_market_migrations`, lock `74382002`) ledgers — each domain migrates and deploys on its
own.

`oman_companies` is the primary table (one row per ingested source record; `company_id` groups
rows into one real company), indexed on `normalized_name`, `registration_number`, `industry`,
`governorate`, `wilayat`, `status`, `registration_date`, plus a partial unique constraint on
`(source_name, source_record_id)` for deduplication on ingestion.

Four supporting tables are schema-complete but intentionally not yet written to —
`oman_company_sources`, `oman_company_domains`, `oman_company_social_profiles`,
`oman_company_risk_flags` — an explicit "empty seam" (mirroring the property domain's unused
`ListingDataProvider`) ready for when a richer per-source or per-domain data model is needed,
without a schema migration at that point.

`businessSchemaV3` adds two tables purely for the Admin & Data Operations Dashboard
(`docs/business-admin.md`): `business_admin_audit_log` (every admin action, who did it, when) and
`business_unmatched_records` (import rows that couldn't be safely resolved to a company, so an
operator can revisit and link/reject them later). Neither is read by the paid capabilities or the
CLI's normal import path — they exist purely as the admin dashboard's own read/write seam.

## Demo dataset — read this before trusting a result

Until a licensed/official Oman company data feed is connected, every result is backed only by a
small, hand-authored dataset (`src/business-data/sources/fixtures.ts`, 10 companies / 12 source
rows). **Every row's `sourceType` is honestly `"demo"`** — never `"government"`,
`"public_registry"`, `"company_website"` or `"directory"` — so it can never be mistaken for a real
source; this caps confidence (typically well under 0.5) and keeps `identityVerified` false for
demo-only evidence. The dataset exercises the full Section 15 checklist: exact search, fuzzy
matching, same-display-name companies under different registration numbers/governorates,
Arabic/English bilingual names, different governorates, an inactive company, a very recently
registered company, a long-established company, a company with no website on file, and a
duplicate/conflicting source record (two sources disagreeing on a company's name for the same
registration number). `importCompanyRecords()` refuses to import `sourceType: "demo"` through the
real ingestion pipeline, so the demo dataset can never leak into production data by accident.

## Connecting real data

```powershell
Set-Location 'C:\Projects\rafid-agent-api'
$env:DATABASE_URL = '...'                 # or OMAN_BUSINESS_DATABASE_URL
$env:OMAN_BUSINESS_DATA_MODE = 'database'  # or 'composite' to keep the demo dataset as a fallback
npm.cmd run business:import -- --source=mociip ./data/mociip-export.csv
npm.cmd run business:import -- --source=tax-oman ./data/tax-oman-lookups.csv
npm.cmd run business:import -- --source=tender-board-suppliers ./data/esnad-suppliers.csv
npm.cmd run business:import -- --source=tender-board-awards ./data/esnad-awards.csv
```

`--source` selects which adapter parses the file — `generic` (the original free-form CSV/JSON
shape, still supported), `mociip`, `tax-oman`, `tender-board-suppliers` or
`tender-board-awards` (see "Production Oman Data Sources" below for what each expects). Add
`--dry-run` to validate and normalize a file (reporting the exact same row-level errors a real run
would) without writing anything to the database — safe to run against a file before trusting it.

Every adapter validates and normalizes every row independently (a bad row is recorded in `errors`
with its 1-based row number and skipped, never aborting the whole file), resolves governorates
against the known Oman governorate list (an unrecognized one is rejected, never guessed), and
upserts through the exact same `CompanyRepository` interface the capabilities query at request
time — there is no second write path. Re-running the same file updates existing rows (deduped on
`sourceName + sourceRecordId`, or on `(companyId, sourceName, tenderNumber)` for awards) rather
than creating duplicates. Every non-dry-run import is recorded in `business_source_sync_runs`
(Phase 13) — `repository.findSyncRuns(sourceName)` returns the audit trail (started/finished,
counts, error message) for a given source, most recent first.

## Production Oman Data Sources

This project's "Critical rule" requires researching each source's actual, legitimate access
mechanism BEFORE writing any integration, and forbids bypassing CAPTCHAs, authentication, robots
restrictions or rate limits, or using any hidden/private API improperly. That research is
summarized here (the full trail — exact URLs checked, exact `robots.txt`/CAPTCHA/login evidence —
lives in the PR/commit history and this file's git log); the conclusion for all three mandated
sources is the same: **no source currently offers a confirmed, unauthenticated, bulk-exportable
API or open-data feed, so all three are implemented as manual/admin IMPORT ADAPTERS, never live
scraping or automated login/CAPTCHA bypass.**

| Source | Portal checked | What was found | Access mechanism implemented |
| --- | --- | --- | --- |
| Oman Business / MOCIIP company register | `business.gov.om` (Invest Easy) | `robots.txt` disallows automated fetching; the public company-search is a search-mask UI with no confirmed bulk export; the Global Open Data Index rates Oman's company register "not meaningfully open" (license "Unknown") | `src/business-data/sources/omanBusinessProvider.ts` — `--source=mociip`: an authorized operator looks up/exports records through the portal's own UI, feeds the resulting rows through the adapter |
| Tax Oman (VATIN verification) | `tms.taxoman.gov.om` | `robots.txt` disallows automated fetching; the public VATIN-lookup tool requires solving a CAPTCHA on every query; no bulk API/export found | `src/business-data/sources/taxOmanProvider.ts` — `--source=tax-oman`: an authorized operator performs individual human-driven lookups (solving the CAPTCHA themselves) and records the real outcome (`verified` / `not_registered` / `pending` / `unknown`) |
| Tender Board / Esnad | Oman Tender Board's public Esnad portal | A public, no-login dashboard shows only aggregate spend/tender statistics; a mentioned "Open Data Graphical Report" section was unconfirmed at research time; individual supplier registration status and per-tender award detail sit behind PKI-certificate-based login | `src/business-data/sources/tenderBoardProvider.ts` — `--source=tender-board-suppliers` / `--source=tender-board-awards`: an operator with legitimate Esnad access exports/transcribes their own registration and award records |

Each adapter's own doc comment repeats this reasoning next to the code it governs, so the access
decision is never separated from the implementation it constrains. If any of these three sources
later publishes an official API or open-data bulk export, only that adapter's row-sourcing step
would need to change — the validation/normalization/repository-write path is already correct for
that day (see `normalize*Record()` in each file).

### Outstanding blockers (not hidden)

- **MOCIIP**: no written data-sharing agreement or confirmed bulk-download mechanism exists yet.
  Bulk production ingestion at scale requires either (a) a formal request/agreement with MOCIIP for
  structured exports or API access, or (b) continued manual/admin lookups at whatever throughput an
  authorized operator can sustain. Neither is something this codebase can resolve on its own.
- **Tax Oman**: the CAPTCHA is a deliberate access control; there is no path to bulk automation
  without either Tax Oman publishing an official API/feed, or a written agreement granting
  programmatic access. Manual, human-solved lookups are the only mechanism implemented.
- **Tender Board / Esnad**: full supplier/award detail requires a PKI certificate login tied to a
  real, authorized identity (typically the supplier's own). Only a party with legitimate Esnad
  access (the supplier itself, or someone it has authorized) can produce the exports this adapter
  consumes; this project cannot obtain that access on a user's behalf.
- **Licensed feed**: `LicensedFeedCompanyProvider` (`src/business-data/sources/provider.ts`) remains
  the documented, not-yet-integrated seam for a commercial Oman business-data vendor, should one be
  licensed — no code changes needed beyond implementing that one class once a contract exists.

None of these blockers are worked around in code — every one of them is a real authentication,
CAPTCHA, or access-control boundary this project deliberately does not attempt to bypass.

## Verification, freshness and procurement metadata (Phase 2/3/6/15/16/17)

Every source is now explainable, not just labeled:

- **`sourceAuthority`** (0–1, `src/business-data/scoring/sourceTrust.ts`) — the one, centralized
  trust weight per `sourceType`. Government/public-registry/tax-authority sources are 1.00,
  government-procurement 0.95, a company's own website 0.80, a licensed feed 0.75, a directory
  0.50, news/other 0.40, the demo dataset 0.10.
- **`verificationStatus`** (`verified` / `reported` / `estimated` / `inferred` / `stale` /
  `conflicting` / `unknown`, `src/business-data/scoring/verification.ts`) — derived at read time
  from `sourceAuthority` + per-source-type freshness (`config/freshnessPolicy.ts`), never stored as
  a frozen judgment, so a fact that was "verified" months ago correctly shows "stale" today without
  a background job. A cross-source identity/address conflict always shows as `"conflicting"`.
- **`dataCoverage`** (`realSources` / `demoSources` / `latestVerifiedAt`) — on
  `get_oman_company_profile`, `analyze_oman_company` and `due_diligence_oman_company` — answers "is
  this backed by real Oman data or only the demo dataset" at a glance, without inspecting every
  provenance entry.
- **`procurement`** (`get_oman_company_profile` / `due_diligence_oman_company`) — the merged
  Tender Board/Esnad snapshot (`registeredSupplier`, `supplierCategory`, `tendersParticipated`,
  `lastTenderActivityAt`, ...) plus the individual `awards` list (`oman_company_awards` — one row
  per real award/contract, never fabricated). `awardedContractCount` in this block always equals
  `awards.length` when any award records have actually been imported for the company, and only
  falls back to a supplier-snapshot's own reported count otherwise, so the two can never silently
  disagree. `commercialSignals.governmentProcurementActivity` (`active` / `limited` / `none`) is
  the same idea as a single classification; `due_diligence_oman_company` additionally sees the real
  award list and reports `"active"` whenever one exists, even if no supplier-snapshot source ever
  set an award count explicitly.
- **`verification.taxVerificationStatus`/`taxVerifiedAt`** — the Tax Oman-specific outcome, surfaced
  wherever `verification` appears. A `"not_registered"` outcome is a real, deterministic risk signal
  (`TAX_NOT_REGISTERED`, weight 20/high in `scoring/risk.ts`) — never a generic "missing data" flag.

## Security (Phase 23)

- Every SQL statement in `src/db/businessStore.ts` is parameterized (`$1, $2, ...`) — no string
  interpolation of any user- or import-supplied value into a query, including the new award/sync-run
  statements added in this phase.
- Import adapters never execute, evaluate, or interpret imported content as anything other than
  inert data (no `eval`, no dynamic code from a row's fields); every text field is length-capped and
  control-character-stripped (`adapterUtils.ts`'s `sanitizeText`), mirroring the existing generic
  importer.
- No source adapter performs live network access, authentication-bypass, CAPTCHA-solving, or
  scraping of an access-controlled page — every one of the three mandated sources is a manual/admin
  import path (see "Outstanding blockers" above), so there is no automated-credential or
  automated-CAPTCHA attack surface to secure in the first place.
- No personally-identifying data about individuals is ever ingested or returned — every field on
  every adapter's raw-row interface is company-level (registration numbers, VAT numbers, tender
  numbers — never a person's national ID, personal address, or personal contact detail).

## Performance (Phase 24)

- The Phase 4-6 migration (`businessSchemaV2`) is purely additive (`ADD COLUMN IF NOT EXISTS`,
  `CREATE TABLE IF NOT EXISTS`) and applies in a single transaction under the existing
  `rafid_business_migrations` advisory lock — no downtime, no data rewrite beyond the one-time
  `first_seen_at`/`last_seen_at` backfill (`UPDATE ... WHERE first_seen_at IS NULL`, a no-op on
  every subsequent deploy).
- `oman_company_awards` and `business_source_sync_runs` are indexed on `company_id` /
  `source_name`+`started_at` respectively — every new read path (`findAwardsByCompanyId`,
  `findSyncRuns`) is an indexed lookup, not a table scan.
- Field-level evidence (Phase 8) is computed at READ time from existing row data rather than
  persisted to a separate table — a deliberate choice to avoid a second write path that could drift
  out of sync with `oman_companies`, at the cost of a small amount of read-time computation that is
  already cheap (a handful of rows per company in practice).

## Privacy

Only company-level data is ever returned: no personal ID numbers, no private personal
addresses/phone/email, no financial account numbers. The schema and every output contract were
designed without a field for any of these.

## Future capabilities this schema is ready for (not yet implemented)

Listed in `src/domain/roadmap.ts` / `GET /agent.json`'s `roadmap` field / `GET /llms.txt`:
`search_oman_tenders`, `analyze_oman_tender`, `match_company_to_tender`,
`discover_oman_business_opportunities`, `find_oman_suppliers`, `compare_oman_companies`. Each is
designed to reuse `companyId`/industry/location/provenance/risk/confidence rather than a new
schema domain.
