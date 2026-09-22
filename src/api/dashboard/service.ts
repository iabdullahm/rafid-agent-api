import type { Config } from "../../config/env.js";
import type { AnalyticsEvent, AnalyticsRepository } from "../../analytics/types.js";
import {
  WINDOW_MS, percentile,
  summarizeAllTime, summarizeDiscoveryAllTime, summarizeToolsAllTime, summarizeX402AllTime
} from "../../analytics/aggregate.js";
import type { RevenueLedger, RevenueSettlement } from "../../revenue/types.js";
import {
  REVENUE_PERIODS, periodSince, summarizeRevenue, summarizeRevenueByTool, buildReconciliation,
  type RevenuePeriod, type RevenueSummary, type RevenueToolStats, type ReconciliationAnomaly
} from "../../revenue/aggregate.js";
import { PostgresRevenueLedger } from "../../db/revenueStore.js";
import { PostgresAnalyticsRepository } from "../../db/analyticsStore.js";
import { MemoryRevenueLedger } from "../../revenue/memoryLedger.js";
import type { BillingService } from "../../billing/service.js";
import { prices, type CapabilityName } from "../../billing/catalog.js";
import { capabilities } from "../../domain/capabilities.js";

/**
 * Internal dashboard BFF (backend-for-frontend) business logic (spec sections 2-9, 11, 14).
 *
 * This module never duplicates analytics/revenue accounting logic: every number here is either
 * read straight from an existing aggregate function (summarizeRevenue, summarizeRevenueByTool,
 * buildReconciliation, summarizeAllTime/summarizeDiscoveryAllTime/summarizeToolsAllTime/
 * summarizeX402AllTime, percentile) or is a small, genuinely new presentation concern that has no
 * existing home — time-bucketing settled revenue for a chart, abbreviating a transaction hash,
 * building a safe block-explorer URL, and reading conversion ratios off already-computed funnel
 * counts. See revenue/aggregate.ts's SOURCE_OF_TRUTH_RULE: revenue figures here are computed only
 * from RevenueLedger rows with status === "settlement_succeeded", never from analytics.
 */

export const DASHBOARD_PERIODS = REVENUE_PERIODS;
export type DashboardPeriod = RevenuePeriod;

function round(n: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.round(n * factor) / factor;
}

// -----------------------------------------------------------------------------------------------
// Period resolution — the analytics layer only has fixed 24h/7d/30d windows (see
// analytics/aggregate.ts's WINDOW_MS); revenue/aggregate.ts's RevenuePeriod already natively
// supports "all". This reuses WINDOW_MS's own numbers (never a re-typed literal) and reuses
// revenue/aggregate.ts's periodSince() as-is for the revenue side.
// -----------------------------------------------------------------------------------------------

const ANALYTICS_WINDOW_MS: Record<Exclude<RevenuePeriod, "all">, number> = {
  "24h": WINDOW_MS.last24h, "7d": WINDOW_MS.last7d, "30d": WINDOW_MS.last30d
};

function analyticsSince(period: RevenuePeriod, now: Date): Date {
  return period === "all" ? new Date(0) : new Date(now.getTime() - ANALYTICS_WINDOW_MS[period]);
}

// -----------------------------------------------------------------------------------------------
// Revenue trend (spec section 3) — new: no existing function buckets settlements over time. Reads
// only status === "settlement_succeeded" rows (never challenges, payment_verified alone, or
// failed settlements), and — like every revenue figure in this codebase — never blends currencies
// into one number (see revenue/aggregate.ts's revenueByCurrency()).
// -----------------------------------------------------------------------------------------------

export interface RevenueTrendBucket {
  label: string;
  startIso: string;
  endIso: string;
  revenueByCurrency: Record<string, number>;
}

export interface RevenueTrend {
  granularity: "hourly" | "daily" | "monthly";
  buckets: RevenueTrendBucket[];
}

