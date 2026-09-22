import { Pool } from "pg";

/**
 * Lightweight, storage-agnostic usage tracking. UsageRepository is the seam a durable store
 * plugs into without changing any call site — PostgresUsageRepository below is that durable
 * store (its own `rafid_agent_usage` table, independent of the customer usage table in
 * src/db/store.ts); Console/MemoryUsageRepository remain available for development and tests.
 *
 * Never put a raw API key, wallet private key, payment proof/signature, or request body value
 * in a UsageRecord. `keyIdentifier` must already be a redacted/derived identifier (e.g. the
 * existing `configured-key-${index}`, a customer UUID, or an `x402:<network>`/`mcp-remote` tag
 * — never the secret itself).
 */
export interface UsageRecord {
  requestId: string;
  keyIdentifier: string;
  toolName: string;
  /** Which access model the call came through: "api-key", "x402", or "mcp-remote". Never a
   *  fourth mode for local stdio — that channel stays intentionally unmetered (see README). */
  accessMode: string;
  timestamp: string;
  status: number;
  durationMs: number;
  billableAmount: number;
  currency: string;
}

export interface UsageRepository {
  record(entry: UsageRecord): void | Promise<void>;
}

/** Writes each usage record as one JSON line to stderr (visible in `vercel logs` / local stderr
 *  today). The intended default once this ships to real traffic. */
export class ConsoleUsageRepository implements UsageRepository {
  record(entry: UsageRecord): void {
    process.stderr.write(`${JSON.stringify({ usage: entry })}\n`);
  }
}

/** In-memory usage log; entries are lost on process restart/redeploy. Has no side effects on
 *  import or construction, so it is the safe default for createApp() and for tests. */
export class MemoryUsageRepository implements UsageRepository {
  private readonly entries: UsageRecord[] = [];
  record(entry: UsageRecord): void {
    this.entries.push(entry);
  }
  list(): readonly UsageRecord[] {
    return this.entries;
  }
  clear(): void {
    this.entries.length = 0;
  }
}

/**
 * Durable, queryable usage ledger backed by PostgreSQL. Independent of the customer/API-key
 * store in src/db/store.ts (its own `rafid_agent_usage` table, no shared schema) so it can
 * record usage for every access mode — API-key, x402 and remote MCP — including calls that
 * never touch a customer record (x402, mcp-remote).
 *
 * Only safe operational metadata is ever written or read back here — requestId, a redacted
 * keyIdentifier, tool name, accessMode, status, duration, billableAmount and currency. Never a
 * private key, a payment proof/signature, or a raw API key: callers must already have redacted
 * those before calling record() (see billing/service.ts's recordUsage and api/app.ts /
 * mcp/remote.ts's call sites), and this class has no field to carry them even if one tried.
 */
export class PostgresUsageRepository implements UsageRepository {
  private readonly pool: Pool;
  private readonly ready: Promise<void>;
  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 5000, statement_timeout: 10000, idle_in_transaction_session_timeout: 10000 });
    this.pool.on("error", () => process.stderr.write("Usage database connection failure\n"));
    this.ready = this.pool.query(
      `CREATE TABLE IF NOT EXISTS rafid_agent_usage (
        id bigserial PRIMARY KEY,
        request_id text NOT NULL,
        key_identifier text NOT NULL,
        tool_name text NOT NULL,
        access_mode text NOT NULL,
        status integer NOT NULL,
        duration_ms double precision NOT NULL,
        billable_amount numeric(12,4) NOT NULL,
        currency text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`
    ).then(() => undefined);
  }
  async record(entry: UsageRecord): Promise<void> {
    await this.ready;
    await this.pool.query(
      `INSERT INTO rafid_agent_usage(request_id,key_identifier,tool_name,access_mode,status,duration_ms,billable_amount,currency,created_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [entry.requestId, entry.keyIdentifier, entry.toolName, entry.accessMode, entry.status, entry.durationMs, entry.billableAmount, entry.currency, entry.timestamp]
    );
  }
  /** Most recent records, newest first — for operational inspection, never exposed on a public
   *  route (a keyIdentifier, while redacted, is still per-customer/channel operational data). */
  async recent(limit = 100): Promise<UsageRecord[]> {
    await this.ready;
    const result = await this.pool.query(
      `SELECT request_id,key_identifier,tool_name,access_mode,status,duration_ms,billable_amount,currency,created_at
       FROM rafid_agent_usage ORDER BY created_at DESC LIMIT $1`,
      [Math.max(1, Math.min(1000, Math.trunc(limit)))]
    );
    return result.rows.map(r => ({
      requestId: r.request_id, keyIdentifier: r.key_identifier, toolName: r.tool_name, accessMode: r.access_mode,
      status: r.status, durationMs: Number(r.duration_ms), billableAmount: Number(r.billable_amount), currency: r.currency,
      timestamp: (r.created_at as Date).toISOString()
    }));
  }
  async close(): Promise<void> {
    await this.pool.end();
  }
}
