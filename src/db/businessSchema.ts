/**
 * PostgreSQL schema for production Oman business-intelligence data. Its own migration ledger
 * (`rafid_business_migrations`, see businessStore.ts) and advisory-lock number, independent of
 * both the customer/billing schema (schema.ts) and the property market-data schema
 * (marketSchema.ts) — deployable, migratable and (in development) wipeable on its own.
 *
 * `oman_companies` stores one ROW PER INGESTED SOURCE RECORD, not one row per real-world company:
 * a company reported by three different sources produces three rows sharing the same
 * `company_id`. See src/business-data/sources/companyRepository.ts's doc comment for exactly why
 * (deterministic, auditable multi-source merging) and src/business-data/matching/merge.ts for how
 * rows sharing a company_id are combined into one canonical view.
 *
 * oman_company_domains / oman_company_social_profiles / oman_company_signals /
 * oman_company_risk_flags are created here for schema completeness (Section 2's suggested
 * supporting tables) but are NOT written to by this MVP's request-time pipeline, which instead
 * derives digital-presence, signals and risk deterministically at query time from
 * oman_companies + oman_company_sources (src/business-data/scoring/*.ts) — exactly the same
 * honest, documented "structural seam, not yet wired" pattern the property domain uses for
 * ListingDataProvider (src/domain/oman/dataProviders.ts). They exist so a future ingestion step
 * (verified social profiles, a persisted signals cache, externally-sourced risk flags such as a
 * sanctions list) has a home without a further migration.
 */
export const businessSchema = `
CREATE TABLE IF NOT EXISTS oman_companies (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  company_name text NOT NULL CHECK (length(company_name) BETWEEN 1 AND 200),
  normalized_name text NOT NULL CHECK (length(normalized_name) BETWEEN 1 AND 200),
  name_ar text,
  name_en text,
  registration_number text,
  legal_type text,
  status text CHECK (status IN ('active','inactive','suspended','unknown')),
  registration_date date,
  industry text,
  activities jsonb NOT NULL DEFAULT '[]'::jsonb,
  governorate text,
  wilayat text,
  area text,
  address text,
  website text,
  email text,
  phone text,
  vat_number text,
  vat_status text,
  employee_range text,
  estimated_company_size text,
  source_type text NOT NULL CHECK (source_type IN ('government','public_registry','company_website','directory','news','demo','other')),
  source_name text NOT NULL CHECK (length(source_name) BETWEEN 1 AND 200),
  source_record_id text,
  source_url text,
  observed_at timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS oc_normalized_name ON oman_companies(normalized_name);
CREATE INDEX IF NOT EXISTS oc_registration_number ON oman_companies(registration_number);
CREATE INDEX IF NOT EXISTS oc_industry ON oman_companies(industry);
CREATE INDEX IF NOT EXISTS oc_governorate ON oman_companies(governorate);
CREATE INDEX IF NOT EXISTS oc_wilayat ON oman_companies(wilayat);
CREATE INDEX IF NOT EXISTS oc_status ON oman_companies(status);
CREATE INDEX IF NOT EXISTS oc_registration_date ON oman_companies(registration_date);
CREATE INDEX IF NOT EXISTS oc_company_id ON oman_companies(company_id);
-- Deduplication: a source with its own stable per-record identifier can never be inserted twice
-- under the same (source_name, source_record_id) pair. Records with no source_record_id are
-- exempt (always inserted as new) — mirrors property_market_records's pmr_source_dedup exactly.
CREATE UNIQUE INDEX IF NOT EXISTS oc_source_dedup ON oman_companies(source_name, source_record_id) WHERE source_record_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS oman_company_sources (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  source_name text NOT NULL CHECK (length(source_name) BETWEEN 1 AND 200),
  source_type text NOT NULL CHECK (source_type IN ('government','public_registry','company_website','directory','news','demo','other')),
  source_record_id text,
  source_url text,
  observed_at timestamptz NOT NULL,
  fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  ingested_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ocs_company_id ON oman_company_sources(company_id);
CREATE UNIQUE INDEX IF NOT EXISTS ocs_source_dedup ON oman_company_sources(company_id, source_name, source_record_id) WHERE source_record_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS oman_company_domains (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  domain text NOT NULL CHECK (length(domain) BETWEEN 1 AND 255),
  verified boolean NOT NULL DEFAULT false,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id, domain)
);

CREATE TABLE IF NOT EXISTS oman_company_social_profiles (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  platform text NOT NULL CHECK (length(platform) BETWEEN 1 AND 60),
  url text NOT NULL,
  discovered_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ocsp_company_id ON oman_company_social_profiles(company_id);

CREATE TABLE IF NOT EXISTS oman_company_signals (
  company_id uuid PRIMARY KEY,
  computed_at timestamptz NOT NULL DEFAULT now(),
  signals jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS oman_company_risk_flags (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  code text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('low','medium','high')),
  message text NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ocrf_company_id ON oman_company_risk_flags(company_id);
`;