function makeBucket(start: Date, end: Date, label: string, succeeded: readonly RevenueSettlement[]): RevenueTrendBucket {
  const startMs = start.getTime(), endMs = end.getTime();
  const inBucket = succeeded.filter(r => {
    const t = new Date(r.createdAt).getTime();
    return t >= startMs && t < endMs;
  });
  const revenueByCurrency: Record<string, number> = {};
  for (const row of inBucket) {
    if (row.currency === null || row.amountDecimal === null) continue;
    revenueByCurrency[row.currency] = round((revenueByCurrency[row.currency] ?? 0) + row.amountDecimal, 6);
  }
  return { label, startIso: start.toISOString(), endIso: end.toISOString(), revenueByCurrency };
}

const MAX_MONTHLY_BUCKETS = 600; // ~50 years — a safety cap, never an expected operating limit.

export function buildRevenueTrend(settlements: readonly RevenueSettlement[], period: RevenuePeriod, now: Date): RevenueTrend {
  const succeeded = settlements.filter(r => r.status === "settlement_succeeded");

  if (period === "24h") {
    const nowHour = new Date(now); nowHour.setUTCMinutes(0, 0, 0);
    const buckets: RevenueTrendBucket[] = [];
    for (let i = 23; i >= 0; i--) {
      const start = new Date(nowHour.getTime() - i * 3_600_000);
      const end = new Date(start.getTime() + 3_600_000);
      buckets.push(makeBucket(start, end, `${String(start.getUTCHours()).padStart(2, "0")}:00`, succeeded));
    }
    return { granularity: "hourly", buckets };
  }

  if (period === "7d" || period === "30d") {
    const days = period === "7d" ? 7 : 30;
    const nowDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const buckets: RevenueTrendBucket[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const start = new Date(nowDay.getTime() - i * 86_400_000);
      const end = new Date(start.getTime() + 86_400_000);
      buckets.push(makeBucket(start, end, start.toISOString().slice(0, 10), succeeded));
    }
    return { granularity: "daily", buckets };
  }

  // "all": monthly buckets from the earliest succeeded settlement's month (or the current month,
  // when there are none yet — see spec section 13's empty-state requirement) through the current
  // month.
  const earliestMs = succeeded.reduce<number | null>((min, r) => {
    const t = new Date(r.createdAt).getTime();
    return min === null || t < min ? t : min;
  }, null);
  const earliest = earliestMs === null ? now : new Date(earliestMs);
  const startMonth = new Date(Date.UTC(earliest.getUTCFullYear(), earliest.getUTCMonth(), 1));
  const endMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const buckets: RevenueTrendBucket[] = [];
  let cursor = startMonth;
  let guard = 0;
  while (cursor.getTime() <= endMonth.getTime() && guard < MAX_MONTHLY_BUCKETS) {
    const start = cursor;
    const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
    buckets.push(makeBucket(start, end, `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`, succeeded));
    cursor = end;
    guard++;
  }
  return { granularity: "monthly", buckets };
}

// -----------------------------------------------------------------------------------------------
// Transaction hash: abbreviated for display, full value always preserved separately (spec
// section 7) — and a safe Base explorer link, built from nothing but the public network id and
// the public transaction hash (never a secret).
// -----------------------------------------------------------------------------------------------

export function abbreviateTxHash(hash: string): string {
  if (hash.length <= 14) return hash;
  return `${hash.slice(0, 6)}...${hash.slice(-4)}`;
}

const BASE_EXPLORER_BASE_URL: Record<string, string> = {
  "eip155:8453": "https://basescan.org/tx/",
  "eip155:84532": "https://sepolia.basescan.org/tx/"
};

const SAFE_TX_HASH = /^0x[0-9a-fA-F]+$/;

export function explorerUrlFor(network: string, txHash: string): string | null {
  const base = BASE_EXPLORER_BASE_URL[network];
  if (!base || !SAFE_TX_HASH.test(txHash)) return null;
  return base + txHash;
}

// -----------------------------------------------------------------------------------------------
// System status (spec section 9) — every field is either a known config fact (never phrased as
// "healthy") or evidence from a query that was actually attempted this request. "Unknown" — never
// a guess — when that evidence isn't available. Mirrors adminRoutes.ts's buildSystemStatus()
// discipline: databaseConnected is only ever set true after an operation that actually succeeded.
// -----------------------------------------------------------------------------------------------

