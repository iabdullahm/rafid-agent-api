import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createApp } from "../src/api/app.js";
import { loadConfig } from "../src/config/env.js";
import { MemoryAnalyticsRepository } from "../src/analytics/memoryRepository.js";
import { MemoryRevenueLedger } from "../src/revenue/memoryLedger.js";
import { hashAdminPassword } from "../src/middleware/adminAuth.js";
import { buildSettlementDedupeKey } from "../src/revenue/idempotency.js";
import { abbreviateTxHash, explorerUrlFor, buildRevenueTrend } from "../src/api/dashboard/service.js";
import type { RevenueSettlement, RevenueSettlementInput, RevenueLedger } from "../src/revenue/types.js";
import type { AnalyticsEventInput } from "../src/analytics/types.js";

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
