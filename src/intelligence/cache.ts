/**
 * A small, generic, in-process TTL cache — Section "Caching": "company research: cache by
 * normalized company/domain + depth + focus areas", "web research: short-lived cache based on
 * normalized query and freshness configuration", "risk analysis: short TTL due to time-sensitive
 * signals", and "the cache must not silently return stale results beyond its documented TTL."
 *
 * Deliberately NOT wired into the "not configured" fast path anywhere it's used: when no live
 * provider is configured, a result is cheap, honest, and identical on every call anyway, so
 * caching it would add no value and would need extra bookkeeping to keep `cached` accurate for
 * no benefit. This also keeps the generic per-capability test loops
 * (tests/http.test.ts/tests/mcp.test.ts/tests/x402.test.ts, which call `c.execute(c.example)`
 * directly, once via the route handler and once again for comparison) deterministic by default,
 * since the default/test environment never configures a live provider.
 *
 * Per-process only (like middleware/rateLimit.ts's own limiter) — a multi-instance serverless
 * deployment will have one cache per warm instance, not a shared one. That's a documented,
 * reasonable-default limitation, not a correctness bug: a cache miss just means "ask the
 * provider again", never a wrong answer.
 */
export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();
  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    this.store.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  /** For tests only — never called from production code paths. */
  clear(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size;
  }
}

/** A stable cache key from an arbitrary set of normalized parts — lowercases and trims each part
 *  so "Stripe" / " stripe " / "STRIPE" hit the same cache entry, joined by a separator that can
 *  never appear inside a single normalized part (a real company name/domain/keyword never
 *  contains the U+241F control-picture separator used here). */
export function cacheKey(...parts: readonly (string | number | null | undefined)[]): string {
  return parts.map(p => (p === null || p === undefined ? "" : String(p).trim().toLowerCase())).join("␟");
}
