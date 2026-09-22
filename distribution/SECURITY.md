# Security Guide

## Accounts and authentication

- **No user account is required for x402 pay-per-call access.** `POST /api/v1/x402/<capability-path>` requires no sign-up, no account, and no API key — just a valid on-chain payment proof per call (see [`X402.md`](X402.md)).
- **An API-key option exists separately**, for callers that prefer a conventional authenticated integration: `POST /api/v1/<capability-path>` with an `X-API-Key` header. Neither route family requires the other to be set up.
- This pack adds no dashboard, no login, no sign-up flow, and no billing portal.

## Partner data

- `analyze_oman_property`'s partner-fed comparables (`sourceType: "partner_feed"`) come from a private partner-ingestion layer (partner onboarding, feed credentials, token rotation — see the project's own `docs/FIRST_PARTNER_ONBOARDING.md` and `docs/FIRST_LIVE_PARTNER_RUNBOOK.md`). **Partner ingestion tokens are private infrastructure and are never exposed by any public endpoint** — not `GET /api/v1/capabilities`, not `/agent.json`, not `/llms.txt`, not this distribution pack.
- What *is* exposed, deliberately, is provenance: a response's `provenance` field states the source type (`partner_feed`/`manual_benchmark`/`official_statistics`) and a public source name (e.g. `"Al Mouj Muscat"`) — the same public brand name a partner listing itself uses, not a private identifier. No internal partner id (the slug used to create/manage the partner record) and no partner auth token ever appears in discovery metadata, this pack's documentation, or `distribution/manifest.json`. `npm run distribution:check` enforces this by scanning `distribution/` for known-sensitive string patterns.
- **No Payment Plan or Government Number, or any other government-issued identifier, is ever exposed.** Rafid's partner sale records carry area/property-type/size/price/date fields for market analysis — not buyer/seller identity, national ID numbers, or similar personal/government identifiers, and no such field exists anywhere in the output schema.
- **Historical contracted prices are not government-registered conveyance prices.** A partner's own contracted-unit sale price is a real, but different, kind of evidence from an official land-registry/conveyance record — every response's own `limitations`/`evidenceTypes` metadata says so, and this distinction must be preserved in any downstream product built on Rafid.

## x402 wallet and facilitator secrets

- The receiving wallet's **private key is never exposed** by any endpoint. Only the public receive-side `payTo` address is ever returned (in `/api/v1/x402`, `/agent.json`), and only when x402 is enabled.
- The **CDP (Coinbase Developer Platform) facilitator's API secret is never exposed.** `GET /api/v1/x402/status` returns only booleans and non-secret identifiers: `enabled`, `mode`, `network`, `asset`, `facilitator` (a name like `"coinbase-cdp"` or `"public"`, not a credential), `walletConfigured`, `paymentEnforcement`.
- This document and the rest of this pack do not print live secret values, and don't pin a live wallet address either (see [`X402.md`](X402.md)) — read current, non-secret x402 configuration from the live status endpoints rather than a copy in this pack.

## Rate limiting

Public, unauthenticated agent-facing endpoints (discovery, x402, remote MCP) are protected by a per-process, in-memory, fixed-window rate limiter (`src/middleware/rateLimit.ts`), keyed by caller IP by default, with each route group given its own independent budget — a burst of x402 calls can't lock an agent out of discovery or remote MCP, and vice versa. This is a best-effort, single-instance default (`RATE_LIMIT_ENABLED`/`RATE_LIMIT_WINDOW_MS`/`RATE_LIMIT_MAX`, defaulting to enabled, a 60-second window, and 60 requests), not a distributed/global cap — a production deployment expecting many concurrent serverless instances should size expectations accordingly, or swap in a shared-store limiter behind the same interface (the code is already structured to allow that without touching call sites).

## SSRF protections on partner feeds

The Production Feed Runner, which fetches partner-configured feed URLs on a schedule, validates every feed URL (`src/domain/oman/feedSecurity.ts`) before it is ever fetched: rejecting non-HTTP(S) schemes, blocked/private hostnames, IP-literal private addresses, and addresses a hostname resolves to that turn out to be private — a partner-supplied URL can never be used to reach Rafid's own internal network, localhost, or a file on disk. This validation is unit-tested with a fake DNS resolver so every rejection path is exercised without needing real network access.

## What this document deliberately omits

No secret values — API keys, wallet private keys, CDP credentials, partner tokens, or database connection strings — appear anywhere in this file or the rest of `distribution/`. Where a fact would require printing one, this document either states the shape of the safe, non-secret status field instead, or points at the live, always-current endpoint that already discloses exactly the right amount of information.
