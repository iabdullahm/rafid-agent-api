# External payment collection: Stripe Checkout + USDC on Base

Rafid's prepaid API credits (`src/billing/unified/`) have always been fundable only by an
internal admin call (`POST /api/internal/billing/accounts/:id/credits`). This layer
(`src/billing/external/`) adds two REAL, externally-verified ways a customer can fund their own
balance — Stripe Checkout (card payments) and USDC transfers on Base — without touching x402,
without rebuilding the credit ledger, and without ever trusting a client-supplied payment claim.

```text
Customer
   │  POST /api/v1/billing/topup/stripe  {amountUSD}       POST /api/v1/billing/topup/usdc {amountUSD}
   ▼                                                         ▼
Stripe Checkout Session                                  USDC top-up intent (tagged amount)
   │  customer pays on Stripe's page                        │  customer sends EXACT tagged amount
   ▼                                                         ▼
Stripe webhook (signature-verified)                       POST .../confirm {transactionHash}
   │  checkout.session.completed                             │  independently verified on-chain
   ▼                                                         ▼
        ExternalPaymentsService.handleStripeWebhookEvent / confirmUsdcTopup
                                   │
                                   ▼
              BillingEngine.fundExternalCredit()   (the ONLY way this layer touches a balance)
                                   │
                                   ▼
                 billing_ledger: one new `credit_purchase` row, balance increases
```

## Accounting model (read this first)

Three things are tracked separately and are **never summed into one number**:

| | What it is | Where it lives | Counted as |
|---|---|---|---|
| **A. Funding** | A customer pays Stripe or sends USDC | `rafid_external_payments`, then one `credit_purchase` ledger row | A **liability** — money Rafid now owes back as spendable balance. Never revenue. |
| **B. Consumption** | A customer calls a paid capability; prepaid balance is captured | `billing_ledger` rows (`debit`/`subscription_usage`, `status='settled'`) — the pre-existing reserve/settle path, untouched by this layer | **Prepaid usage revenue** — money actually earned |
| **C. x402** | An on-chain capability payment settles through x402 | `revenue` ledger (`src/revenue/`) | **On-chain settled revenue** — entirely separate from A and B |

The canonical example this layer is built around: a customer tops up **$20** via Stripe, then
calls a $0.15 capability. That is **$20 of funding** (A) and **$0.15 of revenue** (B) — never
"$20.15 of revenue". The dashboard's Collection & Funding panel and Revenue Overview panel
(`src/api/dashboard/`) enforce this split visually: External Funding Collected and Outstanding
Customer Credit Balance are shown as their own figures, never folded into Collected Revenue or
Payout Available.

