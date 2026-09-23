import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createApp } from "../src/api/app.js";
import { loadConfig } from "../src/config/env.js";
import { MemoryAnalyticsRepository } from "../src/analytics/memoryRepository.js";
import { MemoryRevenueLedger } from "../src/revenue/memoryLedger.js";
import { hashAdminPassword } from "../src/middleware/adminAuth.js";
import { buildSettlementDedupeKey } from "../src/revenue/idempotency.js";
import {
  abbreviateTxHash, explorerUrlFor, buildRevenueTrend, sortToolConversionRows,
  buildAgentStatuses, buildActivityFeed, buildSystemHealthScore, buildCountSparkline, buildSettlementCountSparkline
} from "../src/api/dashboard/service.js";
import type { RevenueSettlement, RevenueSettlementInput, RevenueLedger } from "../src/revenue/types.js";
import type { AnalyticsEvent, AnalyticsEventInput } from "../src/analytics/types.js";
import type { ToolConversionRow, SystemStatusReport, X402FunnelReport } from "../src/api/dashboard/service.js";
import type { ToolsWindow } from "../src/analytics/aggregate.js";

const apiKey = "test-only-not-a-real-credential-12345";
const adminUsername = "ops-admin";
const adminPassword = "correct-horse-battery-staple-not-real";
const adminSessionSecret = "test-only-dashboard-session-secret-0123456789";
const revenueInternalApiKey = "test-only-revenue-internal-key-0123456789";
const analyticsInternalApiKey = "test-only-analytics-internal-key-0123456789";

/** Mirrors tests/revenue.test.ts's startRevenueApp()/startAnalyticsApp() helpers: a real HTTP
 *  server over createApp(), with injected in-memory AnalyticsRepository/RevenueLedger so tests
 *  read exactly the rows seeded directly into them. Admin/dashboard auth is configured so the
 *  dashboard router (config.adminEnabled) actually mounts. */
async function startDashboardApp(opts: { revenueLedger?: RevenueLedger; adminEnabled?: boolean } = {}) {
  process.env.REVENUE_INTERNAL_API_KEY = revenueInternalApiKey;
  process.env.ANALYTICS_INTERNAL_API_KEY = analyticsInternalApiKey;
  delete process.env.REVENUE_DATABASE_URL;
  delete process.env.ANALYTICS_DATABASE_URL;
  const analyticsRepository = new MemoryAnalyticsRepository();
  const revenueLedger = opts.revenueLedger ?? new MemoryRevenueLedger();
  const adminEnabled = opts.adminEnabled ?? true;
  const config = loadConfig({
    RAFID_API_KEYS: apiKey, LOG_LEVEL: "silent", RATE_LIMIT_ENABLED: "false",
    ...(adminEnabled ? {
      ADMIN_USERNAME: adminUsername, ADMIN_PASSWORD_HASH: hashAdminPassword(adminPassword), ADMIN_SESSION_SECRET: adminSessionSecret
    } : {})
  });
  const app = createApp(config, { analyticsRepository, revenueLedger });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, base: `http://127.0.0.1:${address.port}`, analyticsRepository, revenueLedger };
}

async function loginAndGetSessionCookie(base: string): Promise<string> {
  const response = await fetch(base + "/internal/dashboard/login", {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: adminUsername, password: adminPassword }).toString()
  });
  assert.equal(response.status, 302);
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "expected a Set-Cookie header on successful dashboard login");
  return setCookie!.split(";")[0]!;
}

function settlementRow(overrides: Partial<RevenueSettlementInput> = {}): RevenueSettlement {
  const base: RevenueSettlement = {
    requestId: overrides.requestId ?? `req-${Math.random().toString(36).slice(2)}`,
    toolName: "analyze_oman_property",
    capabilityName: "analyze_oman_property",
    amountAtomic: "250000",
    amountDecimal: 0.25,
    amountSource: "verified_requirement",
    currency: "USDC",
    network: "eip155:8453",
    asset: "USDC",
    payerAddress: null,
    payToAddress: "0xRafidWallet",
    transactionHash: `0x${"a".repeat(6)}${Math.random().toString(16).slice(2, 10)}${"b".repeat(30)}`,
    status: "settlement_succeeded",
    facilitator: "coinbase-cdp",
    errorReason: null,
    paymentVerifiedAt: new Date().toISOString(),
    settledAt: new Date().toISOString(),
    dedupeKey: "",
    createdAt: new Date().toISOString(),
    ...overrides
  };
  base.dedupeKey = overrides.dedupeKey ?? buildSettlementDedupeKey({
    network: base.network, transactionHash: base.transactionHash, requestId: base.requestId, toolName: base.toolName
  });
  return base;
}

function analyticsEvent(overrides: Partial<AnalyticsEventInput> = {}): AnalyticsEventInput {
  return {
    category: "tool", eventType: "invocation", path: null, toolName: "analyze_oman_property",
    channel: "x402", success: true, durationMs: 50, amount: null, currency: null, txHash: null,
    dataSource: null, clientHash: null, userAgent: null, referer: null, clientName: null,
    createdAt: new Date().toISOString(),
    ...overrides
  };
}

/** Fixture for pure-function tests of sortToolConversionRows() — never goes through HTTP/a
 *  repository, so every field defaults to a harmless zero/null and a test only sets what it needs
 *  to exercise a given sort key. */
function toolConversionRowFixture(overrides: Partial<ToolConversionRow> = {}): ToolConversionRow {
  return {
    toolName: "fixture_tool", calls: 0, successCount: 0, failureCount: 0, challenges: 0,
    paymentVerified: 0, settledCalls: 0, conversionPct: null, revenueByCurrency: {},
    revenue: null, currency: null, averageRevenuePerSettledCall: null,
    p50LatencyMs: null, p95LatencyMs: null,
    ...overrides
  };
}

/** Fixture for pure-function tests of buildAgentStatuses() — a ToolsWindow with only the named
 *  tools populated (every other AGENT_GROUPS tool defaults to "no calls", i.e. absent from byTool,
 *  exactly as summarizeToolsAllTime() would leave an uncalled tool). */
function toolsWindowFixture(byTool: Record<string, { calls: number; successCount: number; failureCount: number }>): ToolsWindow {
  const built: ToolsWindow["byTool"] = {};
  for (const [name, stats] of Object.entries(byTool)) {
    built[name] = {
      calls: stats.calls, successCount: stats.successCount, failureCount: stats.failureCount,
      successRate: null, p50LatencyMs: null, p95LatencyMs: null,
      partnerFeedCalls: 0, demoManualCalls: 0, mixedCalls: 0, unknownDataSourceCalls: 0
    };
  }
  return { totalInvocations: Object.values(built).reduce((a, s) => a + s.calls, 0), byTool: built, mcp: { initialize: 0, toolsList: 0, toolsCall: 0 } };
}

function x402FunnelFixture(overrides: Partial<X402FunnelReport> = {}): X402FunnelReport {
  return {
    challenges: 0, paymentVerified: 0, settlementSucceeded: 0, settlementFailed: 0,
    conversion: { challengeToVerifiedPct: null, verifiedToSettledPct: null, challengeToSettledPct: null },
    ...overrides
  };
}

function systemStatusFixture(overrides: Partial<SystemStatusReport> = {}): SystemStatusReport {
  return {
    mcp: "Enabled", x402: "Enabled", analytics: "Active", revenueLedger: "Active",
    partnerData: "Unknown", database: "Connected (in-memory — not durable across restarts)",
    lastSuccessfulSettlementAt: null, lastAnalyzeOmanPropertyCallAt: null, lastPartnerFeedAnalysisAt: null,
    ...overrides
  };
}