export interface SystemStatusReport {
  mcp: "Enabled" | "Disabled";
  x402: "Enabled" | "Disabled";
  analytics: "Active" | "Unknown";
  revenueLedger: "Active" | "Unknown";
  partnerData: "Active" | "No partner-fed calls observed in this period" | "Unknown";
  database: string;
  lastSuccessfulSettlementAt: string | null;
  lastAnalyzeOmanPropertyCallAt: string | null;
  lastPartnerFeedAnalysisAt: string | null;
}

async function gatherSystemStatus(args: {
  config: Config;
  analyticsRepository: AnalyticsRepository;
  revenueLedger: RevenueLedger;
  period: RevenuePeriod;
  periodEvents: readonly AnalyticsEvent[];
  periodSettlements: readonly RevenueSettlement[];
}): Promise<SystemStatusReport> {
  const { config, analyticsRepository, revenueLedger, period } = args;

  let allTimeEvents: readonly AnalyticsEvent[] | null = null;
  let analyticsOk = true;
  try {
    allTimeEvents = period === "all" ? args.periodEvents : await analyticsRepository.queryEvents(new Date(0));
  } catch {
    analyticsOk = false;
  }

  let allTimeSettlements: readonly RevenueSettlement[] | null = null;
  let revenueOk = true;
  try {
    allTimeSettlements = period === "all" ? args.periodSettlements : await revenueLedger.query({ since: null, limit: 200 });
  } catch {
    revenueOk = false;
  }

  // ledger.query() and queryEvents() both return newest-first (see their own doc comments).
  const lastSuccessfulSettlement = allTimeSettlements?.find(r => r.status === "settlement_succeeded") ?? null;
  const lastAnalyzeCall = allTimeEvents?.find(e => e.category === "tool" && e.toolName === "analyze_oman_property") ?? null;
  const lastPartnerFeedAnalysis = allTimeEvents?.find(
    e => e.category === "tool" && (e.dataSource === "partner_feed" || e.dataSource === "mixed")
  ) ?? null;

  const anyToolCallsInPeriod = args.periodEvents.some(e => e.category === "tool");
  const partnerFeedInPeriod = args.periodEvents.some(e => e.category === "tool" && (e.dataSource === "partner_feed" || e.dataSource === "mixed"));

  const usingPostgres = revenueLedger instanceof PostgresRevenueLedger || analyticsRepository instanceof PostgresAnalyticsRepository;
  const usingMemory = revenueLedger instanceof MemoryRevenueLedger;
  const database = !analyticsOk || !revenueOk
    ? "Unknown"
    : usingPostgres ? "Connected (Postgres)" : usingMemory ? "Connected (in-memory — not durable across restarts)" : "Connected";

  return {
    mcp: config.mcpRemoteEnabled ? "Enabled" : "Disabled",
    x402: config.x402Enabled ? "Enabled" : "Disabled",
    analytics: analyticsOk ? "Active" : "Unknown",
    revenueLedger: revenueOk ? "Active" : "Unknown",
    partnerData: !anyToolCallsInPeriod ? "Unknown" : partnerFeedInPeriod ? "Active" : "No partner-fed calls observed in this period",
    database,
    lastSuccessfulSettlementAt: lastSuccessfulSettlement?.settledAt ?? lastSuccessfulSettlement?.createdAt ?? null,
    lastAnalyzeOmanPropertyCallAt: lastAnalyzeCall?.createdAt ?? null,
    lastPartnerFeedAnalysisAt: lastPartnerFeedAnalysis?.createdAt ?? null
  };
}

// -----------------------------------------------------------------------------------------------
// Full dashboard payload
// -----------------------------------------------------------------------------------------------

export interface RevenueByToolRow extends RevenueToolStats {
  toolName: string;
  sharePct: number | null;
}

export interface X402FunnelReport {
  challenges: number;
  paymentVerified: number;
  settlementSucceeded: number;
  settlementFailed: number;
  conversion: {
    challengeToVerifiedPct: number | null;
    verifiedToSettledPct: number | null;
    challengeToSettledPct: number | null;
  };
}

