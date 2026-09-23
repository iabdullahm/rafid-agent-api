# Unified billing: x402, API credits, subscriptions, L402 and MPP

Rafid Agent API sells every paid capability through one **billing layer** with several
interchangeable payment rails. The capability itself never knows which rail paid for it:

```text
MCP / REST / agent tool
        ↓
Unified billing layer  (src/billing/unified/)
        ↓   picks exactly one rail per call
        ├── x402 / USDC               (existing gate, unchanged)
        ├── Prepaid API credits       (Rafid API key → account balance)
        ├── Subscription allowance    (Rafid API key → monthly included USD)
        ├── L402 / Lightning          (existing gate, unchanged — if L402_ENABLED)
        └── MPP                       (existing gate, unchanged — if MPP_ENABLED)
        ↓
capability.execute(input)             (the same registry entry for every rail)
```

| Agent | Has | Pays with |
|---|---|---|
| A | Base USDC wallet | x402 — no account, no signup |
| B | no wallet | prepaid API credits on a Rafid API key |
| C | enterprise platform | subscription allowance on a Rafid API key (+ optional credit fallback) |
| D | Lightning wallet | L402 (when enabled) |
| E | MPP client | MPP charge (when enabled) — sessions keep their own routes |

All of them reach the same capability execution path and pay the same **canonical price** —
`capability.price` in `src/domain/capabilities.ts`, the only place a price is written. x402's
`$0.15` requirement, a `$0.15` API-credit debit, `$0.15` of subscription usage, the L402 invoice
(USD → sats at the live rate) and the MPP charge are all derived from it.

## Usage modes

**Agent-native x402** — no account, no signup, pay USDC per request. Unchanged: call
`POST /api/v1/x402/<tool-path>`, or the canonical `POST /api/v1/<tool-path>` with an x402
credential (`X-PAYMENT` / `PAYMENT-SIGNATURE`) or `X-Rafid-Payment-Method: x402`. The canonical
route re-dispatches internally to the same x402 gate, so challenges (`PAYMENT-REQUIRED`),
verification and settlement are byte-for-byte the protocol's.

**API credits** — create an API key, preload a balance, and every paid call is deducted
automatically:

```http
POST /api/v1/intelligence/research-company
Authorization: Bearer raf_live_xxxxxxxxx
Content-Type: application/json
Idempotency-Key: 5b0e…

{"company":"Stripe"}
```

```json
{ "success": true, "data": { … },
  "meta": { "requestId": "…", "tool": "research_company", "price": 0.15, "currency": "USD",
            "billing": { "rail": "api_credits", "amount": "0.15", "currency": "USD",
                         "remainingBalance": "9.85", "transactionId": "txn_…" } } }
```

The same values are sent as headers: `X-Rafid-Billing-Rail`, `X-Rafid-Charge`,
`X-Rafid-Balance-Remaining` (or `X-Rafid-Subscription-Remaining`), `X-Rafid-Transaction-Id`.
`data` is exactly the tool's declared output schema; billing lives only in `meta`/headers.

**Subscription** — an API key whose account holds a plan with a monthly included USD allowance.
Usage is deducted from the allowance at each tool's price; when the allowance can't cover a call,
`auto` falls back to prepaid credits (unless `BILLING_SUBSCRIPTION_CREDIT_FALLBACK=false`).
Periods are monthly, anchored on the assignment date, and roll over automatically (no renewal
job). Default plans (`BILLING_PLANS_JSON` overrides/extends them): `free` $0, `developer` $10,
`growth` $50, `enterprise` $500 (overridable per subscription with `includedUsd`). The model
reserves `allowance.type` for a future "included tool calls" allowance; only USD is implemented.

**L402** — Lightning pay-per-request, only when `L402_ENABLED=true`: `POST /api/v1/l402/<path>`,
or the canonical route with `Authorization: L402 …` / `X-Rafid-Payment-Method: l402`.

**MPP** — only when `MPP_ENABLED=true`. Charge mode (`/api/v1/mpp/charge/<tool>`) is also
reachable from the canonical route (`Authorization: Payment …` or `X-Rafid-Payment-Method: mpp`).
Metered **sessions** keep their dedicated routes (`/api/v1/mpp/sessions/...`) — a session call is
not a per-request credential, so it isn't dispatched from the canonical route.

## Payment selection

`X-Rafid-Payment-Method: auto | credits | subscription | x402 | l402 | mpp` (default `auto`).

`auto` evaluates, in this order:

1. valid Rafid API key → subscription allowance
2. valid Rafid API key → prepaid credit balance
3. x402 credential (`X-PAYMENT` / `PAYMENT-SIGNATURE`)
4. L402 credential (`Authorization: L402 …`), if enabled
5. MPP credential (`Authorization: Payment …` / `Payment-Authorization`), if MPP charge is enabled
6. legacy `X-API-Key` customer key → the pre-existing REST flow, unchanged and unbilled by this layer
7. nothing usable → `402 payment_required` advertising every enabled rail