`billing_accounts.credit_balance_micros` (a customer's spendable balance) is neither A's total nor
B's total — it is exactly what `BillingEngine.billingBalanceView()` already reports, and what
`BillingStore.totalOutstandingBalanceMicros()` sums across every account for the dashboard.

## Stripe Checkout flow

1. `POST /api/v1/billing/topup/stripe` (Rafid API key required) — body `{"amountUSD": 20}`.
   The amount is validated and bounded (`STRIPE_TOPUP_MIN_USD`/`MAX_USD`) **server-side** before
   Stripe is ever called; the client can never supply a Stripe price/product id. Returns only
   `{checkoutUrl, sessionId}`.
2. The customer pays on Stripe's hosted page. The success-page redirect **never funds anything** —
   it is not trusted for any accounting decision.
3. Stripe sends `POST /api/v1/billing/webhooks/stripe`, verified with the official SDK
   (`stripe.webhooks.constructEvent`) against the raw request bytes and `STRIPE_WEBHOOK_SECRET`.
   Only a verified `checkout.session.completed` event (payment_status `paid`, currency `usd`,
   amount matching) calls `BillingEngine.fundExternalCredit()`.
4. Idempotency: the webhook `event.id` is stored as `providerEventId` and doubles as the ledger's
   `externalTransactionId` (via `payment.id`) — `BillingStore.applyCredit()`'s existing dedup
   guarantees a redelivered webhook, or a retried confirmation, never double-funds.
5. Failure handling: `payment_intent.payment_failed` and `checkout.session.expired` mark the row
   `failed`. `charge.refunded` never blindly reverses the balance — see below.

### Refunds (never corrupt the balance)

If the account's *current* available balance is still ≥ the refunded amount, the refund is
mirrored as a ledger reversal (`BillingEngine.adjustCredit()`, itself idempotent per Stripe event
id) and the payment row moves to `refunded`. If the balance is *lower* than the refund (some of it
was already spent on capability calls), the row moves to `requires_review` and **no ledger entry
is written** — a human decides how to reconcile it, rather than the balance silently going
negative or a customer being silently shortchanged.

## USDC-on-Base flow

1. `POST /api/v1/billing/topup/usdc` `{"amountUSD": 10}` → `{topupId, network, chainId, asset,
   amountUSDC, recipient, reference, expiresAt}`. `amountUSDC` is the **exact** amount to send —
   see "Transaction correlation" below for why it isn't a round number.
2. Customer sends exactly that amount of USDC to `recipient` on Base.
3. `POST /api/v1/billing/topup/usdc/:topupId/confirm` `{"transactionHash": "0x…"}`. The server
   **independently** re-derives everything from the chain itself via a JSON-RPC receipt lookup —
   chain id, ERC-20 `Transfer` log, recipient, exact amount, confirmation count — never trusting
   the client's claim. Only a fully-verified, sufficiently-confirmed transfer credits the account.
4. Global transaction-hash uniqueness (`rafid_external_payments_tx_hash_uniq`) means one on-chain
   transfer can fund at most one top-up, ever.

### Transaction correlation (known limitation)

This deployment has exactly **one** shared receiving wallet — there is no per-customer address
derivation, and this layer never handles a private key. Plain ERC-20 transfers carry no reliable
memo field, so "amount + recipient" alone cannot distinguish two customers who happen to top up
the same round amount.

The mitigation: every top-up intent's amount is the customer's requested amount **plus a unique
sub-cent tag** (1–9,999 micro-USD), enforced unique-while-open at the database level. Combined
with (a) `topupId` ownership binding to the authenticated account, (b) global transaction-hash
uniqueness, and (c) independent on-chain amount verification, this is a verifier-supported design,
not a "trust the client" one — see `src/billing/external/usdcTopup.ts`'s doc comment for the full
reasoning.

**What this does NOT do**: cryptographically prove *who* sent the funds. Two residual risks are
documented rather than hidden: (1) a top-up intent's tagged amount is only unique while it stays
open (default 45 minutes) — a very late transfer after expiry is flagged `requires_review` rather
than silently accepted or silently dropped (see "Expiry" below); (2) if a `topupId` and its exact
tagged amount both leaked before the legitimate customer paid, a third party could front-run the
credit. Top-up intents are never listed publicly and are short-lived, bounding but not eliminating
this. A future iteration with real per-customer deposit addresses would close it.

### Expiry and late payments

A USDC top-up intent expires after `TOPUP_EXPIRY_MINUTES` (default 45). After expiry, its exact
tagged amount may be reissued to a different, later intent. A `confirm` call against an expired
intent is **never** auto-accepted: if the submitted hash verifies on-chain, the payment is recorded
as `requires_review` (visible in the admin table) rather than credited or silently discarded.

## Endpoints

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /api/v1/billing/topup/stripe` | Rafid API key | Create a Stripe Checkout Session |
| `POST /api/v1/billing/webhooks/stripe` | Stripe signature only | Fund a balance on verified payment |
| `POST /api/v1/billing/topup/usdc` | Rafid API key | Create a USDC top-up intent |
| `POST /api/v1/billing/topup/usdc/:topupId/confirm` | Rafid API key | Verify on-chain and fund |
| `GET /api/v1/billing/balance` | Rafid API key | `{currency, balanceUSD, reservedUSD, availableUSD}` |
| `GET /api/v1/payment-options`, `GET /api/v1/payment-methods` | none | `prepaidCredits.fundingMethods` lists enabled rails |
| `GET /api/internal/billing/external-payments`, `/topups` | `BILLING_ADMIN_SECRET` | List/filter rows |
| `GET /api/internal/billing/reconciliation` | `BILLING_ADMIN_SECRET` | Cross-check payments vs. ledger |
| `GET /api/internal/billing/stripe-balance` | `BILLING_ADMIN_SECRET` | Stripe's own available/pending balance (optional, section 18) |
| `POST /api/internal/billing/maintenance/expire-stale-topups` | `BILLING_ADMIN_SECRET` | Expire overdue intents |
| `GET /internal/dashboard` | admin session | Collection & Funding panel + top-up history table |

## Environment variables

```
STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PUBLISHABLE_KEY
STRIPE_TOPUP_MIN_USD=5, STRIPE_TOPUP_MAX_USD=1000
STRIPE_SUCCESS_URL, STRIPE_CANCEL_URL

BASE_RPC_URL, BASE_USDC_CONTRACT, TOPUP_RECEIVING_ADDRESS, TOPUP_CONFIRMATIONS=3
USDC_TOPUP_MIN_USD=5, USDC_TOPUP_MAX_USD=1000, TOPUP_EXPIRY_MINUTES=45

EXTERNAL_PAYMENTS_DATABASE_URL   # falls back to BILLING_DATABASE_URL, then DATABASE_URL
```

Stripe and USDC are independently optional. `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` never
appear in any response, log, or dashboard payload. Production requires a database if either rail
is enabled — balance-adjacent records never live only in process memory.

## Security

- Stripe: official SDK signature verification only; the success redirect is never trusted;
  `STRIPE_SECRET_KEY` is server-only.
- USDC: independent on-chain verification (network, contract, recipient, exact amount,
  confirmations), global transaction-hash uniqueness, no private key ever handled by this layer.
- General: no plaintext secrets in the dashboard, logs, or discovery output; crediting a balance
  is never possible from a client assertion alone — see `ExternalPaymentsService`'s doc comment
  ("the ONLY code that calls both an ExternalPaymentStore and
  BillingEngine.fundExternalCredit()/adjustCredit()").
- Rate limits: Stripe checkout creation, USDC top-up creation, and USDC confirmation attempts each
  have their own independent limiter (`src/api/app.ts`).

## Testing

`tests/external-payments.test.ts` covers the full matrix with an injected `StripeClient` fake (no
real Stripe network calls) and an injected `JsonRpcCall` fake (no real chain calls) — CI never
sends a real transaction or hits a real payment processor. A Postgres contract test
(`tests/external-payments-postgres.test.ts`) is gated on `TEST_DATABASE_URL`, mirroring
`tests/billing-postgres.test.ts`'s pattern, and is skipped when that variable is unset.
