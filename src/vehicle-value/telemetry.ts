import type { ConfidenceLevel, FallbackLevel, ProviderRun } from "./types.js";

/**
 * Internal, per-process execution telemetry for vehicle_value_estimate (never part of the API
 * response). Complements the generic analytics layer — which already records every invocation's
 * capability, channel, success, latency and data source (analytics/dataSource.ts) — with the
 * valuation-specific dimensions: country, make, model, model year, comparable count, provider
 * count, confidence level and fallback level. Holds no VIN, no personal data, no prices.
 * Exposed only on the internal-key-gated unit-economics route.
 */

export interface VehicleValuationEvent {
  at: string;
  country: string;
  make: string;
  model: string;
  modelYear: number;
  status: "estimated" | "insufficient_market_data" | "failed";
  comparableCount: number;
  providerCount: number;
  providerFailures: number;
  confidenceLevel: ConfidenceLevel | null;
  fallbackLevel: FallbackLevel | null;
  regionalFallback: boolean;
  latencyMs: number;
}

const MAX_EVENTS = 500;
const events: VehicleValuationEvent[] = [];
const providerStats = new Map<string, { runs: number; ok: number; empty: number; timeouts: number; errors: number; cacheHits: number; totalDurationMs: number }>();

export function recordVehicleValuation(event: VehicleValuationEvent, runs: readonly ProviderRun[]): void {
  events.push(event);
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  for (const run of runs) {
    const s = providerStats.get(run.providerId) ?? { runs: 0, ok: 0, empty: 0, timeouts: 0, errors: 0, cacheHits: 0, totalDurationMs: 0 };
    s.runs++;
    if (run.status === "ok") s.ok++; else if (run.status === "empty") s.empty++; else if (run.status === "timeout") s.timeouts++; else s.errors++;
    if (run.fromCache) s.cacheHits++;
    s.totalDurationMs += run.durationMs;
    providerStats.set(run.providerId, s);
  }
}

export function getVehicleValuationTelemetry() {
  const byStatus: Record<string, number> = {};
  const byCountry: Record<string, number> = {};
  const byConfidence: Record<string, number> = {};
  for (const e of events) {
    byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
    byCountry[e.country] = (byCountry[e.country] ?? 0) + 1;
    if (e.confidenceLevel) byConfidence[e.confidenceLevel] = (byConfidence[e.confidenceLevel] ?? 0) + 1;
  }
  const latencies = events.map(e => e.latencyMs).sort((a, b) => a - b);
  const p = (q: number) => (latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))]! : null);
  return {
    calls: events.length, byStatus, byCountry, byConfidence, p50LatencyMs: p(0.5), p95LatencyMs: p(0.95),
    providers: Object.fromEntries([...providerStats.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, s]) => [id, { ...s, avgDurationMs: s.runs ? Math.round(s.totalDurationMs / s.runs) : 0 }])),
    recent: events.slice(-20)
  };
}

/** Tests only. */
export function resetVehicleValuationTelemetry(): void {
  events.length = 0;
  providerStats.clear();
}
