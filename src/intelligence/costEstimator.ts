/**
 * Internal unit-economics support — Section "Unit Economics": "Add internal support for
 * determining gross revenue, upstream data/search cost, LLM synthesis cost where measurable,
 * gross margin per capability. Do NOT call this net profit. Keep this internal. Do not delay
 * Phase 1 solely to build a sophisticated accounting system."
 *
 * Deliberately minimal, per that last instruction: a static table of ESTIMATED per-call upstream
 * costs (documented assumptions, not a live provider-billing integration) plus a running,
 * in-process counter of what was actually recorded per capability this process's lifetime. This
 * is NOT a second revenue ledger or a second analytics database — it never touches
 * rafid_x402_settlements or rafid_analytics_events, holds no PII, and is exposed only via one
 * additive internal-key-gated route (see api/revenueRoutes.ts's "unit-economics" route, reusing
 * the existing REVENUE_INTERNAL_API_KEY — no new secret, no new dashboard).
 *
 * Every number here is Rafid's own internal ESTIMATE, never a provider's actual confidential
 * pricing (Section: "Do not expose internal provider costs publicly" — this whole module is
 * internal-only) and never presented as net profit (Section: "Do NOT call this net profit" — see
 * `estimatedGrossMargin`'s name and doc comment below).
 *
 * Deliberately does NOT import src/billing/catalog.ts (for `prices`/`CapabilityName`) even though
 * that would be the obvious source for revenuePerCallUSD: this module is imported transitively by
 * domain/capabilities.ts itself (capabilities.ts -> services/companyIntelligence.ts ->
 * intelligence/risk/provider.ts -> .../webSearch/provider.ts -> costEstimator.ts), and
 * billing/catalog.ts imports `capabilities` FROM domain/capabilities.ts — importing it here too
 * would close that into a circular import (`capabilities` accessed before initialization at
 * runtime). Instead, the caller (src/api/revenueRoutes.ts, which already imports `prices`) passes
 * revenue figures in directly — see computeUnitEconomics/computeAllUnitEconomics below.
 */
import type { ProviderCostRecord } from "./types.js";

/** A plain capability-name string rather than billing/catalog.ts's `CapabilityName` — see the
 *  circular-import note above for why this module cannot import that type. */
type CapabilityKey = string;

/** Documented, hand-estimated per-call upstream cost assumptions for the Phase 1 capabilities —
 *  see the final report's "upstream cost per call estimate" section for the reasoning behind each
 *  number. Revisit these whenever the underlying provider's actual pricing changes; they are
 *  intentionally conservative (rounded up) rather than optimistic. A capability with no entry
 *  here (e.g. one with no external provider dependency) is simply absent — never defaulted to 0
 *  silently in a way that could look like "verified zero cost". */
export const ESTIMATED_UPSTREAM_COST_USD: Partial<Record<CapabilityKey, { providerCostUSD: number; llmCostUSD: number; assumptions: string }>> = {
  research_company: {
    providerCostUSD: 0.02, llmCostUSD: 0.01,
    assumptions: "Standard depth: ~3-4 web searches at an estimated $0.005/search (Tavily-class pricing) plus one small-model synthesis call over the retrieved snippets."
  },
  find_companies: {
    providerCostUSD: 0.006, llmCostUSD: 0.006,
    assumptions: "One web search covering up to the internal 20-result cap, plus one small-model extraction call over the retrieved snippets."
  },
  analyze_company_risk: {
    providerCostUSD: 0.015, llmCostUSD: 0,
    assumptions: "Up to 3 targeted web searches (adverse news, reputation, legal/regulatory) at an estimated $0.005/search; domain/website/sanctions checks use free public sources (RDAP, OFAC) with no per-call fee. No LLM synthesis — findings are presented as retrieved evidence, not generated prose."
  }
};

/** A single per-process running total per capability — reset on process restart, exactly like the
 *  in-memory analytics/revenue fallbacks reset without a database configured. Good enough for
 *  "how much are we actually spending on upstream providers this warm instance" without building
 *  a persisted cost ledger, per the "do not delay Phase 1" instruction above. */
const recordedCostsUSD = new Map<CapabilityKey, number>();
const recordedCallCounts = new Map<CapabilityKey, number>();

/** Called by a provider immediately after a real (non-"not configured") upstream call completes.
 *  Never called on the "not configured" fast path (there is no real cost to record there).
 *  Deliberately fire-and-forget/synchronous and side-effect-only — never affects what a
 *  capability returns to its caller, and never counted as revenue anywhere (see
 *  computeUnitEconomics() below, which takes the x402 settlement ledger's own catalog price as
 *  the ONLY revenue figure, passed in by the caller). */
export function recordProviderCost(record: ProviderCostRecord): void {
  const name = record.capability;
  recordedCostsUSD.set(name, (recordedCostsUSD.get(name) ?? 0) + record.estimatedCostUSD);
  recordedCallCounts.set(name, (recordedCallCounts.get(name) ?? 0) + 1);
}

/** For tests only. */
export function resetRecordedCosts(): void {
  recordedCostsUSD.clear();
  recordedCallCounts.clear();
}

export interface UnitEconomics {
  capability: string;
  revenuePerCallUSD: number;
  estimatedProviderCostPerCallUSD: number;
  estimatedLlmCostPerCallUSD: number;
  /** revenue - estimated upstream costs for ONE call, at the documented static assumptions above —
   *  a GROSS margin (Section: never net profit). Excludes hosting, database, facilitator/network
   *  fees and every other overhead a true net-profit figure would need to subtract — the exact
   *  same discipline the revenue ledger's own `grossRevenue` (never `profit`) field documents. */
  estimatedGrossMarginPerCallUSD: number;
  assumptions: string | null;
  recordedCallsThisProcess: number;
  recordedActualCostUSDThisProcess: number;
}

/** Pure, synchronous, and safe to call at any time (never throws for a capability with no cost
 *  entry — it just reports zero estimated cost, distinct from a real verified zero).
 *  `revenuePerCallUSD` is passed in by the caller (src/api/revenueRoutes.ts reads it from
 *  `prices[capability]`, the same catalog every other consumer reads) rather than looked up here —
 *  see this file's top doc comment for why this module cannot import billing/catalog.ts itself. */
export function computeUnitEconomics(capability: CapabilityKey, revenuePerCallUSD: number): UnitEconomics {
  const estimate = ESTIMATED_UPSTREAM_COST_USD[capability];
  const providerCost = estimate?.providerCostUSD ?? 0;
  const llmCost = estimate?.llmCostUSD ?? 0;
  return {
    capability,
    revenuePerCallUSD: round4(revenuePerCallUSD),
    estimatedProviderCostPerCallUSD: round4(providerCost),
    estimatedLlmCostPerCallUSD: round4(llmCost),
    estimatedGrossMarginPerCallUSD: round4(revenuePerCallUSD - providerCost - llmCost),
    assumptions: estimate?.assumptions ?? null,
    recordedCallsThisProcess: recordedCallCounts.get(capability) ?? 0,
    recordedActualCostUSDThisProcess: round4(recordedCostsUSD.get(capability) ?? 0)
  };
}

export function computeAllUnitEconomics(prices: Record<string, number>): UnitEconomics[] {
  return Object.entries(prices).map(([capability, price]) => computeUnitEconomics(capability, price));
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