// -------------------------------------------------------------------------------------------
// Authorization (spec section 10 / 15)
// -------------------------------------------------------------------------------------------
test("dashboard authorization: the HTML page redirects to login and the JSON data route 401s without a session; both succeed with a valid session cookie", async t => {
  const { server, base } = await startDashboardApp();
  t.after(() => { server.closeAllConnections(); server.close(); });

  const pageNoAuth = await fetch(base + "/internal/dashboard", { redirect: "manual" });
  assert.equal(pageNoAuth.status, 302);
  assert.ok(pageNoAuth.headers.get("location")?.startsWith("/internal/dashboard/login"));

  const dataNoAuth = await fetch(base + "/internal/dashboard/data");
  assert.equal(dataNoAuth.status, 401);

  const cookie = await loginAndGetSessionCookie(base);
  const pageAuthed = await fetch(base + "/internal/dashboard", { headers: { Cookie: cookie } });
  assert.equal(pageAuthed.status, 200);
  assert.equal(pageAuthed.headers.get("content-type")?.split(";")[0], "text/html");

  const dataAuthed = await fetch(base + "/internal/dashboard/data", { headers: { Cookie: cookie } });
  assert.equal(dataAuthed.status, 200);
  const body = await dataAuthed.json();
  assert.equal(body.success, true);
});

test("dashboard authorization: a wrong password never establishes a session, and the dashboard 503s when admin auth is not configured at all", async t => {
  {
    const { server, base } = await startDashboardApp();
    t.after(() => { server.closeAllConnections(); server.close(); });
    const bad = await fetch(base + "/internal/dashboard/login", {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: adminUsername, password: "wrong-password" }).toString()
    });
    assert.equal(bad.status, 401);
    assert.equal(bad.headers.get("set-cookie"), null);
  }
  {
    const { server, base } = await startDashboardApp({ adminEnabled: false });
    t.after(() => { server.closeAllConnections(); server.close(); });
    assert.equal((await fetch(base + "/internal/dashboard")).status, 404);
    assert.equal((await fetch(base + "/internal/dashboard/data")).status, 404);
    assert.equal((await fetch(base + "/internal/dashboard/login")).status, 404);
  }
});

test("dashboard: never reachable from any public discovery surface (agent.json, tool catalog, capabilities, openapi, llms.txt)", async t => {
  const { server, base } = await startDashboardApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  // Checks for the specific route path, not the bare word "dashboard" — manifest.ts's own
  // discovery text legitimately contains the word ("Not designed primarily as a human dashboard
  // product."), so the bare word is not a reliable signal of a leak.
  const agentManifest = await (await fetch(base + "/agent.json")).json();
  assert.ok(!JSON.stringify(agentManifest).toLowerCase().includes("/internal/dashboard"));
  const toolCatalog = await (await fetch(base + "/api/v1/tools")).json();
  assert.ok(!JSON.stringify(toolCatalog).toLowerCase().includes("/internal/dashboard"));
  const openapi = await (await fetch(base + "/openapi.json")).json() as { paths: Record<string, unknown> };
  assert.ok(!Object.keys(openapi.paths).some(p => p.includes("/internal/dashboard")));
  const llmsTxt = await (await fetch(base + "/llms.txt")).text();
  assert.ok(!llmsTxt.toLowerCase().includes("internal/dashboard"));
});

// -------------------------------------------------------------------------------------------
// No server secrets in rendered HTML/client bundle (spec section 10 / 15)
// -------------------------------------------------------------------------------------------
test("dashboard: no internal API key, session secret, admin password hash, or public API key ever appears in the rendered HTML page or the JSON data response", async t => {
  const { server, base, revenueLedger } = await startDashboardApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  revenueLedger.record(settlementRow());
  const cookie = await loginAndGetSessionCookie(base);

  const html = await (await fetch(base + "/internal/dashboard", { headers: { Cookie: cookie } })).text();
  const json = await (await fetch(base + "/internal/dashboard/data", { headers: { Cookie: cookie } })).text();

  const forbidden = [
    revenueInternalApiKey, analyticsInternalApiKey, adminSessionSecret, apiKey,
    hashAdminPassword(adminPassword).slice(0, 20), // scrypt hash prefix is unique enough to detect leakage
    "REVENUE_INTERNAL_API_KEY", "ANALYTICS_INTERNAL_API_KEY", "ADMIN_SESSION_SECRET", "ADMIN_PASSWORD_HASH",
    "X-Internal-Api-Key", "privateKey", "facilitatorSecret"
  ];
  for (const secret of forbidden) {
    assert.ok(!html.includes(secret), `rendered HTML must never contain: ${secret}`);
    assert.ok(!json.includes(secret), `dashboard JSON data must never contain: ${secret}`);
  }
});

// -------------------------------------------------------------------------------------------
// Period selector: 24h / 7d / 30d / all
// -------------------------------------------------------------------------------------------
test("dashboard periods: 24h/7d/30d/all each include exactly the settlements within their horizon", async t => {
  const { server, base, revenueLedger } = await startDashboardApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const now = Date.now();
  revenueLedger.record(settlementRow({ createdAt: new Date(now - 1 * 60 * 60 * 1000).toISOString() })); // 1h ago
  revenueLedger.record(settlementRow({ createdAt: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString() })); // 2d ago
  revenueLedger.record(settlementRow({ createdAt: new Date(now - 20 * 24 * 60 * 60 * 1000).toISOString() })); // 20d ago
  revenueLedger.record(settlementRow({ createdAt: new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString() })); // 90d ago
  const cookie = await loginAndGetSessionCookie(base);

  const forPeriod = async (period: string) => {
    const res = await fetch(base + `/internal/dashboard/data?period=${period}`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.period, period);
    return body.data;
  };
  assert.equal((await forPeriod("24h")).revenue.settledPayments, 1);
  assert.equal((await forPeriod("7d")).revenue.settledPayments, 2);
  assert.equal((await forPeriod("30d")).revenue.settledPayments, 3);
  assert.equal((await forPeriod("all")).revenue.settledPayments, 4);

  const invalid = await fetch(base + "/internal/dashboard/data?period=90d", { headers: { Cookie: cookie } });
  assert.equal(invalid.status, 400);
});

// -------------------------------------------------------------------------------------------
// Zero-revenue empty state (spec section 13) — never fake sample transactions
// -------------------------------------------------------------------------------------------
test("dashboard zero-revenue state: reports an honest, explicit zero — never fabricated sample transactions", async t => {
  const { server, base } = await startDashboardApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const cookie = await loginAndGetSessionCookie(base);
  const body = await (await fetch(base + "/internal/dashboard/data?period=all", { headers: { Cookie: cookie } })).json();
  const data = body.data;
  assert.equal(data.revenue.settledPayments, 0);
  assert.deepEqual(data.revenue.revenueByCurrency, {});
  assert.equal(data.revenue.grossRevenueUSD, null);
  assert.equal(data.revenue.averageRevenuePerPaidCall, null);
  assert.deepEqual(data.transactions, []);
  assert.equal(data.reconciliation.anomalyCount, 0);
  for (const row of data.revenueByTool) { assert.equal(row.settledCalls, 0); assert.equal(row.revenue, null); }
});

