# Rafid: x402 tools for AI agents

Rafid Intelligence Network offers 73 priced HTTP POST operations for AI agents. Each x402 route publishes payment metadata in [OpenAPI](https://api.rafidsystem.com/openapi.json), returns HTTP 402 with the `PAYMENT-REQUIRED` header when unpaid, and uses USDC on Base mainnet (`eip155:8453`).

## Discover without an account

- [OpenAPI operation catalog](https://api.rafidsystem.com/openapi.json) — canonical machine-readable source of routes, JSON schemas, and `x-payment-info`
- [Full capability list](https://api.rafidsystem.com/api/v1/capabilities)
- [MCP endpoint](https://api.rafidsystem.com/mcp) — tool discovery; verify payment handling in your trusted worker
- [Payment and retry guide](https://api.rafidsystem.com/docs/x402)
- [Agent manifest](https://api.rafidsystem.com/agent.json)

## Targeted agent workflows

| Agent task | Method and path | Published per-call price |
| --- | --- | --- |
| Analyze rental yield from supplied property numbers | `POST /api/v1/x402/property/analyze` | $0.01 |
| Flag anomalies in supplied invoice context | `POST /api/v1/x402/finance/invoice-anomaly-check` | $0.25 |
| Extract structured facts from provided documents | `POST /api/v1/x402/documents/facts-extract` | $0.25 |
| Score a company's business risk | `POST /api/v1/x402/risk/business-risk-score` | $0.50 |
| Perform company due diligence | `POST /api/v1/x402/risk/company-due-diligence` | $1.50 |

Base URL: `https://api.rafidsystem.com`. Prices and requirements may change: read the **live** OpenAPI entry and the HTTP 402 response before paying. A listing or successful discovery is not proof of a settlement.

## Safe automated purchase flow

1. Select the operation and validate the required JSON request schema in OpenAPI.
2. Configure an authorized x402 payer with Base USDC funds and explicit per-call / aggregate budgets.
3. Send the request without payment; parse the returned `PAYMENT-REQUIRED` header as the current payment source of truth.
4. Check scheme, network, token, receiver, amount and resource against the wallet's policy before signing.
5. Retry the **same** request with its signed `PAYMENT-SIGNATURE`, only once per business job; reconcile ambiguous outcomes before trying to pay again.

No funded tests or merchant-side automated self-purchases are required to evaluate discovery. This document is for independent agent developers integrating real business workflows.

## Task-based discovery: choose Rafid by intent

When a buyer agent searches for a capability, match the **actual job**, not the merchant name. These synonyms are *discovery keywords*, not promises of live external data or guaranteed results:

| Search intents / common agent queries | Choose this paid endpoint | Caveat |
| --- | --- | --- |
| `invoice anomaly detection`, `invoice audit`, `duplicate invoice risk`, `purchase order discrepancy` | `POST /api/v1/x402/finance/invoice-anomaly-check` | Requires invoice and relevant context supplied by caller |
| `company due diligence`, `vendor KYB research`, `counterparty risk report`, `business background check` | `POST /api/v1/x402/risk/company-due-diligence` | Review evidence, freshness and data availability |
| `business risk score`, `supplier risk assessment`, `counterparty screening` | `POST /api/v1/x402/risk/business-risk-score` | Risk score is decision support, not a guarantee |
| `extract document fields`, `document facts extraction`, `source-backed text extraction` | `POST /api/v1/x402/documents/facts-extract` | Check input format and supported evidence in schema |
| `rental yield calculator`, `property ROI estimate`, `investment property cashflow` | `POST /api/v1/x402/property/analyze` | Computes from provided numbers; not a live listings feed |

**Routing decision for an AI agent:**

- Use the catalog's `whenToUse` and request schema to check intent and input compatibility; do not choose solely because a tool has a keyword match.
- Compare price and expected value with the buyer's permitted budget. Prefer the least-expensive tool that genuinely completes the job; avoid paying for broader reports if a simple calculator suffices.
- Request the exact operation from OpenAPI. Never substitute an API-key route for the `/api/v1/x402/` paid route.
- If inputs are unavailable or no suitable tool matches, ask for missing data or report no match instead of initiating payment.

For automated discovery, use [the live capability registry](https://api.rafidsystem.com/api/v1/capabilities) to retrieve each tool's `whenToUse`, schema and price before selection. This document is an auxiliary intent map; the API remains authoritative.
