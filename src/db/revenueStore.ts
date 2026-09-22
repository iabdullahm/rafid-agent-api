import { Pool } from "pg";
import type { RevenueLedger, RevenueSettlement, RevenueSettlementInput } from "../revenue/types.js";
import { MAX_QUERY_SETTLEMENTS } from "../revenue/types.js";

/**
 * Durable, queryable x402 settlement ledger backed by PostgreSQL — the trustworthy accounting
 * record (see revenue/types.ts's doc comment). Its own table, `rafid_x402_settlements`,
 * independent of every other store in src/db/, mirroring PostgresAnalyticsRepository's structure
 * (one additive `CREATE TABLE IF NOT EXISTS`, no shared migration ledger — an append-only log has
 * no prior schema version to migrate from).
 *
 * Idempotency (see revenue/idempotency.ts for the key-construction strategy): `dedupe_key` has a
 * real UNIQUE constraint, and every insert uses `ON CONFLICT (dedupe_key) DO NOTHING` — the exact
 * same settlement observed twice (a client retry, a duplicate res.on("finish") firing, or a
 * future async redelivery) can never produce two rows, enforced by the database itself, not just
 * application-level care.
 */
export class PostgresRevenueLedger implements RevenueLedger {
  private readonly pool: Pool;
  private readonly ready: Promise<void>;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 5000, statement_timeout: 10000, idle_in_transaction_session_timeout: 10000 });
    this.pool.on("error", () => process.stderr.write("Revenue ledger database connection failure\n"));
    this.ready = this.pool.query(
      `CREATE TABLE IF NOT EXISTS rafid_x402_settlements (
        id bigserial PRIMARY KEY,
        request_id text NOT NULL,
        tool_name text NOT NULL,
        capability_name text NOT NULL,
        amount_atomic text,
        amount_decimal numeric(18,6),
        amount_source text NOT NULL,
        currency text,
        network text NOT NULL,
        asset text,
        payer_address text,
        pay_to_address text NOT NULL,
        transaction_hash text,
        status text NOT NULL,
        facilitator text NOT NULL,
        error_reason text,
        payment_verified_at timestamptz NOT NULL,
        settled_at timestamptz,
        dedupe_key text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )`
    ).then(() => this.pool.query(
      // The idempotency guarantee itself — see this class's doc comment.
      `CREATE UNIQUE INDEX IF NOT EXISTS rafid_x402_settlements_dedupe_key_idx ON rafid_x402_settlements (dedupe_key)`
    )).then(() => this.pool.query(
      // Every read (query/count) filters by created_at.
      `CREATE INDEX IF NOT EXISTS rafid_x402_settlements_created_at_idx ON rafid_x402_settlements (created_at DESC)`
    )).then(() => this.pool.query(
      // Reconciliation's duplicate_transaction_hash check and revenue-by-tool both filter/group
      // on these.
      `CREATE INDEX IF NOT EXISTS rafid_x402_settlements_tx_hash_idx ON rafid_x402_settlements (transaction_hash) WHERE transaction_hash IS NOT NULL`
    )).then(() => this.pool.query(
      `CREATE INDEX IF NOT EXISTS rafid_x402_settlements_tool_name_idx ON rafid_x402_settlements (tool_name)`
    )).then(() => undefined);
  }

  async record(input: RevenueSettlementInput): Promise<void> {
    await this.ready;
    await this.pool.query(
      `INSERT INTO rafid_x402_settlements(
        request_id, tool_name, capability_name, amount_atomic, amount_decimal, amount_source,
        currency, network, asset, payer_address, pay_to_address, transaction_hash, status,
        facilitator, error_reason, payment_verified_at, settled_at, dedupe_key, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        input.requestId, input.toolName, input.capabilityName, input.amountAtomic, input.amountDecimal,
        input.amountSource, input.currency, input.network, input.asset, input.payerAddress,
        input.payToAddress, input.transactionHash, input.status, input.facilitator, input.errorReason,
        input.paymentVerifiedAt, input.settledAt, input.dedupeKey, input.createdAt ?? new Date().toISOString()
      ]
    );
  }

  async query(args: { since: Date | null; limit?: number; offset?: number }): Promise<RevenueSettlement[]> {
    await this.ready;
    const limit = Math.min(args.limit ?? MAX_QUERY_SETTLEMENTS, MAX_QUERY_SETTLEMENTS);
    const offset = args.offset ?? 0;
    const result = args.since
      ? await this.pool.query(
          `SELECT * FROM rafid_x402_settlements WHERE created_at >= $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
          [args.since.toISOString(), limit, offset]
        )
      : await this.pool.query(
          `SELECT * FROM rafid_x402_settlements ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
          [limit, offset]
        );
    return result.rows.map(rowToSettlement);
  }

  async count(since: Date | null): Promise<number> {
    await this.ready;
    const result = since
      ? await this.pool.query(`SELECT count(*)::int AS n FROM rafid_x402_settlements WHERE created_at >= $1`, [since.toISOString()])
      : await this.pool.query(`SELECT count(*)::int AS n FROM rafid_x402_settlements`);
    return result.rows[0].n as number;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

function rowToSettlement(r: Record<string, unknown>): RevenueSettlement {
  return {
    requestId: r.request_id as string, toolName: r.tool_name as string, capabilityName: r.capability_name as string,
    amountAtomic: r.amount_atomic as string | null,
    amountDecimal: r.amount_decimal === null ? null : Number(r.amount_decimal),
    amountSource: r.amount_source as RevenueSettlement["amountSource"],
    currency: r.currency as string | null, network: r.network as string, asset: r.asset as string | null,
    payerAddress: r.payer_address as string | null, payToAddress: r.pay_to_address as string,
    transactionHash: r.transaction_hash as string | null, status: r.status as RevenueSettlement["status"],
    facilitator: r.facilitator as string, errorReason: r.error_reason as string | null,
    paymentVerifiedAt: (r.payment_verified_at as Date).toISOString(),
    settledAt: r.settled_at === null ? null : (r.settled_at as Date).toISOString(),
    dedupeKey: r.dedupe_key as string, createdAt: (r.created_at as Date).toISOString()
  };
}
