import { newId } from "./apiKeys.js";
import { addMonthsUtc, currentPeriod } from "./plans.js";
import { BillingStoreError, type BillingStore } from "./store.js";
import type { AccountStatus, ApiKeyEnvironment, ApiKeyRecord, BillingAccount, LedgerEntry, ReleaseInput, ReserveInput, ReserveResult, SettleInput, Subscription, SubscriptionSnapshot, UsageSummaryRow } from "./types.js";

interface SubRow extends Subscription { anchor: string }
interface IdemRow { requestHash: string; status: "in_progress" | "completed" | "failed"; entryId: string | null; responseStatus: number | null; responseBody: unknown }

const clone = <T>(v: T): T => structuredClone(v);

/**
 * In-process BillingStore for development and tests. Loses everything on restart, which is why
 * loadBillingConfig() refuses to enable billing in production without a database.
 *
 * Atomicity: every method body below runs its check-and-mutate sequence synchronously (the only
 * `await` is the implicit one when the async function returns), so no other call can interleave
 * between "is there enough balance?" and "debit it" — the in-memory equivalent of the Postgres
 * store's row lock + conditional UPDATE.
 */
export class MemoryBillingStore implements BillingStore {
  private accounts = new Map<string, BillingAccount>();
  private keys = new Map<string, ApiKeyRecord>();
  private keysByHash = new Map<string, string>();
  private ledger: LedgerEntry[] = [];
  private ledgerById = new Map<string, LedgerEntry>();
  private subs = new Map<string, SubRow>();
  private usage = new Map<string, { includedMicros: number; usedMicros: number }>();
  private idem = new Map<string, IdemRow>();

  async migrate(): Promise<void> {}
  async close(): Promise<void> {}

  async createAccount(input: { name: string; email?: string | null; metadata?: Record<string, unknown> }): Promise<BillingAccount> {
    const now = new Date().toISOString();
    const account: BillingAccount = { id: newId("acct"), name: input.name, email: input.email ?? null, status: "active", currency: "USD", creditBalanceMicros: 0, createdAt: now, updatedAt: now, metadata: input.metadata ?? {} };
    this.accounts.set(account.id, account);
    return clone(account);
  }
  async getAccount(accountId: string) { const a = this.accounts.get(accountId); return a ? clone(a) : null; }
  async setAccountStatus(accountId: string, status: AccountStatus) {
    const a = this.mustAccount(accountId);
    a.status = status; a.updatedAt = new Date().toISOString();
    return clone(a);
  }

  async insertApiKey(input: { id: string; accountId: string; keyPrefix: string; keyHash: string; environment: ApiKeyEnvironment; name: string; expiresAt: Date | null; metadata?: Record<string, unknown> }) {
    this.mustAccount(input.accountId);
    const record: ApiKeyRecord = { id: input.id, accountId: input.accountId, keyPrefix: input.keyPrefix, keyHash: input.keyHash, environment: input.environment, name: input.name, status: "active", createdAt: new Date().toISOString(), lastUsedAt: null, expiresAt: input.expiresAt?.toISOString() ?? null, revokedAt: null, metadata: input.metadata ?? {} };
    this.keys.set(record.id, record); this.keysByHash.set(record.keyHash, record.id);
    return clone(record);
  }
  async findApiKeyByHash(keyHash: string) {
    const id = this.keysByHash.get(keyHash); if (!id) return null;
    const key = this.keys.get(id)!; const account = this.accounts.get(key.accountId);
    return account ? { key: clone(key), account: clone(account) } : null;
  }
  async touchApiKey(keyId: string, at: Date) { const k = this.keys.get(keyId); if (k) k.lastUsedAt = at.toISOString(); }
  async revokeApiKey(accountId: string, keyId: string, at: Date) {
    const k = this.keys.get(keyId);
    if (!k || k.accountId !== accountId) throw new BillingStoreError("key_not_found", "API key not found for this account");
    if (k.status !== "revoked") { k.status = "revoked"; k.revokedAt = at.toISOString(); }
    return clone(k);
  }
  async listApiKeys(accountId: string) { return [...this.keys.values()].filter(k => k.accountId === accountId).map(clone); }

  async applyCredit(input: { accountId: string; amountMicros: number; type: "credit" | "adjustment"; reason: string; externalTransactionId?: string | null; now: Date }) {
    const a = this.mustAccount(input.accountId);
    if (!Number.isSafeInteger(input.amountMicros) || input.amountMicros === 0 || (input.type === "credit" && input.amountMicros < 0)) throw new BillingStoreError("invalid_amount", "Amount must be a non-zero integer number of micros (positive for a credit)");
    if (input.externalTransactionId) {
      const existing = this.ledger.find(e => e.accountId === a.id && e.externalTransactionId === input.externalTransactionId && (e.type === "credit" || e.type === "adjustment"));
      if (existing) return { entry: clone(existing), balanceMicros: a.creditBalanceMicros, duplicate: true };
    }
    const next = a.creditBalanceMicros + input.amountMicros;
    if (next < 0) throw new BillingStoreError("negative_balance", "Adjustment would make the balance negative");
    a.creditBalanceMicros = next; a.updatedAt = input.now.toISOString();
    const entry = this.addEntry({ accountId: a.id, apiKeyId: null, requestId: null, toolName: null, type: input.type, amountMicros: input.amountMicros, rail: "admin", status: "settled", externalTransactionId: input.externalTransactionId ?? null, relatedEntryId: null, metadata: { reason: input.reason, balanceAfterMicros: next } }, input.now);
    return { entry: clone(entry), balanceMicros: next, duplicate: false };
  }

