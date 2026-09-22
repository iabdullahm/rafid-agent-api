export const schema = `
CREATE TABLE IF NOT EXISTS rafid_customers (
 id uuid PRIMARY KEY, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
 active boolean NOT NULL DEFAULT true,
 requests_per_minute integer NOT NULL CHECK(requests_per_minute BETWEEN 1 AND 1000000),
 monthly_quota integer NOT NULL CHECK(monthly_quota BETWEEN 1 AND 1000000000),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rafid_keys (
 id uuid PRIMARY KEY, customer_id uuid NOT NULL REFERENCES rafid_customers(id),
 digest text UNIQUE NOT NULL CHECK(length(digest)=64), label text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz,
 UNIQUE(customer_id,id)
);
CREATE TABLE IF NOT EXISTS rafid_counters (
 customer_id uuid PRIMARY KEY REFERENCES rafid_customers(id),
 minute_start timestamptz NOT NULL, minute_count integer NOT NULL,
 month_start timestamptz NOT NULL, month_count integer NOT NULL
);
CREATE TABLE IF NOT EXISTS rafid_usage (
 request_id uuid PRIMARY KEY, customer_id uuid NOT NULL,
 key_id uuid NOT NULL, capability text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 admitted boolean NOT NULL, status integer CHECK(status BETWEEN 100 AND 599),
 duration_ms integer CHECK(duration_ms >= 0),
 FOREIGN KEY(customer_id,key_id) REFERENCES rafid_keys(customer_id,id)
);
CREATE INDEX IF NOT EXISTS rafid_usage_customer_time ON rafid_usage(customer_id,created_at DESC);
`;
