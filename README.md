# Rafid Property Intelligence — agent-native property and facility intelligence

Rafid provides deterministic property intelligence for autonomous AI agents, starting with OMR calculations for the Oman market. **AI agents are the primary consumer of this product, not human SaaS users.** MCP and x402 are the primary interfaces; the `X-API-Key` REST routes are the underlying transport and a compatibility layer for callers that can't do MCP or x402 yet. This MVP does not fetch market data, provide investment recommendations, or (outside x402) collect payments.

The intended flow for an agent is: **discover** a capability → **select** the right tool → **pay per call** over x402 (or authenticate with an API key) → **execute** → get a **structured, machine-readable** result. No account, dashboard or subscription is required for either access model, and none is planned — see "Design constraints" below.

## Agent discovery

An agent (or an agent marketplace/directory crawler) can start from any of the following; all are public, unauthenticated, always present, and contain no secrets (no wallet private keys, no API keys, no usage data for other customers):

| Endpoint | Purpose |
|---|---|
| `GET /agent.json` | The full agent manifest: product identity, every supported protocol (MCP, x402, REST) and its role, x402 terms, and the complete tool catalog with full input/output JSON Schemas. Start here. |
| `GET /.well-known/ai-plugin.json` | Manifest in the legacy OpenAI ChatGPT-plugin convention, for tooling that still discovers services this way. |
| `GET /.well-known/agent.json` | An Agent Card in the Agent2Agent (A2A) protocol's convention, listing each tool as a `skill`. |
| `GET /llms.txt` | A plain-text briefing for an LLM-based agent: what Rafid does, every tool and how to call it, pricing, the x402 model, and known limitations — no JSON parsing required. |
| `GET /api/v1/capabilities` | The machine-first capability registry: name, description, `whenToUse`, price, schemas and examples for every tool — optimized for a model to decide what to call, not for a human to read. |
| `GET /api/v1/mcp/status` | Factual MCP status: which transports are live (`stdio` always, `http` only when `MCP_REMOTE_ENABLED=true`), the tool count, and the remote endpoint path if any. |
| `GET /api/v1/agent` | Legacy service-metadata endpoint (kept for backward compatibility); superseded by `/agent.json` above. |
| `GET /api/v1/pricing` | The full price list (USD, pay-per-call), sourced from one catalog shared by every code path — never duplicated or out of sync. |
| `GET /api/v1/tools` | Legacy tool catalog (kept for backward compatibility); superseded by `/api/v1/capabilities` above. |

Every one of these is generated from the single capability registry in `src/domain/capabilities.ts` — see "Capability registry" below — so they can never disagree with each other or with what a call actually does.

Once a tool is chosen, call it with an `X-API-Key` header, or — when `X402_ENABLED=true` — call its `/api/v1/x402/...` twin with no key and pay per call on-chain instead (see "Pay-per-call via x402" below).

A human visiting `/` in a browser instead gets a short landing page (agent integration examples, tool list, pricing, links to docs); agents and scripts that send `Accept: application/json` keep getting the original JSON discovery payload — see "Landing page" below.

## Design constraints

This product is deliberately agent-native, not a human SaaS dashboard. It does not have, and is not planned to have, user accounts, a dashboard, subscriptions, Stripe billing, or a billing portal. The `X-API-Key` route family is a compatibility transport for callers that authenticate that way, not an invitation to build account management around it.

## Customer storage phase

PostgreSQL-backed customers, hashed keys, usage tracking and per-customer limits are now available. See [activation and administration](docs/customers.md). Existing env-key development mode remains unchanged; production requires `AUTH_MODE=postgres`. No payment collection is implemented outside x402 (see below).

## Deploy on Vercel

The Express entry point exports the app when `VERCEL=1` and keeps the normal port listener for local runs. `vercel.json` pins the function to `iad1` near the current US East Neon database and limits requests to 15 seconds. `.vercelignore` prevents the local `.env`, caches and generated files from being uploaded.

Production API: <https://api.rafidsystem.com>  
Landing page: <https://api.rafidsystem.com/> (browsers) / same URL with `Accept: application/json` (agents)  
Health: <https://api.rafidsystem.com/api/v1/health>  
OpenAPI: <https://api.rafidsystem.com/openapi.json>  
Agent metadata: <https://api.rafidsystem.com/api/v1/agent>

Connect the repository directory to a Vercel project, attach the Neon Marketplace database, and configure these Production environment variables:

```dotenv
AUTH_MODE=postgres
NODE_ENV=production
LOG_LEVEL=info
X402_ENABLED=false
DATABASE_URL=<sensitive pooled Neon URL with sslmode=verify-full>
```

The Neon integration may inject `DATABASE_URL`; verify that it points to the rotated credential and pooled endpoint. Mark manually added database values as sensitive. Do not upload `.env` or use the previously exposed password. Deploy with Vercel CLI or a connected Git repository, then verify `/api/v1/health`, `/openapi.json`, `/api/v1/agent`, an authenticated analysis request, and the PostgreSQL usage record. The local stdio MCP process is not deployed by this Express function.

To also accept pay-per-call crypto payments, set `X402_ENABLED=true` and `X402_WALLET_ADDRESS=<a 0x-prefixed EVM address you control>` in Production. Leave `X402_ENABLED=false` (the default) until you are ready to receive real payments; see Configuration and the "Pay-per-call via x402" section below. On Base mainnet (`eip155:8453`) also set `CDP_API_KEY_ID`/`CDP_API_KEY_SECRET` (see Configuration).

## Prerequisites and quick start

Use Node.js 24+ and npm. From the repository root:

```powershell
Set-Location 'C:\Projects\rafid-agent-api'
npm.cmd ci --cache .npm-cache
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Copy the generated key into `RAFID_API_KEYS` in `.env`. Keep it private. A blank or short key prevents HTTP startup. Multiple keys are comma-separated. On macOS/Linux use `npm` and `cp .env.example .env`.

```powershell
npm.cmd run dev
```

Development loads `.env` and watches TypeScript sources. For a compiled run:

```powershell
npm.cmd run typecheck
npm.cmd run build
npm.cmd test
npm.cmd start
```

`npm test` first builds and then runs service, live HTTP, agent-marketplace, OpenAPI contract, and compiled MCP stdio tests. `npm start` loads `.env` and runs `dist/server.js`; dependencies are pinned in `package-lock.json`.

## Configuration

| Variable | Default / behavior |
|---|---|
| PORT | 8787 |
| NODE_ENV | development; accepts development, test, production |
| RAFID_API_KEYS | Required for REST; random keys of at least 24 characters |
| API_KEY | Legacy fallback when RAFID_API_KEYS is empty |
| LOG_LEVEL | info; error logs only HTTP/tool 5xx completions; silent disables request logs |
| X402_ENABLED | false; true enables pay-per-call crypto payments at `/api/v1/x402/...` (no API key needed there) and requires X402_WALLET_ADDRESS. Disabled (the default) never affects normal API-key calls — the x402 route family simply doesn't exist and is omitted from discovery/`/openapi.json` |
| X402_NETWORK | eip155:84532 (Base Sepolia testnet); the public facilitator only settles this network for EVM. Any other network, e.g. eip155:8453 (Base mainnet), requires CDP_API_KEY_ID/CDP_API_KEY_SECRET below |
| X402_WALLET_ADDRESS | Empty; required 0x-prefixed EVM address that receives payments when X402_ENABLED=true |
| X402_FACILITATOR_URL | https://x402.org/facilitator; must be an https URL |
| CDP_API_KEY_ID | Empty; Coinbase Developer Platform API key ID (Ed25519 Secret API Key). Required together with CDP_API_KEY_SECRET for any network besides Base Sepolia |
| CDP_API_KEY_SECRET | Empty; Coinbase Developer Platform API key secret. When both CDP vars are set, they take over as the facilitator (X402_FACILITATOR_URL is then ignored) |
| MCP_REMOTE_ENABLED | true; mounts the Streamable HTTP MCP transport at `/mcp`. false unmounts it entirely (404, and every manifest/llms.txt advertises stdio only) — a rollback switch with no code change |
| RAFID_LOGO_URL | Empty; `logo_url` in `/.well-known/ai-plugin.json`. Left blank rather than fabricated |
| RAFID_CONTACT_EMAIL | Empty; `contact_email` in `/.well-known/ai-plugin.json` |
| RAFID_LEGAL_INFO_URL | Empty; `legal_info_url` in `/.well-known/ai-plugin.json` |
| USAGE_REPOSITORY | console (default: one JSON line to stderr per call); memory (local inspection only, lost on restart); postgres (durable `rafid_agent_usage` table — requires DATABASE_URL, independent of AUTH_MODE) |
| RATE_LIMIT_ENABLED | true; per-process, IP-keyed rate limiting on discovery, x402 and remote MCP routes (three independent budgets). false disables it (development/tests) |
| RATE_LIMIT_WINDOW_MS | 60000 (one minute) |
| RATE_LIMIT_MAX | 60 requests per window, per IP, per route group |
| OMAN_PROPERTY_DATA_MODE | manual (default); database; composite. Which Oman property data source(s) `analyze_oman_property` actually queries — see "Production Oman market data" below |
| OMAN_MARKET_DATABASE_URL | Empty; falls back to `DATABASE_URL` when unset. Lets the market-data database be separate from the customer/billing database if desired |
| OMAN_MARKET_STALE_DAYS | 365; a comparable sample whose median age exceeds this is flagged `staleMarketData: true` and its confidence score is deterministically reduced. Independent of and shorter than `comparables.ts`'s 540-day hard recency cutoff (which excludes a record from the pool entirely) |
| OMAN_MARKET_CACHE_TTL_MS | Empty/0 (disabled); when set, `DatabaseOmanPropertyDataProvider` caches a comparable-pool query in memory for this many milliseconds — see "Production Oman market data" below |
| OMAN_RECENT_SALES_DAYS | 730 (~2 years); the window `analyze_oman_property`'s `historicalSalesContext.recentComparableSales`/`recentMedianPricePerSqmOMR` treat as "recent" — separate from, and never affecting, `comparables.ts`'s fixed 540-day cutoff used for the current market estimate. See "Historical sales context" below |
| NCSI_API_BASE_URL | `https://map.ncsi.gov.om/ODPAPI` (verified live base — see "Official market context (NCSI)" below) |
| NCSI_REQUEST_TIMEOUT_MS | 8000 |
| NCSI_CACHE_TTL_MS | 21600000 (6 hours); 0 disables caching official context lookups |
| NCSI_REAL_ESTATE_DATASET_ID | Empty; no default — see "Official market context (NCSI)" below for why this must be operator-verified, never guessed |
| NCSI_FIELD_MAP_JSON | Empty; a JSON object mapping this capability's field names to the configured dataset's actual field names — see "Official market context (NCSI)" below |
| MARKET_DATA_INTERNAL_API_KEY | Empty; no default. Shared secret gating `GET /api/v1/internal/market-data/status` and `.../partners` — see "Partner Data Feed" below. Unset means those two routes always return 503, never a silently-open endpoint |
| PARTNER_FEED_STALE_DAYS | 7; a partner whose latest accepted record is older than this is reported `stale: true` by `GET /api/v1/internal/market-data/partners` — a per-partner monitoring signal only, never affecting ingestion, `analyze_oman_property`, or any other partner's staleness |

