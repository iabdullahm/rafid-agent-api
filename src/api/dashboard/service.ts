import type { Config } from "../../config/env.js";
import type { AnalyticsEvent, AnalyticsRepository } from "../../analytics/types.js";
import {
  WINDOW_MS, percentile,
  summarizeAllTime, summarizeDiscoveryAllTime, summarizeToolsAllTime, summarizeX402AllTime,
  type ToolsWindow, type X402Window
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
import type { BillingEngine } from "../../billing/unified/engine.js";
import type { LedgerEntry } from "../../billing/unified/types.js";
import { railAvailability } from "../../billing/unified/discovery.js";
import {
  summarizeUnifiedBillingRevenue, summarizeUnifiedBillingRevenueByTool,
  type UnifiedBillingToolRow
} from "../../billing/unified/reporting.js";
import type { ExternalPaymentsService } from "../../billing/external/service.js";
import type { ExternalPayment } from "../../billing/external/types.js";
import { buildCallAuditRecords } from "../../audit/build.js";
import {
  buildToolAudit, buildCommercialFunnel, buildAuditReconciliation, diagnoseToolRow, recommendationFor,
  type ToolAuditRow, type CommercialFunnel, type AuditAnomaly
} from "../../audit/aggregate.js";
import type { CallAuditRecord, FinalStatus, ReasonCode } from "../../audit/types.js";
import { buildPaymentJourneyFunnel, buildPaymentJourneyRows, type PaymentJourneyFunnel, type PaymentJourneyRow } from "../../analytics/paymentJourneyReporting.js";

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
  /** Payment methods overview (spec section 10 addition) — which OTHER payment rails are live in
   *  this deployment, alongside x402/MCP above. Computed via billing/unified/discovery.ts's
   *  railAvailability() (the exact same function GET /api/v1/payment-methods and the payment
   *  dispatcher already use to decide rail availability), never a second enabled/disabled check
   *  re-derived here. */
  l402: "Enabled" | "Disabled";
  mpp: "Enabled" | "Disabled";
  apiCredits: "Enabled" | "Disabled";
  subscriptions: "Enabled" | "Disabled";
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

  const rails = railAvailability(config);
  return {
    mcp: config.mcpRemoteEnabled ? "Enabled" : "Disabled",
    x402: config.x402Enabled ? "Enabled" : "Disabled",
    l402: rails.l402 ? "Enabled" : "Disabled",
    mpp: config.mpp?.enabled ? "Enabled" : "Disabled",
    apiCredits: rails.apiCredits ? "Enabled" : "Disabled",
    subscriptions: rails.subscription ? "Enabled" : "Disabled",
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

export interface RevenueAttributionRow {
  source: string;
  campaign: string;
  clientType: string;
  capability: string;
  settledCalls: number;
  revenueByCurrency: Record<string, number>;
}

function buildRevenueByAttribution(settlements: readonly RevenueSettlement[], events: readonly AnalyticsEvent[]): RevenueAttributionRow[] {
  const eventByRequest = new Map<string, AnalyticsEvent>();
  for (const event of events) {
    if (event.category === "x402" && event.eventType === "settlement_success" && event.requestId && event.trafficClass !== "internal_test") eventByRequest.set(event.requestId, event);
  }
  const grouped = new Map<string, RevenueAttributionRow>();
  for (const settlement of settlements) {
    const event = eventByRequest.get(settlement.requestId);
    if (!event) continue;
    const row: RevenueAttributionRow = {
      source: event.source ?? "unknown", campaign: event.campaign ?? "unknown", clientType: event.clientType ?? "unknown",
      capability: settlement.capabilityName, settledCalls: 0, revenueByCurrency: {}
    };
    const key = [row.source, row.campaign, row.clientType, row.capability].join("\u001f");
    const existing = grouped.get(key) ?? row;
    existing.settledCalls++;
    if (settlement.amountDecimal !== null && settlement.currency) existing.revenueByCurrency[settlement.currency] = round((existing.revenueByCurrency[settlement.currency] ?? 0) + settlement.amountDecimal, 4);
    grouped.set(key, existing);
  }
  return [...grouped.values()].sort((a, b) => b.settledCalls - a.settledCalls || a.source.localeCompare(b.source));
}

/**
 * "Top Tools / Conversion by Tool" (dashboard section added 2026-09-23) — which capabilities
 * attract usage vs. which actually convert into paid revenue. Reuses three already-fetched,
 * already-window-scoped sources, in-process, with NO new analytics system and NO new revenue
 * table: `toolsWindow.byTool` (analytics `category: "tool"` invocation events — never
 * tools/list, initialize, or discovery hits, which live under `category: "mcp"`/`"discovery"`
 * and are excluded by construction), `x402Window.byTool` (analytics `category: "x402"` funnel
 * events) plus a small per-tool `payment_verified` count computed the same way
 * buildDashboardData() already computes `x402ToolExecutionCounts` below, and `toolRevenue`
 * (summarizeRevenueByTool() over the REVENUE LEDGER — the settlement source of truth, exactly
 * the same object `revenueByTool` above is already built from).
 *
 * Conversion rate is deliberately `settledCalls` (from the revenue ledger) divided by
 * `challenges` (from analytics) — never analytics' own `settlement_success` event count, so this
 * number never drifts from what the Reconciliation section would also catch. `null` (rendered as
 * "—" in the UI), never a fabricated 0%, when there were zero 402 challenges to convert from.
 */
export type ToolConversionSortKey = "revenue" | "settled" | "calls" | "conversion";
export const TOOL_CONVERSION_SORT_KEYS: readonly ToolConversionSortKey[] = ["revenue", "settled", "calls", "conversion"];

/** Pure, exported, and directly unit-tested (page.ts's client-side sort control reimplements this
 *  same ordering inline, since the browser script is a dependency-free string template with no
 *  import mechanism — the two must stay in sync; keep them identical when changing either). All
 *  four sort keys are descending-only ("simple sorting controls" per the spec, not a toggleable
 *  asc/desc system), and every key falls back to the revenue-descending tie-break so ties resolve
 *  the same way regardless of which column is sorted. */
export function sortToolConversionRows(rows: readonly ToolConversionRow[], key: ToolConversionSortKey): ToolConversionRow[] {
  const byRevenue = (a: ToolConversionRow, b: ToolConversionRow) =>
    (b.revenue ?? -1) - (a.revenue ?? -1) || b.settledCalls - a.settledCalls;
  const sorted = [...rows];
  if (key === "settled") sorted.sort((a, b) => b.settledCalls - a.settledCalls || byRevenue(a, b));
  else if (key === "calls") sorted.sort((a, b) => b.calls - a.calls || byRevenue(a, b));
  else if (key === "conversion") sorted.sort((a, b) => (b.conversionPct ?? -1) - (a.conversionPct ?? -1) || byRevenue(a, b));
  else sorted.sort(byRevenue);
  return sorted;
}

export interface ToolConversionRow {
  toolName: string;
  calls: number;
  successCount: number;
  failureCount: number;
  challenges: number;
  paymentVerified: number;
  settledCalls: number;
  /** null when challenges === 0 — there was no opportunity to convert, never displayed as 0%. */
  conversionPct: number | null;
  revenueByCurrency: Record<string, number>;
  /** Single-currency convenience, null when zero settled or when settled rows span more than one
   *  currency for this tool — same rule as RevenueToolStats.revenue; read revenueByCurrency for
   *  the authoritative, never-combined breakdown. */
  revenue: number | null;
  currency: string | null;
  averageRevenuePerSettledCall: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
}

// -----------------------------------------------------------------------------------------------
// All Capabilities Overview (dashboard section added 2026-09-23) — every registered capability,
// including ones with zero activity. Unlike toolConversion above (which only lists a tool with
// some real signal this period), this section's entire purpose is complete visibility: it starts
// from the capability REGISTRY (domain/capabilities.ts — the same canonical list revenueByTool
// already unions in) in its own declared order, never from analytics/revenue keys, so a
// capability with calls = 0 / challenges = 0 / settled = 0 still gets a row, and a capability
// newly added to the registry appears automatically with no code change here. No new analytics
// system and no new query: this reuses the exact same already-fetched, already period-scoped
// `toolsWindow`, `x402Window` and `toolRevenue` buildDashboardData() already computed for
// toolConversion/revenueByTool above — merged per capability instead of filtered/unioned.
// -----------------------------------------------------------------------------------------------

export type CapabilityOverviewSortKey = "registry" | "calls" | "revenue" | "settled" | "conversion";
export const CAPABILITY_OVERVIEW_SORT_KEYS: readonly CapabilityOverviewSortKey[] = ["registry", "calls", "revenue", "settled", "conversion"];

export interface CapabilityOverviewRow {
  toolName: string;
  /** Human-readable vertical derived from the capability registry's category metadata. */
  /** Optional for callers constructing compatibility/test rows; registry-built rows always set it. */
  vertical?: string;
  /** The capability's current public price, read straight off the registry (domain/
   *  capabilities.ts) — the single source of truth billing/catalog.ts's `prices` is itself
   *  derived from — never a second literal. */
  price: number;
  priceCurrency: string;
  /** This capability's position in the registry array — what "Registry order" (the default sort)
   *  sorts by; never recomputed from anything else, so registry order is always exactly the
   *  registry's own declared order. */
  registryIndex: number;
  calls: number;
  successCount: number;
  failureCount: number;
  challenges: number;
  settledCalls: number;
  /** null when challenges === 0 — no opportunity to convert, never a fabricated 0%. 0 (a real
   *  number, not null) when challenges > 0 but settledCalls === 0 — see conversionPct below. */
  conversionPct: number | null;
  /** Per-currency breakdown of this capability's settled revenue — authoritative, never blended
   *  across currencies/assets (see revenue/aggregate.ts's revenueByCurrency()). */
  revenueByCurrency: Record<string, number>;
  /** Single-currency convenience: null when zero settled, or when settled rows for this
   *  capability span more than one currency — same rule as RevenueToolStats.revenue. Read
   *  revenueByCurrency for the always-correct, never-combined breakdown. */
  revenue: number | null;
  currency: string | null;
  averageRevenuePerSettledCall: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
}

const VERTICAL_LABELS: Record<string, string> = {
  property: "Property Intelligence",
  company: "Company Intelligence",
  supplier: "Supplier Intelligence",
  document_intelligence: "Document Intelligence",
  risk_intelligence: "Risk Intelligence",
  finance_risk: "Finance & Risk Intelligence",
  automotive: "Vehicle Intelligence",
  logistics: "Logistics Intelligence",
  recruitment: "Recruitment Intelligence",
  trading: "Trading Intelligence",
  voice: "Voice Intelligence",
  website_services: "Website Intelligence",
  video_generation: "Video Generation"
};

function capabilityVertical(capability: (typeof capabilities)[number]): string {
  return VERTICAL_LABELS[capability.category ?? ""] ?? "General Intelligence";
}

/** Builds one row per REGISTERED capability (domain/capabilities.ts's `capabilities` array),
 *  in registry order — deliberately `capabilities.map(...)`, never `Object.keys(toolsWindow.byTool)`
 *  or any other analytics-derived key set, so a capability with zero activity this period (or
 *  ever) still gets a row, and the capability list itself is never hardcoded here: adding a
 *  capability to the registry is the only change needed for it to appear. `toolsWindow`,
 *  `x402Window` and `toolRevenue` are the exact same already-fetched, already period-scoped
 *  aggregates buildDashboardData() computes once and also feeds to toolConversion/revenueByTool —
 *  this performs no additional query. */
export function buildCapabilityOverview(args: {
  toolsWindow: ToolsWindow;
  x402Window: X402Window;
  toolRevenue: Record<string, RevenueToolStats>;
}): CapabilityOverviewRow[] {
  const { toolsWindow, x402Window, toolRevenue } = args;
  return capabilities.map((capability, registryIndex): CapabilityOverviewRow => {
    const callStats = toolsWindow.byTool[capability.name];
    const x402Stats = x402Window.byTool[capability.name];
    const revStats: RevenueToolStats = toolRevenue[capability.name] ?? {
      settledCalls: 0, failedSettlements: 0, revenueByCurrency: {}, revenue: null, currency: null
    };
    const challenges = x402Stats?.challenges ?? 0;
    // Deliberately settledCalls (revenue ledger) / challenges (analytics), the exact same
    // conversion definition toolConversion uses above — never analytics' own settlement_success
    // event count, so this number can never drift from what Reconciliation would also catch.
    // challenges === 0 -> null ("—" in the UI); challenges > 0 && settledCalls === 0 -> a real 0,
    // never fabricated, never hidden.
    const conversionPct = challenges === 0 ? null : round((revStats.settledCalls / challenges) * 100, 1);
    return {
      toolName: capability.name,
      vertical: capabilityVertical(capability),
      price: capability.price,
      priceCurrency: capability.currency,
      registryIndex,
      calls: callStats?.calls ?? 0,
      successCount: callStats?.successCount ?? 0,
      failureCount: callStats?.failureCount ?? 0,
      challenges,
      settledCalls: revStats.settledCalls,
      conversionPct,
      revenueByCurrency: revStats.revenueByCurrency,
      revenue: revStats.revenue,
      currency: revStats.currency,
      averageRevenuePerSettledCall: revStats.revenue !== null && revStats.settledCalls > 0
        ? round(revStats.revenue / revStats.settledCalls, 4) : null,
      p50LatencyMs: callStats?.p50LatencyMs ?? null,
      p95LatencyMs: callStats?.p95LatencyMs ?? null
    };
  });
}

/** Pure, exported, directly unit-tested — same "descending-only, revenue-descending tie-break"
 *  discipline as sortToolConversionRows() above, plus the "registry" key this section defaults
 *  to (ascending by registryIndex — the registry's own order, not a ranking). page.ts's
 *  client-side sort control reimplements this same ordering inline (no import mechanism in a
 *  dependency-free browser script) — keep the two in sync when changing either. */
export function sortCapabilityOverviewRows(rows: readonly CapabilityOverviewRow[], key: CapabilityOverviewSortKey): CapabilityOverviewRow[] {
  const byRevenue = (a: CapabilityOverviewRow, b: CapabilityOverviewRow) =>
    (b.revenue ?? -1) - (a.revenue ?? -1) || b.settledCalls - a.settledCalls;
  const sorted = [...rows];
  if (key === "registry") sorted.sort((a, b) => a.registryIndex - b.registryIndex);
  else if (key === "calls") sorted.sort((a, b) => b.calls - a.calls || byRevenue(a, b));
  else if (key === "settled") sorted.sort((a, b) => b.settledCalls - a.settledCalls || byRevenue(a, b));
  else if (key === "conversion") sorted.sort((a, b) => (b.conversionPct ?? -1) - (a.conversionPct ?? -1) || byRevenue(a, b));
  else sorted.sort(byRevenue);
  return sorted;
}

export interface X402FunnelReport {
  challenges: number;
  paymentVerified: number;
  settlementSucceeded: number;
  settlementFailed: number;
  challengeQuality?: X402Window["challengeQuality"];
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

// -----------------------------------------------------------------------------------------------
// Revenue Conversion Audit (spec: "explains, for every capability/tool call, why it did or did
// not convert into paid revenue" — src/audit/). Augments this dashboard; never replaces any
// section above (Revenue, Revenue Overview, Collection & Funding, All Capabilities Overview,
// Top Tools/Conversion by Tool, Active Agents, Reconciliation all stay exactly as they were).
// -----------------------------------------------------------------------------------------------

export interface RevenueConversionAuditSection {
  funnel: CommercialFunnel;
  toolAudit: ToolAuditRow[];
  /** reasonCode -> how many calls carried it, across every non-converted/non-free-success call —
   *  the dashboard's "top conversion blockers" list (spec section 11). Excludes the two reason
   *  codes that mean "this call was never expected to convert" (payment_not_required,
   *  execution_succeeded_free_path) so a busy free-tier tool never crowds out real blockers. */
  topBlockers: { reasonCode: ReasonCode; count: number }[];
  /** Latest 20 non-converted calls (spec section 13) — finalStatus !== "converted" and !==
   *  "free_success" (a free call was never expected to convert, so it isn't a "blocker" row). */
  recentNonConverted: CallAuditRecord[];
  /** Latest 20 converted calls — the positive counterpart, for a quick sanity check that revenue
   *  IS flowing when it should be. */
  recentConverted: CallAuditRecord[];
  anomalies: AuditAnomaly[];
  diagnoses: string[];
  recommendations: { reasonCode: ReasonCode; recommendation: string }[];
  totalCalls: number;
}

const RECENT_AUDIT_ROWS = 20;
const NON_CONVERTING_STATUSES: readonly FinalStatus[] = [
  "not_converted", "failed_before_payment", "payment_failed", "settlement_failed", "reconciliation_issue", "unknown"
];

/** Builds the whole Revenue Conversion Audit dashboard section from CallAuditRecords already
 *  reconstructed by buildCallAuditRecords() over this SAME period's already-fetched `events`,
 *  `settlements`, and unified-billing `ledgerEntries` — no new query beyond the one additional
 *  listLedgerEntries() call buildDashboardData() below makes (settled-only listSettledCharges()
 *  doesn't carry the pending/refunded rows the audit needs to reconstruct a release). */
export function buildRevenueConversionAuditSection(records: readonly CallAuditRecord[], catalogPriceByTool: Record<string, number>): RevenueConversionAuditSection {
  const funnel = buildCommercialFunnel(records);
  const toolAudit = buildToolAudit(records);
  const anomalies = buildAuditReconciliation(records, catalogPriceByTool);
  const diagnoses = toolAudit.map(diagnoseToolRow);

  const blockerCounts = new Map<ReasonCode, number>();
  for (const r of records) {
    if (r.reasonCode === "payment_not_required" || r.reasonCode === "execution_succeeded_free_path") continue;
    if (r.finalStatus === "converted" || r.finalStatus === "free_success") continue;
    blockerCounts.set(r.reasonCode, (blockerCounts.get(r.reasonCode) ?? 0) + 1);
  }
  const topBlockers = [...blockerCounts.entries()]
    .map(([reasonCode, count]) => ({ reasonCode, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const seenReasons = new Set<ReasonCode>();
  const recommendations: { reasonCode: ReasonCode; recommendation: string }[] = [];
  for (const b of topBlockers) {
    const rec = recommendationFor(b.reasonCode);
    if (rec && !seenReasons.has(b.reasonCode)) { recommendations.push({ reasonCode: b.reasonCode, recommendation: rec }); seenReasons.add(b.reasonCode); }
  }

  const sorted = [...records].sort((a, b) => b.calledAt.localeCompare(a.calledAt));
  return {
    funnel, toolAudit, topBlockers,
    recentNonConverted: sorted.filter(r => NON_CONVERTING_STATUSES.includes(r.finalStatus)).slice(0, RECENT_AUDIT_ROWS),
    recentConverted: sorted.filter(r => r.finalStatus === "converted").slice(0, RECENT_AUDIT_ROWS),
    anomalies, diagnoses, recommendations, totalCalls: records.length
  };
}

// -----------------------------------------------------------------------------------------------
// AI Agent Operations Command Center (dashboard redesign added 2026-09-23) — three new,
// PRESENTATION-ONLY derived views, computed entirely from data already fetched above (`events`,
// `toolsWindow`, `x402Funnel`, reconciliation's anomaly count). No new analytics system, no new
// revenue table, no new query, no new HTTP route: every field below is either copied straight off
// an existing aggregate or a small, transparent, exported pure function over it — see each
// function's own doc comment for exactly which real fields back it. Nothing here is simulated;
// "waiting" / zero states are honest zero states, never a fabricated placeholder number.
// -----------------------------------------------------------------------------------------------

export type AgentStatusLevel = "active" | "processing" | "waiting" | "error";

/** One of the operational groupings the dashboard's "Active Agents" panel shows. Six ("research",
 *  "property", "supplier", "risk", "document", "valuation") are a fixed, non-overlapping partition of every
 *  tool-executing capability in the registry (domain/capabilities.ts) — chosen so every capability
 *  belongs to exactly one group and no group is empty in a mature deployment; the remaining two
 *  ("payment", "reconciliation") are cross-cutting and have no tools of their own. When a new
 *  capability is added to the registry, add its name to the best-fit group's toolNames below (or a
 *  new group, if none fits) — buildAgentStatuses() falls through to the generic tool-group branch
 *  for any id other than "payment"/"reconciliation", so no other code change is required. */
export type AgentGroupId = "research" | "property" | "supplier" | "risk" | "document" | "valuation" | "logistics" | "trading" | "recruitment" | "voice" | "business" | "website" | "video" | "payment" | "reconciliation";

export interface AgentGroupDef {
  id: AgentGroupId;
  name: string;
  /** Capability names this group owns (empty for the two cross-cutting groups, "payment" and
   *  "reconciliation", whose status comes from the x402 funnel / reconciliation anomalies instead
   *  of per-tool analytics — see buildAgentStatuses()). */
  toolNames: readonly string[];
}

export const AGENT_GROUPS: readonly AgentGroupDef[] = [
  { id: "research", name: "Research Agent", toolNames: ["research_company", "find_companies"] },
  { id: "property", name: "Property Agent", toolNames: ["analyze_property", "compare_properties", "estimate_maintenance", "analyze_oman_property", "property_investment_report", "portfolio_screen"] },
  { id: "supplier", name: "Supplier Intelligence Agent", toolNames: ["search_oman_company", "get_oman_company_profile", "analyze_oman_company", "due_diligence_oman_company", "oman_supplier_check", "supplier_due_diligence_report", "procurement_vendor_shortlist"] },
  { id: "risk", name: "Risk Agent", toolNames: ["analyze_company_risk", "company_reputation_check", "business_risk_score", "company_due_diligence", "company_risk_report", "company_risk_batch", "invoice_anomaly_check"] },
  { id: "document", name: "Document Intelligence Agent", toolNames: ["document_facts_extract"] },
  { id: "valuation", name: "Vehicle Valuation Agent", toolNames: ["vehicle_value_estimate"] },
  { id: "logistics", name: "Logistics Agent", toolNames: ["shipping_cost_estimate"] },
  { id: "trading", name: "Trading Analysis Agent", toolNames: ["strategy_performance_analysis", "trade_risk_score", "portfolio_exposure_check", "trade_log_analysis"] },
  { id: "recruitment", name: "Recruitment Intelligence Agent", toolNames: ["extract_candidate_profile", "generate_job_profile", "cv_score", "cv_job_match", "cv_improve", "candidate_shortlist_score"] },
  { id: "voice", name: "Voice Operations Agent", toolNames: ["ai_call_agent", "voice_lead_qualifier", "appointment_call_agent"] },
  { id: "business", name: "Business Planning Agent", toolNames: ["startup_readiness_score", "business_idea_validate", "business_idea_generator", "business_validation_plan", "ideal_customer_profile", "competitor_analysis", "business_model_builder", "startup_cost_estimate", "product_pricing_calculator", "break_even_calculator", "business_profitability_analysis", "offer_builder", "oman_go_to_market_plan", "content_plan_generator", "first_10_customers_plan", "sales_response_builder", "whatsapp_business_setup", "monthly_business_financial_report", "oman_business_launch_plan", "business_90_day_growth_plan", "business_risk_check", "final_business_plan_builder", "oman_business_launch_advisor", "oman_business_plan_generator", "oman_small_business_guide"] },
  { id: "website", name: "Website Operations Agent", toolNames: ["website_project_estimate", "website_audit", "website_download"] },
  { id: "video", name: "Video Generation Agent", toolNames: ["social_video_generate", "news_video_generate", "product_promo_video"] },
  { id: "payment", name: "Payment / Settlement Agent", toolNames: [] },
  { id: "reconciliation", name: "Reconciliation Agent", toolNames: [] }
];

/** A tool-group agent is "processing" (mid-burst of real activity) when its most recent event in
 *  this period landed within this window of `now` — never a claim of a literally-still-executing
 *  request (the analytics log only ever records completed calls; see analytics/types.ts). */
const AGENT_RECENT_ACTIVITY_MS = 2 * 60 * 1000;
/** Below this per-group success rate (and only once the group has a meaningful sample), the
 *  group's card surfaces as "error" rather than "active" — an honest signal, not a guess. */
const AGENT_ERROR_SUCCESS_RATE_PCT = 80;

export interface AgentStatusRow {
  id: AgentGroupId;
  name: string;
  status: AgentStatusLevel;
  statusLabel: string;
  currentTask: string;
  metricLabel: string;
  toolNames: readonly string[];
  calls: number;
  lastEventAt: string | null;
  /** Revenue Conversion Audit additions (spec section 15) — summed from src/audit/'s
   *  ToolAuditRow across this group's own toolNames, so a tool-group card can show HOW MANY of
   *  its calls actually became revenue and why the rest didn't, not just raw call/success counts.
   *  Undefined (never a fabricated zero) for the two cross-cutting agents ("payment"/
   *  "reconciliation", which have no toolNames of their own) and whenever the audit section
   *  itself wasn't computed for this render. */
  paidConversions?: number;
  revenueUsd?: number | null;
  topFailureReason?: string | null;
}

function fmtPctForStatus(n: number | null): string {
  return n === null ? "—" : `${n}%`;
}

/** Builds the six Active-Agents cards from data already computed in buildDashboardData() — never
 *  a second query. Tool-group agents (research/property/supplier/risk) are summed from
 *  `toolsWindow.byTool` (analytics `category: "tool"` events, already period-scoped) plus a scan
 *  of the already-fetched `events` array for that group's most recent event and any
 *  `dataSource === "not_configured"` signal (a real, already-tracked provider-misconfiguration
 *  marker — see analytics/types.ts's DataSource doc comment). The two cross-cutting agents read
 *  the already-computed x402 funnel and reconciliation anomaly count instead of per-tool stats. */
export function buildAgentStatuses(args: {
  events: readonly AnalyticsEvent[];
  toolsWindow: ToolsWindow;
  x402Funnel: X402FunnelReport;
  settledPayments: number;
  anomalyCount: number;
  now: Date;
  /** Revenue Conversion Audit's per-tool rows (see RevenueConversionAuditSection) — optional so
   *  every pre-existing call site/test keeps compiling and rendering unchanged when omitted (the
   *  three new fields on AgentStatusRow are then simply absent, never a fabricated zero). */
  toolAudit?: readonly ToolAuditRow[];
}): AgentStatusRow[] {
  const { events, toolsWindow, x402Funnel, settledPayments, anomalyCount, now, toolAudit } = args;

  const rows: AgentStatusRow[] = AGENT_GROUPS.map(group => {
    if (group.id === "payment") {
      const toolEvents = events.filter(e => e.category === "x402");
      const lastEvent = toolEvents.reduce<AnalyticsEvent | null>((latest, e) =>
        !latest || e.createdAt > latest.createdAt ? e : latest, null);
      const recentMs = lastEvent ? now.getTime() - new Date(lastEvent.createdAt).getTime() : null;
      let status: AgentStatusLevel; let statusLabel: string; let currentTask: string;
      if (x402Funnel.challenges === 0) {
        status = "waiting"; statusLabel = "Waiting"; currentTask = "No payment activity in this period";
      } else if (x402Funnel.settlementFailed > 0 && x402Funnel.settlementSucceeded === 0) {
        status = "error"; statusLabel = "Settlements failing"; currentTask = `${x402Funnel.settlementFailed} failed settlement(s), 0 succeeded`;
      } else if (recentMs !== null && recentMs < AGENT_RECENT_ACTIVITY_MS) {
        status = "processing"; statusLabel = "Processing"; currentTask = "Verifying a payment / settling a call";
      } else {
        status = "active"; statusLabel = "Active"; currentTask = `${settledPayments} settled this period`;
      }
      return {
        id: group.id, name: group.name, status, statusLabel, currentTask,
        metricLabel: `${x402Funnel.challenges} challenge(s) · ${x402Funnel.settlementSucceeded} settled`,
        toolNames: group.toolNames, calls: x402Funnel.challenges, lastEventAt: lastEvent?.createdAt ?? null
      };
    }
    if (group.id === "reconciliation") {
      const status: AgentStatusLevel = anomalyCount === 0 ? "active" : "error";
      return {
        id: group.id, name: group.name, status,
        statusLabel: anomalyCount === 0 ? "All clear" : "Anomalies found",
        currentTask: anomalyCount === 0 ? "Settlements and tool executions agree" : `${anomalyCount} anomaly(ies) need review`,
        metricLabel: `${anomalyCount} anomaly(ies) this period`,
        toolNames: group.toolNames, calls: 0, lastEventAt: null
      };
    }

    // Tool-group agents: research / property / supplier / risk.
    const groupToolEvents = events.filter(e => e.category === "tool" && e.toolName && (group.toolNames as readonly string[]).includes(e.toolName));
    const calls = group.toolNames.reduce((sum, name) => sum + (toolsWindow.byTool[name]?.calls ?? 0), 0);
    const successCount = group.toolNames.reduce((sum, name) => sum + (toolsWindow.byTool[name]?.successCount ?? 0), 0);
    const failureCount = group.toolNames.reduce((sum, name) => sum + (toolsWindow.byTool[name]?.failureCount ?? 0), 0);
    const successRatePct = calls === 0 ? null : round((successCount / calls) * 100, 1);
    const lastEvent = groupToolEvents.reduce<AnalyticsEvent | null>((latest, e) =>
      !latest || e.createdAt > latest.createdAt ? e : latest, null);
    const recentMs = lastEvent ? now.getTime() - new Date(lastEvent.createdAt).getTime() : null;
    const recentNotConfigured = groupToolEvents
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 5)
      .some(e => e.dataSource === "not_configured");

    let status: AgentStatusLevel; let statusLabel: string; let currentTask: string;
    if (recentNotConfigured) {
      status = "error"; statusLabel = "Not configured"; currentTask = "A required provider is not configured — see .env.example";
    } else if (calls === 0) {
      status = "waiting"; statusLabel = "Waiting"; currentTask = "No calls in this period";
    } else if (recentMs !== null && recentMs < AGENT_RECENT_ACTIVITY_MS) {
      status = "processing"; statusLabel = "Processing";
      currentTask = `Running ${lastEvent!.toolName}${lastEvent!.success === false ? " (last call failed)" : "..."}`;
    } else if (successRatePct !== null && successRatePct < AGENT_ERROR_SUCCESS_RATE_PCT) {
      status = "error"; statusLabel = "Elevated failures"; currentTask = `${failureCount} of ${calls} calls failed this period`;
    } else {
      status = "active"; statusLabel = "Active"; currentTask = `${calls} call(s) this period · ${fmtPctForStatus(successRatePct)} success`;
    }
    // Revenue Conversion Audit rollup for this group (spec section 15) — summed across the
    // group's own toolNames from the already-computed toolAudit rows; undefined (not zero) when
    // toolAudit wasn't passed at all.
    let paidConversions: number | undefined; let revenueUsd: number | null | undefined; let topFailureReasonForGroup: string | null | undefined;
    if (toolAudit) {
      const groupRows = toolAudit.filter(r => (group.toolNames as readonly string[]).includes(r.toolName));
      paidConversions = groupRows.reduce((sum, r) => sum + r.settled, 0);
      const revenueByCurrency: Record<string, number> = {};
      for (const r of groupRows) for (const [cur, amt] of Object.entries(r.revenueByCurrency)) revenueByCurrency[cur] = round((revenueByCurrency[cur] ?? 0) + amt, 6);
      const currencies = Object.keys(revenueByCurrency);
      revenueUsd = currencies.length === 1 && currencies[0] === "USD" ? revenueByCurrency.USD! : (currencies.length === 0 ? 0 : null);
      const reasonCounts = new Map<string, number>();
      for (const r of groupRows) {
        if (!r.topFailureReason) continue;
        const failingCalls = (r.dropOffBreakdown as Record<string, number>);
        const failingCount = Object.entries(failingCalls).filter(([status]) => status !== "converted" && status !== "free_success").reduce((s, [, n]) => s + n, 0);
        if (failingCount > 0) reasonCounts.set(r.topFailureReason, (reasonCounts.get(r.topFailureReason) ?? 0) + failingCount);
      }
      let best: string | null = null; let bestCount = 0;
      for (const [reason, count] of reasonCounts) if (count > bestCount) { best = reason; bestCount = count; }
      topFailureReasonForGroup = best;
    }
    return {
      id: group.id, name: group.name, status, statusLabel, currentTask,
      metricLabel: `${calls} call(s) · ${fmtPctForStatus(successRatePct)} success`,
      toolNames: group.toolNames, calls, lastEventAt: lastEvent?.createdAt ?? null,
      paidConversions, revenueUsd, topFailureReason: topFailureReasonForGroup
    };
  });

  return rows;
}

// -----------------------------------------------------------------------------------------------
// Live Agent Activity feed — a plain, human-readable rendering of the same safe fields the rest of
// this file already exposes (category, eventType, toolName, success, durationMs, path, createdAt —
// see analytics/types.ts's own field-by-field privacy doc comment; never a client hash, user
// agent, or referer). No new query: reuses the already period-scoped `events` array.
// -----------------------------------------------------------------------------------------------

export interface ActivityFeedItem {
  at: string;
  kind: AnalyticsEvent["category"];
  toolName: string | null;
  success: boolean | null;
  label: string;
}

export const MAX_ACTIVITY_FEED_ITEMS = 50;

function describeActivityEvent(e: AnalyticsEvent): string {
  if (e.category === "discovery") return `Discovery hit${e.path ? ` on ${e.path}` : ""}`;
  if (e.category === "mcp") {
    if (e.eventType === "initialize") return "MCP session initialized";
    if (e.eventType === "tools_list") return "MCP client listed available tools";
    return `MCP tool call${e.toolName ? `: ${e.toolName}` : ""}`;
  }
  if (e.category === "x402") {
    if (e.eventType === "challenge" || e.eventType === "payment_challenge") return `402 payment challenge issued${e.toolName ? ` for ${e.toolName}` : ""}`;
    if (e.eventType === "payment_verified") return `Payment verified${e.toolName ? ` for ${e.toolName}` : ""}`;
    if (e.eventType === "payment_failed") return `Payment verification failed${e.toolName ? ` for ${e.toolName}` : ""}`;
    if (e.eventType === "settlement_success") return `Settlement succeeded${e.toolName ? ` for ${e.toolName}` : ""}`;
    return `Settlement failed${e.toolName ? ` for ${e.toolName}` : ""}`;
  }
  if (e.category === "preview") {
    const tool = e.toolName ? ` for ${e.toolName}` : "";
    if (e.eventType === "preview_requested") return `Free preview requested${tool}`;
    if (e.eventType === "preview_available") return `Free preview available${tool}`;
    if (e.eventType === "preview_limited") return `Free preview limited${tool}`;
    if (e.eventType === "preview_unavailable") return `Free preview unavailable${tool}`;
    if (e.eventType === "preview_invalid") return `Free preview rejected invalid input${tool}`;
    if (e.eventType === "preview_rate_limited") return `Free preview rate-limited${tool}`;
    if (e.eventType === "preview_cache_hit") return `Free preview served from cache${tool}`;
    if (e.eventType === "preview_cache_miss") return `Free preview cache miss${tool}`;
    if (e.eventType === "paid_capability_started") return `Paid call started${tool}${e.previewSeen ? " (preview seen)" : ""}`;
    return `Preview converted to paid call${tool}`; // preview_converted
  }
  // "tool"
  const durationLabel = typeof e.durationMs === "number" ? ` (${Math.round(e.durationMs)}ms)` : "";
  return `${e.toolName ?? "unknown tool"} call ${e.success === false ? "failed" : "completed"}${durationLabel}`;
}

/** Newest-first, capped at MAX_ACTIVITY_FEED_ITEMS — every row is a real, already-recorded
 *  analytics event; there is no synthetic/demo row on the server side under any circumstance (the
 *  dashboard's client-side "demo mode", when a viewer opts into it with ?demo=1, only ever adds
 *  clearly-labeled illustrative rows in the browser — see page.ts — never from this function). */
export function buildActivityFeed(events: readonly AnalyticsEvent[]): ActivityFeedItem[] {
  return [...events]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, MAX_ACTIVITY_FEED_ITEMS)
    .map(e => ({ at: e.createdAt, kind: e.category, toolName: e.toolName, success: e.success, label: describeActivityEvent(e) }));
}

// -----------------------------------------------------------------------------------------------
// System health score — a transparent, documented formula over already-computed SystemStatusReport
// fields plus the reconciliation anomaly count. Only counts a check that was ACTUALLY measured this
// request (an "Unknown" signal — e.g. a query that itself failed — is excluded from the
// denominator, never scored as unhealthy or silently as healthy); 100% is only ever possible when
// every measured signal is healthy, per the spec's explicit requirement.
// -----------------------------------------------------------------------------------------------

export interface SystemHealthReport {
  scorePct: number;
  measuredCount: number;
  healthyCount: number;
  checks: { label: string; measured: boolean; healthy: boolean }[];
}

export function buildSystemHealthScore(status: SystemStatusReport, anomalyCount: number): SystemHealthReport {
  const checks = [
    { label: "Analytics", measured: status.analytics !== "Unknown", healthy: status.analytics === "Active" },
    { label: "Revenue Ledger", measured: status.revenueLedger !== "Unknown", healthy: status.revenueLedger === "Active" },
    { label: "Database", measured: status.database !== "Unknown", healthy: status.database.startsWith("Connected") },
    { label: "Reconciliation", measured: true, healthy: anomalyCount === 0 }
  ];
  const measured = checks.filter(c => c.measured);
  const healthyCount = measured.filter(c => c.healthy).length;
  const scorePct = measured.length === 0 ? 0 : Math.round((healthyCount / measured.length) * 100);
  return { scorePct, measuredCount: measured.length, healthyCount, checks };
}

// -----------------------------------------------------------------------------------------------
// Count sparklines (spec sections 7, 12) — a small, fixed number of buckets showing recent trend
// shape, not exact analytics. Reuses the exact bucket boundaries buildRevenueTrend() already uses
// per period (hourly/daily/monthly) so a KPI's sparkline lines up with the Revenue Trend chart's
// own buckets; counts real matching events only, never interpolated or smoothed.
// -----------------------------------------------------------------------------------------------

export function buildCountSparkline(events: readonly AnalyticsEvent[], period: RevenuePeriod, now: Date, matches: (e: AnalyticsEvent) => boolean): number[] {
  const matching = events.filter(matches);
  const boundaries = bucketBoundaries(period, now);
  return boundaries.map(([start, end]) => matching.filter(e => {
    const t = new Date(e.createdAt).getTime();
    return t >= start.getTime() && t < end.getTime();
  }).length);
}

function bucketBoundaries(period: RevenuePeriod, now: Date): [Date, Date][] {
  if (period === "24h") {
    const nowHour = new Date(now); nowHour.setUTCMinutes(0, 0, 0);
    return Array.from({ length: 24 }, (_, idx) => {
      const i = 23 - idx;
      const start = new Date(nowHour.getTime() - i * 3_600_000);
      return [start, new Date(start.getTime() + 3_600_000)] as [Date, Date];
    });
  }
  const days = period === "7d" ? 7 : period === "30d" ? 30 : 30;
  const nowDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return Array.from({ length: days }, (_, idx) => {
    const i = days - 1 - idx;
    const start = new Date(nowDay.getTime() - i * 86_400_000);
    return [start, new Date(start.getTime() + 86_400_000)] as [Date, Date];
  });
}

/** Settlement-count sparkline — deliberately a COUNT of settled rows per bucket, never a summed
 *  currency amount, so it can never violate the never-combine-currencies rule while still giving
 *  the Gross Revenue KPI card a meaningful trend shape (see buildCountSparkline() above for the
 *  identical bucketing logic applied to analytics events). */
export function buildSettlementCountSparkline(settlements: readonly RevenueSettlement[], period: RevenuePeriod, now: Date): number[] {
  const succeeded = settlements.filter(r => r.status === "settlement_succeeded");
  const boundaries = bucketBoundaries(period, now);
  return boundaries.map(([start, end]) => succeeded.filter(r => {
    const t = new Date(r.createdAt).getTime();
    return t >= start.getTime() && t < end.getTime();
  }).length);
}

// -----------------------------------------------------------------------------------------------
// Free Preview funnel (dashboard section added 2026-09-24) — preview traffic and preview->paid
// conversion, read straight off the "preview" analytics category (analytics/types.ts's
// PreviewEventType, written by preview/analytics.ts's recordPreviewEvent()) that already flows
// into `events` above — no new query, no new aggregation source, same discipline as every other
// section in this file: real counts only, "—"/null rather than a fabricated 0% when there was no
// opportunity to convert.
// -----------------------------------------------------------------------------------------------

export interface PreviewFunnelReport {
  requested: number;
  available: number;
  limited: number;
  unavailable: number;
  invalid: number;
  rateLimited: number;
  cacheHits: number;
  cacheMisses: number;
  /** cacheHits / (cacheHits + cacheMisses) — null when neither was recorded this period. */
  cacheHitRatePct: number | null;
  paidCapabilityStarted: number;
  /** A paid call whose request fingerprint matched a qualifying preview within the conversion
   *  window (see preview/analytics.ts's PreviewConversionIndex) — the funnel's business metric. */
  converted: number;
  /** converted / requested — "out of every free preview served, how many led to a paid call" —
   *  null when there were zero preview requests to convert from. */
  conversionRatePct: number | null;
}

function buildPreviewFunnel(events: readonly AnalyticsEvent[]): PreviewFunnelReport {
  const previewEvents = events.filter(e => e.category === "preview" && e.trafficClass !== "internal_test");
  const count = (t: AnalyticsEvent["eventType"]) => previewEvents.filter(e => e.eventType === t).length;
  const requested = count("preview_requested");
  const cacheHits = count("preview_cache_hit");
  const cacheMisses = count("preview_cache_miss");
  const converted = count("preview_converted");
  return {
    requested,
    available: count("preview_available"),
    limited: count("preview_limited"),
    unavailable: count("preview_unavailable"),
    invalid: count("preview_invalid"),
    rateLimited: count("preview_rate_limited"),
    cacheHits,
    cacheMisses,
    cacheHitRatePct: conversionPct(cacheHits, cacheHits + cacheMisses),
    paidCapabilityStarted: count("paid_capability_started"),
    converted,
    conversionRatePct: conversionPct(converted, requested)
  };
}

// -----------------------------------------------------------------------------------------------
// Unified billing revenue (dashboard section added 2026-09-24) — API credits (prepaid) and
// subscription allowances (src/billing/unified/), a payment rail family entirely separate from
// the x402/L402/MPP settlement ledger `revenue` above is built from. Kept as its own summary
// rather than merged into `revenue.revenueByCurrency`: unified billing is always USD (money.ts)
// while x402 settles USDC — genuinely different assets — and revenue.currency/grossRevenueUSD/
// averageRevenuePerPaidCall are documented single-currency convenience fields over the x402
// ledger specifically, which a silent post-hoc merge could make misleading. Every number here
// comes straight from billing/unified/reporting.ts's pure aggregation over
// BillingEngine.store.listSettledCharges() — never a second accounting pass. Zeroed out (never
// fabricated) when unified billing is disabled for this deployment.
// -----------------------------------------------------------------------------------------------

export interface UnifiedBillingRevenueSummary {
  /** Whether this deployment has API credits and/or subscriptions turned on at all
   *  (billingEngine !== null) — mirrors SystemStatusReport.apiCredits/subscriptions. */
  enabled: boolean;
  totalUsd: number;
  settledCharges: number;
  byRail: { apiCredits: number; subscription: number };
  /** Sorted by revenue descending; only tools with at least one settled charge appear (the
   *  registry-driven "All Capabilities Overview" is what always lists every capability). */
  byTool: UnifiedBillingToolRow[];
}

/** Unified-billing-revenue sparkline — reuses the exact same bucketBoundaries() every other
 *  sparkline in this file buckets against (see buildSettlementCountSparkline() immediately
 *  above), summing settled charge USD per bucket rather than counting rows: unlike x402's
 *  multi-currency settlements, unified billing is always a single currency (USD), so summing a
 *  dollar amount here carries no never-blend-currencies risk. */
function buildUnifiedBillingRevenueSparkline(entries: readonly LedgerEntry[], period: RevenuePeriod, now: Date): number[] {
  const boundaries = bucketBoundaries(period, now);
  return boundaries.map(([start, end]) => {
    const startMs = start.getTime(), endMs = end.getTime();
    let sumMicros = 0;
    for (const e of entries) {
      const t = Date.parse(e.createdAt);
      if (t >= startMs && t < endMs) sumMicros += Math.abs(e.amountMicros);
    }
    return round(sumMicros / 1_000_000, 6);
  });
}

// -----------------------------------------------------------------------------------------------
// Revenue Overview (dashboard section added 2026-09-24) — a top-level "collected vs. available"
// summary spanning BOTH revenue rails this deployment can settle (x402 on-chain + unified billing
// API credits/subscriptions): Collected Revenue, Pending / Internal Billing Revenue, On-chain
// Settled Revenue, and Payout Available. Every figure here is derived purely from `revenue`
// (RevenueSummary, already computed above from the x402 ledger) and `unifiedBillingRevenue`
// (already computed above from billing/unified/reporting.ts) — no second accounting pass, no new
// query, same "reuse the existing aggregate" discipline as every other section in this file.
//
// Why "Pending" for unified billing: x402 settlement is independently confirmed by a real
// blockchain transaction (see revenue/chainVerifier.ts's on-chain receipt check) before this
// codebase ever counts it as revenue. Unified billing has no equivalent external confirmation —
// BillingEngine.addCredit()/adjustBalance() are purely internal ledger operations; this codebase
// has no payment-gateway/webhook integration behind a credit top-up anywhere (grep confirms zero
// references to any payment processor in src/billing/unified/). So unified billing revenue is
// real within this application's own books, but it has never been independently verified the way
// an on-chain settlement has — "pending" reflects that honestly rather than implying it is as
// final as a blockchain-confirmed payment.
//
// Why "Payout Available" == on-chain settled revenue: there is no payout/withdrawal ledger
// anywhere in this codebase (grep confirms zero references to "payout") — this deployment has
// never tracked money actually leaving Rafid's wallet or moving to a bank account. Rather than
// invent a payout system for this reporting task (which would mean fabricating a number with
// nothing behind it — exactly what this dashboard's own design principles forbid), this field
// reports the only revenue independently confirmed to already be sitting in a wallet Rafid
// controls: the on-chain settled total. Internal billing revenue is excluded until a real payout
// mechanism for it exists to report on.
// -----------------------------------------------------------------------------------------------

export interface RevenueOverview {
  /** revenue.revenueByCurrency, restated here so a mixed/non-USDC window is never silently hidden
   *  behind onChainSettledRevenueUsd's null — read this when that's null. */
  onChainRevenueByCurrency: Record<string, number>;
  /** Null exactly when onChainRevenueByCurrency spans more than one currency, or a currency other
   *  than USDC (this deployment's only supported x402 asset) — same convention as
   *  RevenueSummary.grossRevenueUSD, but 0 (not null) when there is simply no settled revenue yet
   *  this period, matching renderRevenueKpis()'s own existing zero-state convention. */
  onChainSettledRevenueUsd: number | null;
  /** = unifiedBillingRevenue.totalUsd — see this section's doc comment for why it's labeled
   *  "pending" rather than "settled". 0 when unified billing is disabled or has no settled
   *  charges yet (UnifiedBillingRevenueSummary is already zeroed, never fabricated, in that
   *  case). */
  pendingInternalBillingRevenueUsd: number;
  /** onChainSettledRevenueUsd + pendingInternalBillingRevenueUsd — this deployment's only two
   *  revenue rails, combined because both are USD-denominated in practice (x402 settles USDC,
   *  treated 1:1 with USD throughout this codebase — see RevenueSummary.grossRevenueUSD's own
   *  identical convention; unified billing is USD by construction, money.ts). Null exactly when
   *  onChainSettledRevenueUsd is null (see its own doc comment) — never silently combined with a
   *  guessed on-chain figure. */
  collectedRevenueUsd: number | null;
  /** See this section's doc comment for why this equals onChainSettledRevenueUsd today. Section
   *  17: this deliberately EXCLUDES externalFundingCollectedUsd below — Stripe-collected money
   *  follows Stripe's own payout/bank flow and is never in this deployment's on-chain wallet, so
   *  it must never be implied to be "available" the way a confirmed on-chain settlement is. */
  payoutAvailableUsd: number | null;
  /** = collectionFunding.stripeCollectedUsd + collectionFunding.usdcTopupsConfirmedUsd (spec
   *  section 16's "External Funding Collected") — money that reached Rafid via a top-up, this
   *  window. A LIABILITY figure (see billing/external/types.ts's accounting model), never summed
   *  with onChainSettledRevenueUsd/pendingInternalBillingRevenueUsd/collectedRevenueUsd above,
   *  which are all genuine EARNED revenue. 0 when both rails are disabled or unused this window. */
  externalFundingCollectedUsd: number;
  /** = collectionFunding.prepaidOutstandingBalanceUsd — the CURRENT (never windowed) sum of every
   *  billing account's spendable balance; spec section 16's "Outstanding Customer Credit
   *  Balance". */
  outstandingPrepaidBalanceUsd: number;
}

function buildRevenueOverview(revenue: RevenueSummary, unifiedBillingRevenue: UnifiedBillingRevenueSummary, collectionFunding: CollectionFunding): RevenueOverview {
  const currencies = Object.keys(revenue.revenueByCurrency);
  const onChainSettledRevenueUsd: number | null =
    revenue.settledPayments === 0 || currencies.length === 0 ? 0
      : currencies.length === 1 && currencies[0] === "USDC" ? revenue.revenueByCurrency["USDC"]!
        : null;
  const pendingInternalBillingRevenueUsd = unifiedBillingRevenue.totalUsd;
  const collectedRevenueUsd = onChainSettledRevenueUsd !== null
    ? round(onChainSettledRevenueUsd + pendingInternalBillingRevenueUsd, 6) : null;
  return {
    onChainRevenueByCurrency: revenue.revenueByCurrency,
    onChainSettledRevenueUsd,
    pendingInternalBillingRevenueUsd,
    collectedRevenueUsd,
    payoutAvailableUsd: onChainSettledRevenueUsd,
    externalFundingCollectedUsd: round(collectionFunding.stripeCollectedUsd + collectionFunding.usdcTopupsConfirmedUsd, 6),
    outstandingPrepaidBalanceUsd: collectionFunding.prepaidOutstandingBalanceUsd
  };
}

/** On-chain (x402) settled-revenue-in-USD sparkline — reuses the same bucketBoundaries() as every
 *  other sparkline in this file. Unlike buildSettlementCountSparkline (a row count, safe
 *  regardless of currency mix), this sums amountDecimal per bucket, so the caller only passes
 *  `safe: true` when the whole window's settled x402 rows are entirely USDC or there are none —
 *  the exact same single-currency condition buildRevenueOverview() uses for
 *  onChainSettledRevenueUsd. Returns an all-zero array of the right length when unsafe (mixed/
 *  non-USDC currencies), mirroring the KPI's own null (no amount to plot) rather than fabricating
 *  a blended trend line. */
function buildOnChainSettledRevenueSparkline(settlements: readonly RevenueSettlement[], period: RevenuePeriod, now: Date, safe: boolean): number[] {
  const boundaries = bucketBoundaries(period, now);
  if (!safe) return boundaries.map(() => 0);
  const succeeded = settlements.filter(r => r.status === "settlement_succeeded" && r.currency === "USDC" && r.amountDecimal !== null);
  return boundaries.map(([start, end]) => {
    const startMs = start.getTime(), endMs = end.getTime();
    let sum = 0;
    for (const r of succeeded) {
      const t = Date.parse(r.createdAt);
      if (t >= startMs && t < endMs) sum += r.amountDecimal!;
    }
    return round(sum, 6);
  });
}

// -----------------------------------------------------------------------------------------------
// Collection & Funding (dashboard section added 2026-09-24, spec section 16) — visibility into the
// external payment-collection layer (src/billing/external/): Stripe Checkout and USDC-on-Base
// top-ups that FUND unified billing's prepaid credits from OUTSIDE this codebase. Every figure
// here comes straight from ExternalPaymentsService.listExternalPayments() (this layer's own
// system-of-record — never a second accounting pass) plus BillingStore.
// totalOutstandingBalanceMicros() for the one figure that is a live snapshot rather than a
// windowed sum. Zeroed out (never fabricated) when externalPaymentsService is null (Stripe/USDC
// both disabled for this deployment).
//
// CRITICAL — see billing/external/types.ts's ACCOUNTING MODEL doc comment: "Stripe Collected" and
// "USDC Top-ups Confirmed" are FUNDING (money that reached Rafid but is a liability, not revenue).
// "Prepaid Outstanding Balance" is what Rafid still owes customers as usable credit. NEITHER of
// these is ever summed with revenue.grossRevenueUSD or unifiedBillingRevenue.totalUsd anywhere in
// this file — the worked example from the spec (Collected $100, Consumed $22, Outstanding $78,
// x402 Settled $4.50) is exactly what renderRevenueOverview()/renderCollectionFunding() (page.ts)
// display side by side, never combined into one number.
// -----------------------------------------------------------------------------------------------

export interface CollectionFunding {
  /** Confirmed Stripe checkouts' amount, this window — money collected via Stripe, which follows
   *  Stripe's OWN payout/bank flow (spec section 17) and is never implied to be "in the wallet". */
  stripeCollectedUsd: number;
  /** Confirmed USDC-on-Base top-ups' amount, this window — independently verified on-chain (see
   *  usdcTopup.ts's verifyUsdcTransfer()) transfers to this deployment's configured receiving
   *  wallet. Unlike Stripe, this genuinely is on-chain collected funds (section 17). */
  usdcTopupsConfirmedUsd: number;
  /** External payment rows still in flight this window (status "created" or "pending") — created
   *  but not yet independently confirmed, so NOT counted in either figure above. */
  pendingExternalPaymentsCount: number;
  /** External payment rows requiring human attention this window (status "refunded" or
   *  "requires_review" — see service.ts's handleStripeRefund() doc comment for what routes a row
   *  to "requires_review" instead of a clean reversal). */
  refundedOrReviewCount: number;
  /** = BillingStore.totalOutstandingBalanceMicros() / 1e6 — the CURRENT sum of every billing
   *  account's spendable balance, across ALL time (never windowed by `period`; a balance is a
   *  stock, not a flow — see that method's own doc comment). This is the true "money Rafid still
   *  owes its customers" figure, not a derived (funding − consumption) approximation, since a
   *  balance can also move via admin-granted credit/adjustment rows this layer never touches. */
  prepaidOutstandingBalanceUsd: number;
  byProvider: {
    stripe: { confirmedUsd: number; confirmedCount: number };
    usdcBase: { confirmedUsd: number; confirmedCount: number };
  };
}

function buildCollectionFunding(payments: readonly ExternalPayment[], totalOutstandingBalanceMicros: number): CollectionFunding {
  const sumUsd = (rows: readonly ExternalPayment[]) => round(rows.reduce((sum, p) => sum + p.amountAtomic, 0) / 1_000_000, 6);
  const confirmedStripe = payments.filter(p => p.provider === "stripe" && p.status === "confirmed");
  const confirmedUsdc = payments.filter(p => p.provider === "usdc_base" && p.status === "confirmed");
  return {
    stripeCollectedUsd: sumUsd(confirmedStripe),
    usdcTopupsConfirmedUsd: sumUsd(confirmedUsdc),
    pendingExternalPaymentsCount: payments.filter(p => p.status === "created" || p.status === "pending").length,
    refundedOrReviewCount: payments.filter(p => p.status === "refunded" || p.status === "requires_review").length,
    prepaidOutstandingBalanceUsd: round(totalOutstandingBalanceMicros / 1_000_000, 6),
    byProvider: {
      stripe: { confirmedUsd: sumUsd(confirmedStripe), confirmedCount: confirmedStripe.length },
      usdcBase: { confirmedUsd: sumUsd(confirmedUsdc), confirmedCount: confirmedUsdc.length }
    }
  };
}

/** Spec section 19's minimal admin table: provider, customer, amount, status, timestamp, tx
 *  hash/Stripe session reference, refund/review flag — reusing this same session-cookie-
 *  protected internal dashboard (never a separate finance ERP), sourced from the identical
 *  ExternalPayment rows CollectionFunding is built from. */
export interface ExternalPaymentRow {
  time: string;
  provider: ExternalPayment["provider"];
  accountId: string;
  amountUsd: number;
  status: ExternalPayment["status"];
  reference: string | null;
  needsReview: boolean;
}

function buildExternalPaymentsTable(payments: readonly ExternalPayment[]): ExternalPaymentRow[] {
  return payments.slice(0, MAX_TRANSACTIONS_SHOWN).map(p => ({
    time: p.createdAt, provider: p.provider, accountId: p.accountId, amountUsd: round(p.amountAtomic / 1_000_000, 6),
    status: p.status, reference: p.transactionHash ?? p.providerPaymentId, needsReview: p.status === "requires_review" || p.status === "refunded"
  }));
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
  revenueByAttribution: RevenueAttributionRow[];
  /** Default-sorted by revenue descending (same tie-break as revenueByTool); the dashboard's own
   *  sort control re-orders this array client-side — see page.ts. Only includes a tool that had
   *  some real activity this period (a call, a challenge, or a settlement) — deliberately NOT the
   *  full always-list-every-capability convention revenueByTool uses, since the empty state here
   *  is "No tool usage recorded in this period," not a full zeroed table. */
  toolConversion: ToolConversionRow[];
  /** "All Capabilities Overview" — one row per REGISTERED capability, registry order, including
   *  zero-activity capabilities (see buildCapabilityOverview()'s doc comment). Deliberately the
   *  full always-list-every-capability convention revenueByTool uses, not toolConversion's
   *  activity-filtered one. */
  capabilityOverview: CapabilityOverviewRow[];
  x402Funnel: X402FunnelReport;
  /** Free Preview traffic and preview->paid conversion (see PreviewFunnelReport's doc comment). */
  previewFunnel: PreviewFunnelReport;
  /** API credits + subscriptions revenue (see UnifiedBillingRevenueSummary's doc comment) — a
   *  separate payment rail family from `revenue` above, never blended into it. */
  unifiedBillingRevenue: UnifiedBillingRevenueSummary;
  usage: UsageReport;
  transactions: TransactionRow[];
  reconciliation: { anomalyCount: number; anomalies: ReconciliationAnomaly[] };
  systemStatus: SystemStatusReport;
  /** "AI Agent Operations Command Center" additions (2026-09-23) — see each type's own doc
   *  comment for exactly which already-fetched real data backs it. */
  agents: AgentStatusRow[];
  activityFeed: ActivityFeedItem[];
  systemHealth: SystemHealthReport;
  sparklines: {
    revenue: number[];
    toolCalls: number[];
    discoveryHits: number[];
    unifiedBillingRevenue: number[];
    onChainSettledRevenue: number[];
    collectedRevenue: number[];
  };
  /** Collected / Pending-Internal / On-chain Settled / Payout Available / External Funding
   *  Collected / Outstanding Prepaid Balance — see RevenueOverview's own doc comment. */
  revenueOverview: RevenueOverview;
  /** "COLLECTION & FUNDING" section (spec section 16) — see CollectionFunding's own doc comment. */
  collectionFunding: CollectionFunding;
  /** Recent external payments / top-up history (spec section 19) — see ExternalPaymentRow's own
   *  doc comment. Newest first, capped at MAX_TRANSACTIONS_SHOWN like `transactions` above. */
  externalPaymentsTable: ExternalPaymentRow[];
  /** "REVENUE CONVERSION AUDIT" section (spec section 11) — see RevenueConversionAuditSection's
   *  own doc comment. Augments this dashboard; never replaces any section above. */
  revenueConversionAudit: RevenueConversionAuditSection;
  /** Correlated discovery -> challenge -> payment -> retry -> execution rows, derived only from
   * existing analytics events. Rows without an explicit journey id remain intentionally absent. */
  paymentJourneys: PaymentJourneyRow[];
  paymentJourneyFunnel: PaymentJourneyFunnel;
}

export interface DashboardServiceOptions {
  config: Config;
  analyticsRepository: AnalyticsRepository;
  revenueLedger: RevenueLedger;
  billingService: BillingService;
  /** Unified billing (API credits + subscriptions — src/billing/unified/). null when this
   *  deployment has neither enabled (createApp()'s own billingEngine variable is exactly this —
   *  see app.ts), in which case unifiedBillingRevenue reports `enabled: false` and every number
   *  zero rather than omitting the section. */
  billingEngine: BillingEngine | null;
  /** External payment collection (Stripe/USDC top-ups — src/billing/external/). null when this
   *  deployment has neither rail configured (createApp()'s own externalPaymentsService variable
   *  is exactly this — see app.ts), in which case collectionFunding/revenueOverview's new fields
   *  report all zeros rather than omitting the section, same convention as billingEngine above. */
  externalPaymentsService: ExternalPaymentsService | null;
}

const MAX_TRANSACTIONS_SHOWN = 20;

function conversionPct(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : round((numerator / denominator) * 100, 1);
}

export async function buildDashboardData(opts: DashboardServiceOptions, period: RevenuePeriod): Promise<DashboardData> {
  const now = new Date();
  const revenueSince = periodSince(period, now);
  const eventsSince = analyticsSince(period, now);

  const [settlements, events, unifiedBillingEntries, externalPayments, totalOutstandingBalanceMicros, auditLedgerEntries] = await Promise.all([
    opts.revenueLedger.query({ since: revenueSince }),
    opts.analyticsRepository.queryEvents(eventsSince),
    opts.billingEngine ? opts.billingEngine.store.listSettledCharges(revenueSince) : Promise.resolve<LedgerEntry[]>([]),
    opts.externalPaymentsService ? opts.externalPaymentsService.listExternalPayments({ since: revenueSince }) : Promise.resolve<ExternalPayment[]>([]),
    opts.billingEngine ? opts.billingEngine.store.totalOutstandingBalanceMicros() : Promise.resolve(0),
    // Revenue Conversion Audit needs the FULL reserve->settle/release lifecycle (pending/settled/
    // refunded), not just settled charges — see store.ts's listLedgerEntries() doc comment.
    opts.billingEngine ? opts.billingEngine.store.listLedgerEntries(revenueSince) : Promise.resolve<LedgerEntry[]>([])
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
    challengeQuality: x402Window.challengeQuality,
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

  // ---- Top Tools / Conversion by Tool — see ToolConversionRow's doc comment. Reuses toolsWindow
  // (analytics tool-call events, already computed above), x402Window (analytics x402 funnel
  // events, already computed above) plus a small per-tool payment_verified count, and toolRevenue
  // (the revenue ledger, already computed above for revenueByTool) — no new aggregation source. ----
  const paymentVerifiedByTool: Record<string, number> = {};
  for (const event of events) {
    if (event.category === "x402" && event.eventType === "payment_verified" && event.toolName) {
      paymentVerifiedByTool[event.toolName] = (paymentVerifiedByTool[event.toolName] ?? 0) + 1;
    }
  }
  const toolConversionNames = new Set<string>([
    ...Object.keys(toolsWindow.byTool), ...Object.keys(x402Window.byTool), ...Object.keys(toolRevenue)
  ]);
  const toolConversion: ToolConversionRow[] = [...toolConversionNames]
    .map((toolName): ToolConversionRow => {
      const callStats = toolsWindow.byTool[toolName];
      const x402Stats = x402Window.byTool[toolName];
      const revStats: RevenueToolStats = toolRevenue[toolName] ?? {
        settledCalls: 0, failedSettlements: 0, revenueByCurrency: {}, revenue: null, currency: null
      };
      const challenges = x402Stats?.challenges ?? 0;
      // Deliberately settledCalls (revenue ledger) / challenges (analytics) — see the interface
      // doc comment. null, never 0%, when there was no opportunity to convert.
      const conversionPct = challenges === 0 ? null : round((revStats.settledCalls / challenges) * 100, 1);
      return {
        toolName,
        calls: callStats?.calls ?? 0,
        successCount: callStats?.successCount ?? 0,
        failureCount: callStats?.failureCount ?? 0,
        challenges,
        paymentVerified: paymentVerifiedByTool[toolName] ?? 0,
        settledCalls: revStats.settledCalls,
        conversionPct,
        revenueByCurrency: revStats.revenueByCurrency,
        revenue: revStats.revenue,
        currency: revStats.currency,
        averageRevenuePerSettledCall: revStats.revenue !== null && revStats.settledCalls > 0
          ? round(revStats.revenue / revStats.settledCalls, 4) : null,
        p50LatencyMs: callStats?.p50LatencyMs ?? null,
        p95LatencyMs: callStats?.p95LatencyMs ?? null
      };
    })
    // Only a tool with some real signal this period — a call, a challenge, or a settlement —
    // appears here at all (unlike revenueByTool, which always lists every known capability); see
    // the empty-state rule in the doc comment above.
    .filter(row => row.calls > 0 || row.challenges > 0 || row.settledCalls > 0)
    .sort((a, b) => (b.revenue ?? -1) - (a.revenue ?? -1) || b.settledCalls - a.settledCalls);

  // ---- All Capabilities Overview — every registered capability, registry order, zero-activity
  // rows included. Reuses toolsWindow/x402Window/toolRevenue exactly as computed above for
  // toolConversion — no new query, no new aggregation source. ----
  const capabilityOverview = buildCapabilityOverview({ toolsWindow, x402Window, toolRevenue });

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
  const paymentJourneys = buildPaymentJourneyRows(events);
  const paymentJourneyFunnel = buildPaymentJourneyFunnel(paymentJourneys);

  const systemStatus = await gatherSystemStatus({
    config: opts.config, analyticsRepository: opts.analyticsRepository, revenueLedger: opts.revenueLedger,
    period, periodEvents: events, periodSettlements: settlements
  });

  // ---- Revenue Conversion Audit (spec: "explains, for every capability/tool call, why it did or
  // did not convert into paid revenue" — src/audit/) — reuses the exact same `events`/
  // `settlements` already fetched above, plus `auditLedgerEntries` (the full reserve->settle/
  // release lifecycle, fetched alongside unifiedBillingEntries above). No new query beyond that
  // one additional listLedgerEntries() call. ----
  const callAuditRecords = buildCallAuditRecords({ events, settlements, ledgerEntries: auditLedgerEntries });
  const revenueConversionAudit = buildRevenueConversionAuditSection(callAuditRecords, catalogPriceByTool);

  // ---- AI Agent Operations Command Center additions — all computed from data already fetched
  // above; see each function's own doc comment for the exact real fields behind it. ----
  const agents = buildAgentStatuses({
    events, toolsWindow, x402Funnel, settledPayments: revenue.settledPayments, anomalyCount: anomalies.length, now,
    toolAudit: revenueConversionAudit.toolAudit
  });
  const activityFeed = buildActivityFeed(events);
  const systemHealth = buildSystemHealthScore(systemStatus, anomalies.length);

  // ---- Free Preview funnel (spec: preview traffic + preview->paid conversion) ----
  const previewFunnel = buildPreviewFunnel(events);

  // ---- Unified billing revenue (API credits + subscriptions — separate rail family from the
  // x402 settlement ledger `revenue` above; see UnifiedBillingRevenueSummary's doc comment). ----
  const unifiedBillingTotals = summarizeUnifiedBillingRevenue(unifiedBillingEntries);
  const unifiedBillingRevenue: UnifiedBillingRevenueSummary = {
    enabled: opts.billingEngine !== null,
    totalUsd: unifiedBillingTotals.totalUsd,
    settledCharges: unifiedBillingTotals.settledCharges,
    byRail: unifiedBillingTotals.byRail,
    byTool: summarizeUnifiedBillingRevenueByTool(unifiedBillingEntries)
  };

  // ---- Collection & Funding: Stripe/USDC top-ups + outstanding prepaid balance (spec section 16;
  // see CollectionFunding's own doc comment) ----
  const collectionFunding = buildCollectionFunding(externalPayments, totalOutstandingBalanceMicros);
  const externalPaymentsTable = buildExternalPaymentsTable(externalPayments);

  // ---- Revenue Overview: Collected / Pending-Internal / On-chain Settled / Payout Available /
  // External Funding Collected / Outstanding Prepaid Balance (see RevenueOverview's doc comment
  // above for the reasoning behind each figure) ----
  const revenueOverview = buildRevenueOverview(revenue, unifiedBillingRevenue, collectionFunding);
  const pendingRevenueSpark = buildUnifiedBillingRevenueSparkline(unifiedBillingEntries, period, now);
  const onChainSettledRevenueSpark = buildOnChainSettledRevenueSparkline(
    settlements, period, now, revenueOverview.onChainSettledRevenueUsd !== null
  );
  const sparklines = {
    revenue: buildSettlementCountSparkline(settlements, period, now),
    toolCalls: buildCountSparkline(events, period, now, e => e.category === "tool"),
    discoveryHits: buildCountSparkline(events, period, now, e => e.category === "discovery"),
    unifiedBillingRevenue: pendingRevenueSpark,
    onChainSettledRevenue: onChainSettledRevenueSpark,
    // Same USD-safe combination as revenueOverview.collectedRevenueUsd: onChainSettledRevenueSpark
    // is already all-zero (never a blended amount) when that combination isn't currency-safe.
    collectedRevenue: onChainSettledRevenueSpark.map((v, i) => round(v + pendingRevenueSpark[i]!, 6))
  };

  return {
    period, generatedAt: now.toISOString(), revenue, paidCalls, revenueTrend, revenueByTool,
    revenueByAttribution: buildRevenueByAttribution(settlements, events), toolConversion,
    capabilityOverview, x402Funnel, previewFunnel, unifiedBillingRevenue, revenueOverview, collectionFunding, externalPaymentsTable, usage,
    transactions, reconciliation: { anomalyCount: anomalies.length, anomalies }, systemStatus,
    agents, activityFeed, systemHealth, sparklines, revenueConversionAudit,
    paymentJourneys, paymentJourneyFunnel
  };
}
