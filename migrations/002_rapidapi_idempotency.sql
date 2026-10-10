-- Rafid Marketplace only — migration 2; execute on the dedicated Marketplace Neon database.
-- Do not apply to the existing Rafid production database.
CREATE TABLE IF NOT EXISTS rafid_rapidapi_requests (
  id uuid PRIMARY KEY,
  subscriber_id text NOT NULL CHECK (length(subscriber_id) BETWEEN 1 AND 255),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  capability text NOT NULL CHECK (capability = 'company_due_diligence'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('processing','completed','failed')),
  response_status integer CHECK (response_status BETWEEN 100 AND 599),
  response_body jsonb,
  attempts integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (subscriber_id,idempotency_key),
  CHECK ((status = 'completed' AND response_status IS NOT NULL AND response_body IS NOT NULL)
      OR status <> 'completed')
);
CREATE INDEX IF NOT EXISTS rafid_rapidapi_requests_recent
  ON rafid_rapidapi_requests (created_at DESC);