The app accepts pre-existing environment variables over `.env`. No live credentials are included. `.env`, dependencies, build output and npm cache are ignored by Git. Never commit or log `CDP_API_KEY_SECRET`, `X402_WALLET_ADDRESS`'s private key (never requested or stored by this app), or `DATABASE_URL`.

## Architecture

```text
src/
  api/app.ts             Express application factory; no listener side effects
  api/agent.ts           Agent-marketplace discovery, pricing, tool-catalog and capability-registry builders
  api/manifest.ts        /agent.json, /.well-known/ai-plugin.json and /.well-known/agent.json builders
  api/llms-txt.ts        /llms.txt plain-text briefing builder
  api/landing.ts         Dependency-free HTML landing page for browsers
  api/openapi.ts         OpenAPI 3.1 built from shared Zod schemas
  domain/capabilities.ts The single AgentCapability registry every consumer above reads from
  domain/roadmap.ts      Planned-but-not-implemented future tools (metadata only, nothing callable)
  domain/financial.ts    Percentage/rounding helpers and maintenance defaults
  domain/oman/types.ts          Oman domain vocabulary (property types, furnished status, source types)
  domain/oman/locations.ts      Muscat area/wilayat normalization (English + Arabic aliases)
  domain/oman/comparables.ts    Comparable selection: size/bedroom/furnished tolerances, IQR outlier removal
  domain/oman/confidence.ts     Deterministic confidence scoring (never model-invented)
  domain/oman/dataProviders.ts  OmanPropertyDataProvider abstraction: Official (real NCSI context) + Listing (stub) + Manual + Database + Composite
  domain/oman/fixtures.ts       Curated/demo Muscat rental & sale benchmark dataset (clearly labeled, not live data)
  domain/oman/marketRepository.ts PropertyMarketRepository interface (engine-agnostic) + MemoryPropertyMarketRepository
  domain/oman/importPipeline.ts Validating CSV/JSON import pipeline for production market records
  domain/oman/dataQualityScore.ts Deterministic, non-LLM per-record data-quality scoring (Partner Data Feed)
  domain/oman/partners.ts       PropertyDataPartner/PartnerRepository abstraction + MemoryPartnerRepository (Partner Data Feed)
  domain/oman/cache.ts          ComparableCache interface + MemoryComparableCache (Redis-ready shape, not yet wired)
  domain/oman/config.ts         OMAN_PROPERTY_DATA_MODE / staleness threshold / cache TTL / NCSI / Partner Data Feed config readers
  domain/oman/officialContext.ts       OfficialMarketContext type + field-map-driven NCSI record adapter (never a hardcoded field name)
  domain/oman/officialContextCache.ts  OfficialMarketContextCache interface + MemoryOfficialMarketContextCache
  services/ncsi/ncsiClient.ts   NcsiClient: catalog discovery, dataset records, retries, timeout, normalized errors
  db/marketSchema.ts    PostgreSQL schema for property_market_records (independent migration ledger)
  db/marketStore.ts     PostgresPropertyMarketRepository: the production PropertyMarketRepository implementation
  db/partnerSchema.ts   PostgreSQL schema for data_partners + property_market_records partner columns (migration v2)
  db/partnerStore.ts    PostgresPartnerRepository: the production PartnerRepository implementation (shares its Pool with PostgresPropertyMarketRepository)
  api/marketDataRoutes.ts Partner Data Feed ingestion + internal status/health routes (never in the capability registry)
  middleware/partnerAuth.ts Per-partner bearer-token auth (X-Partner-Token) + internal shared-secret auth (X-Internal-Api-Key)
  marketImportCli.ts    `npm run market:import -- <file> [PARTNER_ID]` CLI entry point
  ncsiDiscoverCli.ts    `npm run ncsi:discover` CLI: lists NCSI's live catalog and flags real-estate-relevant datasets
  schemas/              Strict shared input and output contracts
  services/property.ts  Validated calculations shared by both transports
  services/omanProperty.ts Deterministic Oman property-analysis pipeline (analyze_oman_property)
  middleware/auth.ts    API-key authentication
  middleware/rateLimit.ts In-memory, IP-keyed rate limiter for public agent endpoints
  billing/catalog.ts    Indicative prices and injectable authorization boundary (single source of truth)
  billing/service.ts    BillingService: the only place a price is read; usage recording
  billing/usage.ts      UsageRepository abstraction (Console/Memory/Postgres implementations)
  billing/x402.ts       Real x402 payment middleware + always-on x402 info builder
  config/env.ts         Validated environment configuration
  utils/                Safe errors and metadata-only logging
  mcp/server.ts         MCP registration factory (shared by both transports)
  mcp/remote.ts         Remote Streamable HTTP MCP handler (/mcp) + /api/v1/mcp/status builder
  mcp.ts                Local stdio entry point
  server.ts             HTTP listener and shutdown
  calculators.ts        Compatibility re-exports
```

Services validate direct calls as well as transport calls. New capabilities belong in the shared catalog with input/output schemas and a service function; the catalog drives REST, MCP and OpenAPI. No calculation logic lives in the HTTP or MCP handlers, and no pricing logic lives in the calculation services — every price is read through `BillingService`, which reads `billing/catalog.ts`.

### Capability registry

`src/domain/capabilities.ts` exports one array, `capabilities: AgentCapability[]`, and that array is the *only* place a tool's name, path, description, `whenToUse`/`useCases` (the recommendation-layer hint for which tool answers which situation), input/output schema, example, price, currency, payment protocol, idempotency and side-effect flag are written. Every consumer below reads this array rather than holding a second copy:

- REST route registration (`api/app.ts`) — both the `X-API-Key` and `x402` route families
- The OpenAPI document (`api/openapi.ts`) — `operationId` is the capability's own `name` (`analyze_property`, `compare_properties`, `estimate_maintenance`, `analyze_oman_property`), and request/response examples come from `capability.example`/`capability.execute(capability.example)`
- The MCP server (`mcp/server.ts`) — tool name, schemas, and a description built from `capability.description` + `capability.whenToUse`
- The x402 payment gate and `BillingService` (`billing/x402.ts`, `billing/service.ts`) — `billing/catalog.ts`'s `prices` object is *derived* from `capabilities` (`Object.fromEntries(capabilities.map(c => [c.name, c.price]))`), never a second literal
- Every agent-marketplace/discovery endpoint (`/api/v1/agent`, `/api/v1/pricing`, `/api/v1/tools`, `/api/v1/capabilities`, `/agent.json`, the two `/.well-known/...` manifests, `/llms.txt`)

Adding a capability to this one array is what makes it real everywhere at once; nothing else needs to be told about it separately. `src/domain/roadmap.ts` holds a separate, much smaller list (`plannedCapabilities`) of future tools — `estimate_property_rent`, `analyze_lease`, `check_contract_risk`, `diagnose_maintenance_issue`, `estimate_repair_cost`, `generate_property_report` — that are metadata only: no route, no MCP registration, no schema, no price, nothing callable. They exist so `/agent.json` and `/llms.txt` can tell an agent what's coming without it mistaking a name on a list for a working endpoint; promoting one to a real capability means adding a full entry to `capabilities`, the only registry that drives actual behavior (`analyze_oman_property` was itself on this list until this phase; it now has a full entry and has been removed from `plannedCapabilities`).

## REST API

REST base: `http://localhost:8787`.

| Method | Endpoint | Auth |
|---|---|---|
| GET | / | Public — HTML landing page (browsers) or JSON discovery (`Accept: application/json`) |
| GET | /agent.json | Public — full agent manifest (protocols, x402 terms, complete tool catalog) |
| GET | /.well-known/ai-plugin.json | Public — OpenAI-plugin-style manifest |
| GET | /.well-known/agent.json | Public — A2A-style Agent Card |
| GET | /llms.txt | Public — plain-text briefing for LLM-based agents (`text/plain`) |
| GET | /api/v1/capabilities | Public — machine-first capability registry (schemas, pricing, when to use) |
| GET | /api/v1/agent | Public — legacy agent-marketplace metadata (superseded by `/agent.json`) |
| GET | /api/v1/pricing | Public — full pay-per-call price list |
| GET | /api/v1/tools | Public — legacy tool catalog (superseded by `/api/v1/capabilities`) |
| GET | /api/v1/x402 | Public — x402 protocol/pricing info (always available, independent of X402_ENABLED) |
| GET | /api/v1/x402/status | Public — factual runtime status: enabled, mode, network, asset, facilitator, walletConfigured, paymentEnforcement |
| POST | /api/v1/property/analyze | X-API-Key |
| POST | /api/v1/property/compare | X-API-Key |
| POST | /api/v1/maintenance/estimate | X-API-Key |
| POST | /api/v1/oman/property/analyze | X-API-Key |
| GET | /api/v1/health | Public liveness |
| GET | /openapi.json | Public raw OpenAPI document |
| POST | /api/v1/market-data/import | X-Partner-Token (Partner Data Feed — infrastructure, not an agent capability; see below) |
| GET | /api/v1/internal/market-data/status | X-Internal-Api-Key (Partner Data Feed; see below) |
| GET | /api/v1/internal/market-data/partners | X-Internal-Api-Key (Partner Data Feed; see below) |

Legacy `/v1/...` POST routes and `/health` remain available. **Response migration:** legacy routes now return the same envelope as canonical routes; read results from `response.data`. Unknown fields are rejected, names must be unique after trimming, and unauthenticated startup is no longer allowed.

Success:

```json
{
  "success": true,
  "data": {},
  "meta": { "requestId": "server-generated-uuid" }
}
```

A tool call (the four POST capabilities, on either the API-key or x402 route family) additionally enriches `meta` with the tool name, its price and its currency, so an agent can confirm what it was charged without a second lookup:

```json
{
  "success": true,
  "data": { "grossYield": 8.47 },
  "meta": { "requestId": "server-generated-uuid", "tool": "analyze_property", "price": 0.01, "currency": "USD" }
}
```

Error:

```json
{
  "success": false,
  "error": {
    "code": "INVALID_INPUT",
    "message": "Input validation failed",
    "details": [{ "path": "propertyValue", "message": "Property value must be at least 0.01" }]
  },
  "meta": { "requestId": "server-generated-uuid" }
}
```

Responses include `X-Request-ID`. Codes cover 400 validation/malformed JSON, 401 authentication, 404 unknown endpoints, 413 bodies over 32kb, 415 unsupported content type/encoding, 500 sanitized internal failures, and 429 for a configured rate-limit adapter. PostgreSQL mode enforces customer minute limits and monthly quotas; env-key development mode has no default limiter. `/openapi.json` intentionally returns the raw specification for discovery tools.

