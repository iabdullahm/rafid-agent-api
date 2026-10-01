import { mkdirSync, writeFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { capabilities, capabilityCategory, toolSelectionMetadata } from "../src/domain/capabilities.js";
import { prices } from "../src/billing/catalog.js";
import { PLATFORM_DESCRIPTION, PLATFORM_NAME } from "../src/brand.js";
import { PRODUCTION_BASE_URL } from "./distributionConfig.js";

const root = resolvePath(import.meta.dirname, "../distribution");
const writeJson = (relative: string, value: unknown) => {
  const path = resolvePath(root, relative);
  mkdirSync(resolvePath(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
};
const writeText = (relative: string, value: string) => {
  const path = resolvePath(root, relative);
  mkdirSync(resolvePath(path, ".."), { recursive: true });
  writeFileSync(path, value.endsWith("\n") ? value : value + "\n", "utf8");
};

const categoryCounts = new Map<string, number>();
for (const capability of capabilities) categoryCounts.set(capabilityCategory(capability), (categoryCounts.get(capabilityCategory(capability)) ?? 0) + 1);
const categories = [...categoryCounts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, count]) => ({ id, count }));

const capabilitySummary = capabilities.map(c => {
  const selection = toolSelectionMetadata(c);
  return {
    id: c.name,
    name: c.name,
    category: capabilityCategory(c),
    description: c.description,
    whenToUse: c.whenToUse,
    useCases: c.useCases,
    recommendedFor: selection.recommendedFor,
    notFor: selection.notFor,
    preferOver: selection.preferOver,
    selectionExamples: selection.selectionExamples,
    price: prices[c.name],
    currency: c.currency,
    paymentProtocols: ["x402"],
    restEndpoint: `${PRODUCTION_BASE_URL}/api/v1${c.path}`,
    x402Endpoint: `${PRODUCTION_BASE_URL}/api/v1/x402${c.path}`,
    mcpTool: c.name,
    mcpAvailable: true,
    a2aAvailable: true,
    previewAvailable: Boolean(c.preview),
    idempotent: c.idempotent,
    sideEffects: c.sideEffects
  };
});

const intents = [...new Set(capabilities.flatMap(c => [c.name, ...c.useCases.map(value => value.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""))]))].sort();

