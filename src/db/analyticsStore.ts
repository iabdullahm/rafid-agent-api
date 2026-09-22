import { Pool } from "pg";
import type { AnalyticsEvent, AnalyticsEventInput, AnalyticsRepository } from "../analytics/types.js";
import { MAX_QUERY_EVENTS } from "../analytics/types.js";

/**
 * Durable, queryable analytics event log backed by PostgreSQL. Independent of every other store
 * in src/db/ (its own `rafid_analytics_events` table, no shared schema, no migration ledger —
 * one additive `CREATE TABLE IF NOT EXISTS` is enough for an append-only event log with no prior
 * versions to migrate from, exactly like PostgresUsageRepository in billing/usage.ts, which this
 * class deliberately mirrors in structure).
 *
 * Only the fields AnalyticsEvent already restricts itself to are ever written or read back —
 * see analytics/types.ts's doc comment for the full "never store a secret" discipline. This
 * class has no column for a raw API key, private key, payment proof, or authorization header,
 * even if a caller tried to pass one.
 */
export class PostgresAnalyticsRepository implements AnalyticsRepository {
  private readonly pool: Pool;
  private readonly ready: Promise<void>;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 5000, statement_timeout: 10000, idle_in_transaction_session_timeout: 10000 });
    this.pool.on("error", () => process.stderr.write("Analytics database connection failure\n"));
    this.ready = this.pool.query(
      `CREATE TABLE IF NOT EXISTS rafid_analytics_events (
        id bigserial PRIMARY KEY,
        category text NOT NULL,
        event_type text NOT NULL,
        path text,
        tool_name text,
        success boolean,
        duration_ms double precision,
        amount numeric(12,4),
        currency text,
        tx_hash text,
        data_source text,
        client_hash text,
        user_agent text,
        referer text,
        client_name text,
        created_at timestamptz NOT NULL DEFAULT now()
      )`
    ).then(() => this.pool.query(
      // Every query filters by created_at (queryEvents) — one index covers the whole read path.
      `CREATE INDEX IF NOT EXISTS rafid_analytics_events_created_at_idx ON rafid_analytics_events (created_at DESC)`
    )).then(() => undefined);
  }

  async record(event: AnalyticsEventInput): Promise<void> {
    await this.ready;
    await this.pool.query(
      `INSERT INTO rafid_analytics_events(
        category, event_type, path, tool_name, success, duration_ms, amount, currency, tx_hash,
        data_source, client_hash, user_agent, referer, client_name, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [
        event.category, event.eventType, event.path, event.toolName, event.success, event.durationMs,
        event.amount, event.currency, event.txHash, event.dataSource, event.clientHash, event.userAgent,
        event.referer, event.clientName, event.createdAt ?? new Date().toISOString()
      ]
    );
  }

  async queryEvents(since: Date): Promise<AnalyticsEvent[]> {
    await this.ready;
    const result = await this.pool.query(
      `SELECT category, event_type, path, tool_name, success, duration_ms, amount, currency, tx_hash,
              data_source, client_hash, user_agent, referer, client_name, created_at
       FROM rafid_analytics_events WHERE created_at >= $1 ORDER BY created_at DESC LIMIT $2`,
      [since.toISOString(), MAX_QUERY_EVENTS]
    );
    return result.rows.map(r => ({
      category: r.category, eventType: r.event_type, path: r.path, toolName: r.tool_name,
      success: r.success, durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
      amount: r.amount === null ? null : Number(r.amount), currency: r.currency, txHash: r.tx_hash,
      dataSource: r.data_source, clientHash: r.client_hash, userAgent: r.user_agent, referer: r.referer,
      clientName: r.client_name, createdAt: (r.created_at as Date).toISOString()
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
