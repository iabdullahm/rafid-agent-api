/**
 * PostgreSQL schema for the external payment-collection layer (Stripe Checkout + USDC on Base).
 * Applied by PostgresExternalPaymentStore.migrate() — same versioned, advisory-locked,
 * idempotent-migration discipline as billing/unified/schema.ts (see that file's doc comment).
 *
 * Accounting invariants enforced by the database itself:
 *  - a Stripe webhook event credits at most once     (rafid_external_payments_provider_event_uniq)
 *  - an on-chain transaction hash credits at most once, GLOBALLY across every customer
 *                                                     (rafid_external_payments_tx_hash_uniq)
 *  - at most one OPEN top-up intent may claim a given tagged USDC amount at a time
 *                                                     (rafid_topup_intents_open_amount_uniq)
 * These are the database-level backstops behind this layer's application-level idempotency and
 * correlation logic (service.ts / usdcTopup.ts) — belt and suspenders, exactly like
 * billing_ledger_external_tx already is for the unified billing ledger.
 */
export const EXTERNAL_PAYMENTS_MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS rafid_topup_intents (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES billing_accounts(id),
  requested_amount_atomic bigint NOT NULL CHECK (requested_amount_atomic > 0),
  amount_usdc_atomic bigint NOT NULL CHECK (amount_usdc_atomic > 0),
  network text NOT NULL,
  chain_id integer NOT NULL,
  asset text NOT NULL DEFAULT 'USDC' CHECK (asset = 'USDC'),
  recipient text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','failed','expired')),
  transaction_hash text,
  external_payment_id text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS rafid_topup_intents_account_idx ON rafid_topup_intents(account_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS rafid_topup_intents_open_amount_uniq ON rafid_topup_intents(recipient, amount_usdc_atomic) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS rafid_topup_intents_pending_idx ON rafid_topup_intents(expires_at) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS rafid_external_payments (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES billing_accounts(id),
  provider text NOT NULL CHECK (provider IN ('stripe','usdc_base')),
  provider_payment_id text,
  provider_event_id text,
  topup_id text REFERENCES rafid_topup_intents(id),
  amount_atomic bigint NOT NULL CHECK (amount_atomic > 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  network text,
  asset text,
  transaction_hash text,
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created','pending','confirmed','failed','refunded','requires_review')),
  confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS rafid_external_payments_account_idx ON rafid_external_payments(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rafid_external_payments_provider_payment_idx ON rafid_external_payments(provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS rafid_external_payments_provider_event_uniq ON rafid_external_payments(provider, provider_event_id) WHERE provider_event_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS rafid_external_payments_tx_hash_uniq ON rafid_external_payments(provider, transaction_hash) WHERE transaction_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS rafid_external_payments_status_idx ON rafid_external_payments(status, created_at DESC);
`
  }
];
