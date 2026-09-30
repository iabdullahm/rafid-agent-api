import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeCapabilityFunnel } from "../src/analytics/aggregate.js";
import type { AnalyticsEvent } from "../src/analytics/types.js";

const base = (overrides: Partial<AnalyticsEvent>): AnalyticsEvent => ({
  category: "x402", eventType: "challenge", path: null, toolName: "analyze_property", channel: null,
  success: null, durationMs: null, amount: 0.01, currency: "USD", txHash: null, dataSource: null,
  clientHash: null, userAgent: "test", referer: null, clientName: null, createdAt: new Date().toISOString(),
  ...overrides
});

test("payment journey funnel counts unique paid journeys, retries, and paid executions", () => {
  const journey = "11111111-1111-4111-8111-111111111111";
  const events: AnalyticsEvent[] = [
    base({ eventType: "challenge", paymentJourneyId: journey, challengeRequestId: "req-402" }),
    base({ eventType: "paid_retry_received", requestId: "req-paid-1", paymentJourneyId: journey, paymentAttemptId: "attempt-1", paidRetryRequestId: "req-paid-1", paymentStatus: "paid" }),
    base({ eventType: "settlement_success", requestId: "req-paid-1", paymentJourneyId: journey, paymentAttemptId: "attempt-1", txHash: "0xtx", paymentStatus: "paid" }),
    base({ eventType: "settlement_success", requestId: "req-paid-1", paymentJourneyId: journey, paymentAttemptId: "attempt-1", txHash: "0xtx", paymentStatus: "paid" }),
    base({ category: "tool", eventType: "invocation", channel: "x402", success: true, requestId: "req-paid-1", paymentJourneyId: journey, paymentAttemptId: "attempt-1", paymentStatus: "paid" }),
    base({ category: "tool", eventType: "execution_completed", channel: "x402", success: true, requestId: "req-paid-1", paymentJourneyId: journey, paymentAttemptId: "attempt-1", paymentStatus: "paid" }),
    base({ eventType: "paid_retry_received", requestId: "req-paid-2", paymentJourneyId: journey, paymentAttemptId: "attempt-2", paidRetryRequestId: "req-paid-2", paymentStatus: "paid" }),
    base({ category: "tool", eventType: "invocation", channel: "x402", success: true, requestId: "req-paid-2", paymentJourneyId: journey, paymentAttemptId: "attempt-2", paymentStatus: "paid" })
  ];
  const row = summarizeCapabilityFunnel(events).analyze_property!;
  assert.equal(row.paidJourneys, 1);
  assert.equal(row.executedPaidJourneys, 1);
  assert.equal(row.totalExecutions, 2);
  assert.equal(row.paidRetryCount, 2);
  assert.equal(row.executionAttemptCount, 2);
  assert.equal(row.paymentToExecutionConversion, 100);
});

test("legacy settlement remains explicitly uncorrelated", () => {
  const row = summarizeCapabilityFunnel([base({ eventType: "settlement_success", txHash: "0xlegacy" })]).analyze_property!;
  assert.equal(row.paidJourneys, 0);
  assert.equal(row.legacyUncorrelatedPaid, 1);
  assert.equal(row.paymentToExecutionConversion, null);
});
