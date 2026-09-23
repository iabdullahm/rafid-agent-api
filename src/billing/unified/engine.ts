import { generateApiKey, hashApiKey, parseApiKey } from "./apiKeys.js";
import type { BillingConfig } from "./config.js";
import { formatMicros, money, usdToMicros } from "./money.js";
import { BillingStoreError, type BillingStore } from "./store.js";
import type { AccountRail, ApiKeyEnvironment, ApiKeyRecord, BillingAccount, BillingAuthorization, LedgerEntry, SubscriptionSnapshot } from "./types.js";

export type AuthResult =
  | { ok: true; key: ApiKeyRecord; account: BillingAccount }
  | { ok: false; status: 401 | 403; code: "invalid_api_key" | "api_key_revoked" | "api_key_expired" | "account_inactive"; message: string };

export type AuthorizeOutcome =
  | { kind: "authorized"; authorization: BillingAuthorization }
  | { kind: "replay"; responseStatus: number; responseBody: unknown }
  | { kind: "idempotency_conflict" }
  | { kind: "idempotency_in_progress" }
  | { kind: "insufficient"; priceMicros: number; balanceMicros: number; subscription: SubscriptionSnapshot | null; reason: "insufficient_credits" | "subscription_exhausted" | "no_active_subscription" };

export class BillingAdminError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

/**
 * The unified billing engine: API-key authentication, rail authorization (reserve), settlement
 * and refund, plus the account-management operations the admin API and CLI call. It is the only
 * component that turns a tool name into a charge on an account, and it gets the price from the
 * same `priceUsd(tool)` function (BillingService.getToolPrice → capability.price) the x402, L402
 * and MPP gates use — so an API-credit debit can never differ from the x402 price.
 */
export class BillingEngine {
  private readonly now: () => Date;
  constructor(readonly deps: { config: BillingConfig; store: BillingStore; priceUsd: (tool: string) => number; now?: () => Date }) {
    this.now = deps.now ?? (() => new Date());
  }
  get config() { return this.deps.config; }
  get store() { return this.deps.store; }

  /** Canonical price of a tool, in integer micro-USD. */
  priceMicros(tool: string): number { return usdToMicros(this.deps.priceUsd(tool)); }

  async authenticate(apiKey: string): Promise<AuthResult> {
    const invalid = { ok: false as const, status: 401 as const, code: "invalid_api_key" as const, message: "The Rafid API key is invalid." };
    if (!parseApiKey(apiKey)) return invalid;
    const found = await this.deps.store.findApiKeyByHash(hashApiKey(apiKey));
    if (!found) return invalid;
    if (found.key.status === "revoked") return { ok: false, status: 401, code: "api_key_revoked", message: "This Rafid API key has been revoked." };
    if (found.key.expiresAt && Date.parse(found.key.expiresAt) <= this.now().getTime()) return { ok: false, status: 401, code: "api_key_expired", message: "This Rafid API key has expired." };
    if (found.account.status !== "active") return { ok: false, status: 403, code: "account_inactive", message: "The billing account for this API key is not active." };
    void this.deps.store.touchApiKey(found.key.id, this.now()).catch(() => {});
    return { ok: true, key: found.key, account: found.account };
  }

  /** Reserves the charge for one call on the first rail that can pay (see selection.ts for the
   *  order). A zero-priced tool authorizes as the `free` rail without touching any account. */
  async authorize(input: { toolName: string; account: BillingAccount; key: ApiKeyRecord; rails: AccountRail[]; subscriptionFallback: boolean; requestId: string; idempotency?: { key: string; requestHash: string } }): Promise<AuthorizeOutcome> {
    const priceMicros = this.priceMicros(input.toolName);
    if (priceMicros === 0) return { kind: "authorized", authorization: { authorized: true, rail: "free", priceMicros: 0, chargedMicros: 0, accountId: input.account.id, apiKeyId: input.key.id } };
    const result = await this.deps.store.reserve({
      accountId: input.account.id, apiKeyId: input.key.id, requestId: input.requestId, toolName: input.toolName, priceMicros,
      rails: input.rails, subscriptionFallback: input.subscriptionFallback, idempotency: input.idempotency, now: this.now()
    });
    switch (result.kind) {
      case "reserved":
        return { kind: "authorized", authorization: {
          authorized: true, rail: result.rail, accountId: input.account.id, apiKeyId: input.key.id, priceMicros, chargedMicros: result.chargedMicros,
          balanceBeforeMicros: result.balanceBeforeMicros, balanceAfterMicros: result.balanceAfterMicros, transactionId: result.entryId, subscription: result.subscription
        } };
      case "replay": return { kind: "replay", responseStatus: result.responseStatus, responseBody: result.responseBody };
      case "idempotency_conflict": return { kind: "idempotency_conflict" };
      case "idempotency_in_progress": return { kind: "idempotency_in_progress" };
      case "insufficient": {
        const onlySubscription = input.rails.length === 1 && input.rails[0] === "subscription";
        const blockedBySubscription = Boolean(result.subscription) && input.rails[0] === "subscription" && !input.subscriptionFallback;
        return { kind: "insufficient", priceMicros, balanceMicros: result.balanceMicros, subscription: result.subscription, reason: onlySubscription && !result.subscription ? "no_active_subscription" : onlySubscription || blockedBySubscription ? "subscription_exhausted" : "insufficient_credits" };
      }
    }
  }

