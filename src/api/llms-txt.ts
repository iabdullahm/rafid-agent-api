import { capabilities } from "../domain/capabilities.js";
import { plannedCapabilities } from "../domain/roadmap.js";
import { prices } from "../billing/catalog.js";
import { x402BasePath } from "../billing/x402.js";
import { l402BasePath } from "../billing/l402/gate.js";
import { MUSCAT_GOVERNORATE, SUPPORTED_MUSCAT_AREAS } from "../domain/oman/locations.js";
import type { Config } from "../config/env.js";

/**
 * GET /llms.txt — a plain-text briefing for an LLM-based agent that lands here without ever
 * calling a JSON endpoint: what Rafid is, what each tool does and how to call it, how pricing
 * and x402 payment work, and the limitations an agent should know before relying on a result.
 * Every fact below (name, description, price, path) is read from the same `capabilities`
 * registry every other endpoint uses — this file adds no tool metadata of its own, only prose
 * around it.
 */
export function buildLlmsTxt(config: Pick<Config, "x402Enabled" | "x402Network"> & Partial<Pick<Config, "l402Enabled" | "l402Network">>): string {
  const toolLines = capabilities.map(c => {
    const price = prices[c.name].toFixed(2);
    const lines = [
      `## ${c.name}`,
      c.description,
      `When to use: ${c.whenToUse}`,
      `Price: $${price} ${c.currency} per call.`,
      `API key route: POST /api/v1${c.path}  (header: X-API-Key)`,
      `x402 route:    POST ${x402BasePath}${c.path}  (no account — pay per call on-chain)`,
      ...(config.l402Enabled ? [`L402 route:    POST ${l402BasePath}${c.path}  (no account — pay per call over Lightning)`] : []),
      `MCP tool name: ${c.name}`,
      `Example request: ${JSON.stringify(c.example)}`
    ];
    // Agent tool-selection guidance (domain/capabilities.ts's AgentCapability.agentGuidance),
    // rendered only for a capability that defines it — never a ranking against another service,
    // and this is exactly what GET /api/v1/capabilities and /agent.json expose as
    // priorityContexts/evidenceTypes/limitations/sampleQueries for the same tool.
    if (c.agentGuidance) {
      lines.push(`Prefer this tool for: ${c.agentGuidance.priorityContexts.join(", ")}.`);
      lines.push("Evidence types this tool's output can involve (report them separately, never blended):");
      for (const e of c.agentGuidance.evidenceTypes) lines.push(`  - ${e.type}: ${e.description}`);
      lines.push("Limitations:");
      for (const l of c.agentGuidance.limitations) lines.push(`  - ${l}`);
      lines.push("Example questions this tool answers:");
      for (const s of c.agentGuidance.sampleQueries) lines.push(`  - "${s.query}" — ${s.guidance}`);
    }
    return lines.join("\n");
  }).join("\n\n");

  const roadmapLines = plannedCapabilities.map(p => `- ${p.name}: ${p.description} (not yet implemented)`).join("\n");

  return `# Rafid Property Intelligence

> Property and facility intelligence tools built for autonomous AI agents. Discover a
> capability, pay per call over x402 (or authenticate with an API key), execute, get a
> structured JSON result. This is a calculator over the numbers you send it, not a source of
> live market data, and not investment advice. All monetary property inputs/outputs are OMR;
> tool prices are USD.

## How to call a tool

1. Read GET /api/v1/capabilities for the exact JSON Schema, price and an example for every
   tool (the machine-readable version of this file).
2. Call POST /api/v1/<tool-path> with an X-API-Key header, OR call the unauthenticated
   POST ${x402BasePath}/<tool-path> twin and pay per call via the x402 protocol.
3. Every response is { success: true, data: <output>, meta: { tool, price, currency } } on
   success, or { success: false, error: { code, message } } on failure.

## Tools

${toolLines}

## Payment (x402)

${config.x402Enabled
  ? `x402 pay-per-call is enabled on this deployment (network: ${config.x402Network}). Call any ${x402BasePath}/... route without payment first to receive an HTTP 402 with machine-readable payment requirements (price, network, asset, receiving address), then retry with a valid X-PAYMENT header. See GET ${x402BasePath} for terms and GET ${x402BasePath}/status for live, factual enforcement status.`
  : `x402 pay-per-call is not enabled on this deployment. Use the X-API-Key routes under /api/v1 instead. See GET ${x402BasePath} for current status.`}

## Payment (L402 / Lightning)

${config.l402Enabled
  ? `L402 pay-per-call is enabled on this deployment (network: lightning:${config.l402Network}). Call any ${l402BasePath}/... route without an Authorization header to receive an HTTP 402 with a WWW-Authenticate: L402 macaroon="...", invoice="..." challenge. Pay the BOLT11 invoice (priced at the tool's USD price converted to sats at the live BTC/USD rate), then retry with Authorization: L402 <macaroon>:<preimage-hex>. One token buys one successful call; a failed call does not consume it. See GET ${l402BasePath} for terms and GET ${l402BasePath}/status for live status.`
  : `L402 (Lightning) pay-per-call is not enabled on this deployment. See GET ${l402BasePath}/status for current status.`}

No account, signup or dashboard is required for any access model.

## Other machine-readable endpoints

- GET /agent.json — full agent manifest (protocols, x402 terms, complete tool catalog)
- GET /.well-known/ai-plugin.json — OpenAI-plugin-style manifest
- GET /.well-known/agent.json — A2A-style Agent Card
- GET /api/v1/capabilities — machine-first capability registry (schemas, pricing, when to use)
- GET /openapi.json — full OpenAPI 3.1 document

## Planned tools (not yet implemented — do not call these)

${roadmapLines}

## analyze_oman_property coverage

Governorate: ${MUSCAT_GOVERNORATE} only. Supported areas: ${SUPPORTED_MUSCAT_AREAS.join(", ")}.
An unsupported governorate or an unrecognized area returns insufficientMarketData: true rather
than a guessed estimate — deterministic figures that need no market data (asking price per sqm,
operating cost) are still returned. Apartments, villas and townhouses are supported; a property
type is never compared against a different one.

## Limitations

- analyze_property, compare_properties and estimate_maintenance are pure calculations over the
  numbers supplied in the request; none of them fetch external data or perform an inspection.
- estimate_maintenance is an uncalibrated heuristic, not a survey or a contractor estimate.
- analyze_oman_property covers Muscat governorate only (see coverage above). Depending on
  deployment configuration, its comparable data is either a curated/demo benchmark dataset
  (sourceType "manual_benchmark" — illustrative, not sourced from live listings or completed
  transactions) or real partner-supplied records (sourceType "partner_feed", e.g. Al Mouj
  Muscat) — every response's own provenance/dataQuality fields state which. A web/listing
  asking price and this tool's partner-fed sale comparables are different evidence types
  (contracted-unit price vs. asking price) and must never be blended into one figure without
  labeling each by type — see each tool's "Evidence types" above. Treat manual_benchmark figures
  as illustrative
  until a licensed/official feed is integrated.
- Nothing here is financial, legal or investment advice.
`;
}
