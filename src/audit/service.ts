import type { AnalyticsRepository } from "../analytics/types.js";
import type { RevenueLedger } from "../revenue/types.js";
import { periodSince, type RevenuePeriod } from "../revenue/aggregate.js";
import type { BillingEngine } from "../billing/unified/engine.js";
import type { LedgerEntry } from "../billing/unified/types.js";
import { prices, type CapabilityName } from "../billing/catalog.js";
import { buildCallAuditRecords } from "./build.js";
import {
  buildToolAudit, buildCommercialFunnel, buildAuditReconciliation, diagnoseToolRow, recommendationFor,
  type ToolAuditRow, type CommercialFunnel, type AuditAnomaly
} from "./aggregate.js";
import type { CallAuditRecord, ReasonCode } from "./types.js";

/**
 * Assembles one Revenue Conversion Audit report for a period — the single function the internal
 * API route (api/auditRoutes.ts), the CLI (revenueConversionAuditCli.ts), and the dashboard
 * section (api/dashboard/service.ts) all call, so the three surfaces can never drift from each
 * other's numbers (same discipline as revenue/aggregate.ts's summarizeRevenue() being the one
 * function revenueRoutes.ts, revenueSummaryCli.ts, and the dashboard all share).
 *
 * Performance (spec section 23): this fetches each source's already-bounded, already period-
 * scoped rows exactly once (no synchronous reconstruction of "millions of events" — the analytics
 * layer is itself capped at MAX_QUERY_EVENTS, the revenue ledger and billing ledger reads are
 * windowed by `since`), and every aggregation below runs once, in plain JS, over those same
 * already-fetched arrays — no per-tool or per-record additional query, matching this codebase's
 * existing "lightweight ledger + plain JS aggregation" philosophy (see revenue/types.ts's own
 * doc comment on that same tradeoff).
 */

export interface RevenueConversionAuditReport {
  period: RevenuePeriod;
  generatedAt: string;
  /** Every correlated call this period, newest first — capped at MAX_RECORDS_RETURNED for the
   *  same "bounded payload" reason revenue/types.ts's MAX_TRANSACTIONS_PAGE_SIZE exists; toolAudit
   *  and funnel below are computed over the FULL uncapped set, never this capped slice. */
  records: CallAuditRecord[];
  recordCount: number;
  toolAudit: ToolAuditRow[];
  funnel: CommercialFunnel;
  anomalies: AuditAnomaly[];
  diagnoses: string[];
  recommendations: { reasonCode: ReasonCode; recommendation: string }[];
}

export interface RevenueConversionAuditOptions {
  analyticsRepository: AnalyticsRepository;
  revenueLedger: RevenueLedger;
  /** null when this deployment has unified billing disabled — api_credits/subscription calls
   *  simply never occur then, so an empty ledgerEntries array is the honest input, same
   *  "disabled = zeros, not omitted" convention as api/dashboard/service.ts's DashboardServiceOptions. */
  billingEngine: BillingEngine | null;
  /** The capability registry's current price for a tool — deliberately a bare function (the same
   *  dependency shape createPaymentDispatcher's own `priceUsd` uses in billing/unified/http.ts),
   *  not a full BillingService, so a CLI/script caller never needs to construct one just to read
   *  reconciliation.ts's `catalogPriceByTool`. Every real call site (api/app.ts, the internal
   *  route, the dashboard) passes `billingService.getToolPrice.bind(billingService)`, the exact
   *  same registry-derived price every other revenue surface in this codebase reads. */
  priceUsd: (tool: CapabilityName) => number;
}

/** A generous safety cap on the per-call rows actually returned to a caller (dashboard table / API
 *  response / CLI output) — never an expected operating limit; toolAudit/funnel/anomalies are
 *  always computed from the full set regardless of this cap. */
export const MAX_RECORDS_RETURNED = 2000;

export async function buildRevenueConversionAudit(opts: RevenueConversionAuditOptions, period: RevenuePeriod): Promise<RevenueConversionAuditReport> {
  const now = new Date();
  const since = periodSince(period, now);
  const [events, settlements, ledgerEntries] = await Promise.all([
    opts.analyticsRepository.queryEvents(since ?? new Date(0)),
    opts.revenueLedger.query({ since }),
    opts.billingEngine ? opts.billingEngine.store.listLedgerEntries(since) : Promise.resolve<LedgerEntry[]>([])
  ]);

  const allRecords = buildCallAuditRecords({ events, settlements, ledgerEntries });
  const toolAudit = buildToolAudit(allRecords);
  const funnel = buildCommercialFunnel(allRecords);

  const catalogPriceByTool: Record<string, number> = {};
  for (const name of Object.keys(prices)) catalogPriceByTool[name] = opts.priceUsd(name as CapabilityName);
  const anomalies = buildAuditReconciliation(allRecords, catalogPriceByTool);

  const diagnoses = toolAudit.map(diagnoseToolRow);
  const seenReasons = new Set<ReasonCode>();
  const recommendations: { reasonCode: ReasonCode; recommendation: string }[] = [];
  for (const row of toolAudit) {
    if (row.topFailureReason && !seenReasons.has(row.topFailureReason)) {
      const rec = recommendationFor(row.topFailureReason);
      if (rec) { recommendations.push({ reasonCode: row.topFailureReason, recommendation: rec }); seenReasons.add(row.topFailureReason); }
    }
  }

  return {
    period, generatedAt: now.toISOString(),
    records: allRecords.slice(0, MAX_RECORDS_RETURNED), recordCount: allRecords.length,
    toolAudit, funnel, anomalies, diagnoses, recommendations
  };
}
