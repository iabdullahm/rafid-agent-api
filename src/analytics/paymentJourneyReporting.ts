import type { AnalyticsEvent } from "./types.js";

export type PaymentJourneyStatus = "awaiting_payment" | "abandoned" | "attempted" | "settled" | "retried" | "executed" | "failed";

export const PAYMENT_ABANDONMENT_WINDOW_MS = 15 * 60 * 1000;

export interface PaymentJourneyRow {
  paymentJourneyId: string;
  requestCount: number;
  startedAt: string;
  capability: string | null;
  source: string;
  paymentRail: string | null;
  price: number | null;
  currency: string | null;
  challenge: { requestId: string | null; at: string | null };
  payment: { attemptId: string | null; status: "attempted" | "verified" | "failed" | null; at: string | null } | null;
  settlement: { status: "succeeded" | "failed" | null; txHash: string | null; at: string | null } | null;
  retry: { requestId: string | null; at: string | null } | null;
  execution: { status: "succeeded" | "failed" | null; at: string | null } | null;
  status: PaymentJourneyStatus;
  durationMs: number | null;
  revenue: number | null;
}

export interface PaymentJourneyFunnel {
  requests: number;
  challenges: number;
  paymentAttempts: number;
  settlements: number;
  retries: number;
  executions: number;
  abandonmentReasons: { noPaymentAttempt: number; paymentFailed: number; noRetry: number; executionFailed: number };
}

function firstEvent(rows: readonly AnalyticsEvent[], predicate: (event: AnalyticsEvent) => boolean): AnalyticsEvent | null {
  return rows.find(predicate) ?? null;
}

export function buildPaymentJourneyRows(events: readonly AnalyticsEvent[], limit = 100): PaymentJourneyRow[] {
  const groups = new Map<string, AnalyticsEvent[]>();
  for (const event of events) {
    if (!event.paymentJourneyId) continue;
    const rows = groups.get(event.paymentJourneyId) ?? [];
    rows.push(event);
    groups.set(event.paymentJourneyId, rows);
  }

  return [...groups.entries()].map(([paymentJourneyId, input]) => {
    const rows = input.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const first = rows[0]!;
    const challenge = firstEvent(rows, e => e.eventType === "challenge" || e.eventType === "payment_challenge");
    const attempted = firstEvent(rows, e => e.eventType === "payment_attempt_received" || e.eventType === "payment_verified" || e.eventType === "payment_failed" || e.eventType === "settlement_success" || e.eventType === "settlement_failure");
    const paymentAttemptReceived = firstEvent(rows, e => e.eventType === "payment_attempt_received");
    const paymentFailed = firstEvent(rows, e => e.eventType === "payment_failed");
    const settlement = firstEvent(rows, e => e.eventType === "settlement_success" || e.eventType === "settlement_failure");
    const retry = firstEvent(rows, e => e.eventType === "paid_retry_received");
    const execution = firstEvent(rows, e => e.category === "tool" && e.eventType === "execution_completed" && e.success !== null)
      ?? firstEvent(rows, e => e.category === "tool" && e.eventType === "invocation" && e.success !== null);
    const succeededExecution = execution?.success === true ? execution : null;
    const failedExecution = execution?.success === false ? execution : null;
    const ageMs = Date.now() - Date.parse(first.createdAt);
    const status: PaymentJourneyStatus = succeededExecution ? "executed"
      : failedExecution ? "failed"
      : settlement?.eventType === "settlement_success" ? retry ? "retried" : "settled"
      : paymentFailed ? "failed"
      : retry ? "retried"
      : attempted ? "attempted"
      : Number.isFinite(ageMs) && ageMs >= PAYMENT_ABANDONMENT_WINDOW_MS ? "abandoned"
      : "awaiting_payment";
    const last = rows[rows.length - 1]!;
    const startMs = Date.parse(first.createdAt), endMs = Date.parse(last.createdAt);
    return {
      paymentJourneyId,
      requestCount: new Set(rows.map(event => event.requestId).filter(Boolean)).size || 1,
      startedAt: first.createdAt,
      capability: first.toolName,
      source: first.source ?? first.trafficType ?? first.normalizedClient ?? first.clientName ?? "unknown",
      paymentRail: settlement?.paymentRail ?? retry?.paymentMode ?? attempted?.paymentMode ?? first.paymentMode ?? null,
      price: challenge?.amount ?? settlement?.amount ?? first.amount ?? null,
      currency: challenge?.currency ?? settlement?.currency ?? first.currency ?? null,
      challenge: { requestId: challenge?.challengeRequestId ?? challenge?.requestId ?? null, at: challenge?.challengeIssuedAt ?? challenge?.createdAt ?? null },
      payment: attempted ? { attemptId: attempted.paymentAttemptId ?? paymentAttemptReceived?.paymentAttemptId ?? null, status: (paymentFailed ? "failed" : attempted.eventType === "payment_verified" ? "verified" : "attempted") as "attempted" | "verified" | "failed", at: attempted.paymentAttemptedAt ?? attempted.paymentVerifiedAt ?? attempted.createdAt } : null,
      settlement: settlement ? { status: (settlement.eventType === "settlement_success" ? "succeeded" : "failed") as "succeeded" | "failed", txHash: settlement.txHash, at: settlement.chainSettledAt ?? settlement.settlementRecordedAt ?? settlement.createdAt } : null,
      retry: retry ? { requestId: retry.paidRetryRequestId ?? retry.requestId ?? null, at: retry.paidRetryReceivedAt ?? retry.createdAt } : null,
      execution: execution ? { status: (succeededExecution ? "succeeded" : failedExecution ? "failed" : null) as "succeeded" | "failed" | null, at: execution.executionCompletedAt ?? execution.createdAt } : null,
      status,
      durationMs: Number.isFinite(startMs) && Number.isFinite(endMs) && endMs >= startMs ? endMs - startMs : null,
      revenue: settlement?.eventType === "settlement_success" ? settlement.amount : null
    };
  }).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, limit);
}

export function buildPaymentJourneyFunnel(rows: readonly PaymentJourneyRow[]): PaymentJourneyFunnel {
  const challenges = rows.filter(r => r.challenge.at !== null).length;
  const paymentAttempts = rows.filter(r => r.payment !== null).length;
  const settlements = rows.filter(r => r.settlement?.status === "succeeded").length;
  const retries = rows.filter(r => r.retry !== null).length;
  const executions = rows.filter(r => r.execution?.status === "succeeded").length;
  return {
    requests: rows.reduce((total, row) => total + row.requestCount, 0), challenges, paymentAttempts, settlements, retries, executions,
    abandonmentReasons: {
      noPaymentAttempt: rows.filter(r => r.challenge.at !== null && !r.payment).length,
      paymentFailed: rows.filter(r => r.payment?.status === "failed").length,
      noRetry: rows.filter(r => r.settlement?.status === "succeeded" && !r.retry).length,
      executionFailed: rows.filter(r => r.execution?.status === "failed").length
    }
  };
}
