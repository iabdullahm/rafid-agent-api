import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { createApp } from "../src/api/app.js";
import { loadConfig } from "../src/config/env.js";
import { capabilities } from "../src/domain/capabilities.js";
import { MemoryAnalyticsRepository } from "../src/analytics/memoryRepository.js";
import {
  DISCOVERY_PATHS, classifyX402Outcome, decodeX402SettlementHeader, recordX402Event, recordToolInvocation
} from "../src/analytics/recorder.js";
import { summarize, summarizeDiscovery, summarizeTools, summarizeX402 } from "../src/analytics/aggregate.js";
import { classifyDataSource } from "../src/analytics/dataSource.js";
import { hashClientIdentity, MAX_ATTRIBUTION_FIELD_LENGTH } from "../src/analytics/attribution.js";
import type { RequestClientContext } from "../src/analytics/context.js";

const key = "test-only-not-a-real-credential-12345";

/** Mirrors tests/mcp-remote.test.ts's withServer() helper: a real HTTP server over createApp(),
 *  with an injected in-memory AnalyticsRepository so every test below reads exactly the rows the
 *  running app recorded, rather than a second implementation of the numbers.
 *  ANALYTICS_INTERNAL_API_KEY is read from process.env at createApp() time (see
 *  src/analytics/config.ts), so this helper sets/clears it per call, exactly like
 *  tests/partner-feed.test.ts's startApp() does for MARKET_DATA_INTERNAL_API_KEY. */
async function startAnalyticsApp(opts: { internalApiKey?: string } = {}) {
  if (opts.internalApiKey !== undefined) process.env.ANALYTICS_INTERNAL_API_KEY = opts.internalApiKey;
  else delete process.env.ANALYTICS_INTERNAL_API_KEY;
  delete process.env.ANALYTICS_DATABASE_URL;
  const analyticsRepository = new MemoryAnalyticsRepository();
  const config = loadConfig({ RAFID_API_KEYS: key, LOG_LEVEL: "silent", RATE_LIMIT_ENABLED: "false" });
  const app = createApp(config, { analyticsRepository });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, base: `http://127.0.0.1:${address.port}`, analyticsRepository };
}

