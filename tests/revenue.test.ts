import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createApp } from "../src/api/app.js";
import { loadConfig } from "../src/config/env.js";
import { MemoryAnalyticsRepository } from "../src/analytics/memoryRepository.js";
import { MemoryRevenueLedger } from "../src/revenue/memoryLedger.js";
import { recordToolInvocation } from "../src/analytics/recorder.js";
import { buildSettlementDedupeKey } from "../src/revenue/idempotency.js";
import { decodeX402SettlementMetadata, buildSettlementRecord, recordSettlement } from "../src/revenue/settlementCapture.js";
import {
  SOURCE_OF_TRUTH_RULE, periodSince, summarizeRevenue, summarizeRevenueByTool, buildReconciliation
} from "../src/revenue/aggregate.js";
import type { RevenueSettlement, RevenueSettlementInput } from "../src/revenue/types.js";
import type { RequestClientContext } from "../src/analytics/context.js";
import { ManualSettlementChainVerifier, EvmRpcSettlementChainVerifier, getChainVerifierConfig, createSettlementChainVerifier, type JsonRpcCall } from "../src/revenue/chainVerifier.js";

const key = "test-only-not-a-real-credential-12345";
const client: RequestClientContext = { clientHash: null, userAgent: null, referer: null, clientName: null };

/** Mirrors tests/analytics.test.ts's startAnalyticsApp() helper: a real HTTP server over
 *  createApp(), with injected in-memory AnalyticsRepository/RevenueLedger so tests below read
 *  exactly the rows the running app recorded (or that this test seeded directly into the ledger,
 *  standing in for a real x402 settlement — this sandbox has no facilitator network egress, see
 *  tests/analytics.test.ts's x402 test comment). REVENUE_INTERNAL_API_KEY is read from
 *  process.env at createApp() time (src/revenue/config.ts), so this sets/clears it per call. */
async function startRevenueApp(opts: { internalApiKey?: string } = {}) {
  if (opts.internalApiKey !== undefined) process.env.REVENUE_INTERNAL_API_KEY = opts.internalApiKey;
  else delete process.env.REVENUE_INTERNAL_API_KEY;
  delete process.env.REVENUE_DATABASE_URL;
  delete process.env.ANALYTICS_INTERNAL_API_KEY;
  delete process.env.ANALYTICS_DATABASE_URL;
  const analyticsRepository = new MemoryAnalyticsRepository();
  const revenueLedger = new MemoryRevenueLedger();
  const config = loadConfig({ RAFID_API_KEYS: key, LOG_LEVEL: "silent", RATE_LIMIT_ENABLED: "false" });
  const app = createApp(config, { analyticsRepository, revenueLedger });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, base: `http://127.0.0.1:${address.port}`, analyticsRepository, revenueLedger };
}

/** A minimal, valid RevenueSettlementInput builder — every test below overrides only the fields
 *  it cares about, so each test reads as "what's different about this row" rather than repeating
 *  the full shape. Mirrors a settlement for analyze_oman_property ($0.25) on Base unless
 *  overridden. */
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
    transactionHash: `0xtx-${Math.random().toString(36).slice(2)}`,
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

// -------------------------------------------------------------------------------------------
// Source-of-truth: what counts as revenue
// -------------------------------------------------------------------------------------------
test("revenue source of truth: a successful settlement is counted exactly once", () => {
  const ledger = new MemoryRevenueLedger();
  ledger.record(settlementRow({ status: "settlement_succeeded" }));
  const summary = summarizeRevenue(ledger.all(), "24h");
  assert.equal(summary.settledPayments, 1);
  assert.equal(summary.grossRevenueUSD, 0.25);
  assert.equal(summary.currency, "USDC");
});

test("revenue source of truth: a failed settlement is never counted as revenue", () => {
  const ledger = new MemoryRevenueLedger();
  ledger.record(settlementRow({ status: "settlement_failed", amountAtomic: null, amountDecimal: null, amountSource: "unavailable", currency: null, asset: null, settledAt: null, errorReason: "insufficient_funds" }));
  const summary = summarizeRevenue(ledger.all(), "24h");
  assert.equal(summary.settledPayments, 0);
  assert.equal(summary.failedSettlements, 1);
  assert.equal(summary.grossRevenueUSD, null);
  assert.deepEqual(summary.revenueByCurrency, {});
});

