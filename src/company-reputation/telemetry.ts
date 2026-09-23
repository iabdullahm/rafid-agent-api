import type { ProviderRun } from "./types.js";

/**
 * Internal per-process execution telemetry for company_reputation_check (never part of the API
 * response, never contains credentials or company data): provider calls, cache hits/misses, stale
 * serves, outages, provider latency and evidence volume — the inputs needed later for per-call
 * cost accounting (revenue per call − provider cost per call = gross margin). Upstream search spend
 * is ALSO recorded through intelligence/costEstimator.ts's recordProviderCost (by the web-search
 * provider itself), which the internal unit-economics route already reports.
 */

interface ProviderStats { runs: number; outboundRequests: number; cacheHits: number; staleServed: number; outages: number; totalDurationMs: number; maxDurationMs: number; estimatedCostUSD: number }

const stats = {
  calls: 0,
  evidenceProcessed: 0,
  cacheHits: 0,
  cacheMisses: 0,
  staleServed: 0,
  outboundRequests: 0,
  estimatedCostUSD: 0,
  providers: new Map<string, ProviderStats>()
};

export function recordReputationRun(runs: readonly ProviderRun[], evidenceProcessed: number): void {
  stats.calls++;
  stats.evidenceProcessed += evidenceProcessed;
  for (const run of runs) {
    if (run.status === "not_configured" || run.status === "not_applicable") continue;
    const p = stats.providers.get(run.providerId) ?? { runs: 0, outboundRequests: 0, cacheHits: 0, staleServed: 0, outages: 0, totalDurationMs: 0, maxDurationMs: 0, estimatedCostUSD: 0 };
    p.runs++;
    p.outboundRequests += run.requests;
    p.totalDurationMs += run.durationMs;
    p.maxDurationMs = Math.max(p.maxDurationMs, run.durationMs);
    p.estimatedCostUSD += run.estimatedCostUSD;
    if (run.status === "ok" && run.fromCache) { p.cacheHits++; stats.cacheHits++; } else if (run.status !== "stale_cache") stats.cacheMisses++;
    if (run.status === "stale_cache") { p.staleServed++; stats.staleServed++; }
    if (run.status === "unavailable" || run.status === "timeout" || run.status === "rate_limited") p.outages++;
    stats.outboundRequests += run.requests;
    stats.estimatedCostUSD += run.estimatedCostUSD;
    stats.providers.set(run.providerId, p);
  }
}

export interface ReputationTelemetrySnapshot {
  calls: number;
  evidenceProcessed: number;
  cacheHits: number;
  cacheMisses: number;
  staleServed: number;
  outboundRequests: number;
  estimatedUpstreamCostUSD: number;
  estimatedUpstreamCostPerCallUSD: number;
  providers: Record<string, ProviderStats & { avgDurationMs: number }>;
}

export function getReputationTelemetry(): ReputationTelemetrySnapshot {
  const round = (n: number) => Math.round(n * 10000) / 10000;
  return {
    calls: stats.calls, evidenceProcessed: stats.evidenceProcessed, cacheHits: stats.cacheHits, cacheMisses: stats.cacheMisses,
    staleServed: stats.staleServed, outboundRequests: stats.outboundRequests, estimatedUpstreamCostUSD: round(stats.estimatedCostUSD),
    estimatedUpstreamCostPerCallUSD: stats.calls ? round(stats.estimatedCostUSD / stats.calls) : 0,
    providers: Object.fromEntries([...stats.providers.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, p]) => [id, { ...p, estimatedCostUSD: round(p.estimatedCostUSD), avgDurationMs: p.runs ? Math.round(p.totalDurationMs / p.runs) : 0 }]))
  };
}

/** Tests only. */
export function resetReputationTelemetry(): void {
  stats.calls = 0; stats.evidenceProcessed = 0; stats.cacheHits = 0; stats.cacheMisses = 0; stats.staleServed = 0;
  stats.outboundRequests = 0; stats.estimatedCostUSD = 0; stats.providers.clear();
}