/**
 * Phase 4-6/14: additive schema evolution for the production Oman data ingestion layer — new
 * source types (Tax Oman, Tender Board/Esnad), freshness/verification metadata (Phase 3), a
 * procurement snapshot on oman_companies (Phase 6), and two genuinely new tables: award/contract
 * records (list-shaped — a company can have zero-to-many) and a sync-run audit log (Phase 13).
 * Applied as version 2 against the same `rafid_business_migrations` ledger businessSchema (version
 * 1) uses — see businessStore.ts's MIGRATIONS array. Every statement is additive/idempotent
 * (ADD COLUMN IF NOT EXISTS, CREATE TABLE IF NOT EXISTS) so it never disturbs an already-applied
 * version-1 deployment, exactly like marketStore.ts's partnerSchema (version 2) pattern.
 */
export const businessSchemaV2 = `
-- Widen the source_type vocabulary to the three new production source families. Constraint names
-- below are Postgres's own auto-generated names for the inline CHECKs in businessSchema above.
ALTER TABLE oman_companies DROP CONSTRAINT IF EXISTS oman_companies_source_type_check;
ALTER TABLE oman_companies ADD CONSTRAINT oman_companies_source_type_check
  CHECK (source_type IN ('government','public_registry','tax_authority','government_procurement','company_website','licensed_feed','directory','news','demo','other'));
ALTER TABLE oman_company_sources DROP CONSTRAINT IF EXISTS oman_company_sources_source_type_check;
ALTER TABLE oman_company_sources ADD CONSTRAINT oman_company_sources_source_type_check
  CHECK (source_type IN ('government','public_registry','tax_authority','government_procurement','company_website','licensed_feed','directory','news','demo','other'));

-- Phase 3: per-row freshness/verification metadata.
ALTER TABLE oman_companies ADD COLUMN IF NOT EXISTS first_seen_at timestamptz;
ALTER TABLE oman_companies ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
ALTER TABLE oman_companies ADD COLUMN IF NOT EXISTS record_version integer NOT NULL DEFAULT 1;
ALTER TABLE oman_companies ADD COLUMN IF NOT EXISTS verification_status text;
ALTER TABLE oman_companies ADD COLUMN IF NOT EXISTS last_verified_at timestamptz;
-- Backfill pre-existing rows (observed_at is the best available substitute for a row ingested
-- before firstSeenAt/lastSeenAt existed), then make the two required going forward.
UPDATE oman_companies SET first_seen_at = observed_at WHERE first_seen_at IS NULL;
UPDATE oman_companies SET last_seen_at = observed_at WHERE last_seen_at IS NULL;
ALTER TABLE oman_companies ALTER COLUMN first_seen_at SET NOT NULL;
ALTER TABLE oman_companies ALTER COLUMN last_seen_at SET NOT NULL;
ALTER TABLE oman_companies DROP CONSTRAINT IF EXISTS oman_companies_verification_status_check;
ALTER TABLE oman_companies ADD CONSTRAINT oman_companies_verification_status_check
  CHECK (verification_status IS NULL OR verification_status IN ('verified','reported','estimated','inferred','stale','conflicting','unknown'));

-- Phase 6: procurement snapshot fields (Tender Board/Esnad-sourced rows populate these; every
-- other row leaves them null) — merged like any other field by matching/merge.ts.
ALTER TABLE oman_companies ADD COLUMN IF NOT EXISTS registered_supplier boolean;
ALTER TABLE oman_companies ADD COLUMN IF NOT EXISTS supplier_category text;
ALTER TABLE oman_companies ADD COLUMN IF NOT EXISTS supplier_classification text;
ALTER TABLE oman_companies ADD COLUMN IF NOT EXISTS government_procurement_presence boolean;
ALTER TABLE oman_companies ADD COLUMN IF NOT EXISTS tenders_participated integer;
ALTER TABLE oman_companies ADD COLUMN IF NOT EXISTS awarded_contract_count integer;
ALTER TABLE oman_companies ADD COLUMN IF NOT EXISTS last_tender_activity_at timestamptz;

-- Phase 5: tax/VAT verification snapshot fields (Tax Oman-sourced rows populate these).
ALTER TABLE oman_companies ADD COLUMN IF NOT EXISTS tax_verification_status text;
ALTER TABLE oman_companies ADD COLUMN IF NOT EXISTS tax_verified_at timestamptz;

-- Phase 6: individual award/contract facts — list-shaped (zero-to-many per company), so a genuine
-- separate table rather than a flat field, unlike the procurement snapshot fields above.
CREATE TABLE IF NOT EXISTS oman_company_awards (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL,
  tender_number text NOT NULL CHECK (length(tender_number) BETWEEN 1 AND 100),
  buyer text,
  title text,
  status text,
  award_value_omr numeric,
  category text,
  source_name text NOT NULL CHECK (length(source_name) BETWEEN 1 AND 200),
  observed_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS oca_company_id ON oman_company_awards(company_id);
-- Re-importing the same award updates it in place (Phase 12's non-destructive incremental sync)
-- rather than duplicating it — mirrors oc_source_dedup's dedup-key convention.
CREATE UNIQUE INDEX IF NOT EXISTS oca_source_dedup ON oman_company_awards(company_id, source_name, tender_number);

-- Phase 13: auditability — one row per ingestion run, independent of the company data itself, so
-- "when did we last try to sync source X, and what happened" is answerable without inferring it
-- from oman_companies.observed_at/ingested_at timestamps.
CREATE TABLE IF NOT EXISTS business_source_sync_runs (
  id uuid PRIMARY KEY,
  source_name text NOT NULL CHECK (length(source_name) BETWEEN 1 AND 200),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  status text NOT NULL CHECK (status IN ('running','succeeded','failed')),
  records_seen integer NOT NULL DEFAULT 0,
  records_inserted integer NOT NULL DEFAULT 0,
  records_updated integer NOT NULL DEFAULT 0,
  records_skipped integer NOT NULL DEFAULT 0,
  error_message text
);
CREATE INDEX IF NOT EXISTS bssr_source_name ON business_source_sync_runs(source_name);
CREATE INDEX IF NOT EXISTS bssr_started_at ON business_source_sync_runs(started_at);
`;

