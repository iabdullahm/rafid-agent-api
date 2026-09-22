/**
 * Partner Data Feed layer, migration version 2 (see marketStore.ts's MIGRATIONS array) — applied
 * against the SAME independent `rafid_market_migrations` ledger as marketSchema.ts's version 1,
 * never against the customer/billing schema (schema.ts) or its own migration ledger.
 *
 * `data_partners` intentionally stores no personal data (Section 1) — only what is needed to
 * attribute and administer a feed. `token_digest` is the SHA-256 digest of a partner's bearer
 * token (see src/domain/oman/partners.ts's generatePartnerToken()/partnerTokenDigest()) — the
 * plaintext token itself is never persisted anywhere, mirroring rafid_keys.digest in schema.ts.
 *
 * `property_market_records.partner_id` is added as a nullable foreign key: every row imported
 * before this migration (or imported through any non-partner path — official statistics, the
 * manual benchmark) simply has partner_id NULL, which is correct, not a migration gap to backfill.
 */
export const partnerSchema = `
CREATE TABLE IF NOT EXISTS data_partners (
  partner_id text PRIMARY KEY CHECK (partner_id ~ '^[a-z0-9][a-z0-9-]{1,63}$'),
  partner_name text NOT NULL CHECK (length(partner_name) BETWEEN 1 AND 200),
  feed_type text NOT NULL CHECK (feed_type IN ('csv','json','http_feed')),
  source_type text NOT NULL CHECK (source_type IN ('official_statistics','listing_asking_price','manual_benchmark','partner_feed')),
  enabled boolean NOT NULL DEFAULT true,
  data_license_reference text CHECK (data_license_reference IS NULL OR length(data_license_reference) <= 300),
  contact_reference text CHECK (contact_reference IS NULL OR length(contact_reference) <= 300),
  token_digest text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  records_received integer NOT NULL DEFAULT 0,
  records_accepted integer NOT NULL DEFAULT 0,
  records_rejected integer NOT NULL DEFAULT 0,
  records_updated integer NOT NULL DEFAULT 0,
  latest_observation_date timestamptz
);

ALTER TABLE property_market_records ADD COLUMN IF NOT EXISTS partner_id text REFERENCES data_partners(partner_id);
-- A record's deterministic, non-LLM data-quality score (Section 7) — see dataQualityScore.ts.
-- Nullable: only records written through importMarketRecords() ever populate it.
ALTER TABLE property_market_records ADD COLUMN IF NOT EXISTS data_quality_score numeric CHECK (data_quality_score IS NULL OR (data_quality_score >= 0 AND data_quality_score <= 1));
CREATE INDEX IF NOT EXISTS pmr_partner_id ON property_market_records(partner_id) WHERE partner_id IS NOT NULL;
`;
