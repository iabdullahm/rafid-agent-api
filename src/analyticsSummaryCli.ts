/**
 * `npm run analytics:summary` — prints a safe last-24h analytics summary to stdout, for an
 * operator who wants a quick check without calling the internal-key-protected HTTP endpoints
 * (src/api/analyticsRoutes.ts). Reads the same PostgresAnalyticsRepository/MemoryAnalyticsRepository
 * seam and the same summarize() aggregation those routes use — no second implementation of the
 * numbers.
 *
 * Contains nothing an operator wouldn't already see via GET /api/v1/internal/analytics/summary:
 * event counts, success rates, partner-vs-demo split. Never prints a raw client hash's inputs,
 * never a token, never a private key.
 */
import { getAnalyticsDatabaseUrl } from "./analytics/config.js";
import { MemoryAnalyticsRepository } from "./analytics/memoryRepository.js";
import { PostgresAnalyticsRepository } from "./db/analyticsStore.js";
import { summarize, WINDOW_MS } from "./analytics/aggregate.js";
import type { AnalyticsRepository } from "./analytics/types.js";

async function main() {
  const databaseUrl = getAnalyticsDatabaseUrl();
  let repository: AnalyticsRepository & { close?: () => Promise<void> };
  if (databaseUrl) {
    repository = new PostgresAnalyticsRepository(databaseUrl);
  } else {
    console.error("No ANALYTICS_DATABASE_URL/DATABASE_URL configured — printing an empty summary from an in-memory repository (this process has no prior events; run this against a deployed environment's database for a real report).");
    repository = new MemoryAnalyticsRepository();
  }
  try {
    const since = new Date(Date.now() - WINDOW_MS.last24h);
    const events = await repository.queryEvents(since);
    const summary = summarize(events, new Date()).last24h;
    console.log(JSON.stringify({ windowStart: since.toISOString(), windowEnd: new Date().toISOString(), ...summary }, null, 2));
  } finally {
    await repository.close?.();
  }
}

main().catch(err => {
  console.error("analytics:summary failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