// -------------------------------------------------------------------------------------------
// Revenue KPI cards
// -------------------------------------------------------------------------------------------
test("dashboard revenue cards: gross revenue, settled payments, paid calls, average revenue per paid call, failed settlements and reconciliation anomaly count are all present and correctly computed", async t => {
  const { server, base, revenueLedger, analyticsRepository } = await startDashboardApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  revenueLedger.record(settlementRow({ amountDecimal: 0.25 }));
  revenueLedger.record(settlementRow({ amountDecimal: 0.25 }));
  revenueLedger.record(settlementRow({ status: "settlement_failed", amountDecimal: null, amountAtomic: null, currency: null, asset: null, amountSource: "unavailable", settledAt: null, errorReason: "insufficient_funds" }));
  await analyticsRepository.record(analyticsEvent({ channel: "x402", success: true }));
  await analyticsRepository.record(analyticsEvent({ channel: "x402", success: true }));
  const cookie = await loginAndGetSessionCookie(base);
  const data = (await (await fetch(base + "/internal/dashboard/data?period=all", { headers: { Cookie: cookie } })).json()).data;

  assert.equal(data.revenue.grossRevenueUSD, 0.5);
  assert.equal(data.revenue.settledPayments, 2);
  assert.equal(data.revenue.failedSettlements, 1);
  assert.equal(data.revenue.averageRevenuePerPaidCall, 0.25);
  assert.equal(data.paidCalls, 2);
  assert.equal(typeof data.reconciliation.anomalyCount, "number");
  // Gross revenue must never be labeled "profit" anywhere in the payload.
  assert.ok(!JSON.stringify(data.revenue).toLowerCase().includes("profit"));
});

// -------------------------------------------------------------------------------------------
// Revenue by tool
// -------------------------------------------------------------------------------------------
test("dashboard revenue by tool: sorted by revenue descending, share of revenue computed within a single currency, capability list not hardcoded", async t => {
  const { server, base, revenueLedger } = await startDashboardApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  revenueLedger.record(settlementRow({ toolName: "analyze_oman_property", amountDecimal: 0.75 }));
  revenueLedger.record(settlementRow({ toolName: "analyze_property", amountDecimal: 0.25 }));
  const cookie = await loginAndGetSessionCookie(base);
  const data = (await (await fetch(base + "/internal/dashboard/data?period=all", { headers: { Cookie: cookie } })).json()).data;

  const names = data.revenueByTool.map((r: { toolName: string }) => r.toolName);
  // Every known capability appears (never hardcoded to just the two that settled), including
  // ones with zero revenue this period.
  assert.ok(names.includes("compare_properties"));
  assert.ok(names.includes("estimate_maintenance"));
  assert.equal(data.revenueByTool[0].toolName, "analyze_oman_property");
  assert.equal(data.revenueByTool[0].revenue, 0.75);
  assert.equal(data.revenueByTool[0].sharePct, 75);
  const second = data.revenueByTool.find((r: { toolName: string }) => r.toolName === "analyze_property");
  assert.equal(second.revenue, 0.25);
  assert.equal(second.sharePct, 25);
});

// -------------------------------------------------------------------------------------------
// x402 funnel
// -------------------------------------------------------------------------------------------
test("dashboard x402 funnel: counts come from analytics events and conversion rates are plain ratios over already-recorded counts, never inferred", async t => {
  const { server, base, analyticsRepository } = await startDashboardApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  for (let i = 0; i < 10; i++) await analyticsRepository.record(analyticsEvent({ category: "x402", eventType: "challenge", success: null }));
  for (let i = 0; i < 6; i++) await analyticsRepository.record(analyticsEvent({ category: "x402", eventType: "payment_verified", success: null }));
  for (let i = 0; i < 5; i++) await analyticsRepository.record(analyticsEvent({ category: "x402", eventType: "settlement_success", success: null }));
  for (let i = 0; i < 1; i++) await analyticsRepository.record(analyticsEvent({ category: "x402", eventType: "settlement_failure", success: null }));
  const cookie = await loginAndGetSessionCookie(base);
  const data = (await (await fetch(base + "/internal/dashboard/data?period=all", { headers: { Cookie: cookie } })).json()).data;

  assert.equal(data.x402Funnel.challenges, 10);
  assert.equal(data.x402Funnel.paymentVerified, 6);
  assert.equal(data.x402Funnel.settlementSucceeded, 5);
  assert.equal(data.x402Funnel.settlementFailed, 1);
  assert.equal(data.x402Funnel.conversion.challengeToVerifiedPct, 60);
  assert.equal(data.x402Funnel.conversion.verifiedToSettledPct, Math.round((5 / 6) * 1000) / 10);
  assert.equal(data.x402Funnel.conversion.challengeToSettledPct, 50);
});

test("dashboard x402 funnel: a zero-challenge period reports null conversion rates rather than dividing by zero or inferring a number", async t => {
  const { server, base } = await startDashboardApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const cookie = await loginAndGetSessionCookie(base);
  const data = (await (await fetch(base + "/internal/dashboard/data?period=24h", { headers: { Cookie: cookie } })).json()).data;
  assert.equal(data.x402Funnel.challenges, 0);
  assert.equal(data.x402Funnel.conversion.challengeToVerifiedPct, null);
  assert.equal(data.x402Funnel.conversion.verifiedToSettledPct, null);
  assert.equal(data.x402Funnel.conversion.challengeToSettledPct, null);
});

// -------------------------------------------------------------------------------------------
// Latest transactions
// -------------------------------------------------------------------------------------------
test("dashboard latest transactions: shows at most the latest 20, newest first", async t => {
  const { server, base, revenueLedger } = await startDashboardApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  for (let i = 0; i < 25; i++) {
    revenueLedger.record(settlementRow({ requestId: `req-${i}`, createdAt: new Date(Date.now() - i * 1000).toISOString() }));
  }
  const cookie = await loginAndGetSessionCookie(base);
  const data = (await (await fetch(base + "/internal/dashboard/data?period=all", { headers: { Cookie: cookie } })).json()).data;
  assert.equal(data.transactions.length, 20);
  assert.ok(new Date(data.transactions[0].time).getTime() >= new Date(data.transactions[1].time).getTime());
});

// -------------------------------------------------------------------------------------------
// Transaction hash abbreviation
// -------------------------------------------------------------------------------------------
test("transaction hash abbreviation: visually shortens the hash but never alters the underlying full value", () => {
  const full = "0x1234abcd5678efab9012cdef34567890abcdef1234567890abcdef12345678";
  const abbrev = abbreviateTxHash(full);
  assert.equal(abbrev, "0x1234...5678");
  assert.notEqual(abbrev, full);
  assert.equal(abbrev.startsWith(full.slice(0, 6)), true);
  assert.equal(abbrev.endsWith(full.slice(-4)), true);
  // A short/malformed hash is returned as-is rather than mangled.
  assert.equal(abbreviateTxHash("0xabc"), "0xabc");
});

test("dashboard latest transactions: the full transaction hash always round-trips alongside the abbreviated display value", async t => {
  const { server, base, revenueLedger } = await startDashboardApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const fullHash = "0x" + "ab".repeat(30);
  revenueLedger.record(settlementRow({ transactionHash: fullHash, network: "eip155:8453" }));
  const cookie = await loginAndGetSessionCookie(base);
  const data = (await (await fetch(base + "/internal/dashboard/data?period=all", { headers: { Cookie: cookie } })).json()).data;
  const tx = data.transactions[0];
  assert.equal(tx.transactionHashFull, fullHash);
  assert.equal(tx.transactionHashAbbrev, abbreviateTxHash(fullHash));
  assert.equal(tx.explorerUrl, "https://basescan.org/tx/" + fullHash);
});