An explicit value selects only that rail: naming `x402`/`l402`/`mpp` **never charges an API key**
even if one is presented (use `X-Rafid-Api-Key: raf_live_…` if the `Authorization` header is needed
for the other rail), and `credits`/`subscription` never fall through to a crypto rail. A disabled
rail is `400 payment_method_unavailable`; an unknown value is `400 invalid_payment_method`.

The Rafid key is accepted as `Authorization: Bearer raf_live_…` (preferred) or `X-Rafid-Api-Key`.
`X-API-Key` keeps meaning the legacy customer key (`src/db/store.ts`) — the two systems never mix.

## Responses when payment is missing

No usable credential (billing enabled):

```json
HTTP 402
{ "success": false, "error": { "code": "payment_required", "message": "…" },
  "tool": "research_company", "price": { "amount": "0.15", "currency": "USD" },
  "paymentOptions": { "x402": { "enabled": true, "network": "eip155:8453", "asset": "USDC", "selectWith": "X-Rafid-Payment-Method: x402" },
                      "apiCredits": { "enabled": true, "authentication": "api_key", … },
                      "subscription": { "enabled": true, … }, "l402": { "enabled": false }, "mpp": { "enabled": false } },
  "paymentMethods": "/api/v1/payment-methods", "meta": { "requestId": "…" } }
```

Valid key, not enough balance: `402` with `error.code` `insufficient_credits` (or
`subscription_exhausted` / `no_active_subscription` for an explicit `subscription`), plus `tool`,
`price`, `balance`, `subscription` (when present) and `paymentOptions` — an array of the
**enabled** method ids only (e.g. `["x402","api_credits"]`). Nothing is charged, nothing executes.

The machine-readable codes use the `error.code` field of the repository's standard error envelope
(`{ success: false, error: { code, message }, meta }`), with the payment details at top level.

## Accounting model

* Money is stored as **BIGINT micro-USD** (1 USD = 1,000,000). Prices are converted once through
  a decimal-string conversion; no floating-point arithmetic touches a balance.
* Every movement is a row in `billing_ledger`: `credit`, `debit`, `refund`, `adjustment`,
  `subscription_usage`, each `pending → settled | refunded` (or `failed`), with request id, tool,
  rail, API key id, related entry and metadata. `amount_micros` is signed (effect on the customer);
  the API shows a magnitude plus `direction`. Σ ledger (credit rails) = balance, always.
* **Atomicity / concurrency** (PostgreSQL): one transaction per operation; the account row is
  locked (`SELECT … FOR UPDATE`) and money moves with a conditional update
  (`… WHERE credit_balance_micros >= $price`, `… WHERE used_micros + $price <= included_micros`).
  CHECK constraints make a negative balance or an allowance overdraw impossible even if code were
  wrong. Two simultaneous $0.25 calls against $0.30 can never both succeed (tested against a real
  PostgreSQL with a 20-connection pool).
* **Charging policy**: input is schema-validated **before** any reservation (invalid input is never
  charged) → the price is reserved (`pending`) → the capability runs → success settles the entry;
  **any** exception from the capability (internal failure, provider outage, "not found",
  unreadable document …) releases it: the entry becomes `refunded` and a `refund` entry restores
  the balance/allowance. Customers pay only for successful (2xx) results — the same rule the x402
  gate applies. A crash between reserve and settle leaves a `pending` entry that
  `npm run billing -- release-stale` refunds after `BILLING_RESERVATION_TTL_SECONDS` (schedule it,
  e.g. every 15 minutes). If the settle write itself fails after a success, the entry stays
  pending and is later refunded — that failure mode favors the customer, never double-charges.

## Idempotency

`Idempotency-Key: <1–255 visible ASCII chars>` on API-credit/subscription calls, scoped to
account + tool, persisted in `billing_idempotency` (survives restarts and spans instances).

* same key + same body (canonical JSON, key order irrelevant) after success → the original
  response is replayed with `Idempotent-Replay: true`; no second charge, no second execution;
* same key + different body → `409 idempotency_conflict`;
* same key while the first attempt is still running → `409 idempotency_in_progress` (`Retry-After`);
* a failed (refunded) attempt may be retried with the same key and is charged at most once;
* an insufficient-balance 402 doesn't consume the key (top up and retry).

Over MCP the key goes in `params._meta["com.rafidsystem/idempotency-key"]` (or the HTTP header).

## API keys

`raf_live_<43 base64url chars>` / `raf_test_…` — 256 bits from the OS CSPRNG. Only the SHA-256
hash (plus a 13-character display prefix) is stored in `billing_api_keys`; the raw key is returned
once at creation and never logged. A fast hash is correct here (not bcrypt/scrypt): the secret is
uniformly random and unguessable, and the hash must be an indexed lookup on every request. Keys
can expire (`expires_at`) and be revoked; `last_used_at` is updated at most once a minute.
Invalid/revoked/expired → `401 invalid_api_key | api_key_revoked | api_key_expired`; a suspended
or closed account → `403 account_inactive`.

## Endpoints

Public:

* `GET /api/v1/payment-methods` — every enabled rail, its credential format, the selection header
  and auto priority. Disabled rails are never listed.
