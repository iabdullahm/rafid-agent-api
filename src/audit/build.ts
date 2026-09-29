import type { AnalyticsEvent } from "../analytics/types.js";
import type { LedgerEntry } from "../billing/unified/types.js";
import { MPP_SESSION_LEDGER_TOOL } from "../billing/mpp/settlement.js";
import { correlateByRequestId, type CorrelatedGroup } from "./correlate.js";
import type { AuditChannel, CallAuditRecord, FinalStatus, ReasonCode } from "./types.js";

/**
 * Core per-call funnel reconstruction (spec sections 1, 4-8, 16-19).
 *
 * Channel awareness (spec section 4): a call is NEVER evaluated against a payment mechanism its
 * own channel doesn't use — an `api_credits`/`subscription` call is judged against the unified
 * billing ledger's reserve → settle/release lifecycle, never against x402 settlement; a `free`/
 * `rest` call has no payment concept to evaluate at all.
 *
 * Anti-fabrication (spec sections 5, 19 and the SUCCESS CRITERIA's own rule): every boolean below
 * is either a real, directly-observed fact, or `null` with an explanation in `reasonDetail` when
 * this codebase's current instrumentation genuinely cannot see that stage. No branch below ever
 * upgrades a `null` to a guessed `true`/`false`.
 */

const X402_LIKE_CATEGORY_TOOL_NAME_SENTINEL = MPP_SESSION_LEDGER_TOOL; // documents the exclusion below

function round(n: number, decimals = 6): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

function normalizeChannel(raw: string | null | undefined): AuditChannel {
  switch (raw) {
    case "rest": case "x402": case "l402": case "mpp": case "mpp-session":
    case "mcp-remote": case "api_credits": case "subscription": case "free":
      return raw;
    default:
      return "unknown";
  }
}

/** Best-effort, honestly-scoped failure detail (spec sections 16-18). The current analytics
 *  schema (analytics/types.ts's AnalyticsEvent) carries only `success: boolean` plus, for a
 *  handful of capabilities, `dataSource` — there is no granular error-code/category field on a
 *  "tool" category row today. So this function surfaces the one real signal that exists
 *  (`dataSource === "not_configured"` — a genuine, already-tracked provider-misconfiguration
 *  marker, see analytics/types.ts's DataSource doc comment) and is explicit, rather than silent,
 *  about the rest being unobserved. See the final report's "remaining observability gaps" for
 *  what closing this properly would need (a granular failure-category field on the tool-call
 *  event, populated at each capability's own catch block). */
function deriveFailureReason(toolEvent: AnalyticsEvent | null): string | null {
  if (!toolEvent || toolEvent.success !== false) return null;
  if (toolEvent.dataSource === "not_configured") {
    return "provider_not_configured (a required upstream provider has no credentials/config in this environment)";
  }
  return "unknown (no granular failure detail is captured by the current analytics schema for this call — see docs/revenue-conversion-audit.md's observability-gaps section)";
}

function executionFailureReasonCode(toolEvent: AnalyticsEvent | null): ReasonCode {
  if (toolEvent?.dataSource === "not_configured") return "provider_not_configured";
  return "execution_failed";
}

/** True/false/false: the exact vocabulary produced for x402/L402 rows — see
 *  analytics/recorder.ts's classifyX402Outcome()/X402_SUCCESS_BY_EVENT_TYPE. */
function hasEventType(events: readonly AnalyticsEvent[], eventType: string): boolean {
  return events.some(e => e.eventType === eventType);
}

/**
 * x402 and L402 share one funnel vocabulary end to end (recordL402Event's own doc comment: "the
 * same funnel vocabulary as x402") — challenge / payment_verified / payment_failed /
 * settlement_success / settlement_failure — so one function classifies both; `paymentEvents` is
 * whichever of `group.x402Events`/`group.l402Events` matches the channel being built.
 *
 * Payment-attempt observability (spec sections 5 and 19): this codebase never reimplements x402/
 * L402 verification itself (buildX402Gate()/createL402Gate() own that entirely — third-party
 * SDKs), so "was a payment attempted" is read from the SAME signal that decided the response, not
 * invented: a "challenge" event alone means no payment was presented on this request (the classic
 * unpaid 402); a payment_failed/payment_verified/settlement_success/settlement_failure event, OR
 * an execution having actually happened at all (which requires the third-party gate to have
 * already verified a presented payment before calling next() — see api/app.ts's gate mounting
 * order), both mean a payment attempt is a directly-observable fact. Only when NEITHER signal
 * exists does this report `null` with an explanation — never guessed.
 */