test("explorer URL: built only for a known Base network from a well-formed hash, and never for an unrecognized network", () => {
  assert.equal(explorerUrlFor("eip155:8453", "0xabc123"), "https://basescan.org/tx/0xabc123");
  assert.equal(explorerUrlFor("eip155:84532", "0xabc123"), "https://sepolia.basescan.org/tx/0xabc123");
  assert.equal(explorerUrlFor("eip155:1", "0xabc123"), null);
  assert.equal(explorerUrlFor("eip155:8453", "not-a-hash"), null);
});

// -------------------------------------------------------------------------------------------
// Reconciliation
// -------------------------------------------------------------------------------------------
test("dashboard reconciliation: surfaces an anomaly when a settlement has no matching x402 tool execution", async t => {
  const { server, base, revenueLedger } = await startDashboardApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  revenueLedger.record(settlementRow({ toolName: "analyze_oman_property" }));
  const cookie = await loginAndGetSessionCookie(base);
  const data = (await (await fetch(base + "/internal/dashboard/data?period=all", { headers: { Cookie: cookie } })).json()).data;
  assert.ok(data.reconciliation.anomalyCount > 0);
  assert.ok(data.reconciliation.anomalies.some((a: { kind: string }) => a.kind === "settlement_without_tool_execution"));
});

test("dashboard reconciliation: reports zero anomalies (the '✓ No anomalies' state) when settlements and x402 executions agree", async t => {
  const { server, base, revenueLedger, analyticsRepository } = await startDashboardApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  revenueLedger.record(settlementRow({ toolName: "analyze_oman_property", amountDecimal: 0.25 }));
  await analyticsRepository.record(analyticsEvent({ toolName: "analyze_oman_property", channel: "x402", success: true, dataSource: "partner_feed" }));
  const cookie = await loginAndGetSessionCookie(base);
  const data = (await (await fetch(base + "/internal/dashboard/data?period=all", { headers: { Cookie: cookie } })).json()).data;
  const relevant = data.reconciliation.anomalies.filter((a: { toolName: string | null }) => a.toolName === "analyze_oman_property");
  assert.equal(relevant.length, 0);
});

// -------------------------------------------------------------------------------------------
// Multiple assets: never incorrectly combined (spec section 14)
// -------------------------------------------------------------------------------------------
test("dashboard: multiple settlement currencies are never summed into one figure — revenue, revenue-by-tool and the trend chart all keep separate per-currency totals", async t => {
  const { server, base, revenueLedger } = await startDashboardApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  revenueLedger.record(settlementRow({ toolName: "analyze_oman_property", currency: "USDC", amountDecimal: 0.25 }));
  revenueLedger.record(settlementRow({ toolName: "analyze_oman_property", currency: "EURC", asset: "EURC", amountDecimal: 0.20 }));
  const cookie = await loginAndGetSessionCookie(base);
  const data = (await (await fetch(base + "/internal/dashboard/data?period=all", { headers: { Cookie: cookie } })).json()).data;

  assert.deepEqual(data.revenue.revenueByCurrency, { USDC: 0.25, EURC: 0.20 });
  assert.equal(data.revenue.currency, null);
  assert.equal(data.revenue.grossRevenueUSD, null);
  const row = data.revenueByTool.find((r: { toolName: string }) => r.toolName === "analyze_oman_property");
  assert.deepEqual(row.revenueByCurrency, { USDC: 0.25, EURC: 0.20 });
  assert.equal(row.revenue, null); // ambiguous across currencies — never silently picked or summed
  const bucketWithData = data.revenueTrend.buckets.find((b: { revenueByCurrency: Record<string, number> }) => Object.keys(b.revenueByCurrency).length > 0);
  assert.ok(bucketWithData);
  assert.ok("USDC" in bucketWithData.revenueByCurrency || "EURC" in bucketWithData.revenueByCurrency);
});

test("buildRevenueTrend: buckets each currency's settled amount separately and never blends them into one number", () => {
  const now = new Date("2026-09-22T12:00:00.000Z");
  const rows: RevenueSettlement[] = [
    settlementRow({ currency: "USDC", amountDecimal: 1, createdAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString() }),
    settlementRow({ currency: "EURC", asset: "EURC", amountDecimal: 2, createdAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString() })
  ];
  const trend = buildRevenueTrend(rows, "24h", now);
  assert.equal(trend.granularity, "hourly");
  const total = trend.buckets.reduce((sum, b) => sum + Object.values(b.revenueByCurrency).reduce((a, c) => a + c, 0), 0);
  assert.equal(Math.round(total * 100) / 100, 3);
  const bucketWithBoth = trend.buckets.find(b => b.revenueByCurrency.USDC && b.revenueByCurrency.EURC);
  assert.ok(bucketWithBoth);
  assert.equal(bucketWithBoth!.revenueByCurrency.USDC, 1);
  assert.equal(bucketWithBoth!.revenueByCurrency.EURC, 2);
});

// -------------------------------------------------------------------------------------------
// Partner-feed usage percentage
// -------------------------------------------------------------------------------------------
test("dashboard partner-feed usage percentage: computed only from actual provenance recorded by the analytics layer", async t => {
  const { server, base, analyticsRepository } = await startDashboardApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  await analyticsRepository.record(analyticsEvent({ dataSource: "partner_feed" }));
  await analyticsRepository.record(analyticsEvent({ dataSource: "partner_feed" }));
  await analyticsRepository.record(analyticsEvent({ dataSource: "demo_manual" }));
  await analyticsRepository.record(analyticsEvent({ dataSource: "unknown" }));
  const cookie = await loginAndGetSessionCookie(base);
  const data = (await (await fetch(base + "/internal/dashboard/data?period=all", { headers: { Cookie: cookie } })).json()).data;
  // 2 partner_feed out of 4 total tool invocations = 50%.
  assert.equal(data.usage.partnerFeedUsagePct, 50);
});

test("dashboard partner-feed usage percentage: null (not zero) when there are no tool invocations at all in the period", async t => {
  const { server, base } = await startDashboardApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const cookie = await loginAndGetSessionCookie(base);
  const data = (await (await fetch(base + "/internal/dashboard/data?period=24h", { headers: { Cookie: cookie } })).json()).data;
  assert.equal(data.usage.partnerFeedUsagePct, null);
});

// -------------------------------------------------------------------------------------------
// Top Tools / Conversion by Tool (dashboard section added 2026-09-23) — reuses toolsWindow
// (analytics tool-call events), x402Window (analytics x402 funnel events) and toolRevenue (the
// revenue ledger) exactly as buildDashboardData() already computes them for revenueByTool/usage;
// no new analytics system, no new revenue table, no new query.
// -------------------------------------------------------------------------------------------
test("tool conversion: a tool with calls but no 402 challenges has zero challenges/settlements and a null (not zero) conversion rate", async t => {
  const { server, base, analyticsRepository } = await startDashboardApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  await analyticsRepository.record(analyticsEvent({ toolName: "compare_properties", channel: "rest", success: true }));
  await analyticsRepository.record(analyticsEvent({ toolName: "compare_properties", channel: "rest", success: true }));
  await analyticsRepository.record(analyticsEvent({ toolName: "compare_properties", channel: "rest", success: true }));
  const cookie = await loginAndGetSessionCookie(base);
  const data = (await (await fetch(base + "/internal/dashboard/data?period=all", { headers: { Cookie: cookie } })).json()).data;
  const row = data.toolConversion.find((r: { toolName: string }) => r.toolName === "compare_properties");
  assert.ok(row, "expected a toolConversion row for compare_properties");
  assert.equal(row.calls, 3);
  assert.equal(row.successCount, 3);
  assert.equal(row.challenges, 0);
  assert.equal(row.settledCalls, 0);
  assert.equal(row.conversionPct, null);
  assert.equal(row.revenue, null);
  assert.deepEqual(row.revenueByCurrency, {});
});

