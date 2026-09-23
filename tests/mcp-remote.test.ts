import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createApp } from "../src/api/app.js";
import { loadConfig } from "../src/config/env.js";
import { capabilities } from "../src/domain/capabilities.js";
import { PostgresUsageRepository, MemoryUsageRepository } from "../src/billing/usage.js";
import { BillingService } from "../src/billing/service.js";

const key = "test-only-not-a-real-credential-12345";

async function withServer<T>(config: ReturnType<typeof loadConfig>, fn: (base: string) => Promise<T>, opts?: Parameters<typeof createApp>[1]): Promise<T> {
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

let nextId = 1;
async function rpc(base: string, method: string, params: unknown = {}) {
  const response = await fetch(base + "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params })
  });
  return { status: response.status, body: await response.json() as any };
}

test("remote MCP connection: initialize succeeds and reports the same server identity as stdio", async () => {
  const config = loadConfig({ RAFID_API_KEYS: key });
  await withServer(config, async base => {
    const { status, body } = await rpc(base, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } });
    assert.equal(status, 200);
    assert.equal(body.result.serverInfo.name, "rafid-agent-api");
  });
});

test("remote MCP tool listing matches the shared capability registry exactly (names, descriptions, strict schemas)", async () => {
  const config = loadConfig({ RAFID_API_KEYS: key });
  await withServer(config, async base => {
    const { body } = await rpc(base, "tools/list");
    const tools = body.result.tools as any[];
    // Free Preview (src/preview/) adds exactly one generic "preview_capability" tool alongside
    // the per-capability tools built straight from the registry — not a second tool list.
    assert.deepEqual(tools.map(t => t.name).sort(), [...capabilities.map(c => c.name), "preview_capability"].sort());
    for (const c of capabilities) {
      const tool = tools.find(t => t.name === c.name);
      assert.ok(tool, `expected a remote MCP tool entry for ${c.name}`);
      assert.ok(tool.description.includes(c.description));
      assert.ok(tool.description.includes(c.whenToUse));
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.ok(tool.outputSchema);
    }
  });
});

test("remote MCP tool execution returns the exact same structured result as calling the service layer directly", async () => {
  const config = loadConfig({ RAFID_API_KEYS: key });
  await withServer(config, async base => {
    for (const c of capabilities) {
      const { body } = await rpc(base, "tools/call", { name: c.name, arguments: c.example });
      assert.equal(body.error, undefined);
      assert.ok(!body.result.isError);
      assert.deepEqual(body.result.structuredContent, await c.execute(c.example));
    }
    const { body: invalid } = await rpc(base, "tools/call", { name: "analyze_property", arguments: { propertyValue: 0 } });
    assert.ok(invalid.result?.isError);
  });
});

test("remote MCP registry parity with stdio: both are built by the exact same createMcpServer() factory reading src/domain/capabilities.ts", async () => {
  // tests/mcp.test.ts spawns the compiled stdio entry point (dist/mcp.js) and asserts its
  // tools/list output against the same `capabilities` array. This test asserts the remote
  // transport's tools/list output against the same array from the live HTTP route, so the two
  // together prove neither transport can drift from the registry, or from each other, without
  // needing a second registry to compare against — there is only ever one.
  const config = loadConfig({ RAFID_API_KEYS: key });
  await withServer(config, async base => {
    const { body } = await rpc(base, "tools/list");
    const allRemoteTools = (body.result.tools as any[]).map(t => ({ name: t.name, description: t.description, additionalProperties: t.inputSchema.additionalProperties })).sort((a, b) => a.name.localeCompare(b.name));
    // Free Preview (src/preview/) registers one extra generic "preview_capability" tool
    // (src/mcp/server.ts) alongside every per-capability tool built from the registry — assert
    // it separately (its own dedicated schema, not one derived from a capability) rather than
    // folding it into the per-capability parity check below.
    const previewTool = allRemoteTools.find(t => t.name === "preview_capability");
    assert.ok(previewTool, "expected a preview_capability tool on the remote MCP transport");
    assert.equal(previewTool!.additionalProperties, false);
    assert.match(previewTool!.description, /preview/i);
    const remoteTools = allRemoteTools.filter(t => t.name !== "preview_capability");
    const expected = capabilities.map(c => ({ name: c.name, description: `${c.description} ${c.whenToUse}`, additionalProperties: false })).sort((a, b) => a.name.localeCompare(b.name));
    assert.deepEqual(remoteTools, expected);
  });
});

test("remote MCP is unmounted (404) when MCP_REMOTE_ENABLED=false, and /api/v1/mcp/status reflects it honestly", async () => {
  const config = loadConfig({ RAFID_API_KEYS: key, MCP_REMOTE_ENABLED: "false" });
  await withServer(config, async base => {
    const response = await fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    assert.equal(response.status, 404);
    const status = await (await fetch(base + "/api/v1/mcp/status")).json();
    assert.deepEqual(status.data, { enabled: false, transport: ["stdio"], tools: capabilities.length, endpoint: null });
  });
});

test("/api/v1/mcp/status reports enabled with both transports and the /mcp endpoint when MCP_REMOTE_ENABLED=true (the default)", async () => {
  const config = loadConfig({ RAFID_API_KEYS: key });
  await withServer(config, async base => {
    const status = await (await fetch(base + "/api/v1/mcp/status")).json();
    assert.deepEqual(status.data, { enabled: true, transport: ["stdio", "http"], tools: capabilities.length, endpoint: "/mcp" });
  });
});

