import { z } from "zod";
import { capabilities } from "../domain/capabilities.js";
import { plannedCapabilities } from "../domain/roadmap.js";
import { prices } from "../billing/catalog.js";
import { x402BasePath } from "../billing/x402.js";
import { l402BasePath } from "../billing/l402/gate.js";
import { mppBasePath } from "../billing/mpp/routes.js";
import type { Config } from "../config/env.js";

/** Payment-rail config every discovery builder reads. l402/mpp are optional so existing callers
 *  (and tests) that pass only the x402 fields keep compiling and keep their exact output. */
export type PaymentDiscoveryConfig = Pick<Config, "x402Enabled" | "x402Network"> & Partial<Pick<Config, "l402Enabled" | "l402Network" | "mpp">>;

/** Enabled pay-per-call / metered rails, in the order an agent should consider them. Read from
 *  config — a rail that isn't mounted is never advertised. */
export function paymentMethodsFor(config: PaymentDiscoveryConfig): string[] {
  return [
    ...(config.x402Enabled ? ["x402"] : []),
    ...(config.l402Enabled ? ["l402"] : []),
    ...(config.mpp?.enabled && config.mpp.modes.includes("charge") ? ["mpp-charge"] : []),
    ...(config.mpp?.enabled && config.mpp.modes.includes("session") ? ["mpp-session"] : [])
  ];
}

/** Top-level `payments` summary for /agent.json, /.well-known/agent.json and /api/v1/agent. */
export function buildPaymentsSummary(config: PaymentDiscoveryConfig) {
  const mpp = config.mpp;
  return {
    x402: config.x402Enabled,
    l402: Boolean(config.l402Enabled),
    mpp: mpp?.enabled
      ? {
          enabled: true,
          modes: [...mpp.modes],
          info: mppBasePath,
          status: mppBasePath + "/status",
          chargeMethods: mpp.modes.includes("charge") ? mpp.chargeMethods.map(m => `${m}/charge`) : [],
          sessionMethod: mpp.modes.includes("session") ? "tempo/session" : null,
          network: mpp.tempo.network,
          authorization: "Authorization: Payment <credential>"
        }
      : { enabled: false, modes: [] as string[] }
  };
}

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
export function buildAgentInfo(config: PaymentDiscoveryConfig) {
  return {
    name: "Rafid Property Intelligence",
    description: "Property and facility intelligence tools built for autonomous AI agents: discover a capability, pay per call over x402 (or authenticate with an API key), execute, get a structured result.",
    version: "0.1.0",
    audience: "ai-agents",
    protocols: [
      { protocol: "mcp", role: "primary", description: "Local stdio MCP server exposing every capability as a tool with strict input/output schemas.", transport: "stdio", remote: false },
      { protocol: "x402", role: "primary", enabled: config.x402Enabled, description: "Pay-per-call, no account or API key: discover price via GET " + x402BasePath + ", pay, call.", network: config.x402Enabled ? config.x402Network : null },
      ...(config.l402Enabled ? [{ protocol: "l402", role: "primary", enabled: true, description: "Pay-per-call over Lightning, no account or API key: POST " + l402BasePath + "/<tool> returns a 402 with an L402 macaroon + invoice; pay, retry with Authorization: L402 <macaroon>:<preimage>.", network: `lightning:${config.l402Network}` }] : []),
      ...(config.mpp?.enabled ? [{ protocol: "mpp", role: "primary", enabled: true, modes: [...config.mpp.modes], description: "Machine Payments Protocol (HTTP 'Payment' auth scheme): POST " + mppBasePath + "/charge/<tool> for a one-time payment per call, or POST " + mppBasePath + "/sessions to open a budgeted, metered session and call tools under it.", network: config.mpp.tempo.network }] : []),
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
    ...(config.l402Enabled ? { l402: l402BasePath, l402Enabled: true } : {}),
    ...(config.mpp?.enabled ? { mpp: mppBasePath, mppEnabled: true } : {}),
    payments: buildPaymentsSummary(config),
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
export function buildCapabilitiesRegistry(config: PaymentDiscoveryConfig) {
  const paymentMethods = paymentMethodsFor(config);
  const mppCharge = paymentMethods.includes("mpp-charge");
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
    // Additive (MPP rollout): every enabled payment rail for this tool, and the MPP charge route
    // when MPP charge mode is on. Session calls use POST /api/v1/mpp/sessions/{id}/tools/{name}.
    paymentMethods,
    ...(mppCharge ? { mppChargeEndpoint: `${mppBasePath}/charge/${c.name}` } : {}),
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
