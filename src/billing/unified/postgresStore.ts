import { Pool, type PoolClient } from "pg";
import { newId } from "./apiKeys.js";
import { microsFromDb } from "./money.js";
import { addMonthsUtc, currentPeriod } from "./plans.js";
import { BILLING_MIGRATIONS } from "./schema.js";
import { BillingStoreError, type BillingStore } from "./store.js";
import type { AccountStatus, ApiKeyEnvironment, ApiKeyRecord, BillingAccount, LedgerEntry, ReleaseInput, ReserveInput, ReserveResult, SettleInput, Subscription, SubscriptionSnapshot, UsageSummaryRow } from "./types.js";

type Row = Record<string, any>;
const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();
const isoOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : iso(v));

const toAccount = (r: Row): BillingAccount => ({ id: r.id, name: r.name, email: r.email, status: r.status, currency: "USD", creditBalanceMicros: microsFromDb(r.credit_balance_micros), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), metadata: r.metadata ?? {} });
const toKey = (r: Row): ApiKeyRecord => ({ id: r.id, accountId: r.account_id, keyPrefix: r.key_prefix, keyHash: r.key_hash, environment: r.environment, name: r.name, status: r.status, createdAt: iso(r.created_at), lastUsedAt: isoOrNull(r.last_used_at), expiresAt: isoOrNull(r.expires_at), revokedAt: isoOrNull(r.revoked_at), metadata: r.metadata ?? {} });
const toEntry = (r: Row): LedgerEntry => ({ id: r.id, accountId: r.account_id, apiKeyId: r.api_key_id, requestId: r.request_id, toolName: r.tool_name, type: r.type, amountMicros: microsFromDb(r.amount_micros), currency: "USD", rail: r.rail, status: r.status, externalTransactionId: r.external_transaction_id, relatedEntryId: r.related_entry_id, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at), metadata: r.metadata ?? {} });

/**
 * Production BillingStore on PostgreSQL.
 *
 * Concurrency model: every money-moving operation is ONE transaction that first takes a row lock
 * on the account (`SELECT … FOR UPDATE`) — so all charges, refunds and top-ups for one account are
 * serialized — and then moves money with a CONDITIONAL update (`… WHERE credit_balance_micros >=
 * $price`, `… WHERE used_micros + $price <= included_micros`). Even if the lock were somehow
 * bypassed, the conditional update plus the table CHECK constraints make an overspend impossible:
 * two simultaneous $0.25 calls against $0.30 can never both succeed. Lock order is always
 * account → ledger/idempotency rows, so reserve/release/top-up cannot deadlock one another.
 */
export class PostgresBillingStore implements BillingStore {
  readonly pool: Pool;
  private migrated: Promise<void> | null = null;
  constructor(databaseUrl: string, options: { poolMax?: number } = {}) {
    this.pool = new Pool({ connectionString: databaseUrl, max: options.poolMax ?? 10, connectionTimeoutMillis: 5000, statement_timeout: 10000, idle_in_transaction_session_timeout: 10000 });
    this.pool.on("error", () => process.stderr.write("Billing database connection failure\n"));
  }