// -------------------------------------------------------------------------------------------
// DISCOVERY counting
// -------------------------------------------------------------------------------------------
test("analytics/discovery: hits on exactly the tracked surfaces are counted, per-path, and never leak into untracked endpoints", async t => {
  const internalApiKey = "test-analytics-internal-key-0123456789";
  const { server, base, analyticsRepository } = await startAnalyticsApp({ internalApiKey });
  t.after(() => { server.closeAllConnections(); server.close(); });

  // "/mcp" is a POST-only JSON-RPC transport — covered by the dedicated MCP test below.
  const trackedGetPaths = DISCOVERY_PATHS.filter(p => p !== "/mcp");
  for (const path of trackedGetPaths) assert.equal((await fetch(base + path)).status, 200);
  await fetch(base + "/agent.json"); // hit twice, to prove per-path counting isn't just presence/absence

  // Untracked discovery-ish endpoints (spec names 7 exact surfaces, not every discovery-adjacent
  // route) must never be recorded as a discovery hit.
  await fetch(base + "/api/v1/agent");
  await fetch(base + "/api/v1/pricing");
  await fetch(base + "/.well-known/ai-plugin.json");
  await fetch(base + "/api/v1/mcp/status");

  const discoveryEvents = analyticsRepository.all().filter(e => e.category === "discovery");
  assert.equal(discoveryEvents.length, trackedGetPaths.length + 1);
  const byPath = new Map<string, number>();
  for (const e of discoveryEvents) byPath.set(e.path!, (byPath.get(e.path!) ?? 0) + 1);
  assert.equal(byPath.get("/agent.json"), 2);
  for (const path of trackedGetPaths) assert.ok(byPath.has(path), `expected a recorded hit for ${path}`);
  assert.equal(byPath.size, trackedGetPaths.length);

  const response = await fetch(base + "/api/v1/internal/analytics/discovery", { headers: { "X-Internal-Api-Key": internalApiKey } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.last24h.totalHits, trackedGetPaths.length + 1);
  assert.equal(body.data.last24h.byPath["/agent.json"], 2);
  assert.equal(body.data.last7d.totalHits, body.data.last24h.totalHits);
  assert.equal(body.data.last30d.totalHits, body.data.last24h.totalHits);
  assert.equal(typeof body.data.last24h.uniqueClients, "number");
});

// -------------------------------------------------------------------------------------------
// MCP counting
// -------------------------------------------------------------------------------------------
test("analytics/mcp: initialize, tools/list and tools/call are each counted, with tool name, success and duration on tools/call", async t => {
  const { server, base, analyticsRepository } = await startAnalyticsApp();
  t.after(() => { server.closeAllConnections(); server.close(); });

  let nextId = 1;
  const rpc = (method: string, params: unknown = {}) => fetch(base + "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params })
  });

  await rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1.0.0" } });
  await rpc("tools/list");
  await rpc("tools/call", { name: "analyze_property", arguments: capabilities[0]!.example });
  await rpc("tools/call", { name: "analyze_property", arguments: { propertyValue: 0 } }); // deliberately invalid → failure path

  const mcpEvents = analyticsRepository.all().filter(e => e.category === "mcp");
  assert.equal(mcpEvents.filter(e => e.eventType === "initialize").length, 1);
  assert.equal(mcpEvents.filter(e => e.eventType === "tools_list").length, 1);
  const toolsCall = mcpEvents.filter(e => e.eventType === "tools_call");
  assert.equal(toolsCall.length, 2);
  assert.ok(toolsCall.every(e => e.toolName === "analyze_property"));
  assert.equal(toolsCall.filter(e => e.success === true).length, 1);
  assert.equal(toolsCall.filter(e => e.success === false).length, 1);
  assert.ok(toolsCall.every(e => typeof e.durationMs === "number" && e.durationMs! >= 0));

  // "/mcp" is one of the tracked discovery surfaces too (see DISCOVERY_PATHS) — one hit per HTTP
  // request reaching the transport, independent of the more granular MCP breakdown above.
  assert.equal(analyticsRepository.all().filter(e => e.category === "discovery" && e.path === "/mcp").length, 4);

  // Every tools/call attempt also produces a TOOL USAGE row (recordToolInvocation), the same
  // domain REST/x402 calls feed — so MCP traffic shows up in analyze_property's success rate too.
  const toolEvents = analyticsRepository.all().filter(e => e.category === "tool" && e.toolName === "analyze_property");
  assert.equal(toolEvents.length, 2);
});

