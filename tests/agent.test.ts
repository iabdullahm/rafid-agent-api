import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createApp } from "../src/api/app.js";
import { loadConfig } from "../src/config/env.js";
import { capabilities } from "../src/domain/capabilities.js";
import { prices } from "../src/billing/catalog.js";
import { BillingService } from "../src/billing/service.js";
import { ConsoleUsageRepository, MemoryUsageRepository } from "../src/billing/usage.js";

const key = "test-only-not-a-real-credential-12345";
const config = loadConfig({ RAFID_API_KEYS: key, LOG_LEVEL: "silent" });

async function withServer<T>(fn: (base: string) => Promise<T>, opts?: Parameters<typeof createApp>[1]): Promise<T> {
  const app = createApp(config, { logger: () => {}, ...opts });
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a network address");
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

test("GET /api/v1/agent returns agent-marketplace discovery metadata", async () => {
  await withServer(async base => {
    const response = await fetch(base + "/api/v1/agent");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.equal(body.data.name, "Rafid Property Intelligence");
    assert.equal(body.data.mcp, true);
    assert.equal(body.data.openapi, "/openapi.json");
    assert.equal(body.data.pricing, "/api/v1/pricing");
    assert.equal(body.data.tools, "/api/v1/tools");
    assert.equal(body.data.x402, "/api/v1/x402");
    assert.equal(body.data.x402Enabled, false);
    assert.deepEqual(body.data.endpoints.sort(), capabilities.map(c => "/api/v1" + c.path).sort());
  });
});

test("GET /api/v1/pricing mirrors the single price catalog exactly, with no duplication", async () => {
  await withServer(async base => {
    const response = await fetch(base + "/api/v1/pricing");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.currency, "USD");
    assert.equal(body.data.model, "pay-per-call");
    assert.deepEqual(body.data.tools, prices);
  });
});

test("GET /api/v1/tools returns a complete, schema-accurate catalog for every capability", async () => {
  await withServer(async base => {
    const response = await fetch(base + "/api/v1/tools");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.length, capabilities.length);
    for (const c of capabilities) {
      const tool = body.data.find((t: any) => t.name === c.name);
      assert.ok(tool, `expected a tool entry for ${c.name}`);
      assert.equal(tool.description, c.description);
      assert.equal(tool.price, prices[c.name]);
      assert.equal(tool.currency, "USD");
      assert.equal(tool.endpoint, "/api/v1" + c.path);
      assert.equal(tool.method, "POST");
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.ok(typeof tool.outputSummary === "string" && tool.outputSummary.length > 0);
    }
  });
});

test("GET /api/v1/health responds 200 with a minimal liveness payload", async () => {
  await withServer(async base => {
    const response = await fetch(base + "/api/v1/health");
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data, { ok: true });
  });
});

test("GET / serves an HTML landing page by default and JSON discovery on request", async () => {
  await withServer(async base => {
    const browser = await fetch(base + "/");
    assert.equal(browser.status, 200);
    assert.match(browser.headers.get("content-type") ?? "", /text\/html/);
    const html = await browser.text();
    assert.match(html, /Rafid Property Intelligence/);
    assert.match(html, /Property intelligence built for AI agents\./);
    assert.match(html, /Discover\. Pay per call\. Execute\./);

    const agent = await fetch(base + "/", { headers: { Accept: "application/json" } });
    assert.match(agent.headers.get("content-type") ?? "", /application\/json/);
    const body = await agent.json();
    assert.equal(body.data.name, "Rafid Agent API");
    assert.equal(body.data.agent, "/api/v1/agent");
  });
});

test("Capability responses carry tool/price/currency in meta, in addition to unchanged data", async () => {
  await withServer(async base => {
    const response = await fetch(base + "/api/v1/property/analyze", {
      method: "POST", headers: { "X-API-Key": key, "Content-Type": "application/json" }, body: JSON.stringify(capabilities[0].example)
    });
    const body = await response.json();
    assert.deepEqual(body.data, await capabilities[0].execute(capabilities[0].example));
    assert.equal(body.meta.tool, "analyze_property");
    assert.equal(body.meta.price, prices.analyze_property);
    assert.equal(body.meta.currency, "USD");
  });
});

test("CORS: permissive origin on every response, OPTIONS short-circuits with no route match required", async () => {
  await withServer(async base => {
    const preflight = await fetch(base + "/api/v1/property/analyze", { method: "OPTIONS" });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
    const get = await fetch(base + "/api/v1/health");
    assert.equal(get.headers.get("access-control-allow-origin"), "*");
    assert.equal(get.headers.get("x-frame-options"), "DENY");
  });
});

test("Usage tracking: every capability call (success or failure) is recorded, without the raw API key", async () => {
  const usage = new MemoryUsageRepository();
  const billingService = new BillingService(usage);
  await withServer(async base => {
    await fetch(base + "/api/v1/property/analyze", {
      method: "POST", headers: { "X-API-Key": key, "Content-Type": "application/json" }, body: JSON.stringify(capabilities[0].example)
    });
    await fetch(base + "/api/v1/property/analyze", {
      method: "POST", headers: { "X-API-Key": "wrong", "Content-Type": "application/json" }, body: "{}"
    });
  }, { billingService });
  const records = usage.list();
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(r => r.status).sort(), [200, 401]);
  for (const record of records) {
    assert.equal(record.toolName, "analyze_property");
    assert.ok(!JSON.stringify(record).includes(key));
    assert.equal(typeof record.durationMs, "number");
  }
  assert.equal(records[0].billableAmount, prices.analyze_property);
});

test("BillingService centralizes pricing and never lets business logic read a raw price literal", () => {
  const service = new BillingService();
  for (const c of capabilities) {
    assert.equal(service.getToolPrice(c.name), prices[c.name]);
    assert.equal(service.isBillable(c.name), true);
  }
  const requirement = service.buildX402PaymentRequirement("analyze_property", "eip155:8453", "0x1234567890123456789012345678901234567890");
  assert.deepEqual(requirement, { scheme: "exact", price: "$0.01", network: "eip155:8453", payTo: "0x1234567890123456789012345678901234567890" });
});

test("ConsoleUsageRepository writes one JSON line to stderr per record", () => {
  const original = process.stderr.write.bind(process.stderr);
  const lines: string[] = [];
  (process.stderr as any).write = (chunk: string) => { lines.push(String(chunk)); return true; };
  try {
    new ConsoleUsageRepository().record({ requestId: "r1", keyIdentifier: "configured-key-0", toolName: "analyze_property", accessMode: "api-key", timestamp: new Date().toISOString(), status: 200, durationMs: 5, billableAmount: 0.01, currency: "USD" });
  } finally {
    (process.stderr as any).write = original;
  }
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.usage.toolName, "analyze_property");
});