  async assignSubscription(input: { accountId: string; plan: string; includedMicros: number; now: Date }) {
    this.mustAccount(input.accountId);
    for (const s of this.subs.values()) if (s.accountId === input.accountId && s.status === "active") { s.status = "canceled"; s.canceledAt = input.now.toISOString(); }
    const row: SubRow = { id: newId("sub"), accountId: input.accountId, plan: input.plan, status: "active", includedMicros: input.includedMicros, periodStart: input.now.toISOString(), periodEnd: addMonthsUtc(input.now, 1).toISOString(), createdAt: input.now.toISOString(), canceledAt: null, anchor: input.now.toISOString() };
    this.subs.set(row.id, row);
    const { anchor: _a, ...pub } = row; return clone(pub);
  }
  async cancelSubscription(accountId: string, now: Date) {
    const s = this.activeSub(accountId); if (!s) return null;
    s.status = "canceled"; s.canceledAt = now.toISOString();
    const { anchor: _a, ...pub } = s; return clone(pub);
  }
  async getSubscription(accountId: string, now: Date) { const snap = this.snapshot(accountId, now); return snap ? { ...snap } : null; }

  async reserve(input: ReserveInput): Promise<ReserveResult> {
    const account = this.mustAccount(input.accountId);
    if (account.status !== "active") throw new BillingStoreError("account_inactive", "Billing account is not active");
    const idemKey = input.idempotency ? `${input.accountId}|${input.toolName}|${input.idempotency.key}` : null;
    if (idemKey) {
      const existing = this.idem.get(idemKey);
      if (existing) {
        if (existing.requestHash !== input.idempotency!.requestHash) return { kind: "idempotency_conflict" };
        if (existing.status === "completed") return { kind: "replay", responseStatus: existing.responseStatus ?? 200, responseBody: clone(existing.responseBody), entryId: existing.entryId };
        if (existing.status === "in_progress") return { kind: "idempotency_in_progress" };
      }
      this.idem.set(idemKey, { requestHash: input.idempotency!.requestHash, status: "in_progress", entryId: null, responseStatus: null, responseBody: null });
    }
    const snap = input.rails.includes("subscription") ? this.snapshot(input.accountId, input.now) : null;
    const balance = account.creditBalanceMicros;
    for (const rail of input.rails) {
      if (rail === "subscription") {
        if (!snap) continue;
        const usageRow = this.usage.get(`${snap.subscriptionId}|${snap.periodStart}`)!;
        if (usageRow.includedMicros - usageRow.usedMicros >= input.priceMicros) {
          usageRow.usedMicros += input.priceMicros;
          const entry = this.addEntry({ accountId: account.id, apiKeyId: input.apiKeyId, requestId: input.requestId, toolName: input.toolName, type: "subscription_usage", amountMicros: -input.priceMicros, rail: "subscription", status: "pending", externalTransactionId: null, relatedEntryId: null, metadata: { subscriptionId: snap.subscriptionId, plan: snap.plan, periodStart: snap.periodStart } }, input.now);
          if (idemKey) this.idem.get(idemKey)!.entryId = entry.id;
          return { kind: "reserved", rail, entryId: entry.id, chargedMicros: input.priceMicros, balanceBeforeMicros: balance, balanceAfterMicros: balance, subscription: { ...snap, usedMicros: usageRow.usedMicros } };
        }
        if (!input.subscriptionFallback) break;
        continue;
      }
      if (account.creditBalanceMicros >= input.priceMicros) {
        account.creditBalanceMicros -= input.priceMicros; account.updatedAt = input.now.toISOString();
        const entry = this.addEntry({ accountId: account.id, apiKeyId: input.apiKeyId, requestId: input.requestId, toolName: input.toolName, type: "debit", amountMicros: -input.priceMicros, rail: "api_credits", status: "pending", externalTransactionId: null, relatedEntryId: null, metadata: { balanceBeforeMicros: balance, balanceAfterMicros: account.creditBalanceMicros } }, input.now);
        if (idemKey) this.idem.get(idemKey)!.entryId = entry.id;
        return { kind: "reserved", rail, entryId: entry.id, chargedMicros: input.priceMicros, balanceBeforeMicros: balance, balanceAfterMicros: account.creditBalanceMicros, ...(snap ? { subscription: snap } : {}) };
      }
    }
    if (idemKey) this.idem.get(idemKey)!.status = "failed";
    return { kind: "insufficient", balanceMicros: balance, subscription: snap };
  }

