import test from "node:test";
import assert from "node:assert/strict";
import { capabilities, capabilityCategory, discoveryCapabilities } from "../src/domain/capabilities.js";
import { buildAgentManifest, buildAgentCard } from "../src/api/manifest.js";
import { buildCapabilitiesRegistry, buildToolCatalog } from "../src/api/agent.js";
import { buildLlmsTxt } from "../src/api/llms-txt.js";
import { buildOpenapi } from "../src/api/openapi.js";
import { summarizeCapabilityFunnel } from "../src/analytics/aggregate.js";

const config = {
  x402Enabled: true, x402Network: "eip155:84532", x402WalletAddress: "0x0000000000000000000000000000000000000001",
  cdpConfigured: false, mcpRemoteEnabled: true, logoUrl: "", contactEmail: "", legalInfoUrl: ""
} as any;

test("discovery ordering is deterministic, categorized, complete, and unique", () => {
  assert.equal(discoveryCapabilities.length, capabilities.length);
  assert.equal(new Set(discoveryCapabilities.map(c => c.name)).size, capabilities.length);
  assert.equal(capabilityCategory(discoveryCapabilities[0]!), "risk_intelligence");
  assert.ok(discoveryCapabilities.findIndex(c => c.name === "analyze_property") > 0);
  assert.ok(discoveryCapabilities.every(c => capabilityCategory(c).length > 0));
});

test("registry-derived surfaces expose the same complete capability set and prices", () => {
  const expected = discoveryCapabilities.map(c => c.name);
  const registry = buildCapabilitiesRegistry(config).map((c: any) => c.name);
  const catalog = buildToolCatalog().map((c: any) => c.name);
  const manifest = (buildAgentManifest(config) as any).tools.map((c: any) => c.name);
  const a2a = (buildAgentCard(config, "https://example.test") as any).skills.map((c: any) => c.id);
  assert.deepEqual(registry, expected);
  assert.deepEqual(catalog, expected);
  assert.deepEqual(manifest, expected);
  assert.deepEqual(a2a, expected);
  for (const c of discoveryCapabilities) {
    const exposed = (buildCapabilitiesRegistry(config).find((x: any) => x.name === c.name) as any);
    assert.equal(exposed.price, c.price);
    assert.equal(exposed.intents.length, c.useCases.length);
    assert.ok(exposed.description.length > 0);
  }
  const openapi = buildOpenapi(config) as any;
  for (const c of discoveryCapabilities) assert.ok(openapi.paths[`/api/v1${c.path}`]);
  const llms = buildLlmsTxt(config);
  for (const c of discoveryCapabilities) assert.match(llms, new RegExp(`## ${c.name}`));
});

test("funnel distinguishes surface presentation from capability interaction", () => {
  const base = { path: null, toolName: null, channel: null, success: null, durationMs: null, amount: null, currency: null, txHash: null, dataSource: null, clientHash: null, userAgent: null, referer: null, clientName: null, createdAt: new Date().toISOString() };
  const events: any[] = [
    { ...base, category: "discovery", eventType: "surface_requested", path: "/agent.json", presentedCapabilities: ["company_due_diligence", "analyze_property"] },
    { ...base, category: "preview", eventType: "preview_requested", toolName: "company_due_diligence" },
    { ...base, category: "x402", eventType: "challenge", toolName: "company_due_diligence" },
    { ...base, category: "x402", eventType: "settlement_success", toolName: "company_due_diligence", amount: 1.5, currency: "USD" },
    { ...base, category: "tool", eventType: "invocation", toolName: "company_due_diligence", channel: "x402", success: true }
  ];
  const row = summarizeCapabilityFunnel(events).company_due_diligence;
  assert.deepEqual(row && { presented: row.presented, preview: row.preview, challenges402: row.challenges402, paid: row.paid, executed: row.executed, revenueUsd: row.revenueUsd, presentedIsSurfaceImpression: row.presentedIsSurfaceImpression }, { presented: 1, preview: 1, challenges402: 1, paid: 1, executed: 1, revenueUsd: 1.5, presentedIsSurfaceImpression: true });
  assert.equal(summarizeCapabilityFunnel(events).analyze_property?.executed, 0);
});
