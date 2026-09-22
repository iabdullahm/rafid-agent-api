import type { AnalyticsEvent } from "./types.js";

/**
 * Pure aggregation over an already-fetched event array — deliberately not SQL-side aggregation.
 * This is a "lightweight internal analytics layer" per its own spec; computing percentiles/
 * breakdowns in plain JS over AnalyticsRepository.queryEvents()'s result keeps the SQL side to a
 * single indexed range SELECT (easy to reason about, easy to test against MemoryAnalyticsRepository
 * with no database at all) at the cost of transferring more rows for a 30-day window on a
 * high-traffic deployment. AnalyticsRepository.queryEvents() caps its result at MAX_QUERY_EVENTS
 * (types.ts) specifically so this never grows unbounded; a deployment busy enough to regularly
 * hit that cap will under-count its 30-day figures rather than time out or OOM — a known,
 * documented limit of "lightweight," the same honest tradeoff this codebase already makes
 * elsewhere (see middleware/rateLimit.ts's per-process limiter doc comment for the same spirit).
 */

export const WINDOW_MS = {
  last24h: 24 * 60 * 60 * 1000,
  last7d: 7 * 24 * 60 * 60 * 1000,
  last30d: 30 * 24 * 60 * 60 * 1000
} as const;

export type WindowKey = keyof typeof WINDOW_MS;
export const WINDOW_KEYS = Object.keys(WINDOW_MS) as WindowKey[];

/** Splits a fetched event array (assumed to already cover at least the widest window needed) into
 *  the three spec-required windows, each measured back from `now`. */
function eventsInWindow(events: readonly AnalyticsEvent[], now: Date, windowMs: number): AnalyticsEvent[] {
  const cutoff = now.getTime() - windowMs;
  return events.filter(e => new Date(e.createdAt).getTime() >= cutoff);
}

/** Nearest-rank percentile over a set of durations — no external stats dependency, deterministic,
 *  and matches the common "p50/p95 latency" convention closely enough for an internal ops view
 *  (not a claim of statistical rigor beyond that). Returns null for an empty input rather than 0,
 *  so "no data yet" is never confused with "zero latency". */
export function percentile(durations: readonly number[], p: number): number | null {
  if (durations.length === 0) return null;
  const sorted = [...durations].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[rank]! * 100) / 100;
}

function successRate(successes: number, total: number): number | null {
  return total === 0 ? null : Math.round((successes / total) * 10000) / 100;
}

function byWindow<T>(events: readonly AnalyticsEvent[], now: Date, fn: (windowEvents: AnalyticsEvent[]) => T): Record<WindowKey, T> {
  const result = {} as Record<WindowKey, T>;
  for (const key of WINDOW_KEYS) result[key] = fn(eventsInWindow(events, now, WINDOW_MS[key]));
  return result;
}

// -----------------------------------------------------------------------------------------------
// GET /api/v1/internal/analytics/summary
// -----------------------------------------------------------------------------------------------

export interface SummaryWindow {
  totalEvents: number;
  discoveryHits: number;
  mcpCalls: number;
  x402Events: number;
  toolInvocations: number;
  toolSuccessRate: number | null;
  partnerFeedInvocations: number;
  demoManualInvocations: number;
}

export function summarize(events: readonly AnalyticsEvent[], now: Date): Record<WindowKey, SummaryWindow> {
  return byWindow(events, now, windowEvents => {
    const tools = windowEvents.filter(e => e.category === "tool");
    const successfulTools = tools.filter(e => e.success === true);
    return {
      totalEvents: windowEvents.length,
      discoveryHits: windowEvents.filter(e => e.category === "discovery").length,
      mcpCalls: windowEvents.filter(e => e.category === "mcp").length,
      x402Events: windowEvents.filter(e => e.category === "x402").length,
      toolInvocations: tools.length,
      toolSuccessRate: successRate(successfulTools.length, tools.length),
      partnerFeedInvocations: tools.filter(e => e.dataSource === "partner_feed" || e.dataSource === "mixed").length,
      demoManualInvocations: tools.filter(e => e.dataSource === "demo_manual" || e.dataSource === "mixed").length
    };
  });
}

// -----------------------------------------------------------------------------------------------
// GET /api/v1/internal/analytics/discovery
// -----------------------------------------------------------------------------------------------

export interface DiscoveryWindow {
  totalHits: number;
  byPath: Record<string, number>;
  uniqueClients: number;
}

export function summarizeDiscovery(events: readonly AnalyticsEvent[], now: Date): Record<WindowKey, DiscoveryWindow> {
  return byWindow(events, now, windowEvents => {
    const hits = windowEvents.filter(e => e.category === "discovery");
    const byPath: Record<string, number> = {};
    for (const hit of hits) if (hit.path) byPath[hit.path] = (byPath[hit.path] ?? 0) + 1;
    return { totalHits: hits.length, byPath, uniqueClients: new Set(hits.map(h => h.clientHash).filter((h): h is string => Boolean(h))).size };
  });
}

// -----------------------------------------------------------------------------------------------
// GET /api/v1/internal/analytics/tools
// -----------------------------------------------------------------------------------------------