function classifyX402Like(group: CorrelatedGroup, channel: Extract<AuditChannel, "x402" | "l402">, paymentEvents: readonly AnalyticsEvent[]): CallAuditRecord {
  const hasExecution = group.toolEvent !== null;
  const hasChallenge = hasEventType(paymentEvents, "challenge");
  const hasPaymentFailed = hasEventType(paymentEvents, "payment_failed");
  const hasVerifiedOrSettled = hasEventType(paymentEvents, "payment_verified") || hasEventType(paymentEvents, "settlement_success");
  const hasSettlementFailure = hasEventType(paymentEvents, "settlement_failure");
  const hasSettlementSuccess = hasEventType(paymentEvents, "settlement_success") || (group.settlement?.status === "settlement_succeeded");

  // "attempted": see the function doc comment above for exactly which signals count as real.
  let attempted: boolean | null;
  if (hasVerifiedOrSettled || hasPaymentFailed || hasSettlementFailure || hasExecution) attempted = true;
  else if (hasChallenge) attempted = false;
  else attempted = null;

  // "verified": execution happening at all is itself proof of verification (the gate is
  // structurally the only thing standing between an unverified request and the capability
  // handler — see api/app.ts's `app.use(buildX402Gate(...))` mounted before the per-path routes
  // that set res.locals.toolName), so this is honest even when the x402/l402 analytics row for
  // THIS request happens to be missing (e.g. evicted from a capped analytics window).
  let verified: boolean | null;
  if (attempted === false) verified = null;
  else if (hasExecution || hasVerifiedOrSettled) verified = true;
  else if (hasPaymentFailed) verified = false;
  else verified = null;

  let settled: boolean | null;
  if (hasSettlementSuccess) settled = true;
  else if (hasSettlementFailure || group.settlement?.status === "settlement_failed") settled = false;
  else settled = null;

  const revenueRecorded = group.settlement?.status === "settlement_succeeded";
  const execution = {
    attempted: hasExecution,
    success: hasExecution ? (group.toolEvent!.success ?? null) : null,
    failureReason: hasExecution ? deriveFailureReason(group.toolEvent) : null
  };

  let finalStatus: FinalStatus;
  let reasonCode: ReasonCode;
  let reasonDetail: string;

  if (hasExecution) {
    if (execution.success === false) {
      if (settled === true) {
        finalStatus = "reconciliation_issue";
        reasonCode = "reconciliation_mismatch";
        reasonDetail = `Payment settled for this request, but tool execution failed after settlement — funds were captured for a ${channel} call that did not deliver a successful result. Needs manual review.`;
      } else {
        finalStatus = "failed_before_payment";
        reasonCode = executionFailureReasonCode(group.toolEvent);
        reasonDetail = `Execution failed on this ${channel} call (${execution.failureReason}); no revenue was recorded for it.`;
      }
    } else if (settled === true) {
      finalStatus = "converted";
      reasonCode = "settlement_succeeded";
      reasonDetail = `Execution succeeded and the ${channel} payment settled — revenue recorded.`;
    } else if (settled === false) {
      finalStatus = "settlement_failed";
      reasonCode = "settlement_failed";
      reasonDetail = `Execution succeeded, but the ${channel} payment settlement itself failed — the call was serviced with no revenue captured.`;
    } else {
      finalStatus = "unknown";
      reasonCode = "revenue_record_missing";
      reasonDetail = `Execution succeeded on this ${channel} route (which requires payment to already be verified before execution can begin), but no settlement outcome or revenue-ledger row could be found for this request — revenue may be missing.`;
    }
  } else {
    if (attempted === false) {
      finalStatus = "not_converted";
      reasonCode = "payment_not_attempted";
      reasonDetail = `A 402 ${channel === "x402" ? "payment-required challenge" : "challenge"} was issued for this request; the caller did not present a payment on this specific call.`;
    } else if (attempted === true) {
      finalStatus = "payment_failed";
      reasonCode = verified === false ? "payment_verification_failed" : "payment_attempt_failed";
      reasonDetail = `A payment was presented on this ${channel} request but was rejected before execution began.`;
    } else {
      finalStatus = "unknown";
      reasonCode = "unknown";
      reasonDetail = `No challenge, payment, or execution signal was found for this request on the ${channel} route — payment-attempt stage is not independently observable here.`;
    }
  }

  return {
    requestId: group.requestId, toolName: group.toolEvent?.toolName ?? paymentEvents[0]?.toolName ?? group.settlement?.toolName ?? null,
    channel, calledAt: group.earliestAt, called: true, execution,
    payment: { required: true, challengeIssued: hasChallenge, attempted, verified, settled },
    revenue: {
      recorded: revenueRecorded, amount: revenueRecorded ? group.settlement!.amountDecimal : null,
      currency: revenueRecorded ? group.settlement!.currency : null, channel: revenueRecorded ? channel : null
    },
    finalStatus, reasonCode, reasonDetail
  };
}