test("revenue source of truth: a bare 402 challenge (no settlement header at all) is never written to the ledger", () => {
  // decodeX402SettlementMetadata is only ever called by api/app.ts when a settlement header was
  // present at all — a routine 402 challenge has none, so this returns null and
  // recordSettlement() / buildSettlementRecord() are never reached for that request. This is a
  // regression guard on that decode step: undefined/absent header input must decode to null.
  assert.equal(decodeX402SettlementMetadata(undefined), null);
  assert.equal(decodeX402SettlementMetadata(""), null);
  const ledger = new MemoryRevenueLedger();
  assert.equal(ledger.all().length, 0);
  assert.equal(summarizeRevenue(ledger.all(), "24h").settledPayments, 0);
});

test("revenue source of truth: payment_verified without settlement is never counted as settled or failed revenue", () => {
  // This codebase's synchronous x402 flow never actually emits a bare "payment_verified" row on
  // its own (see revenue/types.ts's RevenueSettlementStatus doc comment) — but the aggregation
  // logic must still be honest if one ever existed (a future async verify-then-settle flow), so
  // this constructs one directly against the ledger/aggregate layer rather than through the app.
  const ledger = new MemoryRevenueLedger();
  ledger.record(settlementRow({ status: "payment_verified", settledAt: null, transactionHash: null, dedupeKey: "req:verified-only:analyze_oman_property" }));
  const summary = summarizeRevenue(ledger.all(), "24h");
  assert.equal(summary.settledPayments, 0);
  assert.equal(summary.failedSettlements, 0); // not settlement_succeeded, not settlement_failed either
  assert.equal(summary.grossRevenueUSD, null);
});

// -------------------------------------------------------------------------------------------
// Idempotency / deduplication
// -------------------------------------------------------------------------------------------
test("idempotency: prefers network+transactionHash; falls back to requestId+toolName only when no hash exists", () => {
  assert.equal(
    buildSettlementDedupeKey({ network: "eip155:8453", transactionHash: "0xabc", requestId: "req-1", toolName: "analyze_property" }),
    "tx:eip155:8453:0xabc"
  );
  assert.equal(
    buildSettlementDedupeKey({ network: "eip155:8453", transactionHash: null, requestId: "req-1", toolName: "analyze_property" }),
    "req:req-1:analyze_property"
  );
});

test("idempotency: the same settlement (same network+transactionHash) observed twice is not double-counted", () => {
  const ledger = new MemoryRevenueLedger();
  const row = settlementRow({ transactionHash: "0xsame-hash", requestId: "req-a" });
  ledger.record(row);
  // A second observation of the exact same on-chain transaction (e.g. a client retry re-triggering
  // res.on("finish")) — different requestId, same transactionHash/network, so the SAME dedupeKey.
  ledger.record({ ...row, requestId: "req-b", dedupeKey: buildSettlementDedupeKey({ network: row.network, transactionHash: row.transactionHash, requestId: "req-b", toolName: row.toolName }) });
  assert.equal(ledger.all().length, 1);
  assert.equal(summarizeRevenue(ledger.all(), "24h").settledPayments, 1);
});

test("idempotency: recordSettlement() is fire-and-forget and never throws, even when the underlying ledger write fails", () => {
  const throwingLedger = { record: () => { throw new Error("db down"); }, query: async () => [], count: async () => 0 };
  assert.doesNotThrow(() => recordSettlement(throwingLedger, settlementRow()));
  const rejectingLedger = { record: async () => { throw new Error("db down (async)"); }, query: async () => [], count: async () => 0 };
  assert.doesNotThrow(() => recordSettlement(rejectingLedger, settlementRow()));
});

