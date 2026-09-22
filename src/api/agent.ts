import { z } from "zod";
import { capabilities } from "../domain/capabilities.js";
import { plannedCapabilities } from "../domain/roadmap.js";
import { prices } from "../billing/catalog.js";
import { x402BasePath } from "../billing/x402.js";
import type { Config } from "../config/env.js";

/** Section A/B/C route paths, defined once so app.ts and openapi.ts never disagree. */
export const agentBasePath = "/api/v1/agent";
export const pricingBasePath = "/api/v1/pricing";
export const toolsBasePath = "/api/v1/tools";
export const capabilitiesBasePath = "/api/v1/capabilities";

function summarizeOutput(schema: z.ZodType): string {
  const json = z.toJSONSchema(schema) as { properties?: Record<string, unknown> };
  const keys = Object.keys(json.properties ?? {});
  return keys.length ? `Returns ${keys.join(", ")}.` : "Returns a JSON object.";
}

/** GET /api/v1/agent — public, machine-readable service metadata for AI agents and
 *  agent marketplaces/directories. Distinct from the legacy "/" discovery payload
 *  (kept as-is for backward compatibility); this is the new, agent-marketplace-facing shape.
 *
 *  Rafid Agent API is agent-first: MCP and x402 are the primary interfaces an autonomous
 *  agent is expected to use end to end (discover a tool, pay per call, get a structured
 *  result, no account). The REST `X-API-Key` routes exist as an underlying transport and a
 *  compatibility layer for callers that can't do x402 yet — `protocols` below states that
 *  ordering explicitly rather than leaving it to be inferred. */
export function buildAgentInfo(config: Pick<Config, "x402Enabled" | "x402Network">) {
  return {
    name: "Rafid Property Intelligence",
    description: "Property and facility intelligence tools built for autonomous AI agents: discover a capability, pay per call over x402 (or authenticate with an API key), execute, get a structured result.",
    version: "0.1.0",
    audience: "ai-agents",
    protocols: [
      { protocol: "mcp", role: "primary", description: "Local stdio MCP server exposing every capability as a tool with strict input/output schemas.", transport: "stdio", remote: false },
      { protocol: "x402", role: "primary", enabled: config.x402Enabled, description: "Pay-per-call, no account or API key: discover price via GET " + x402BasePath + ", pay, call.", network: config.x402Enabled ? config.x402Network : null },
      { protocol: "rest", role: "compatibility", description: "X-API-Key authenticated REST routes. Underlying transport shared by MCP and the informational endpoints below; not the primary integration path for agents." }
    ],
    mcp: true,
    docs: "/docs",
    openapi: "/openapi.json",
    health: "/api/v1/health",
    manifest: "/agent.json",
    wellKnown: ["/.well-known/ai-plugin.json", "/.well-known/agent.json"],
    llmsTxt: "/llms.txt",
    pricing: pricingBasePath,
    tools: toolsBasePath,
    capabilities: capabilitiesBasePath,
    x402: x402BasePath,
    x402Enabled: config.x402Enabled,
    endpoints: capabilities.map(c => "/api/v1" + c.path),
    roadmap: plannedCapabilities
  };
}

/** GET /api/v1/pricing — reads the single centralized price catalog; never a second copy. */
export function buildPricingInfo() {
  return { currency: "USD", model: "pay-per-call", tools: { ...prices } };
}

/** GET /api/v1/tools — the agent-facing tool catalog: name, description, price, endpoint,
 *  method, input schema and a derived output summary for every capability. Kept as-is
 *  (summary rather than full output schema) for backward compatibility; GET /api/v1/capabilities
 *  below is the fuller, machine-first successor. */
export function buildToolCatalog() {
  return capabilities.map(c => ({
    name: c.name,
    description: c.description,
    price: prices[c.name],
    currency: "USD",
    endpoint: "/api/v1" + c.path,
    x402Endpoint: x402BasePath + c.path,
    method: "POST",
    inputSchema: z.toJSONSchema(c.input),
    outputSummary: summarizeOutput(c.output)
  }));
}

/**
 * GET /api/v1/capabilities — Section 8/13's machine-first capability registry, optimized for
 * an agent (or the model behind one) to decide what to call and how, without reading prose.
 * Every field is read directly off the single `capabilities` array in
 * src/domain/capabilities.ts — this function adds no metadata of its own beyond resolving the
 * runtime x402 network from config, so this endpoint can never drift from BillingService, the
 * x402 gate, or the MCP tool definitions.
 */
export function buildCapabilitiesRegistry(config: Pick<Config, "x402Enabled" | "x402Network">) {
  return capabilities.map(c => ({
    name: c.name,
    description: c.description,
    whenToUse: c.whenToUse,
    useCases: c.useCases,
    price: c.price,
    currency: c.currency,
    paymentProtocol: c.paymentProtocol,
    network: config.x402Enabled ? config.x402Network : null,
    idempotent: c.idempotent,
    sideEffects: c.sideEffects,
    endpoint: "/api/v1" + c.path,
    x402Endpoint: x402BasePath + c.path,
    method: "POST",
    inputSchema: { ...z.toJSONSchema(c.input), examples: [c.example] },
    outputSchema: z.toJSONSchema(c.output),
    // Agent tool-selection guidance (see AgentCapability.agentGuidance in domain/capabilities.ts):
    // priorityContexts/evidenceTypes/limitations/sampleQueries, or omitted fields when a
    // capability defines no agentGuidance. Read straight off the registry — never a second copy.
    priorityContexts: c.agentGuidance?.priorityContexts ?? [],
    evidenceTypes: c.agentGuidance?.evidenceTypes ?? [],
    limitations: c.agentGuidance?.limitations ?? [],
    sampleQueries: c.agentGuidance?.sampleQueries ?? []
  }));
}
