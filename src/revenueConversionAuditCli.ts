/**
 * `npm run audit:revenue -- [24h|7d|30d|all]` — prints a human-readable Revenue Conversion Audit
 * to stdout for an operator, without calling the internal-key-protected HTTP endpoint
 * (src/api/auditRoutes.ts). Reads the exact same buildRevenueConversionAudit() the HTTP route and
 * the dashboard section both call — no second implementation of the numbers (see
 * src/audit/service.ts's own doc comment).
 *
 * Never prints a payment proof, signature, API key, or wallet secret — only the same safe,
 * already-redacted fields the HTTP route and dashboard would also show (see
 * src/audit/build.ts's own field-by-field privacy discipline).
 */
import { getRevenueDatabaseUrl } from "./revenue/config.js";
import { getAnalyticsDatabaseUrl } from "./analytics/config.js";
import { MemoryRevenueLedger } from "./revenue/memoryLedger.js";
import { PostgresRevenueLedger } from "./db/revenueStore.js";
import { MemoryAnalyticsRepository } from "./analytics/memoryRepository.js";
import { PostgresAnalyticsRepository } from "./db/analyticsStore.js";
import { REVENUE_PERIODS, type RevenuePeriod } from "./revenue/aggregate.js";
import type { RevenueLedger } from "./revenue/types.js";
import type { AnalyticsRepository } from "./analytics/types.js";
import { prices, type CapabilityName } from "./billing/catalog.js";
import { BillingEngine, PostgresBillingStore, loadBillingConfig } from "./billing/unified/index.js";
import { buildRevenueConversionAudit } from "./audit/service.js";

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
  if (revenueDatabaseUrl) ledger = new PostgresRevenueLedger(revenueDatabaseUrl);
  else {
    console.error("No REVENUE_DATABASE_URL/DATABASE_URL configured — printing an audit from an in-memory ledger (this process has no prior settlements; run this against a deployed environment's database for a real report).");
    ledger = new MemoryRevenueLedger();
  }

  const analyticsDatabaseUrl = getAnalyticsDatabaseUrl();
  const analyticsRepository: AnalyticsRepository & { close?: () => Promise<void> } = analyticsDatabaseUrl
    ? new PostgresAnalyticsRepository(analyticsDatabaseUrl)
    : new MemoryAnalyticsRepository();

  // Unified billing (api_credits/subscription) is optional per deployment — same convention as
  // api/dashboard/service.ts's DashboardServiceOptions.billingEngine: null means "not configured",
  // and every api_credits/subscription figure below is then honestly zero, never omitted.
  const billingDatabaseUrl = process.env.BILLING_DATABASE_URL || process.env.DATABASE_URL;
  const billingConfig = loadBillingConfig({ ...process.env, API_CREDITS_ENABLED: process.env.API_CREDITS_ENABLED ?? "false" }, { nodeEnv: "development", databaseUrl: billingDatabaseUrl });
  const billingStore = billingDatabaseUrl && billingConfig.enabled ? new PostgresBillingStore(billingDatabaseUrl, { poolMax: 2 }) : null;
  const billingEngine = billingStore ? new BillingEngine({ config: billingConfig, store: billingStore, priceUsd: tool => prices[tool as CapabilityName] ?? 0 }) : null;

  try {
    const report = await buildRevenueConversionAudit({
      analyticsRepository, revenueLedger: ledger, billingEngine,
      priceUsd: tool => prices[tool] ?? 0
    }, period);

    console.log(`Rafid Revenue Conversion Audit — last ${period}\n`);
    console.log(`Calls: ${report.recordCount}\n`);

    console.log("Commercial funnel:");
    for (const stage of report.funnel.stages) {
      const dropOff = stage.dropOffCount === null ? "" : ` (drop-off: ${stage.dropOffCount}, ${stage.dropOffPct}%${stage.topDropOffReason ? `, top reason: ${stage.topDropOffReason}` : ""})`;
      const unobserved = stage.unobserved > 0 ? ` [${stage.unobserved} unobserved/not instrumented]` : "";
      console.log(`  ${stage.name}: ${stage.count}${dropOff}${unobserved}`);
    }

    console.log("\nPer-tool audit:");
    for (const row of report.toolAudit) {
      const conv = row.conversionPct === null ? "—" : `${row.conversionPct}%`;
      const paymentAttempts = row.paymentAttempts > 0 ? `${row.paymentAttempts}` : "unavailable";
      console.log(`  ${row.toolName}: calls=${row.calls} success=${row.successfulExecutions} 402=${row.challenges402} paymentAttempts=${paymentAttempts} verified=${row.verified} settled=${row.settled} revenue=${row.revenue !== null ? `${row.revenue.toFixed(2)} ${row.currency}` : JSON.stringify(row.revenueByCurrency)} conversion=${conv} topBlocker=${row.topFailureReason ?? "—"}`);
    }

    console.log("\nDiagnosis:");
    for (const line of report.diagnoses) console.log(`  - ${line}`);

    if (report.recommendations.length > 0) {
      console.log("\nRecommendations:");
      for (const r of report.recommendations) console.log(`  - [${r.reasonCode}] ${r.recommendation}`);
    }

    console.log(`\nReconciliation anomalies: ${report.anomalies.length}`);
    for (const a of report.anomalies.slice(0, 20)) console.log(`  - [${a.kind}]${a.toolName ? ` ${a.toolName}:` : ""} ${a.detail}`);
  } finally {
    await ledger.close?.();
    await analyticsRepository.close?.();
    await billingStore?.close();
  }
}

main().catch(err => {
  console.error("audit:revenue failed:", err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