// -------------------------------------------------------------------------------------------
// X402 funnel: classification, settlement decoding, and end-to-end aggregation.
//
// A full HTTP-level x402 test would need a live facilitator round-trip (this codebase's own
// tests/x402.test.ts skips exactly those cases in this sandbox — "Host not in allowlist:
// x402.org" — no network egress to the facilitator here). Testing the funnel logic directly
// against a MemoryAnalyticsRepository is deterministic, network-independent, and exercises the
// exact same functions api/app.ts's x402 middleware calls on every real request.
// -------------------------------------------------------------------------------------------
test("analytics/x402: outcome classification, settlement header decoding, and the full funnel roundtrip through summarizeX402", () => {
  assert.equal(classifyX402Outcome({ hadPaymentHeader: false, status: 402, settlement: null }), "challenge");
  assert.equal(classifyX402Outcome({ hadPaymentHeader: false, status: 200, settlement: null }), null);
  assert.equal(classifyX402Outcome({ hadPaymentHeader: true, status: 402, settlement: null }), "payment_failed");
  assert.equal(classifyX402Outcome({ hadPaymentHeader: true, status: 500, settlement: null }), "payment_failed");
  assert.equal(classifyX402Outcome({ hadPaymentHeader: true, status: 200, settlement: { success: true, transaction: "0xabc" } }), "settlement_success");
  assert.equal(classifyX402Outcome({ hadPaymentHeader: true, status: 200, settlement: { success: false } }), "settlement_failure");
  assert.equal(classifyX402Outcome({ hadPaymentHeader: true, status: 200, settlement: null }), null);

  const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64");
  assert.deepEqual(decodeX402SettlementHeader(encode({ success: true, transaction: "0xdeadbeef" })), { success: true, transaction: "0xdeadbeef" });
  assert.equal(decodeX402SettlementHeader(encode({ success: false }))!.success, false);
  assert.equal(decodeX402SettlementHeader(undefined), null);
  assert.equal(decodeX402SettlementHeader("not-base64-json"), null);
  assert.equal(decodeX402SettlementHeader(encode({ noSuccessField: true })), null);

  const repository = new MemoryAnalyticsRepository();
  const fakeReq = { header: () => undefined, socket: { remoteAddress: "127.0.0.1" } } as unknown as Request;
  recordX402Event(repository, fakeReq, { eventType: "challenge", toolName: "analyze_oman_property", amount: 0.05, currency: "USD", txHash: null });
  recordX402Event(repository, fakeReq, { eventType: "payment_verified", toolName: "analyze_oman_property", amount: 0.05, currency: "USD", txHash: null });
  recordX402Event(repository, fakeReq, { eventType: "settlement_success", toolName: "analyze_oman_property", amount: 0.05, currency: "USD", txHash: "0xdeadbeef" });
  recordX402Event(repository, fakeReq, { eventType: "settlement_failure", toolName: "compare_properties", amount: 0.03, currency: "USD", txHash: null });

  const summary = summarizeX402(repository.all(), new Date());
  assert.equal(summary.last24h.challenges, 1);
  assert.equal(summary.last24h.paymentVerified, 1);
  assert.equal(summary.last24h.paymentFailed, 0);
  assert.equal(summary.last24h.settlementSuccess, 1);
  assert.equal(summary.last24h.settlementFailure, 1);
  assert.equal(summary.last24h.settledAmountByCurrency.USD, 0.05);
  assert.equal(summary.last24h.byTool.analyze_oman_property!.challenges, 1);
  assert.equal(summary.last24h.byTool.analyze_oman_property!.settlementSuccess, 1);
  assert.equal(summary.last24h.byTool.compare_properties!.settlementFailure, 1);
  assert.equal(summary.last24h.recentSettlements.length, 1);
  assert.equal(summary.last24h.recentSettlements[0]!.txHash, "0xdeadbeef");
  assert.equal(summary.last24h.recentSettlements[0]!.toolName, "analyze_oman_property");

  // Never a raw payment proof, signature, or the X-PAYMENT header itself — the recordX402Event
  // signature accepts only toolName/amount/currency/txHash; this is a regression guard on what's
  // actually stored, not just the type.
  const serialized = JSON.stringify(repository.all());
  for (const forbidden of ["X-PAYMENT", "privateKey", "signature", "authorization"]) assert.ok(!serialized.toLowerCase().includes(forbidden.toLowerCase()));
});

