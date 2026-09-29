# Free Preview

`POST /api/v1/preview/:capability` (and the `/v1` legacy twin) lets an agent verify that useful
data/analysis is available for a given input **before paying** — without ever revealing the paid
analysis itself. It is the "preview" step of the recommended agent flow:

```
Discover -> Preview -> Evaluate -> Pay -> Execute
```

- **Discover**: `GET /api/v1/capabilities`, `/agent.json`, `/.well-known/agent.json`,
  `/.well-known/ai-plugin.json`, `/openapi.json` and `/llms.txt` all list which capabilities have a
  preview, at `preview.endpoint`, alongside the capability's normal price and paid endpoint. This is
  single-source-of-truth data — read straight from `src/domain/capabilities.ts`'s registry, never a
  second hand-maintained list.
- **Preview**: `POST /api/v1/preview/:capability` with the same input shape the paid capability
  accepts. **Completely free and unauthenticated** — no API key, no `X-PAYMENT`/L402/MPP credential,
  no usage consumption. It never calls the capability's own `execute()` and never triggers any
  payment rail's settlement, by construction (`src/preview/`, `src/api/previewRoutes.ts` — see their
  doc comments).
- **Evaluate**: the response reports objective coverage signals only — `sourcesFound`,
  `coverageScore`, `availableSections`, `freshestSourceDate`, `dataCoverage`, and similar. It never
  includes a recommendation field (no `purchaseRecommended`); the calling agent decides whether the
  paid call is worth it.
- **Pay / Execute**: `fullResult` on the preview response reports the capability's price and the
  real, currently-enabled payment rails for it (see "Payment discovery" below) — pay over whichever
  rail your deployment supports, then call the paid endpoint as usual.

## Production hardening

### Rate limiting

Free Preview has its own dedicated rate limit, entirely separate from every other route group
(paid REST/x402/L402/MPP, discovery, MCP) and from `RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS`: a
preview burst can never exhaust a paid capability's budget, and heavy paid usage never throttles
preview. Two windows apply together — `PREVIEW_RATE_LIMIT_PER_MINUTE` (default 60) and
`PREVIEW_RATE_LIMIT_PER_HOUR` (default 300) — keyed by a verified `X-API-Key` when one is presented,
else by caller IP. `document_facts_extract` and `invoice_anomaly_check` (accept a document/invoice
payload, so their preview cost scales with caller-supplied content) get an additional, tighter
per-capability budget on top. Exceeding any window returns `429` with
`{"error":"preview_rate_limited","retryAfterSeconds":N}` and a `Retry-After` header. See
`src/preview/rateLimit.ts`.

### Response caching

Preview responses are cached in-memory, keyed `preview:<capability>:<fingerprint>` — never the raw
input, only a one-way SHA-256/HMAC digest of the capability plus its identity-relevant normalized
fields (see "Fingerprinting" below). TTLs are centralized per capability (10–20 minutes depending on
capability; override every bucket uniformly with `PREVIEW_CACHE_TTL_SECONDS`) — never hardcoded per
service. A cache failure (or no cache configured) fails open: the preview simply runs fresh. See
`src/preview/cache.ts`.

### Payment discovery

`fullResult.paymentMethods` lists only the payment rails actually enabled on this deployment, each
with its real endpoint:

```json
{
  "fullResult": {
    "capability": "research_company",
    "price": { "amount": "0.15", "currency": "USD" },
    "paymentMethods": [
      { "id": "x402", "enabled": true, "endpoint": "/api/v1/x402/intelligence/research-company" },
      { "id": "l402", "enabled": true, "endpoint": "/api/v1/l402/intelligence/research-company" }
    ],
    "endpoint": "/api/v1/intelligence/research-company"
  }
}
```

Derived from real configuration (`X402_ENABLED`, `L402_ENABLED`, `MPP_ENABLED`/`MPP_MODES`) via
`src/billing/paymentMethods.ts` — a disabled rail is never included, and the field is omitted
entirely (never an empty array) when no rail is enabled. The same helper backs the
`preview_capability` MCP tool's `fullResult`, so REST and MCP can never disagree.

### Preview → paid conversion analytics

Every preview and every paid capability call (any rail) is recorded to the same internal analytics
layer every other domain in this codebase already uses
(`src/analytics/`) under a `preview` category: `preview_requested`, `preview_available`,
`preview_limited`, `preview_unavailable`, `preview_invalid`, `preview_rate_limited`,
`preview_cache_hit`, `preview_cache_miss`, `paid_capability_started`, `preview_converted`.

A paid call converts a preview when the same capability + the same request fingerprint was
previewed within the conversion window (default 24h, `PREVIEW_CONVERSION_WINDOW_HOURS`) — the most
recent qualifying preview is used if there were several. `preview_converted` carries the payment
rail actually used (read from the billing flow itself, never client-supplied) and the latency
between preview and payment. Analytics recording is fire-and-forget and fails open: it never slows
down or fails a real request, and paid execution never depends on it. See `src/preview/analytics.ts`
and `src/api/app.ts`'s shared request-finish handler.

### Fingerprinting

A request fingerprint is `SHA-256` (or, with `PREVIEW_FINGERPRINT_SECRET` set, `HMAC-SHA256`) of the
capability name plus its normalized identity-relevant input fields (e.g. company name + country for
`research_company`; governorate/area/property type/bedrooms/size for `analyze_oman_property`) — never
financial amounts, line items, or raw document/invoice content. For `document_facts_extract` and
`invoice_anomaly_check`, only a hash of the document text (never the text itself) and small
structural metadata are included. See `src/preview/fingerprint.ts`.

## Configuration

All of the following are optional, with sensible defaults — a deployment needs to set none of them:

| Variable | Default | Purpose |
|---|---|---|
| `PREVIEW_RATE_LIMIT_PER_MINUTE` | `60` | Preview requests per client per minute |
| `PREVIEW_RATE_LIMIT_PER_HOUR` | `300` | Preview requests per client per hour |
| `PREVIEW_CACHE_TTL_SECONDS` | unset (per-capability default) | Overrides every capability's cache TTL uniformly |
| `PREVIEW_CONVERSION_WINDOW_HOURS` | `24` | How long a preview counts toward a later paid call |
| `PREVIEW_FINGERPRINT_SECRET` | unset (falls back to plain SHA-256) | HMAC key hardening fingerprints against offline enumeration |
