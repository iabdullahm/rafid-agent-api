import { previewCostTier } from "./classification.js";

/**
 * Free Preview — response cache.
 *
 * A small, generic, in-memory TTL cache (no new infrastructure dependency — there is no Redis or
 * other shared cache anywhere in this codebase today, and the rate limiters already use the same
 * per-process, in-memory pattern for the same "reasonable default, no new dependency" reason — see
 * middleware/rateLimit.ts's doc comment). Keys are always `preview:<capability>:<fingerprint>`,
 * where `<fingerprint>` is a one-way hash from preview/fingerprint.ts — never raw input (see that
 * module's doc comment). Values are whole CapabilityPreviewResult objects (see preview/types.ts),
 * so a cache hit is a straight `res.json()` with no recomputation at all.
 *
 * Every read/write in this module is designed to be called through preview/service.ts's
 * try/catch-wrapped helpers (see runCapabilityPreview's caller in api/previewRoutes.ts) so a cache
 * failure — this implementation can't actually throw, but a future swap to a real shared cache
 * (e.g. Upstash Redis, exactly the swap-in point middleware/rateLimit.ts's doc comment already
 * names for rate limiting) could — always fails OPEN: the preview just runs fresh, never fails the
 * request. Caching is also never made mandatory: previewRoutes.ts works identically with no cache
 * instance supplied at all (see createPreviewRoutes' `cache` option).
 */
export interface PreviewCache {
  get(key: string): unknown;
  set(key: string, value: unknown, ttlSeconds: number): void;
}

interface Entry { value: unknown; expiresAt: number }

/** Bounds memory for a long-running, DB-less process — same discipline as
 *  middleware/rateLimit.ts's `hits` map and analytics/memoryRepository.ts's MAX_QUERY_EVENTS cap. */
const DEFAULT_MAX_ENTRIES = 5000;

export function createInMemoryPreviewCache(maxEntries = DEFAULT_MAX_ENTRIES): PreviewCache {
  const store = new Map<string, Entry>();
  return {
    get(key: string): unknown {
      const entry = store.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= Date.now()) {
        store.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key: string, value: unknown, ttlSeconds: number): void {
      if (ttlSeconds <= 0) return;
      store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
      // Bounded, occasional sweep — same pattern as middleware/rateLimit.ts's createRateLimiter,
      // so a long-running process can't grow this map forever even without a real TTL-eviction
      // data structure.
      if (store.size > maxEntries) {
        const now = Date.now();
        for (const [k, v] of store) if (v.expiresAt <= now) store.delete(k);
        // Still over the cap after sweeping expired entries (a genuine high-cardinality burst,
        // not just accumulated staleness): drop the oldest remaining entries (Map iteration order
        // is insertion order) rather than growing without bound.
        if (store.size > maxEntries) {
          const overflow = store.size - maxEntries;
          let dropped = 0;
          for (const k of store.keys()) {
            if (dropped >= overflow) break;
            store.delete(k);
            dropped++;
          }
        }
      }
    }
  };
}

export function previewCacheKey(capabilityName: string, fingerprint: string): string {
  return `preview:${capabilityName}:${fingerprint}`;
}

/**
 * Centralized TTL policy — one place, never hardcoded per capability/service. Buckets follow the
 * Free Preview production-readiness spec's suggested ranges:
 *   - company/reputation/business research: 15–30 min (here: 20 min)
 *   - property market availability: 10–30 min (here: 20 min)
 *   - supplier checks: 15–30 min (here: 20 min)
 *   - invoice/document metadata previews: 5–15 min (here: 10 min)
 * `PREVIEW_CACHE_TTL_SECONDS`, when set, overrides every bucket uniformly (see config/env.ts) —
 * one operator-facing knob rather than one env var per capability.
 */
const TTL_SECONDS_BY_CAPABILITY: Readonly<Record<string, number>> = Object.freeze({
  research_company: 1200,
  company_reputation_check: 1200,
  business_risk_score: 1200,
  vehicle_value_estimate: 1200,
  analyze_oman_property: 1200,
  oman_supplier_check: 1200,
  document_facts_extract: 600,
  invoice_anomaly_check: 600
});

export function previewCacheTtlSeconds(capabilityName: string, overrideSeconds: number | null): number {
  if (overrideSeconds !== null) return overrideSeconds;
  return TTL_SECONDS_BY_CAPABILITY[capabilityName] ?? (previewCostTier(capabilityName) === "expensive" ? 600 : 1200);
}
