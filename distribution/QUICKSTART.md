# Quickstart

Three ways to call Rafid. Pick one; they all reach the same capability registry and produce the same output shape.

Production base URL: `https://rafid-agent-api.vercel.app`

Example intent used throughout this pack:

> "Is OMR 450,000 reasonable for a 4-bedroom villa in Al Mouj Muscat?"

That maps to one call: `analyze_oman_property` with `{ governorate: "Muscat", area: "Al Mouj", propertyType: "villa", bedrooms: 4, sizeSqm: <size>, askingPriceOMR: 450000 }`. (`sizeSqm` is required by the schema; a real agent would ask the user for it or estimate from listing data — the example below uses a representative villa size.)

## A. Remote MCP

**Endpoint:** `POST https://rafid-agent-api.vercel.app/mcp` — a stateless MCP Streamable HTTP transport (JSON-RPC 2.0). Live status: `GET /api/v1/mcp/status`. Full guide: [`MCP.md`](MCP.md).

**Minimal configuration:** point any MCP client that supports the Streamable HTTP transport at the URL above. No API key and no x402 payment is required for remote MCP today — it is unmetered in this phase (see [`MCP.md`](MCP.md) for exactly what that means).

**One real call** (`tools/call` for `analyze_oman_property`), as a JSON-RPC request body:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "analyze_oman_property",
    "arguments": {
      "governorate": "Muscat",
      "area": "Al Mouj",
      "propertyType": "villa",
      "bedrooms": 4,
      "sizeSqm": 420,
      "askingPriceOMR": 450000
    }
  }
}
```

**Expected output shape** (the `structuredContent` field of the MCP result — see [`OPENAPI.md`](OPENAPI.md) for the full output schema):

```json
{
  "normalizedLocation": { "governorate": "Muscat", "area": "Al Mouj", "matchType": "exact", "supported": true },
  "subjectProperty": { "propertyType": "villa", "bedrooms": 4, "sizeSqm": 420, "askingPriceOMR": 450000 },
  "pricePosition": { "askingPricePerSqmOMR": 1071.43, "observedComparableRange": { "low": 0, "median": 0, "high": 0 }, "marketPosition": "..." },
  "historicalSalesContext": { "available": true, "..." : "..." },
  "provenance": [ { "sourceType": "partner_feed", "sourceName": "Al Mouj Muscat", "..." : "..." } ],
  "dataQuality": { "dataFreshnessDays": 0, "sampleSize": 0, "sourceTypes": ["partner_feed"], "staleMarketData": false },
  "confidence": { "score": 0, "level": "...", "reasons": ["..."] },
  "riskFlags": ["..."]
}
```

Exact numeric values depend on the live comparable pool at call time — see [`examples/al-mouj-agent-flow.md`](examples/al-mouj-agent-flow.md) for a worked, non-fabricated walkthrough of how to read a real response.

## B. REST / OpenAPI (API-key)

**Endpoint:** `POST https://rafid-agent-api.vercel.app/api/v1/oman/property/analyze`, header `X-API-Key: <your key>`. Full guide: [`OPENAPI.md`](OPENAPI.md).

**Minimal configuration:** an active Rafid API key in the `X-API-Key` header.

```bash
curl -s -X POST https://rafid-agent-api.vercel.app/api/v1/oman/property/analyze \
  -H "X-API-Key: $RAFID_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"governorate":"Muscat","area":"Al Mouj","propertyType":"villa","bedrooms":4,"sizeSqm":420,"askingPriceOMR":450000}'
```

**Expected output shape:** `{ "success": true, "data": { ...same output shape as above... }, "meta": { "requestId", "tool": "analyze_oman_property", "price": 0.25, "currency": "USD" } }`.

## C. x402 pay-per-call (no account)

**Endpoint:** `POST https://rafid-agent-api.vercel.app/api/v1/x402/oman/property/analyze` — no API key. Full guide: [`X402.md`](X402.md).

**Minimal configuration:** an x402-aware HTTP client (or the pattern below done by hand): call once without payment to get a `402` with a `PAYMENT-REQUIRED` header describing accepted payment, satisfy it, retry with an `X-PAYMENT` header.

```bash
# 1. Unpaid call — expect 402 with a PAYMENT-REQUIRED header
curl -s -i -X POST https://rafid-agent-api.vercel.app/api/v1/x402/oman/property/analyze \
  -H "Content-Type: application/json" \
  -d '{"governorate":"Muscat","area":"Al Mouj","propertyType":"villa","bedrooms":4,"sizeSqm":420,"askingPriceOMR":450000}'

# 2. Retry with a valid X-PAYMENT header once payment is satisfied (see X402.md)
curl -s -X POST https://rafid-agent-api.vercel.app/api/v1/x402/oman/property/analyze \
  -H "Content-Type: application/json" \
  -H "X-PAYMENT: <payment-proof>" \
  -d '{"governorate":"Muscat","area":"Al Mouj","propertyType":"villa","bedrooms":4,"sizeSqm":420,"askingPriceOMR":450000}'
```

**Expected output shape:** identical response envelope to the REST route — `{ "success": true, "data": { ... }, "meta": { "tool", "price": 0.25, "currency": "USD" } }`.

## Which one should an agent pick?

- **MCP** if the agent framework speaks MCP natively (Claude, many agent SDKs) — least glue code, structured tool schema, no payment step today.
- **REST/OpenAPI** if the agent already has an API key or is integrated via OpenAPI function-calling (OpenAI/Codex-style tool use).
- **x402** if the agent wants to pay per call with no account at all, or is running in an environment where holding an API key isn't practical.

None of these are mutually exclusive with the others — they're three transports over the same registry, priced identically.
