import { z } from "zod";
import { capabilities } from "../domain/capabilities.js";
import { prices } from "../billing/catalog.js";
import { x402BasePath } from "../billing/x402.js";
import { agentBasePath, buildAgentInfo, buildCapabilitiesRegistry, buildPricingInfo, buildToolCatalog, capabilitiesBasePath, pricingBasePath, toolsBasePath } from "./agent.js";
import { buildAgentCard, buildAgentManifest, buildAiPluginManifest } from "./manifest.js";
import { buildLlmsTxt } from "./llms-txt.js";
import { buildX402Status } from "../billing/x402.js";
import { l402BasePath } from "../billing/l402/gate.js";
import { buildMcpStatus, mcpStatusBasePath } from "../mcp/remote.js";
import { buildMppOpenapiPaths } from "../billing/mpp/openapi.js";
import type { MppConfig } from "../billing/mpp/config.js";
const json = (schema: unknown, example?: unknown, summary = "Example") => ({ "application/json": {
  schema, ...(example === undefined ? {} : { examples: { default: { summary, value: example } } })
} });
const meta = { type: "object", required: ["requestId"], properties: { requestId: { type: "string" } } };
const success = (data: unknown) => ({ type: "object", required: ["success", "data", "meta"], properties: { success: { const: true }, data, meta } });
const errorSchema = {
  type: "object", required: ["success", "error", "meta"], properties: {
    success: { const: false }, meta,
    error: { type: "object", required: ["code", "message"], properties: {
      code: { type: "string" }, message: { type: "string" },
      details: { type: "array", items: { type: "object", required: ["path", "message"], properties: { path: { type: "string" }, message: { type: "string" } } } }
    } }
  }
};
const errors = Object.fromEntries([
  [400, "INVALID_INPUT", "Input validation failed"], [401, "UNAUTHORIZED", "A valid X-API-Key header is required"],
  [413, "PAYLOAD_TOO_LARGE", "Request body exceeds 32kb"], [415, "UNSUPPORTED_MEDIA_TYPE", "Use application/json"],
  [429, "RATE_LIMITED", "Per-minute limit or monthly quota exceeded (QUOTA_EXCEEDED)"], [503, "SERVICE_UNAVAILABLE", "Customer or usage storage unavailable"], [500, "INTERNAL_ERROR", "An unexpected error occurred"]
].map(([status, code, message]) => [status, { description: message, content: json(errorSchema, { success: false, error: { code, message }, meta: { requestId: "example-request" } }) }]));
const x402Errors = Object.fromEntries(Object.entries(errors).filter(([status]) => status !== "401"));
const toolMeta = { type: "object", required: ["requestId", "tool", "price", "currency"], properties: { requestId: { type: "string" }, tool: { type: "string" }, price: { type: "number" }, currency: { type: "string" } } };
const toolSuccess = (data: unknown) => ({ type: "object", required: ["success", "data", "meta"], properties: { success: { const: true }, data, meta: toolMeta } });