// -------------------------------------------------------------------------------------------
// Partner-data usage %
// -------------------------------------------------------------------------------------------
test("analytics/tool-usage: classifyDataSource reads each capability's own provenance/coverage honestly, and aggregation reports partner-feed vs demo/manual usage", () => {
  assert.equal(classifyDataSource("analyze_oman_property", { provenance: [{ sourceType: "partner_feed" }] }), "partner_feed");
  assert.equal(classifyDataSource("analyze_oman_property", { provenance: [{ sourceType: "manual_benchmark" }] }), "demo_manual");
  assert.equal(classifyDataSource("analyze_oman_property", { provenance: [{ sourceType: "partner_feed" }, { sourceType: "manual_benchmark" }] }), "mixed");
  assert.equal(classifyDataSource("analyze_oman_property", { provenance: [] }), "unknown");
  assert.equal(classifyDataSource("get_oman_company_profile", { dataCoverage: { realSources: 2, demoSources: 0 } }), "partner_feed");
  assert.equal(classifyDataSource("get_oman_company_profile", { dataCoverage: { realSources: 0, demoSources: 1 } }), "demo_manual");
  assert.equal(classifyDataSource("get_oman_company_profile", { dataCoverage: { realSources: 1, demoSources: 1 } }), "mixed");
  assert.equal(classifyDataSource("search_oman_company", { matches: [{ companyId: "demo-co-1" }] }), "demo_manual");
  assert.equal(classifyDataSource("search_oman_company", { matches: [{ companyId: randomUUID() }] }), "partner_feed");
  assert.equal(classifyDataSource("analyze_property", { currency: "OMR" }), null); // no provenance concept for a pure calculator

  const repository = new MemoryAnalyticsRepository();
  const client: RequestClientContext = { clientHash: null, userAgent: null, referer: null, clientName: null };
  recordToolInvocation(repository, { toolName: "analyze_oman_property", channel: "rest", success: true, durationMs: 10, dataSource: "partner_feed", client });
  recordToolInvocation(repository, { toolName: "analyze_oman_property", channel: "x402", success: true, durationMs: 12, dataSource: "demo_manual", client });
  recordToolInvocation(repository, { toolName: "analyze_oman_property", channel: "rest", success: true, durationMs: 8, dataSource: "mixed", client });
  recordToolInvocation(repository, { toolName: "analyze_oman_property", channel: "rest", success: false, durationMs: 20, dataSource: "unknown", client });
  recordToolInvocation(repository, { toolName: "analyze_property", channel: "mcp-remote", success: true, durationMs: 5, dataSource: null, client });

  const summary = summarize(repository.all(), new Date());
  assert.equal(summary.last24h.toolInvocations, 5);
  // partnerFeedInvocations counts partner_feed + mixed; demoManualInvocations counts demo_manual + mixed.
  assert.equal(summary.last24h.partnerFeedInvocations, 2);
  assert.equal(summary.last24h.demoManualInvocations, 2);

  const tools = summarizeTools(repository.all(), new Date());
  const stats = tools.last24h.byTool.analyze_oman_property!;
  assert.equal(stats.calls, 4);
  assert.equal(stats.partnerFeedCalls, 1);
  assert.equal(stats.demoManualCalls, 1);
  assert.equal(stats.mixedCalls, 1);
  assert.equal(stats.unknownDataSourceCalls, 1);
  assert.equal(stats.successCount, 3);
  assert.equal(stats.failureCount, 1);
  assert.equal(stats.successRate, 75);
  assert.equal(stats.p50LatencyMs, 10);
  assert.ok(stats.p95LatencyMs !== null);
});

// -------------------------------------------------------------------------------------------
// No secret leakage
// -------------------------------------------------------------------------------------------
test("analytics: no raw API key, payment header, authorization value, private key or signature ever reaches a stored event or a summary response", async t => {
  const internalApiKey = "test-analytics-internal-key-0123456789";
  const { server, base, analyticsRepository } = await startAnalyticsApp({ internalApiKey });
  t.after(() => { server.closeAllConnections(); server.close(); });

  const longUserAgent = "X".repeat(500);
  await fetch(base + "/api/v1/property/analyze", {
    method: "POST",
    headers: {
      "X-API-Key": key,
      "Content-Type": "application/json",
      "User-Agent": longUserAgent,
      "X-Payment": "fake-payment-proof-should-never-be-stored",
      "Authorization": "Bearer super-secret-token-should-never-be-stored",
      "X-Client-Name": "test-agent"
    },
    body: JSON.stringify(capabilities[0]!.example)
  });

  const events = analyticsRepository.all();
  assert.ok(events.length > 0);
  const serialized = JSON.stringify(events);
  for (const forbidden of [key, internalApiKey, "fake-payment-proof-should-never-be-stored", "super-secret-token-should-never-be-stored", "Bearer"]) {
    assert.ok(!serialized.includes(forbidden), `analytics events must never contain: ${forbidden}`);
  }

  const toolEvent = events.find(e => e.category === "tool");
  assert.ok(toolEvent);
  // User-Agent is truncated to a bounded length, never stored raw/unbounded.
  assert.ok(toolEvent!.userAgent && toolEvent!.userAgent.length <= MAX_ATTRIBUTION_FIELD_LENGTH);
  // Client identity is a coarse, one-way hash — never a raw IP address.
  assert.ok(toolEvent!.clientHash && /^[0-9a-f]{16}$/.test(toolEvent!.clientHash));
  assert.equal(toolEvent!.clientName, "test-agent");

  const summaryResponse = await fetch(base + "/api/v1/internal/analytics/summary", { headers: { "X-Internal-Api-Key": internalApiKey } });
  const summaryText = await summaryResponse.text();
  for (const forbidden of [key, internalApiKey, "fake-payment-proof-should-never-be-stored", "super-secret-token-should-never-be-stored"]) {
    assert.ok(!summaryText.includes(forbidden));
  }
});

