# Revenue Conversion Audit

For every capability/tool call, explains **why it did or did not convert into paid revenue** —
reconstructed entirely from data this deployment already records. It never creates a new
analytics database, a second revenue ledger, or new payment semantics, and it never modifies
existing payment behavior: it is a read-only lens over the analytics events, the x402/L402/MPP
revenue settlement ledger, the unified billing (API credits + subscription) ledger, and the
capability registry, all of which already exist.

Source: `src/audit/`.

## Why this exists

The dashboard already answers "how much revenue did we make" (Revenue, Revenue Overview) and
"which tools are converting" (Top Tools / Conversion by Tool). It did not answer, for one specific
failed or unpaid call, **what happened** and **why didn't this call become revenue** — the
Revenue Conversion Audit adds that.

## The unit of "one call"

A call is one physical HTTP request, identified by `requestId` — the same
`res.locals.requestId` (`api/app.ts`) already stamped onto every analytics "tool"/"x402"/"l402"
event, every `RevenueSettlement`, and every unified-billing `LedgerEntry`. Grouping by it is free
(no new correlation infrastructure) and never risks a false match.

This means an unpaid x402 402 challenge and a later paid retry are **two separate call records**,
each with its own `requestId` — not one merged "attempt". That is the honest answer: they really
are two physical requests. See `src/audit/correlate.ts`.

**Never correlated by:** timestamp proximity, same tool name, same price, or same client. Two
different callers hitting the same free-priced tool at the same instant must never be merged.

## Schema

One `CallAuditRecord` per call (`src/audit/types.ts`):

```json
{
  "requestId": "…",
  "toolName": "research_company",
  "channel": "x402",
  "calledAt": "2026-…",
  "called": true,
  "execution": { "attempted": true, "success": true, "failureReason": null },
  "payment": { "required": true, "challengeIssued": false, "attempted": true, "verified": true, "settled": true },
  "revenue": { "recorded": true, "amount": 0.5, "currency": "USDC", "channel": "x402" },
  "finalStatus": "converted",
  "reasonCode": "settlement_succeeded",
  "reasonDetail": "Execution succeeded and the x402 payment settled — revenue recorded."
}
```

Every boolean is either a real, directly-observed fact, or `null` with an explanation in
`reasonDetail` when this codebase's current instrumentation genuinely cannot see that stage. No
code path ever upgrades a `null` to a guessed `true`/`false` — see the anti-fabrication rule
repeated throughout `src/audit/build.ts`.

## Reason-code taxonomy

`ReasonCode` (`src/audit/types.ts`) is a closed, ~30-value enum — `tool_not_called`,
`schema_validation_failed`, `authentication_failed`, `rate_limited`, `provider_not_configured`,
`provider_timeout`, `provider_error`, `execution_failed`, `execution_succeeded_free_path`,
`payment_not_required`, `x402_challenge_not_issued`, `payment_not_attempted`,
`payment_attempt_failed`, `payment_verification_failed`, `payment_verified_not_settled`,
`settlement_failed`, `settlement_succeeded`, `insufficient_prepaid_balance`,
`prepaid_reservation_failed`, `prepaid_capture_failed`, `prepaid_capture_succeeded`,
`subscription_charge_failed`, `subscription_charge_succeeded`, `revenue_record_missing`,
`reconciliation_mismatch`, `unknown`. `unknown` is a first-class, legitimate value — assigned
whenever the evidence doesn't support anything more specific, never a fallback to be embarrassed
about.

`finalStatus` (`FinalStatus`) is the normalized outcome: `converted`, `not_converted`,
`free_success`, `failed_before_payment`, `payment_failed`, `settlement_failed`,
`reconciliation_issue`, `unknown`.

## Channel awareness

A call is judged only against the payment mechanism its own channel actually uses
(`src/audit/build.ts`):

| Channel | Judged against |
|---|---|
| `x402`, `l402` | The settlement ledger + the challenge/payment_verified/payment_failed/settlement_success/settlement_failure analytics events. |
| `mpp` | The settlement ledger (no dedicated challenge/payment_failed analytics category for MPP — see below). |
| `mpp-session` | Never per-call — a session's channel settles many calls at once under a separate `mpp_session` pseudo-tool row; per-call settlement is genuinely not observable, by protocol design, not a gap. |
| `api_credits`, `subscription` | The unified billing ledger's reserve → settle/release lifecycle (`BillingStore.listLedgerEntries`). Never evaluated against x402 settlement. |
| `mcp-remote` | Re-attributed to `api_credits`/`subscription` when a ledger reservation correlates by `requestId` (the mcp-credits transport bills through the same unified ledger, just under a narrower analytics channel label — see `classifyMcpRemote()`); otherwise treated as the free `/mcp` endpoint. |
| `free`, `rest` | No payment concept at all — `payment.required = false`. |

## Payment-attempt observability

This codebase never reimplements x402/L402 verification or settlement — third-party SDKs own
that. "Was a payment attempted" is read from the same signal that decided the response, never
invented:

- x402/L402: a `challenge` event alone means no payment was presented on this request. A
  `payment_failed`/`payment_verified`/`settlement_success`/`settlement_failure` event, or
  execution having happened at all (which requires the gate to have already verified a presented
  payment before calling `next()`), both mean an attempt is directly observable. Only when
  neither signal exists is this `null`.