// -------------------------------------------------------------------------------------------
// Revenue by tool
// -------------------------------------------------------------------------------------------
test("revenue by tool: derived from the settlement ledger only, never from tool-call analytics", () => {
  const ledger = new MemoryRevenueLedger();
  ledger.record(settlementRow({ toolName: "analyze_oman_property", amountDecimal: 0.25 }));
  ledger.record(settlementRow({ toolName: "analyze_oman_property", amountDecimal: 0.25 }));
  ledger.record(settlementRow({ toolName: "analyze_oman_property", amountDecimal: 0.25 }));
  ledger.record(settlementRow({ toolName: "analyze_oman_property", amountDecimal: 0.25 }));
  ledger.record(settlementRow({ toolName: "analyze_property", amountDecimal: 0.01, amountAtomic: "10000" }));
  ledger.record(settlementRow({ toolName: "analyze_property", amountDecimal: 0.01, amountAtomic: "10000" }));
  // A failed settlement for a tool that otherwise never settled must not create a phantom revenue row.
  ledger.record(settlementRow({ toolName: "compare_properties", status: "settlement_failed", amountAtomic: null, amountDecimal: null, amountSource: "unavailable", currency: null, asset: null, settledAt: null }));

  const byTool = summarizeRevenueByTool(ledger.all());
  assert.equal(byTool.analyze_oman_property!.settledCalls, 4);
  assert.equal(byTool.analyze_oman_property!.revenue, 1.00);
  assert.equal(byTool.analyze_property!.settledCalls, 2);
  assert.equal(byTool.analyze_property!.revenue, 0.02);
  assert.equal(byTool.compare_properties!.settledCalls, 0);
  assert.equal(byTool.compare_properties!.failedSettlements, 1);
  assert.equal(byTool.compare_properties!.revenue, null);
});

// -------------------------------------------------------------------------------------------
// Period windows: 24h / 7d / 30d / all
// -------------------------------------------------------------------------------------------
test("revenue windows: 24h/7d/30d/all each include exactly the rows within their horizon", () => {
  const now = new Date("2026-09-22T12:00:00.000Z");
  const rows = [
    settlementRow({ createdAt: new Date(now.getTime() - 1 * 60 * 60 * 1000).toISOString() }), // 1h ago: in all 4
    settlementRow({ createdAt: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString() }), // 2d ago: 7d/30d/all only
    settlementRow({ createdAt: new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000).toISOString() }), // 20d ago: 30d/all only
    settlementRow({ createdAt: new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString() }) // 90d ago: all only
  ];

  const within = (period: "24h" | "7d" | "30d" | "all") => {
    const since = periodSince(period, now);
    return rows.filter(r => since === null || new Date(r.createdAt!).getTime() >= since.getTime());
  };
  assert.equal(summarizeRevenue(within("24h"), "24h").settledPayments, 1);
  assert.equal(summarizeRevenue(within("7d"), "7d").settledPayments, 2);
  assert.equal(summarizeRevenue(within("30d"), "30d").settledPayments, 3);
  assert.equal(summarizeRevenue(within("all"), "all").settledPayments, 4);
  assert.equal(periodSince("all", now), null);
});

// -------------------------------------------------------------------------------------------
// Multiple currencies/assets: never blended
// -------------------------------------------------------------------------------------------
test("revenue: multiple currencies are never incorrectly combined into one amount — separate totals per currency", () => {
  const ledger = new MemoryRevenueLedger();
  ledger.record(settlementRow({ toolName: "analyze_oman_property", currency: "USDC", amountDecimal: 0.25 }));
  ledger.record(settlementRow({ toolName: "analyze_oman_property", currency: "USDC", amountDecimal: 0.25 }));
  ledger.record(settlementRow({ toolName: "analyze_oman_property", currency: "EURC", amountDecimal: 0.20, asset: "EURC" }));

  const summary = summarizeRevenue(ledger.all(), "24h");
  assert.deepEqual(summary.revenueByCurrency, { USDC: 0.50, EURC: 0.20 });
  // Convenience single-currency fields must be null, never a silently-picked or summed value.
  assert.equal(summary.currency, null);
  assert.equal(summary.grossRevenueUSD, null);

  const byTool = summarizeRevenueByTool(ledger.all());
  assert.deepEqual(byTool.analyze_oman_property!.revenueByCurrency, { USDC: 0.50, EURC: 0.20 });
  assert.equal(byTool.analyze_oman_property!.revenue, null);
  assert.equal(byTool.analyze_oman_property!.currency, null);
});