  async settle(auth: BillingAuthorization, idempotency?: { toolName: string; key: string; responseStatus: number; responseBody: unknown }) {
    if (!auth.transactionId || !auth.accountId) return;
    await this.deps.store.settle({ entryId: auth.transactionId, idempotency: idempotency ? { accountId: auth.accountId, ...idempotency } : undefined });
  }

  async release(auth: BillingAuthorization, reason: string, idempotency?: { toolName: string; key: string }) {
    if (!auth.transactionId || !auth.accountId) return null;
    return this.deps.store.release({ entryId: auth.transactionId, reason, idempotency: idempotency ? { accountId: auth.accountId, ...idempotency } : undefined });
  }

  // ---- account management (admin API + CLI) ----------------------------------------------

  async createAccount(input: { name: string; email?: string | null; metadata?: Record<string, unknown> }) {
    const name = (input.name ?? "").trim();
    if (!name || name.length > 200) throw new BillingAdminError(400, "invalid_input", "name is required (max 200 characters)");
    if (input.email && (input.email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(input.email))) throw new BillingAdminError(400, "invalid_input", "email is invalid");
    return this.deps.store.createAccount({ name, email: input.email ?? null, metadata: input.metadata });
  }

  async createApiKey(input: { accountId: string; name?: string; environment?: ApiKeyEnvironment; expiresAt?: string | null }) {
    const environment = input.environment ?? "live";
    if (environment !== "live" && environment !== "test") throw new BillingAdminError(400, "invalid_input", 'environment must be "live" or "test"');
    let expiresAt: Date | null = null;
    if (input.expiresAt) { expiresAt = new Date(input.expiresAt); if (Number.isNaN(expiresAt.getTime())) throw new BillingAdminError(400, "invalid_input", "expiresAt must be an ISO 8601 date"); }
    const account = await this.mustAccount(input.accountId);
    const generated = generateApiKey(environment);
    const record = await this.deps.store.insertApiKey({ id: generated.id, accountId: account.id, keyPrefix: generated.keyPrefix, keyHash: generated.keyHash, environment, name: (input.name ?? "default").trim().slice(0, 120) || "default", expiresAt });
    return { apiKey: generated.key, key: publicKey(record) };
  }

  async revokeApiKey(accountId: string, keyId: string) { return publicKey(await this.wrap(() => this.deps.store.revokeApiKey(accountId, keyId, this.now()))); }
  async listApiKeys(accountId: string) { await this.mustAccount(accountId); return (await this.deps.store.listApiKeys(accountId)).map(publicKey); }

  async addCredit(input: { accountId: string; amount: string; reason?: string; externalTransactionId?: string | null }) {
    const micros = this.parseAmount(input.amount);
    if (micros <= 0) throw new BillingAdminError(400, "invalid_amount", "A credit amount must be positive");
    const r = await this.wrap(() => this.deps.store.applyCredit({ accountId: input.accountId, amountMicros: micros, type: "credit", reason: input.reason ?? "prepaid credit", externalTransactionId: input.externalTransactionId ?? null, now: this.now() }));
    return { transaction: ledgerView(r.entry), balance: money(r.balanceMicros), duplicate: r.duplicate };
  }

  async adjustCredit(input: { accountId: string; amount: string; reason: string; externalTransactionId?: string | null }) {
    const micros = this.parseAmount(input.amount);
    if (micros === 0) throw new BillingAdminError(400, "invalid_amount", "An adjustment must be non-zero");
    if (!input.reason?.trim()) throw new BillingAdminError(400, "invalid_input", "An adjustment requires a reason");
    const r = await this.wrap(() => this.deps.store.applyCredit({ accountId: input.accountId, amountMicros: micros, type: "adjustment", reason: input.reason.trim(), externalTransactionId: input.externalTransactionId ?? null, now: this.now() }));
    return { transaction: ledgerView(r.entry), balance: money(r.balanceMicros), duplicate: r.duplicate };
  }

  async assignSubscription(input: { accountId: string; plan: string; includedUsd?: string }) {
    const plan = this.deps.config.plans[input.plan];
    if (!plan) throw new BillingAdminError(400, "unknown_plan", `Unknown plan "${input.plan}". Known plans: ${Object.keys(this.deps.config.plans).join(", ")}`);
    const includedMicros = input.includedUsd !== undefined ? this.parseAmount(input.includedUsd) : plan.allowance.monthlyIncludedMicros;
    if (includedMicros < 0) throw new BillingAdminError(400, "invalid_amount", "includedUsd must not be negative");
    await this.mustAccount(input.accountId);
    const sub = await this.deps.store.assignSubscription({ accountId: input.accountId, plan: plan.id, includedMicros, now: this.now() });
    return { ...sub, includedMicros: undefined, included: money(sub.includedMicros) };
  }

