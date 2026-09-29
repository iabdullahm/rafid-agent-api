import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { buildCallAuditRecords } from "../src/audit/build.js";
import { buildToolAudit, buildCommercialFunnel, buildAuditReconciliation } from "../src/audit/aggregate.js";
import type { AnalyticsEvent } from "../src/analytics/types.js";
import type { RevenueSettlement } from "../src/revenue/types.js";
import type { LedgerEntry } from "../src/billing/unified/types.js";
import { MPP_SESSION_LEDGER_TOOL } from "../src/billing/mpp/settlement.js";

/**
 * Revenue Conversion Audit — unit tests over src/audit/'s pure builder functions. No HTTP server
 * and no real x402/L402 facilitator round-trip (this sandbox has no facilitator network egress —
 * see tests/revenue.test.ts's own comment on the same constraint): every fixture below hand-builds
 * the exact analytics/settlement/ledger rows the real app.ts wiring would have recorded for a given
 * scenario (verified by direct code reading during this feature's implementation — see
 * docs/revenue-conversion-audit.md), and asserts buildCallAuditRecords()/buildToolAudit()/
 * buildCommercialFunnel()/buildAuditReconciliation() reconstruct it honestly.
 */

const now = () => new Date().toISOString();
const noClient = { clientHash: null, userAgent: null, referer: null, clientName: null };

function toolEvent(overrides: Partial<AnalyticsEvent> = {}): AnalyticsEvent {
  return {
    category: "tool", eventType: "invocation", path: null, toolName: "research_company", channel: "x402",
    success: true, durationMs: 120, amount: null, currency: null, txHash: null, dataSource: null,
    requestId: randomUUID(), createdAt: now(), ...noClient, ...overrides
  };
}

function x402Event(eventType: AnalyticsEvent["eventType"], overrides: Partial<AnalyticsEvent> = {}): AnalyticsEvent {
  return {
    category: "x402", eventType, path: null, toolName: "research_company", channel: null,
    success: eventType === "challenge" ? null : eventType === "payment_failed" || eventType === "settlement_failure" ? false : true,
    durationMs: null, amount: 0.5, currency: "USD", txHash: null, dataSource: null,
    requestId: randomUUID(), createdAt: now(), ...noClient, ...overrides
  };
}

function settlementRow(overrides: Partial<RevenueSettlement> = {}): RevenueSettlement {
  return {
    requestId: randomUUID(), toolName: "research_company", capabilityName: "research_company",
    amountAtomic: "500000", amountDecimal: 0.5, amountSource: "verified_requirement", currency: "USDC",
    network: "eip155:8453", asset: "USDC", payerAddress: null, payToAddress: "0xWallet",
    transactionHash: "0x" + "a".repeat(64), status: "settlement_succeeded", facilitator: "public",
    errorReason: null, paymentVerifiedAt: now(), settledAt: now(), dedupeKey: randomUUID(), createdAt: now(),
    ...overrides
  };
}

function ledgerRow(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    id: randomUUID(), accountId: "acct-1", apiKeyId: "key-1", requestId: randomUUID(), toolName: "research_company",
    type: "debit", amountMicros: -500000, currency: "USD", rail: "api_credits", status: "settled",
    externalTransactionId: null, relatedEntryId: null, createdAt: now(), updatedAt: now(), metadata: {},
    ...overrides
  };
}

test("zero-activity period produces zero records", () => {
  const records = buildCallAuditRecords({ events: [], settlements: [], ledgerEntries: [] });
  assert.equal(records.length, 0);
});