// -------------------------------------------------------------------------------------------
// buildSettlementRecord: amount sourcing from real (mocked) x402 SDK settlement responses
// -------------------------------------------------------------------------------------------
test("buildSettlementRecord: uses the SDK-echoed amount when present, otherwise falls back to the verified requirement amount, never fabricating a field the SDK omits", () => {
  // Case 1: SDK echoes an amount (rare/future-proofing) — used as-is, amountSource records this.
  const withEcho = buildSettlementRecord({
    settlement: { success: true, transaction: "0xabc", network: "eip155:8453", payer: "0xPayer", amount: "500000", errorReason: null, errorMessage: null },
    requestId: "req-1", toolName: "analyze_oman_property", network: "eip155:8453", facilitator: "coinbase-cdp",
    payToAddress: "0xRafidWallet", requirementAmountDecimal: 0.25, currency: "USDC"
  });
  assert.equal(withEcho.amountSource, "settlement_response");
  assert.equal(withEcho.amountAtomic, "500000");
  assert.equal(withEcho.amountDecimal, 0.5);
  assert.equal(withEcho.payerAddress, "0xPayer");

  // Case 2: this deployment's real (EIP-3009) case — no amount echoed by the SDK. Falls back to
  // the cryptographically-verified 402 requirement amount for this specific request, not a live
  // capability.price lookup.
  const withoutEcho = buildSettlementRecord({
    settlement: { success: true, transaction: "0xdef", network: "eip155:8453", payer: null, amount: null, errorReason: null, errorMessage: null },
    requestId: "req-2", toolName: "analyze_oman_property", network: "eip155:8453", facilitator: "coinbase-cdp",
    payToAddress: "0xRafidWallet", requirementAmountDecimal: 0.25, currency: "USDC"
  });
  assert.equal(withoutEcho.amountSource, "verified_requirement");
  assert.equal(withoutEcho.amountDecimal, 0.25);
  assert.equal(withoutEcho.amountAtomic, "250000");
  assert.equal(withoutEcho.payerAddress, null); // never fabricated when the SDK doesn't provide it

  // Case 3: a failed settlement — nothing actually transferred, so no honest "actual settled
  // amount" exists; must not report the merely-requested amount as if it settled.
  const failed = buildSettlementRecord({
    settlement: { success: false, transaction: "0xghi", network: "eip155:8453", payer: null, amount: null, errorReason: "insufficient_funds", errorMessage: "..." },
    requestId: "req-3", toolName: "analyze_oman_property", network: "eip155:8453", facilitator: "coinbase-cdp",
    payToAddress: "0xRafidWallet", requirementAmountDecimal: 0.25, currency: "USDC"
  });
  assert.equal(failed.status, "settlement_failed");
  assert.equal(failed.amountSource, "unavailable");
  assert.equal(failed.amountDecimal, null);
  assert.equal(failed.amountAtomic, null);
  assert.equal(failed.currency, null);
  assert.equal(failed.asset, null);
  assert.equal(failed.errorReason, "insufficient_funds");
  assert.equal(failed.settledAt, null);
});

test("decodeX402SettlementMetadata: malformed/garbage/non-base64 input never throws and decodes to null", () => {
  assert.equal(decodeX402SettlementMetadata(undefined), null);
  assert.equal(decodeX402SettlementMetadata("not-base64-at-all!!"), null);
  assert.equal(decodeX402SettlementMetadata(Buffer.from("not json").toString("base64")), null);
  assert.equal(decodeX402SettlementMetadata(Buffer.from(JSON.stringify({ noSuccessField: true })).toString("base64")), null);
  const valid = Buffer.from(JSON.stringify({ success: true, transaction: "0xabc", network: "eip155:8453" })).toString("base64");
  assert.deepEqual(decodeX402SettlementMetadata(valid), { success: true, transaction: "0xabc", network: "eip155:8453", payer: null, amount: null, errorReason: null, errorMessage: null });
});

// -------------------------------------------------------------------------------------------
// Reconciliation
// -------------------------------------------------------------------------------------------
test("reconciliation: flags a tool executed via x402 with no matching settlement", () => {
  const ledger = new MemoryRevenueLedger();
  ledger.record(settlementRow({ toolName: "analyze_oman_property" })); // 1 settled row
  const anomalies = buildReconciliation({
    settlements: ledger.all(),
    x402ToolExecutionCounts: { analyze_oman_property: 3 }, // but 3 successful x402 executions
    catalogPriceByTool: { analyze_oman_property: 0.25 }
  });
  const found = anomalies.find(a => a.kind === "tool_executed_without_settlement" && a.toolName === "analyze_oman_property");
  assert.ok(found, "expected a tool_executed_without_settlement anomaly");
});

