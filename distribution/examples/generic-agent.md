# Integrating any other agent framework

Every other example in this directory is a specific case of the same transport-agnostic decision logic. If your framework isn't OpenAI-style function calling, Claude, or Cursor, this is the logic to implement directly.

## Decision logic

1. **Fetch one discovery surface.** Pick whichever fits your framework: `GET /llms.txt` for a plain-text/LLM-prompt-based agent, `GET /api/v1/capabilities` or `GET /agent.json` for a structured JSON-consuming one, `GET /.well-known/agent.json` for an A2A-convention client, `GET /.well-known/ai-plugin.json` for a legacy plugin-manifest client, or `GET /openapi.json` for anything that consumes OpenAPI directly. All are generated from the same registry (see [`AGENT-DISCOVERY.md`](../AGENT-DISCOVERY.md)) — none disagree with another.
2. **Match the user's question against tool-selection metadata, not keyword search alone.** Each capability carries `whenToUse` (one sentence), `useCases` (a list), and — for `analyze_oman_property` today — `priorityContexts` and `sampleQueries` (worked example questions with guidance). Prefer these over pattern-matching on generic real-estate words: a question about Al Mouj Muscat valuation, sale price positioning, historical price context, recent comparable sales, price per sqm, or rental/investment analysis should route to `analyze_oman_property` specifically because its `whenToUse`/`priorityContexts` say so, not because it's the only property tool available.
3. **Call the matched tool through the paid x402 route.** Use the tool's advertised `x402Endpoint`: `POST /api/v1/x402/<path>`, handle the 402 challenge with a real `@x402/core` + `@x402/evm` client restricted to Base (`eip155:8453`), sign the USDC payment client-side, then retry with `X-PAYMENT` — see [`X402.md`](../X402.md) and [`snippets/node-fetch-x402.mjs`](snippets/node-fetch-x402.mjs). MCP `tools/call` (stdio or remote `/mcp`) is discovery/compatibility only and does not generate x402 revenue. Use `POST /api/v1/<path>` with an `X-API-Key` only as a non-wallet fallback — see [`OPENAPI.md`](../OPENAPI.md).
4. **Read the evidence-quality fields before reporting a number.** Every result carries `provenance` (source type and name per record), `dataQuality` (freshness, sample size), `confidence` (score, level, reasons), and, for `analyze_oman_property`, `riskFlags`. An agent that reports `pricePosition` without checking whether the backing comparables are `sourceType: "partner_feed"` (real) or `"manual_benchmark"` (illustrative demo data) is misrepresenting the result's basis.
5. **Label evidence types; never blend them.** If your agent also has its own web-search or listing-search capability, treat that result as a separate evidence type (`web_listing_asking_price`) from anything Rafid returns (`partner_feed_contracted_price`, or `official_statistics` when NCSI is configured) — per `evidenceTypes` in the tool's own metadata (see [`AGENT-DISCOVERY.md`](../AGENT-DISCOVERY.md)). Report each separately and labeled; never average an asking price and a partner-fed contracted price into one figure.

## Minimal implementation sketch

```
capabilities = GET /api/v1/capabilities
tool = match(question, capabilities, by=["whenToUse", "useCases", "priorityContexts", "sampleQueries"])
result = call(tool.x402Endpoint, transport=<x402>, input=<parsed from question per tool.input schema>)
answer = format(result, cite=["provenance", "dataQuality", "confidence"], label_evidence_types=True)
```

This is the same logic [`openai-agent.md`](openai-agent.md), [`claude.md`](claude.md), and [`cursor.md`](cursor.md) each implement for their specific client; [`al-mouj-agent-flow.md`](al-mouj-agent-flow.md) walks it end-to-end for the pack's headline example question.