### Agent discovery, pricing and tool catalog

```bash
curl -s https://api.rafidsystem.com/api/v1/agent
```

```json
{
  "success": true,
  "data": {
    "name": "Rafid Property Intelligence",
    "description": "Property and facility intelligence tools for AI agents",
    "version": "0.1.0",
    "mcp": true,
    "docs": "/docs",
    "openapi": "/openapi.json",
    "health": "/api/v1/health",
    "pricing": "/api/v1/pricing",
    "tools": "/api/v1/tools",
    "x402": "/api/v1/x402",
    "x402Enabled": false,
    "endpoints": ["/api/v1/property/analyze", "/api/v1/property/compare", "/api/v1/maintenance/estimate", "/api/v1/oman/property/analyze"]
  },
  "meta": { "requestId": "..." }
}
```

`GET /api/v1/pricing` returns `{ "currency": "USD", "model": "pay-per-call", "tools": { "analyze_property": 0.01, "compare_properties": 0.03, "estimate_maintenance": 0.02, "analyze_oman_property": 0.25 } }` — the exact same object `billing/catalog.ts` defines, with nothing recomputed or duplicated. `GET /api/v1/tools` returns one entry per capability with a full JSON Schema for its input and a derived output summary, enough for an agent to construct a valid call without reading any documentation.

### Landing page

Human visitors to `/` get a small, dependency-free HTML page (no build step, no external assets) led by the agent-native positioning ("Property intelligence built for AI agents. Discover. Pay per call. Execute."), an "Agent Integration" section with copyable MCP/x402/OpenAPI/manifest examples, the tool list and pricing, and links to `/docs`, `/openapi.json` and `/api/v1/health`. API-key/REST access is documented as a compatibility option, not the primary message. This is purely a presentation layer over the same data the JSON endpoints return; nothing about the API's behavior changes. Any client that sends `Accept: application/json` (including a plain `fetch()`/`curl` with an explicit header, or any existing integration) is unaffected and keeps receiving the JSON discovery payload it always has.

### Property analysis

PowerShell (replace the key placeholder):

```powershell
$headers = @{ 'X-API-Key' = '<your-api-key>' }
$body = @{ propertyValue = 85000; annualRent = 7200; serviceCharge = 650; maintenanceCost = 400 } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:8787/api/v1/property/analyze -Headers $headers -ContentType application/json -Body $body
```

The resulting `data` includes `grossYield: 8.47`, `netYield: 7.24`, `annualOperatingCost: 1050`, and `annualNetIncome: 6150`.

Optional inputs: `serviceCharge`, `maintenanceCost`, `otherAnnualCosts`, `vacancyRatePct` (0–100). The old `maintenance` alias is accepted, but cannot be supplied alongside `maintenanceCost`.

Formulas:

- Gross annual income = annualRent.
- Effective annual rent = annualRent × (1 − vacancyRatePct / 100).
- Operating cost = serviceCharge + maintenanceCost + otherAnnualCosts.
- Net annual income = effective annual rent − operating cost.
- Gross yield = annualRent / propertyValue × 100.
- Net yield = net annual income / propertyValue × 100.
- Simple payback = propertyValue / net annual income; null for nonpositive income or a number too large to represent safely.

All money is OMR. Outputs are rounded to two decimals using JavaScript numbers, preserving the original MVP convention (not a settlement ledger). Finite input amounts are bounded to 1e12; property value must be at least 0.01. Negative net income is valid. Legacy output fields `grossYieldPct`, `netYieldPct`, and `annualOperatingCosts` remain. Financing, taxes, transaction fees and appreciation are excluded.

### Property comparison

```powershell
$body = @{ properties = @(
  @{ name = 'A'; propertyValue = 85000; annualRent = 7200 },
  @{ name = 'B'; propertyValue = 100000; annualRent = 7000 }
) } | ConvertTo-Json -Depth 5
Invoke-RestMethod -Method Post -Uri http://localhost:8787/api/v1/property/compare -Headers $headers -ContentType application/json -Body $body
```

Requires 2–20 properties with unique, nonblank names (up to 120 characters). Returns calculated `properties` and `sortedByNetYield` names, descending by rounded net yield, retaining input order for ties. This ordering is a metric comparison, not investment advice.

### Maintenance estimate

```powershell
$body = @{ propertyValue = 100000; ageYears = 12; units = 1 } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:8787/api/v1/maintenance/estimate -Headers $headers -ContentType application/json -Body $body
```

This example returns annual maintenance 1300 OMR, monthly reserve 108.33 OMR and maintenance percentage 1.3, plus `assumptionsUsed`.

Default annual rates: age below 5 → 0.6%; 5–under 10 → 0.9%; 10–under 20 → 1.3%; 20+ → 1.8%. Defaults: age 0, units 1. Additional units add 35 OMR/year each. Supported ages are 0–200 and units 1–10000.

```text
annual estimate = propertyValue × annualRatePct / 100
                + (units − 1) × additionalUnitCost
```

Override assumptions per request with `"assumptions": { "annualRatePct": 1.5, "additionalUnitCost": 50 }`. The returned percentage includes the additional unit allowance. Legacy `annualRent` is accepted but unused. Property type and area are not modeled yet and are rejected as unknown fields. This preserves the existing heuristic without inventing unsupported local cost factors; it requires calibration before commercial estimates.

### Oman property analysis (Muscat)

`analyze_oman_property` ($0.25/call) is the first Rafid capability whose value comes from local market evidence, not just arithmetic over the caller's own numbers. It answers "is this Muscat property reasonably priced as a rental investment?" with structured, sourced evidence — never a hard-coded "good"/"bad investment" verdict.

```powershell
$body = @{ governorate = 'Muscat'; area = 'Al Mouj'; propertyType = 'apartment'; bedrooms = 2; sizeSqm = 130; askingPriceOMR = 118000 } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:8787/api/v1/oman/property/analyze -Headers $headers -ContentType application/json -Body $body
```

Required: `governorate`, `area`, `propertyType` (`apartment` | `villa` | `townhouse`), `sizeSqm`, `askingPriceOMR`. Optional: `wilayat`, `bedrooms`, `bathrooms`, `furnished` (`furnished` | `semi_furnished` | `unfurnished`), `optionalAnnualServiceChargeOMR`, `optionalAnnualMaintenanceOMR`.