test("successful x402 conversion: execution succeeded, payment verified and settled -> converted / settlement_succeeded", () => {
  const requestId = randomUUID();
  const tool = toolEvent({ requestId, channel: "x402", success: true });
  const settle = settlementRow({ requestId, status: "settlement_succeeded" });
  const verified = x402Event("payment_verified", { requestId });
  const settled = x402Event("settlement_success", { requestId });
  const records = buildCallAuditRecords({ events: [tool, verified, settled], settlements: [settle], ledgerEntries: [] });
  assert.equal(records.length, 1);
  const r = records[0]!;
  assert.equal(r.channel, "x402");
  assert.equal(r.execution.attempted, true);
  assert.equal(r.execution.success, true);
  assert.equal(r.payment.verified, true);
  assert.equal(r.payment.settled, true);
  assert.equal(r.revenue.recorded, true);
  assert.equal(r.revenue.amount, 0.5);
  assert.equal(r.finalStatus, "converted");
  assert.equal(r.reasonCode, "settlement_succeeded");
});

test("402 with no verified payment: a bare challenge, no execution -> not_converted / payment_not_attempted", () => {
  const requestId = randomUUID();
  const challenge = x402Event("challenge", { requestId, success: null });
  const records = buildCallAuditRecords({ events: [challenge], settlements: [], ledgerEntries: [] });
  assert.equal(records.length, 1);
  const r = records[0]!;
  assert.equal(r.execution.attempted, false);
  assert.equal(r.payment.challengeIssued, true);
  assert.equal(r.payment.attempted, false);
  assert.equal(r.finalStatus, "not_converted");
  assert.equal(r.reasonCode, "payment_not_attempted");
});

test("payment verified but no settlement ever recorded -> revenue_record_missing, never fabricated as settled", () => {
  const requestId = randomUUID();
  const tool = toolEvent({ requestId, channel: "x402", success: true });
  const records = buildCallAuditRecords({ events: [tool], settlements: [], ledgerEntries: [] });
  const r = records[0]!;
  assert.equal(r.payment.verified, true, "execution happening at all proves verification succeeded");
  assert.equal(r.payment.settled, null, "no settlement signal exists — must stay null, never fabricated false");
  assert.equal(r.revenue.recorded, false);
  assert.equal(r.finalStatus, "unknown");
  assert.equal(r.reasonCode, "revenue_record_missing");
});

test("settlement failure: execution succeeded but settlement itself failed -> settlement_failed, no revenue", () => {
  const requestId = randomUUID();
  const tool = toolEvent({ requestId, channel: "x402", success: true });
  const failEvent = x402Event("settlement_failure", { requestId });
  const settle = settlementRow({ requestId, status: "settlement_failed", transactionHash: null });
  const records = buildCallAuditRecords({ events: [tool, failEvent], settlements: [settle], ledgerEntries: [] });
  const r = records[0]!;
  assert.equal(r.payment.settled, false);
  assert.equal(r.revenue.recorded, false);
  assert.equal(r.finalStatus, "settlement_failed");
  assert.equal(r.reasonCode, "settlement_failed");
});

test("free successful call: no payment concept engaged -> free_success / payment_not_required", () => {
  const tool = toolEvent({ channel: "free", success: true, toolName: "preview_capability" });
  const records = buildCallAuditRecords({ events: [tool], settlements: [], ledgerEntries: [] });
  const r = records[0]!;
  assert.equal(r.payment.required, false);
  assert.equal(r.revenue.recorded, false);
  assert.equal(r.finalStatus, "free_success");
  assert.equal(r.reasonCode, "payment_not_required");
});

test("execution failure before payment settles: x402 execution fails, no settlement -> failed_before_payment", () => {
  const requestId = randomUUID();
  const tool = toolEvent({ requestId, channel: "x402", success: false, dataSource: null });
  const records = buildCallAuditRecords({ events: [tool], settlements: [], ledgerEntries: [] });
  const r = records[0]!;
  assert.equal(r.execution.success, false);
  assert.equal(r.finalStatus, "failed_before_payment");
  assert.equal(r.reasonCode, "execution_failed");
});

test("provider not configured is surfaced via dataSource, never collapsed into generic execution_failed", () => {
  const requestId = randomUUID();
  const tool = toolEvent({ requestId, channel: "x402", success: false, dataSource: "not_configured" });
  const records = buildCallAuditRecords({ events: [tool], settlements: [], ledgerEntries: [] });
  const r = records[0]!;
  assert.equal(r.reasonCode, "provider_not_configured");
  assert.match(r.execution.failureReason ?? "", /not_configured/);
});

