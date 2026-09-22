# Marketplace Listing Pack

A reusable listing template for agent marketplaces, directories, and plugin/tool stores. Copy the fields below as-is, or adapt formatting to a specific marketplace's submission form. **This is a template, not a claim of an existing submission or approval on any named marketplace** — no marketplace-specific submission process is asserted here.

## Product name

Rafid Property Intelligence

## One-line

Oman property intelligence for AI agents.

## Short description

AI-agent-native property intelligence with Oman-specific market context, real partner-fed Al Mouj Muscat sales data, provenance, confidence, MCP, OpenAPI and x402 pay-per-call.

## Long description

Rafid Property Intelligence is an API built for autonomous AI agents rather than human dashboards. It exposes four capabilities — property investment metrics, multi-property comparison, a maintenance-reserve heuristic, and Oman/Muscat-specific property analysis — over three interchangeable transports: MCP (stdio or remote Streamable HTTP), a conventional REST API authenticated with an API key, and x402 pay-per-call requiring no account at all.

Its most distinctive capability, `analyze_oman_property`, combines local rental and sale comparables, historical sale context, and (where NCSI is configured) official governorate-level statistics into one structured response with `pricePosition`, `historicalSalesContext`, `provenance`, `dataQuality`, `confidence`, and `riskFlags`. On deployments configured with them, its sale comparables and historical context include real partner-supplied Al Mouj Muscat property sale records (`sourceType: "partner_feed"`) — genuine contracted-unit prices from a real estate partner's own sales records — alongside a curated demo/benchmark dataset (`sourceType: "manual_benchmark"`) where partner data isn't configured. Every response states which kind of data actually contributed.

Rafid is explicit about evidence semantics: a web-search asking price, a partner-fed contracted sale price, and an official statistic are three different kinds of evidence, and the API's own discovery metadata (`evidenceTypes`, `limitations`) tells an integrating agent to keep them labeled separately rather than blending them into one number.

Every capability is discoverable and callable the same way regardless of integration path: `GET /api/v1/capabilities` (or `/agent.json`, `/llms.txt`, `/.well-known/agent.json`, `/.well-known/ai-plugin.json`) for discovery; `POST /api/v1/<path>` with an API key, `POST /api/v1/x402/<path>` for pay-per-call, or an MCP `tools/call` for execution. Full OpenAPI 3.1 documentation is at `/openapi.json`.

## Categories

- Real estate
- Property intelligence
- Oman
- Investment analysis
- MCP tools
- x402

## Pricing table

| Capability | Price (USD) | Payment |
|---|---|---|
| `analyze_property` | $0.01 | API key or x402 |
| `compare_properties` | $0.03 | API key or x402 |
| `estimate_maintenance` | $0.02 | API key or x402 |
| `analyze_oman_property` | $0.25 | API key or x402 |

MCP calls (stdio or remote) are unmetered in this phase — see [`MCP.md`](MCP.md). Prices are read live from `GET /api/v1/pricing`; the table above reflects that endpoint as of this pack's writing.

## Example queries

- "Is this villa in Al Mouj reasonably priced?"
- "Is OMR 450,000 reasonable for a 4-bedroom villa in Al Mouj Muscat?"
- "Compare this Al Mouj asking price against local sales data."
- "Show me recent comparable sales for a villa in Al Mouj."
- "Compare two properties by net rental yield."
- "Estimate the annual maintenance reserve for a 12-year-old, single-unit property."

## Supported geography

**Muscat governorate only**, and only its currently supported areas: Al Mouj, Muscat Hills, Qurum, Bausher, Azaiba, Al Khuwair, Madinat Al Irfan, Ghubrah (see the live `GET /llms.txt` coverage section, or `distribution/manifest.json`'s `geography.supportedAreas`, for the current list — it can grow over time).

**Al Mouj Muscat is this deployment's strongest single-area coverage today**, because it is the only area with real partner-fed sale records; other supported areas may only have demo/benchmark data on a given deployment. This is **not nationwide Oman coverage**, and no claim of nationwide or countrywide coverage should be made when listing this product.

## Data semantics

`analyze_oman_property`'s comparable and historical data is one of two kinds, always disclosed in the response's own `provenance`/`dataQuality` fields:

- `manual_benchmark` — a curated demo/MVP dataset, illustrative, not sourced from live listings or completed transactions.
- `partner_feed` — real partner-supplied sale records (e.g. Al Mouj Muscat), contracted-unit prices from a partner's own sales records.

A web-search asking price is a third, separate kind of evidence Rafid does not itself fetch — an integrating agent that also has access to listing search should keep that labeled apart from Rafid's own `pricePosition`/`historicalSalesContext`, never blending the two into a single reported number.

## Limitations

- Muscat governorate only; an unsupported governorate or area returns `insufficientMarketData: true` rather than a guessed estimate.
- Partner-supplied sale prices are contracted-unit prices, not necessarily government-registered conveyance/transaction prices.
- `estimate_maintenance` is an uncalibrated heuristic, not a survey or contractor estimate.
- Nothing Rafid returns is financial, legal, or investment advice.
- All four capabilities are calculations over supplied or looked-up data — none of them perform a physical inspection.

## Security

No user accounts are required for x402 pay-per-call access; an API-key option exists as a separate, traditional integration path. Partner ingestion credentials are private infrastructure and are never exposed by any public endpoint. x402 wallet and facilitator secrets are never exposed. See [`SECURITY.md`](SECURITY.md) for the full statement.

## Support contact

`<insert support contact — e.g. a support email or issue tracker URL — before publishing this listing>`
