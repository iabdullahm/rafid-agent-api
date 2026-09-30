import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createApp } from "../src/api/app.js";
import { loadConfig } from "../src/config/env.js";
import { capabilities } from "../src/domain/capabilities.js";
import { MemoryAnalyticsRepository } from "../src/analytics/memoryRepository.js";
import { buildCapabilitiesRegistry } from "../src/api/agent.js";
import { buildCategoryIndex, buildDiscoveryIndex, buildIntentDetail, buildIntentIndex, renderToolPage, searchCapabilities } from "../src/api/discovery.js";

const config = loadConfig({ RAFID_API_KEYS: "discovery-test-key-012345678901234567890", LOG_LEVEL: "silent", RATE_LIMIT_ENABLED: "false", MCP_REMOTE_ENABLED: "true" });

test("discovery metadata is registry-derived and representative intents route to small candidate sets", () => {
  const registry = buildCapabilitiesRegistry(config);
  const index = buildDiscoveryIndex(config);
  assert.equal(index.capabilityCount, capabilities.length);
  assert.equal(registry.length, capabilities.length);
  assert.equal(index.categories.reduce((sum, category) => sum + category.count, 0), capabilities.length);
  assert.ok(buildIntentDetail("company_due_diligence"));
  assert.equal(buildIntentDetail("company_due_diligence")?.primary, "company_due_diligence");
  assert.ok(buildIntentIndex().some(intent => intent.intent === "invoice_anomaly_check"));

  const cases = [
    ["check company before onboarding", "company_due_diligence"],
    ["detect suspicious invoice", "invoice_anomaly_check"],
    ["calculate rental yield", "analyze_property"],
    ["audit this website", "website_audit"],
    ["estimate vehicle value", "vehicle_value_estimate"],
    ["estimate shipping cost", "shipping_cost_estimate"]
  ] as const;
  for (const [query, expected] of cases) {
    const result = searchCapabilities(query, config);
    assert.ok(result.matches.length > 0 && result.matches.length <= 8, query);
    assert.ok(result.matches.some(match => match.capability === expected), `${query} -> ${expected}`);
  }
});

test("public discovery routes expose tool pages and never expose internal analytics paths", async t => {
  const analyticsRepository = new MemoryAnalyticsRepository();
  const app = createApp(config, { analyticsRepository });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  const discovery = await (await fetch(`${base}/api/v1/discovery`)).json() as { data: { capabilityCount: number; tools: string } };
  assert.equal(discovery.data.capabilityCount, capabilities.length);
  assert.equal(discovery.data.tools, "/tools");
  const search = await (await fetch(`${base}/api/v1/discovery/search?q=check%20a%20supplier%20before%20onboarding`)).json() as { data: { matches: Array<{ capability: string }> } };
  assert.ok(search.data.matches.some(match => match.capability === "company_due_diligence"));
  assert.equal((await fetch(`${base}/api/v1/discovery/intents/company_due_diligence`)).status, 200);
  assert.equal((await fetch(`${base}/tools/company_due_diligence`)).status, 200);
  assert.equal((await fetch(`${base}/robots.txt`)).status, 200);
  assert.equal((await fetch(`${base}/sitemap.xml`)).status, 200);
  const [robots, sitemap, manifest, llms] = await Promise.all([
    fetch(`${base}/robots.txt`).then(response => response.text()),
    fetch(`${base}/sitemap.xml`).then(response => response.text()),
    fetch(`${base}/agent.json`).then(response => response.text()),
    fetch(`${base}/llms.txt`).then(response => response.text())
  ]);
  for (const publicText of [robots, sitemap, manifest, llms, renderToolPage("company_due_diligence", config)!]) {
    assert.ok(!publicText.includes("/api/v1/internal/analytics"));
  }
});
