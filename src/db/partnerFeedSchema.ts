/**
 * Production Feed Runner, migration version 4 (see marketStore.ts's MIGRATIONS array) — applied
 * against the SAME independent `rafid_market_migrations` ledger as versions 1-3, following the
 * same "append a new version, never edit an already-applied one" discipline.
 *
 * Adds optional scheduled-feed columns to `data_partners` (Section 1) — all nullable/defaulted, so
 * every partner created before this migration simply has no schedule configured, which is
 * correct, not a gap to backfill. `partner_feed_credentials` is a SEPARATE table, one row per
 * partner, holding only a credential's SHAPE (auth type, which header, which secret REFERENCE) —
 * never a secret value itself (Section 1: "Secrets must only come from environment variables or a
 * secure secret provider abstraction" — see src/domain/oman/partnerFeedCredentials.ts).
 */
export const partnerFeedSchema = `
ALTER TABLE data_partners ADD COLUMN IF NOT EXISTS feed_url text;
ALTER TABLE data_partners ADD COLUMN IF NOT EXISTS feed_format text CHECK (feed_format IS NULL OR feed_format IN ('json','csv'));
ALTER TABLE data_partners ADD COLUMN IF NOT EXISTS schedule_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE data_partners ADD COLUMN IF NOT EXISTS schedule_interval_minutes integer CHECK (schedule_interval_minutes IS NULL OR schedule_interval_minutes > 0);
ALTER TABLE data_partners ADD COLUMN IF NOT EXISTS last_successful_run_at timestamptz;
ALTER TABLE data_partners ADD COLUMN IF NOT EXISTS last_attempt_at timestamptz;
ALTER TABLE data_partners ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS partner_feed_credentials (
  partner_id text PRIMARY KEY REFERENCES data_partners(partner_id),
  auth_type text NOT NULL CHECK (auth_type IN ('bearer','api_key_header','none')),
  secret_ref text,
  header_name text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;