/**
 * Admin & Data Operations Dashboard: additive schema evolution (version 3, same
 * `rafid_business_migrations` ledger). Widens source_type to accept "admin_manual" (Section 20),
 * adds a per-row conservative manual disposition (Section 14/15 — never a frozen judgment about
 * the DATA itself, just "has an operator looked at this row"), and two new tables: an
 * admin-operation audit trail (Section 29) and a durable home for import rows that couldn't be
 * safely auto-resolved to a company (Section 19), so they can be revisited from the dashboard
 * instead of being lost once the import response has been shown once. Every statement is
 * additive/idempotent, exactly like businessSchemaV2.
 */
export const businessSchemaV3 = `
ALTER TABLE oman_companies DROP CONSTRAINT IF EXISTS oman_companies_source_type_check;
ALTER TABLE oman_companies ADD CONSTRAINT oman_companies_source_type_check
  CHECK (source_type IN ('government','public_registry','tax_authority','government_procurement','company_website','licensed_feed','directory','news','demo','other','admin_manual'));
ALTER TABLE oman_company_sources DROP CONSTRAINT IF EXISTS oman_company_sources_source_type_check;
ALTER TABLE oman_company_sources ADD CONSTRAINT oman_company_sources_source_type_check
  CHECK (source_type IN ('government','public_registry','tax_authority','government_procurement','company_website','licensed_feed','directory','news','demo','other','admin_manual'));

ALTER TABLE oman_companies ADD COLUMN IF NOT EXISTS admin_flag text;
ALTER TABLE oman_companies ADD COLUMN IF NOT EXISTS admin_flag_note text;
ALTER TABLE oman_companies ADD COLUMN IF NOT EXISTS admin_flag_at timestamptz;
ALTER TABLE oman_companies DROP CONSTRAINT IF EXISTS oman_companies_admin_flag_check;
ALTER TABLE oman_companies ADD CONSTRAINT oman_companies_admin_flag_check
  CHECK (admin_flag IS NULL OR admin_flag IN ('reviewed','kept_separate','confirmed_same','rejected','needs_verification'));

CREATE TABLE IF NOT EXISTS business_admin_audit_log (
  id uuid PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  admin_user text NOT NULL CHECK (length(admin_user) BETWEEN 1 AND 200),
  action text NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
  entity_type text,
  entity_id text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS baal_occurred_at ON business_admin_audit_log(occurred_at);
CREATE INDEX IF NOT EXISTS baal_action ON business_admin_audit_log(action);

CREATE TABLE IF NOT EXISTS business_unmatched_records (
  id uuid PRIMARY KEY,
  source_type text NOT NULL,
  source_name text NOT NULL CHECK (length(source_name) BETWEEN 1 AND 200),
  raw_payload jsonb NOT NULL,
  reason text NOT NULL,
  reason_detail text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'unresolved' CHECK (status IN ('unresolved','linked','created','rejected')),
  linked_company_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  resolved_by text,
  note text
);
CREATE INDEX IF NOT EXISTS bur_status ON business_unmatched_records(status);
CREATE INDEX IF NOT EXISTS bur_created_at ON business_unmatched_records(created_at);
`;

/**
 * Cardify Oman Business Index workbook import (Section 20): a small, structured metadata column on
 * the existing sync-run audit table — the source file name, sheet/row counts, and the
 * source_record_id repair strategy used, never the imported content itself. Purely additive, same
 * `rafid_business_migrations` ledger, same pattern as businessSchemaV2/V3.
 */
export const businessSchemaV4 = `
ALTER TABLE business_source_sync_runs ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
`;