export interface ToolStats {
  calls: number;
  successCount: number;
  failureCount: number;
  successRate: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  partnerFeedCalls: number;
  demoManualCalls: number;
  mixedCalls: number;
  unknownDataSourceCalls: number;
}

export interface ToolsWindow {
  totalInvocations: number;
  byTool: Record<string, ToolStats>;
  mcp: { initialize: number; toolsList: number; toolsCall: number };
}

export function summarizeTools(events: readonly AnalyticsEvent[], now: Date): Record<WindowKey, ToolsWindow> {
  return byWindow(events, now, windowEvents => {
    const invocations = windowEvents.filter(e => e.category === "tool");
    const byTool: Record<string, ToolStats> = {};
    for (const invocation of invocations) {
      const name = invocation.toolName ?? "unknown";
      const stats = (byTool[name] ??= {
        calls: 0, successCount: 0, failureCount: 0, successRate: null, p50LatencyMs: null, p95LatencyMs: null,
        partnerFeedCalls: 0, demoManualCalls: 0, mixedCalls: 0, unknownDataSourceCalls: 0
      });
      stats.calls++;
      if (invocation.success === true) stats.successCount++;
      else if (invocation.success === false) stats.failureCount++;
      if (invocation.dataSource === "partner_feed") stats.partnerFeedCalls++;
      else if (invocation.dataSource === "demo_manual") stats.demoManualCalls++;
      else if (invocation.dataSource === "mixed") stats.mixedCalls++;
      else if (invocation.dataSource === "unknown") stats.unknownDataSourceCalls++;
    }
    for (const [name, stats] of Object.entries(byTool)) {
      const durations = invocations.filter(e => (e.toolName ?? "unknown") === name && typeof e.durationMs === "number").map(e => e.durationMs!);
      stats.successRate = successRate(stats.successCount, stats.calls);
      stats.p50LatencyMs = percentile(durations, 50);
      stats.p95LatencyMs = percentile(durations, 95);
    }
    const mcpEvents = windowEvents.filter(e => e.category === "mcp");
    return {
      totalInvocations: invocations.length,
      byTool,
      mcp: {
        initialize: mcpEvents.filter(e => e.eventType === "initialize").length,
        toolsList: mcpEvents.filter(e => e.eventType === "tools_list").length,
        toolsCall: mcpEvents.filter(e => e.eventType === "tools_call").length
      }
    };
  });
}

// -----------------------------------------------------------------------------------------------
// GET /api/v1/internal/analytics/x402
// -----------------------------------------------------------------------------------------------

export interface X402Window {
  challenges: number;
  paymentVerified: number;
  paymentFailed: number;
  settlementSuccess: number;
  settlementFailure: number;
  settledAmountByCurrency: Record<string, number>;
  byTool: Record<string, { challenges: number; settlementSuccess: number; settlementFailure: number }>;
  /** Safe, public on-chain identifiers only (see recorder.ts's doc comment on what txHash may
   *  ever contain) — capped and newest-first, for operator spot-checking, never a payment proof
   *  or signature. */
  recentSettlements: { toolName: string | null; amount: number | null; currency: string | null; txHash: string; at: string }[];
}

const MAX_RECENT_SETTLEMENTS = 20;

export function summarizeX402(events: readonly AnalyticsEvent[], now: Date): Record<WindowKey, X402Window> {
  return byWindow(events, now, windowEvents => {
    const x402Events = windowEvents.filter(e => e.category === "x402");
    const settledAmountByCurrency: Record<string, number> = {};
    const byTool: Record<string, { challenges: number; settlementSuccess: number; settlementFailure: number }> = {};
    for (const event of x402Events) {
      const tool = event.toolName ?? "unknown";
      const bucket = (byTool[tool] ??= { challenges: 0, settlementSuccess: 0, settlementFailure: 0 });
      if (event.eventType === "challenge") bucket.challenges++;
      if (event.eventType === "settlement_success") {
        bucket.settlementSuccess++;
        if (event.amount !== null && event.currency) settledAmountByCurrency[event.currency] = Math.round(((settledAmountByCurrency[event.currency] ?? 0) + event.amount) * 10000) / 10000;
      }
      if (event.eventType === "settlement_failure") bucket.settlementFailure++;
    }
    const recentSettlements = x402Events
      .filter(e => e.eventType === "settlement_success" && e.txHash)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, MAX_RECENT_SETTLEMENTS)
      .map(e => ({ toolName: e.toolName, amount: e.amount, currency: e.currency, txHash: e.txHash!, at: e.createdAt }));
    return {
      challenges: x402Events.filter(e => e.eventType === "challenge").length,
      paymentVerified: x402Events.filter(e => e.eventType === "payment_verified").length,
      paymentFailed: x402Events.filter(e => e.eventType === "payment_failed").length,
      settlementSuccess: x402Events.filter(e => e.eventType === "settlement_success").length,
      settlementFailure: x402Events.filter(e => e.eventType === "settlement_failure").length,
      settledAmountByCurrency, byTool, recentSettlements
    };
  });
}
