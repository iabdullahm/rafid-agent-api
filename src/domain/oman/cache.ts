import type { FurnishedStatus, PropertyType } from "./types.js";

/**
 * Phase 9: an optional cache for comparable-pool lookups, sitting in front of
 * DatabaseOmanPropertyDataProvider (dataProviders.ts). Not coupled to Redis yet — this interface
 * is written so a future `RedisComparableCache` can implement it (async get/set, string keys,
 * JSON-serializable values are all Redis-compatible) without any caller changing; today
 * `MemoryComparableCache` is the only implementation, and using no cache at all (the default) is
 * always correct, just slower under repeated identical queries.
 */
export interface CacheableRecord {
  readonly id: string;
}

export interface ComparableCache {
  get(key: string): Promise<readonly CacheableRecord[] | null>;
  set(key: string, value: readonly CacheableRecord[]): Promise<void>;
}

/** Size buckets so "128 sqm" and "135 sqm" (a difference that comparables.ts's own ±20% size
 *  tolerance would treat as practically the same query) share a cache entry, while "80 sqm" and
 *  "300 sqm" never collide. 25 sqm is roughly half of comparables.ts's own SIZE_TOLERANCE_PCT
 *  band at a typical Muscat apartment size, so cache hits stay useful without smearing distinct
 *  queries together. */
const SIZE_BUCKET_SQM = 25;

/** Cache keys depend on exactly the fields the spec calls out: area, property type, bedrooms,
 *  a size bucket (not the exact sqm — see above), furnished status, and transaction type. Two
 *  requests that only differ in, say, askingPriceOMR (which doesn't affect which comparables get
 *  fetched) share a cache entry; two requests for different areas or property types never do. */
export function buildComparableCacheKey(query: {
  area: string; propertyType: PropertyType; bedrooms?: number; sizeSqm: number; furnished?: FurnishedStatus; transactionType: "rental" | "sale";
}): string {
  const sizeBucket = Math.floor(query.sizeSqm / SIZE_BUCKET_SQM);
  return [
    query.transactionType, query.area.trim().toLowerCase(), query.propertyType,
    query.bedrooms ?? "any", sizeBucket, query.furnished ?? "any"
  ].join("::");
}

/**
 * Simple TTL cache over an in-process Map. Not shared across server instances/processes (a
 * serverless deployment with multiple warm instances gets independent caches, each with its own
 * hit rate) — that limitation is inherent to any in-memory cache and is exactly what a future
 * `RedisComparableCache` (sharing one cache across instances) would remove, without this class's
 * callers needing to change since both implement the same `ComparableCache` interface.
 */
export class MemoryComparableCache implements ComparableCache {
  private readonly store = new Map<string, { value: readonly CacheableRecord[]; expiresAt: number }>();
  constructor(private readonly ttlMs: number) {}
  async get(key: string): Promise<readonly CacheableRecord[] | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) { this.store.delete(key); return null; }
    return entry.value;
  }
  async set(key: string, value: readonly CacheableRecord[]): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
  /** Test-only introspection — not part of the interface. */
  size(): number { return this.store.size; }
}
