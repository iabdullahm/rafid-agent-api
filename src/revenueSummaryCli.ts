/**
 * `npm run revenue:summary` — prints a safe revenue summary to stdout for an operator, without
 * calling the internal-key-protected HTTP endpoints (src/api/revenueRoutes.ts). Reads the same
 * RevenueLedger/summarizeRevenue()/summarizeRevenueByTool()/buildReconciliation() the HTTP routes
 * use — no second implementation of the numbers, and the same source-of-truth rule
 * (revenue/aggregate.ts's SOURCE_OF_TRUTH_RULE: only settlement_succeeded rows ever count as
 * revenue).
 *
 * Usage: npm run revenue:summary [-- 24h|7d|30d|all]   (default: 24h)
 *
 * Never prints amountAtomic, payerAddress, a transaction proof, or an internal API key — only the
 * same safe, aggregated figures GET /api/v1/internal/revenue/summary would return.
 */
import { getRevenueDatabaseUrl } from "./revenue/config.js";
import { getAnalyticsDatabaseUrl } from "./analytics/config.js";
import { MemoryRevenueLedger } from "./revenue/memoryLedger.js";
import { PostgresRevenueLedger } from "./db/revenueStore.js";
import { MemoryAnalyticsRepository } from "./analytics/memoryRepository.js";
import { PostgresAnalyticsRepository } from "./db/analyticsStore.js";
import { REVENUE_PERIODS, periodSince, summarizeRevenue, summarizeRevenueByTool, buildReconciliation, isPaidToolExecution, type RevenuePeriod } from "./revenue/aggregate.js";
import type { RevenueLedger } from "./revenue/types.js";
import type { AnalyticsRepository } from "./analytics/types.js";
import { prices, type CapabilityName } from "./billing/catalog.js";

function parsePeriod(argv: string[]): RevenuePeriod {
  const raw = argv[2];
  if (raw === undefined) return "24h";
  if (!REVENUE_PERIODS.includes(raw as RevenuePeriod)) {
    console.error(`Unknown period "${raw}" — expected one of: ${REVENUE_PERIODS.join(", ")}. Defaulting to 24h.`);
    return "24h";
  }
  return raw as RevenuePeriod;
}

async function main() {
  const period = parsePeriod(process.argv);
  const revenueDatabaseUrl = getRevenueDatabaseUrl();
  let ledger: RevenueLedger & { close?: () => Promise<void> };
  if (revenueDatabaseUrl) {
    ledger = new PostgresRevenueLedger(revenueDatabaseUrl);
  } else {
    console.error("No REVENUE_DATABASE_URL/DATABASE_URL configured — printing an empty summary from an in-memory ledger (this process has no prior settlements; run this against a deployed environment's database for a real report).");
    ledger = new MemoryRevenueLedger();
  }
  const analyticsDatabaseUrl = getAnalyticsDatabaseUrl();
  const analyticsRepository: AnalyticsRepository & { close?: () => Promise<void> } = analyticsDatabaseUrl
    ? new PostgresAnalyticsRepository(analyticsDatabaseUrl)
    : new MemoryAnalyticsRepository();

  try {
    const since = periodSince(period, new Date());
    const settlements = await ledger.query({ since });
    const summary = summarizeRevenue(settlements, period);
    const byTool = summarizeRevenueByTool(settlements);
    const analyticsEvents = await analyticsRepository.queryEvents(since ?? new Date(0));
    const x402ToolExecutionCounts: Record<string, number> = {};
    for (const event of analyticsEvents) {
      if (isPaidToolExecution(event) && event.toolName) {
        x402ToolExecutionCounts[event.toolName] = (x402ToolExecutionCounts[event.toolName] ?? 0) + 1;
      }
    }
    const catalogPriceByTool = Object.fromEntries(Object.keys(prices).map(name => [name, prices[name as CapabilityName]]));
    const anomalies = buildReconciliation({ settlements, x402ToolExecutionCounts, catalogPriceByTool });

    console.log(`Rafid Revenue — last ${period}\n`);
    console.log(`Settled calls: ${summary.settledPayments}`);
    if (summary.grossRevenueUSD !== null) {
      console.log(`Revenue: ${summary.grossRevenueUSD.toFixed(2)} ${summary.currency}`);
    } else {
      console.log(`Revenue by currency: ${JSON.stringify(summary.revenueByCurrency)}`);
    }
    const toolNames = Object.keys(byTool).sort();
    for (const name of toolNames) {
      const stats = byTool[name]!;
      if (stats.settledCalls === 0) continue;
      const revenueText = stats.revenue !== null ? `${stats.revenue.toFixed(2)} ${stats.currency}` : JSON.stringify(stats.revenueByCurrency);
      console.log(`${name}: ${stats.settledCalls} calls / ${revenueText}`);
    }
    console.log(`\nFailed settlements: ${summary.failedSettlements}`);
    console.log(`Reconciliation anomalies: ${anomalies.length}`);
    if (anomalies.length > 0) {
      for (const a of anomalies) console.log(`  - [${a.kind}]${a.toolName ? ` ${a.toolName}:` : ""} ${a.detail}`);
    }
  } finally {
    await ledger.close?.();
    await analyticsRepository.close?.();
  }
}

main().catch(err => {
  console.error("revenue:summary failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