writeJson("platform.json", {
  platform: PLATFORM_NAME,
  description: PLATFORM_DESCRIPTION,
  capabilityCount: capabilities.length,
  categories,
  discovery: {
    index: `${PRODUCTION_BASE_URL}/api/v1/discovery`,
    search: `${PRODUCTION_BASE_URL}/api/v1/discovery/search?q=...`,
    intents: `${PRODUCTION_BASE_URL}/api/v1/discovery/intents`,
    capabilities: `${PRODUCTION_BASE_URL}/api/v1/capabilities`,
    tools: `${PRODUCTION_BASE_URL}/tools`,
    openapi: `${PRODUCTION_BASE_URL}/openapi.json`,
    llms: `${PRODUCTION_BASE_URL}/llms.txt`
  },
  protocols: { rest: true, mcp: true, a2a: true, x402: true, l402: "deployment_configured", mpp: "deployment_configured" },
  generatedBy: "scripts/generateDiscoveryPack.ts"
});
writeJson("categories.json", categories);
writeJson("intents.json", { derivedFrom: ["capability.name", "capability.useCases", "selection guidance"], intents });
writeJson("capabilities.json", capabilitySummary);
writeJson("mcp/server.json", {
  name: "io.github.iabdullahm/rafid-agent-api",
  title: PLATFORM_NAME,
  description: PLATFORM_DESCRIPTION,
  version: "0.1.2",
  websiteUrl: PRODUCTION_BASE_URL,
  repository: { url: "https://github.com/iabdullahm/rafid-agent-api", source: "github" },
  remotes: [{ type: "streamable-http", url: `${PRODUCTION_BASE_URL}/mcp` }],
  stdio: { command: "npm run mcp" },
  metadataSource: "src/domain/capabilities.ts"
});
writeText("mcp/submission.md", `# Official MCP Registry submission readiness\n\nThe repository contains a registry-shaped server manifest at mcp/server.json. Publishing requires the repository owner to run the official mcp-publisher flow and complete any GitHub ownership/verification requested by the registry. No submission is claimed by this file.\n`);
writeJson("a2a/agent.json", {
  name: PLATFORM_NAME,
  description: PLATFORM_DESCRIPTION,
  url: `${PRODUCTION_BASE_URL}/.well-known/agent.json`,
  skills: capabilitySummary.map(c => ({ id: c.id, name: c.name, description: c.description, category: c.category, endpoint: c.restEndpoint, mcpTool: c.mcpTool }))
});
writeText("x402/services.json", JSON.stringify({ protocol: "x402", network: "deployment-configured; production is expected to use Base Mainnet", asset: "USDC", services: capabilitySummary.map(c => ({ capability: c.id, purpose: c.whenToUse, price: c.price, currency: c.currency, endpoint: c.x402Endpoint, method: "POST", inputSchema: `${PRODUCTION_BASE_URL}/api/v1/capabilities#${c.id}`, payment: "Read PAYMENT-REQUIRED, pay the exact requirement, retry the same request with X-PAYMENT." })) }, null, 2));
writeText("x402/submission.md", `# x402 discovery readiness\n\nThe live x402 metadata is generated from the capability registry and runtime payment configuration. Verify the deployed network, asset, facilitator and payTo values from ${PRODUCTION_BASE_URL}/api/v1/x402/status before any directory submission. This pack does not submit a listing or claim approval.\n`);
writeText("directories/registry-readiness.md", `# Registry readiness matrix\n\n| Registry | Protocol | Status | Exact reason / action |\n|---|---|---|---|\n| Official MCP Registry | MCP | PARTIAL | Manifest is prepared; owner must run mcp-publisher and complete repository verification. |\n| Glama | MCP | MANUAL ACTION REQUIRED | Submit the public MCP endpoint and repository through the Glama listing flow; no submission is claimed. |\n| Smithery | MCP | MANUAL ACTION REQUIRED | Submit a verified server/repository through Smithery; account and ownership checks are external. |\n| PulseMCP | MCP | MANUAL ACTION REQUIRED | Submit the public server metadata and confirm remote transport availability. |\n| x402 Bazaar | x402 | PARTIAL | Runtime Bazaar metadata exists; verify deployed Base/network/payTo and submit through the current directory flow. |\n| x402.direct | x402 | MANUAL ACTION REQUIRED | External listing and approval are not performed by this repository. |\n| x402-list | x402 | MANUAL ACTION REQUIRED | External listing and approval are not performed by this repository. |\n| x402mpp | x402/MPP | PARTIAL | x402 is documented; MPP remains deployment-configured and must be verified before listing. |\n| agentfirst.directory | A2A/REST/MCP | MANUAL ACTION REQUIRED | Submit the generated platform and capability metadata after production URL verification. |\n\nStatuses describe repository readiness only; none means that a remote registry accepted or published Rafid.\n`);
writeText("directories/submission-checklist.md", `# Manual submission checklist\n\n1. Deploy the current commit and verify /api/v1/discovery, /api/v1/capabilities, /openapi.json, /mcp, /robots.txt and /sitemap.xml.\n2. Verify runtime x402 status, Base network, USDC asset, facilitator and payTo without copying secrets.\n3. Confirm the public domain and repository ownership in each directory account.\n4. Submit the prepared MCP, A2A and x402 metadata and record external approval links.\n5. Re-run this pack generator whenever the canonical registry changes.\n`);
writeText("examples/curl.md", `# Deterministic discovery\n\n\`curl -s ${PRODUCTION_BASE_URL}/api/v1/discovery\`\n\n\`curl -sG --data-urlencode "q=check a supplier before onboarding" ${PRODUCTION_BASE_URL}/api/v1/discovery/search\`\n\n\`curl -s ${PRODUCTION_BASE_URL}/tools/company_due_diligence\`\n`);
writeText("examples/mcp.md", `# MCP\n\nRemote: POST ${PRODUCTION_BASE_URL}/mcp when MCP_REMOTE_ENABLED is enabled. Local: \`npm run mcp\`. Use tools/list, then preview_capability before a paid execution where a preview is available.\n`);
writeText("examples/x402.md", `# x402\n\n1. Read ${PRODUCTION_BASE_URL}/api/v1/capabilities.\n2. POST the x402 endpoint without payment.\n3. Parse PAYMENT-REQUIRED, pay the exact Base/USDC requirement exposed by the deployment, and retry the same body with X-PAYMENT.\n`);
process.stdout.write(`Generated discovery pack for ${capabilities.length} capabilities.\n`);