export interface UsageReport {
  discoveryHits: number;
  uniqueClients: number;
  mcpInitialize: number;
  mcpToolsList: number;
  mcpToolsCall: number;
  totalToolCalls: number;
  analyzeOmanPropertyCalls: number;
  toolSuccessRatePct: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  partnerFeedUsagePct: number | null;
}

export interface TransactionRow {
  time: string;
  capability: string;
  amount: number | null;
  currency: string | null;
  network: string;
  status: RevenueSettlement["status"];
  transactionHashFull: string | null;
  transactionHashAbbrev: string | null;
  explorerUrl: string | null;
}

export interface DashboardData {
  period: RevenuePeriod;
  generatedAt: string;
  revenue: RevenueSummary;
  /** Successful x402 tool executions observed by the analytics layer in this period (spec
   *  section 2's "Paid Calls" KPI) — deliberately a SECOND, independently-sourced count from
   *  revenue.settledPayments (the ledger's own row count): the two normally agree, and when they
   *  don't, that is exactly what the Reconciliation section below already flags
   *  (tool_executed_without_settlement / settlement_without_tool_execution). Never blended into
   *  one number. */
  paidCalls: number;
  revenueTrend: RevenueTrend;
  revenueByTool: RevenueByToolRow[];
  x402Funnel: X402FunnelReport;
  usage: UsageReport;
  transactions: TransactionRow[];
  reconciliation: { anomalyCount: number; anomalies: ReconciliationAnomaly[] };
  systemStatus: SystemStatusReport;
}

export interface DashboardServiceOptions {
  config: Config;
  analyticsRepository: AnalyticsRepository;
  revenueLedger: RevenueLedger;
  billingService: BillingService;
}

const MAX_TRANSACTIONS_SHOWN = 20;

function conversionPct(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : round((numerator / denominator) * 100, 1);
}