  async migrate(): Promise<void> {
    await this.tx(async c => {
      await c.query("SELECT pg_advisory_xact_lock(74382077)");
      await c.query("CREATE TABLE IF NOT EXISTS rafid_billing_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      const done = new Set((await c.query("SELECT version FROM rafid_billing_migrations")).rows.map(r => Number(r.version)));
      for (const m of BILLING_MIGRATIONS) {
        if (done.has(m.version)) continue;
        await c.query(m.sql);
        await c.query("INSERT INTO rafid_billing_migrations(version) VALUES($1)", [m.version]);
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

  async createAccount(input: { name: string; email?: string | null; metadata?: Record<string, unknown> }) {
    const r = await this.q("INSERT INTO billing_accounts(id,name,email,metadata) VALUES($1,$2,$3,$4) RETURNING *", [newId("acct"), input.name, input.email ?? null, input.metadata ?? {}]);
    return toAccount(r.rows[0]);
  }
  async getAccount(accountId: string) { const r = await this.q("SELECT * FROM billing_accounts WHERE id=$1", [accountId]); return r.rows[0] ? toAccount(r.rows[0]) : null; }
  async setAccountStatus(accountId: string, status: AccountStatus) {
    const r = await this.q("UPDATE billing_accounts SET status=$2, updated_at=now() WHERE id=$1 RETURNING *", [accountId, status]);
    if (!r.rows[0]) throw new BillingStoreError("account_not_found", "Billing account not found");
    return toAccount(r.rows[0]);
  }

  async insertApiKey(input: { id: string; accountId: string; keyPrefix: string; keyHash: string; environment: ApiKeyEnvironment; name: string; expiresAt: Date | null; metadata?: Record<string, unknown> }) {
    return this.tx(async c => {
      const a = await c.query("SELECT id FROM billing_accounts WHERE id=$1 FOR UPDATE", [input.accountId]);
      if (!a.rowCount) throw new BillingStoreError("account_not_found", "Billing account not found");
      const r = await c.query("INSERT INTO billing_api_keys(id,account_id,key_prefix,key_hash,environment,name,expires_at,metadata) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *",
        [input.id, input.accountId, input.keyPrefix, input.keyHash, input.environment, input.name, input.expiresAt, input.metadata ?? {}]);
      return toKey(r.rows[0]);
    });
  }
  async findApiKeyByHash(keyHash: string) {
    const r = await this.q(`SELECT to_jsonb(k) AS k, to_jsonb(a) AS a FROM billing_api_keys k JOIN billing_accounts a ON a.id = k.account_id WHERE k.key_hash=$1`, [keyHash]);
    if (!r.rows[0]) return null;
    return { key: toKey(r.rows[0].k), account: toAccount(r.rows[0].a) };
  }
  async touchApiKey(keyId: string, at: Date) {
    // Throttled to one write per key per minute so hot keys don't turn every call into a row write.
    await this.q("UPDATE billing_api_keys SET last_used_at=$2 WHERE id=$1 AND (last_used_at IS NULL OR last_used_at < $2::timestamptz - interval '1 minute')", [keyId, at]);
  }
  async revokeApiKey(accountId: string, keyId: string, at: Date) {
    const r = await this.q("UPDATE billing_api_keys SET status='revoked', revoked_at=COALESCE(revoked_at,$3) WHERE id=$1 AND account_id=$2 RETURNING *", [keyId, accountId, at]);
    if (!r.rows[0]) throw new BillingStoreError("key_not_found", "API key not found for this account");
    return toKey(r.rows[0]);
  }
  async listApiKeys(accountId: string) { return (await this.q("SELECT * FROM billing_api_keys WHERE account_id=$1 ORDER BY created_at", [accountId])).rows.map(toKey); }

  async applyCredit(input: { accountId: string; amountMicros: number; type: "credit" | "adjustment"; reason: string; externalTransactionId?: string | null; now: Date }) {
    if (!Number.isSafeInteger(input.amountMicros) || input.amountMicros === 0 || (input.type === "credit" && input.amountMicros < 0)) throw new BillingStoreError("invalid_amount", "Amount must be a non-zero integer number of micros (positive for a credit)");
    return this.tx(async c => {
      const a = await c.query("SELECT * FROM billing_accounts WHERE id=$1 FOR UPDATE", [input.accountId]);
      if (!a.rows[0]) throw new BillingStoreError("account_not_found", "Billing account not found");
      if (input.externalTransactionId) {
        const dup = await c.query("SELECT * FROM billing_ledger WHERE account_id=$1 AND external_transaction_id=$2 AND type IN ('credit','adjustment')", [input.accountId, input.externalTransactionId]);
        if (dup.rows[0]) return { entry: toEntry(dup.rows[0]), balanceMicros: microsFromDb(a.rows[0].credit_balance_micros), duplicate: true };
      }
      const u = await c.query("UPDATE billing_accounts SET credit_balance_micros = credit_balance_micros + $2, updated_at=$3 WHERE id=$1 AND credit_balance_micros + $2 >= 0 RETURNING credit_balance_micros", [input.accountId, input.amountMicros, input.now]);
      if (!u.rows[0]) throw new BillingStoreError("negative_balance", "Adjustment would make the balance negative");
      const balance = microsFromDb(u.rows[0].credit_balance_micros);
      const e = await this.insertEntry(c, { accountId: input.accountId, apiKeyId: null, requestId: null, toolName: null, type: input.type, amountMicros: input.amountMicros, rail: "admin", status: "settled", externalTransactionId: input.externalTransactionId ?? null, relatedEntryId: null, metadata: { reason: input.reason, balanceAfterMicros: balance } }, input.now);
      return { entry: e, balanceMicros: balance, duplicate: false };
    });
  }

  async assignSubscription(input: { accountId: string; plan: string; includedMicros: number; now: Date }): Promise<Subscription> {
    return this.tx(async c => {
      const a = await c.query("SELECT id FROM billing_accounts WHERE id=$1 FOR UPDATE", [input.accountId]);
      if (!a.rowCount) throw new BillingStoreError("account_not_found", "Billing account not found");
      await c.query("UPDATE billing_subscriptions SET status='canceled', canceled_at=$2 WHERE account_id=$1 AND status='active'", [input.accountId, input.now]);
      const r = await c.query("INSERT INTO billing_subscriptions(id,account_id,plan,status,included_micros,anchor_at,created_at) VALUES($1,$2,$3,'active',$4,$5,$5) RETURNING *", [newId("sub"), input.accountId, input.plan, input.includedMicros, input.now]);
      const row = r.rows[0];
      return { id: row.id, accountId: row.account_id, plan: row.plan, status: "active", includedMicros: microsFromDb(row.included_micros), periodStart: iso(row.anchor_at), periodEnd: addMonthsUtc(new Date(row.anchor_at), 1).toISOString(), createdAt: iso(row.created_at), canceledAt: null };
    });
  }
  async cancelSubscription(accountId: string, now: Date): Promise<Subscription | null> {
    const r = await this.q("UPDATE billing_subscriptions SET status='canceled', canceled_at=$2 WHERE account_id=$1 AND status='active' RETURNING *", [accountId, now]);
    const row = r.rows[0]; if (!row) return null;
    const p = currentPeriod(new Date(row.anchor_at), now);
    return { id: row.id, accountId: row.account_id, plan: row.plan, status: "canceled", includedMicros: microsFromDb(row.included_micros), periodStart: p.start.toISOString(), periodEnd: p.end.toISOString(), createdAt: iso(row.created_at), canceledAt: iso(row.canceled_at) };
  }
  async getSubscription(accountId: string, now: Date) {
    return this.tx(c => this.snapshot(c, accountId, now));
  }
  private async snapshot(c: PoolClient, accountId: string, now: Date): Promise<SubscriptionSnapshot | null> {
    const s = (await c.query("SELECT * FROM billing_subscriptions WHERE account_id=$1 AND status='active'", [accountId])).rows[0];
    if (!s) return null;
    const p = currentPeriod(new Date(s.anchor_at), now);
    await c.query("INSERT INTO subscription_usage(subscription_id,period_start,period_end,included_micros) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [s.id, p.start, p.end, s.included_micros]);
    const u = (await c.query("SELECT included_micros, used_micros FROM subscription_usage WHERE subscription_id=$1 AND period_start=$2", [s.id, p.start])).rows[0];
    return { subscriptionId: s.id, plan: s.plan, periodStart: p.start.toISOString(), periodEnd: p.end.toISOString(), includedMicros: microsFromDb(u.included_micros), usedMicros: microsFromDb(u.used_micros) };
  }

  async reserve(input: ReserveInput): Promise<ReserveResult> {
    return this.tx(async c => {
      const a = (await c.query("SELECT * FROM billing_accounts WHERE id=$1 FOR UPDATE", [input.accountId])).rows[0];
      if (!a) throw new BillingStoreError("account_not_found", "Billing account not found");
      if (a.status !== "active") throw new BillingStoreError("account_inactive", "Billing account is not active");
      const idem = input.idempotency;
      if (idem) {
        const ins = await c.query("INSERT INTO billing_idempotency(account_id,tool_name,idempotency_key,request_hash,request_id,status) VALUES($1,$2,$3,$4,$5,'in_progress') ON CONFLICT DO NOTHING", [input.accountId, input.toolName, idem.key, idem.requestHash, input.requestId]);
        if (!ins.rowCount) {
          const row = (await c.query("SELECT * FROM billing_idempotency WHERE account_id=$1 AND tool_name=$2 AND idempotency_key=$3 FOR UPDATE", [input.accountId, input.toolName, idem.key])).rows[0];
          if (row.request_hash !== idem.requestHash) return { kind: "idempotency_conflict" } as const;
          if (row.status === "completed") return { kind: "replay", responseStatus: row.response_status ?? 200, responseBody: row.response_body, entryId: row.ledger_entry_id } as const;
          if (row.status === "in_progress") return { kind: "idempotency_in_progress" } as const;
          await c.query("UPDATE billing_idempotency SET status='in_progress', request_id=$4, ledger_entry_id=NULL, updated_at=now() WHERE account_id=$1 AND tool_name=$2 AND idempotency_key=$3", [input.accountId, input.toolName, idem.key, input.requestId]);
        }
      }
      const markIdem = (entryId: string) => idem ? c.query("UPDATE billing_idempotency SET ledger_entry_id=$4, updated_at=now() WHERE account_id=$1 AND tool_name=$2 AND idempotency_key=$3", [input.accountId, input.toolName, idem.key, entryId]) : Promise.resolve();
      const balance = microsFromDb(a.credit_balance_micros);
      const snap = input.rails.includes("subscription") ? await this.snapshot(c, input.accountId, input.now) : null;
      for (const rail of input.rails) {
        if (rail === "subscription") {
          if (!snap) continue;
          const u = await c.query("UPDATE subscription_usage SET used_micros = used_micros + $3, updated_at=now() WHERE subscription_id=$1 AND period_start=$2 AND used_micros + $3 <= included_micros RETURNING used_micros", [snap.subscriptionId, snap.periodStart, input.priceMicros]);
          if (u.rows[0]) {
            const e = await this.insertEntry(c, { accountId: input.accountId, apiKeyId: input.apiKeyId, requestId: input.requestId, toolName: input.toolName, type: "subscription_usage", amountMicros: -input.priceMicros, rail: "subscription", status: "pending", externalTransactionId: null, relatedEntryId: null, metadata: { subscriptionId: snap.subscriptionId, plan: snap.plan, periodStart: snap.periodStart } }, input.now);
            await markIdem(e.id);
            return { kind: "reserved", rail, entryId: e.id, chargedMicros: input.priceMicros, balanceBeforeMicros: balance, balanceAfterMicros: balance, subscription: { ...snap, usedMicros: microsFromDb(u.rows[0].used_micros) } } as const;
          }
          if (!input.subscriptionFallback) break;
          continue;
        }
        const u = await c.query("UPDATE billing_accounts SET credit_balance_micros = credit_balance_micros - $2, updated_at=$3 WHERE id=$1 AND credit_balance_micros >= $2 RETURNING credit_balance_micros", [input.accountId, input.priceMicros, input.now]);
        if (u.rows[0]) {
          const after = microsFromDb(u.rows[0].credit_balance_micros);
          const e = await this.insertEntry(c, { accountId: input.accountId, apiKeyId: input.apiKeyId, requestId: input.requestId, toolName: input.toolName, type: "debit", amountMicros: -input.priceMicros, rail: "api_credits", status: "pending", externalTransactionId: null, relatedEntryId: null, metadata: { balanceBeforeMicros: balance, balanceAfterMicros: after } }, input.now);
          await markIdem(e.id);
          return { kind: "reserved", rail, entryId: e.id, chargedMicros: input.priceMicros, balanceBeforeMicros: balance, balanceAfterMicros: after, ...(snap ? { subscription: snap } : {}) } as const;
        }
      }
      if (idem) await c.query("UPDATE billing_idempotency SET status='failed', updated_at=now() WHERE account_id=$1 AND tool_name=$2 AND idempotency_key=$3", [input.accountId, input.toolName, idem.key]);
      return { kind: "insufficient", balanceMicros: balance, subscription: snap } as const;
    });
  }

  async settle(input: SettleInput) {
    await this.tx(async c => {
      await c.query("UPDATE billing_ledger SET status='settled', updated_at=clock_timestamp() WHERE id=$1 AND status='pending'", [input.entryId]);
      const i = input.idempotency;
      if (i) await c.query("UPDATE billing_idempotency SET status='completed', response_status=$4, response_body=$5, ledger_entry_id=$6, updated_at=now() WHERE account_id=$1 AND tool_name=$2 AND idempotency_key=$3",
        [i.accountId, i.toolName, i.key, i.responseStatus, JSON.stringify(i.responseBody ?? null), input.entryId]);
    });
  }

  async release(input: ReleaseInput) {
    return this.tx(async c => {
      const head = (await c.query("SELECT account_id FROM billing_ledger WHERE id=$1", [input.entryId])).rows[0];
      if (!head) return null;
      await c.query("SELECT id FROM billing_accounts WHERE id=$1 FOR UPDATE", [head.account_id]);
      const e = (await c.query("SELECT * FROM billing_ledger WHERE id=$1 FOR UPDATE", [input.entryId])).rows[0];
      let result: { refundEntryId: string; balanceMicros: number } | null = null;
      if (e.status === "pending") {
        const amount = -microsFromDb(e.amount_micros);
        if (e.rail === "api_credits") await c.query("UPDATE billing_accounts SET credit_balance_micros = credit_balance_micros + $2, updated_at=now() WHERE id=$1", [e.account_id, amount]);
        else if (e.rail === "subscription") await c.query("UPDATE subscription_usage SET used_micros = GREATEST(0, used_micros - $3), updated_at=now() WHERE subscription_id=$1 AND period_start=$2", [e.metadata.subscriptionId, e.metadata.periodStart, amount]);
        await c.query("UPDATE billing_ledger SET status='refunded', updated_at=clock_timestamp() WHERE id=$1", [e.id]);
        const refund = await this.insertEntry(c, { accountId: e.account_id, apiKeyId: e.api_key_id, requestId: e.request_id, toolName: e.tool_name, type: "refund", amountMicros: amount, rail: e.rail, status: "settled", externalTransactionId: null, relatedEntryId: e.id, metadata: { reason: input.reason, ...(e.rail === "subscription" ? { subscriptionId: e.metadata.subscriptionId, periodStart: e.metadata.periodStart } : {}) } }, new Date());
        const bal = (await c.query("SELECT credit_balance_micros FROM billing_accounts WHERE id=$1", [e.account_id])).rows[0];
        result = { refundEntryId: refund.id, balanceMicros: microsFromDb(bal.credit_balance_micros) };
      }
      const i = input.idempotency;
      if (i) await c.query("UPDATE billing_idempotency SET status='failed', updated_at=now() WHERE account_id=$1 AND tool_name=$2 AND idempotency_key=$3 AND status='in_progress'", [i.accountId, i.toolName, i.key]);
      else await c.query("UPDATE billing_idempotency SET status='failed', updated_at=now() WHERE ledger_entry_id=$1 AND status='in_progress'", [input.entryId]);
      return result;
    });
  }

  async releaseStale(olderThan: Date) {
    const rows = (await this.q("SELECT id FROM billing_ledger WHERE status='pending' AND created_at < $1 ORDER BY created_at LIMIT 1000", [olderThan])).rows;
    let n = 0;
    for (const r of rows) if (await this.release({ entryId: r.id, reason: "reservation_expired" })) n++;
    return n;
  }

  async listLedger(accountId: string, options: { limit: number; before?: string }) {
    const limit = Math.max(1, Math.min(500, Math.trunc(options.limit)));
    const r = options.before
      ? await this.q("SELECT * FROM billing_ledger WHERE account_id=$1 AND seq < (SELECT seq FROM billing_ledger WHERE id=$2 AND account_id=$1) ORDER BY seq DESC LIMIT $3", [accountId, options.before, limit])
      : await this.q("SELECT * FROM billing_ledger WHERE account_id=$1 ORDER BY seq DESC LIMIT $2", [accountId, limit]);
    return r.rows.map(toEntry);
  }
  async usageSummary(accountId: string, since: Date): Promise<UsageSummaryRow[]> {
    const r = await this.q(`SELECT tool_name, rail, count(*)::int AS calls, (-sum(amount_micros))::bigint AS charged FROM billing_ledger
      WHERE account_id=$1 AND status='settled' AND type IN ('debit','subscription_usage') AND created_at >= $2 GROUP BY tool_name, rail ORDER BY tool_name, rail`, [accountId, since]);
    return r.rows.map(x => ({ toolName: x.tool_name, rail: x.rail, calls: Number(x.calls), chargedMicros: microsFromDb(x.charged) }));
  }

  private async insertEntry(c: PoolClient, e: Omit<LedgerEntry, "id" | "currency" | "createdAt" | "updatedAt">, now: Date): Promise<LedgerEntry> {
    const r = await c.query(`INSERT INTO billing_ledger(id,account_id,api_key_id,request_id,tool_name,type,amount_micros,rail,status,external_transaction_id,related_entry_id,metadata,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) RETURNING *`,
      [newId("txn"), e.accountId, e.apiKeyId, e.requestId, e.toolName, e.type, e.amountMicros, e.rail, e.status, e.externalTransactionId, e.relatedEntryId, e.metadata, now]);
    return toEntry(r.rows[0]);
  }
}
