import type { Config } from "../../config/env.js";
import type { AnalyticsEvent, AnalyticsRepository } from "../../analytics/types.js";
import {
  WINDOW_MS, percentile,
  summarizeAllTime, summarizeDiscoveryAllTime, summarizeToolsAllTime, summarizeX402AllTime,
  type ToolsWindow
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

/** One of the six operational groupings the dashboard's "Active Agents" panel shows. Five are a
 *  fixed, non-overlapping partition of the 11 registered capabilities (domain/capabilities.ts) —
 *  chosen so every capability belongs to exactly one group and no group is empty in a mature
 *  deployment; the sixth ("reconciliation") is cross-cutting and has no tools of its own. */
export type AgentGroupId = "research" | "property" | "supplier" | "risk" | "payment" | "reconciliation";

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
  { id: "property", name: "Property Agent", toolNames: ["analyze_property", "compare_properties", "estimate_maintenance", "analyze_oman_property"] },
  { id: "supplier", name: "Supplier Intelligence Agent", toolNames: ["search_oman_company", "get_oman_company_profile", "analyze_oman_company", "due_diligence_oman_company"] },
  { id: "risk", name: "Risk Agent", toolNames: ["analyze_company_risk"] },
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
}): AgentStatusRow[] {
  const { events, toolsWindow, x402Funnel, settledPayments, anomalyCount, now } = args;

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
    return {
      id: group.id, name: group.name, status, statusLabel, currentTask,
      metricLabel: `${calls} call(s) · ${fmtPctForStatus(successRatePct)} success`,
      toolNames: group.toolNames, calls, lastEventAt: lastEvent?.createdAt ?? null
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
    if (e.eventType === "challenge") return `402 payment challenge issued${e.toolName ? ` for ${e.toolName}` : ""}`;
    if (e.eventType === "payment_verified") return `Payment verified${e.toolName ? ` for ${e.toolName}` : ""}`;
    if (e.eventType === "payment_failed") return `Payment verification failed${e.toolName ? ` for ${e.toolName}` : ""}`;
    if (e.eventType === "settlement_success") return `Settlement succeeded${e.toolName ? ` for ${e.toolName}` : ""}`;
    return `Settlement failed${e.toolName ? ` for ${e.toolName}` : ""}`;
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
  /** Default-sorted by revenue descending (same tie-break as revenueByTool); the dashboard's own
   *  sort control re-orders this array client-side — see page.ts. Only includes a tool that had
   *  some real activity this period (a call, a challenge, or a settlement) — deliberately NOT the
   *  full always-list-every-capability convention revenueByTool uses, since the empty state here
   *  is "No tool usage recorded in this period," not a full zeroed table. */
  toolConversion: ToolConversionRow[];
  x402Funnel: X402FunnelReport;
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
  };
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

  // ---- AI Agent Operations Command Center additions — all computed from data already fetched
  // above; see each function's own doc comment for the exact real fields behind it. ----
  const agents = buildAgentStatuses({
    events, toolsWindow, x402Funnel, settledPayments: revenue.settledPayments, anomalyCount: anomalies.length, now
  });
  const activityFeed = buildActivityFeed(events);
  const systemHealth = buildSystemHealthScore(systemStatus, anomalies.length);
  const sparklines = {
    revenue: buildSettlementCountSparkline(settlements, period, now),
    toolCalls: buildCountSparkline(events, period, now, e => e.category === "tool"),
    discoveryHits: buildCountSparkline(events, period, now, e => e.category === "discovery")
  };

  return {
    period, generatedAt: now.toISOString(), revenue, paidCalls, revenueTrend, revenueByTool, toolConversion, x402Funnel, usage,
    transactions, reconciliation: { anomalyCount: anomalies.length, anomalies }, systemStatus,
    agents, activityFeed, systemHealth, sparklines
  };
}
