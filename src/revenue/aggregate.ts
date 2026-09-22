import type { RevenueSettlement } from "./types.js";

/**
 * Pure aggregation over an already-fetched, already-window-filtered settlement array — the same
 * "fetch once, aggregate in plain JS" shape analytics/aggregate.ts uses, but NOT the same
 * "lightweight, may under-count" tradeoff: see revenue/types.ts's RevenueLedger.query() doc
 * comment for why this ledger fetches everything in the requested window rather than a capped
 * sample. Revenue is only ever counted from rows with status === "settlement_succeeded" — see
 * SOURCE_OF_TRUTH_RULE below, the one rule every function in this file follows.
 */
export const SOURCE_OF_TRUTH_RULE =
  "Revenue counts only rows with status === \"settlement_succeeded\". 402 challenges, verification " +
  "failures, and settlement_failed rows are never counted as revenue — see aggregate.ts.";

export type RevenuePeriod = "24h" | "7d" | "30d" | "all";
export const REVENUE_PERIODS: readonly RevenuePeriod[] = ["24h", "7d", "30d", "all"];

const PERIOD_MS: Record<Exclude<RevenuePeriod, "all">, number> = {
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000
};

/** null means "no lower bound" — the "all" period, read straight from the full ledger. */
export function periodSince(period: RevenuePeriod, now: Date): Date | null {
  if (period === "all") return null;
  return new Date(now.getTime() - PERIOD_MS[period]);
}

function round(n: number, decimals = 6): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

/** Groups settled amounts by currency and never blends them — see the spec's explicit
 *  requirement in section 6: "If multiple currencies/assets are ever introduced, do NOT
 *  incorrectly combine them into one amount." Every summary in this file uses this instead of a
 *  single summed number. */
function revenueByCurrency(settled: readonly RevenueSettlement[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const row of settled) {
    if (row.currency === null || row.amountDecimal === null) continue;
    totals[row.currency] = round((totals[row.currency] ?? 0) + row.amountDecimal);
  }
  return totals;
}

/** The single network figure a summary reports when every settled row in the window agrees;
 *  "mixed" when they don't (never silently picks one); null when there is nothing settled to
 *  report a network for. Mirrors the same never-blend discipline as revenueByCurrency, applied
 *  to network instead of currency — this deployment only ever configures one X402_NETWORK at a
 *  time, but historical ledger rows can span a network change across redeploys. */
function uniformNetwork(settled: readonly RevenueSettlement[]): string | "mixed" | null {
  const networks = new Set(settled.map(r => r.network));
  if (networks.size === 0) return null;
  if (networks.size > 1) return "mixed";
  return [...networks][0]!;
}

function uniformCurrency(byCurrency: Record<string, number>): string | null {
  const currencies = Object.keys(byCurrency);
  return currencies.length === 1 ? currencies[0]! : null;
}

// -----------------------------------------------------------------------------------------------
// GET /api/v1/internal/revenue/summary
// -----------------------------------------------------------------------------------------------

export interface RevenueSummary {
  period: RevenuePeriod;
  settledPayments: number;
  failedSettlements: number;
  network: string | "mixed" | null;
  /** Per-currency totals — the never-incorrectly-combined breakdown; authoritative. */
  revenueByCurrency: Record<string, number>;
  /** Convenience fields matching the spec's example shape — populated ONLY when exactly one
   *  currency is present among settled rows in this window (the common case today: this
   *  deployment only ever settles USDC). Both null when zero or multiple currencies are present,
   *  rather than guessing which one to surface — read revenueByCurrency instead in that case. */
  currency: string | null;
  grossRevenueUSD: number | null;
  averageRevenuePerPaidCall: number | null;
}

export function summarizeRevenue(settlements: readonly RevenueSettlement[], period: RevenuePeriod): RevenueSummary {
  const settled = settlements.filter(r => r.status === "settlement_succeeded");
  const failed = settlements.filter(r => r.status === "settlement_failed");
  const byCurrency = revenueByCurrency(settled);
  const currency = uniformCurrency(byCurrency);
  // "USD" convenience field: only meaningful when the single currency is USDC, which this
  // codebase treats as 1:1 with USD throughout (see buildX402Status()'s own "USDC" assumption
  // and analytics' existing x402 funnel, which already reports x402 amounts as currency "USD").
  const grossRevenueUSD = currency === "USDC" ? byCurrency[currency]! : null;
  return {
    period,
    settledPayments: settled.length,
    failedSettlements: failed.length,
    network: uniformNetwork(settled),
    revenueByCurrency: byCurrency,
    currency,
    grossRevenueUSD,
    averageRevenuePerPaidCall: grossRevenueUSD !== null && settled.length > 0 ? round(grossRevenueUSD / settled.length, 4) : null
  };
}

// -----------------------------------------------------------------------------------------------
// GET /api/v1/internal/revenue/tools
// -----------------------------------------------------------------------------------------------

export interface RevenueToolStats {
  settledCalls: number;
  failedSettlements: number;
  revenueByCurrency: Record<string, number>;
  /** Same single-currency convenience rule as RevenueSummary.grossRevenueUSD — null when this
   *  tool's settled rows in the window span more than one currency. */
  revenue: number | null;
  currency: string | null;
}

export function summarizeRevenueByTool(settlements: readonly RevenueSettlement[]): Record<string, RevenueToolStats> {
  const byTool: Record<string, RevenueToolStats> = {};
  const names = new Set(settlements.map(r => r.toolName));
  for (const name of names) {
    const rows = settlements.filter(r => r.toolName === name);
    const settled = rows.filter(r => r.status === "settlement_succeeded");
    const failed = rows.filter(r => r.status === "settlement_failed");
    const byCurrency = revenueByCurrency(settled);
    const currency = uniformCurrency(byCurrency);
    byTool[name] = {
      settledCalls: settled.length,
      failedSettlements: failed.length,
      revenueByCurrency: byCurrency,
      revenue: currency !== null ? byCurrency[currency]! : null,
      currency
    };
  }
  return byTool;
}

