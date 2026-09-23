import { Pool } from "pg";
import type { EvidenceSource, ProviderResult } from "./types.js";

/**
 * Provider-evidence cache for oman_supplier_check.
 *
 * WHAT THIS IS: a TTL cache of individual provider observations (a registry lookup, a website
 * inspection, a sanctions-list screen, a public-web search), keyed by (providerId, normalized
 * evidence key). It exists so a supplier that is screened repeatedly does not trigger the same
 * upstream calls every time (spec: "Supplier information does not need to be fetched repeatedly
 * for every call"), and so repeated identical calls are idempotent: a write is always an UPSERT
 * on the (provider_id, evidence_key) primary key — a second call updates the same row, never
 * inserts a duplicate.
 *
 * WHAT THIS IS NOT: a second company-record / source-evidence model. Canonical company identity
 * and its per-source provenance stay exclusively in the existing Oman company registry
 * (oman_companies rows sharing a companyId — src/business-data/sources/companyRepository.ts).
 * This cache is never read by search_oman_company/get_oman_company_profile, never merged into
 * canonical records, and never promotes caller-supplied data (a website URL an API caller typed
 * in) into the registry — doing that would let any caller write unverified "facts" about a
 * company into Rafid's canonical data. Evidence rows only carry a nullable `company_id` pointer
 * back to the canonical companyId they were resolved against.
 *
 * The FINAL screening result (risk level, suitability) is never cached — it is recomputed from
 * (possibly cached) evidence on every call, so a TTL expiry on any one evidence type is picked up
 * immediately (spec: "Do not cache final risk forever because underlying data can change").
 */

export interface StoredEvidence<T> {
  result: ProviderResult<T>;
  checkedAt: string;
  expiresAt: string;
}

export interface EvidenceStore {
  readonly name: string;
  get<T>(providerId: string, key: string, now: Date): Promise<StoredEvidence<T> | null>;
  /** Idempotent upsert on (providerId, key). */
  put<T>(providerId: string, key: string, value: StoredEvidence<T>, companyId: string | null): Promise<void>;
}

export class MemoryEvidenceStore implements EvidenceStore {
  readonly name = "memory";
  private readonly rows = new Map<string, { value: StoredEvidence<unknown>; companyId: string | null; writes: number }>();

  async get<T>(providerId: string, key: string, now: Date): Promise<StoredEvidence<T> | null> {
    const row = this.rows.get(`${providerId}␟${key}`);
    if (!row) return null;
    if (Date.parse(row.value.expiresAt) <= now.getTime()) return null;
    return row.value as StoredEvidence<T>;
  }

  async put<T>(providerId: string, key: string, value: StoredEvidence<T>, companyId: string | null): Promise<void> {
    const id = `${providerId}␟${key}`;
    const existing = this.rows.get(id);
    this.rows.set(id, { value: value as StoredEvidence<unknown>, companyId, writes: (existing?.writes ?? 0) + 1 });
  }

  /** Tests/diagnostics only. */
  get size(): number { return this.rows.size; }
  writesFor(providerId: string, key: string): number { return this.rows.get(`${providerId}␟${key}`)?.writes ?? 0; }
  clear(): void { this.rows.clear(); }
}

/**
 * Durable evidence cache — one additive `CREATE TABLE IF NOT EXISTS` (no migration ledger), the
 * same pattern as PostgresAnalyticsRepository / PostgresUsageRepository. Every failure is
 * swallowed by the caller (cachedProviderCall): a database outage only means "no cache", never a
 * failed paid call.
 */