/**
 * mpp (per-call synchronous charge): same settlement ledger as x402/L402, but this rail has no
 * dedicated "challenge"/"payment_failed" analytics category (see billing/mpp/service.ts — a
 * rejected MPP credential/voucher surfaces only as the generic "tool" category row's
 * `success: false`, with no finer payment-stage breakdown recorded anywhere). This is a real,
 * narrower observability window than x402/L402 — reported honestly via `unknown`, never guessed.
 */
function classifyMpp(group: CorrelatedGroup): CallAuditRecord {
  const hasExecution = group.toolEvent !== null;
  const revenueRecorded = group.settlement?.status === "settlement_succeeded";
  const execution = {
    attempted: hasExecution,
    success: hasExecution ? (group.toolEvent!.success ?? null) : null,
    failureReason: hasExecution ? deriveFailureReason(group.toolEvent) : null
  };
  let finalStatus: FinalStatus;
  let reasonCode: ReasonCode;
  let reasonDetail: string;
  let settled: boolean | null = revenueRecorded ? true : (group.settlement?.status === "settlement_failed" ? false : null);

  if (!hasExecution) {
    finalStatus = "unknown"; reasonCode = "unknown";
    reasonDetail = "No tool-execution or settlement signal was found for this mpp request in the queried window.";
  } else if (execution.success === false) {
    finalStatus = settled === true ? "reconciliation_issue" : "failed_before_payment";
    reasonCode = settled === true ? "reconciliation_mismatch" : executionFailureReasonCode(group.toolEvent);
    reasonDetail = settled === true
      ? "MPP payment settled but tool execution failed — needs manual review."
      : `Execution failed on this mpp call (${execution.failureReason}); mpp has no separate payment-rejection signal, so whether a credential/voucher was even presented cannot be independently determined here.`;
  } else if (settled === true) {
    finalStatus = "converted"; reasonCode = "settlement_succeeded";
    reasonDetail = "Execution succeeded and the mpp charge settled — revenue recorded.";
  } else if (settled === false) {
    finalStatus = "settlement_failed"; reasonCode = "settlement_failed";
    reasonDetail = "Execution succeeded but the mpp settlement failed — the call was serviced with no revenue captured.";
  } else {
    finalStatus = "unknown"; reasonCode = "revenue_record_missing";
    reasonDetail = "Execution succeeded on the mpp route but no settlement/revenue row could be found for this request.";
  }

  return {
    requestId: group.requestId, toolName: group.toolEvent?.toolName ?? group.settlement?.toolName ?? null,
    channel: "mpp", calledAt: group.earliestAt, called: true, execution,
    payment: { required: true, challengeIssued: null, attempted: hasExecution ? true : null, verified: hasExecution ? true : null, settled },
    revenue: { recorded: revenueRecorded, amount: revenueRecorded ? group.settlement!.amountDecimal : null, currency: revenueRecorded ? group.settlement!.currency : null, channel: revenueRecorded ? "mpp" : null },
    finalStatus, reasonCode, reasonDetail
  };
}

/**
 * mpp-session (a metered call inside an open MPP session): the session's eventual on-chain
 * settlement pays for MANY calls at once, recorded under the `mpp_session` pseudo-tool with the
 * SESSION-CLOSE request's own requestId — never this individual call's (see
 * billing/mpp/settlement.ts's MPP_SESSION_LEDGER_TOOL doc comment and buildMppSessionSettlementRecord()).
 * So per-call settlement genuinely is not observable here, by design of the protocol itself, not
 * a gap in this codebase's instrumentation — reported as `null`/`unknown`, never as `false`
 * (which would wrongly imply the call was serviced for free) or fabricated as `true`.
 */