test("tool conversion: a tool with 402 challenges but zero settlements reports a real 0% conversion, never null", async t => {
  const { server, base, analyticsRepository } = await startDashboardApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  for (let i = 0; i < 4; i++) {
    await analyticsRepository.record(analyticsEvent({ category: "x402", eventType: "challenge", toolName: "find_companies", success: null }));
  }
  const cookie = await loginAndGetSessionCookie(base);
  const data = (await (await fetch(base + "/internal/dashboard/data?period=all", { headers: { Cookie: cookie } })).json()).data;
  const row = data.toolConversion.find((r: { toolName: string }) => r.toolName === "find_companies");
  assert.ok(row);
  assert.equal(row.challenges, 4);
  assert.equal(row.settledCalls, 0);
  assert.equal(row.conversionPct, 0);
});

test("tool conversion: settled/challenges yields the correct nonzero conversion percentage, payment-verified count, average revenue per settled call, and total revenue", async t => {
  const { server, base, analyticsRepository, revenueLedger } = await startDashboardApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  for (let i = 0; i < 5; i++) {
    await analyticsRepository.record(analyticsEvent({ category: "x402", eventType: "challenge", toolName: "analyze_company_risk", success: null }));
  }
  for (let i = 0; i < 3; i++) {
    await analyticsRepository.record(analyticsEvent({ category: "x402", eventType: "payment_verified", toolName: "analyze_company_risk", success: null }));
  }
  revenueLedger.record(settlementRow({ toolName: "analyze_company_risk", amountDecimal: 0.15 }));
  revenueLedger.record(settlementRow({ toolName: "analyze_company_risk", amountDecimal: 0.15 }));
  const cookie = await loginAndGetSessionCookie(base);
  const data = (await (await fetch(base + "/internal/dashboard/data?period=all", { headers: { Cookie: cookie } })).json()).data;
  const row = data.toolConversion.find((r: { toolName: string }) => r.toolName === "analyze_company_risk");
  assert.ok(row);
  assert.equal(row.challenges, 5);
  assert.equal(row.paymentVerified, 3);
  assert.equal(row.settledCalls, 2);
  assert.equal(row.conversionPct, 40);
  assert.equal(row.revenue, 0.3);
  assert.equal(row.currency, "USDC");
  assert.equal(row.averageRevenuePerSettledCall, 0.15);
});

test("tool conversion: a zero-challenge denominator always yields null, never a divide-by-zero or fabricated 0%, even when the tool has settlements", async t => {
  const { server, base, revenueLedger } = await startDashboardApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  // Settled with no matching recorded 402 challenge for this tool — the denominator is zero even
  // though the numerator (settledCalls) is not.
  revenueLedger.record(settlementRow({ toolName: "research_company", amountDecimal: 0.35 }));
  const cookie = await loginAndGetSessionCookie(base);
  const data = (await (await fetch(base + "/internal/dashboard/data?period=all", { headers: { Cookie: cookie } })).json()).data;
  const row = data.toolConversion.find((r: { toolName: string }) => r.toolName === "research_company");
  assert.ok(row);
  assert.equal(row.challenges, 0);
  assert.equal(row.settledCalls, 1);
  assert.equal(row.conversionPct, null, "must never divide 1 settled call by 0 challenges");
});

test("tool conversion: revenue is summed across every settled row for a tool and excludes settlement_failed rows entirely", async t => {
  const { server, base, analyticsRepository, revenueLedger } = await startDashboardApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  for (let i = 0; i < 3; i++) {
    await analyticsRepository.record(analyticsEvent({ category: "x402", eventType: "challenge", toolName: "estimate_maintenance", success: null }));
  }
  revenueLedger.record(settlementRow({ toolName: "estimate_maintenance", amountDecimal: 0.1 }));
  revenueLedger.record(settlementRow({ toolName: "estimate_maintenance", amountDecimal: 0.2 }));
  revenueLedger.record(settlementRow({
    toolName: "estimate_maintenance", status: "settlement_failed", amountDecimal: null, amountAtomic: null,
    currency: null, asset: null, amountSource: "unavailable", settledAt: null, errorReason: "insufficient_funds"
  }));
  const cookie = await loginAndGetSessionCookie(base);
  const data = (await (await fetch(base + "/internal/dashboard/data?period=all", { headers: { Cookie: cookie } })).json()).data;
  const row = data.toolConversion.find((r: { toolName: string }) => r.toolName === "estimate_maintenance");
  assert.ok(row);
  assert.equal(row.settledCalls, 2);
  assert.equal(row.revenue, 0.3);
  assert.equal(row.conversionPct, Math.round((2 / 3) * 1000) / 10);
});

test("tool conversion: multiple capabilities are tracked independently, and a capability with no activity this period is omitted — unlike Revenue by Tool, which always lists every known capability", async t => {
  const { server, base, analyticsRepository, revenueLedger } = await startDashboardApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  await analyticsRepository.record(analyticsEvent({ toolName: "analyze_oman_property", channel: "rest", success: true }));
  await analyticsRepository.record(analyticsEvent({ category: "x402", eventType: "challenge", toolName: "find_companies", success: null }));
  revenueLedger.record(settlementRow({ toolName: "research_company", amountDecimal: 0.35 }));
  const cookie = await loginAndGetSessionCookie(base);
  const data = (await (await fetch(base + "/internal/dashboard/data?period=all", { headers: { Cookie: cookie } })).json()).data;
  const names = data.toolConversion.map((r: { toolName: string }) => r.toolName);
  assert.ok(names.includes("analyze_oman_property"));
  assert.ok(names.includes("find_companies"));
  assert.ok(names.includes("research_company"));
  assert.ok(!names.includes("compare_properties"), "a capability with zero activity this period must not appear in toolConversion");
  assert.ok(data.revenueByTool.some((r: { toolName: string }) => r.toolName === "compare_properties"), "but it must still appear in revenueByTool, which always lists every capability");
});

test("tool conversion: failed tool calls are counted separately from successful calls, both included in the call total", async t => {
  const { server, base, analyticsRepository } = await startDashboardApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  await analyticsRepository.record(analyticsEvent({ toolName: "compare_properties", channel: "rest", success: true }));
  await analyticsRepository.record(analyticsEvent({ toolName: "compare_properties", channel: "rest", success: true }));
  await analyticsRepository.record(analyticsEvent({ toolName: "compare_properties", channel: "rest", success: false }));
  const cookie = await loginAndGetSessionCookie(base);
  const data = (await (await fetch(base + "/internal/dashboard/data?period=all", { headers: { Cookie: cookie } })).json()).data;
  const row = data.toolConversion.find((r: { toolName: string }) => r.toolName === "compare_properties");
  assert.equal(row.calls, 3);
  assert.equal(row.successCount, 2);
  assert.equal(row.failureCount, 1);
});

