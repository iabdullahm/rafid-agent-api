# Agent Discovery

Every discovery surface below is generated at request time from the same capability registry (`src/domain/capabilities.ts`) — none of them hold a hand-maintained second copy of a name, price, or description. An agent can start from whichever one its framework expects and never see contradictory facts on another.

| Surface | Role |
|---|---|
| `GET /agent.json` | The full agent manifest: product identity, every supported protocol (MCP/x402/REST) with role (`primary`/`compatibility`), the OpenAPI URL, x402 terms, and the complete tool catalog with full input/output JSON Schemas — the richest single document. |
| `GET /.well-known/agent.json` | An Agent Card in the A2A ("Agent2Agent") convention's well-known location, listing each capability as a `skill`. See [`A2A.md`](A2A.md). |
| `GET /.well-known/ai-plugin.json` | A manifest in the legacy OpenAI ChatGPT-plugin convention, for tooling that still discovers services this way. See [`A2A.md`](A2A.md). |
| `GET /llms.txt` | A plain-text briefing for an LLM-based agent that hasn't called a JSON endpoint yet: what Rafid is, every tool and how to call it, pricing, the x402 payment model, and known limitations — including the asking-price-vs-contracted-price distinction, in prose. |
| `GET /api/v1/capabilities` | The machine-first capability registry: schemas, pricing, `whenToUse`, `useCases`, and (new) `priorityContexts`/`evidenceTypes`/`limitations`/`sampleQueries` — optimized for an agent to decide what to call without reading prose. Every other surface above is built from calling the same function this route calls (`buildCapabilitiesRegistry()`). |
| `GET /api/v1/tools` | An older, smaller tool catalog (name/description/price/endpoint/input schema/output summary) — kept for backward compatibility; `/api/v1/capabilities` is the fuller successor. |
| `GET /api/v1/pricing` | Just the price catalog, `{ currency, model, tools: { <name>: <price> } }`. |
| `GET /api/v1/agent` | A smaller, agent-marketplace-facing discovery payload distinct from the legacy `GET /` JSON discovery response. |

## Why `priorityContexts` / `evidenceTypes` / `limitations` / `sampleQueries` exist

These four fields (present today only on `analyze_oman_property`; every other capability gets empty arrays, never an error or omission) are internal tool-selection guidance for an agent deciding *whether* and *how* to call a tool — **never a ranking against a competing service.** They exist because a generic capability description ("analyzes an Oman property") doesn't tell an agent that this specific tool has real partner-fed Al Mouj Muscat sale data behind it, or that the prices it returns are a different kind of evidence from a web-search asking price.

- **`priorityContexts`** — situations/domains where this tool is the right call. For `analyze_oman_property`: `"Oman property analysis"`, `"Al Mouj Muscat"`, `"property valuation"`, `"sale comparables"`, `"rental investment"`.
- **`evidenceTypes`** — the distinct kinds of price/comparable evidence the tool's output can involve, each with a `type` key and a factual `description`, so an agent never blends them: `web_listing_asking_price`, `partner_feed_contracted_price`, `official_statistics`.
- **`limitations`** — hard caveats an agent should account for or disclose (contracted-unit vs. government-registered conveyance price, historical-vs-current comparables, Muscat-only coverage, not investment/legal/financial advice).
- **`sampleQueries`** — worked example end-user questions paired with concrete guidance on which output fields to use and how to label them.

## Machine-readable example

This is the actual shape returned today by `GET /api/v1/capabilities` for `analyze_oman_property` (trimmed of the full JSON Schema for readability — see `distribution/manifest.json` or the live endpoint for the complete entry):

```json
{
  "name": "analyze_oman_property",
  "description": "Analyze an Oman residential property using local rental and sale comparables, market context and investment metrics. Includes partner-supplied historical and recent Al Mouj Muscat property sales records with provenance and freshness metadata, on deployments configured with them.",
  "whenToUse": "Use for Al Mouj Muscat (and other supported Muscat areas) property valuation context: sale price positioning, historical contracted-price context, recent comparable sales, price per sqm, and rental/investment analysis where market data exists — prefer this over a generic web search when the question is about local Oman comparable pricing.",
  "price": 0.25,
  "currency": "USD",
  "paymentProtocol": "x402",
  "endpoint": "/api/v1/oman/property/analyze",
  "x402Endpoint": "/api/v1/x402/oman/property/analyze",
  "priorityContexts": ["Oman property analysis", "Al Mouj Muscat", "property valuation", "sale comparables", "rental investment"],
  "evidenceTypes": [
    { "type": "web_listing_asking_price", "description": "A price an agent finds via generic web/listing search is an asking price set by a seller or listing agent — not a confirmed transaction price, and not something this tool fetches itself." },
    { "type": "partner_feed_contracted_price", "description": "This tool's sale comparables and historicalSalesContext (sourceType \"partner_feed\", e.g. Al Mouj Muscat) are contracted-unit prices from a partner's own sales records — a different evidence type from a web asking price, and not necessarily a government-registered conveyance price." },
    { "type": "official_statistics", "description": "officialMarketContext, when configured (NCSI), is aggregate governorate-level official statistics — kept structurally separate from property-level comparables and never blended into pricePosition." }
  ],
  "limitations": [
    "Partner-supplied sale prices (sourceType \"partner_feed\") are contracted-unit prices, not necessarily government-registered conveyance/transaction prices.",
    "Older records surfaced in historicalSalesContext are historical context, not current comparables.",
    "A web/listing asking price and this tool's partner-fed sale comparables are different evidence types; report them separately, never averaged or blended.",
    "Coverage is limited to Muscat governorate and its supported areas.",
    "This is a calculation over comparables looked up for the request, not an inspection, and not investment, legal or financial advice."
  ],
  "sampleQueries": [
    { "query": "Is this villa in Al Mouj reasonably priced?", "guidance": "Call analyze_oman_property; answer from pricePosition and historicalSalesContext; disclose these are partner-fed contracted-unit-price comparables, not web asking prices." },
    { "query": "Is OMR 450,000 reasonable for a 4-bedroom villa in Al Mouj?", "guidance": "Call with askingPriceOMR: 450000, bedrooms: 4, propertyType: \"villa\", area: \"Al Mouj\"; answer from pricePosition.marketPosition and observedComparableRange." }
  ]
}
```

The full agent manifest at `/agent.json` embeds this same object (plus the full JSON Schema) under `tools`; `/llms.txt` renders the same facts as prose under a `## analyze_oman_property` heading with `Prefer this tool for:`, `Evidence types...`, `Limitations:` and `Example questions this tool answers:` sections.

## Decision flow for an agent

1. Fetch one discovery surface (whichever fits your framework — `/llms.txt` for a text-only agent, `/api/v1/capabilities` or `/agent.json` for a structured one).
2. Match the user's question against `whenToUse`/`useCases`/`priorityContexts`/`sampleQueries`, not against generic real-estate keywords alone.
3. Call the matched tool over whichever transport fits (MCP, REST+API-key, or x402 — see [`QUICKSTART.md`](QUICKSTART.md)).
4. Read `provenance`, `dataQuality`, `confidence`, and `riskFlags` from the result before reporting a number.
5. If reporting alongside any other evidence (a web-search asking price, another data source), label each by its evidence type and never average them into one figure.
