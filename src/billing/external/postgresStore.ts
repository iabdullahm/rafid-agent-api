import { Pool, type PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { microsFromDb } from "../unified/money.js";
import { EXTERNAL_PAYMENTS_MIGRATIONS } from "./schema.js";
import { ExternalPaymentStoreError, type ExternalPaymentStore } from "./store.js";
import { MAX_QUERY_EXTERNAL_PAYMENTS, type ExternalPayment, type ExternalPaymentInput, type ExternalPaymentProvider, type ExternalPaymentStatus, type TopupIntent, type TopupIntentInput, type TopupIntentStatus } from "./types.js";

export const newExternalId = (prefix: "extpay" | "topup") => `${prefix}_${randomUUID().replace(/-/g, "")}`;

type Row = Record<string, any>;
const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

const toTopup = (r: Row): TopupIntent => ({
  id: r.id, accountId: r.account_id, requestedAmountAtomic: microsFromDb(r.requested_amount_atomic),
  amountUsdcAtomic: microsFromDb(r.amount_usdc_atomic), network: r.network, chainId: r.chain_id, asset: "USDC",
  recipient: r.recipient, status: r.status, transactionHash: r.transaction_hash, externalPaymentId: r.external_payment_id,
  expiresAt: iso(r.expires_at), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), metadata: r.metadata ?? {}
});
const toPayment = (r: Row): ExternalPayment => ({
  id: r.id, accountId: r.account_id, provider: r.provider, providerPaymentId: r.provider_payment_id, providerEventId: r.provider_event_id,
  topupId: r.topup_id, amountAtomic: microsFromDb(r.amount_atomic), currency: "USD", network: r.network, asset: r.asset,
  transactionHash: r.transaction_hash, status: r.status, confirmedAt: isoOrNull(r.confirmed_at),
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), metadata: r.metadata ?? {}
});

/** Production ExternalPaymentStore on PostgreSQL — same migration/transaction discipline as
 *  billing/unified/postgresStore.ts's PostgresBillingStore (see that file's doc comment); a
 *  distinct advisory-lock id (74382078, vs. unified billing's 74382077) so the two migration
 *  runners never contend if they somehow raced. */
export class PostgresExternalPaymentStore implements ExternalPaymentStore {
  readonly pool: Pool;
  private migrated: Promise<void> | null = null;
  constructor(databaseUrl: string, options: { poolMax?: number } = {}) {
    this.pool = new Pool({ connectionString: databaseUrl, max: options.poolMax ?? 10, connectionTimeoutMillis: 5000, statement_timeout: 10000, idle_in_transaction_session_timeout: 10000 });
    this.pool.on("error", () => process.stderr.write("External payments database connection failure\n"));
  }