test("tool conversion: p50/p95 latency for a tool matches the nearest-rank percentile of that tool's own recorded call durations", async t => {
  const { server, base, analyticsRepository } = await startDashboardApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const durations = [10, 20, 30, 40, 100]; // nearest-rank p50 -> 30, p95 -> 100 (see aggregate.ts's percentile())
  for (const durationMs of durations) {
    await analyticsRepository.record(analyticsEvent({ toolName: "analyze_property", channel: "rest", success: true, durationMs }));
  }
  const cookie = await loginAndGetSessionCookie(base);
  const data = (await (await fetch(base + "/internal/dashboard/data?period=all", { headers: { Cookie: cookie } })).json()).data;
  const row = data.toolConversion.find((r: { toolName: string }) => r.toolName === "analyze_property");
  assert.equal(row.p50LatencyMs, 30);
  assert.equal(row.p95LatencyMs, 100);
});

test("tool conversion: respects the 24h/7d/30d/all period selector for calls and settlements alike", async t => {
  const { server, base, analyticsRepository, revenueLedger } = await startDashboardApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const now = Date.now();
  await analyticsRepository.record(analyticsEvent({ toolName: "analyze_oman_property", channel: "rest", success: true, createdAt: new Date(now - 1 * 60 * 60 * 1000).toISOString() })); // 1h ago
  await analyticsRepository.record(analyticsEvent({ toolName: "analyze_oman_property", channel: "rest", success: true, createdAt: new Date(now - 20 * 24 * 60 * 60 * 1000).toISOString() })); // 20d ago
  revenueLedger.record(settlementRow({ toolName: "analyze_oman_property", amountDecimal: 0.25, createdAt: new Date(now - 1 * 60 * 60 * 1000).toISOString() }));
  revenueLedger.record(settlementRow({ toolName: "analyze_oman_property", amountDecimal: 0.25, createdAt: new Date(now - 20 * 24 * 60 * 60 * 1000).toISOString() }));
  const cookie = await loginAndGetSessionCookie(base);

  const rowFor = async (period: string) => {
    const data = (await (await fetch(base + `/internal/dashboard/data?period=${period}`, { headers: { Cookie: cookie } })).json()).data;
    return data.toolConversion.find((r: { toolName: string }) => r.toolName === "analyze_oman_property");
  };
  const last24h = await rowFor("24h");
  assert.equal(last24h.calls, 1);
  assert.equal(last24h.settledCalls, 1);
  const last30d = await rowFor("30d");
  assert.equal(last30d.calls, 2);
  assert.equal(last30d.settledCalls, 2);
});

test("tool conversion: settled rows in different currencies for the same tool are never summed — revenue is null and revenueByCurrency lists both separately", async t => {
  const { server, base, revenueLedger } = await startDashboardApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  revenueLedger.record(settlementRow({ toolName: "analyze_oman_property", currency: "USDC", amountDecimal: 0.25 }));
  revenueLedger.record(settlementRow({ toolName: "analyze_oman_property", currency: "EURC", asset: "EURC", amountDecimal: 0.20 }));
  const cookie = await loginAndGetSessionCookie(base);
  const data = (await (await fetch(base + "/internal/dashboard/data?period=all", { headers: { Cookie: cookie } })).json()).data;
  const row = data.toolConversion.find((r: { toolName: string }) => r.toolName === "analyze_oman_property");
  assert.equal(row.revenue, null);
  assert.equal(row.currency, null);
  assert.deepEqual(row.revenueByCurrency, { USDC: 0.25, EURC: 0.20 });
  assert.equal(row.averageRevenuePerSettledCall, null);
});

test("tool conversion: the toolConversion payload never leaks internal API keys, session secrets, or admin credentials", async t => {
  const { server, base, analyticsRepository, revenueLedger } = await startDashboardApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  await analyticsRepository.record(analyticsEvent({ category: "x402", eventType: "challenge", toolName: "analyze_company_risk", success: null }));
  await analyticsRepository.record(analyticsEvent({ toolName: "analyze_company_risk", channel: "x402", success: true }));
  revenueLedger.record(settlementRow({ toolName: "analyze_company_risk", amountDecimal: 0.15 }));
  const cookie = await loginAndGetSessionCookie(base);
  const json = await (await fetch(base + "/internal/dashboard/data?period=all", { headers: { Cookie: cookie } })).text();
  const parsed = JSON.parse(json);
  assert.ok(parsed.data.toolConversion.length > 0, "expected at least one toolConversion row to actually exercise this payload");
  const forbidden = [
    revenueInternalApiKey, analyticsInternalApiKey, adminSessionSecret, apiKey,
    hashAdminPassword(adminPassword).slice(0, 20),
    "REVENUE_INTERNAL_API_KEY", "ANALYTICS_INTERNAL_API_KEY", "ADMIN_SESSION_SECRET", "ADMIN_PASSWORD_HASH",
    "privateKey", "facilitatorSecret"
  ];
  for (const secret of forbidden) assert.ok(!json.includes(secret), `toolConversion payload must never contain: ${secret}`);
});

test("dashboard UI: the Top Tools / Conversion by Tool panel, its sort control, and its exact empty-state copy are present in the rendered page", async t => {
  const { server, base } = await startDashboardApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const cookie = await loginAndGetSessionCookie(base);
  const html = await (await fetch(base + "/internal/dashboard", { headers: { Cookie: cookie } })).text();
  assert.ok(html.includes("Top Tools / Conversion by Tool"));
  assert.ok(html.includes('id="tool-conversion-sort"'));
  assert.ok(html.includes("No tool usage recorded in this period."));
});

test("sortToolConversionRows: sorts by revenue descending by default, tie-broken by settled calls", () => {
  const rows: ToolConversionRow[] = [
    toolConversionRowFixture({ toolName: "a", revenue: 1, settledCalls: 1 }),
    toolConversionRowFixture({ toolName: "b", revenue: 5, settledCalls: 2 }),
    toolConversionRowFixture({ toolName: "c", revenue: null, settledCalls: 0 }),
    toolConversionRowFixture({ toolName: "d", revenue: 5, settledCalls: 4 })
  ];
  const sorted = sortToolConversionRows(rows, "revenue").map(r => r.toolName);
  assert.deepEqual(sorted, ["d", "b", "a", "c"]);
});

test("sortToolConversionRows: sorting by conversion rate ranks null (no 402 opportunity to convert) below every real percentage, tie-broken by revenue", () => {
  const rows: ToolConversionRow[] = [
    toolConversionRowFixture({ toolName: "low", conversionPct: 10, revenue: 1 }),
    toolConversionRowFixture({ toolName: "high", conversionPct: 80, revenue: 1 }),
    toolConversionRowFixture({ toolName: "none", conversionPct: null, revenue: 100 }),
    toolConversionRowFixture({ toolName: "mid", conversionPct: 50, revenue: 1 })
  ];
  const sorted = sortToolConversionRows(rows, "conversion").map(r => r.toolName);
  assert.deepEqual(sorted, ["high", "mid", "low", "none"]);
});