  async settle(input: SettleInput) {
    const e = this.ledgerById.get(input.entryId);
    if (e && e.status === "pending") { e.status = "settled"; e.updatedAt = new Date().toISOString(); }
    if (input.idempotency) {
      const row = this.idem.get(`${input.idempotency.accountId}|${input.idempotency.toolName}|${input.idempotency.key}`);
      if (row) { row.status = "completed"; row.responseStatus = input.idempotency.responseStatus; row.responseBody = clone(input.idempotency.responseBody); row.entryId = input.entryId; }
    }
  }

  async release(input: ReleaseInput) {
    const e = this.ledgerById.get(input.entryId);
    let result: { refundEntryId: string; balanceMicros: number } | null = null;
    if (e && e.status === "pending") {
      const account = this.accounts.get(e.accountId)!;
      const amount = -e.amountMicros;
      if (e.rail === "api_credits") { account.creditBalanceMicros += amount; account.updatedAt = new Date().toISOString(); }
      else if (e.rail === "subscription") {
        const u = this.usage.get(`${String(e.metadata.subscriptionId)}|${String(e.metadata.periodStart)}`);
        if (u) u.usedMicros = Math.max(0, u.usedMicros - amount);
      }
      e.status = "refunded"; e.updatedAt = new Date().toISOString();
      const refund = this.addEntry({ accountId: e.accountId, apiKeyId: e.apiKeyId, requestId: e.requestId, toolName: e.toolName, type: "refund", amountMicros: amount, rail: e.rail, status: "settled", externalTransactionId: null, relatedEntryId: e.id, metadata: { reason: input.reason, ...(e.rail === "subscription" ? { subscriptionId: e.metadata.subscriptionId, periodStart: e.metadata.periodStart } : {}) } }, new Date());
      result = { refundEntryId: refund.id, balanceMicros: account.creditBalanceMicros };
    }
    const idemRow = input.idempotency
      ? this.idem.get(`${input.idempotency.accountId}|${input.idempotency.toolName}|${input.idempotency.key}`)
      : [...this.idem.values()].find(r => r.entryId === input.entryId);
    if (idemRow && idemRow.status === "in_progress") idemRow.status = "failed";
    return result;
  }

  async releaseStale(olderThan: Date) {
    const stale = this.ledger.filter(e => e.status === "pending" && Date.parse(e.createdAt) < olderThan.getTime());
    for (const e of stale) await this.release({ entryId: e.id, reason: "reservation_expired" });
    return stale.length;
  }

  async listLedger(accountId: string, options: { limit: number; before?: string }) {
    let rows = this.ledger.filter(e => e.accountId === accountId);
    if (options.before) { const idx = rows.findIndex(e => e.id === options.before); if (idx >= 0) rows = rows.slice(0, idx); }
    return rows.slice(-options.limit).reverse().map(clone);
  }
  async usageSummary(accountId: string, since: Date): Promise<UsageSummaryRow[]> {
    const groups = new Map<string, UsageSummaryRow>();
    for (const e of this.ledger) {
      if (e.accountId !== accountId || e.status !== "settled" || (e.type !== "debit" && e.type !== "subscription_usage") || Date.parse(e.createdAt) < since.getTime()) continue;
      const k = `${e.toolName}|${e.rail}`;
      const g = groups.get(k) ?? { toolName: e.toolName ?? "", rail: e.rail, calls: 0, chargedMicros: 0 };
      g.calls++; g.chargedMicros += -e.amountMicros; groups.set(k, g);
    }
    return [...groups.values()].sort((a, b) => a.toolName.localeCompare(b.toolName) || a.rail.localeCompare(b.rail));
  }

  /** Test/diagnostic helper: the raw ledger, oldest first. */
  allLedgerEntries(): LedgerEntry[] { return this.ledger.map(clone); }

  private mustAccount(id: string): BillingAccount {
    const a = this.accounts.get(id);
    if (!a) throw new BillingStoreError("account_not_found", "Billing account not found");
    return a;
  }
  private activeSub(accountId: string): SubRow | undefined {
    for (const s of this.subs.values()) if (s.accountId === accountId && s.status === "active") return s;
    return undefined;
  }
  private snapshot(accountId: string, now: Date): SubscriptionSnapshot | null {
    const s = this.activeSub(accountId); if (!s) return null;
    const period = currentPeriod(new Date(s.anchor), now);
    s.periodStart = period.start.toISOString(); s.periodEnd = period.end.toISOString();
    const key = `${s.id}|${s.periodStart}`;
    let u = this.usage.get(key);
    if (!u) { u = { includedMicros: s.includedMicros, usedMicros: 0 }; this.usage.set(key, u); }
    return { subscriptionId: s.id, plan: s.plan, periodStart: s.periodStart, periodEnd: s.periodEnd, includedMicros: u.includedMicros, usedMicros: u.usedMicros };
  }
  private addEntry(e: Omit<LedgerEntry, "id" | "currency" | "createdAt" | "updatedAt">, now: Date): LedgerEntry {
    const entry: LedgerEntry = { ...e, id: newId("txn"), currency: "USD", createdAt: now.toISOString(), updatedAt: now.toISOString() };
    this.ledger.push(entry); this.ledgerById.set(entry.id, entry);
    return entry;
  }
}
