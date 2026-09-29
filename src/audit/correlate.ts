import type { AnalyticsEvent } from "../analytics/types.js";
import type { RevenueSettlement } from "../revenue/types.js";
import type { LedgerEntry } from "../billing/unified/types.js";

/**
 * Correlation strategy (spec section 3's hard requirement): group every signal by `requestId` —
 * one physical HTTP request, and nothing weaker. `requestId` is the SAME identifier already
 * stamped by api/app.ts's top-level middleware (`res.locals.requestId = randomUUID()`) onto every
 * analytics "tool"/"x402"/"l402" event (analytics/types.ts's `requestId` field), every
 * RevenueSettlement (revenue/types.ts), and every unified-billing LedgerEntry
 * (billing/unified/types.ts) — so grouping by it costs nothing new to compute and never risks a
 * false match.
 *
 * Explicitly and deliberately NEVER correlated by: timestamp proximity, same tool name, same
 * price, or same client (the spec's exact forbidden list) — none of those distinguish two
 * different callers' simultaneous calls to the same free-priced tool, for one concrete example,
 * and silently merging them would fabricate a funnel that never happened.
 *
 * A signal with no requestId (analytics rows recorded before this field existed — see
 * analytics/types.ts's doc comment — or a LedgerEntry/RevenueSettlement type that is structurally
 * requestId-less, which does not occur in this codebase today) is never merged with anything else
 * "by best guess": it becomes its own single-signal group, keyed by a synthetic per-row id, so it
 * still gets an honest audit record (see build.ts) rather than being silently dropped or wrongly
 * merged. This is the "safe deterministic fallback" the spec asks this module to document: no
 * fallback correlation happens, ever — an ungrouped signal simply stays its own group of one.
 */

export interface CorrelatedGroup {
  /** The shared requestId, or null for a synthetic single-signal group (see doc comment above). */
  requestId: string | null;
  toolEvent: AnalyticsEvent | null;
  /** x402 category analytics events for this requestId — normally 0, 1 (challenge OR
   *  payment_failed alone) or 2 (payment_verified + settlement_success, recorded together — see
   *  api/app.ts's x402 finish listener). Never more than a handful; this module never assumes a
   *  specific count. */
  x402Events: AnalyticsEvent[];
  l402Events: AnalyticsEvent[];
  /** At most one — RevenueSettlement.requestId is unique per settlement attempt in this codebase
   *  (one x402/L402/MPP settlement is recorded per paid physical request). */
  settlement: RevenueSettlement | null;
  /** Unified-billing ledger rows for this requestId — 1 (a still-pending or settled reservation)
   *  or 2 (the original reservation, now "refunded", plus its linked "refund" entry — see
   *  billing/unified/memoryStore.ts's release()). Sorted oldest-first so [0] is always the
   *  original reservation. */
  ledgerEntries: LedgerEntry[];
  /** Earliest timestamp among this group's signals — used as the record's `calledAt`. */
  earliestAt: string;
}

/**
 * Groups every already period-scoped signal by requestId. Pure and synchronous — callers fetch
 * each source's rows for the desired window first (see build.ts's `buildCallAuditRecords()`), so
 * this never issues its own query and never re-derives a time window.
 */
export function correlateByRequestId(args: {
  events: readonly AnalyticsEvent[];
  settlements: readonly RevenueSettlement[];
  ledgerEntries: readonly LedgerEntry[];
}): CorrelatedGroup[] {
  const groups = new Map<string, CorrelatedGroup>();
  const orphans: CorrelatedGroup[] = [];

  const groupFor = (requestId: string | null | undefined, at: string): CorrelatedGroup => {
    if (requestId) {
      let g = groups.get(requestId);
      if (!g) {
        g = { requestId, toolEvent: null, x402Events: [], l402Events: [], settlement: null, ledgerEntries: [], earliestAt: at };
        groups.set(requestId, g);
      }
      if (at < g.earliestAt) g.earliestAt = at;
      return g;
    }
    const g: CorrelatedGroup = { requestId: null, toolEvent: null, x402Events: [], l402Events: [], settlement: null, ledgerEntries: [], earliestAt: at };
    orphans.push(g);
    return g;
  };

  for (const event of args.events) {
    if (event.category !== "tool" && event.category !== "x402" && event.category !== "l402") continue;
    const g = groupFor(event.requestId, event.createdAt);
    if (event.category === "tool") g.toolEvent = event;
    else if (event.category === "x402") g.x402Events.push(event);
    else g.l402Events.push(event);
  }
  for (const settlement of args.settlements) {
    const g = groupFor(settlement.requestId, settlement.createdAt);
    g.settlement = settlement;
  }
  for (const entry of args.ledgerEntries) {
    // Admin-granted credit/adjustment rows (metadata reason "admin grant" etc.) and
    // "credit_purchase" top-ups carry requestId: null by construction (billing/unified/store.ts's
    // applyCredit — a top-up is not a paid tool call) — never part of the per-call audit; skipping
    // them here (rather than emitting a same-shaped synthetic group) keeps them out of call counts
    // entirely, which is correct: they are funding events, not calls.
    if (entry.requestId === null) continue;
    const g = groupFor(entry.requestId, entry.createdAt);
    g.ledgerEntries.push(entry);
  }

  for (const g of groups.values()) g.ledgerEntries.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return [...groups.values(), ...orphans];
}
