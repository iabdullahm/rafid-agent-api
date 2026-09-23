import { capabilities, CURRENCY } from "../domain/capabilities.js";
import { plannedCapabilities } from "../domain/roadmap.js";
import { buildAccountBillingSummary, buildCapabilitiesRegistry, buildPaymentsSummary } from "./agent.js";
import { accountPaymentMethodIds, paymentMethodsPath, railAvailability } from "../billing/unified/discovery.js";
import { mcpCreditsPath } from "../billing/unified/mcp.js";
import { mppBasePath } from "../billing/mpp/routes.js";
import { x402BasePath } from "../billing/x402.js";
import { l402BasePath } from "../billing/l402/gate.js";
import { mcpRemotePath } from "../mcp/remote.js";
import type { Config } from "../config/env.js";

type ManifestConfig = Pick<Config, "x402Enabled" | "x402Network" | "x402WalletAddress" | "cdpConfigured" | "mcpRemoteEnabled"> & Partial<Pick<Config, "l402Enabled" | "l402Network" | "mpp" | "billing">>;
type PluginManifestConfig = Pick<Config, "logoUrl" | "contactEmail" | "legalInfoUrl"> & Partial<Pick<Config, "x402Enabled" | "x402Network" | "billing">>;

const PRODUCT_NAME = "Rafid Property Intelligence";
const PRODUCT_DESCRIPTION =
  "Property and facility intelligence tools built for autonomous AI agents: discover a capability, " +
  "pay per call over x402 (or authenticate with an API key), execute, get a structured result. " +
  "Not designed primarily as a human dashboard product.";

/** Shared by every manifest below, so "mcp"/"x402"/"rest" and their roles are described
 *  identically everywhere rather than redrifting per document. Remote MCP is only ever
 *  mentioned when MCP_REMOTE_ENABLED=true (config.mcpRemoteEnabled) — otherwise every manifest
 *  and llms.txt describe stdio only, so a manifest can never advertise an endpoint app.ts
 *  didn't actually mount (see api/app.ts). */
function protocolList(config: Pick<Config, "x402Enabled" | "x402Network" | "mcpRemoteEnabled"> & Partial<Pick<Config, "l402Enabled" | "l402Network" | "mpp" | "billing">>) {
  return [
    {
      protocol: "mcp", role: "primary" as const,
      transports: config.mcpRemoteEnabled ? ["stdio", "http"] : ["stdio"],
      remote: config.mcpRemoteEnabled,
      endpoint: config.mcpRemoteEnabled ? mcpRemotePath : null,
      description: config.mcpRemoteEnabled
        ? `Every capability exposed as an MCP tool with strict input/output schemas, over local stdio (\`npm run mcp\`) or the remote Streamable HTTP transport at ${mcpRemotePath}.`
        : "Every capability exposed as an MCP tool with strict input/output schemas. Not remotely hosted in this environment — run `npm run mcp` after cloning."
    },
    { protocol: "x402", role: "primary" as const, enabled: config.x402Enabled, network: config.x402Enabled ? config.x402Network : null, description: "Pay-per-call, no account or API key required." },
    ...(config.l402Enabled ? [{ protocol: "l402", role: "primary" as const, enabled: true, network: `lightning:${config.l402Network}`, endpoint: l402BasePath, description: "Pay-per-call over Lightning (L402: macaroon + BOLT11 invoice), no account or API key required." }] : []),
    ...(config.mpp?.enabled ? [{ protocol: "mpp", role: "primary" as const, enabled: true, modes: [...config.mpp.modes], network: config.mpp.tempo.network, endpoint: mppBasePath, description: "Machine Payments Protocol (HTTP 'Payment' auth scheme): one-time charges per call, or budgeted metered sessions (TIP-1034 payment channels) for high-frequency agents. No account or API key required." }] : []),
    // Unified billing (additive, only when enabled): no wallet needed — a Rafid API key pays from
    // a subscription allowance and/or prepaid USD credits at the same per-tool prices.
    ...(railAvailability(config).billing ? [{ protocol: "api-key-billing", role: "primary" as const, enabled: true, authentication: "Authorization: Bearer raf_live_…", paymentMethods: accountPaymentMethodIds(config), endpoint: "/api/v1/<tool-path>", ...(config.mcpRemoteEnabled ? { mcpEndpoint: mcpCreditsPath } : {}), description: "No wallet required: create a Rafid API key, preload USD credit or hold a subscription, and every paid tool call is deducted automatically at its listed price." }] : []),
    { protocol: "rest", role: "compatibility" as const, description: "X-API-Key authenticated HTTP routes; the underlying transport MCP and the informational endpoints share, and a fallback for callers that can't do x402 yet." }
  ];
}

/**
 * GET /agent.json — the full agent manifest (Section 3): product identity, every supported
 * protocol, the MCP transport, the OpenAPI URL, x402 terms (network/currency/facilitator/pay
 * address — never a secret), and the complete tool catalog with full input AND output JSON
 * Schemas. Everything under `tools` comes from buildCapabilitiesRegistry(), i.e. the same
 * single capability registry every other endpoint in this project reads — this file adds no
 * tool metadata of its own.
 */