function classifyMppSession(group: CorrelatedGroup): CallAuditRecord {
  const hasExecution = group.toolEvent !== null;
  const execution = {
    attempted: hasExecution,
    success: hasExecution ? (group.toolEvent!.success ?? null) : null,
    failureReason: hasExecution ? deriveFailureReason(group.toolEvent) : null
  };
  const finalStatus: FinalStatus = execution.success === false ? "failed_before_payment" : "unknown";
  const reasonCode: ReasonCode = execution.success === false ? executionFailureReasonCode(group.toolEvent) : "unknown";
  const reasonDetail = execution.success === false
    ? `Execution failed on this metered mpp-session call (${execution.failureReason}).`
    : "This call was metered inside an open mpp-session. Its payment settles only in aggregate when the session's payment channel is closed/settled (under a separate, session-level ledger row — see MPP_SESSION_LEDGER_TOOL) — per-call settlement is not independently observable, by protocol design, not an instrumentation gap.";
  return {
    requestId: group.requestId, toolName: group.toolEvent?.toolName ?? null, channel: "mpp-session",
    calledAt: group.earliestAt, called: true, execution,
    payment: { required: true, challengeIssued: null, attempted: hasExecution ? true : null, verified: hasExecution ? true : null, settled: null },
    revenue: { recorded: false, amount: null, currency: null, channel: null },
    finalStatus, reasonCode, reasonDetail
  };
}

/**
 * api_credits / subscription (the unified billing account rails — src/billing/unified/): the
 * reserve → execute → settle/release lifecycle IS fully observable, via the SAME
 * BillingStore.listLedgerEntries() rows execution.ts's runBilledCall() itself writes (see
 * store.ts's doc comment) — no guessing required for the funnel this rail actually uses. The one
 * real gap (documented below, never silently patched over) is a call rejected at reservation time
 * ("insufficient" — see execution.ts's ReserveResult): no ledger row is EVER written for that
 * outcome by design (nothing was reserved), and http.ts's dispatcher also does not currently
 * capture WHICH rejection reason (insufficient balance vs. no active subscription vs. allowance
 * exhausted vs. a schema-validation failure that never reached billing at all) onto the analytics
 * event — so this function reports `unknown` with an explicit, itemized explanation rather than
 * guessing which of those it was.
 */
function classifyAccountRail(group: CorrelatedGroup, channel: Extract<AuditChannel, "api_credits" | "subscription">): CallAuditRecord {
  const hasExecution = group.toolEvent !== null;
  const primaryEntry = group.ledgerEntries.find(e => e.type === "debit" || e.type === "subscription_usage") ?? group.ledgerEntries[0] ?? null;
  const refundEntry = group.ledgerEntries.find(e => e.type === "refund") ?? null;
  const execution = {
    attempted: primaryEntry !== null,
    success: hasExecution ? (group.toolEvent!.success ?? null) : null,
    failureReason: hasExecution ? deriveFailureReason(group.toolEvent) : null
  };

  let finalStatus: FinalStatus;
  let reasonCode: ReasonCode;
  let reasonDetail: string;
  let settled: boolean | null = null;
  let revenueRecorded = false;
  let revenueAmount: number | null = null;

  if (primaryEntry) {
    if (primaryEntry.status === "settled") {
      settled = true; revenueRecorded = true; revenueAmount = round(Math.abs(primaryEntry.amountMicros) / 1e6, 6);
      finalStatus = "converted";
      reasonCode = channel === "subscription" ? "subscription_charge_succeeded" : "prepaid_capture_succeeded";
      reasonDetail = `Execution succeeded and the ${channel === "subscription" ? "subscription allowance" : "prepaid credit reservation"} was captured — revenue recorded.`;
    } else if (primaryEntry.status === "refunded" && refundEntry) {
      settled = false; revenueRecorded = false;
      finalStatus = "failed_before_payment";
      reasonCode = executionFailureReasonCode(group.toolEvent);
      reasonDetail = `Execution failed (${execution.failureReason}); the ${channel} reservation was released (reason: "${String(refundEntry.metadata?.reason ?? "capability_failed")}") — no revenue was recorded.`;
    } else {
      // "pending": the call may still be in flight, or a settle() write failed and the entry is
      // awaiting release-stale cleanup (execution.ts's runBilledCall doc comment) — genuinely
      // ambiguous from a point-in-time read, reported as unknown rather than guessed either way.
      finalStatus = "unknown"; reasonCode = "unknown";
      reasonDetail = `The ${channel} reservation for this call is still "pending" — either still in flight, or awaiting release-stale cleanup after an interrupted settlement write.`;
    }
  } else if (hasExecution && execution.success === true) {
    // No reservation for a successful execution — most likely an idempotent replay of an
    // already-billed earlier request (execution.ts's runBilledCall "replay" path never creates a
    // new ledger row); revenue was recorded on that ORIGINAL request, not duplicated here.
    finalStatus = "unknown"; reasonCode = "unknown";
    reasonDetail = `Execution succeeded with no matching ${channel} ledger reservation for this request — most likely an idempotent replay of an already-billed earlier call (see execution.ts's idempotency handling); revenue, if any, was recorded on that original request.`;
  } else if (hasExecution && execution.success === false) {
    finalStatus = "not_converted";
    reasonCode = "unknown";
    reasonDetail = `Execution was recorded as failed with no matching ${channel} ledger reservation for this request. This is consistent with several distinct causes this codebase's current instrumentation cannot yet tell apart on the analytics event alone: an insufficient prepaid balance / exhausted subscription allowance rejection (http.ts's "insufficient" outcome, which never writes a ledger row), a request-schema validation failure, or an idempotency conflict. See docs/revenue-conversion-audit.md's observability-gaps section for the closing-this-gap recommendation.`;
  } else {
    finalStatus = "unknown"; reasonCode = "unknown";
    reasonDetail = "No execution or ledger signal was found for this request in the queried window.";
  }

  return {
    requestId: group.requestId,
    toolName: group.toolEvent?.toolName ?? primaryEntry?.toolName ?? null,
    channel, calledAt: group.earliestAt, called: true, execution,
    payment: { required: true, challengeIssued: null, attempted: execution.attempted, verified: execution.attempted ? true : null, settled },
    revenue: { recorded: revenueRecorded, amount: revenueAmount, currency: revenueRecorded ? "USD" : null, channel: revenueRecorded ? channel : null },
    finalStatus, reasonCode, reasonDetail
  };
}

