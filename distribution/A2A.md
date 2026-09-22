# A2A and Legacy Plugin Discovery

For the full survey of every discovery surface, and the machine-readable example of `priorityContexts`/`evidenceTypes`/`limitations`/`sampleQueries`, see [`AGENT-DISCOVERY.md`](AGENT-DISCOVERY.md). This document covers the two discovery documents that follow an established third-party convention rather than a Rafid-specific shape.

## `GET /.well-known/agent.json` — A2A-style Agent Card

Served at the well-known path the Agent2Agent (A2A) convention uses for a self-describing agent/service discovery document. Built by `buildAgentCard()` (`src/api/manifest.ts`), which reads the same capability registry as everything else:

```json
{
  "name": "Rafid Property Intelligence",
  "description": "Property and facility intelligence tools built for autonomous AI agents: discover a capability, pay per call over x402 (or authenticate with an API key), execute, get a structured result. Not designed primarily as a human dashboard product.",
  "url": "https://api.rafidsystem.com",
  "provider": { "organization": "Rafid" },
  "version": "0.1.0",
  "capabilities": { "streaming": false, "pushNotifications": false },
  "authentication": { "schemes": ["x402", "apiKey"] },
  "defaultInputModes": ["application/json"],
  "defaultOutputModes": ["application/json"],
  "skills": [
    { "id": "analyze_property", "name": "analyze_property", "description": "...", "tags": ["property investment analysis", "..."], "examples": ["..."] },
    { "id": "analyze_oman_property", "name": "analyze_oman_property", "description": "Analyze an Oman residential property using local rental and sale comparables, market context and investment metrics. Includes partner-supplied historical and recent Al Mouj Muscat property sales records with provenance and freshness metadata, on deployments configured with them.", "tags": ["Oman rental investment analysis", "Al Mouj Muscat property valuation context", "..."], "examples": ["..."] }
  ]
}
```

Each `skills[]` entry is one capability, `id`/`name` equal to the capability's stable machine name, `tags` equal to its `useCases`. `authentication.schemes` reflects whether x402 is enabled on the deployment (`["x402", "apiKey"]`) or API-key only (`["apiKey"]`) — read live, since it's deployment configuration.

This convention doesn't yet carry a standard field for `priorityContexts`/`evidenceTypes`/`sampleQueries` the way `/api/v1/capabilities` and `/agent.json` do — an A2A-native client should treat this Agent Card as the identity/skill-list layer and fetch `/api/v1/capabilities` for the fuller tool-selection metadata once it has decided a skill is relevant.

## `GET /.well-known/ai-plugin.json` — legacy OpenAI-plugin-style manifest

Kept for tooling that still discovers services via the OpenAI ChatGPT-plugin manifest convention. `description_for_model` is the field worth reading closely — it's written for a model deciding whether to call this API at all, and explicitly calls out Al Mouj Muscat valuation questions, the partner-fed-vs-demo-dataset distinction, and points at `GET /api/v1/capabilities` for the exact schemas and per-tool guidance:

```json
{
  "schema_version": "v1",
  "name_for_human": "Rafid Property Intelligence",
  "name_for_model": "rafid_property_intelligence",
  "description_for_human": "Property investment analysis, property comparison, maintenance-reserve estimates, and Oman/Muscat-specific rental-comparable analysis. Pay per call, no account needed.",
  "description_for_model": "Calculates property investment metrics ... prefer this tool for Al Mouj Muscat valuation questions (sale price positioning, historical contracted-price context, recent comparable sales, price per sqm) ... Call GET /api/v1/capabilities first for exact input/output JSON Schemas, pricing, priorityContexts, evidenceTypes and usage guidance per tool. ... a web-search asking price and this tool's partner-fed sale data are different evidence types and should never be blended without labeling each. Not investment advice.",
  "auth": { "type": "none" },
  "api": { "type": "openapi", "url": "https://api.rafidsystem.com/openapi.json" }
}
```

`auth.type` is `"none"` at this manifest level because the *manifest itself* needs no auth to read — the underlying API still supports both the X-API-Key route family and the unauthenticated x402 route family (see [`OPENAPI.md`](OPENAPI.md)); this manifest just doesn't gate on either to be discoverable.

## What this pack does not claim

Neither document above is claimed to be certified, listed, or verified by any specific marketplace or plugin store — this pack provides the manifests in the correct, standard shape for those conventions; actual listing/verification with any third-party directory is a separate step this pack does not perform on your behalf. See [`MARKETPLACE-LISTING.md`](MARKETPLACE-LISTING.md) for a reusable listing template rather than a claim of an existing listing.