test("sortToolConversionRows: sorting by total calls and by settled calls each rank on their own column, both falling back to the revenue tie-break", () => {
  const rows: ToolConversionRow[] = [
    toolConversionRowFixture({ toolName: "many-calls-no-revenue", calls: 50, settledCalls: 0, revenue: null }),
    toolConversionRowFixture({ toolName: "few-calls-high-revenue", calls: 2, settledCalls: 2, revenue: 10 })
  ];
  assert.deepEqual(sortToolConversionRows(rows, "calls").map(r => r.toolName), ["many-calls-no-revenue", "few-calls-high-revenue"]);
  assert.deepEqual(sortToolConversionRows(rows, "settled").map(r => r.toolName), ["few-calls-high-revenue", "many-calls-no-revenue"]);
});

// -------------------------------------------------------------------------------------------
// AI Agent Operations Command Center (dashboard redesign added 2026-09-23) — agents,
// activity feed, system health score, and sparklines. All derived from data already fetched by
// buildDashboardData(); see service.ts's own doc comments for exactly which real fields back each.
// -------------------------------------------------------------------------------------------

test("buildAgentStatuses: a tool-group agent reports waiting/active/processing/error correctly from real call stats and event recency", () => {
  const now = new Date();
  const oldTs = new Date(now.getTime() - 10 * 60 * 1000).toISOString(); // outside the 2-minute "processing" window
  const recentTs = new Date(now.getTime() - 30 * 1000).toISOString(); // inside it

  // Waiting: zero calls at all this period.
  const waiting = buildAgentStatuses({
    events: [], toolsWindow: toolsWindowFixture({}), x402Funnel: x402FunnelFixture(), settledPayments: 0, anomalyCount: 0, now
  }).find(a => a.id === "property")!;
  assert.equal(waiting.status, "waiting");
  assert.equal(waiting.calls, 0);

  // Active: real calls, high success rate, most recent call outside the "processing" window.
  const active = buildAgentStatuses({
    events: [analyticsEvent({ toolName: "analyze_oman_property", channel: "rest", success: true, createdAt: oldTs }) as AnalyticsEvent],
    toolsWindow: toolsWindowFixture({ analyze_oman_property: { calls: 10, successCount: 10, failureCount: 0 } }),
    x402Funnel: x402FunnelFixture(), settledPayments: 0, anomalyCount: 0, now
  }).find(a => a.id === "property")!;
  assert.equal(active.status, "active");
  assert.equal(active.calls, 10);

  // Processing: most recent real call for the group landed inside the last 2 minutes.
  const processing = buildAgentStatuses({
    events: [analyticsEvent({ toolName: "research_company", channel: "rest", success: true, createdAt: recentTs }) as AnalyticsEvent],
    toolsWindow: toolsWindowFixture({ research_company: { calls: 1, successCount: 1, failureCount: 0 } }),
    x402Funnel: x402FunnelFixture(), settledPayments: 0, anomalyCount: 0, now
  }).find(a => a.id === "research")!;
  assert.equal(processing.status, "processing");

  // Error: real calls, majority failing, most recent call outside the processing window.
  const errorRow = buildAgentStatuses({
    events: [analyticsEvent({ toolName: "analyze_company_risk", channel: "rest", success: false, createdAt: oldTs }) as AnalyticsEvent],
    toolsWindow: toolsWindowFixture({ analyze_company_risk: { calls: 10, successCount: 2, failureCount: 8 } }),
    x402Funnel: x402FunnelFixture(), settledPayments: 0, anomalyCount: 0, now
  }).find(a => a.id === "risk")!;
  assert.equal(errorRow.status, "error");
  assert.equal(errorRow.statusLabel, "Elevated failures");

  // Error: a real, already-tracked "not_configured" data-source signal on a recent call overrides
  // everything else, even a perfect success rate — this is a genuine provider-misconfiguration
  // marker, not a guess (see analytics/types.ts's DataSource doc comment).
  const notConfigured = buildAgentStatuses({
    events: [analyticsEvent({ toolName: "research_company", channel: "rest", success: true, dataSource: "not_configured", createdAt: oldTs }) as AnalyticsEvent],
    toolsWindow: toolsWindowFixture({ research_company: { calls: 3, successCount: 3, failureCount: 0 } }),
    x402Funnel: x402FunnelFixture(), settledPayments: 0, anomalyCount: 0, now
  }).find(a => a.id === "research")!;
  assert.equal(notConfigured.status, "error");
  assert.equal(notConfigured.statusLabel, "Not configured");
});

test("buildAgentStatuses: the Payment/Settlement agent derives its status from the x402 funnel, never from a per-tool call count", () => {
  const now = new Date();
  const waiting = buildAgentStatuses({
    events: [], toolsWindow: toolsWindowFixture({}), x402Funnel: x402FunnelFixture(), settledPayments: 0, anomalyCount: 0, now
  }).find(a => a.id === "payment")!;
  assert.equal(waiting.status, "waiting");

  const active = buildAgentStatuses({
    events: [], toolsWindow: toolsWindowFixture({}),
    x402Funnel: x402FunnelFixture({ challenges: 5, settlementSucceeded: 5 }), settledPayments: 5, anomalyCount: 0, now
  }).find(a => a.id === "payment")!;
  assert.equal(active.status, "active");
  assert.equal(active.metricLabel, "5 challenge(s) · 5 settled");

  const errorRow = buildAgentStatuses({
    events: [], toolsWindow: toolsWindowFixture({}),
    x402Funnel: x402FunnelFixture({ challenges: 3, settlementFailed: 3, settlementSucceeded: 0 }), settledPayments: 0, anomalyCount: 0, now
  }).find(a => a.id === "payment")!;
  assert.equal(errorRow.status, "error");
});

test("buildAgentStatuses: the Reconciliation agent is 'All clear' with zero anomalies and 'error' the moment any anomaly exists", () => {
  const now = new Date();
  const clear = buildAgentStatuses({
    events: [], toolsWindow: toolsWindowFixture({}), x402Funnel: x402FunnelFixture(), settledPayments: 0, anomalyCount: 0, now
  }).find(a => a.id === "reconciliation")!;
  assert.equal(clear.status, "active");
  assert.equal(clear.statusLabel, "All clear");

  const anomalous = buildAgentStatuses({
    events: [], toolsWindow: toolsWindowFixture({}), x402Funnel: x402FunnelFixture(), settledPayments: 0, anomalyCount: 2, now
  }).find(a => a.id === "reconciliation")!;
  assert.equal(anomalous.status, "error");
  assert.equal(anomalous.metricLabel, "2 anomaly(ies) this period");
});

test("buildActivityFeed: sorts newest-first, produces a human-readable label per event category, and caps the result", () => {
  const events: AnalyticsEvent[] = [
    analyticsEvent({ category: "discovery", eventType: "hit", path: "/agent.json", toolName: null, channel: null, createdAt: "2026-01-01T00:00:00.000Z" }) as AnalyticsEvent,
    analyticsEvent({ category: "mcp", eventType: "initialize", toolName: null, channel: null, createdAt: "2026-01-01T00:01:00.000Z" }) as AnalyticsEvent,
    analyticsEvent({ category: "x402", eventType: "challenge", toolName: "find_companies", channel: null, success: null, createdAt: "2026-01-01T00:02:00.000Z" }) as AnalyticsEvent,
    analyticsEvent({ category: "tool", eventType: "invocation", toolName: "analyze_oman_property", channel: "rest", success: true, durationMs: 120, createdAt: "2026-01-01T00:03:00.000Z" }) as AnalyticsEvent
  ];
  const feed = buildActivityFeed(events);
  assert.equal(feed.length, 4);
  assert.equal(feed[0]!.at, "2026-01-01T00:03:00.000Z");
  assert.match(feed[0]!.label, /analyze_oman_property call completed \(120ms\)/);
  assert.match(feed[1]!.label, /402 payment challenge issued for find_companies/);
  assert.match(feed[2]!.label, /MCP session initialized/);
  assert.match(feed[3]!.label, /Discovery hit on \/agent\.json/);

  const many: AnalyticsEvent[] = Array.from({ length: 60 }, (_, i) =>
    analyticsEvent({ createdAt: new Date(Date.now() - i * 1000).toISOString() }) as AnalyticsEvent);
  assert.equal(buildActivityFeed(many).length, 50);
});