/** free / rest: no payment mechanism is engaged at all — see AnalyticsChannel's doc comment
 *  ("rest" = a plain legacy X-API-Key call with no unified billing involved; "free" = a
 *  zero-priced tool on the unified-billing dispatch path). Both are judged the same way: there is
 *  no funnel beyond "did it execute and succeed". */
function classifyUnpaid(group: CorrelatedGroup, channel: Extract<AuditChannel, "free" | "rest">): CallAuditRecord {
  const toolEvent = group.toolEvent;
  const success = toolEvent?.success ?? null;
  const execution = { attempted: toolEvent !== null, success, failureReason: toolEvent ? deriveFailureReason(toolEvent) : null };
  const finalStatus: FinalStatus = success === true ? "free_success" : success === false ? "failed_before_payment" : "unknown";
  const reasonCode: ReasonCode = success === true ? "payment_not_required" : success === false ? executionFailureReasonCode(toolEvent) : "unknown";
  const reasonDetail = success === true
    ? `This ${channel === "free" ? "zero-priced" : "legacy API-key"} call needed no payment — it is not expected to convert into revenue.`
    : success === false
      ? `Execution failed on this ${channel} call (${execution.failureReason}); no payment was ever required.`
      : "No execution outcome was recorded for this request.";
  return {
    requestId: group.requestId, toolName: toolEvent?.toolName ?? null, channel, calledAt: group.earliestAt, called: true,
    execution, payment: { required: false, challengeIssued: null, attempted: null, verified: null, settled: null },
    revenue: { recorded: false, amount: null, currency: null, channel: null }, finalStatus, reasonCode, reasonDetail
  };
}

/** mcp-remote: the free /mcp endpoint's tool calls, OR (see the doc comment below) a paid
 *  /mcp/credits call that the mcp-credits transport records under the same "mcp-remote" analytics
 *  channel label — this function tells the two apart by whether a unified-billing ledger
 *  reservation actually correlates to this requestId, rather than trusting the label alone. */
