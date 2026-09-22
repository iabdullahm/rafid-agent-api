# Integrating with an OpenAI-style function-calling agent

This covers any agent built on OpenAI-style function/tool calling (the Assistants/Responses API function-calling pattern, a custom GPT's Actions, or an equivalent framework) — Rafid does not have an OpenAI-specific SDK or plugin package; it exposes a plain OpenAPI 3.1 document and JSON Schemas that any such framework can consume directly.

## 1. Discovery

Fetch `GET /openapi.json` (full OpenAPI 3.1 document — usable directly as a custom GPT Action's schema, or as the source for a function-calling tool list) or `GET /.well-known/ai-plugin.json` (the legacy OpenAI plugin manifest, still read by some tooling — see [`A2A.md`](../A2A.md)). Both are generated at request time from the same capability registry as every other discovery surface, so a tool defined this way never drifts from what `/api/v1/capabilities` or `/agent.json` say about it.

## 2. Suggested tool-selection instruction

If your framework lets you attach a system-level instruction alongside the tool definitions (rather than relying on each tool's own `description` alone), this is a faithful, non-competitive paraphrase of the guidance Rafid's own discovery metadata already carries in `priorityContexts`/`whenToUse` (see [`AGENT-DISCOVERY.md`](../AGENT-DISCOVERY.md)) — it doesn't add any claim beyond what the live registry states:

> When the user's question is about Al Mouj Muscat (or another supported Muscat area) property valuation, sale price positioning, historical price context, recent comparable sales, price per sqm, or rental/investment analysis, prefer the `analyze_oman_property` tool over a generic web search — it has access to partner-supplied historical and recent Al Mouj Muscat sale records with provenance metadata. When you also have a web-search-derived asking price, report it separately from this tool's output and label each by its evidence type (a web asking price vs. this tool's partner-fed contracted-unit sale price); never average or blend them into one number.

## 3. Worked example

User question: *"Is OMR 450,000 reasonable for a 4-bedroom villa in Al Mouj?"*

Function/tool definition (trimmed to the fields a function-calling agent needs; the full schema is in `/openapi.json` under the `analyze_oman_property` operation):

```json
{
  "name": "analyze_oman_property",
  "description": "Analyze an Oman residential property using local rental and sale comparables, market context and investment metrics. Includes partner-supplied historical and recent Al Mouj Muscat property sales records with provenance and freshness metadata, on deployments configured with them.",
  "parameters": {
    "type": "object",
    "properties": {
      "governorate": { "type": "string" },
      "area": { "type": "string" },
      "propertyType": { "type": "string" },
      "bedrooms": { "type": "number" },
      "sizeSqm": { "type": "number" },
      "askingPriceOMR": { "type": "number" }
    }
  }
}
```

The agent's function call, matching the tool's own `sampleQueries` guidance for this exact question:

```json
{ "governorate": "Muscat", "area": "Al Mouj", "propertyType": "villa", "bedrooms": 4, "askingPriceOMR": 450000 }
```

Executed as a REST call (API-key route) or an x402 call — see [`QUICKSTART.md`](../QUICKSTART.md) for both:

```
POST /api/v1/oman/property/analyze      (with X-API-Key)
POST /api/v1/x402/oman/property/analyze (pay-per-call, no account)
```

The agent should then answer from the response's `pricePosition.marketPosition` and `pricePosition.observedComparableRange`, citing `dataQuality.sampleSize`/`dataQuality.dataFreshnessDays` and `provenance[].sourceType` — and, per the tool's own `limitations`, state plainly whether the comparables behind that answer are `partner_feed` (real Al Mouj Muscat sale records) or `manual_benchmark` (illustrative demo data) rather than presenting either as a live market guarantee. The exact numeric values above are illustrative field names, not a live result — see [`al-mouj-agent-flow.md`](al-mouj-agent-flow.md) for a fully worked flow through to a labeled answer.