export function buildAgentManifest(config: ManifestConfig) {
  return {
    name: PRODUCT_NAME,
    description: PRODUCT_DESCRIPTION,
    version: "0.1.0",
    audience: "ai-agents",
    protocols: protocolList(config),
    interfaces: {
      mcp: config.mcpRemoteEnabled ? { transports: ["stdio", "http"], remote: true, endpoint: mcpRemotePath } : { transports: ["stdio"], remote: false },
      openapi: "/openapi.json",
      docs: "/docs",
      rest: { role: "compatibility", baseUrl: "/api/v1" }
    },
    x402: {
      enabled: config.x402Enabled,
      network: config.x402Enabled ? config.x402Network : null,
      currency: CURRENCY,
      facilitator: config.x402Enabled ? (config.cdpConfigured ? "coinbase-cdp" : "public") : null,
      payTo: config.x402Enabled ? config.x402WalletAddress : null,
      info: x402BasePath,
      status: x402BasePath + "/status"
    },
    // Additive (MPP rollout): which payment rails are live, in one place.
    payments: buildPaymentsSummary(config),
    paymentMethods: paymentMethodsPath,
    ...(railAvailability(config).billing ? { billing: buildAccountBillingSummary(config) } : {}),
    currency: CURRENCY,
    tools: buildCapabilitiesRegistry(config),
    roadmap: plannedCapabilities,
    wellKnown: ["/.well-known/ai-plugin.json", "/.well-known/agent.json"],
    llmsTxt: "/llms.txt"
  };
}

/**
 * GET /.well-known/ai-plugin.json — the OpenAI-plugin-manifest convention. `origin` is the
 * request's own scheme+host (computed per request in app.ts), so `api.url` is always correct
 * for whatever URL the server is actually reachable at (localhost, a Vercel preview, or the
 * production domain) rather than a hardcoded string.
 *
 * `logo_url`, `contact_email` and `legal_info_url` come from RAFID_LOGO_URL / RAFID_CONTACT_EMAIL
 * / RAFID_LEGAL_INFO_URL (config/env.ts), each defaulting to an empty string. Nothing here is
 * hardcoded: an unset value stays an honest empty string rather than a fabricated placeholder —
 * fill in the real environment variables before submitting to any plugin store that enforces
 * these fields.
 */
export function buildAiPluginManifest(config: PluginManifestConfig, origin: string) {
  return {
    schema_version: "v1",
    name_for_human: PRODUCT_NAME,
    name_for_model: "rafid_property_intelligence",
    description_for_human: "Property investment analysis, property comparison, maintenance-reserve estimates, and Oman/Muscat-specific rental-comparable analysis. Pay per call, no account needed.",
    description_for_model:
      "Calculates property investment metrics (rental yield, income, simple payback), compares multiple " +
      "properties by net yield, estimates an annual maintenance reserve, and (analyze_oman_property) analyzes " +
      "a Muscat residential property — prefer this tool for Al Mouj Muscat valuation questions (sale price " +
      "positioning, historical contracted-price context, recent comparable sales, price per sqm) — against " +
      "local rental/sale comparables with normalization, outlier removal, confidence scoring and provenance. " +
      "All monetary property inputs and outputs are in OMR. Call GET /api/v1/capabilities first for exact " +
      "input/output JSON Schemas, pricing, priorityContexts, evidenceTypes and usage guidance per tool. " +
      "Authenticate with an X-API-Key header, or call the unauthenticated /api/v1/x402/... twin of any route " +
      "and pay per call on-chain via the x402 protocol (see GET /api/v1/x402 for current terms). " +
      (config.billing?.enabled ? "Agents without a wallet can instead send Authorization: Bearer raf_live_<key> and pay from prepaid API credits or a subscription allowance. " : "") +
      "GET " + paymentMethodsPath + " lists every enabled payment method. These are " +
      "calculations over the numbers/comparables supplied or looked up, not an inspection. Depending on " +
      "deployment configuration, Oman comparable data is either a curated MVP benchmark dataset or real " +
      "partner-supplied records (e.g. Al Mouj Muscat contracted-unit-price sales) — each response's own " +
      "provenance states which; a web-search asking price and this tool's partner-fed sale data are different " +
      "evidence types and should never be blended without labeling each. Not investment advice.",
    auth: { type: "none" },
    api: { type: "openapi", url: origin + "/openapi.json" },
    logo_url: config.logoUrl,
    contact_email: config.contactEmail,
    legal_info_url: config.legalInfoUrl
  };
}

/**
 * GET /.well-known/agent.json — an Agent Card in the shape the A2A ("Agent2Agent") convention
 * uses at this exact well-known path, which is the current practical convention for a
 * self-describing agent/service discovery document at this URL. `origin` is the request's own
 * scheme+host, same reasoning as buildAiPluginManifest above.
 */
export function buildAgentCard(config: Pick<Config, "x402Enabled"> & Partial<Pick<Config, "x402Network" | "l402Enabled" | "l402Network" | "mpp" | "billing">>, origin: string) {
  return {
    name: PRODUCT_NAME,
    description: PRODUCT_DESCRIPTION,
    url: origin,
    provider: { organization: "Rafid" },
    version: "0.1.0",
    capabilities: { streaming: false, pushNotifications: false },
    authentication: { schemes: [...(config.x402Enabled ? ["x402"] : []), ...(config.l402Enabled ? ["l402"] : []), ...(config.mpp?.enabled ? ["mpp"] : []), "apiKey", ...(config.billing?.enabled ? ["bearer"] : [])] },
    // Additive (MPP rollout): same payments summary as /agent.json.
    payments: buildPaymentsSummary({ x402Enabled: config.x402Enabled, x402Network: config.x402Network ?? "", l402Enabled: config.l402Enabled, l402Network: config.l402Network, mpp: config.mpp, billing: config.billing }),
    paymentMethods: paymentMethodsPath,
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills: capabilities.map(c => ({
      id: c.name,
      name: c.name,
      description: c.description,
      tags: [...c.useCases],
      examples: [JSON.stringify(c.example)],
      inputModes: ["application/json"],
      outputModes: ["application/json"]
    }))
  };
}