export class PostgresEvidenceStore implements EvidenceStore {
  readonly name = "postgres";
  private readonly pool: Pool;
  private readonly ready: Promise<void>;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 3, connectionTimeoutMillis: 5000, statement_timeout: 8000, idle_in_transaction_session_timeout: 8000 });
    this.pool.on("error", () => process.stderr.write("Supplier evidence database connection failure\n"));
    this.ready = this.pool.query(
      `CREATE TABLE IF NOT EXISTS rafid_supplier_evidence (
        provider_id text NOT NULL,
        evidence_key text NOT NULL,
        company_id text,
        status text NOT NULL,
        evidence jsonb NOT NULL,
        checked_at timestamptz NOT NULL,
        expires_at timestamptz NOT NULL,
        write_count integer NOT NULL DEFAULT 1,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (provider_id, evidence_key)
      )`
    ).then(() => this.pool.query(
      `CREATE INDEX IF NOT EXISTS rafid_supplier_evidence_company_idx ON rafid_supplier_evidence (company_id) WHERE company_id IS NOT NULL`
    )).then(() => undefined);
    // Never let an unhandled rejection escape if the database is unreachable at construction.
    this.ready.catch(() => {});
  }

  async get<T>(providerId: string, key: string, now: Date): Promise<StoredEvidence<T> | null> {
    await this.ready;
    const result = await this.pool.query(
      `SELECT evidence, checked_at, expires_at FROM rafid_supplier_evidence WHERE provider_id = $1 AND evidence_key = $2 AND expires_at > $3`,
      [providerId, key, now.toISOString()]
    );
    const row = result.rows[0];
    if (!row) return null;
    return { result: row.evidence as ProviderResult<T>, checkedAt: new Date(row.checked_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString() };
  }

  async put<T>(providerId: string, key: string, value: StoredEvidence<T>, companyId: string | null): Promise<void> {
    await this.ready;
    await this.pool.query(
      `INSERT INTO rafid_supplier_evidence (provider_id, evidence_key, company_id, status, evidence, checked_at, expires_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
       ON CONFLICT (provider_id, evidence_key) DO UPDATE SET
         company_id = EXCLUDED.company_id, status = EXCLUDED.status, evidence = EXCLUDED.evidence,
         checked_at = EXCLUDED.checked_at, expires_at = EXCLUDED.expires_at,
         write_count = rafid_supplier_evidence.write_count + 1, updated_at = now()`,
      [providerId, key, companyId, value.result.status, JSON.stringify(value.result), value.checkedAt, value.expiresAt]
    );
  }

  /** Tests/diagnostics only. */
  async countRows(providerId?: string): Promise<number> {
    await this.ready;
    const result = providerId
      ? await this.pool.query(`SELECT count(*)::int AS n FROM rafid_supplier_evidence WHERE provider_id = $1`, [providerId])
      : await this.pool.query(`SELECT count(*)::int AS n FROM rafid_supplier_evidence`);
    return result.rows[0].n as number;
  }

  async close(): Promise<void> { await this.pool.end(); }
}

/**
 * Runs `fetch` through the cache: a fresh cached "ok" result is served as-is (including its
 * ORIGINAL checkedAt, so the output always states when the evidence was really obtained);
 * otherwise the provider is called and an "ok" result is upserted. Non-ok results
 * (not_configured/unavailable/not_applicable) are never cached — an outage must not be
 * remembered as "no evidence" for days. Cache read/write failures degrade to a direct call.
 */
export async function cachedProviderCall<T>(
  store: EvidenceStore,
  providerId: string,
  key: string,
  ttlMs: number,
  now: Date,
  fetch: () => Promise<ProviderResult<T>>,
  companyIdOf: (result: ProviderResult<T>) => string | null = () => null
): Promise<ProviderResult<T>> {
  try {
    const hit = await store.get<T>(providerId, key, now);
    if (hit && hit.result.status === "ok") return hit.result;
  } catch { /* cache unavailable — fall through to a live call */ }

  const result = await fetch();
  if (result.status === "ok" && ttlMs > 0) {
    const checkedAt = firstCheckedAt(result.sources) ?? now.toISOString();
    try {
      await store.put(providerId, key, { result, checkedAt, expiresAt: new Date(now.getTime() + ttlMs).toISOString() }, companyIdOf(result));
    } catch { /* cache write failure never fails the call */ }
  }
  return result;
}

function firstCheckedAt(sources: readonly EvidenceSource[]): string | null {
  return sources[0]?.checkedAt ?? null;
}