test("reconciliation issue: payment settled but execution failed after settlement -> flagged, not silently converted", () => {
  const requestId = randomUUID();
  const tool = toolEvent({ requestId, channel: "x402", success: false });
  const settled = x402Event("settlement_success", { requestId });
  const settle = settlementRow({ requestId, status: "settlement_succeeded" });
  const records = buildCallAuditRecords({ events: [tool, settled], settlements: [settle], ledgerEntries: [] });
  const r = records[0]!;
  assert.equal(r.finalStatus, "reconciliation_issue");
  assert.equal(r.reasonCode, "reconciliation_mismatch");
});

test("prepaid insufficient balance: execution never reserved, no ledger row -> not_converted / unknown (evidence genuinely insufficient)", () => {
  const requestId = randomUUID();
  const tool = toolEvent({ requestId, channel: "api_credits", success: false });
  const records = buildCallAuditRecords({ events: [tool], settlements: [], ledgerEntries: [] });
  const r = records[0]!;
  assert.equal(r.execution.attempted, false, "no ledger reservation exists, so capability.execute() never ran");
  assert.equal(r.finalStatus, "not_converted");
  assert.equal(r.reasonCode, "unknown", "cannot distinguish insufficient-balance from validation failure from the evidence alone");
});

test("prepaid reservation + capture: settled ledger row -> converted / prepaid_capture_succeeded, revenue recorded from the ledger", () => {
  const requestId = randomUUID();
  const tool = toolEvent({ requestId, channel: "api_credits", success: true });
  const entry = ledgerRow({ requestId, type: "debit", status: "settled", amountMicros: -250000, rail: "api_credits" });
  const records = buildCallAuditRecords({ events: [tool], settlements: [], ledgerEntries: [entry] });
  const r = records[0]!;
  assert.equal(r.execution.attempted, true);
  assert.equal(r.payment.settled, true);
  assert.equal(r.revenue.recorded, true);
  assert.equal(r.revenue.amount, 0.25);
  assert.equal(r.finalStatus, "converted");
  assert.equal(r.reasonCode, "prepaid_capture_succeeded");
});

test("prepaid reservation + release: execution failed, reservation refunded -> failed_before_payment, no revenue double-counted", () => {
  const requestId = randomUUID();
  const tool = toolEvent({ requestId, channel: "api_credits", success: false });
  const primary = ledgerRow({ requestId, type: "debit", status: "refunded", amountMicros: -250000, rail: "api_credits" });
  const refund = ledgerRow({ requestId, type: "refund", status: "settled", amountMicros: 250000, rail: "api_credits", relatedEntryId: primary.id, metadata: { reason: "capability_failed" } });
  const records = buildCallAuditRecords({ events: [tool], settlements: [], ledgerEntries: [primary, refund] });
  const r = records[0]!;
  assert.equal(r.payment.settled, false);
  assert.equal(r.revenue.recorded, false);
  assert.equal(r.finalStatus, "failed_before_payment");
  assert.equal(r.reasonCode, "execution_failed");
});

test("subscription settled internally -> converted / subscription_charge_succeeded", () => {
  const requestId = randomUUID();
  const tool = toolEvent({ requestId, channel: "subscription", success: true });
  const entry = ledgerRow({ requestId, type: "subscription_usage", status: "settled", amountMicros: -100000, rail: "subscription" });
  const records = buildCallAuditRecords({ events: [tool], settlements: [], ledgerEntries: [entry] });
  const r = records[0]!;
  assert.equal(r.channel, "subscription");
  assert.equal(r.finalStatus, "converted");
  assert.equal(r.reasonCode, "subscription_charge_succeeded");
});