- `api_credits`/`subscription`: "attempted" = a reservation exists in the unified billing ledger.
- `mpp`/`mpp-session`: there is no dedicated payment-rejection analytics category for MPP today —
  a rejected credential surfaces only as the generic execution failure. Reported honestly as
  `unknown` rather than guessed; see "Remaining observability gaps" below.

## Reconciliation cross-checks

`buildAuditReconciliation()` (`src/audit/aggregate.ts`) adds checks only a per-call, cross-channel
view can make — `settled_but_no_tool_execution`, `tool_execution_but_no_expected_billing`,
`billing_capture_missing`, `revenue_record_missing`, `amount_mismatch` — and never duplicates or
replaces `revenue/aggregate.ts`'s existing `buildReconciliation()` (x402-vs-analytics tool
execution counts), which keeps running unchanged. Never mutates any record.

## Endpoints

- `GET /api/v1/internal/audit/revenue-conversion` (`src/api/auditRoutes.ts`) — internal-key
  protected (`AUDIT_INTERNAL_API_KEY`, a dedicated key, never reused from
  `REVENUE_INTERNAL_API_KEY`/`ANALYTICS_INTERNAL_API_KEY`), 503s when unset. Query params:
  `period` (24h/7d/30d/all), `tool`, `channel`, `status`, `reason` — filters apply to the per-call
  `records` list; `toolAudit`/`funnel`/`anomalies`/`diagnoses`/`recommendations` always reflect
  the full period.
- `npm run audit:revenue -- [24h|7d|30d|all]` (`src/revenueConversionAuditCli.ts`) — the same
  `buildRevenueConversionAudit()` the HTTP route and dashboard call, printed for an operator.

## Dashboard

A new "Revenue Conversion Audit" panel (`src/api/dashboard/service.ts`'s
`buildRevenueConversionAuditSection()`, `src/api/dashboard/page.ts`'s
`renderRevenueConversionAudit()`) sits below Reconciliation: a commercial funnel summary, top
conversion blockers with a one-line recommendation each, a per-tool audit table (Tool / Calls /
Success / 402 / Payment Attempts / Verified / Settled / Revenue / Conversion / Top Blocker), and
the latest 20 non-converted and converted calls. It reuses the existing period selector; it does
not add its own interactive tool/channel/status/reason filters in this first version (use the
internal API's query params for that). The existing Active Agents cards gain an optional
paid-conversions / revenue / top-failure-reason line per tool-group agent
(`buildAgentStatuses()`'s new `toolAudit` argument). Every other dashboard section — Revenue,
Revenue Overview, Collection & Funding, All Capabilities Overview, Top Tools/Conversion by Tool,
Reconciliation — is unchanged.

## Performance

Every source is fetched once per report, already bounded by its own existing cap (analytics:
`MAX_QUERY_EVENTS`; the billing ledger and revenue ledger reads are windowed by `since`). Every
aggregation runs once, in plain JS, over those already-fetched arrays — no per-tool or per-record
additional query, matching this codebase's existing "lightweight ledger + plain JS aggregation"
philosophy. No new table is created; every `CallAuditRecord` is computed on demand.

## Security

The audit never exposes a payment proof, signature, raw API key, wallet private key, or
facilitator secret — the same redaction discipline as `revenueRoutes.ts`/`analyticsRoutes.ts`.
`reasonDetail` strings are static, evidence-scoped templates, never an echoed upstream error body.

## Remaining observability gaps

Documented honestly rather than papered over with a guess:

1. **`api_credits`/`subscription` "insufficient" rejections write no ledger row** — an insufficient
   prepaid balance, an exhausted subscription allowance, a request-schema validation failure, and
   an idempotency conflict all currently look identical from the analytics event alone (a failed
   "tool" category row with no matching ledger reservation). Closing this would mean
   `billing/unified/http.ts` recording which specific rejection reason occurred onto
   `res.locals` for the analytics event to pick up — additive, but out of this change's scope.
2. **MPP has no dedicated payment-rejection analytics category** — unlike x402/L402's
   challenge/payment_failed events, a rejected MPP credential/voucher surfaces only as a generic
   execution failure. Closing this would mean `billing/mpp/service.ts` emitting its own funnel
   events, mirroring `recordX402Event`/`recordL402Event`.
3. **No granular failure-category field on the "tool" analytics event** — today it carries only
   `success: boolean` plus, for a few capabilities, `dataSource`. `provider_timeout` vs.
   `provider_error` vs. `execution_failed` is not distinguishable beyond the one real
   `dataSource === "not_configured"` signal. Closing this would add an optional
   `failureCategory` field to `AnalyticsEvent`, populated at each capability's own catch block.
4. **mcp-remote's analytics channel label doesn't distinguish api_credits from subscription** at
   the point it's recorded (`billing/unified/mcp.ts`'s `onToolCall`) — this audit works around it
   by re-deriving the real rail from the correlating ledger entry, but the underlying analytics
   row still says "mcp-remote".
5. **A capped analytics window can outlive a settlement/ledger row's own retention** — the revenue
   ledger and billing ledger are uncapped; analytics is capped at `MAX_QUERY_EVENTS`. In a very
   high-traffic "all time" query, a settlement could show up with no correlating analytics event,
   landing in the `unknown` channel bucket. This is reported honestly, never guessed.
