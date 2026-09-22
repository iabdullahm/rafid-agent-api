/**
 * Partner Operations layer, migration version 3 (see marketStore.ts's MIGRATIONS array) — applied
 * against the SAME independent `rafid_market_migrations` ledger as marketSchema.ts's version 1 and
 * partnerSchema.ts's version 2, following the same "append a new version, never edit an
 * already-applied one" discipline.
 *
 * Two tables, both deliberately minimal:
 *
 * `partner_ingestion_audit` — one row per ingestion ATTEMPT (src/domain/oman/partnerAudit.ts's
 * PartnerIngestionAuditRepository). It intentionally has NO column for a partner token, a raw
 * request body, or any individual property record's fields — see partnerAudit.ts's doc comment for
 * why. `partner_id` is a plain text foreign key (not ON DELETE CASCADE — a partner is disabled, not
 * deleted, so this never needs to handle a partner disappearing out from under its audit trail).
 *
 * `data_partner_audit_log` — one row per partner ADMINISTRATION event (created, enabled, disabled,
 * token rotated — Section 2/10: "audit the rotation event"). Separate from the ingestion audit
 * table because these are operator actions against the partner record itself, not ingestion
 * traffic, and have a completely different, much lower volume and retention shape.
 */
export const partnerOpsSchema = `
CREATE TABLE IF NOT EXISTS partner_ingestion_audit (
  id uuid PRIMARY KEY,
  partner_id text NOT NULL REFERENCES data_partners(partner_id),
  request_id text NOT NULL,
  received_at timestamptz NOT NULL,
  records_received integer NOT NULL DEFAULT 0,
  records_accepted integer NOT NULL DEFAULT 0,
  records_rejected integer NOT NULL DEFAULT 0,
  records_updated integer NOT NULL DEFAULT 0,
  http_status integer NOT NULL,
  duration_ms integer NOT NULL,
  error_code text
);
CREATE INDEX IF NOT EXISTS pia_partner_received ON partner_ingestion_audit(partner_id, received_at DESC);

CREATE TABLE IF NOT EXISTS data_partner_audit_log (
  id uuid PRIMARY KEY,
  partner_id text NOT NULL REFERENCES data_partners(partner_id),
  event_type text NOT NULL CHECK (event_type IN ('created','enabled','disabled','token_rotated')),
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS dpal_partner_occurred ON data_partner_audit_log(partner_id, occurred_at DESC);
`;
