import type { OfficialMarketContext } from "./officialContext.js";

/**
 * Section 7 (NCSI integration): official aggregate statistics change far less often than
 * property-level comparable listings (typically quarterly/annually), and are the same for every
 * caller asking about the same governorate — there is no reason to hit NCSI on every paid
 * `analyze_oman_property` call. A dedicated cache (rather than reusing ComparableCache) because
 * the shape being cached is a single object per governorate, not an array of comparable records —
 * forcing it into ComparableCache's `CacheableRecord[]` shape would be a worse fit than a small,
 * purpose-built interface. `MemoryComparableCache`'s TTL-Map pattern is intentionally mirrored
 * here so a future shared/distributed implementation (e.g. Redis) can back both without surprises.
 */
export interface OfficialMarketContextCache {
  get(governorate: string): Promise<OfficialMarketContext | null>;
  set(governorate: string, value: OfficialMarketContext): Promise<void>;
}

export class MemoryOfficialMarketContextCache implements OfficialMarketContextCache {
  private readonly store = new Map<string, { value: OfficialMarketContext; expiresAt: number }>();
  constructor(private readonly ttlMs: number) {}

  async get(governorate: string): Promise<OfficialMarketContext | null> {
    const key = governorate.trim().toLowerCase();
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) { this.store.delete(key); return null; }
    return entry.value;
  }

  async set(governorate: string, value: OfficialMarketContext): Promise<void> {
    const key = governorate.trim().toLowerCase();
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /** Test-only introspection — not part of the interface. */
  size(): number { return this.store.size; }
}