test("reconciliation: flags a settlement with no matching x402 tool execution", () => {
  const ledger = new MemoryRevenueLedger();
  ledger.record(settlementRow({ toolName: "analyze_oman_property" }));
  ledger.record(settlementRow({ toolName: "analyze_oman_property" }));
  const anomalies = buildReconciliation({
    settlements: ledger.all(),
    x402ToolExecutionCounts: { analyze_oman_property: 0 }, // no recorded x402 execution at all
    catalogPriceByTool: { analyze_oman_property: 0.25 }
  });
  const found = anomalies.find(a => a.kind === "settlement_without_tool_execution" && a.toolName === "analyze_oman_property");
  assert.ok(found, "expected a settlement_without_tool_execution anomaly");
});

test("reconciliation: flags a settled amount that diverges from the current catalog price (reconciliation-only, never rewrites the ledger)", () => {
  const ledger = new MemoryRevenueLedger();
  ledger.record(settlementRow({ toolName: "analyze_oman_property", amountDecimal: 0.25 }));
  const before = JSON.stringify(ledger.all());
  const anomalies = buildReconciliation({
    settlements: ledger.all(),
    x402ToolExecutionCounts: { analyze_oman_property: 1 },
    catalogPriceByTool: { analyze_oman_property: 0.30 } // price changed since this row settled
  });
  assert.ok(anomalies.some(a => a.kind === "amount_mismatch" && a.toolName === "analyze_oman_property"));
  // The reconciliation call must never mutate the ledger rows it read.
  assert.equal(JSON.stringify(ledger.all()), before);
});

test("reconciliation: a settlement_succeeded row with no transaction hash is flagged (should be structurally impossible)", () => {
  const ledger = new MemoryRevenueLedger();
  ledger.record(settlementRow({ transactionHash: null, dedupeKey: "req:no-hash-req:analyze_oman_property" }));
  const anomalies = buildReconciliation({ settlements: ledger.all(), x402ToolExecutionCounts: {}, catalogPriceByTool: {} });
  assert.ok(anomalies.some(a => a.kind === "missing_transaction_hash"));
});

test("reconciliation: duplicate transaction hashes across rows are flagged as a data-integrity signal", () => {
  // Bypasses the ledger's own dedup (different dedupeKeys) to exercise buildReconciliation's own
  // defense-in-depth check directly — this should be structurally impossible via the ledger.
  const rows = [
    settlementRow({ transactionHash: "0xdup", requestId: "req-x", dedupeKey: "tx:eip155:8453:0xdup" }),
    settlementRow({ transactionHash: "0xdup", requestId: "req-y", dedupeKey: "tx:eip155:8453:0xdup:duplicate-for-test" })
  ];
  const anomalies = buildReconciliation({ settlements: rows, x402ToolExecutionCounts: {}, catalogPriceByTool: {} });
  assert.ok(anomalies.some(a => a.kind === "duplicate_transaction_hash"));
});

test("SOURCE_OF_TRUTH_RULE is documented and mentions settlement_succeeded", () => {
  assert.ok(SOURCE_OF_TRUTH_RULE.includes("settlement_succeeded"));
});