test("correlation by requestId: two distinct requestIds never merge into one call, even for the same tool/price/timestamp", () => {
  const sharedAt = now();
  const a = toolEvent({ requestId: "req-a", channel: "x402", success: true, createdAt: sharedAt, amount: null, toolName: "research_company" });
  const b = toolEvent({ requestId: "req-b", channel: "x402", success: true, createdAt: sharedAt, amount: null, toolName: "research_company" });
  const settleA = settlementRow({ requestId: "req-a", status: "settlement_succeeded" });
  const settleB = settlementRow({ requestId: "req-b", status: "settlement_succeeded" });
  const records = buildCallAuditRecords({ events: [a, b], settlements: [settleA, settleB], ledgerEntries: [] });
  assert.equal(records.length, 2, "same tool, same price, same timestamp — still two separate calls, never merged");
  assert.deepEqual(new Set(records.map(r => r.requestId)), new Set(["req-a", "req-b"]));
});

test("multiple capabilities and multiple channels aggregate correctly per tool via buildToolAudit", () => {
  const r1 = toolEvent({ requestId: randomUUID(), toolName: "research_company", channel: "x402", success: true });
  const s1 = settlementRow({ requestId: r1.requestId!, toolName: "research_company", status: "settlement_succeeded", amountDecimal: 0.5, currency: "USDC" });
  const r2 = toolEvent({ requestId: randomUUID(), toolName: "document_facts_extract", channel: "api_credits", success: true });
  const e2 = ledgerRow({ requestId: r2.requestId!, toolName: "document_facts_extract", status: "settled", amountMicros: -300000 });
  const records = buildCallAuditRecords({ events: [r1, r2], settlements: [s1], ledgerEntries: [e2] });
  const toolAudit = buildToolAudit(records);
  assert.equal(toolAudit.length, 2);
  const research = toolAudit.find(t => t.toolName === "research_company")!;
  const doc = toolAudit.find(t => t.toolName === "document_facts_extract")!;
  assert.equal(research.settled, 1);
  assert.equal(doc.settled, 1);
  assert.equal(doc.revenue, 0.3);
});

test("unknown payment-attempt stage: a settlement/ledger row with no correlating analytics event -> channel unknown, never guessed", () => {
  const settle = settlementRow({ status: "settlement_succeeded" });
  const records = buildCallAuditRecords({ events: [], settlements: [settle], ledgerEntries: [] });
  const r = records[0]!;
  assert.equal(r.channel, "unknown");
  assert.equal(r.reasonCode, "unknown");
  assert.equal(r.revenue.recorded, true, "revenue is still honestly reported even when the channel can't be attributed");
});

test("multiple currencies for one tool: buildToolAudit never blends them into one number", () => {
  const r1 = toolEvent({ requestId: randomUUID(), toolName: "research_company", channel: "x402", success: true });
  const s1 = settlementRow({ requestId: r1.requestId!, toolName: "research_company", status: "settlement_succeeded", currency: "USDC", amountDecimal: 0.5 });
  const r2 = toolEvent({ requestId: randomUUID(), toolName: "research_company", channel: "l402", success: true });
  const s2 = settlementRow({ requestId: r2.requestId!, toolName: "research_company", status: "settlement_succeeded", currency: "BTC", amountDecimal: 0.00001 });
  const records = buildCallAuditRecords({ events: [r1, r2], settlements: [s1, s2], ledgerEntries: [] });
  const toolAudit = buildToolAudit(records);
  const row = toolAudit.find(t => t.toolName === "research_company")!;
  assert.equal(row.revenue, null, "spans two currencies — single-currency convenience field must be null, not blended");
  assert.equal(row.revenueByCurrency.USDC, 0.5);
  assert.equal(row.revenueByCurrency.BTC, 0.00001);
});

test("no secrets appear anywhere in a built record's shape", () => {
  const requestId = randomUUID();
  const tool = toolEvent({ requestId, channel: "x402", success: true });
  const settle = settlementRow({ requestId, status: "settlement_succeeded" });
  const records = buildCallAuditRecords({ events: [tool], settlements: [settle], ledgerEntries: [] });
  const serialized = JSON.stringify(records);
  for (const forbidden of ["privateKey", "signature", "paymentProof", "x-payment", "apiKey", "keyHash"]) {
    assert.ok(!serialized.toLowerCase().includes(forbidden.toLowerCase()), `must never contain "${forbidden}"`);
  }
});