export function buildOpenapi(config: { x402Enabled: boolean; x402Network: string; x402WalletAddress: string; cdpConfigured: boolean; mcpRemoteEnabled: boolean; logoUrl: string; contactEmail: string; legalInfoUrl: string; l402Enabled?: boolean; l402Network?: "mainnet" | "testnet" | "signet" | "regtest"; mpp?: MppConfig } = { x402Enabled: false, x402Network: "", x402WalletAddress: "", cdpConfigured: false, mcpRemoteEnabled: false, logoUrl: "", contactEmail: "", legalInfoUrl: "" }) {
const paths: Record<string, unknown> = {};
for (const c of capabilities) {
  const operation = {
    operationId: c.name,
    tags: [
      c.name === "estimate_maintenance" ? "Maintenance" :
      c.name === "analyze_oman_property" ? "Oman" :
      c.name === "research_company" || c.name === "find_companies" || c.name === "analyze_company_risk" ? "Intelligence" :
      c.name === "oman_supplier_check" ? "Procurement" :
      "Property"
    ],
    summary: c.description,
    description: `${c.description} Click Authorize and enter an active Rafid API key before using Try it out.`,
    security: [{ ApiKeyAuth: [] }],
    requestBody: { required: true, description: "Strict JSON input; unknown fields are rejected.", content: json(z.toJSONSchema(c.input), c.example, `${c.name} request`) },
    responses: {
      "200": { description: "Calculated metrics", content: json(toolSuccess(z.toJSONSchema(c.output)), { success: true, data: c.exampleOutput, meta: { requestId: "example-request", tool: c.name, price: prices[c.name], currency: "USD" } }, `${c.name} response`) },
      ...errors
    }
  };
  paths["/api/v1" + c.path] = { post: operation };
  paths["/v1" + c.path] = { post: { ...operation, operationId: c.name + "_legacy", deprecated: true } };
}
if (config.x402Enabled) {
  for (const c of capabilities) {
    paths[x402BasePath + c.path] = { post: {
      operationId: c.name + "_x402",
      tags: ["x402"],
      summary: `${c.description} (pay-per-call via x402, no API key)`,
      description: "Requires a valid X-PAYMENT header per the x402 protocol instead of X-API-Key. Send the request without an X-PAYMENT header first to receive a 402 response listing accepted payment options (price, network and receiving address).",
      security: [],
      requestBody: { required: true, description: "Strict JSON input; unknown fields are rejected.", content: json(z.toJSONSchema(c.input), c.example, `${c.name} request`) },
      responses: {
        "200": { description: "Calculated metrics", content: json(toolSuccess(z.toJSONSchema(c.output)), { success: true, data: c.exampleOutput, meta: { requestId: "example-request", tool: c.name, price: prices[c.name], currency: "USD" } }, `${c.name} response`) },
        "402": { description: `Payment required — ${prices[c.name].toFixed(2)} USD in USDC on ${config.x402Network}. Response body lists accepted payment options per the x402 protocol.` },
        ...x402Errors
      }
    } };
  }
}
if (config.l402Enabled) {
  for (const c of capabilities) {
    paths[l402BasePath + c.path] = { post: {
      operationId: c.name + "_l402",
      tags: ["L402"],
      summary: `${c.description} (pay-per-call via L402 / Lightning, no API key)`,
      description: "Requires `Authorization: L402 <macaroon>:<preimage-hex>` instead of X-API-Key. Send the request without an Authorization header first to receive a 402 whose WWW-Authenticate header carries an L402 macaroon and a BOLT11 invoice (the tool's USD price converted to sats at the live BTC/USD rate). Pay the invoice, then retry with the macaroon and the payment preimage. One token buys one successful call.",
      security: [],
      requestBody: { required: true, description: "Strict JSON input; unknown fields are rejected.", content: json(z.toJSONSchema(c.input), c.example, `${c.name} request`) },
      responses: {
        "200": { description: "Calculated metrics", content: json(toolSuccess(z.toJSONSchema(c.output)), { success: true, data: c.exampleOutput, meta: { requestId: "example-request", tool: c.name, price: prices[c.name], currency: "USD" } }, `${c.name} response`) },
        "402": { description: `Payment required — ${prices[c.name].toFixed(2)} USD, payable in BTC over Lightning (lightning:${config.l402Network ?? "mainnet"}). See the WWW-Authenticate header (L402 macaroon + invoice).` },
        "503": { description: "No BTC/USD rate or Lightning invoice could be produced right now; retry or use x402/API-key access." },
        ...x402Errors
      }
    } };
  }
}
for (const path of ["/api/v1/health", "/health"]) {
  paths[path] = { get: { operationId: path === "/health" ? "health_legacy" : "health", tags: ["System"], summary: "Process liveness", description: "Public liveness endpoint. No API key is required.", security: [],
    responses: { "200": { description: "Alive", content: json(success({ type: "object", required: ["ok"], properties: { ok: { const: true } } }), { success: true, data: { ok: true }, meta: { requestId: "example-request" } }) } }
  } };
}
const discoverySchema = { type: "object", required: ["name", "version", "docs", "openapi", "health", "endpoints"], properties: {
  name: { type: "string" }, version: { type: "string" }, docs: { type: "string" }, openapi: { type: "string" }, health: { type: "string" },
  agent: { type: "string" }, pricing: { type: "string" }, tools: { type: "string" }, x402: { type: "string" }, endpoints: { type: "array", items: { type: "string" } }
} };
const discoveryExample = { success: true, data: { name: "Rafid Agent API", version: "0.1.0", docs: "/docs", openapi: "/openapi.json", health: "/api/v1/health", agent: agentBasePath, pricing: pricingBasePath, tools: toolsBasePath, ...(config.x402Enabled ? { x402: x402BasePath } : {}), endpoints: capabilities.map(c => "/api/v1" + c.path) }, meta: { requestId: "example-request" } };
paths["/"] = { get: { operationId: "discovery", tags: ["System"], summary: "Service metadata or a browser-facing landing page", description: "Returns an HTML landing page for browsers (Accept: text/html, the default) and a JSON discovery payload for machine/agent clients that send Accept: application/json.", security: [], responses: {
  "200": { description: "Discovery (JSON) or landing page (HTML)", content: {
    ...json(discoverySchema, discoveryExample),
    "text/html": { schema: { type: "string" } }
  } }
} } };
paths["/docs"] = { get: { operationId: "swagger_docs", tags: ["System"], summary: "Interactive Swagger UI", description: "Browser interface for exploring the API, authorizing with X-API-Key, and sending test requests.", security: [], responses: {
  "200": { description: "Swagger UI HTML", content: { "text/html": { schema: { type: "string" } } } }
} } };
paths["/openapi.json"] = { get: { operationId: "openapi", tags: ["System"], summary: "Raw OpenAPI discovery document (no envelope)", security: [], responses: {
  "200": { description: "OpenAPI 3.1 document", content: json({ type: "object", required: ["openapi", "info", "paths"], properties: { openapi: { type: "string" }, info: { type: "object" }, paths: { type: "object" } } }) }
} } };
// Section A/B/C: agent-marketplace discovery, pricing and tool catalog. Always present
// regardless of X402_ENABLED, and reuse the exact same builder functions app.ts calls at
// request time, so this document can never drift from the live response shape.
paths[agentBasePath] = { get: { operationId: "agent", tags: ["Agent"], summary: "Agent-marketplace metadata", description: "Machine-readable service metadata for AI agents and agent directories/marketplaces.", security: [],
  responses: { "200": { description: "Agent metadata", content: json(success({ type: "object", required: ["name", "description", "version", "mcp", "openapi", "pricing", "x402"], properties: {
    name: { type: "string" }, description: { type: "string" }, version: { type: "string" }, mcp: { type: "boolean" },
    docs: { type: "string" }, openapi: { type: "string" }, health: { type: "string" }, pricing: { type: "string" }, tools: { type: "string" },
    x402: { type: "string" }, x402Enabled: { type: "boolean" }, endpoints: { type: "array", items: { type: "string" } }
  } }), { success: true, data: buildAgentInfo(config), meta: { requestId: "example-request" } }) } }
} };
paths[pricingBasePath] = { get: { operationId: "pricing", tags: ["Agent"], summary: "Pay-per-call pricing", description: "Structured, centralized pricing for every tool. Sourced from a single price catalog shared with the x402 payment gate — never duplicated.", security: [],
  responses: { "200": { description: "Pricing", content: json(success({ type: "object", required: ["currency", "model", "tools"], properties: {
    currency: { type: "string" }, model: { type: "string" }, tools: { type: "object", additionalProperties: { type: "number" } }
  } }), { success: true, data: buildPricingInfo(), meta: { requestId: "example-request" } }) } }
} };
paths[toolsBasePath] = { get: { operationId: "tools", tags: ["Agent"], summary: "Tool catalog for AI agents", description: "Every tool available to AI agents: name, description, price, endpoint, method, input JSON Schema and a derived output summary.", security: [],
  responses: { "200": { description: "Tool catalog", content: json(success({ type: "array", items: { type: "object", required: ["name", "description", "price", "currency", "endpoint", "method", "inputSchema", "outputSummary"], properties: {
    name: { type: "string" }, description: { type: "string" }, price: { type: "number" }, currency: { type: "string" },
    endpoint: { type: "string" }, x402Endpoint: { type: "string" }, method: { type: "string" }, inputSchema: { type: "object" }, outputSummary: { type: "string" }
  } } }), { success: true, data: buildToolCatalog(), meta: { requestId: "example-request" } }) } }
} };
// Section F: always-on x402 protocol/pricing information, separate from the payment-gated
// POST routes (which only exist when X402_ENABLED=true and are documented above).
paths[x402BasePath] = { get: { operationId: "x402_info", tags: ["x402"], summary: "x402 protocol and pricing information", description: "Always available, independent of X402_ENABLED, so an agent can discover pricing/network support before deciding whether to pay. No wallet secret is ever included.", security: [],
  responses: { "200": { description: "x402 protocol info", content: json(success({ type: "object", required: ["protocol", "x402Version", "scheme", "enabled", "tools"], properties: {
    protocol: { type: "string" }, x402Version: { type: "integer" }, scheme: { type: "string" }, enabled: { type: "boolean" },
    network: { type: ["string", "null"] }, payTo: { type: ["string", "null"] }, facilitator: { type: ["string", "null"] },
    tools: { type: "array", items: { type: "object", required: ["name", "endpoint", "price"], properties: { name: { type: "string" }, endpoint: { type: "string" }, price: { type: "number" } } } }
  } }), { success: true, data: { protocol: "x402", x402Version: 2, scheme: "exact", enabled: config.x402Enabled, network: config.x402Enabled ? config.x402Network : null, payTo: null, facilitator: null, tools: capabilities.map(c => ({ name: c.name, endpoint: x402BasePath + c.path, price: prices[c.name] })) }, meta: { requestId: "example-request" } }) } }
} };
// Section F hardening: a small, always-on, factual runtime status report distinct from the
// informational endpoint above — see buildX402Status()'s doc comment for exactly why each
// field is safe to expose and cannot silently disagree with reality.
paths[x402BasePath + "/status"] = { get: { operationId: "x402_status", tags: ["x402"], summary: "Factual x402 runtime status", description: "A small, always-on status report so a caller never has to infer payment enforcement from marketing copy: every field is read directly from validated configuration. Never includes a wallet private key or any other secret.", security: [],
  responses: { "200": { description: "x402 runtime status", content: json(success({ type: "object", required: ["enabled", "mode", "network", "asset", "facilitator", "walletConfigured", "paymentEnforcement"], properties: {
    enabled: { type: "boolean" }, mode: { type: "string", enum: ["disabled", "testnet", "production"] },
    network: { type: ["string", "null"] }, asset: { type: ["string", "null"] }, facilitator: { type: ["string", "null"] },
    walletConfigured: { type: "boolean" }, paymentEnforcement: { type: "boolean" }
  } }), { success: true, data: buildX402Status(config), meta: { requestId: "example-request" } }) } }
} };
// L402 (Lightning) info + status — always available, independent of L402_ENABLED.
paths[l402BasePath] = { get: { operationId: "l402_info", tags: ["L402"], summary: "L402 (Lightning) protocol and pricing information", description: "Always available, independent of L402_ENABLED. USD prices per tool; the sats amount is quoted per 402 challenge at the live BTC/USD rate. No secret is ever included.", security: [],
  responses: { "200": { description: "L402 protocol info", content: json(success({ type: "object", required: ["protocol", "enabled", "tools"], properties: {
    protocol: { type: "string" }, spec: { type: "string" }, enabled: { type: "boolean" }, network: { type: ["string", "null"] }, currency: { type: "string" },
    pricing: { type: "string" }, tokenPolicy: { type: "string" }, authorization: { type: "string" },
    tools: { type: "array", items: { type: "object", required: ["name", "endpoint", "priceUsd"], properties: { name: { type: "string" }, endpoint: { type: "string" }, priceUsd: { type: "number" } } } }
  } })) } }
} };
paths[l402BasePath + "/status"] = { get: { operationId: "l402_status", tags: ["L402"], summary: "Factual L402 runtime status", description: "Always-on status read directly from validated configuration. Never includes the root key, LND macaroon or any other secret.", security: [],
  responses: { "200": { description: "L402 runtime status", content: json(success({ type: "object", required: ["enabled", "mode", "paymentEnforcement"], properties: {
    enabled: { type: "boolean" }, mode: { type: "string", enum: ["disabled", "testnet", "production"] }, network: { type: ["string", "null"] },
    asset: { type: ["string", "null"] }, backend: { type: ["string", "null"] }, lightningBackendConfigured: { type: "boolean" },
    rootKeyConfigured: { type: "boolean" }, paymentEnforcement: { type: "boolean" }
  } })) } }
} };
// Section 3/4/5/8: top-level agent discovery. All four reuse the exact builder functions
// app.ts calls at request time, so this document can never drift from the live responses.
const exampleOrigin = "https://api.rafidsystem.com";
paths[capabilitiesBasePath] = { get: { operationId: "capabilities", tags: ["Agent"], summary: "Machine-first capability registry", description: "The full capability registry — schemas, pricing, when to use, examples — optimized for an agent (or the model behind it) to decide what to call without reading prose. The single source every other discovery endpoint here reuses.", security: [],
  responses: { "200": { description: "Capability registry", content: json(success({ type: "array", items: { type: "object", required: ["name", "description", "whenToUse", "price", "currency", "paymentProtocol", "endpoint", "inputSchema", "outputSchema"], properties: {
    name: { type: "string" }, description: { type: "string" }, whenToUse: { type: "string" }, useCases: { type: "array", items: { type: "string" } },
    price: { type: "number" }, currency: { type: "string" }, paymentProtocol: { type: "string" }, network: { type: ["string", "null"] },
    idempotent: { type: "boolean" }, sideEffects: { type: "boolean" }, endpoint: { type: "string" }, x402Endpoint: { type: "string" }, method: { type: "string" },
    inputSchema: { type: "object" }, outputSchema: { type: "object" },
    // Agent tool-selection guidance (AgentCapability.agentGuidance, domain/capabilities.ts):
    // internal recommendation metadata for an agent deciding whether/how to call this tool —
    // never a ranking against a competing service. Empty arrays for a capability with no
    // agentGuidance defined.
    priorityContexts: { type: "array", items: { type: "string" }, description: "Situations/domains where this tool is the right call; not a comparison to any other service." },
    evidenceTypes: { type: "array", items: { type: "object", required: ["type", "description"], properties: { type: { type: "string" }, description: { type: "string" } } }, description: "Distinct kinds of price/comparable evidence this tool's output can involve (e.g. web asking price vs. partner-fed contracted price); report each separately, never blended." },
    limitations: { type: "array", items: { type: "string" }, description: "Hard caveats an agent must account for before treating this tool's output as authoritative." },
    sampleQueries: { type: "array", items: { type: "object", required: ["query", "guidance"], properties: { query: { type: "string" }, guidance: { type: "string" } } }, description: "Worked example end-user questions this tool answers, each with how an agent should use the response." }
  } } }), { success: true, data: buildCapabilitiesRegistry(config), meta: { requestId: "example-request" } }) } }
} };
paths["/agent.json"] = { get: { operationId: "agent_manifest", tags: ["Agent"], summary: "Full agent manifest", description: "Comprehensive, unauthenticated discovery document: product identity, every supported protocol (MCP, x402, REST), the OpenAPI URL, x402 terms and the complete tool catalog with full input/output JSON Schemas. No secrets.", security: [],
  responses: { "200": { description: "Agent manifest", content: json({ type: "object" }, buildAgentManifest(config)) } }
} };
paths["/.well-known/ai-plugin.json"] = { get: { operationId: "ai_plugin_manifest", tags: ["Agent"], summary: "OpenAI-plugin-style manifest", description: "Manifest in the legacy OpenAI ChatGPT-plugin convention, for tooling that still discovers services this way.", security: [],
  responses: { "200": { description: "ai-plugin.json manifest", content: json({ type: "object" }, buildAiPluginManifest(config, exampleOrigin)) } }
} };
paths["/.well-known/agent.json"] = { get: { operationId: "agent_card", tags: ["Agent"], summary: "A2A-style Agent Card", description: "Agent Card in the Agent2Agent (A2A) protocol's convention at this well-known path, listing each tool as a skill.", security: [],
  responses: { "200": { description: "Agent Card", content: json({ type: "object" }, buildAgentCard(config, exampleOrigin)) } }
} };
if (config.mcpRemoteEnabled) {
  paths["/mcp"] = { post: { operationId: "mcp_remote", tags: ["Agent"], summary: "Remote MCP transport (Streamable HTTP, JSON-RPC 2.0)", description: "Not a REST endpoint: this is the MCP Streamable HTTP transport, carrying JSON-RPC 2.0 requests (initialize, tools/list, tools/call, ...) per the Model Context Protocol specification, not an OpenAPI-shaped request/response. Stateless (no session ID), so every request is self-contained. See GET " + mcpStatusBasePath + " to check whether this transport is live, and /llms.txt for a plain-text connection summary.", security: [],
    requestBody: { required: true, description: "A JSON-RPC 2.0 request object.", content: { "application/json": { schema: { type: "object", required: ["jsonrpc", "method"], properties: { jsonrpc: { const: "2.0" }, id: {}, method: { type: "string" }, params: { type: "object" } } } } } },
    responses: { "200": { description: "A JSON-RPC 2.0 response (or an SSE stream negotiated via the Accept header)." } }
  } };
}
paths[mcpStatusBasePath] = { get: { operationId: "mcp_status", tags: ["Agent"], summary: "Factual MCP transport status", description: "Always-on status report for MCP connectivity: which transports are live (stdio always, http only when MCP_REMOTE_ENABLED=true), the tool count, and the remote endpoint path if any. No secret, no session data.", security: [],
  responses: { "200": { description: "MCP status", content: json(success({ type: "object", required: ["enabled", "transport", "tools", "endpoint"], properties: {
    enabled: { type: "boolean" }, transport: { type: "array", items: { type: "string" } }, tools: { type: "integer" }, endpoint: { type: ["string", "null"] }
  } }), { success: true, data: buildMcpStatus(config), meta: { requestId: "example-request" } }) } }
} };
paths["/llms.txt"] = { get: { operationId: "llms_txt", tags: ["Agent"], summary: "Plain-text briefing for LLM-based agents", description: "What Rafid does, every tool and how to call it, pricing, the x402 payment model and known limitations, in plain text for an agent that hasn't called a JSON endpoint yet.", security: [],
  responses: { "200": { description: "llms.txt", content: { "text/plain": { schema: { type: "string" }, example: buildLlmsTxt(config) } } } }
} };
// MPP (Machine Payments Protocol): info/status always, payment routes only when MPP_ENABLED=true.
Object.assign(paths, buildMppOpenapiPaths(config.mpp));
return {
  openapi: "3.1.0", info: { title: "Rafid Agent API", version: "0.1.0", description: "Property intelligence calculations in OMR for agents and applications. Use Authorize to set X-API-Key. Maintenance is an uncalibrated heuristic. Monetary outputs are rounded to two decimals. Aliases maintenance and maintenanceCost are mutually exclusive; comparison names must be unique." },
  tags: [
    { name: "Property", description: "Property analysis and comparison calculations." },
    { name: "Maintenance", description: "Annual maintenance reserve estimation." },
    { name: "Oman", description: "Oman/Muscat-specific property analysis using local rental/sale comparables, normalization, confidence scoring and provenance. Muscat governorate only; see GET /llms.txt for supported areas and data limitations." },
    { name: "Intelligence", description: "Rafid Agent Intelligence: company research, discovery and evidence-tiered risk signals from public web sources. Inert (no external calls) until an operator configures the relevant provider — see GET /llms.txt." },
    { name: "Procurement", description: "Procurement supplier screening for AI procurement agents: oman_supplier_check screens an Oman supplier (identity, activity, website/contact/address consistency, sanctions and public-risk indicators) before an RFQ. Screening only — not KYC/AML or vendor approval." },
    { name: "Agent", description: "Public discovery, pricing and tool-catalog endpoints for AI agents and agent marketplaces." },
    { name: "System", description: "Public discovery, health and documentation endpoints." },
    { name: "x402", description: "Pay-per-call protocol information, always available; payment-gated endpoints are settled on-chain via the x402 protocol and require no account or API key." },
    { name: "L402", description: "Pay-per-call over the Bitcoin Lightning Network via the L402 protocol (macaroon + BOLT11 invoice); no account or API key. Payment-gated endpoints exist only when L402_ENABLED=true." },
    { name: "MPP", description: "Machine Payments Protocol (HTTP 'Payment' auth scheme, https://mpp.dev): one-time charges per call and budgeted, metered sessions over Tempo payment channels; no account or API key. Payment-gated endpoints exist only when MPP_ENABLED=true." }
  ],
  servers: [{ url: "/" }], paths,
  components: { securitySchemes: { ApiKeyAuth: { type: "apiKey", in: "header", name: "X-API-Key", description: "Enter an active Rafid API key. Swagger UI sends it in the X-API-Key request header." } } }
};
}