// -------------------------------------------------------------------------------------------
// HTTP layer: internal auth, pagination, secret redaction
// -------------------------------------------------------------------------------------------
test("revenue internal auth: every route 503s when unconfigured, 401s on a missing/wrong key, 200s with the correct key, and is never reachable from a public discovery surface", async t => {
  {
    const { server, base } = await startRevenueApp({ internalApiKey: undefined });
    t.after(() => { server.closeAllConnections(); server.close(); });
    for (const path of ["summary", "tools", "transactions", "reconciliation"]) {
      const response = await fetch(base + `/api/v1/internal/revenue/${path}`, { headers: { "X-Internal-Api-Key": "anything" } });
      assert.equal(response.status, 503);
    }
  }
  {
    const internalApiKey = "test-revenue-internal-key-0123456789";
    const { server, base } = await startRevenueApp({ internalApiKey });
    t.after(() => { server.closeAllConnections(); server.close(); });
    for (const path of ["summary", "tools", "transactions", "reconciliation"]) {
      assert.equal((await fetch(base + `/api/v1/internal/revenue/${path}`)).status, 401);
      assert.equal((await fetch(base + `/api/v1/internal/revenue/${path}`, { headers: { "X-Internal-Api-Key": "wrong-key" } })).status, 401);
      assert.equal((await fetch(base + `/api/v1/internal/revenue/${path}`, { headers: { "X-Internal-Api-Key": internalApiKey } })).status, 200);
    }
    // Structurally unreachable from every public discovery surface — never registered in
    // src/domain/capabilities.ts (same discipline as analyticsRoutes.ts).
    const agentManifest = await (await fetch(base + "/agent.json")).json();
    assert.ok(!JSON.stringify(agentManifest).toLowerCase().includes("revenue"));
    const toolCatalog = await (await fetch(base + "/api/v1/tools")).json();
    assert.ok(!JSON.stringify(toolCatalog).toLowerCase().includes("revenue"));
    const capabilitiesRegistry = await (await fetch(base + "/api/v1/capabilities")).json();
    assert.ok(!JSON.stringify(capabilitiesRegistry).toLowerCase().includes("revenue"));
    const openapi = await (await fetch(base + "/openapi.json")).json() as { paths: Record<string, unknown> };
    assert.ok(!Object.keys(openapi.paths).some(p => p.includes("/internal/revenue")));
    const llmsTxt = await (await fetch(base + "/llms.txt")).text();
    assert.ok(!llmsTxt.toLowerCase().includes("internal/revenue"));
  }
});

test("revenue transactions: paginates and returns only safe fields — never a payment proof, signature, atomic amount, payer address or dedupe key", async t => {
  const internalApiKey = "test-revenue-internal-key-0123456789";
  const { server, base, revenueLedger } = await startRevenueApp({ internalApiKey });
  t.after(() => { server.closeAllConnections(); server.close(); });

  for (let i = 0; i < 5; i++) {
    revenueLedger.record(settlementRow({ requestId: `req-page-${i}`, payerAddress: "0xSecretPayerAddress" }));
  }

  const page1 = await (await fetch(base + "/api/v1/internal/revenue/transactions?limit=2&offset=0&period=all", { headers: { "X-Internal-Api-Key": internalApiKey } })).json();
  assert.equal(page1.data.transactions.length, 2);
  assert.equal(page1.data.pagination.total, 5);
  assert.equal(page1.data.pagination.limit, 2);
  assert.equal(page1.data.pagination.offset, 0);

  const page2 = await (await fetch(base + "/api/v1/internal/revenue/transactions?limit=2&offset=2&period=all", { headers: { "X-Internal-Api-Key": internalApiKey } })).json();
  assert.equal(page2.data.transactions.length, 2);
  const page1Ids = new Set(page1.data.transactions.map((t: { requestId: string }) => t.requestId));
  const page2Ids = new Set(page2.data.transactions.map((t: { requestId: string }) => t.requestId));
  for (const id of page2Ids) assert.ok(!page1Ids.has(id), "pages must not overlap");

  const tx = page1.data.transactions[0];
  assert.deepEqual(Object.keys(tx).sort(), ["amount", "currency", "network", "requestId", "status", "timestamp", "tool", "transactionHash"].sort());

  const serialized = JSON.stringify(page1) + JSON.stringify(page2);
  for (const forbidden of ["0xSecretPayerAddress", "payerAddress", "dedupeKey", "amountAtomic", "errorReason", internalApiKey]) {
    assert.ok(!serialized.includes(forbidden), `revenue transactions response must never contain: ${forbidden}`);
  }
});

test("revenue: no raw X-PAYMENT header, payment proof, signature, or internal API key ever reaches a stored settlement row or a summary/tools response", async t => {
  const internalApiKey = "test-revenue-internal-key-0123456789";
  const { server, base, revenueLedger } = await startRevenueApp({ internalApiKey });
  t.after(() => { server.closeAllConnections(); server.close(); });

  revenueLedger.record(settlementRow({ toolName: "analyze_oman_property" }));
  const serializedLedger = JSON.stringify(revenueLedger.all());
  for (const forbidden of ["X-PAYMENT", "privateKey", "signature", "facilitatorSecret", "proof"]) {
    assert.ok(!serializedLedger.toLowerCase().includes(forbidden.toLowerCase()), `ledger rows must never contain: ${forbidden}`);
  }

  const summaryText = await (await fetch(base + "/api/v1/internal/revenue/summary?period=all", { headers: { "X-Internal-Api-Key": internalApiKey } })).text();
  const toolsText = await (await fetch(base + "/api/v1/internal/revenue/tools?period=all", { headers: { "X-Internal-Api-Key": internalApiKey } })).text();
  for (const forbidden of [internalApiKey, key]) {
    assert.ok(!summaryText.includes(forbidden));
    assert.ok(!toolsText.includes(forbidden));
  }
});