export async function buildDashboardData(opts: DashboardServiceOptions, period: RevenuePeriod): Promise<DashboardData> {
  const now = new Date();
  const revenueSince = periodSince(period, now);
  const eventsSince = analyticsSince(period, now);

  const [settlements, events] = await Promise.all([
    opts.revenueLedger.query({ since: revenueSince }),
    opts.analyticsRepository.queryEvents(eventsSince)
  ]);

  // ---- Revenue (source of truth: settlement_succeeded rows only — see aggregate.ts) ----
  const revenue = summarizeRevenue(settlements, period);
  const revenueTrend = buildRevenueTrend(settlements, period, now);

  const toolRevenue = summarizeRevenueByTool(settlements);
  // Section 4: never hardcode the capability list — the union of the shared capability registry
  // (domain/capabilities.ts, itself the one place every tool is described) and any tool name that
  // actually appears in this period's ledger (so a retired/renamed capability's historical
  // revenue is still visible).
  const knownToolNames = new Set<string>([...capabilities.map(c => c.name), ...Object.keys(toolRevenue)]);
  const revenueByTool: RevenueByToolRow[] = [...knownToolNames].map(toolName => {
    const stats: RevenueToolStats = toolRevenue[toolName] ?? {
      settledCalls: 0, failedSettlements: 0, revenueByCurrency: {}, revenue: null, currency: null
    };
    const totalForCurrency = stats.currency !== null ? revenue.revenueByCurrency[stats.currency] : undefined;
    const sharePct = stats.revenue !== null && totalForCurrency ? round((stats.revenue / totalForCurrency) * 100, 1) : null;
    return { toolName, ...stats, sharePct };
  }).sort((a, b) => (b.revenue ?? -1) - (a.revenue ?? -1) || b.settledCalls - a.settledCalls);

  // ---- x402 funnel (analytics is the only layer that tracks "challenge"/"payment_verified" —
  // the revenue ledger only ever records an actual settlement attempt; see revenue/types.ts).
  // Conversion rates are plain ratios over already-recorded counts — never an inferred event. ----
  const x402Window = summarizeX402AllTime(events);
  const x402Funnel: X402FunnelReport = {
    challenges: x402Window.challenges,
    paymentVerified: x402Window.paymentVerified,
    settlementSucceeded: x402Window.settlementSuccess,
    settlementFailed: x402Window.settlementFailure,
    conversion: {
      challengeToVerifiedPct: conversionPct(x402Window.paymentVerified, x402Window.challenges),
      verifiedToSettledPct: conversionPct(x402Window.settlementSuccess, x402Window.paymentVerified),
      challengeToSettledPct: conversionPct(x402Window.settlementSuccess, x402Window.challenges)
    }
  };

  // ---- Usage metrics ----
  const summaryWindow = summarizeAllTime(events);
  const discoveryWindow = summarizeDiscoveryAllTime(events);
  const toolsWindow = summarizeToolsAllTime(events);
  const analyzePropertyStats = toolsWindow.byTool["analyze_oman_property"];
  const toolDurations = events.filter(e => e.category === "tool" && typeof e.durationMs === "number").map(e => e.durationMs!);
  const usage: UsageReport = {
    discoveryHits: discoveryWindow.totalHits,
    uniqueClients: discoveryWindow.uniqueClients,
    mcpInitialize: toolsWindow.mcp.initialize,
    mcpToolsList: toolsWindow.mcp.toolsList,
    mcpToolsCall: toolsWindow.mcp.toolsCall,
    totalToolCalls: toolsWindow.totalInvocations,
    analyzeOmanPropertyCalls: analyzePropertyStats?.calls ?? 0,
    toolSuccessRatePct: summaryWindow.toolSuccessRate,
    p50LatencyMs: percentile(toolDurations, 50),
    p95LatencyMs: percentile(toolDurations, 95),
    partnerFeedUsagePct: summaryWindow.toolInvocations === 0 ? null : round((summaryWindow.partnerFeedInvocations / summaryWindow.toolInvocations) * 100, 1)
  };

  // ---- Latest transactions (spec section 7) — ledger.query() is already newest-first; every
  // status is shown (not only succeeded) so a failure is visible, never only successes. Only
  // known-safe fields ever leave this function: no payment proof, signature, API key, private
  // key or facilitator secret. ----
  const transactions: TransactionRow[] = settlements.slice(0, MAX_TRANSACTIONS_SHOWN).map(r => ({
    time: r.createdAt,
    capability: r.toolName,
    amount: r.amountDecimal,
    currency: r.currency,
    network: r.network,
    status: r.status,
    transactionHashFull: r.transactionHash,
    transactionHashAbbrev: r.transactionHash ? abbreviateTxHash(r.transactionHash) : null,
    explorerUrl: r.transactionHash ? explorerUrlFor(r.network, r.transactionHash) : null
  }));

  // ---- Reconciliation (spec section 8) — identical inputs to GET /api/v1/internal/revenue/
  // reconciliation (revenueRoutes.ts), computed in-process here rather than proxied over HTTP. ----
  const x402ToolExecutionCounts: Record<string, number> = {};
  for (const event of events) {
    if (event.category === "tool" && event.channel === "x402" && event.success === true && event.toolName) {
      x402ToolExecutionCounts[event.toolName] = (x402ToolExecutionCounts[event.toolName] ?? 0) + 1;
    }
  }
  const catalogPriceByTool: Record<string, number> = {};
  for (const name of Object.keys(prices)) catalogPriceByTool[name] = opts.billingService.getToolPrice(name as CapabilityName);
  const anomalies = buildReconciliation({ settlements, x402ToolExecutionCounts, catalogPriceByTool });
  const paidCalls = Object.values(x402ToolExecutionCounts).reduce((a, b) => a + b, 0);

  const systemStatus = await gatherSystemStatus({
    config: opts.config, analyticsRepository: opts.analyticsRepository, revenueLedger: opts.revenueLedger,
    period, periodEvents: events, periodSettlements: settlements
  });

  return {
    period, generatedAt: now.toISOString(), revenue, paidCalls, revenueTrend, revenueByTool, x402Funnel, usage,
    transactions, reconciliation: { anomalyCount: anomalies.length, anomalies }, systemStatus
  };
}
