import type { CallAuditRecord, FinalStatus, ReasonCode } from "./types.js";

function round(n: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function topReasonCode(records: readonly CallAuditRecord[]): { reasonCode: ReasonCode; count: number } | null {
  if (records.length === 0) return null;
  const counts = new Map<ReasonCode, number>();
  for (const r of records) counts.set(r.reasonCode, (counts.get(r.reasonCode) ?? 0) + 1);
  let best: { reasonCode: ReasonCode; count: number } | null = null;
  for (const [reasonCode, count] of counts) {
    if (!best || count > best.count) best = { reasonCode, count };
  }
  return best;
}

function pct(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : round((numerator / denominator) * 100, 1);
}

// ---------------------------------------------------------------------------------------------
// Section 9: per-tool aggregated audit.
// ---------------------------------------------------------------------------------------------

export interface ToolAuditRow {
  toolName: string;
  calls: number;
  successfulExecutions: number;
  challenges402: number;
  /** Calls where payment.attempted === true (a real, observed attempt) — never counts a `null`
   *  (unobserved) as either an attempt or a non-attempt. */
  paymentAttempts: number;
  verified: number;
  settled: number;
  revenueByCurrency: Record<string, number>;
  /** Single-currency convenience, null when zero settled or when settled rows span more than one
   *  currency — same convention as revenue/aggregate.ts's RevenueToolStats.revenue. */
  revenue: number | null;
  currency: string | null;
  /** finalStatus -> count, for this tool — the per-tool "why didn't this convert" breakdown. */
  dropOffBreakdown: Partial<Record<FinalStatus, number>>;
  /** null when there were 0 calls with payment.required === true (no opportunity to convert —
   *  never a fabricated 0%). Denominator is calls where payment.required === true; numerator is
   *  finalStatus === "converted". */
  conversionPct: number | null;
  topFailureReason: ReasonCode | null;
}

export function buildToolAudit(records: readonly CallAuditRecord[]): ToolAuditRow[] {
  const byTool = new Map<string, CallAuditRecord[]>();
  for (const r of records) {
    const name = r.toolName ?? "(unknown tool)";
    const list = byTool.get(name) ?? [];
    list.push(r);
    byTool.set(name, list);
  }
  const rows: ToolAuditRow[] = [];
  for (const [toolName, toolRecords] of byTool) {
    const calls = toolRecords.length;
    const successfulExecutions = toolRecords.filter(r => r.execution.success === true).length;
    const challenges402 = toolRecords.filter(r => r.payment.challengeIssued === true).length;
    const paymentAttempts = toolRecords.filter(r => r.payment.attempted === true).length;
    const verified = toolRecords.filter(r => r.payment.verified === true).length;
    const settled = toolRecords.filter(r => r.payment.settled === true).length;
    const revenueByCurrency: Record<string, number> = {};
    for (const r of toolRecords) {
      if (r.revenue.recorded && r.revenue.amount !== null && r.revenue.currency !== null) {
        revenueByCurrency[r.revenue.currency] = round((revenueByCurrency[r.revenue.currency] ?? 0) + r.revenue.amount, 6);
      }
    }
    const currencies = Object.keys(revenueByCurrency);
    const revenue = currencies.length === 1 ? revenueByCurrency[currencies[0]!]! : null;
    const currency = currencies.length === 1 ? currencies[0]! : null;
    const dropOffBreakdown: Partial<Record<FinalStatus, number>> = {};
    for (const r of toolRecords) dropOffBreakdown[r.finalStatus] = (dropOffBreakdown[r.finalStatus] ?? 0) + 1;
    const opportunities = toolRecords.filter(r => r.payment.required === true).length;
    const converted = toolRecords.filter(r => r.finalStatus === "converted").length;
    const notConverted = toolRecords.filter(r => r.finalStatus !== "converted" && r.finalStatus !== "free_success");
    rows.push({
      toolName, calls, successfulExecutions, challenges402, paymentAttempts, verified, settled,
      revenueByCurrency, revenue, currency, dropOffBreakdown,
      conversionPct: pct(converted, opportunities),
      topFailureReason: topReasonCode(notConverted)?.reasonCode ?? null
    });
  }
  return rows.sort((a, b) => (b.revenue ?? -1) - (a.revenue ?? -1) || b.calls - a.calls);
}

// ---------------------------------------------------------------------------------------------
// Section 10: aggregate commercial funnel.
// ---------------------------------------------------------------------------------------------

export interface FunnelStage {
  name: string;
  count: number;
  /** null when this stage's observability is itself incomplete for a meaningful share of the
   *  prior stage (see `unobserved`) — the stage is then reported as "unknown / not instrumented"
   *  by the caller (page.ts/CLI), never as a fabricated 0% drop-off. */
  dropOffCount: number | null;
  dropOffPct: number | null;
  topDropOffReason: ReasonCode | null;
  /** How many calls from the PRIOR stage have a null (unobserved, not merely false) value for
   *  this stage's own signal — e.g. x402 "payment attempted" being null for a call with no
   *  correlating analytics signal at all. Always reported, never hidden inside dropOffCount. */
  unobserved: number;
}

export interface CommercialFunnel {
  stages: FunnelStage[];
}

/** Builds the 6-stage funnel (calls -> successful executions -> payment required -> attempted ->
 *  verified -> settled -> revenue recorded — 7 named points, 6 stage-transitions) spec section 10
 *  asks for. Every count is read straight off already-built CallAuditRecords — no new query, no
 *  re-derivation. */
export function buildCommercialFunnel(records: readonly CallAuditRecord[]): CommercialFunnel {
  const calls = records;
  const successfulExecutions = calls.filter(r => r.execution.success === true);
  const paymentRequired = successfulExecutions.filter(r => r.payment.required === true);
  const attemptedTrue = paymentRequired.filter(r => r.payment.attempted === true);
  const attemptedUnknown = paymentRequired.filter(r => r.payment.attempted === null);
  const verifiedTrue = attemptedTrue.filter(r => r.payment.verified === true);
  const verifiedUnknown = attemptedTrue.filter(r => r.payment.verified === null);
  const settledTrue = verifiedTrue.filter(r => r.payment.settled === true);
  const settledUnknown = verifiedTrue.filter(r => r.payment.settled === null);
  const revenueRecorded = settledTrue.filter(r => r.revenue.recorded);

  const stage = (name: string, count: readonly CallAuditRecord[], prior: readonly CallAuditRecord[] | null, unobservedFromPrior: readonly CallAuditRecord[]): FunnelStage => {
    if (prior === null) return { name, count: count.length, dropOffCount: null, dropOffPct: null, topDropOffReason: null, unobserved: 0 };
    const observedPrior = prior.length - unobservedFromPrior.length;
    const dropOffCount = observedPrior - count.length;
    const dropped = prior.filter(r => !count.includes(r) && !unobservedFromPrior.includes(r));
    return {
      name, count: count.length,
      dropOffCount: observedPrior > 0 ? Math.max(0, dropOffCount) : null,
      dropOffPct: observedPrior > 0 ? pct(Math.max(0, dropOffCount), observedPrior) : null,
      topDropOffReason: topReasonCode(dropped)?.reasonCode ?? null,
      unobserved: unobservedFromPrior.length
    };
  };

  return {
    stages: [
      stage("calls", calls, null, []),
      stage("successful_executions", successfulExecutions, calls, []),
      stage("payment_required", paymentRequired, successfulExecutions, []),
      stage("payment_attempted", attemptedTrue, paymentRequired, attemptedUnknown),
      stage("payment_verified", verifiedTrue, attemptedTrue, verifiedUnknown),
      stage("payment_settled", settledTrue, verifiedTrue, settledUnknown),
      stage("revenue_recorded", revenueRecorded, settledTrue, [])
    ]
  };
}

// ---------------------------------------------------------------------------------------------
// Section 20: reconciliation cross-checks specific to the per-call audit (complements, and never
// duplicates, revenue/aggregate.ts's buildReconciliation() — that function's x402-vs-analytics
// tool-execution-count checks already run unchanged, see spec section 29 / 20's "never replace
// existing reconciliation" rule). These are the checks only a per-call, cross-channel view can
// make: never mutates any record, purely a read-side report.
// ---------------------------------------------------------------------------------------------

export type AuditAnomalyKind =
  | "settled_but_no_tool_execution" | "tool_execution_but_no_expected_billing"
  | "billing_capture_missing" | "revenue_record_missing" | "amount_mismatch";

export interface AuditAnomaly {
  kind: AuditAnomalyKind;
  requestId: string | null;
  toolName: string | null;
  channel: string;
  detail: string;
}

export function buildAuditReconciliation(records: readonly CallAuditRecord[], catalogPriceByTool: Record<string, number>): AuditAnomaly[] {
  const anomalies: AuditAnomaly[] = [];
  for (const r of records) {
    if (r.revenue.recorded && !r.execution.attempted) {
      anomalies.push({
        kind: "settled_but_no_tool_execution", requestId: r.requestId, toolName: r.toolName, channel: r.channel,
        detail: "Revenue was recorded for this request but no correlating tool-execution event was found."
      });
    }
    if (r.reasonCode === "revenue_record_missing") {
      anomalies.push({
        kind: "revenue_record_missing", requestId: r.requestId, toolName: r.toolName, channel: r.channel,
        detail: r.reasonDetail
      });
    }
    if ((r.channel === "api_credits" || r.channel === "subscription") && r.execution.success === true && !r.revenue.recorded && r.reasonCode === "unknown") {
      anomalies.push({
        kind: "billing_capture_missing", requestId: r.requestId, toolName: r.toolName, channel: r.channel,
        detail: "Execution succeeded on an account-billed rail with no matching ledger capture for this request (see build.ts's classifyAccountRail — likely an idempotent replay, but not confirmed)."
      });
    }
    if (r.finalStatus === "converted" && r.revenue.amount !== null && r.revenue.currency === "USD" && r.toolName && catalogPriceByTool[r.toolName] !== undefined) {
      const expected = catalogPriceByTool[r.toolName]!;
      if (expected > 0 && Math.abs(r.revenue.amount - expected) > 0.01) {
        anomalies.push({
          kind: "amount_mismatch", requestId: r.requestId, toolName: r.toolName, channel: r.channel,
          detail: `Recorded revenue $${r.revenue.amount.toFixed(4)} differs from the catalog price $${expected.toFixed(2)} for ${r.toolName}.`
        });
      }
    }
    if (r.execution.success === true && r.payment.required === true && !r.revenue.recorded && r.finalStatus !== "settlement_failed" && r.reasonCode !== "revenue_record_missing" && r.reasonCode !== "unknown") {
      anomalies.push({
        kind: "tool_execution_but_no_expected_billing", requestId: r.requestId, toolName: r.toolName, channel: r.channel,
        detail: `Execution succeeded and payment was required, but no revenue was recorded (finalStatus=${r.finalStatus}, reasonCode=${r.reasonCode}).`
      });
    }
  }
  return anomalies;
}

// ---------------------------------------------------------------------------------------------
// Section 26/27: automated per-tool diagnosis + machine-readable recommendations. Both are pure
// text generation over already-computed ToolAuditRow/CallAuditRecord data — never a new query,
// never a claim beyond what the evidence in the row itself supports (no speculative wording).
// ---------------------------------------------------------------------------------------------

const RECOMMENDATIONS: Partial<Record<ReasonCode, string>> = {
  payment_not_attempted: "Callers are seeing the 402 price and not paying. Consider reviewing pricing, or clarifying the payment instructions returned in the 402 response.",
  payment_verification_failed: "A meaningful share of presented payments fail verification. Check the accepted payment methods/network configuration against what callers are actually sending.",
  payment_attempt_failed: "Presented payments are being rejected before verification. Check facilitator/network configuration.",
  settlement_failed: "Execution is succeeding but settlement is failing after the fact — customers are getting the service for free. Investigate the facilitator/settlement path urgently.",
  provider_not_configured: "A required upstream provider has no credentials configured in this environment — calls to this tool cannot succeed until it is configured.",
  provider_timeout: "Calls to this tool are timing out against an upstream provider. Consider a timeout/retry review or a provider health check.",
  provider_error: "Calls to this tool are failing against an upstream provider. Check that provider's status and this integration's error handling.",
  execution_failed: "Executions are failing for reasons not yet broken out by category — see docs/revenue-conversion-audit.md's observability-gaps section for adding a granular failure-category field.",
  schema_validation_failed: "Callers are frequently sending input that fails schema validation — consider clearer input documentation or examples.",
  insufficient_prepaid_balance: "Callers are running out of prepaid balance/subscription allowance before this call. Consider a low-balance warning or an easier top-up flow.",
  revenue_record_missing: "Execution and payment appear to have succeeded but no revenue record exists — investigate the settlement/ledger write path for dropped writes.",
  reconciliation_mismatch: "Payment was captured for a call that did not deliver a successful result — investigate refund policy for this tool."
};

export function recommendationFor(reasonCode: ReasonCode): string | null {
  return RECOMMENDATIONS[reasonCode] ?? null;
}

/** One evidence-scoped sentence per tool (spec section 26) — built entirely from the tool's own
 *  already-computed ToolAuditRow, never from anything the row doesn't itself contain. */
export function diagnoseToolRow(row: ToolAuditRow): string {
  if (row.calls === 0) return `${row.toolName}: no calls recorded in this period.`;
  if (row.conversionPct === null) {
    return `${row.toolName}: ${row.calls} call(s), no payment-required opportunity observed in this period (successful free/unpaid calls only, or no successful execution reached a paid stage).`;
  }
  if (row.conversionPct === 100) {
    return `${row.toolName}: ${row.calls} call(s), ${row.conversionPct}% conversion — every paid opportunity converted to revenue this period.`;
  }
  const reasonText = row.topFailureReason ? ` Top reason: ${row.topFailureReason}.` : "";
  return `${row.toolName}: ${row.calls} call(s), ${row.conversionPct}% conversion (${row.settled} settled of ${row.challenges402 || row.paymentAttempts || row.calls} opportunity/opportunities).${reasonText}`;
}