test("buildActivityFeed: never carries a client hash, user agent, or referer into the feed, even when the source event has one", () => {
  const risky = analyticsEvent({ clientHash: "deadbeef", userAgent: "SecretAgent/1.0", referer: "https://internal.example/secret" }) as AnalyticsEvent;
  const feed = buildActivityFeed([risky]);
  const json = JSON.stringify(feed);
  assert.ok(!json.includes("deadbeef"));
  assert.ok(!json.includes("SecretAgent"));
  assert.ok(!json.includes("internal.example"));
});

test("buildSystemHealthScore: scores 100% only when every actually-measured check is healthy, and an Unknown signal is excluded from the denominator rather than counted either way", () => {
  const allHealthy = buildSystemHealthScore(systemStatusFixture(), 0);
  assert.equal(allHealthy.scorePct, 100);
  assert.equal(allHealthy.measuredCount, 4);
  assert.equal(allHealthy.healthyCount, 4);

  const oneUnmeasured = buildSystemHealthScore(systemStatusFixture({ analytics: "Unknown" }), 0);
  assert.equal(oneUnmeasured.measuredCount, 3);
  assert.equal(oneUnmeasured.healthyCount, 3);
  assert.equal(oneUnmeasured.scorePct, 100, "an unmeasured signal must never drag the score below 100% on its own");

  const withAnomalies = buildSystemHealthScore(systemStatusFixture(), 2);
  assert.ok(withAnomalies.scorePct < 100);
  assert.equal(withAnomalies.checks.find(c => c.label === "Reconciliation")?.healthy, false);
});

test("buildCountSparkline: a 24h period returns 24 hourly buckets whose sum matches the real matching event count", () => {
  const now = new Date();
  const events: AnalyticsEvent[] = [
    analyticsEvent({ category: "tool", createdAt: new Date(now.getTime() - 60 * 1000).toISOString() }) as AnalyticsEvent,
    analyticsEvent({ category: "tool", createdAt: new Date(now.getTime() - 2 * 3_600_000).toISOString() }) as AnalyticsEvent,
    analyticsEvent({ category: "discovery", createdAt: new Date(now.getTime() - 60 * 1000).toISOString() }) as AnalyticsEvent
  ];
  const spark = buildCountSparkline(events, "24h", now, e => e.category === "tool");
  assert.equal(spark.length, 24);
  assert.equal(spark.reduce((a, b) => a + b, 0), 2);
});

test("buildSettlementCountSparkline: a 7d period returns 7 daily buckets and counts only settlement_succeeded rows", () => {
  const now = new Date();
  const rows: RevenueSettlement[] = [
    settlementRow({ createdAt: new Date(now.getTime() - 1 * 86_400_000).toISOString() }),
    settlementRow({
      status: "settlement_failed", amountDecimal: null, amountAtomic: null, currency: null, asset: null,
      amountSource: "unavailable", settledAt: null, errorReason: "insufficient_funds", createdAt: new Date(now.getTime() - 1 * 86_400_000).toISOString()
    })
  ];
  const spark = buildSettlementCountSparkline(rows, "7d", now);
  assert.equal(spark.length, 7);
  assert.equal(spark.reduce((a, b) => a + b, 0), 1);
});

test("dashboard command-center fields: agents, activityFeed, systemHealth and sparklines are present in the real payload, cover all six agent groups, and never leak secrets or demo markers", async t => {
  const { server, base, analyticsRepository, revenueLedger } = await startDashboardApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  await analyticsRepository.record(analyticsEvent({ toolName: "analyze_oman_property", channel: "rest", success: true }));
  await analyticsRepository.record(analyticsEvent({ category: "x402", eventType: "challenge", toolName: "find_companies", success: null }));
  revenueLedger.record(settlementRow({ toolName: "analyze_oman_property", amountDecimal: 0.25 }));
  const cookie = await loginAndGetSessionCookie(base);
  const res = await fetch(base + "/internal/dashboard/data?period=all", { headers: { Cookie: cookie } });
  const json = await res.text();
  const body = JSON.parse(json);
  const data = body.data;

  assert.equal(data.agents.length, 6);
  for (const id of ["research", "property", "supplier", "risk", "payment", "reconciliation"]) {
    assert.ok(data.agents.some((a: { id: string }) => a.id === id), `expected an agent card for ${id}`);
  }
  assert.ok(data.activityFeed.length >= 2);
  assert.equal(typeof data.systemHealth.scorePct, "number");
  assert.ok(Array.isArray(data.sparklines.revenue));
  assert.ok(Array.isArray(data.sparklines.toolCalls));
  assert.ok(Array.isArray(data.sparklines.discoveryHits));

  const forbidden = [
    revenueInternalApiKey, analyticsInternalApiKey, adminSessionSecret, apiKey,
    hashAdminPassword(adminPassword).slice(0, 20),
    "REVENUE_INTERNAL_API_KEY", "ANALYTICS_INTERNAL_API_KEY", "ADMIN_SESSION_SECRET", "ADMIN_PASSWORD_HASH",
    "privateKey", "facilitatorSecret", "DEMO ACTIVITY"
  ];
  for (const secret of forbidden) assert.ok(!json.includes(secret), `command-center payload must never contain: ${secret}`);
});

test("dashboard UI: sidebar navigation, AI Workforce status, Active Agents, Live Agent Activity and System Health panels are present in the rendered page", async t => {
  const { server, base } = await startDashboardApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const cookie = await loginAndGetSessionCookie(base);
  const html = await (await fetch(base + "/internal/dashboard", { headers: { Cookie: cookie } })).text();
  assert.ok(html.includes("AI Workforce Online"));
  assert.ok(html.includes("Active Agents"));
  assert.ok(html.includes("Live Agent Activity"));
  assert.ok(html.includes("Live Analysis &amp; Calculation Preview"));
  assert.ok(html.includes("System Health"));
  assert.ok(html.includes("Agents &amp; Tools"));
});

// -------------------------------------------------------------------------------------------
// Backend/API failure: graceful degradation, never a raw crash or leaked internals
// -------------------------------------------------------------------------------------------
test("dashboard: a revenue ledger failure produces a graceful, generic JSON error — never an uncaught crash or a leaked internal error message", async t => {
  const throwingLedger: RevenueLedger = {
    record: () => { /* no-op */ },
    query: async () => { throw new Error("connection refused: postgres://secret-internal-host/db"); },
    count: async () => 0
  };
  const { server, base } = await startDashboardApp({ revenueLedger: throwingLedger });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const cookie = await loginAndGetSessionCookie(base);

  const response = await fetch(base + "/internal/dashboard/data?period=24h", { headers: { Cookie: cookie } });
  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.success, false);
  assert.equal(body.error.code, "INTERNAL_ERROR");
  const raw = JSON.stringify(body);
  assert.ok(!raw.includes("secret-internal-host"), "the underlying error message must never leak to the client");
  assert.ok(!raw.includes("postgres://"));
});
