/**
 * Phase 3: PostgreSQL schema for production Oman property market data. Kept in its own migration
 * ledger (`rafid_market_migrations`, see marketStore.ts) independent of the customer/billing
 * schema in schema.ts — the market data layer has nothing to do with API-key authentication or
 * usage metering and should be deployable (or wiped/reloaded during development) without
 * touching customer data.
 */
export const marketSchema = `
CREATE TABLE IF NOT EXISTS property_market_records (
  id uuid PRIMARY KEY,
  governorate text NOT NULL CHECK (length(governorate) BETWEEN 1 AND 60),
  wilayat text,
  area text NOT NULL CHECK (length(area) BETWEEN 1 AND 80),
  normalized_area text NOT NULL CHECK (length(normalized_area) BETWEEN 1 AND 80),
  property_type text NOT NULL CHECK (property_type IN ('apartment','villa','townhouse')),
  bedrooms integer CHECK (bedrooms BETWEEN 0 AND 20),
  bathrooms integer CHECK (bathrooms BETWEEN 0 AND 20),
  size_sqm numeric NOT NULL CHECK (size_sqm > 0 AND size_sqm <= 5000), -- widened to <= 10000 by migration version 5 (marketSizeBoundsFix.ts) on every deployment that migrates forward from here; this literal is intentionally left unchanged (never edit an already-applied migration's SQL — see MIGRATIONS' own doc comment in marketStore.ts)
  transaction_type text NOT NULL CHECK (transaction_type IN ('rental','sale')),
  price_omr numeric NOT NULL CHECK (price_omr > 0 AND price_omr <= 1000000000),
  rent_period text CHECK (rent_period IN ('monthly','annual')),
  furnished text CHECK (furnished IN ('furnished','semi_furnished','unfurnished')),
  source_type text NOT NULL CHECK (source_type IN ('official_statistics','listing_asking_price','manual_benchmark','partner_feed')),
  source_name text NOT NULL CHECK (length(source_name) BETWEEN 1 AND 200),
  source_record_id text,
  source_url text,
  observed_at timestamptz NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT pmr_rental_has_rent_period CHECK (transaction_type <> 'rental' OR rent_period IS NOT NULL),
  CONSTRAINT pmr_sale_has_no_rent_period CHECK (transaction_type <> 'sale' OR rent_period IS NULL)
);
-- Comparable-query index: every comparable lookup filters on exactly these three columns first.
CREATE INDEX IF NOT EXISTS pmr_area_type_txn ON property_market_records(normalized_area, property_type, transaction_type);
CREATE INDEX IF NOT EXISTS pmr_bedrooms ON property_market_records(bedrooms);
CREATE INDEX IF NOT EXISTS pmr_size_sqm ON property_market_records(size_sqm);
CREATE INDEX IF NOT EXISTS pmr_observed_at ON property_market_records(observed_at DESC);
-- Deduplication: a source with its own stable per-record identifier (a listing ID, a statistics
-- row number) can never be inserted twice under the same (source_name, source_record_id) pair.
-- Records with no source_record_id (source_record_id IS NULL) are exempt from this constraint —
-- they cannot be safely deduplicated against a prior import and are always inserted as new; see
-- importPipeline.ts's dedup notes for exactly what this means for re-importing such a file.
CREATE UNIQUE INDEX IF NOT EXISTS pmr_source_dedup ON property_market_records(source_name, source_record_id) WHERE source_record_id IS NOT NULL;
`;
