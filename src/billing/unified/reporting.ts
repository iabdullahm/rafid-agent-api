import type { LedgerEntry } from "./types.js";

/**
 * Pure, read-only aggregation over an already-fetched, already-window-filtered
 * BillingStore.listSettledCharges() result — the exact same "fetch once, aggregate in plain JS"
 * shape src/revenue/aggregate.ts uses for the x402 settlement ledger. Revenue here is counted
 * only from rows listSettledCharges() itself already restricts to (status "settled", type
 * "debit"/"subscription_usage" — see store.ts's doc comment), mirroring revenue/aggregate.ts's
 * SOURCE_OF_TRUTH_RULE for the unified-billing ledger. Never used by the reserve/settle/release
 * path — this module exists purely for reporting (the internal ops dashboard).
 *
 * Deliberately kept SEPARATE from revenue/aggregate.ts's RevenueSettlement-shaped functions
 * rather than reusing them: a unified-billing ledger row has no on-chain network/asset/
 * facilitator/transaction-hash concept, and forcing it through that shape would mean inventing
 * values for fields that don't apply. Unified billing is always USD (see money.ts) — a single,
 * known currency — so, unlike x402/L402/MPP, there is no multi-currency blending risk here.
 */

function round(n: number, decimals = 6): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

/** Integer micro-USD -> decimal USD, always non-negative (amountMicros is signed negative for a
 *  debit/subscription_usage charge — see types.ts's LedgerEntry doc comment). */
const chargeUsd = (amountMicros: number): number => round(Math.abs(amountMicros) / 1_000_000, 6);

export interface UnifiedBillingRevenueTotals {
  totalUsd: number;
  settledCharges: number;
  byRail: { apiCredits: number; subscription: number };
}

export function summarizeUnifiedBillingRevenue(entries: readonly LedgerEntry[]): UnifiedBillingRevenueTotals {
  let totalUsd = 0;
  let apiCredits = 0;
  let subscription = 0;
  for (const e of entries) {
    const usd = chargeUsd(e.amountMicros);
    totalUsd = round(totalUsd + usd, 6);
    if (e.rail === "api_credits") apiCredits = round(apiCredits + usd, 6);
    else if (e.rail === "subscription") subscription = round(subscription + usd, 6);
  }
  return { totalUsd, settledCharges: entries.length, byRail: { apiCredits, subscription } };
}

export interface UnifiedBillingToolRow {
  toolName: string;
  revenueUsd: number;
  settledCalls: number;
}

/** Sorted by revenue descending (same tie-break convention as revenue/aggregate.ts's
 *  summarizeRevenueByTool()'s callers) — only tools with at least one settled unified-billing
 *  charge appear, mirroring revenueByTool's activity-only convention for a secondary breakdown
 *  (the dashboard's registry-driven "All Capabilities Overview" is what always lists every
 *  capability, per buildCapabilityOverview() in dashboard/service.ts). */
export function summarizeUnifiedBillingRevenueByTool(entries: readonly LedgerEntry[]): UnifiedBillingToolRow[] {
  const byTool = new Map<string, { revenueUsd: number; settledCalls: number }>();
  for (const e of entries) {
    if (!e.toolName) continue;
    const cur = byTool.get(e.toolName) ?? { revenueUsd: 0, settledCalls: 0 };
    cur.revenueUsd = round(cur.revenueUsd + chargeUsd(e.amountMicros), 6);
    cur.settledCalls += 1;
    byTool.set(e.toolName, cur);
  }
  return [...byTool.entries()]
    .map(([toolName, v]) => ({ toolName, ...v }))
    .sort((a, b) => b.revenueUsd - a.revenueUsd || b.settledCalls - a.settledCalls);
}