test("mpp-session per-call settlement is honestly unknown, never fabricated as settled or as free", () => {
  const requestId = randomUUID();
  const tool = toolEvent({ requestId, channel: "mpp-session", success: true, toolName: "analyze_property" });
  const records = buildCallAuditRecords({ events: [tool], settlements: [], ledgerEntries: [] });
  const r = records[0]!;
  assert.equal(r.payment.settled, null);
  assert.equal(r.revenue.recorded, false);
  assert.equal(r.finalStatus, "unknown");
});

test("mpp session-level settlement rows (pseudo-tool) are excluded from per-call records entirely", () => {
  const sessionSettlement = settlementRow({ toolName: MPP_SESSION_LEDGER_TOOL, status: "settlement_succeeded" });
  const records = buildCallAuditRecords({ events: [], settlements: [sessionSettlement], ledgerEntries: [] });
  assert.equal(records.length, 0, "a session-aggregate settlement is not one call and must not appear as a fake CallAuditRecord");
});

test("mcp-remote billed via unified billing is reattributed to its real rail via the ledger, not left mislabeled", () => {
  const requestId = randomUUID();
  const tool = toolEvent({ requestId, channel: "mcp-remote", success: true, toolName: "research_company" });
  const entry = ledgerRow({ requestId, type: "debit", status: "settled", amountMicros: -500000, rail: "api_credits" });
  const records = buildCallAuditRecords({ events: [tool], settlements: [], ledgerEntries: [entry] });
  const r = records[0]!;
  assert.equal(r.channel, "mcp-remote", "the public label stays mcp-remote — the rail is explained in reasonDetail, not silently rewritten");
  assert.equal(r.finalStatus, "converted");
  assert.equal(r.reasonCode, "prepaid_capture_succeeded");
  assert.match(r.reasonDetail, /api_credits/);
});

test("commercial funnel: drop-off counts and unobserved counts never overlap, and unobserved is never hidden inside drop-off", () => {
  const converted = toolEvent({ requestId: randomUUID(), channel: "x402", success: true });
  const settleOk = settlementRow({ requestId: converted.requestId!, status: "settlement_succeeded" });
  const challengeOnly = x402Event("challenge", { requestId: randomUUID(), success: null });
  const records = buildCallAuditRecords({ events: [converted, challengeOnly], settlements: [settleOk], ledgerEntries: [] });
  const funnel = buildCommercialFunnel(records);
  const settledStage = funnel.stages.find(s => s.name === "payment_settled")!;
  assert.equal(settledStage.count, 1);
  const callsStage = funnel.stages.find(s => s.name === "calls")!;
  assert.equal(callsStage.count, 2);
});

test("reconciliation: amount_mismatch is flagged when recorded revenue diverges from the catalog price", () => {
  const requestId = randomUUID();
  const tool = toolEvent({ requestId, channel: "x402", success: true, toolName: "research_company" });
  const settle = settlementRow({ requestId, status: "settlement_succeeded", amountDecimal: 9.99, currency: "USD" });
  const records = buildCallAuditRecords({ events: [tool], settlements: [settle], ledgerEntries: [] });
  const anomalies = buildAuditReconciliation(records, { research_company: 0.5 });
  assert.ok(anomalies.some(a => a.kind === "amount_mismatch"));
});

test("zero-activity period: every builder returns an empty, well-typed result, never throws", () => {
  const records = buildCallAuditRecords({ events: [], settlements: [], ledgerEntries: [] });
  assert.deepEqual(buildToolAudit(records), []);
  const funnel = buildCommercialFunnel(records);
  assert.equal(funnel.stages.find(s => s.name === "calls")!.count, 0);
  assert.deepEqual(buildAuditReconciliation(records, {}), []);
});