* `GET /api/v1/capabilities`, `/agent.json`, `/.well-known/agent.json`, `/.well-known/ai-plugin.json`,
  `/api/v1/pricing`, `/api/v1/agent`, `/llms.txt`, `/openapi.json` — each paid capability lists its
  accepted `paymentMethods` (existing ids `x402`, `l402`, `mpp-charge`, `mpp-session`, plus
  `api_credits` and `subscription` when enabled), and a `pricing: {amount, currency}` object.

Customer (Rafid API key):

* `GET /api/v1/account/balance` — credits + current subscription period (included/used/remaining)
* `GET /api/v1/account/usage[?since=ISO]` — settled charges per tool and rail
* `GET /api/v1/account/transactions[?limit=&before=txn_…]` — the ledger, newest first

Internal admin (never in OpenAPI/discovery; `X-Billing-Admin-Key: $BILLING_ADMIN_SECRET` or
`Authorization: Bearer $BILLING_ADMIN_SECRET`; 503 until the secret is set):

```text
POST   /api/internal/billing/accounts                               {name, email?}
GET    /api/internal/billing/accounts/:id
POST   /api/internal/billing/accounts/:id/status                    {status: active|suspended|closed}
POST   /api/internal/billing/accounts/:id/api-keys                  {name?, environment?: live|test, expiresAt?}
GET    /api/internal/billing/accounts/:id/api-keys
POST   /api/internal/billing/accounts/:id/api-keys/:keyId/revoke
POST   /api/internal/billing/accounts/:id/credits                   {amount: "10.00", reason?, externalTransactionId?}
POST   /api/internal/billing/accounts/:id/adjustments               {amount: "-2.00", reason}
GET    /api/internal/billing/accounts/:id/ledger
GET    /api/internal/billing/accounts/:id/usage
PUT    /api/internal/billing/accounts/:id/subscription              {plan, includedUsd?}
DELETE /api/internal/billing/accounts/:id/subscription
POST   /api/internal/billing/maintenance/release-stale
```

`externalTransactionId` makes a top-up idempotent (e.g. a payment-processor id) — a repeat returns
`duplicate: true` and credits nothing. The same operations are available offline through the CLI:

```bash
npm run billing -- migrate
npm run billing -- account:create "Agent B Inc" ops@agent-b.example
npm run billing -- key:create acct_… prod live
npm run billing -- credit:add acct_… 10.00 "prepaid" wire-0001
npm run billing -- subscription:assign acct_… developer
npm run billing -- account:show acct_…
npm run billing -- release-stale
```

## MCP

| Mode | Supported | How |
|---|---|---|
| MCP + API-key credits/subscription (remote) | yes | `POST /mcp/credits` with `Authorization: Bearer raf_live_…` — paid `tools/call` billed to the account; billing in `result._meta["com.rafidsystem/billing"]` |
| MCP + API-key credits (local stdio) | yes | `RAFID_API_KEY=raf_live_… node dist/mcp.js` — "hosted mode": each tool call is forwarded to the hosted API (`RAFID_API_URL`, default `https://api.rafidsystem.com`) and billed there; optional `RAFID_PAYMENT_METHOD=credits|subscription` |
| MCP + MPP | yes (existing) | `POST /mcp/mpp` (`MPP_MCP_ENABLED=true`) |
| MCP + x402 | no | x402 is an HTTP-header protocol; use the REST routes |
| MCP + L402 | no | use the REST routes |

`/mcp` itself is unchanged (free, no key); without `RAFID_API_KEY` stdio runs in-process as before.

```json
{ "mcpServers": { "rafid-credits": { "url": "https://api.rafidsystem.com/mcp/credits",
    "headers": { "Authorization": "Bearer raf_live_…" } } } }
```

## Configuration

```env
API_CREDITS_ENABLED=false            # prepaid credits
SUBSCRIPTIONS_ENABLED=false          # subscription allowances
API_KEY_AUTH_ENABLED=true            # accept raf_ keys (only matters when one of the above is on)
BILLING_DATABASE_URL=                # falls back to DATABASE_URL; REQUIRED in production
BILLING_ADMIN_SECRET=                # ≥32 chars (openssl rand -hex 32); enables /api/internal/billing
BILLING_PLANS_JSON=                  # {"developer":{"monthlyIncludedUsd":"10"}, …}
BILLING_SUBSCRIPTION_CREDIT_FALLBACK=true
BILLING_RESERVATION_TTL_SECONDS=900
X402_ENABLED / L402_ENABLED / MPP_ENABLED   # unchanged, see README
```

With every flag at its default the canonical routes behave exactly as before this layer existed.

## Migration

The schema lives in `src/billing/unified/schema.ts` (tables `billing_accounts`, `billing_api_keys`,
`billing_ledger`, `billing_subscriptions`, `subscription_usage`, `billing_idempotency`, tracked in
`rafid_billing_migrations`). It is additive — no existing table is touched — idempotent and
advisory-locked. Run `npm run billing -- migrate` once per database (the store also migrates
lazily on first use).

## Not built (by design)

No customer dashboard, checkout UI, invoicing or tax engine. Top-ups are recorded by an operator
(admin API/CLI) after collecting payment by any means; `externalTransactionId` is the hook for a
future payment-processor webhook.
