import type { ReputationEvidenceCache } from "../evidenceCache.js";
import type { ProviderCategory, ProviderFetchResult, ProviderRun } from "../types.js";
import { isAbortError, type ProviderContext, type ReputationProvider, type ReputationQuery } from "./types.js";

/**
 * Runs every provider CONCURRENTLY with isolation (one provider's failure/latency never blocks or
 * fails another), under a per-provider timeout, with at most one retry for providers that declare
 * themselves retryable (free idempotent GETs — paid searches are never retried automatically).
 *
 * Hybrid lookup per provider:
 *   fresh cache hit → serve cached evidence (original fetchedAt preserved, no outbound call)
 *   miss/expired    → fetch; on "ok" upsert cache
 *   fetch failed    → if an expired entry exists within maxStaleMs, serve it as "stale_cache"
 *                     (explicitly flagged DATA_STALE downstream), else report the outage
 */

export interface RunnerOptions {
  cache: ReputationEvidenceCache;
  ttls: Readonly<Record<ProviderCategory, number>>;
  maxStaleMs: number;
  timeoutMs: number;
  maxAttempts: number;
  disabled: ReadonlySet<string>;
  now: () => Date;
}

function timeoutResult(): ProviderFetchResult {
  return { status: "timeout", evidence: [], reason: "The provider did not respond within the time budget.", requests: 1, estimatedCostUSD: 0 };
}

async function fetchWithTimeout(provider: ReputationProvider, query: ReputationQuery, now: Date, timeoutMs: number): Promise<ProviderFetchResult> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const context: ProviderContext = { now, signal: controller.signal };
  const timeout = new Promise<ProviderFetchResult>(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve(timeoutResult()); }, timeoutMs);
  });
  try {
    return await Promise.race([
      provider.fetch(query, context).catch((error: unknown): ProviderFetchResult => (
        isAbortError(error) ? timeoutResult() : { status: "unavailable", evidence: [], reason: `${provider.name} failed unexpectedly.`, requests: 1, estimatedCostUSD: 0 }
      )),
      timeout
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runProvider(provider: ReputationProvider, query: ReputationQuery, options: RunnerOptions): Promise<ProviderRun> {
  const base = { providerId: provider.id, providerName: provider.name, category: provider.category };
  const empty = { evidence: [], fromCache: false, fetchedAt: null, requests: 0, estimatedCostUSD: 0, durationMs: 0, attempts: 0 };
  if (options.disabled.has(provider.id.toLowerCase()) || options.disabled.has(provider.category)) {
    return { ...base, ...empty, status: "not_configured", reason: "Disabled by the operator (COMPANY_REPUTATION_DISABLED_PROVIDERS)." };
  }
  const applicability = provider.applicability(query);
  if (applicability.status !== "ready") return { ...base, ...empty, status: applicability.status, reason: applicability.reason };

  const now = options.now();
  const key = provider.cacheKey(query);
  let cached = null as Awaited<ReturnType<ReputationEvidenceCache["get"]>>;
  try { cached = await options.cache.get(provider.id, key); } catch { cached = null; }
  if (cached && Date.parse(cached.expiresAt) > now.getTime()) {
    return { ...base, status: "ok", evidence: cached.evidence, reason: null, fromCache: true, fetchedAt: cached.fetchedAt, requests: 0, estimatedCostUSD: 0, durationMs: 0, attempts: 0 };
  }

  const started = performance.now();
  let attempts = 0, requests = 0, cost = 0;
  let result: ProviderFetchResult;
  for (;;) {
    attempts++;
    result = await fetchWithTimeout(provider, query, now, options.timeoutMs);
    requests += result.requests;
    cost += result.estimatedCostUSD;
    const transient = result.status === "unavailable" || result.status === "timeout";
    if (!transient || !provider.retryable || attempts >= options.maxAttempts) break;
  }
  const durationMs = Math.round(performance.now() - started);

  if (result.status === "ok") {
    const fetchedAt = now.toISOString();
    const ttl = options.ttls[provider.category];
    if (ttl > 0) {
      try { await options.cache.put({ providerId: provider.id, identityKey: key, evidence: result.evidence, fetchedAt, expiresAt: new Date(now.getTime() + ttl).toISOString() }); } catch { /* cache write failure never fails the call */ }
    }
    return { ...base, status: "ok", evidence: result.evidence, reason: result.reason, fromCache: false, fetchedAt, requests, estimatedCostUSD: cost, durationMs, attempts };
  }
  if ((result.status === "unavailable" || result.status === "timeout" || result.status === "rate_limited") && cached
    && now.getTime() - Date.parse(cached.expiresAt) <= options.maxStaleMs) {
    return { ...base, status: "stale_cache", evidence: cached.evidence, reason: `${result.reason ?? "Live source unavailable"} Serving previously retrieved evidence from ${cached.fetchedAt} (stale).`, fromCache: true, fetchedAt: cached.fetchedAt, requests, estimatedCostUSD: cost, durationMs, attempts };
  }
  return { ...base, status: result.status, evidence: [], reason: result.reason, fromCache: false, fetchedAt: null, requests, estimatedCostUSD: cost, durationMs, attempts };
}

export async function runProviders(providers: readonly ReputationProvider[], query: ReputationQuery, options: RunnerOptions): Promise<ProviderRun[]> {
  return Promise.all(providers.map(p => runProvider(p, query, options)));
}