test("revenue tools endpoint: matches summarizeRevenueByTool computed directly from the same ledger rows", async t => {
  const internalApiKey = "test-revenue-internal-key-0123456789";
  const { server, base, revenueLedger } = await startRevenueApp({ internalApiKey });
  t.after(() => { server.closeAllConnections(); server.close(); });

  revenueLedger.record(settlementRow({ toolName: "analyze_oman_property", amountDecimal: 0.25 }));
  revenueLedger.record(settlementRow({ toolName: "analyze_oman_property", amountDecimal: 0.25 }));
  revenueLedger.record(settlementRow({ toolName: "analyze_property", amountDecimal: 0.01, amountAtomic: "10000" }));

  const body = await (await fetch(base + "/api/v1/internal/revenue/tools?period=all", { headers: { "X-Internal-Api-Key": internalApiKey } })).json();
  assert.equal(body.data.tools.analyze_oman_property.settledCalls, 2);
  assert.equal(body.data.tools.analyze_oman_property.revenue, 0.50);
  assert.equal(body.data.tools.analyze_property.settledCalls, 1);
  assert.equal(body.data.tools.analyze_property.revenue, 0.01);
});

test("revenue reconciliation endpoint: builds x402ToolExecutionCounts only from successful, x402-channel tool invocations — never from REST or MCP calls to the same capability", async t => {
  const internalApiKey = "test-revenue-internal-key-0123456789";
  const { server, base, revenueLedger, analyticsRepository } = await startRevenueApp({ internalApiKey });
  t.after(() => { server.closeAllConnections(); server.close(); });

  // Two settled x402 rows for analyze_oman_property.
  revenueLedger.record(settlementRow({ toolName: "analyze_oman_property" }));
  revenueLedger.record(settlementRow({ toolName: "analyze_oman_property" }));
  // Two real x402 tool invocations recorded in analytics — matches the settlement count, so no
  // tool_executed_without_settlement / settlement_without_tool_execution anomaly should fire.
  recordToolInvocation(analyticsRepository, { toolName: "analyze_oman_property", channel: "x402", success: true, durationMs: 10, dataSource: "partner_feed", client });
  recordToolInvocation(analyticsRepository, { toolName: "analyze_oman_property", channel: "x402", success: true, durationMs: 12, dataSource: "partner_feed", client });
  // A REST call to the same capability must NOT be counted toward x402ToolExecutionCounts (that
  // would create a false tool_executed_without_settlement anomaly if it were).
  recordToolInvocation(analyticsRepository, { toolName: "analyze_oman_property", channel: "rest", success: true, durationMs: 8, dataSource: "partner_feed", client });

  const body = await (await fetch(base + "/api/v1/internal/revenue/reconciliation?period=all", { headers: { "X-Internal-Api-Key": internalApiKey } })).json();
  const relevant = body.data.anomalies.filter((a: { toolName: string | null }) => a.toolName === "analyze_oman_property");
  assert.equal(relevant.length, 0, `expected no reconciliation anomaly for analyze_oman_property, got: ${JSON.stringify(relevant)}`);
});

// -------------------------------------------------------------------------------------------
// Optional on-chain verification (spec section 10) — never a dependency of the ledger itself,
// tested entirely with an injected mock JSON-RPC caller (no real network egress).
// -------------------------------------------------------------------------------------------
test("SettlementChainVerifier: falls back to the honest 'not_configured' manual verifier when no CHAIN_RPC_URL is set", async () => {
  const verifier = createSettlementChainVerifier({ rpcUrl: null, usdcContractByNetwork: {} });
  assert.ok(verifier instanceof ManualSettlementChainVerifier);
  const result = await verifier.verify(settlementRow());
  assert.equal(result.status, "not_configured");
  assert.equal(result.checks.transactionExists, null);

  // getChainVerifierConfig() itself must never throw when unset, and must never hardcode a key.
  const config = getChainVerifierConfig({});
  assert.equal(config.rpcUrl, null);
});

