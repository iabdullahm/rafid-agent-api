# OpenAPI Guide

`GET /openapi.json` (`https://rafid-agent-api.vercel.app/openapi.json`) is a full OpenAPI 3.1 document generated at request time by `buildOpenapi()` (`src/api/openapi.ts`) from the same capability registry every other discovery surface reads — it can't drift from the live route behavior, the schemas, or the prices in `GET /api/v1/pricing`. A human-browsable Swagger UI over the same document is at `GET /docs`.

## Operation IDs

| Capability | API-key route `operationId` | Legacy `/v1/...` route `operationId` | x402 route `operationId` |
|---|---|---|---|
| `analyze_property` | `analyze_property` | `analyze_property_legacy` | `analyze_property_x402` |
| `compare_properties` | `compare_properties` | `compare_properties_legacy` | `compare_properties_x402` |
| `estimate_maintenance` | `estimate_maintenance` | `estimate_maintenance_legacy` | `estimate_maintenance_x402` |
| `analyze_oman_property` | `analyze_oman_property` | `analyze_oman_property_legacy` | `analyze_oman_property_x402` |

Every API-key operation ID equals the capability's own `name` exactly — the same string used as the MCP tool name and the `tool` field in every response's `meta`.

## Schemas and examples

Each operation's request body schema is the capability's Zod input schema converted to JSON Schema (`z.toJSONSchema(c.input)`), with the capability's own worked `example` attached as the request example. The `200` response schema wraps the capability's Zod output schema in the standard success envelope (`{ success: true, data: <output>, meta: { requestId, tool, price, currency } }`), with the capability's hand-verified `exampleOutput` as the response example. Error responses (`400`, `401` for API-key routes, `413`, `415`, `429`, `500`, `503`) share one schema (`{ success: false, error: { code, message, details? } }`).

`analyze_oman_property`'s `/api/v1/capabilities` entry (also embedded in `/agent.json`) additionally carries `priorityContexts`, `evidenceTypes`, `limitations` and `sampleQueries` — agent tool-selection guidance, documented in [`AGENT-DISCOVERY.md`](AGENT-DISCOVERY.md). The OpenAPI schema for `GET /api/v1/capabilities` documents these fields too.

## Authentication: two independent route families

**API-key routes — traditional integration.** `POST /api/v1/<capability-path>` (and the deprecated `POST /v1/<capability-path>` alias, kept for backward compatibility) require an `X-API-Key` header with an active Rafid API key. This is the route family for an application, script, or agent that already holds — or can be issued — a key and wants a conventional authenticated integration.

**x402 routes — agent-native pay-per-call.** `POST /api/v1/x402/<capability-path>` require no API key and no account. Call once without an `X-PAYMENT` header to receive a `402` response with machine-readable payment requirements; pay; retry with a valid `X-PAYMENT` header. This is the route family for an autonomous agent that wants to discover a price and pay for exactly the calls it makes, with nothing to provision in advance. Full protocol detail: [`X402.md`](X402.md).

**These two families are not required together, and using one doesn't require any setup for the other.** A caller with an API key never needs to touch x402; an x402-paying agent never needs a key. Both families expose the exact same input/output schemas and the exact same price — only the authentication/payment mechanism differs. Both are documented in the same OpenAPI file so a single client library can support either without a second schema.

## Everything else the document covers

- `GET /api/v1/health` and the legacy `GET /health` — liveness, no auth.
- `GET /` — HTML landing page for browsers (`Accept: text/html`) or a small JSON discovery payload for machine clients.
- `GET /docs` — Swagger UI.
- `GET /api/v1/agent`, `/api/v1/pricing`, `/api/v1/tools`, `/api/v1/capabilities` — agent-marketplace discovery, pricing, and the two tool-catalog shapes (see [`AGENT-DISCOVERY.md`](AGENT-DISCOVERY.md)).
- `GET /api/v1/x402`, `/api/v1/x402/status` — x402 protocol info and factual runtime status, always available regardless of whether x402 is enabled on a given deployment.
- `GET /api/v1/mcp/status`, and `POST /mcp` when remote MCP is enabled — see [`MCP.md`](MCP.md).
- `GET /agent.json`, `/.well-known/ai-plugin.json`, `/.well-known/agent.json`, `/llms.txt` — see [`A2A.md`](A2A.md) and [`AGENT-DISCOVERY.md`](AGENT-DISCOVERY.md).

## Verifying this yourself

`/openapi.json` is a large document (it embeds full input/output JSON Schemas for every capability across three route families). If you fetch it through a tool that summarizes or truncates large responses, don't trust an exhaustive "this path is missing" conclusion from that summary — fetch it directly and inspect the raw JSON, or diff it against a previous known-good copy. This pack's own live-verification pass (see the final report accompanying this distribution work) hit exactly that limitation and treated it as inconclusive rather than as evidence of a missing route, since the smaller discovery endpoints (`/api/v1/capabilities`, `/agent.json`, `/api/v1/x402`) independently confirmed all four capabilities — including `analyze_oman_property` and its x402 route — are live.