  async cancelSubscription(accountId: string) {
    await this.mustAccount(accountId);
    const sub = await this.deps.store.cancelSubscription(accountId, this.now());
    if (!sub) throw new BillingAdminError(404, "subscription_not_found", "No active subscription for this account");
    return { id: sub.id, plan: sub.plan, status: sub.status, canceledAt: sub.canceledAt };
  }

  async balanceView(accountId: string) {
    const account = await this.mustAccount(accountId);
    const sub = await this.deps.store.getSubscription(accountId, this.now());
    return {
      accountId: account.id,
      status: account.status,
      credits: { available: formatMicros(account.creditBalanceMicros), currency: "USD" },
      subscription: sub ? subscriptionView(sub) : null
    };
  }

  async ledgerView(accountId: string, options: { limit?: number; before?: string }) {
    await this.mustAccount(accountId);
    const limit = Math.max(1, Math.min(200, Math.trunc(options.limit ?? 50)));
    const entries = await this.deps.store.listLedger(accountId, { limit, before: options.before });
    return { accountId, transactions: entries.map(ledgerView), nextBefore: entries.length === limit ? entries[entries.length - 1]!.id : null };
  }

  async usageView(accountId: string, sinceParam?: string) {
    await this.mustAccount(accountId);
    const sub = await this.deps.store.getSubscription(accountId, this.now());
    let since = sub ? new Date(sub.periodStart) : new Date(this.now().getTime() - 30 * 86400000);
    if (sinceParam) { since = new Date(sinceParam); if (Number.isNaN(since.getTime())) throw new BillingAdminError(400, "invalid_input", "since must be an ISO 8601 date"); }
    const rows = await this.deps.store.usageSummary(accountId, since);
    const total = rows.reduce((s, r) => s + r.chargedMicros, 0);
    return {
      accountId, since: since.toISOString(),
      tools: rows.map(r => ({ tool: r.toolName, rail: r.rail, calls: r.calls, charged: money(r.chargedMicros) })),
      total: money(total),
      subscription: sub ? subscriptionView(sub) : null
    };
  }

  async releaseStale() {
    const cutoff = new Date(this.now().getTime() - this.deps.config.reservationTtlSeconds * 1000);
    return { released: await this.deps.store.releaseStale(cutoff), olderThan: cutoff.toISOString() };
  }

  private parseAmount(amount: string): number {
    try { return usdToMicros(String(amount)); } catch (e) { throw new BillingAdminError(400, "invalid_amount", (e as Error).message); }
  }
  private async mustAccount(id: string) {
    const account = typeof id === "string" && id ? await this.deps.store.getAccount(id) : null;
    if (!account) throw new BillingAdminError(404, "account_not_found", "Billing account not found");
    return account;
  }
  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try { return await fn(); } catch (e) {
      if (e instanceof BillingStoreError) throw new BillingAdminError(e.code === "account_not_found" || e.code === "key_not_found" ? 404 : 400, e.code, e.message);
      throw e;
    }
  }
}

export const publicKey = (k: ApiKeyRecord) => ({ id: k.id, accountId: k.accountId, prefix: k.keyPrefix, environment: k.environment, name: k.name, status: k.status, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt, expiresAt: k.expiresAt, revokedAt: k.revokedAt });

export const subscriptionView = (s: SubscriptionSnapshot) => ({
  id: s.subscriptionId, plan: s.plan, periodStartsAt: s.periodStart, periodEndsAt: s.periodEnd,
  included: formatMicros(s.includedMicros), used: formatMicros(s.usedMicros), remaining: formatMicros(Math.max(0, s.includedMicros - s.usedMicros)), currency: "USD"
});

export const ledgerView = (e: LedgerEntry) => ({
  id: e.id, requestId: e.requestId, tool: e.toolName, type: e.type, rail: e.rail,
  amount: formatMicros(Math.abs(e.amountMicros)), direction: e.amountMicros >= 0 ? "credit" as const : "debit" as const,
  currency: e.currency, status: e.status, externalTransactionId: e.externalTransactionId, relatedTransactionId: e.relatedEntryId, createdAt: e.createdAt,
  ...(e.metadata.reason ? { reason: String(e.metadata.reason) } : {})
});

/** The billing block returned with a paid result (response `meta.billing` and MCP `_meta`). */
export function billingResultView(auth: BillingAuthorization) {
  return {
    rail: auth.rail,
    amount: formatMicros(auth.chargedMicros),
    currency: "USD",
    ...(auth.rail === "api_credits" && auth.balanceAfterMicros !== undefined ? { remainingBalance: formatMicros(auth.balanceAfterMicros) } : {}),
    ...(auth.rail === "subscription" && auth.subscription ? { subscriptionRemaining: formatMicros(Math.max(0, auth.subscription.includedMicros - auth.subscription.usedMicros)) } : {}),
    ...(auth.transactionId ? { transactionId: auth.transactionId } : {})
  };
}
