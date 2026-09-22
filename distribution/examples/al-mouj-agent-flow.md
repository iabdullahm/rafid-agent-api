# Worked flow: an Al Mouj Muscat property question, end to end

This walks one concrete question through every step of [`generic-agent.md`](generic-agent.md)'s decision logic, from discovery to a final, evidence-labeled answer. The numeric values below are **not invented for this document** — they are the hand-verified example fixture shipped in the capability registry itself (`OMAN_EXAMPLE_OUTPUT` in `src/domain/capabilities.ts`, regenerated from a real call to `analyzeOmanProperty()` in the default demo data mode), the same fixture `GET /api/v1/capabilities`, `/agent.json` and `/openapi.json` all use as their own documented example for `analyze_oman_property`.

**User question:** *"Is this apartment in Al Mouj reasonably priced?"*

## 1. Discovery

The agent fetches `GET /api/v1/capabilities` (or `/agent.json`/`/llms.txt` — any discovery surface reaches the same registry).

## 2. Match the question to a tool

`analyze_oman_property`'s `whenToUse` ("Use for Al Mouj Muscat … property valuation context: sale price positioning …") and `priorityContexts` (`"Al Mouj Muscat"`, `"property valuation"`) match directly — this is a stronger, more specific match than `analyze_property`'s generic single-property yield calculation.

## 3. Build the call input

The user's property: an apartment in Al Mouj, 2 bedrooms, 130 sqm, asking OMR 118,000. Matched to `analyze_oman_property`'s input schema:

```json
{ "governorate": "Muscat", "area": "Al Mouj", "propertyType": "apartment", "bedrooms": 2, "sizeSqm": 130, "askingPriceOMR": 118000 }
```

## 4. Choose a transport

Any of the three works identically for this call — the agent picks whichever it already speaks:

```
POST /api/v1/oman/property/analyze        (X-API-Key header)
POST /api/v1/x402/oman/property/analyze   (x402 payment proof, no account)
MCP tools/call { "name": "analyze_oman_property", "arguments": { ... } }
```

## 5. Call it

The call costs $0.25 (see [`X402.md`](../X402.md) for the x402 flow, [`OPENAPI.md`](../OPENAPI.md) for the API-key route) or is unmetered over MCP in this phase (see [`MCP.md`](../MCP.md)).

## 6. Read the result

The documented example response for this exact input (trimmed to the fields this flow uses):

```json
{
  "pricePosition": { "askingPricePerSqmOMR": 907.69, "observedComparableRange": null, "marketPosition": "insufficient_data" },
  "market": { "estimatedMonthlyRentOMR": { "low": 696.43, "median": 731.25, "high": 731.85 }, "comparableCount": 4, "sampleSizeUsed": 3, "dataFreshnessDays": 185 },
  "investment": { "grossYieldPct": 7.44, "netYieldPct": 7.44 },
  "historicalSalesContext": { "available": false, "recordsAvailable": 0 },
  "riskFlags": ["outliers_removed", "insufficient_sale_market_data", "demo_dataset_not_live_market_data"],
  "confidence": { "score": 0.73, "level": "high" },
  "provenance": [{ "sourceType": "manual_benchmark", "sourceName": "Rafid curated Muscat benchmark dataset (demo/MVP — illustrative figures, not sourced from live listings or completed transactions)", "sourceDate": "2026-06-01", "recordCount": 5 }],
  "insufficientMarketData": false
}
```

## 7. Check `provenance` before saying anything about price

`provenance[0].sourceType` is `"manual_benchmark"` here — this specific example response is illustrative demo data, not a real Al Mouj sale record. (On a deployment configured with the real Al Mouj Muscat partner feed, a live call can instead return `sourceType: "partner_feed"` records — see [`SECURITY.md`](../SECURITY.md) and [`MARKETPLACE-LISTING.md`](../MARKETPLACE-LISTING.md) for that distinction.) The agent's answer must say which kind of data actually backed it, every time — never presenting a `manual_benchmark`-sourced figure as if it were a confirmed market transaction.

## 8. Check `pricePosition.marketPosition`

Here it's `"insufficient_data"` — `unavailableOutputs` in the full response confirms `pricePosition.observedComparableRange` and `.marketPosition` were not computable from this particular comparable pool. A correct agent answer says so directly rather than guessing a position.

## 9. Check `historicalSalesContext.available`

`false` in this example (the default demo mode has no live partner transaction-record store — see the code comment on `OMAN_EXAMPLE_OUTPUT` in `capabilities.ts`). The agent should not claim a historical-sales trend it doesn't have.

## 10. Check `confidence` and `riskFlags`

`confidence.score` 0.73 (`"high"`), but `riskFlags` includes `"demo_dataset_not_live_market_data"` and `"insufficient_sale_market_data"` — both must be surfaced in the answer, not silently dropped just because the confidence score itself looks reasonable.

## 11. If the agent also has a web-search figure

Suppose a separate web search found a similar Al Mouj apartment listed at OMR 125,000. That is a `web_listing_asking_price` (evidence type), distinct from this tool's own `pricePosition`/`market` figures. Report both, each labeled, e.g.: *"A similar unit is currently listed at OMR 125,000 (web listing, asking price) — this is a different evidence type from Rafid's own comparable data below."* Never average the two into one number.

## 12. Compose the final answer

A correct answer to *"Is this apartment in Al Mouj reasonably priced?"* from this exact response states: the estimated price per sqm (OMR 907.69/sqm) and estimated rental range (OMR 696–732/month, median 731.25) with their basis; that `marketPosition` could not be determined from available comparables (`insufficient_data`); that the backing data is `manual_benchmark` (illustrative demo data on this particular deployment), not a live partner sale record, with the `demo_dataset_not_live_market_data` risk flag disclosed; that historical sales context isn't available for this example; and, if a web asking price is also in hand, that figure reported separately and labeled by evidence type. This is the full discipline every capability's `limitations` and `evidenceTypes` metadata asks an integrating agent to follow — see [`AGENT-DISCOVERY.md`](../AGENT-DISCOVERY.md).
