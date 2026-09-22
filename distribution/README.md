# Rafid Property Intelligence — Agent Distribution Pack

Property intelligence built for AI agents.

**Discover. Pay per call. Execute.**

Rafid Property Intelligence is an AI-agent-first API for Oman property and facility intelligence. It is not designed primarily as a human dashboard product — there is no sign-up flow, no user account, and no billing portal. An agent (or the model behind one) discovers what Rafid can do from a small set of machine-readable documents, pays per call over the x402 protocol (or authenticates with an API key), calls a tool, and gets a structured JSON result back.

Production base URL: `https://rafid-agent-api.vercel.app`

## What's in this pack

This directory packages Rafid for distribution to AI agents, agent frameworks, and agent marketplaces/directories. It is documentation, integration examples, and a discovery/validation toolchain — **it adds no new public capability, does not change pricing, and does not change any x402 payment route.** Every fact in it (capability names, prices, endpoints, `whenToUse`, evidence types) is derived from the single capability registry (`src/domain/capabilities.ts`) that the live API itself reads from, either directly or via `distribution/manifest.json` (see [`manifests/`](manifests/) and `npm run distribution:manifest`).

| File | Purpose |
|---|---|
| [`QUICKSTART.md`](QUICKSTART.md) | The fastest path to a working call, in three ways: remote MCP, REST/OpenAPI, x402. |
| [`MCP.md`](MCP.md) | Remote and stdio MCP integration, tool discovery, client config examples. |
| [`OPENAPI.md`](OPENAPI.md) | The OpenAPI document, operation IDs, schemas, API-key vs. x402 route families. |
| [`X402.md`](X402.md) | The pay-per-call protocol: pricing, payment flow, the `402`/`PAYMENT-REQUIRED` handshake, security notes. |
| [`A2A.md`](A2A.md) | The A2A-style Agent Card and OpenAI-plugin-style manifest. |
| [`AGENT-DISCOVERY.md`](AGENT-DISCOVERY.md) | Every discovery surface (`/agent.json`, `/llms.txt`, `/api/v1/capabilities`, …) and what each is for. |
| [`MARKETPLACE-LISTING.md`](MARKETPLACE-LISTING.md) | A reusable listing template for agent marketplaces/directories. |
| [`INTEGRATION-EXAMPLES.md`](INTEGRATION-EXAMPLES.md) | Index of the worked integration examples in `examples/`. |
| [`SECURITY.md`](SECURITY.md) | What is and isn't exposed: accounts, tokens, partner data, wallet/facilitator secrets, rate limiting, SSRF protection. |
| [`BRANDING.md`](BRANDING.md) | Name, tagline, description, keywords — for listings and marketplace pages. |
| [`manifests/`](manifests/) | Notes on `distribution/manifest.json` and how it's generated. |
| [`examples/`](examples/) | Worked integration paths: OpenAI/Codex-style agents, Claude, Cursor, a generic HTTP/MCP/x402 agent, and a full example agent flow for a real Al Mouj question. |
| [`snippets/`](snippets/) | Minimal, runnable curl/Node/MCP snippets. |
| [`manifest.json`](manifest.json) | Machine-readable distribution manifest, generated from the capability registry (`npm run distribution:manifest`). |

## Core value proposition

- **Oman-specific property intelligence** — Muscat governorate, with real per-area coverage rather than a generic global model.
- **Partner-fed Al Mouj Muscat sales data** — `analyze_oman_property` uses real partner-supplied Al Mouj Muscat property sale records where a deployment is configured with them (`sourceType: "partner_feed"`), alongside a demo/benchmark dataset (`sourceType: "manual_benchmark"`) where it isn't. Every response's own `provenance` and `dataQuality` fields say which.
- **Machine-readable outputs** — every capability has a strict Zod-derived JSON Schema for input and output; nothing is scraped HTML or unstructured text.
- **Provenance, freshness, confidence** — `analyze_oman_property`'s output carries `provenance` (source type/name/date/record count), `dataQuality` (freshness, sample size, staleness), a `confidence` score with stated reasons, and `riskFlags` — an agent can decide how much to trust a result without guessing.
- **Evidence-type labeling** — a web-search asking price, a partner-fed contracted sale price, and an official statistic are three different kinds of evidence. Rafid's metadata says so explicitly (`evidenceTypes`) so an agent never blends them into one number.
- **x402 pay-per-call** — no account needed. Call an endpoint, get a `402` with machine-readable payment requirements, pay on-chain, call again.
- **MCP** — every capability is also an MCP tool, over stdio or the remote Streamable HTTP transport, with `readOnlyHint`/`idempotentHint` annotations.
- **OpenAPI** — a full OpenAPI 3.1 document at `/openapi.json`, covering both the API-key and x402 route families.
- **A2A / agent discovery** — an Agent Card at `/.well-known/agent.json`, an OpenAI-plugin-style manifest at `/.well-known/ai-plugin.json`, and a plain-text briefing at `/llms.txt` for an agent that hasn't called a JSON endpoint yet.

## What this pack is not

- Not a new public capability. The four capabilities documented here (`analyze_property`, `compare_properties`, `estimate_maintenance`, `analyze_oman_property`) are exactly the four already live in production.
- Not a pricing change. Prices are quoted here exactly as they are in `src/billing/catalog.ts` / `GET /api/v1/pricing` today.
- Not an x402 route change. Every x402 path named here already exists.
- Not a SaaS dashboard and not a user-account system. There is no login, no sign-up, and nothing in this pack asks for one.

## Where to start

If you're integrating an agent right now, start at [`QUICKSTART.md`](QUICKSTART.md). If you're listing Rafid on a marketplace or directory, start at [`MARKETPLACE-LISTING.md`](MARKETPLACE-LISTING.md) and [`BRANDING.md`](BRANDING.md). If you're validating this pack itself, run `npm run distribution:check` (see the project root `README.md`'s development section, or [`SECURITY.md`](SECURITY.md) for what it guards against).
