import type { RevenueLedger, RevenueSettlement, RevenueSettlementInput } from "./types.js";
import { MAX_QUERY_SETTLEMENTS } from "./types.js";

/** In-memory revenue ledger; entries are lost on process restart/redeploy — the safe default for
 *  createApp() and for tests, exactly like MemoryAnalyticsRepository/MemoryUsageRepository.
 *  Recording still always happens (never conditional on a database being configured); only
 *  durability across restarts requires REVENUE_DATABASE_URL/DATABASE_URL (see
 *  src/db/revenueStore.ts). Deduplicated on dedupeKey via a Set, exactly matching the strategy
 *  PostgresRevenueLedger enforces with a real unique index — see revenue/idempotency.ts. */
export class MemoryRevenueLedger implements RevenueLedger {
  private readonly rows: RevenueSettlement[] = [];
  private readonly seenDedupeKeys = new Set<string>();

  record(input: RevenueSettlementInput): void {
    if (this.seenDedupeKeys.has(input.dedupeKey)) return;
    this.seenDedupeKeys.add(input.dedupeKey);
    this.rows.push({ ...input, createdAt: input.createdAt ?? new Date().toISOString() });
  }

  async query(args: { since: Date | null; limit?: number; offset?: number }): Promise<RevenueSettlement[]> {
    const sinceMs = args.since ? args.since.getTime() : null;
    const matching = this.rows
      .filter(r => sinceMs === null || new Date(r.createdAt).getTime() >= sinceMs)
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const offset = args.offset ?? 0;
    const limit = Math.min(args.limit ?? MAX_QUERY_SETTLEMENTS, MAX_QUERY_SETTLEMENTS);
    return matching.slice(offset, offset + limit);
  }

  async count(since: Date | null): Promise<number> {
    const sinceMs = since ? since.getTime() : null;
    return this.rows.filter(r => sinceMs === null || new Date(r.createdAt).getTime() >= sinceMs).length;
  }

  /** Test-only helpers — never used by production call sites. */
  clear(): void {
    this.rows.length = 0;
    this.seenDedupeKeys.clear();
  }
  all(): readonly RevenueSettlement[] {
    return this.rows;
  }
}