/** Pads an address to the 32-byte, 0x-prefixed topic form an Ethereum log uses — computed at
 *  runtime (rather than hand-typed hex) so the fixture below can't drift out of sync with
 *  chainVerifier.ts's own padAddressTopic(). */
function topicFor(address: string): string {
  return "0x" + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

test("SettlementChainVerifier (EVM/RPC): confirms a matching transaction — exists, correct network, correct USDC amount and recipient", async () => {
  const usdcContract = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const rafidWallet = "0x00000000000000000000000000000000000000ab";
  const txHash = "0xtx-match";
  const rpcCall: JsonRpcCall = async (method) => {
    if (method === "eth_chainId") return "0x2105"; // 8453 (Base) in hex
    if (method === "eth_getTransactionReceipt") {
      return {
        status: "0x1",
        logs: [{
          address: usdcContract,
          topics: [
            "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
            topicFor("0x00000000000000000000000000000000000000ff"), // from (irrelevant)
            topicFor(rafidWallet) // to = rafidWallet
          ],
          data: "0x" + (250000).toString(16).padStart(64, "0")
        }]
      };
    }
    throw new Error(`unexpected RPC method ${method}`);
  };
  const verifier = new EvmRpcSettlementChainVerifier(rpcCall, { "eip155:8453": usdcContract });
  const result = await verifier.verify(settlementRow({ network: "eip155:8453", payToAddress: rafidWallet, transactionHash: txHash, amountAtomic: "250000" }));
  assert.equal(result.status, "verified");
  assert.equal(result.checks.transactionExists, true);
  assert.equal(result.checks.networkMatches, true);
  assert.equal(result.checks.amountMatches, true);
  assert.equal(result.checks.recipientMatches, true);
});

test("SettlementChainVerifier (EVM/RPC): flags a mismatch — wrong recipient, wrong amount, or a transaction the RPC endpoint has never seen", async () => {
  const usdcContract = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const rafidWallet = "0x000000000000000000000000000000000000ab";

  // Wrong recipient / wrong amount.
  const mismatchRpc: JsonRpcCall = async (method) => {
    if (method === "eth_chainId") return "0x2105";
    if (method === "eth_getTransactionReceipt") {
      return {
        status: "0x1",
        logs: [{
          address: usdcContract,
          topics: [
            "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
            "0x000000000000000000000000000000000000000000000000000000000000ff",
            "0x000000000000000000000000000000000000000000000000000000000000cd" // wrong recipient
          ],
          data: "0x" + (999).toString(16).padStart(64, "0") // wrong amount
        }]
      };
    }
    throw new Error(`unexpected RPC method ${method}`);
  };
  const verifier = new EvmRpcSettlementChainVerifier(mismatchRpc, { "eip155:8453": usdcContract });
  const mismatch = await verifier.verify(settlementRow({ network: "eip155:8453", payToAddress: rafidWallet, transactionHash: "0xtx-mismatch", amountAtomic: "250000" }));
  assert.equal(mismatch.status, "mismatch");
  assert.equal(mismatch.checks.recipientMatches, false);
  assert.equal(mismatch.checks.amountMatches, false);

  // Transaction never seen by this RPC endpoint at all.
  const notFoundRpc: JsonRpcCall = async (method) => {
    if (method === "eth_chainId") return "0x2105";
    if (method === "eth_getTransactionReceipt") return null;
    throw new Error(`unexpected RPC method ${method}`);
  };
  const notFoundVerifier = new EvmRpcSettlementChainVerifier(notFoundRpc, { "eip155:8453": usdcContract });
  const notFound = await notFoundVerifier.verify(settlementRow({ network: "eip155:8453", payToAddress: rafidWallet, transactionHash: "0xtx-unseen" }));
  assert.equal(notFound.status, "not_found");
  assert.equal(notFound.checks.transactionExists, false);
});

test("SettlementChainVerifier: never throws on an RPC failure — reports status 'error' instead", async () => {
  const failingRpc: JsonRpcCall = async () => { throw new Error("connection refused"); };
  const verifier = new EvmRpcSettlementChainVerifier(failingRpc, { "eip155:8453": "0xUsdc" });
  const result = await verifier.verify(settlementRow({ network: "eip155:8453", transactionHash: "0xtx-err" }));
  assert.equal(result.status, "error");
});
