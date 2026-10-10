-- Apply ONLY to rafid-agent-marketplace-db, never the original Rafid production database.
-- The existing unique (subscriber_id,idempotency_key) intentionally remains global
-- across capabilities. Reusing one key for a different capability returns conflict.
ALTER TABLE rafid_rapidapi_requests
  DROP CONSTRAINT IF EXISTS rafid_rapidapi_requests_capability_check;
ALTER TABLE rafid_rapidapi_requests
  ADD CONSTRAINT rafid_rapidapi_requests_capability_check
  CHECK (capability ~ '^[a-z][a-z0-9_]{0,127}$');
