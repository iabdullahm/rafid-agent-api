/**
 * PostgreSQL schema for the unified billing ledger. Applied by PostgresBillingStore.migrate()
 * (idempotent, serialized with an advisory lock, tracked in rafid_billing_migrations) — run it
 * with `npm run billing -- migrate`; the store also runs it lazily on first use.
 *
 * Accounting invariants enforced by the database itself, not only by application code:
 *  - credit_balance_micros >= 0                        (no negative balances, ever)
 *  - 0 <= used_micros <= included_micros               (no allowance overdraw)
 *  - one refund per charge                             (billing_ledger_one_refund)
 *  - one active subscription per account               (billing_subscriptions_one_active)
 *  - a top-up's external transaction id credits once   (billing_ledger_external_tx)
 * All amounts are BIGINT micro-USD (1 USD = 1,000,000) — never floating point.
 */
export const BILLING_MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS billing_accounts (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','closed')),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  credit_balance_micros bigint NOT NULL DEFAULT 0 CHECK (credit_balance_micros >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS billing_api_keys (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES billing_accounts(id),
  key_prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  environment text NOT NULL CHECK (environment IN ('live','test')),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS billing_api_keys_account_idx ON billing_api_keys(account_id);
CREATE TABLE IF NOT EXISTS billing_ledger (
  id text PRIMARY KEY,
  seq bigserial NOT NULL UNIQUE,
  account_id text NOT NULL REFERENCES billing_accounts(id),
  api_key_id text REFERENCES billing_api_keys(id),
  request_id text,
  tool_name text,
  type text NOT NULL CHECK (type IN ('credit','debit','refund','adjustment','subscription_usage')),
  amount_micros bigint NOT NULL,
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  rail text NOT NULL CHECK (rail IN ('api_credits','subscription','admin')),
  status text NOT NULL CHECK (status IN ('pending','settled','refunded','failed')),
  external_transaction_id text,
  related_entry_id text REFERENCES billing_ledger(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS billing_ledger_account_seq_idx ON billing_ledger(account_id, seq DESC);
CREATE INDEX IF NOT EXISTS billing_ledger_pending_idx ON billing_ledger(created_at) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS billing_ledger_external_tx ON billing_ledger(account_id, external_transaction_id)
  WHERE external_transaction_id IS NOT NULL AND type IN ('credit','adjustment');
CREATE UNIQUE INDEX IF NOT EXISTS billing_ledger_one_refund ON billing_ledger(related_entry_id) WHERE type = 'refund';
CREATE TABLE IF NOT EXISTS billing_subscriptions (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES billing_accounts(id),
  plan text NOT NULL,
  status text NOT NULL CHECK (status IN ('active','canceled')),
  included_micros bigint NOT NULL CHECK (included_micros >= 0),
  anchor_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  canceled_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS billing_subscriptions_one_active ON billing_subscriptions(account_id) WHERE status = 'active';
CREATE TABLE IF NOT EXISTS subscription_usage (
  subscription_id text NOT NULL REFERENCES billing_subscriptions(id),
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  included_micros bigint NOT NULL CHECK (included_micros >= 0),
  used_micros bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (subscription_id, period_start),
  CHECK (used_micros >= 0 AND used_micros <= included_micros)
);
CREATE TABLE IF NOT EXISTS billing_idempotency (
  account_id text NOT NULL REFERENCES billing_accounts(id),
  tool_name text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  request_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('in_progress','completed','failed')),
  ledger_entry_id text REFERENCES billing_ledger(id),
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, tool_name, idempotency_key)
);
CREATE INDEX IF NOT EXISTS billing_idempotency_entry_idx ON billing_idempotency(ledger_entry_id);
`
  }
];