test("remote MCP tool calls are recorded as accessMode 'mcp-remote', billableAmount 0, with no sensitive data — local stdio stays unmetered by contrast", async () => {
  const usage = new MemoryUsageRepository();
  const billingService = new BillingService(usage);
  const config = loadConfig({ RAFID_API_KEYS: key });
  await withServer(config, async base => {
    await rpc(base, "tools/call", { name: "analyze_property", arguments: capabilities[0].example });
  }, { billingService });
  const records = usage.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].accessMode, "mcp-remote");
  assert.equal(records[0].toolName, "analyze_property");
  assert.equal(records[0].billableAmount, 0);
  assert.equal(records[0].currency, "USD");
  assert.equal(records[0].keyIdentifier, "mcp-remote");
  const serialized = JSON.stringify(records);
  for (const forbidden of ["privateKey", "signature", "X-PAYMENT", key]) assert.ok(!serialized.includes(forbidden));
});

test("rate limiting protects discovery, x402 and remote MCP independently: each group 429s on its own budget without affecting the others", async () => {
  const config = loadConfig({ RAFID_API_KEYS: key, X402_ENABLED: "true", X402_WALLET_ADDRESS: "0x1234567890123456789012345678901234567890", RATE_LIMIT_MAX: "2", RATE_LIMIT_WINDOW_MS: "60000" });
  await withServer(config, async base => {
    const hit = (path: string) => fetch(base + path);
    // Discovery group: 2 allowed, 3rd is 429.
    assert.equal((await hit("/api/v1/agent")).status, 200);
    assert.equal((await hit("/api/v1/agent")).status, 200);
    const third = await hit("/api/v1/agent");
    assert.equal(third.status, 429);
    assert.ok(third.headers.get("retry-after"));
    const body = await third.json();
    assert.equal(body.error.code, "RATE_LIMITED");
    // x402 group has its own independent budget, unaffected by discovery's exhaustion above.
    assert.equal((await hit("/api/v1/x402")).status, 200);
    assert.equal((await hit("/api/v1/x402")).status, 200);
    assert.equal((await hit("/api/v1/x402")).status, 429);
    // Remote MCP group is likewise independent.
    const mcpCall = () => fetch(base + "/mcp", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    assert.equal((await mcpCall()).status, 200);
    assert.equal((await mcpCall()).status, 200);
    assert.equal((await mcpCall()).status, 429);
    // A route outside all three groups (health) is never rate limited.
    for (let i = 0; i < 5; i++) assert.equal((await hit("/api/v1/health")).status, 200);
  });
});

test("rate limiting can be disabled with RATE_LIMIT_ENABLED=false, for local development and other tests", async () => {
  const config = loadConfig({ RAFID_API_KEYS: key, RATE_LIMIT_ENABLED: "false", RATE_LIMIT_MAX: "1" });
  await withServer(config, async base => {
    for (let i = 0; i < 5; i++) assert.equal((await fetch(base + "/api/v1/agent")).status, 200);
  });
});

// Requires a real PostgreSQL database, like the customer-store integration test in
// tests/customers.test.ts. Run with: TEST_DATABASE_URL=postgresql://... npm test
const url = process.env.TEST_DATABASE_URL;
test("PostgresUsageRepository persists a durable, queryable ledger with only safe operational metadata (dedicated test database required)", { skip: !url }, async t => {
  const repo = new PostgresUsageRepository(url!);
  t.after(async () => { await repo.close(); });
  const requestId = `test-${Date.now()}`;
  await repo.record({ requestId, keyIdentifier: "mcp-remote", toolName: "analyze_property", accessMode: "mcp-remote", status: 200, durationMs: 12.5, billableAmount: 0, currency: "USD", timestamp: new Date().toISOString() });
  await repo.record({ requestId: requestId + "-x402", keyIdentifier: "x402:eip155:84532", toolName: "compare_properties", accessMode: "x402", status: 200, durationMs: 40, billableAmount: 0.03, currency: "USD", timestamp: new Date().toISOString() });
  const rows = await repo.recent(50);
  const found = rows.find(r => r.requestId === requestId);
  assert.ok(found);
  assert.equal(found!.accessMode, "mcp-remote");
  assert.equal(found!.toolName, "analyze_property");
  assert.equal(found!.billableAmount, 0);
  assert.equal(found!.currency, "USD");
  // No column and no stored value in this repository can ever carry a private key, payment
  // proof/signature or raw API key — the UsageRecord type has no such field, and every call
  // site (billing/service.ts, api/app.ts, mcp/remote.ts) only ever passes a redacted
  // keyIdentifier. This assertion is a regression guard on the values actually round-tripped,
  // not just the type.
  const serialized = JSON.stringify(rows);
  for (const forbidden of ["privateKey", "signature", "-----BEGIN"]) assert.ok(!serialized.includes(forbidden));
});

test("USAGE_REPOSITORY=postgres requires DATABASE_URL", () => {
  assert.throws(() => loadConfig({ RAFID_API_KEYS: key, USAGE_REPOSITORY: "postgres" }), /DATABASE_URL is required/);
  assert.doesNotThrow(() => loadConfig({ RAFID_API_KEYS: key, USAGE_REPOSITORY: "postgres", DATABASE_URL: "postgresql://localhost/rafid" }));
});