**Coverage (MVP):** Muscat governorate only. Supported areas: Al Mouj, Muscat Hills, Qurum, Bausher, Azaiba, Al Khuwair, Madinat Al Irfan, Ghubrah (`domain/oman/locations.ts`'s `MUSCAT_AREAS`). English and common Arabic spellings both resolve to the same canonical area (e.g. `الموج` / `Al Mouj` / `the wave` → `Al Mouj`) — deliberately without fuzzy/phonetic matching, so an unlisted place name is reported `matchType: "unmatched"` rather than guessed at.

**Comparable selection (`domain/oman/comparables.ts`):** never compares across property type; filters by area + property type + a ±20% size tolerance (`SIZE_TOLERANCE_PCT`) to build the reported `comparableCount`, then narrows to an exact bedroom match and exact furnished-status match where at least 3 (`MIN_COMPARABLES`) exist, relaxing to ±1 bedroom or "any furnished status" only when the exact match is too small (reported via `bedroomToleranceApplied`/`furnishedFilterRelaxed` and surfaced in `riskFlags`/`assumptions`); records older than 540 days are excluded outright as stale before any of this; a standard 1.5×IQR rule then removes statistical outliers from what remains (`sampleSizeUsed`). Rents quoted annually are normalized to a monthly figure before any comparison.

**Confidence (`domain/oman/confidence.ts`):** a fixed, documented weighted formula over sample size, data freshness, size/bedroom similarity to the subject, and price dispersion (coefficient of variation) — never a model-invented number. Below `MIN_COMPARABLES` used comparables, confidence is always `{ score: 0, level: "insufficient" }`.

**Fallback behavior:** below `MIN_COMPARABLES` comparables (rental side) or an unsupported governorate/area, `insufficientMarketData: true` is returned, `unavailableOutputs` lists exactly which fields were withheld (e.g. `market.estimatedMonthlyRentOMR`, `investment.grossYieldPct`), and deterministic figures that need no market data (`pricePosition.askingPricePerSqmOMR`, `investment.estimatedOperatingCostOMR`) are still computed. Nothing is ever fabricated to fill a gap.

**Rafid does not scrape property websites, and never will as a way of sourcing this data.** `OfficialOmanDataProvider` and `ListingDataProvider` (`domain/oman/dataProviders.ts`) are real, wired-in seams for a future official/licensed feed — they return empty today rather than faking or scraping data. Production market data is expected to come from one of: official government/statistical sources, a licensed real-estate data vendor, a partner data-sharing agreement, or a customer's own listing/transaction export. All of these reach the analysis pipeline the same way — as rows imported into the `property_market_records` table via the import pipeline below — so no scraping code exists or is planned anywhere in this codebase.

**Provenance:** every response includes a `provenance` array — `{ sourceType, sourceName, sourceDate, recordCount }` — so a caller can tell `official_statistics`, `listing_asking_price`, `partner_feed` and `manual_benchmark` apart, and can tell an asking price from a confirmed completed-transaction price. The bundled `ManualDatasetProvider` (`domain/oman/fixtures.ts`) is a small, explicitly curated benchmark dataset, clearly labeled in every `sourceName` as demo/MVP data — never official statistics and never confirmed transaction prices. `riskFlags` includes `demo_dataset_not_live_market_data` only when a `manual_benchmark` record actually contributed to the comparables used for that specific answer — it is computed per-response, not hard-coded, so an answer built entirely from database-backed production records (official statistics, a licensed listing feed, or a partner feed) does not carry it.

**Data freshness:** every response includes a `dataQuality` block — `{ latestDataDate, dataFreshnessDays, sampleSize, sourceTypes, staleMarketData }` — computed from whichever comparables actually drove the answer, even when the sample is too small to produce a full result (freshness is never hidden). `dataFreshnessDays` beyond `OMAN_MARKET_STALE_DAYS` (default 365 days) sets `staleMarketData: true`, adds a `stale_market_data` risk flag, and applies a fixed, documented penalty inside the confidence formula (`domain/oman/confidence.ts`) — so an agent consuming this API can decide how much to trust an answer from `dataQuality`/`confidence`/`riskFlags` alone, without needing to inspect raw records.

Output shape: `normalizedLocation`, `subjectProperty`, `market` (estimated monthly/annual rent range, comparable/sample counts, data freshness), `investment` (gross/net yield, operating cost, net income), `pricePosition` (asking price/sqm vs. the observed sale-comparable range, `below_market`/`at_market`/`above_market`/`insufficient_data`), `comparablesSummary` (rent-per-sqm low/median/high of the sample actually used), `dataQuality`, `historicalSalesContext`, `riskFlags`, `confidence`, `provenance`, `assumptions`, `insufficientMarketData`, `unavailableOutputs`. Strict output schema in `schemas/omanOutputs.ts`.

**Historical sales context:** every response also includes `historicalSalesContext` — `{ available, recordsAvailable, recentComparableSales, medianHistoricalPricePerSqmOMR, recentMedianPricePerSqmOMR, oldestRecordDate, latestRecordDate, sourceTypes, priceSemantics, phaseBreakdown }` — a separate, additive field surfacing long-term completed-sale history (e.g. a multi-year partner feed spanning 2006-2026) alongside, but never mixed into, `market`/`pricePosition`/`comparablesSummary`/`confidence` above, which stay driven exclusively by the current-comparable pool (`comparables.ts`'s 540-day `MAX_DATA_AGE_DAYS` cutoff, unchanged). `recordsAvailable`/`oldestRecordDate`/`latestRecordDate`/`medianHistoricalPricePerSqmOMR` are computed with real database aggregation (`PropertyMarketRepository.getHistoricalSaleStatistics()`) rather than reusing the capped, most-recent-first candidate pool `findSaleComparables()` returns, so they stay accurate for a history longer than that cap. `recentComparableSales`/`recentMedianPricePerSqmOMR` are a genuinely *matched* subset — area, property type, size similarity (±20%) and bedrooms where available — within the configurable `OMAN_RECENT_SALES_DAYS` window (default 730 days), computed by `comparables.ts`'s `selectRecentSaleRecords()`; this is a deliberately separate selection path from `selectComparables()`, both because the recency window differs and because a completed-sale record routinely has no recorded `furnished` status (true of every partner-feed sale record observed so far) — `selectComparables()` requires one and would otherwise silently report zero recent sales for exactly this data. `phaseBreakdown` (only relevant to a phased-development partner feed like Al Mouj's) lists per-phase `{ phaseName, recordCount, medianPriceOMR, medianPricePerSqmOMR, oldestRecordDate, latestRecordDate }`, but only for phases meeting the same `MIN_COMPARABLES` sample-size floor used elsewhere — a phase trend is never reported from an insufficient sample — capped to the busiest 10 phases. `available: false` (with every other field at its empty default) whenever the location is unsupported or the active provider has no genuine transaction-level record store for it (manual/demo mode, official statistics, the not-yet-integrated listing feed) — demo/benchmark data is never presented as real historical sales intelligence. `priceSemantics` reports only what the source data itself recorded (e.g. `"contracted_unit_price"`) — never `verified_conveyance_price`, `government_registered_transaction` or `final_title_transfer_price` unless the source genuinely supports that claim.

### Production Oman market data (database mode, import, caching)

By default (`OMAN_PROPERTY_DATA_MODE=manual`, or unset) `analyze_oman_property` uses only the bundled curated fixtures — no database is required to run or evaluate the capability. Production deployments instead populate a real PostgreSQL-backed data layer and switch modes:

- **`OMAN_PROPERTY_DATA_MODE=manual`** (default) — the curated `ManualDatasetProvider` fixtures only. No database connection is attempted.
- **`OMAN_PROPERTY_DATA_MODE=database`** — production records only, read through `DatabaseOmanPropertyDataProvider` (`domain/oman/dataProviders.ts`) from `PostgresPropertyMarketRepository` (`db/marketStore.ts`). Requires `OMAN_MARKET_DATABASE_URL` (or `DATABASE_URL`) to be set; the manual fixtures never contribute to an answer in this mode.
- **`OMAN_PROPERTY_DATA_MODE=composite`** — database records first, falling back to the manual fixtures only where the database has nothing to offer. Useful while a real feed is still being onboarded for some areas but not others.

**Schema and migrations:** `db/marketSchema.ts` defines `property_market_records` (governorate, wilayat, area, `normalizedArea`, propertyType, bedrooms, bathrooms, sizeSqm, transactionType, priceOMR, rentPeriod, furnished, sourceType, sourceName, sourceRecordId, sourceUrl, observedAt, ingestedAt, metadata JSONB), indexed on `normalizedArea`/propertyType/transactionType/bedrooms/sizeSqm/observedAt, plus a partial unique index on `(sourceName, sourceRecordId)` for records that carry a source record id. `PostgresPropertyMarketRepository.migrate()` applies this schema idempotently using its own migration ledger (`rafid_market_migrations`, advisory lock `74382002`) — entirely independent of the customer/billing store's migrations, so market-data schema changes never contend with or depend on customer data migrations. Records are upserted (`INSERT ... ON CONFLICT (source_name, source_record_id) DO UPDATE`) when a `sourceRecordId` is present, so re-importing the same feed is safe and idempotent; records with no `sourceRecordId` are always inserted fresh, since they cannot be safely deduplicated.

**Importing a dataset:**

```bash
npm run market:import -- ./data/example-oman-market-import.csv
```

This runs `PostgresPropertyMarketRepository.migrate()` (safe to run repeatedly) and then imports the file, printing a JSON summary of `{ totalRows, imported, updated, skipped, errors }`. Both CSV and JSON are accepted (`{ "records": [...] }` or a bare array); see `data/example-oman-market-import.csv` for the expected columns. Every row is validated against a strict schema (unknown columns are rejected outright), locations are normalized through the same English/Arabic area resolution `analyze_oman_property` itself uses, rent periods/furnished status/transaction type aliases are normalized, and text fields are sanitized — a malformed row is skipped and reported individually rather than aborting the whole import. Import is bounded (10 MB file size, 20,000 rows) and never executes anything found in the file; there is no web UI, only the CLI and the underlying `importMarketRecords()` service for programmatic use.

**Size validation is property-type-specific**, not one generic range: `SIZE_BOUNDS_BY_PROPERTY_TYPE` in `domain/oman/importPipeline.ts` — apartment 20-1500 sqm, townhouse 40-2000 sqm, villa 50-10,000 sqm — centralized in one place rather than a single bound tuned for a typical apartment (which previously rejected genuine ultra-luxury villas well over 3,000 sqm while being far looser than warranted for an apartment). Still finite in both directions per type: widening the villa band never means "accept anything."

**Caching:** an optional `ComparableCache` (`domain/oman/cache.ts`) can front repeated comparable lookups against the database — keyed by area, property type, bedrooms, a bucketed property size, furnished status and transaction type — with a configurable TTL (`OMAN_MARKET_CACHE_TTL_MS`, default disabled). The bundled `MemoryComparableCache` is process-local; the interface is deliberately not coupled to Redis so a distributed cache can be added later (e.g. a future `RedisComparableCache`) without touching `DatabaseOmanPropertyDataProvider` or any analysis logic.

**What stays the same regardless of mode:** comparable selection, outlier removal, confidence scoring and provenance labeling (`domain/oman/comparables.ts`/`confidence.ts`) are untouched by any of this — the database provider only retrieves a broader candidate pool (matching area, property type, transaction type and recency); every downstream decision about which candidates actually get used is made in the same place regardless of where the records came from.

### Partner Data Feed (authorized property-level data from real estate companies, brokers, property managers)

The Oman property intelligence engine (comparable selection, confidence scoring, official NCSI context) is complete on its own; this layer exists solely to make it easy — and safe — for a real estate company, brokerage or property manager in Oman to supply Rafid with authorized market data, instead of every production record coming only from a manually curated fixture or an operator hand-loading a file. **It is infrastructure, not an agent capability**: none of it is registered in `domain/capabilities.ts`, so none of it appears in `/agent.json`, `/api/v1/capabilities`, the MCP tool catalog, or the `x402` payment-gated route family — an agent calling `analyze_oman_property` has no way to reach or even discover these routes, and they carry no price. `analyze_oman_property`'s own request/response shape is completely unchanged by any of this.

**Partner model.** A `PropertyDataPartner` (`domain/oman/partners.ts`) is deliberately minimal — `partnerId` (a short slug, e.g. `gulf-realty-om`), `partnerName`, `feedType` (`csv` | `json` | `http_feed`), `sourceType` (almost always `partner_feed`), `enabled`, `dataLicenseReference`, `contactReference` (a free-text pointer — an email alias or contract number — never a person's name or phone number), and `createdAt`. It deliberately stores no personal data about individuals at the partner. `PartnerRepository` is the storage abstraction, exactly like `PropertyMarketRepository` — `MemoryPartnerRepository` for tests, `PostgresPartnerRepository` (`db/partnerStore.ts`) for production, sharing the same `Pool`/database as `PostgresPropertyMarketRepository` rather than opening a second connection pool.

**Authentication model — three distinct credentials, each scoped to what it's for:**

- **`X-API-Key`** (existing) — the normal customer credential for the four billed capabilities. Never accepted by the partner-feed routes.
- **`X-Partner-Token`** — a per-partner bearer token (`rafid_partner_<64 hex chars>`), generated once at `partner:create` time and returned to the operator exactly once; only its SHA-256 digest is ever stored (`data_partners.token_digest`), mirroring how `rafid_keys.digest` protects a customer API key. Authenticates the ingestion endpoint below as exactly one partner — a token can never act as, or see, another partner's data.
- **`X-Internal-Api-Key`** — a single shared secret (`MARKET_DATA_INTERNAL_API_KEY`) gating the two read-only internal endpoints below. Deliberately distinct from every partner token (a partner must never see cross-partner aggregate data) and from the customer API key. Unset means those routes always answer `503`, never silently open.

**Ingestion modes.** CSV file upload, JSON file/array upload, and an authenticated HTTP feed — all three go through the exact same `POST /api/v1/market-data/import` endpoint and the exact same validating pipeline (`domain/oman/importPipeline.ts`) the operator-run `market:import` CLI already used; there is no separate write path and no scraping of any kind.

**`POST /api/v1/market-data/import`** — never public. Requires `X-Partner-Token`. The request body is either:
- `Content-Type: text/csv` (or `text/plain`) with the CSV text as the body, in the exact column format below; or
- `Content-Type: application/json` with a bare JSON array of records, or `{ "records": [...] }`.

Response: `{ success: true, data: { partnerId, totalRows, imported, updated, skipped, rejected, averageDataQualityScore, rejections: [{ row, code, message }] } }`. A malformed row never aborts the batch — it is rejected individually with its 1-based row number, a stable error `code` (see **Rejection codes** below), and a safe `message`; your original row data is never echoed back. Two rows in the same batch sharing a `sourceRecordId` but differing in content are treated as a legitimate same-batch update (last one wins, exactly as before); two rows that are otherwise byte-identical are treated as a true duplicate — the earlier occurrence is rejected with code `DUPLICATE_RECORD` and only the later one is written.

**CSV format** (identical columns to `data/example-oman-market-import.csv`; see `data/example-partner-feed.csv` for a full fictional example):

```
governorate,wilayat,area,propertyType,bedrooms,bathrooms,sizeSqm,transactionType,priceOMR,rentPeriod,furnished,sourceType,sourceName,sourceRecordId,sourceUrl,observedAt,metadata
Muscat,Muscat,Al Mouj,apartment,2,2,135,rental,820,monthly,furnished,partner_feed,Gulf Realty Oman,GRO-2001,https://example-partner.test/units/2001,2026-08-01,"{""floor"": 6}"
```

**JSON format** (identical field names as the CSV header; see `data/example-partner-feed.json`):

```json
{ "records": [ {
  "governorate": "Muscat", "wilayat": "Muscat", "area": "Al Mouj", "propertyType": "apartment",
  "bedrooms": 2, "bathrooms": 2, "sizeSqm": 135, "transactionType": "rental", "priceOMR": 820,
  "rentPeriod": "monthly", "furnished": "furnished", "sourceType": "partner_feed",
  "sourceName": "Gulf Realty Oman", "sourceRecordId": "GRO-2001",
  "sourceUrl": "https://example-partner.test/units/2001", "observedAt": "2026-08-01",
  "metadata": { "floor": 6 }
} ] }
```

Required per row: `governorate`, `area` (must resolve to a supported Muscat area — English or Arabic spelling), `propertyType` (`apartment`/`villa`/`townhouse`), `sizeSqm`, `transactionType` (`rental`/`sale`), `priceOMR`, `rentPeriod` (required for `rental`, must be blank for `sale`), `sourceType`, `sourceName`, `observedAt`. Optional: `wilayat`, `bedrooms`, `bathrooms`, `furnished`, `sourceRecordId`, `sourceUrl`, `metadata` (a small JSON object). **Never include a `partnerId` column** — the row schema is strict and rejects unrecognized columns outright, so a file cannot even attempt to claim a partner identity; attribution comes only from the authenticated `X-Partner-Token` (or, for a CLI-run bulk import, an explicit operator-supplied partner id) and silently overwrites whatever `sourceType`/`sourceName` the row itself claims. This is deliberate: a partner's own file can never spoof another partner's identity or claim a provenance (e.g. `official_statistics`) it hasn't earned. `sourceType`/`sourceName` are still required columns for schema validation to pass — fill them with your own values (typically `sourceType=partner_feed`, `sourceName=<your company name>`) even though the server overwrites them, so the file is self-consistent if inspected on its own.

**Validation — "reject impossible or suspicious values", not just malformed ones.** Beyond type/enum checks, application-level bounds (tighter than the database's own wide CHECK constraints, which remain a last-resort safety net): `sizeSqm` between 10 and 3,000; a sale `priceOMR` between 3,000 and 20,000,000 OMR; a rental's *monthly-equivalent* price (annual rents divided by 12 first) between 30 and 15,000 OMR; `observedAt` no more than a day in the future and not before the year 2000. A row failing any of these is rejected individually, with a plain-English reason, exactly like a malformed or unrecognized-area row.

**Deduplication strategy.** Idempotent upsert on `(sourceName, sourceRecordId)` — the same partial unique index and `INSERT ... ON CONFLICT ... DO UPDATE` the base import pipeline already used. Because `sourceName` is always forced to the authenticated partner's own name, this is effectively `(partnerId, sourceRecordId)` in practice: re-sending the same `sourceRecordId` (whether in a later request or twice within the same batch) updates the existing record rather than duplicating it. A row with no `sourceRecordId` can never be safely matched against a prior import and is always inserted as new — exactly as documented for the base pipeline.

**Data-quality scoring — deterministic, never an LLM.** Every accepted record gets a `dataQualityScore` in `[0, 1]` (`domain/oman/dataQualityScore.ts`), a fixed weighted sum computed the same way every time: completeness of optional fields — bedrooms/bathrooms/furnished/sourceUrl/metadata (30%), size plausibility (15%), price plausibility (20%), freshness — linear decay to 0 at a two-year-old record (20%), and source identity — 1.0 for an authenticated partner or official statistics, 0.7 for the manual benchmark, 0.5 for an unattributed listing (15%). The import response's `averageDataQualityScore` is the batch mean; the CLI and HTTP paths both compute and store it identically.

**Partner-feed statistics.** `data_partners` tracks `recordsReceived`/`recordsAccepted`/`recordsRejected`/`recordsUpdated`/`latestObservationDate` per partner, updated after every import (HTTP or CLI) — see **Partner Operations layer** below for the full monitoring/health/audit surface built on top of this.

**`GET /api/v1/internal/market-data/status`** (X-Internal-Api-Key) returns exactly:

```json
{ "records": 1250, "rentalRecords": 740, "saleRecords": 510, "areas": 8, "partners": 3, "latestDataDate": "2026-08-05T00:00:00.000Z", "sourceTypes": ["partner_feed", "listing_asking_price", "official_statistics"] }
```

Cross-partner aggregates only — no individual partner's token, digest, statistics or identity is ever exposed here (that detail lives behind `.../partners`, gated by the same key).

**Provenance.** `analyze_oman_property`'s existing `provenance`/`dataQuality.sourceTypes` grouping (unchanged code — `services/omanProperty.ts`) already distinguishes `partner_feed` from `official_statistics`, `manual_benchmark` and `listing_asking_price` by `(sourceType, sourceName)`, because `sourceType`/`sourceName` were already part of every `MarketRecord`; this layer only had to make sure partner-ingested records are honestly attributed at write time, which the forced server-side attribution above guarantees.

**Onboarding the first Oman real-estate data partner — quick version** (the full, actionable checklist is [`docs/FIRST_PARTNER_ONBOARDING.md`](docs/FIRST_PARTNER_ONBOARDING.md)):

1. Agree a data license/contact reference with the partner out of band (a signed data-sharing agreement, a contract number) — this becomes `dataLicenseReference`/`contactReference`, never a person's name or phone number.
2. Issue the partner's credentials from the operator's own machine (never over chat/email in plaintext beyond the initial handoff):
   ```bash
   npm run admin -- partner:create gulf-realty-om "Gulf Realty Oman" csv partner_feed "Data License #2026-014" "partnerships@example.com"
   ```
   This prints the new partner record **and the bearer token exactly once** — store it in the partner's secrets manager immediately; it cannot be retrieved again (rotate it — see **Token rotation** below — if it's ever compromised).
3. Generate the partner's onboarding package and deliver it (see **Onboarding package** below) — it explains the endpoint, header, formats and rules without ever including the real token.
4. The partner either calls the endpoint directly from their own systems (the `http_feed` `feedType`), or hands Rafid a file for an operator-run bulk import attributed to them:
   ```bash
   npm run market:import -- ./gulf-realty-export.csv gulf-realty-om
   ```
5. Monitor onboarding with `GET /api/v1/internal/market-data/status` (aggregate), `GET /api/v1/internal/market-data/partners` (per-partner health) and `GET /api/v1/internal/market-data/partners/:partnerId/quality` (data-quality summary), all behind `MARKET_DATA_INTERNAL_API_KEY`.
6. To pause a partner without losing its history, `npm run admin -- partner:disable gulf-realty-om` (its token immediately stops authenticating); `partner:enable` resumes it.

**Testing.** `tests/partner-feed.test.ts` covers partner authentication (valid/unknown/disabled/rotated tokens), CSV ingestion, JSON ingestion (array and `{records:[...]}` forms), idempotent upsert (across requests, within one batch, and true in-batch duplicates), invalid/rejected rows and their codes, the deterministic data-quality score and per-partner quality summary, partner provenance flowing into `analyze_oman_property`, stale-partner detection (including that one stale partner never marks another partner or the market stale), unauthorized-import rejection, token rotation, onboarding-package generation, the ingestion audit log, and the exact `/api/v1/internal/market-data/status`/`.../partners` response shapes — all against in-memory repositories, plus an opt-in PostgreSQL integration test (gated behind `TEST_DATABASE_URL`, matching `tests/market-data.test.ts`'s pattern) covering the migration schema, `PostgresPartnerRepository`/`PostgresPartnerIngestionAuditRepository`, and the `admin`/`market:import` CLI commands against a live database. `npm run test:partner-e2e` (`scripts/partner-e2e.ts`) is a standalone, self-contained end-to-end rehearsal of the entire first-partner flow — create, issue token, ingest, re-ingest (idempotency), check health, run `analyze_oman_property`, disable, verify ingestion is then rejected — using only in-memory repositories, so it needs no database or production secrets and can run in CI.

### Partner Operations layer (onboarding package, token rotation, ingestion audit, health monitoring, staleness policy)

Built directly on top of the Partner Data Feed layer above, to make onboarding and operating a real partner safe and practical without adding any new public capability, dashboard, or scraping. Every piece here is either the existing internal-key-gated JSON routes, or an operator-run CLI command — nothing is registered in `domain/capabilities.ts`.

**Onboarding package.** `npm run admin -- partner:package <partnerId> [baseUrl]` (`domain/oman/partnerPackage.ts`) writes `partner-packages/<partnerId>/{README.md, sample.csv, sample.json, schema.json, curl-example.txt}` (git-ignored) — a complete, self-contained explanation of the endpoint, required header, CSV/JSON formats, field meanings, allowed property/transaction types, `rentPeriod`/`observedAt` rules, max batch size, rejection codes, and retry/idempotency behavior. **Never contains the partner's real token** — every example uses a `<PARTNER_TOKEN>` placeholder; deliver the real token separately, through a channel appropriate for a credential.

**Token rotation.** `npm run admin -- partner:rotate-token <partnerId>` invalidates the current token immediately (a single `UPDATE ... SET token_digest` — no window where both the old and new token work), issues exactly one new token, prints it once, and records a `token_rotated` event in `data_partner_audit_log` (also recorded for `created`/`enabled`/`disabled`).

**Ingestion audit log.** `partner_ingestion_audit` (`db/partnerOpsSchema.ts`, migration v3; `domain/oman/partnerAudit.ts`'s `PartnerIngestionAuditRepository`) records exactly one row per ingestion **attempt** that reaches an authenticated partner — success or failure: `id, partnerId, requestId, receivedAt, recordsReceived, recordsAccepted, recordsRejected, recordsUpdated, httpStatus, durationMs, errorCode`. It **never** stores the partner's token, the raw request body, or any individual record's fields — the row shape has no room for any of those. This is what powers the windowed figures in the health endpoint below without ever re-reading anything sensitive.

**Partner health.** `GET /api/v1/internal/market-data/partners` (X-Internal-Api-Key) now returns, per partner:

```json
{ "partnerId": "gulf-realty-om", "partnerName": "Gulf Realty Oman", "enabled": true, "feedType": "csv",
  "latestIngestionAt": "2026-09-20T08:12:03.000Z", "latestObservationDate": "2026-09-18T00:00:00.000Z",
  "recordsAcceptedLast24h": 42, "recordsAcceptedLast7d": 310, "rejectionRateLast7d": 1.3,
  "stale": false, "staleDays": 7 }
```

`latestIngestionAt` (most recent ingestion *attempt*, from the audit log) is deliberately distinct from `latestObservationDate` (freshest *accepted* record's `observedAt`, from `PartnerFeedStats` as before) — a partner can have a very recent `latestIngestionAt` while every attempt was rejected, which is exactly what an operator needs to see. Never exposes a token, digest, contact detail, or license reference.

**Staleness policy.** `PARTNER_FEED_STALE_DAYS` (default **7**; replaces the prior phase's `MARKET_PARTNER_STALE_DAYS`, default 30) — a partner is stale once no *accepted* fresh observation has arrived within the threshold. **Staleness is always per-partner** — one partner going stale never marks any other partner, or the market as a whole, stale; it never gates ingestion or `analyze_oman_property` either.

**Rejection codes.** Every rejected row's `code` is one of: `INVALID_FORMAT`, `INVALID_AREA`, `INVALID_PROPERTY_TYPE`, `INVALID_TRANSACTION_TYPE`, `INVALID_SIZE`, `INVALID_PRICE`, `INVALID_BEDROOMS`, `INVALID_BATHROOMS`, `INVALID_RENT_PERIOD`, `INVALID_FURNISHED`, `INVALID_SOURCE_TYPE`, `INVALID_SOURCE_NAME`, `INVALID_URL`, `INVALID_DATE`, `INVALID_METADATA`, `DUPLICATE_RECORD`. The accompanying `message` is a safe, human-readable summary — the rejected row's original values are never echoed back.

**Data-quality summary.** `GET /api/v1/internal/market-data/partners/:partnerId/quality` (X-Internal-Api-Key) returns `{ partnerId, recordCount, averageDataQualityScore, percentageAbove80, percentageBelow50, missingBedroomRate, missingBathroomRate, missingFurnishedRate }`, computed with database-side aggregation (a single `SELECT ... count(*) FILTER (WHERE ...)` query in `PostgresPropertyMarketRepository.getPartnerQualitySummary()`) rather than reading every record into memory.

**Security.** The internal API key is compared with `timingSafeEqual` (unchanged from the prior phase); partner-token authentication is a SHA-256 digest lookup, never a raw-token comparison, so the value that would need to be timing-attacked is already a cryptographic digest, not the secret itself. Disabled partners fail `X-Partner-Token` auth immediately (already tested); a rotated-away token fails immediately too (new tests). Neither the internal API key nor any partner token, nor any raw ingested payload, is ever logged — the request logger records only the matched route template, status and duration — and the ingestion audit table's row shape structurally excludes all three.

**First partner checklist.** See [`docs/FIRST_PARTNER_ONBOARDING.md`](docs/FIRST_PARTNER_ONBOARDING.md) for the full, step-by-step operational checklist: agree data rights, create the partner, generate the onboarding package, securely deliver the token, send a test batch, verify accepted/rejected records and provenance, confirm `analyze_oman_property` surfaces `partner_feed` (and no demo-data flag when only partner data contributes), monitor the first 24 hours, then enable the partner's production schedule.

### Production Feed Runner (scheduled HTTPS JSON/CSV ingestion — no scraping, no new public capability)

Built directly on top of the Partner Operations layer above, so the *first* real Oman partner feed can run on a schedule instead of a human pushing files by hand. Like everything else in the Partner Data Feed/Operations layers, this is infrastructure — `domain/oman/partnerFeedRunner.ts`, its CLI entry points, and its own database columns/table are never registered in `domain/capabilities.ts` and never appear in `/agent.json`, the tool catalog, remote MCP, or the x402 route family. It never touches `analyze_oman_property` itself, x402 pricing, or any other public capability.

**Feed configuration model.** Six new, all-optional columns on `data_partners` (migration v4, `db/partnerFeedSchema.ts`): `feedUrl`, `feedFormat` (`"json" | "csv"`), `scheduleEnabled`, `scheduleIntervalMinutes`, `lastSuccessfulRunAt`, `lastAttemptAt`, plus `consecutiveFailures`. Every partner created before this migration simply has no schedule configured — nothing to backfill. Set with `npm run admin -- partner:set-feed <partnerId> <feedUrl> <json|csv> <true|false> [intervalMinutes]` — a full replace of the schedule config each time (mirrors `setEnabled()`'s "one explicit value" simplicity), never a partial patch.

**Security model (credentials).** Feed authentication is **never** stored on `PropertyDataPartner` itself. A separate table, `partner_feed_credentials` (also migration v4; one row per partner: `authType` — `bearer | api_key_header | none` — plus `secretRef` and `headerName`), stores only a credential's *shape*. `secretRef` is a **reference** — an environment variable *name* — never a secret value; the actual value is resolved only at fetch time, in memory, for the duration of one outbound request, via an injectable `SecretProvider` abstraction (`domain/oman/partnerFeedCredentials.ts`). The bundled `EnvSecretProvider` reads `process.env[secretRef]`; a future deployment can swap in a real secrets-manager-backed provider without touching the feed runner or the credential schema. Set with `npm run admin -- partner:set-feed-credential <partnerId> <bearer|api_key_header|none> [secretEnvVarName] [headerName]` — the secret's actual value is never an argument to this command, only the name of the environment variable holding it.

**SSRF controls.** Every feed URL — and every redirect target, independently re-validated before being followed, never blindly trusted — must pass `domain/oman/feedSecurity.ts`'s `validateFeedUrl()`: HTTPS-only by default (a test/dev-only `allowInsecureHttp` escape hatch exists but is never partner-influenced), rejects `localhost`/`*.localhost`/`0.0.0.0`, rejects private/loopback/link-local/reserved IPv4 and IPv6 ranges (checked both as a literal address and via DNS resolution of a hostname, through an injectable `HostResolver` so this is fully unit-testable without real DNS), and supports an optional exact-hostname allowlist. `domain/oman/safeFeedFetch.ts` layers the actual bounded HTTP GET on top: a timeout (`AbortController`), a streamed response-size cap (aborts mid-download rather than buffering an oversized body), and manual (`redirect: "manual"`) redirect handling so a redirect to a different, unsafe host can never be followed silently.

**Retry policy.** `domain/oman/feedRetry.ts` retries **only**: a network/connection error, a request timeout, or an HTTP 502/503/504 — bounded exponential backoff (200ms, 400ms, 800ms, capped at 4s), **maximum 3 attempts total**. A 400, 401, 403, 404, or any validation/parse failure is **never** retried — repeating an already-wrong request would only fail identically.

**Scheduling model.** `computeNextDueAt()`/`isFeedDue()`/`computeFeedHealth()` (`domain/oman/partners.ts`) are pure, stateless functions shared by both the scheduling pass and the health endpoint, so "which partner is due" and "what does the health endpoint report" can never disagree. A partner that has never been attempted is due immediately, not after waiting a full interval from "now".

**CLI commands.**
- `npm run partner:feeds` — one scheduling **pass**: identifies every enabled, due partner, runs each safely, prints a safe JSON summary (`{"attempted": N, "successful": N, "failed": N, "results": [...] }`), and exits. **Never an always-running process** — intended for an external scheduler (Vercel Cron, a GitHub Actions `schedule:` trigger, Windows Task Scheduler, plain cron).
- `npm run admin -- partner:run-feed <partnerId>` — a single, on-demand run, for testing a partner before enabling its schedule. Prints only `{partner, httpStatus, recordsReceived, recordsAccepted, recordsRejected, recordsUpdated, durationMs, auditId, ok, errorCode}` — **never** the resolved credential header or a raw record.
- `npm run admin -- partner:set-feed` / `partner:set-feed-credential` — see above.

**Failure isolation (Section 7).** `PartnerFeedRunner.runDueFeeds()` wraps each partner's run in its own try/catch — one partner's failure (however it fails) can never abort the loop or affect any other partner's run. Returns `{attempted, successful, failed, results}`.

**Data safety.** The feed runner calls the exact same `importMarketRecords()` every other ingestion path (the manual HTTP endpoint, `market:import`) already uses — **never a duplicated or parallel validation/upsert implementation**. Existing idempotent upsert rules, rejection codes, and the narrow `DUPLICATE_RECORD` semantics are entirely unchanged. A rejected batch never deletes existing records; raw partner data is never logged; credentials are redacted everywhere by construction (there is structurally no code path that stores or logs a secret value).

**Feed health fields.** `GET /api/v1/internal/market-data/partners` now additionally returns, per partner: `lastFeedAttemptAt`, `lastFeedSuccessAt`, `consecutiveFailures`, `nextDueAt`, and `feedHealth` (`"healthy" | "degraded" | "stale"` — `consecutiveFailures >= 3` → `"degraded"`, checked first; else the existing per-partner `stale` flag → `"stale"`; else `"healthy"`). Every existing Partner Operations field on this endpoint is unchanged. A partner's feed health never affects any other partner, or `analyze_oman_property`'s availability globally.

**Observability.** Every completed run (success or failure) emits one structured JSON log line: `{partnerId, requestId, attempt, status, httpStatus, durationMs, recordsReceived, recordsAccepted, recordsRejected}` — no raw records, no tokens, no auth headers; every field is safe by construction, with nothing left to redact.

**Tests.** `tests/partner-feed-runner.test.ts` covers, entirely with mock HTTP (an injected `fetchImpl` and `HostResolver` — no real network or DNS): a successful JSON feed, a successful CSV feed, an HTTP timeout, HTTP 503 retried to success and retried to exhaustion (exactly `maxAttempts` calls, never more), HTTP 401 never retried (exactly one call), an oversized response, an unexpected content type, a malformed body, SSRF rejection of `localhost`, SSRF rejection of a hostname that resolves to a private IP, a redirect to a blocked host never followed, partner isolation in `runDueFeeds()`, idempotent re-fetch (no duplicate records), one audit row per attempt with a safe field set, `consecutiveFailures`/`feedHealth` transitions (including reset to 0 on the next success), secret redaction (a fake secret is sent to the mock feed endpoint but never appears in the outcome, logs, or audit rows), a misconfigured credential, and the three operator-misconfiguration guard cases (partner not found / disabled / unconfigured) that throw rather than recording a silent audit failure.

**First live partner runbook.** See [`docs/FIRST_LIVE_PARTNER_RUNBOOK.md`](docs/FIRST_LIVE_PARTNER_RUNBOOK.md) for the full, step-by-step checklist: create the partner, generate the token/package, agree the feed URL/auth with the partner, configure the secret, test with `partner:run-feed`, inspect the audit log and data quality, verify provenance, run `analyze_oman_property`, verify no demo flag, enable the schedule, and monitor the first 24 hours.

### Official market context (NCSI)

`analyze_oman_property`'s response includes an `officialMarketContext` object sourced from Oman's National Centre for Statistics and Information (NCSI) Open Data Portal API — the first, and so far only, live external network integration this capability makes. It is deliberately **not** another comparable data source: NCSI publishes governorate-level aggregate statistics (a price index, traded value, contract counts), never individual listing or transaction records, so this integration never feeds NCSI data into `comparablesSummary`, `market`, `pricePosition` or the comparable-based `confidence` score — those remain exactly as documented above, unaffected by whether NCSI is configured at all. `officialMarketContext` carries its own, separate `confidence` (`unavailable`/`low`/`medium`/`high`) so an agent can't mistake "official statistics exist" for "the comparable estimate is more trustworthy."

**Rafid does not scrape NCSI or any other property/statistics website.** This integration calls NCSI's own documented REST API (`services/ncsi/ncsiClient.ts`) — the "Explore Api" served from `map.ncsi.gov.om/ODPAPI` — nothing else. NCSI's data is published under the Open Government License – Sultanate of Oman, which supports API/web-service reuse; this integration only reads NCSI's own published aggregate statistics and always attributes them back to NCSI (`officialMarketContext.provenance.source`/`license`) — Rafid claims no ownership of NCSI's data.

**What was actually verified live, and what wasn't (read before configuring this):** before writing `NcsiClient`, the live API was inspected directly rather than guessed at. Its OpenAPI/Swagger document (`https://map.ncsi.gov.om/ODPAPI/swagger/v1/swagger.json`) was successfully retrieved and confirms a real, working "Explore Api" v1 with no authentication required and exactly the endpoints this client implements: `GET /catalog/datasets` (list), `GET /catalog/datasets/{id}` (metadata), `GET /catalog/datasets/{id}/records` (query, with `Select`/`Where`/`order_by`/`offset`/`limit`/`language` parameters), and `GET /catalog/datasets/{id}/download`. However, every attempt to actually *call* the catalog-listing or records endpoints during development returned **HTTP 500** — including a request for a deliberately nonexistent dataset id, which a healthy API would 404 on rather than 500 — indicating the live backend was temporarily broken at the time, not that a parameter or dataset id was missing. `api.ncsi.gov.om` (the second URL commonly referenced for this API) serves only a bare Swagger UI shell with no working spec or data routes found at any standard path. Because of this, **no real dataset id and no real record field names could be verified against live data**, and none are hardcoded anywhere in this codebase as a result.

**Configuration is therefore intentionally inert until an operator verifies it:**

1. Run `npm run ncsi:discover` (retries the live catalog and filters titles/descriptions for real-estate keywords — English and Arabic). If NCSI's catalog backend is healthy when you run it, it prints candidate dataset ids/titles; if it 500s the way it did during development, it says so plainly rather than pretending to have found something.
2. Once you have a confirmed dataset id, inspect a real response from `GET /catalog/datasets/{id}/records` (via the discovery output, `curl`, or NCSI support) to find the actual field names for governorate, period, price index, traded value, and sale/mortgage contract counts.
3. Set `NCSI_REAL_ESTATE_DATASET_ID` to that id, and `NCSI_FIELD_MAP_JSON` to a JSON object mapping this capability's concepts to those exact field names, e.g.:
   ```bash
   NCSI_REAL_ESTATE_DATASET_ID=real-estate-price-index
   NCSI_FIELD_MAP_JSON={"governorate":"GOVERNORATE_EN","period":"PERIOD","priceIndexValue":"PRICE_INDEX","tradedValueOMR":"TRADED_VALUE","saleContracts":"SALE_CONTRACTS","mortgageContracts":"MORTGAGE_CONTRACTS","publishedAt":"LAST_UPDATED"}
   ```
   Only `governorate` is required; any concept you omit from the map is reported as `null` in the response rather than guessed — "Only populate fields actually supported by retrieved data" is enforced structurally, not by convention.

Until both are set, `officialMarketContext.available` is always `false` with `reason: "ncsi_not_configured"` and no network call is attempted at all — this is the example output shown in `/openapi.json` and the MCP tool catalog today.

**Failure behavior:** a timeout, a 5xx, a malformed response, or no record matching the requested governorate all resolve to `officialMarketContext.available: false` with a specific `reason` (`ncsi_timeout` / `official_source_temporarily_unavailable` / `ncsi_malformed_response` / `no_data_for_governorate`) — never a fabricated fallback figure, and never a failed `analyze_oman_property` call as a whole; the comparable-based analysis always completes independently (see `tests/ncsi.test.ts`'s "an NCSI outage does not prevent the comparable analysis from completing").

**Caching:** a successful lookup is cached per governorate (`domain/oman/officialContextCache.ts`'s `MemoryOfficialMarketContextCache`) for `NCSI_CACHE_TTL_MS` (default 6 hours, since official statistics are published quarterly/annually, not continuously) — a failed lookup is never cached, so the next call retries NCSI rather than pinning "unavailable" for the full TTL.

**Testing:** `tests/ncsi.test.ts` covers catalog/record parsing against a mocked HTTP layer (an injectable `fetchImpl`, never the network), field-map-driven parsing (missing metrics, stale records), every failure mode (timeout/5xx/4xx/malformed response), cache hit/expiry/no-cache-on-failure, and full-pipeline integration (NCSI down vs. healthy, zero-record dataset, the early-return unsupported-area path) — none of it depends on live NCSI availability. A separate, opt-in `npm run test:ncsi-live` (gated behind `NCSI_LIVE_TEST=1` in `.env`, exactly like `test:db` is gated behind a live database) smoke-tests the real API when you want to re-verify it.

**Known limitation:** because the live catalog could not be queried successfully during development, this integration has not yet been exercised against a single real NCSI record — everything above is verified against the *documented contract* and mocked responses, not a live payload. Re-running `npm run ncsi:discover` and `npm run test:ncsi-live` once NCSI's backend is healthy (or once you have a dataset id/field list from NCSI directly) is the remaining step before this integration is proven end-to-end against real data.

### Pay-per-call via x402 (no API key)

`GET /api/v1/x402` is always available, regardless of `X402_ENABLED`, and returns the protocol, scheme, whether payments are currently accepted, the network/receiving address (only when enabled — never a secret, just the public address), the facilitator in use, and per-tool price/endpoint. An agent can read this before deciding whether to pay, with no side effects.

`GET /api/v1/x402/status` is a smaller, always-on companion endpoint whose only job is to state the runtime facts plainly, so nothing has to be inferred from this README or the landing page's copy: `{ enabled, mode, network, asset, facilitator, walletConfigured, paymentEnforcement }`. `mode` is `"disabled"`, `"testnet"` (Base Sepolia — the public facilitator settles it, but no real value moves), or `"production"` (any other configured network, where a verified payment is a real on-chain transfer). `enabled` and `paymentEnforcement` are the same value by construction: this app only ever mounts the real `@x402/express` payment gate when `X402_ENABLED=true`, and `loadConfig()` fails startup closed if that gate's required configuration is missing or invalid — there is no state where the app is running with `X402_ENABLED=true` but the gate isn't actually enforcing. Never includes a secret.

When `X402_ENABLED=true`, the same four capabilities are also available, unauthenticated, under `/api/v1/x402/...`:

| Method | Endpoint | Price |
|---|---|---|
| POST | /api/v1/x402/property/analyze | $0.01 |
| POST | /api/v1/x402/property/compare | $0.03 |
| POST | /api/v1/x402/maintenance/estimate | $0.02 |
| POST | /api/v1/x402/oman/property/analyze | $0.25 |

These routes accept the same JSON request/response bodies as their authenticated counterparts above, but skip the `X-API-Key` header entirely. Authorization is a valid on-chain payment instead: a request with no `X-PAYMENT` header (or an invalid/insufficient one) receives an HTTP 402 response. Per the x402 v2 protocol, the accepted payment options (`accepts`, prices, network) are carried in a base64-encoded JSON `PAYMENT-REQUIRED` response header, not the JSON body (the body is intentionally `{}`); decode that header (`JSON.parse(Buffer.from(header, "base64").toString())`) to read it. An x402-aware HTTP client does this automatically: it attaches a valid `X-PAYMENT` header for the quoted amount and network, and the request then proceeds normally. The price quoted always comes from `BillingService.getToolPrice()`, i.e. the same catalog `/api/v1/pricing` reads — the x402 gate cannot drift from the advertised price.

Payments settle in USDC on the network set by `X402_NETWORK` (default: Base Sepolia testnet, `eip155:84532`). By default, verification/settlement goes through the public facilitator at `X402_FACILITATOR_URL` (`https://x402.org/facilitator`, no account needed) -- but that free facilitator only settles Base Sepolia for EVM "exact" payments. To use any other network, including Base mainnet (`eip155:8453`), set both `CDP_API_KEY_ID` and `CDP_API_KEY_SECRET` (from a free [Coinbase Developer Platform](https://portal.cdp.coinbase.com) account, under API Keys — an Ed25519 Secret API Key, whose downloaded JSON file has `id`/`privateKey` fields that map to `CDP_API_KEY_ID`/`CDP_API_KEY_SECRET`): when both are set, the server authenticates to CDP's facilitator (`https://api.cdp.coinbase.com/platform/v2/x402`) instead, via the official `@coinbase/x402` package, and `X402_FACILITATOR_URL` is ignored. Startup fails fast with a clear error if `X402_NETWORK` is anything but `eip155:84532` and the CDP variables are not both set, rather than accepting payment requests it cannot actually settle. `X402_WALLET_ADDRESS` is the receiving wallet and must be set to an address you control before enabling this in production; the testnet default network is safe for development but moves no real money. These routes are entirely separate from the API-key/PostgreSQL customer system: no customer account, quota or usage record is created or consulted for x402 calls (though every call, on either route family, is still recorded through `UsageRepository` — see below). Disabling `X402_ENABLED` removes the routes entirely: they 404, and they are omitted from `/openapi.json` and the `/` discovery response — normal API-key calls are completely unaffected by this flag either way.

**Current production status — stated precisely rather than as a blanket "live":** the payment *gate* is real and operating on Base mainnet (`eip155:8453`) via the Coinbase CDP facilitator — production has returned a genuine HTTP 402 with correct terms (`payTo` matching the configured `X402_WALLET_ADDRESS`, network `eip155:8453`, price matching the catalog), which is only possible if the real `@x402/express` middleware is mounted, configured, and actually talking to the real facilitator. What has **not** yet been exercised in production is a *completed* mainnet payment settling all the way through to a tool executing — that would require sending real USDC. Base Sepolia testnet, where no real value moves, has been exercised fully end-to-end (a real funded test wallet completing a real payment against the public facilitator). Until a real mainnet payment has actually been completed and observed, the landing page deliberately says "x402 ready" rather than "live" for this reason, and `GET /api/v1/x402/status` is the authoritative place to check the current enforcement state rather than trusting any prose (this README included). There is no automated CI coverage for either live payment flow (the live tests are opt-in: `RUN_X402_LIVE_TESTS=true npm test`, which requires real internet access to the facilitator).

## MCP usage

MCP is one of Rafid's two primary agent interfaces (alongside x402), not an afterthought bolted onto the REST API. The installed MCP SDK v2 is retained; see the [official SDK documentation](https://ts.sdk.modelcontextprotocol.io/v2/). Two transports are available, and both are built by the exact same `createMcpServer()` factory (`src/mcp/server.ts`) reading the exact same `capabilities` registry — there is no second tool registry, schema set, description set, or `execute()` path to keep in sync by hand:

- **Local stdio** — build first, then run `npm.cmd run mcp` for a manual local process.
- **Remote Streamable HTTP** — `POST /mcp` on the deployed server, mounted whenever `MCP_REMOTE_ENABLED=true` (the default). Stateless (`sessionIdGenerator: undefined`): required, not just simpler, since a serverless deployment (Vercel) can route consecutive requests to different warm instances with no shared memory, so no server-side session state can be relied on. `GET /api/v1/mcp/status` always reports which transports are actually live: `{ enabled, transport: ["stdio","http"], tools: 4, endpoint: "/mcp" }` (or `endpoint: null`/`transport: ["stdio"]` when remote is disabled).

For local stdio, launch Node directly so npm banners cannot contaminate protocol stdout:

```json
{
  "mcpServers": {
    "rafid": {
      "command": "node",
      "args": ["C:/Projects/rafid-agent-api/dist/mcp.js"],
      "env": { "LOG_LEVEL": "info", "X402_ENABLED": "false" }
    }
  }
}
```

Use your own absolute project path. For remote Streamable HTTP, point an MCP client at the deployed URL instead of a local command, for example:

```json
{
  "mcpServers": {
    "rafid": { "url": "https://api.rafidsystem.com/mcp" }
  }
}
```

Or drive it directly with JSON-RPC 2.0 over HTTP:

```bash
curl -s https://api.rafidsystem.com/mcp \
  -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"analyze_property","arguments":{"propertyValue":85000,"annualRent":7200,"serviceCharge":650,"maintenanceCost":400}}}'
```

Tools on both transports: `analyze_property`, `compare_properties`, `estimate_maintenance`, `analyze_oman_property`. Tool results include JSON text and `structuredContent`, with strict input/output schemas, validation errors and read-only annotations; each tool's MCP `description` is its registry `description` plus its `whenToUse` recommendation sentence, verbatim — never a second copy of that prose. Custom cross-field constraints (alias exclusivity, unique names) are enforced at runtime, and every error on either transport goes through the same `publicError()` sanitizer as REST, so an internal failure never leaks internals remotely any more than it does locally.

MCP and REST are not two implementations that happen to agree: all three (stdio, remote MCP, REST) call the exact same `capabilities` catalog (`src/domain/capabilities.ts`) and the exact same `services/property.ts` functions, so a formula or price change made in one place is correct everywhere, and there is nothing to keep in sync by hand.

Stdio is local to the launching OS user; REST API keys are not an authentication mechanism for stdio, and stdio calls remain deliberately unmetered — an MCP client's own OS user launched that process directly, with no shared server resource to protect. Remote MCP is different: it is a shared, public server resource, so every remote tool call is recorded through the same `UsageRepository` as REST/x402 calls (`accessMode: "mcp-remote"`, `billableAmount: 0` — remote MCP is not a paid channel in this phase) and is protected by the same rate limiting as the other public agent endpoints (see "Security, observability and billing boundary" below). Logs go to stderr on both transports; stdout is reserved for MCP stdio framing. Remote auth (beyond rate limiting) is not implemented yet — see "Next five production priorities" below.

## Security, observability and billing boundary

API-key middleware compares SHA-256 digests with constant-time comparisons. Keys come from PostgreSQL in postgres mode and from configuration in legacy development mode. Request logs contain only generated request ID, matched route template/tool name, status, timestamp and duration; bodies, headers, query strings, raw API keys and unknown URL paths are not logged. Internal exceptions return a generic message. Every response — success or error — carries a `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` and `Referrer-Policy: no-referrer` header, plus a permissive-but-safe CORS policy (`Access-Control-Allow-Origin: *`) that is safe here because every route authorizes itself with a request header (`X-API-Key` or `X-PAYMENT`) rather than an ambient browser cookie or session — there is no credentialed state a cross-origin page could ride on. Request bodies are capped at 32kb (`413 PAYLOAD_TOO_LARGE`) before parsing.

`createApp` accepts an injectable `rateLimiter` middleware after authentication and before body parsing, for authenticated PostgreSQL-mode customer traffic. Separately, `middleware/rateLimit.ts`'s `createRateLimiter()` protects the *public, unauthenticated* agent endpoints — discovery (`/`, `/agent.json`, the `.well-known` manifests, `/llms.txt`, `/api/v1/agent`, `/api/v1/pricing`, `/api/v1/tools`, `/api/v1/capabilities`, `/api/v1/mcp/status`), the whole `/api/v1/x402/...` family, and remote MCP (`/mcp`) — each as its own independent, IP-keyed, fixed-window budget (`RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX`, both configurable; `RATE_LIMIT_ENABLED=false` to disable for local development). This is an honest, per-process, in-memory default, not a distributed limiter: on a serverless platform running several concurrent instances (Vercel), each instance enforces the limit independently, so the effective ceiling across a whole deployment can exceed `RATE_LIMIT_MAX` under traffic spread across instances — a production deployment expecting many concurrent instances should swap in a shared-store limiter (e.g. Upstash Redis) behind the same `RequestHandler` shape; nothing else in this app needs to change to do that. Proxy trust is not enabled. Deploy behind HTTPS; do not publicly expose the MVP without these controls.

The isolated billing catalog (`billing/catalog.ts`) has indicative USD prices: analysis $0.01, comparison $0.03, maintenance $0.02, Oman property analysis $0.25. It is the single source of truth: `BillingService` (`billing/service.ts`) is the only code that reads it, and every other module — route handlers, the x402 gate, the agent/pricing/tools endpoints — asks `BillingService` for a price rather than reading the catalog or a literal directly. REST calls the injectable `BillingGate.authorize` after validation and before calculation; its default implementation does nothing and must not be interpreted as billing. This seam allows future credit or usage-billing adapters without changing calculation services. PostgreSQL mode supplies a durable customer UUID; env-key mode retains a configuration-local identity. Stdio remains unmetered local execution.

Every capability call — API-key, x402, or remote MCP — and regardless of outcome (success, validation failure, auth failure, rate limit), is recorded through a `UsageRepository` (`billing/usage.ts`): request ID, a redacted identifier (the existing customer ID, an `x402:<network>` tag, or `mcp-remote` — never a raw API key, wallet secret, or payment proof/signature), tool name, `accessMode` (`"api-key"` / `"x402"` / `"mcp-remote"`), status, duration, billable amount and currency. `USAGE_REPOSITORY` selects the store: `console` (default — one JSON line to stderr per call, wired by `server.ts`'s `ConsoleUsageRepository`), `memory` (local inspection/tests only, lost on restart), or `postgres` (`PostgresUsageRepository`, a durable, queryable `rafid_agent_usage` table — its own table, independent of the customer store in `db/store.ts`, created on first use with `CREATE TABLE IF NOT EXISTS`, reusing `DATABASE_URL`). Swapping repositories requires no change to any route handler or to `mcp/remote.ts`.

When `X402_ENABLED=true`, `@x402/express`, `@x402/core` and `@x402/evm` gate a separate, unauthenticated `/api/v1/x402/...` route family (see "Pay-per-call via x402" above). Payment verification and settlement are delegated entirely to the configured facilitator (the public one, or CDP's when `CDP_API_KEY_ID`/`CDP_API_KEY_SECRET` are set -- see above); this repo does not implement wallet custody, settlement or replay protection itself. Never commit or log `CDP_API_KEY_SECRET`; store it the same way as `DATABASE_URL`.

## Next five production priorities

1. **Customer keys and abuse controls:** persistent customer identities, hashed keys, issuance/rotation/revocation, shared per-customer quotas, and edge limits before authentication. A per-process IP-keyed rate limiter now protects discovery, x402 and remote MCP (see "Security, observability and billing boundary" above); still needed: a distributed limiter for multi-instance deployments, and per-customer quotas for the x402/remote-MCP route families specifically.
2. **Durable usage and billing:** x402 pay-per-call is implemented and live on both Base Sepolia and Base mainnet; `UsageRepository` now has a durable PostgreSQL-backed implementation (`USAGE_REPOSITORY=postgres`) alongside console/memory. Still needed: x402 receipt reconciliation, and a second billing adapter (e.g. credits/subscriptions) for customers who prefer not to pay per call in crypto, plus monetizing remote MCP itself (it is currently a free, unauthenticated channel).
3. **Deployment and operations:** HTTPS deployment, secret management, CI checks, dependency scanning, metrics/alerts, load testing, backups and recovery drills.
4. **Authenticated, distributed remote MCP:** the Streamable HTTP transport now exists at `/mcp` (stateless, sharing the exact same registry/service layer as stdio — see "MCP usage" above) with basic IP rate limiting and usage recording. Still needed: durable identity/authorization for remote callers, origin/host validation appropriate for a public (not localhost-bound) deployment, and a distributed rate limiter for multi-instance production traffic.
5. **Trusted property intelligence:** `analyze_oman_property` now has a production-ready data architecture: async capability execution throughout REST/x402/MCP, a `PropertyMarketRepository` abstraction with a PostgreSQL-backed implementation and its own migration ledger, a validated CSV/JSON import pipeline (`npm run market:import`), configurable provider modes (`OMAN_PROPERTY_DATA_MODE=manual|database|composite`), per-response data freshness/staleness reporting, dynamic (not hard-coded) demo-data risk flagging, an optional comparable cache, a real (though not yet live-verified) integration with NCSI's official statistics API for governorate-level market context (`officialMarketContext`), and — as of this phase — a production-ready **Partner Data Feed layer** (authenticated CSV/JSON/HTTP ingestion, per-partner tokens, idempotent upsert, deterministic non-LLM data-quality scoring, partner-feed health/staleness, and internal aggregate-status reporting, entirely outside the agent-capability registry) that finally gives a real Oman real-estate company, broker or property manager a documented, authorized path to supply market data — see "Oman property analysis (Muscat)", "Production Oman market data", "Partner Data Feed" and "Official market context (NCSI)" above. Comparable selection, outlier removal and confidence scoring are unchanged regardless of data source, and NCSI context is kept structurally separate from comparable-based figures. Still needed: NCSI's live catalog endpoint to actually respond (it returned HTTP 500 for every request during development — see "Official market context (NCSI)" for the full finding) so a real `NCSI_REAL_ESTATE_DATASET_ID`/`NCSI_FIELD_MAP_JSON` can be verified and this integration exercised against real data; actually onboarding a first real (not fictional) Oman real-estate data partner through the new Partner Data Feed layer (`ListingDataProvider` remains a real, wired-in, but always-empty seam pending that); broader Muscat/Oman area coverage; and calibrated maintenance assumptions with provenance/freshness/formula versions for `estimate_maintenance` before adding further ROI, service-charge, lease or facility tools.

See [implementation review](docs/implementation-review.md) for the initial findings, exact scope and verification.
