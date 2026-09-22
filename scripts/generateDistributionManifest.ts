import { writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { capabilities } from "../src/domain/capabilities.js";
import { plannedCapabilities } from "../src/domain/roadmap.js";
import { prices } from "../src/billing/catalog.js";
import { agentBasePath, pricingBasePath, toolsBasePath, capabilitiesBasePath } from "../src/api/agent.js";
import { x402BasePath } from "../src/billing/x402.js";
import { mcpRemotePath, mcpStatusBasePath } from "../src/mcp/remote.js";
import { MUSCAT_GOVERNORATE, SUPPORTED_MUSCAT_AREAS } from "../src/domain/oman/locations.js";
import { PRODUCTION_BASE_URL } from "./distributionConfig.js";

/**
 * Generates distribution/manifest.json — the machine-readable summary of Rafid's agent
 * distribution surface (Section 18 of the "Agent Distribution Pack" request).
 *
 * Every capability-shaped fact below (name, description, whenToUse, useCases, price,
 * currency, paymentProtocol, endpoint, x402Endpoint, priorityContexts, evidenceTypes,
 * limitations, sampleQueries) is read directly from the single `capabilities` registry in
 * src/domain/capabilities.ts — the exact same registry GET /api/v1/capabilities,
 * GET /agent.json, GET /llms.txt, the MCP server and the x402 gate all read from. This script
 * adds NO manual tool catalog of its own; it is a projection of the registry into a
 * distribution-friendly static file, not a second source of truth. Re-run this script (`npm
 * run distribution:manifest`) whenever the registry changes so distribution/manifest.json
 * never drifts — `npm run distribution:check` fails if it does.
 *
 * Deliberately excludes full JSON Schemas (those live in the canonical /openapi.json /
 * GET /api/v1/capabilities responses) to keep this file small and readable as a distribution
 * summary rather than a duplicate OpenAPI document.
 */

const manifest = {
  name: "Rafid Property Intelligence",
  tagline: "Property intelligence built for AI agents.",
  description:
    "Property and facility intelligence tools built for autonomous AI agents: discover a capability, " +
    "pay per call over x402 (or authenticate with an API key), execute, get a structured result. " +
    "Not designed primarily as a human dashboard product.",
  baseUrl: PRODUCTION_BASE_URL,
  version: "0.1.0",
  audience: "ai-agents",
  discovery: {
    agentManifest: "/agent.json",
    aiPlugin: "/.well-known/ai-plugin.json",
    a2aAgentCard: "/.well-known/agent.json",
    llmsTxt: "/llms.txt",
    capabilities: capabilitiesBasePath,
    tools: toolsBasePath,
    pricing: pricingBasePath,
    agentInfo: agentBasePath,
    openapi: "/openapi.json",
    docs: "/docs",
    health: "/api/v1/health",
    mcpStatus: mcpStatusBasePath,
    mcpRemote: mcpRemotePath,
    x402Info: x402BasePath,
    x402Status: x402BasePath + "/status"
  },
  protocols: ["mcp", "openapi", "x402", "rest"],
  mcp: {
    remotePath: mcpRemotePath,
    statusPath: mcpStatusBasePath,
    stdioCommand: "npm run mcp",
    transports: ["stdio", "http"],
    note: "Remote (Streamable HTTP) transport is enabled by default (MCP_REMOTE_ENABLED defaults to true) but is deployment-configurable — always check mcpStatus at runtime rather than assuming."
  },
  x402: {
    infoPath: x402BasePath,
    statusPath: x402BasePath + "/status",
    currency: "USD",
    scheme: "exact",
    protocolVersion: 2,
    note: "Network, asset, facilitator and payTo address are deployment-specific runtime config, not build-time constants — always read them from x402Status rather than hardcoding."
  },
  capabilities: capabilities.map(c => ({
    name: c.name,
    description: c.description,
    whenToUse: c.whenToUse,
    useCases: c.useCases,
    price: c.price,
    currency: c.currency,
    paymentProtocol: c.paymentProtocol,
    idempotent: c.idempotent,
    sideEffects: c.sideEffects,
    endpoint: "/api/v1" + c.path,
    x402Endpoint: x402BasePath + c.path,
    mcpToolName: c.name,
    priorityContexts: c.agentGuidance?.priorityContexts ?? [],
    evidenceTypes: c.agentGuidance?.evidenceTypes ?? [],
    limitations: c.agentGuidance?.limitations ?? [],
    sampleQueries: c.agentGuidance?.sampleQueries ?? []
  })),
  pricing: { currency: "USD", model: "pay-per-call", tools: { ...prices } },
  roadmap: plannedCapabilities,
  geography: {
    country: "Oman",
    governorate: MUSCAT_GOVERNORATE,
    supportedAreas: SUPPORTED_MUSCAT_AREAS,
    currentStrongestCoverage: ["Al Mouj Muscat"],
    note: "Coverage is Muscat governorate only, and only its supported areas. Al Mouj Muscat is the deployment's strongest single-area coverage today because it is the only area with real partner-fed (sourceType partner_feed) sale records; other supported areas may only have demo/manual_benchmark data on a given deployment. This is not nationwide Oman coverage."
  },
  generatedAt: new Date().toISOString(),
  generatedBy: "scripts/generateDistributionManifest.ts (derived from src/domain/capabilities.ts — never hand-edit this file)"
};

const outPath = resolvePath(import.meta.dirname, "../distribution/manifest.json");
writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
process.stdout.write(`Wrote ${outPath} (${capabilities.length} capabilities, ${plannedCapabilities.length} planned).\n`);