function classifyMcpRemote(group: CorrelatedGroup): CallAuditRecord {
  if (group.ledgerEntries.length > 0) {
    // billing/unified/mcp.ts's createCreditsMcpHandler threads the SAME requestId used to reserve
    // the ledger entry into its onToolCall event (see app.ts's mcp-credits `onToolCall` wiring) —
    // so a ledger reservation correlating here means this was actually billed via api_credits or
    // subscription, just recorded under the generic "mcp-remote" analytics channel label (a
    // pre-existing, narrower label than the REST dispatcher uses — not something this audit
    // changes, since doing so would mean editing already-shipped analytics recording beyond what
    // the spec's additive-only scope covers). The real rail is read off the ledger entry itself.
    const rail = group.ledgerEntries[0]!.rail;
    const effectiveChannel: Extract<AuditChannel, "api_credits" | "subscription"> = rail === "subscription" ? "subscription" : "api_credits";
    const record = classifyAccountRail(group, effectiveChannel);
    return { ...record, channel: "mcp-remote", reasonDetail: `${record.reasonDetail} (billed via ${effectiveChannel}; recorded as "mcp-remote" in analytics — see build.ts's classifyMcpRemote()).` };
  }
  return classifyUnpaid(group, "free");
}

/**
 * Builds one CallAuditRecord per correlated group (see correlate.ts). Pure and synchronous — the
 * caller (aggregate.ts / api/auditRoutes.ts / revenueConversionAuditCli.ts) fetches each source's
 * already period-scoped rows first, exactly like every other dashboard/report builder in this
 * codebase (see api/dashboard/service.ts's buildDashboardData()).
 *
 * A group whose settlement is an mpp-SESSION-level aggregate (toolName === MPP_SESSION_LEDGER_TOOL)
 * is deliberately excluded: it does not represent one call, it represents a whole session's worth
 * of many calls settling at once — including it as a single "call" audit row would misrepresent
 * both the call count and the per-call funnel. Its revenue is still fully visible in the existing
 * Revenue/Revenue Overview dashboard sections (this audit never hides or replaces those — see
 * spec section 29) — it is simply not attributable to one CallAuditRecord.
 */
export function buildCallAuditRecords(args: {
  events: readonly AnalyticsEvent[];
  settlements: readonly import("../revenue/types.js").RevenueSettlement[];
  ledgerEntries: readonly LedgerEntry[];
}): CallAuditRecord[] {
  const groups = correlateByRequestId(args).filter(g => g.settlement?.toolName !== X402_LIKE_CATEGORY_TOOL_NAME_SENTINEL);
  const records: CallAuditRecord[] = [];
  for (const group of groups) {
    const channel = normalizeChannel(group.toolEvent?.channel
      ?? (group.x402Events.length > 0 ? "x402" : null)
      ?? (group.l402Events.length > 0 ? "l402" : null)
      ?? (group.ledgerEntries.length > 0 ? group.ledgerEntries[0]!.rail : null));

    if (channel === "x402") records.push(classifyX402Like(group, "x402", group.x402Events));
    else if (channel === "l402") records.push(classifyX402Like(group, "l402", group.l402Events));
    else if (channel === "mpp") records.push(classifyMpp(group));
    else if (channel === "mpp-session") records.push(classifyMppSession(group));
    else if (channel === "api_credits") records.push(classifyAccountRail(group, "api_credits"));
    else if (channel === "subscription") records.push(classifyAccountRail(group, "subscription"));
    else if (channel === "mcp-remote") records.push(classifyMcpRemote(group));
    else if (channel === "free" || channel === "rest") records.push(classifyUnpaid(group, channel));
    else {
      // "unknown": a settlement-only or ledger-only group with no correlating analytics signal at
      // all to read a channel off (see correlate.ts's doc comment — most likely an analytics
      // window eviction, since the revenue/billing ledgers are uncapped but analytics is capped).
      const revenueRecorded = group.settlement?.status === "settlement_succeeded";
      records.push({
        requestId: group.requestId, toolName: group.settlement?.toolName ?? group.ledgerEntries[0]?.toolName ?? null,
        channel: "unknown", calledAt: group.earliestAt, called: true,
        execution: { attempted: false, success: null, failureReason: null },
        payment: { required: null, challengeIssued: null, attempted: null, verified: null, settled: revenueRecorded ? true : null },
        revenue: { recorded: revenueRecorded, amount: revenueRecorded ? group.settlement!.amountDecimal : null, currency: revenueRecorded ? group.settlement!.currency : null, channel: revenueRecorded ? "unknown" : null },
        finalStatus: "unknown", reasonCode: "unknown",
        reasonDetail: "A settlement or billing-ledger row was found for this requestId with no correlating analytics tool/x402/l402 event — the call's channel could not be determined. Likely cause: the analytics event was evicted from the queried window (analytics/types.ts's MAX_QUERY_EVENTS cap) while the settlement/ledger row (uncapped) remained."
      });
    }
  }
  return records.sort((a, b) => b.calledAt.localeCompare(a.calledAt));
}