// -----------------------------------------------------------------------------------------------
// GET /api/v1/internal/revenue/reconciliation
// -----------------------------------------------------------------------------------------------

export type ReconciliationAnomalyKind =
  | "tool_executed_without_settlement"
  | "settlement_without_tool_execution"
  | "amount_mismatch"
  | "duplicate_transaction_hash"
  | "missing_transaction_hash";

export interface ReconciliationAnomaly {
  kind: ReconciliationAnomalyKind;
  toolName: string | null;
  detail: string;
  /** Safe references only — never a proof/signature. */
  requestId?: string;
  transactionHash?: string;
}

/**
 * Compares A (successful x402 tool executions, from analytics) against B (this ledger) per the
 * spec's section 9. `x402ToolExecutionCounts` must already be scoped to the SAME window and to
 * successful, x402-channel tool invocations only (api/app.ts passes analytics events filtered by
 * `channel === "x402" && category === "tool" && success === true`) — see analytics/types.ts's
 * `channel` field, added specifically to make this comparison possible without conflating an
 * x402 call with a REST or MCP call to the same capability.
 *
 * C (expected capability price) and D (on-chain transaction metadata where available) are both
 * folded into amount_mismatch/missing_transaction_hash below rather than kept as separate inputs
 * — C is `catalogPriceByTool`, D is simply each settled row's own transactionHash/amountSource,
 * already on the row.
 *
 * Never automatically alters financial records — this function only ever returns findings; every
 * revenue endpoint that calls it is GET-only.
 */
export function buildReconciliation(args: {
  settlements: readonly RevenueSettlement[];
  x402ToolExecutionCounts: Record<string, number>;
  catalogPriceByTool: Record<string, number>;
}): ReconciliationAnomaly[] {
  const { settlements, x402ToolExecutionCounts, catalogPriceByTool } = args;
  const anomalies: ReconciliationAnomaly[] = [];
  const settled = settlements.filter(r => r.status === "settlement_succeeded");

  // A vs B: successful x402 executions vs settled rows, per tool.
  const settledCountByTool: Record<string, number> = {};
  for (const row of settled) settledCountByTool[row.toolName] = (settledCountByTool[row.toolName] ?? 0) + 1;
  const allToolNames = new Set([...Object.keys(x402ToolExecutionCounts), ...Object.keys(settledCountByTool)]);
  for (const toolName of allToolNames) {
    const executed = x402ToolExecutionCounts[toolName] ?? 0;
    const settledForTool = settledCountByTool[toolName] ?? 0;
    if (executed > settledForTool) {
      anomalies.push({
        kind: "tool_executed_without_settlement", toolName,
        detail: `${executed} successful x402 execution(s) of ${toolName} vs ${settledForTool} settled ledger row(s) in this window`
      });
    } else if (settledForTool > executed) {
      anomalies.push({
        kind: "settlement_without_tool_execution", toolName,
        detail: `${settledForTool} settled ledger row(s) for ${toolName} vs ${executed} successful x402 execution(s) in this window`
      });
    }
  }

  // amount_mismatch: a settled row whose amount doesn't match this tool's current catalog price.
  // Reconciliation-only per the spec (capability.price is never the revenue source of truth) —
  // this never rewrites amountDecimal, it only flags the divergence for a human to investigate
  // (a legitimate mismatch can mean pricing changed since this row settled, not necessarily an
  // error).
  const EPSILON = 0.000001;
  for (const row of settled) {
    const expected = catalogPriceByTool[row.toolName];
    if (expected === undefined || row.amountDecimal === null) continue;
    if (Math.abs(row.amountDecimal - expected) > EPSILON) {
      anomalies.push({
        kind: "amount_mismatch", toolName: row.toolName,
        detail: `settled ${row.amountDecimal} ${row.currency ?? ""} vs current catalog price ${expected} for ${row.toolName} (amountSource: ${row.amountSource})`,
        requestId: row.requestId, ...(row.transactionHash ? { transactionHash: row.transactionHash } : {})
      });
    }
  }

  // duplicate_transaction_hash: should be structurally impossible given the dedupe unique index
  // (revenue/idempotency.ts) — checked anyway as a defense-in-depth integrity signal.
  const byTxHash = new Map<string, RevenueSettlement[]>();
  for (const row of settlements) {
    if (!row.transactionHash) continue;
    const key = `${row.network}:${row.transactionHash}`;
    const list = byTxHash.get(key) ?? [];
    list.push(row);
    byTxHash.set(key, list);
  }
  for (const [key, rows] of byTxHash) {
    if (rows.length > 1) {
      anomalies.push({
        kind: "duplicate_transaction_hash", toolName: null,
        detail: `${rows.length} ledger rows share transaction hash ${key} — dedupe should make this impossible`,
        transactionHash: rows[0]!.transactionHash!
      });
    }
  }

  // missing_transaction_hash: a succeeded settlement with no transaction hash — @x402/core's
  // settleResponseSchema requires `transaction` on every settle response, so this should never
  // happen for a real settlement_succeeded row; flagged as a data-integrity check.
  for (const row of settled) {
    if (!row.transactionHash) {
      anomalies.push({
        kind: "missing_transaction_hash", toolName: row.toolName,
        detail: `settlement_succeeded row for ${row.toolName} has no transaction hash`,
        requestId: row.requestId
      });
    }
  }

  return anomalies;
}
