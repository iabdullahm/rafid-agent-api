import { Pool } from "pg";
import type { NormalizedEvidence } from "./types.js";

/**
 * Internal evidence cache for company_reputation_check (hybrid lookup: cache first, then fetch
 * missing/stale evidence, then merge). Keyed by (provider_id, identity_key), where identity_key is
 * the normalized company identity (name key | country | domain | registration number | LEI) the
 * provider was queried with — so two different companies with the same name in different
 * countries never share a cache row.
 *
 * - Only successful ("ok") provider results are cached — including an empty result ("checked,
 *   nothing found"), which is a real observation. Outages are never cached.
 * - Each row stores the evidence set with its ORIGINAL retrieval time (fetched_at). A cache hit
 *   serves that original observedAt/fetchedAt, so cache age never masquerades as fresh evidence.
 * - get() returns expired rows too; the caller decides (fresh → use; expired → refetch; refetch
 *   failed → may serve as explicitly-flagged stale evidence within a max-stale window).
 * - A dedicated table (rafid_company_evidence_cache), deliberately separate from
 *   oman_supplier_check's rafid_supplier_evidence: different key semantics and payload shape, and no
 *   cross-capability coupling. The payload is the capability-neutral NormalizedEvidence model, so a
 *   future company_due_diligence capability can read the same rows.
 * - The final score/result is never cached — always recomputed from evidence.
 */

export interface CachedEvidenceSet {
  providerId: string;
  identityKey: string;
  evidence: NormalizedEvidence[];
  fetchedAt: string;
  expiresAt: string;
}

export interface ReputationEvidenceCache {
  readonly name: string;
  get(providerId: string, identityKey: string): Promise<CachedEvidenceSet | null>;
  /** Idempotent upsert on (providerId, identityKey). */
  put(set: CachedEvidenceSet): Promise<void>;
}

export class MemoryReputationEvidenceCache implements ReputationEvidenceCache {
  readonly name = "memory";
  private readonly rows = new Map<string, { set: CachedEvidenceSet; writes: number }>();
  /** Bounded so a long-lived warm instance can't grow without limit. */
  constructor(private readonly maxRows = 5000) {}

  async get(providerId: string, identityKey: string): Promise<CachedEvidenceSet | null> {
    return this.rows.get(`${providerId}␟${identityKey}`)?.set ?? null;
  }

  async put(set: CachedEvidenceSet): Promise<void> {
    const key = `${set.providerId}␟${set.identityKey}`;
    const existing = this.rows.get(key);
    if (!existing && this.rows.size >= this.maxRows) {
      const oldest = this.rows.keys().next().value;
      if (oldest !== undefined) this.rows.delete(oldest);
    }
    this.rows.delete(key);
    this.rows.set(key, { set, writes: (existing?.writes ?? 0) + 1 });
  }

  /** Tests/diagnostics only. */
  get size(): number { return this.rows.size; }
  writesFor(providerId: string, identityKey: string): number { return this.rows.get(`${providerId}␟${identityKey}`)?.writes ?? 0; }
  clear(): void { this.rows.clear(); }
}

export class PostgresReputationEvidenceCache implements ReputationEvidenceCache {
  readonly name = "postgres";
  private readonly pool: Pool;
  private readonly ready: Promise<void>;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 3, connectionTimeoutMillis: 5000, statement_timeout: 8000, idle_in_transaction_session_timeout: 8000 });
    this.pool.on("error", () => process.stderr.write("Company reputation evidence database connection failure\n"));
    this.ready = this.pool.query(
      `CREATE TABLE IF NOT EXISTS rafid_company_evidence_cache (
        provider_id text NOT NULL,
        identity_key text NOT NULL,
        evidence jsonb NOT NULL,
        evidence_count integer NOT NULL,
        fetched_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL,
        write_count integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (provider_id, identity_key)
      )`
    ).then(() => this.pool.query(
      `CREATE INDEX IF NOT EXISTS rafid_company_evidence_cache_expires_idx ON rafid_company_evidence_cache (expires_at)`
    )).then(() => undefined);
    this.ready.catch(() => {});
  }

  async get(providerId: string, identityKey: string): Promise<CachedEvidenceSet | null> {
    await this.ready;
    const result = await this.pool.query(
      `SELECT evidence, fetched_at, expires_at FROM rafid_company_evidence_cache WHERE provider_id = $1 AND identity_key = $2`,
      [providerId, identityKey]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      providerId, identityKey,
      evidence: row.evidence as NormalizedEvidence[],
      fetchedAt: new Date(row.fetched_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString()
    };
  }

  async put(set: CachedEvidenceSet): Promise<void> {
    await this.ready;
    await this.pool.query(
      `INSERT INTO rafid_company_evidence_cache (provider_id, identity_key, evidence, evidence_count, fetched_at, expires_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6)
       ON CONFLICT (provider_id, identity_key) DO UPDATE SET
         evidence = EXCLUDED.evidence, evidence_count = EXCLUDED.evidence_count,
         fetched_at = EXCLUDED.fetched_at, expires_at = EXCLUDED.expires_at,
         write_count = rafid_company_evidence_cache.write_count + 1, updated_at = now()`,
      [set.providerId, set.identityKey, JSON.stringify(set.evidence), set.evidence.length, set.fetchedAt, set.expiresAt]
    );
  }

  async close(): Promise<void> { await this.pool.end(); }
}