  async migrate(): Promise<void> {
    await this.tx(async c => {
      await c.query("SELECT pg_advisory_xact_lock(74382078)");
      await c.query("CREATE TABLE IF NOT EXISTS rafid_external_payments_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      const done = new Set((await c.query("SELECT version FROM rafid_external_payments_migrations")).rows.map(r => Number(r.version)));
      for (const m of EXTERNAL_PAYMENTS_MIGRATIONS) {
        if (done.has(m.version)) continue;
        await c.query(m.sql);
        await c.query("INSERT INTO rafid_external_payments_migrations(version) VALUES($1)", [m.version]);
      }
    }, false);
  }
  private ready(): Promise<void> {
    if (!this.migrated) this.migrated = this.migrate().catch(error => { this.migrated = null; throw error; });
    return this.migrated;
  }
  private async tx<T>(fn: (c: PoolClient) => Promise<T>, ensureReady = true): Promise<T> {
    if (ensureReady) await this.ready();
    const c = await this.pool.connect();
    try { await c.query("BEGIN"); const result = await fn(c); await c.query("COMMIT"); return result; }
    catch (error) { await c.query("ROLLBACK").catch(() => {}); throw error; }
    finally { c.release(); }
  }
  private async q(sql: string, params: unknown[] = []) { await this.ready(); return this.pool.query(sql, params); }
  async close() { await this.pool.end(); }

  async createTopupIntent(input: TopupIntentInput): Promise<TopupIntent> {
    return this.tx(async c => {
      const r = await c.query(
        `INSERT INTO rafid_topup_intents(id,account_id,requested_amount_atomic,amount_usdc_atomic,network,chain_id,asset,recipient,status,transaction_hash,external_payment_id,expires_at,metadata)
         VALUES($1,$2,$3,$4,$5,$6,'USDC',$7,$8,$9,$10,$11,$12) RETURNING *`,
        [input.id, input.accountId, input.requestedAmountAtomic, input.amountUsdcAtomic, input.network, input.chainId, input.recipient, input.status, input.transactionHash, input.externalPaymentId, input.expiresAt, input.metadata ?? {}]
      ).catch(e => { if (String((e as Error).message).includes("rafid_topup_intents_open_amount_uniq")) throw new ExternalPaymentStoreError("amount_collision", "This tagged amount is already claimed by another open top-up intent"); throw e; });
      return toTopup(r.rows[0]);
    });
  }
  async getTopupIntent(id: string) { const r = await this.q("SELECT * FROM rafid_topup_intents WHERE id=$1", [id]); return r.rows[0] ? toTopup(r.rows[0]) : null; }
  async isAmountOpen(recipient: string, amountUsdcAtomic: number): Promise<boolean> {
    const r = await this.q("SELECT 1 FROM rafid_topup_intents WHERE recipient=$1 AND amount_usdc_atomic=$2 AND status='pending' LIMIT 1", [recipient, amountUsdcAtomic]);
    return r.rowCount! > 0;
  }
  async updateTopupIntent(id: string, patch: Partial<Pick<TopupIntent, "status" | "transactionHash" | "externalPaymentId" | "metadata">>) {
    const r = await this.q(
      `UPDATE rafid_topup_intents SET
         status = COALESCE($2, status), transaction_hash = COALESCE($3, transaction_hash),
         external_payment_id = COALESCE($4, external_payment_id), metadata = COALESCE($5, metadata), updated_at = now()
       WHERE id=$1 RETURNING *`,
      [id, patch.status ?? null, patch.transactionHash ?? null, patch.externalPaymentId ?? null, patch.metadata ? JSON.stringify(patch.metadata) : null]
    );
    return r.rows[0] ? toTopup(r.rows[0]) : null;
  }
  async expireStaleTopupIntents(now: Date): Promise<number> {
    const r = await this.q("UPDATE rafid_topup_intents SET status='expired', updated_at=$1 WHERE status='pending' AND expires_at < $1", [now]);
    return r.rowCount ?? 0;
  }
  async listTopupIntents(opts: { accountId?: string; status?: TopupIntentStatus; limit?: number }): Promise<TopupIntent[]> {
    const limit = Math.max(1, Math.min(MAX_QUERY_EXTERNAL_PAYMENTS, Math.trunc(opts.limit ?? 500)));
    const clauses: string[] = []; const params: unknown[] = [];
    if (opts.accountId) { params.push(opts.accountId); clauses.push(`account_id=$${params.length}`); }
    if (opts.status) { params.push(opts.status); clauses.push(`status=$${params.length}`); }
    params.push(limit);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const r = await this.q(`SELECT * FROM rafid_topup_intents ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return r.rows.map(toTopup);
  }

  async createExternalPayment(input: ExternalPaymentInput): Promise<ExternalPayment> {
    const r = await this.q(
      `INSERT INTO rafid_external_payments(id,account_id,provider,provider_payment_id,provider_event_id,topup_id,amount_atomic,currency,network,asset,transaction_hash,status,confirmed_at,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7,'USD',$8,$9,$10,$11,$12,$13) RETURNING *`,
      [input.id, input.accountId, input.provider, input.providerPaymentId, input.providerEventId, input.topupId, input.amountAtomic, input.network, input.asset, input.transactionHash, input.status, input.confirmedAt, input.metadata ?? {}]
    ).catch(e => { throw mapUniqueViolation(e as Error); });
    return toPayment(r.rows[0]);
  }
  async getExternalPayment(id: string) { const r = await this.q("SELECT * FROM rafid_external_payments WHERE id=$1", [id]); return r.rows[0] ? toPayment(r.rows[0]) : null; }
  async findExternalPaymentByProviderPaymentId(provider: ExternalPaymentProvider, providerPaymentId: string) {
    const r = await this.q("SELECT * FROM rafid_external_payments WHERE provider=$1 AND provider_payment_id=$2 ORDER BY created_at DESC LIMIT 1", [provider, providerPaymentId]);
    return r.rows[0] ? toPayment(r.rows[0]) : null;
  }
  async findExternalPaymentByEventId(provider: ExternalPaymentProvider, providerEventId: string) {
    const r = await this.q("SELECT * FROM rafid_external_payments WHERE provider=$1 AND provider_event_id=$2", [provider, providerEventId]);
    return r.rows[0] ? toPayment(r.rows[0]) : null;
  }
  async findExternalPaymentByTransactionHash(provider: ExternalPaymentProvider, transactionHash: string) {
    const r = await this.q("SELECT * FROM rafid_external_payments WHERE provider=$1 AND transaction_hash=$2", [provider, transactionHash]);
    return r.rows[0] ? toPayment(r.rows[0]) : null;
  }
  async updateExternalPayment(id: string, patch: Partial<Pick<ExternalPayment, "status" | "providerEventId" | "providerPaymentId" | "transactionHash" | "amountAtomic" | "confirmedAt" | "metadata">>) {
    const r = await this.q(
      `UPDATE rafid_external_payments SET
         status = COALESCE($2, status), provider_event_id = COALESCE($3, provider_event_id),
         provider_payment_id = COALESCE($4, provider_payment_id), transaction_hash = COALESCE($5, transaction_hash),
         amount_atomic = COALESCE($6, amount_atomic), confirmed_at = COALESCE($7, confirmed_at),
         metadata = COALESCE($8, metadata), updated_at = now()
       WHERE id=$1 RETURNING *`,
      [id, patch.status ?? null, patch.providerEventId ?? null, patch.providerPaymentId ?? null, patch.transactionHash ?? null, patch.amountAtomic ?? null, patch.confirmedAt ?? null, patch.metadata ? JSON.stringify(patch.metadata) : null]
    ).catch(e => { throw mapUniqueViolation(e as Error); });
    return r.rows[0] ? toPayment(r.rows[0]) : null;
  }
  async listExternalPayments(opts: { since: Date | null; accountId?: string; provider?: ExternalPaymentProvider; status?: ExternalPaymentStatus; limit?: number }): Promise<ExternalPayment[]> {
    const limit = Math.max(1, Math.min(MAX_QUERY_EXTERNAL_PAYMENTS, Math.trunc(opts.limit ?? MAX_QUERY_EXTERNAL_PAYMENTS)));
    const clauses: string[] = []; const params: unknown[] = [];
    if (opts.since) { params.push(opts.since); clauses.push(`created_at >= $${params.length}`); }
    if (opts.accountId) { params.push(opts.accountId); clauses.push(`account_id=$${params.length}`); }
    if (opts.provider) { params.push(opts.provider); clauses.push(`provider=$${params.length}`); }
    if (opts.status) { params.push(opts.status); clauses.push(`status=$${params.length}`); }
    params.push(limit);
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const r = await this.q(`SELECT * FROM rafid_external_payments ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return r.rows.map(toPayment);
  }
}

function mapUniqueViolation(e: Error): Error {
  const msg = String(e.message);
  if (msg.includes("rafid_external_payments_provider_event_uniq")) return new ExternalPaymentStoreError("duplicate_event", "This provider event has already been recorded");
  if (msg.includes("rafid_external_payments_tx_hash_uniq")) return new ExternalPaymentStoreError("duplicate_transaction_hash", "This transaction hash has already been recorded");
  return e;
}
