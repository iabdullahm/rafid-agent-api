import assert from "node:assert/strict";
import { test } from "node:test";
import type { AnalyticsEvent } from "../src/analytics/types.js";
import { auditPaymentTraffic } from "../src/analytics/paymentJourneyAudit.js";

const base = (overrides: Partial<AnalyticsEvent>): AnalyticsEvent => ({
  category: "x402", eventType: "payment_challenge", path: null, toolName: "analyze_property",
  channel: null, success: null, durationMs: null, amount: 0.01, currency: "USD", txHash: null,
  dataSource: null, clientHash: "client-1", userAgent: "RafidSDK/1.0", referer: null,
  clientName: null, createdAt: new Date().toISOString(), ...overrides
});

test("payment traffic audit is conservative and deduplicates journeys", () => {
  const report = auditPaymentTraffic([
    base({ paymentJourneyId: "j1", trafficType: "rest_agent" }),
    base({ paymentJourneyId: "j1", trafficType: "rest_agent" }),
    base({ paymentJourneyId: "j2", userAgent: "Googlebot/1.0" }),
    base({ paymentJourneyId: "j3", isInternalTest: true })
  ]);
  assert.equal(report.rawRequests, 4);
  assert.equal(report.uniqueJourneys, 3);
  assert.equal(report.uniqueClients, 1);
  assert.equal(report.duplicateRequests, 1);
  assert.equal(report.classifications.REAL_EXTERNAL_AGENT, 2);
  assert.equal(report.classifications.CRAWLER, 1);
  assert.equal(report.classifications.INTERNAL_TEST, 1);
  assert.equal(report.uniqueBodiesUnavailable, true);
});