test("hashClientIdentity: deterministic and one-way — same input always hashes the same, the raw IP never appears in the result", () => {
  const h1 = hashClientIdentity("203.0.113.5", "TestAgent/1.0");
  const h2 = hashClientIdentity("203.0.113.5", "TestAgent/1.0");
  assert.equal(h1, h2);
  assert.equal(h1.length, 16);
  assert.ok(/^[0-9a-f]{16}$/.test(h1));
  assert.ok(!h1.includes("203.0.113.5"));
  const h3 = hashClientIdentity("203.0.113.6", "TestAgent/1.0");
  assert.notEqual(h1, h3);
});

// -------------------------------------------------------------------------------------------
// Internal auth protection
// -------------------------------------------------------------------------------------------
test("analytics internal auth: every route 503s when unconfigured, 401s on a missing/wrong key, 200s with the correct key, and is never reachable from a public discovery surface", async t => {
  {
    const { server, base } = await startAnalyticsApp({ internalApiKey: undefined });
    t.after(() => { server.closeAllConnections(); server.close(); });
    for (const path of ["summary", "discovery", "tools", "x402"]) {
      const response = await fetch(base + `/api/v1/internal/analytics/${path}`, { headers: { "X-Internal-Api-Key": "anything" } });
      assert.equal(response.status, 503);
    }
  }
  {
    const internalApiKey = "test-analytics-internal-key-0123456789";
    const { server, base } = await startAnalyticsApp({ internalApiKey });
    t.after(() => { server.closeAllConnections(); server.close(); });
    for (const path of ["summary", "discovery", "tools", "x402"]) {
      assert.equal((await fetch(base + `/api/v1/internal/analytics/${path}`)).status, 401);
      assert.equal((await fetch(base + `/api/v1/internal/analytics/${path}`, { headers: { "X-Internal-Api-Key": "wrong-key" } })).status, 401);
      assert.equal((await fetch(base + `/api/v1/internal/analytics/${path}`, { headers: { "X-Internal-Api-Key": internalApiKey } })).status, 200);
    }
    // Structurally unreachable from every public discovery surface — never registered in
    // src/domain/capabilities.ts (see analyticsRoutes.ts's doc comment).
    const agentManifest = await (await fetch(base + "/agent.json")).json();
    assert.ok(!JSON.stringify(agentManifest).toLowerCase().includes("analytics"));
    const toolCatalog = await (await fetch(base + "/api/v1/tools")).json();
    assert.ok(!JSON.stringify(toolCatalog).toLowerCase().includes("analytics"));
    const capabilitiesRegistry = await (await fetch(base + "/api/v1/capabilities")).json();
    assert.ok(!JSON.stringify(capabilitiesRegistry).toLowerCase().includes("analytics"));
    const openapi = await (await fetch(base + "/openapi.json")).json() as { paths: Record<string, unknown> };
    assert.ok(!Object.keys(openapi.paths).some(p => p.includes("/internal/analytics")));
    const llmsTxt = await (await fetch(base + "/llms.txt")).text();
    assert.ok(!llmsTxt.toLowerCase().includes("internal/analytics"));
  }
});
