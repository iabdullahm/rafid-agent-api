import assert from "node:assert/strict";
import { test } from "node:test";
import { BillingEngine, disabledBillingConfig, loadBillingConfig, type BillingStore, type BillingConfig } from "../src/billing/unified/index.js";

/**
 * Store-contract tests for the unified billing ledger, run against every BillingStore
 * implementation: MemoryBillingStore (tests/billing.test.ts) and PostgresBillingStore
 * (tests/billing-postgres.test.ts, when TEST_DATABASE_URL is set). Identical assertions, so the
 * in-memory store used by most HTTP tests can never drift from production semantics.
 */
export function billingStoreContract(label: string, makeStore: () => Promise<BillingStore>, options: { skip?: boolean } = {}) {
  const config: BillingConfig = loadBillingConfig({ API_CREDITS_ENABLED: "true", SUBSCRIPTIONS_ENABLED: "true" }, { nodeEnv: "test" });
  const setup = async (prices: Record<string, number> = {}) => {
    const store = await makeStore();
    let now = new Date("2026-01-31T10:00:00.000Z");
    const engine = new BillingEngine({ config, store, priceUsd: t => prices[t] ?? 0.25, now: () => now });
    const account = await engine.createAccount({ name: "Contract Co", email: "billing@example.com" });
    const { apiKey } = await engine.createApiKey({ accountId: account.id, name: "contract" });
    const auth = await engine.authenticate(apiKey);
    assert.ok(auth.ok);
    const authorize = (tool = "tool_025", extra: Partial<Parameters<BillingEngine["authorize"]>[0]> = {}) => engine.authorize({
      toolName: tool, account: auth.account, key: auth.key, rails: ["subscription", "api_credits"], subscriptionFallback: true, requestId: "req-" + Math.random(), ...extra
    });
    const balance = async () => (await store.getAccount(account.id))!.creditBalanceMicros;
    return { store, engine, account, apiKey, auth, authorize, balance, setNow: (d: Date) => { now = d; }, getNow: () => now };
  };
  /** Σ ledger amounts on the credit rails must always equal the stored balance (exact accounting). */
  const reconcile = async (store: BillingStore, accountId: string) => {
    const entries = await store.listLedger(accountId, { limit: 500 });
    const sum = entries.filter(e => e.rail !== "subscription" && e.status !== "failed").reduce((s, e) => s + e.amountMicros, 0);
    assert.equal(sum, (await store.getAccount(accountId))!.creditBalanceMicros, "ledger does not reconcile with the balance");
  };

  test(`${label}: top-up, debit and settle are exact and fully ledgered`, { skip: options.skip }, async () => {
    const { store, engine, account, authorize, balance } = await setup({ tool_015: 0.15 });
    await engine.addCredit({ accountId: account.id, amount: "10.00", reason: "test top-up" });
    const r = await authorize("tool_015");
    assert.equal(r.kind, "authorized");
    if (r.kind !== "authorized") return;
    assert.equal(r.authorization.rail, "api_credits");
    assert.equal(r.authorization.balanceBeforeMicros, 10_000_000);
    assert.equal(r.authorization.balanceAfterMicros, 9_850_000);
    await engine.settle(r.authorization);
    assert.equal(await balance(), 9_850_000);
    const ledger = await store.listLedger(account.id, { limit: 10 });
    const debit = ledger.find(e => e.type === "debit")!;
    assert.equal(debit.status, "settled");
    assert.equal(debit.amountMicros, -150_000);
    assert.equal(debit.toolName, "tool_015");
    assert.equal(ledger.find(e => e.type === "credit")!.amountMicros, 10_000_000);
    // 0.1 + 0.2 style float drift is impossible: 7 debits of $0.15 from $9.85 leave exactly $8.80.
    for (let i = 0; i < 7; i++) { const x = await authorize("tool_015"); assert.equal(x.kind, "authorized"); if (x.kind === "authorized") await engine.settle(x.authorization); }
    assert.equal(await balance(), 8_800_000);
    await reconcile(store, account.id);
  });

  test(`${label}: concurrent debits can never overspend ($0.25 x 20 in parallel against $0.30)`, { skip: options.skip }, async () => {
    const { store, engine, account, authorize, balance } = await setup();
    await engine.addCredit({ accountId: account.id, amount: "0.30" });
    const results = await Promise.all(Array.from({ length: 20 }, () => authorize("tool_025", { rails: ["api_credits"] })));
    assert.equal(results.filter(r => r.kind === "authorized").length, 1);
    assert.equal(results.filter(r => r.kind === "insufficient").length, 19);
    assert.equal(await balance(), 50_000);
    await reconcile(store, account.id);
  });

  test(`${label}: concurrent debits spend exactly the affordable number of calls ($1.00 / $0.25 = 4 of 12)`, { skip: options.skip }, async () => {
    const { store, engine, account, authorize, balance } = await setup();
    await engine.addCredit({ accountId: account.id, amount: "1.00" });
    const results = await Promise.all(Array.from({ length: 12 }, () => authorize("tool_025", { rails: ["api_credits"] })));
    assert.equal(results.filter(r => r.kind === "authorized").length, 4);
    assert.equal(await balance(), 0);
    await reconcile(store, account.id);
  });

  test(`${label}: idempotency — replay after settle, conflict on a different payload, in-progress while pending, retry after a refund`, { skip: options.skip }, async () => {
    const { store, engine, account, authorize, balance } = await setup();
    await engine.addCredit({ accountId: account.id, amount: "5.00" });
    const idem = { key: "idem-1", requestHash: "hash-a" };
    const first = await authorize("tool_025", { idempotency: idem });
    assert.equal(first.kind, "authorized");
    if (first.kind !== "authorized") return;
    // While the first attempt is still pending, a concurrent retry must not charge again.
    assert.equal((await authorize("tool_025", { idempotency: idem })).kind, "idempotency_in_progress");
    await engine.settle(first.authorization, { toolName: "tool_025", key: idem.key, responseStatus: 200, responseBody: { success: true, data: { v: 1 } } });
    const replay = await authorize("tool_025", { idempotency: idem });
    assert.equal(replay.kind, "replay");
    if (replay.kind === "replay") { assert.equal(replay.responseStatus, 200); assert.deepEqual(replay.responseBody, { success: true, data: { v: 1 } }); }
    assert.equal((await authorize("tool_025", { idempotency: { key: "idem-1", requestHash: "hash-b" } })).kind, "idempotency_conflict");
    // The same key is scoped per tool: another tool may reuse it.
    assert.equal((await authorize("tool_other", { idempotency: { key: "idem-1", requestHash: "hash-b" } })).kind, "authorized");
    assert.equal(await balance(), 4_500_000);
    // A failed (refunded) attempt may be retried with the same key and is charged only once.
    const failKey = { key: "idem-fail", requestHash: "hash-f" };
    const f = await authorize("tool_025", { idempotency: failKey });
    assert.equal(f.kind, "authorized");
    if (f.kind === "authorized") await engine.release(f.authorization, "capability_failed", { toolName: "tool_025", key: failKey.key });
    assert.equal(await balance(), 4_250_000 + 250_000);
    const retry = await authorize("tool_025", { idempotency: failKey });
    assert.equal(retry.kind, "authorized");
    assert.equal(await balance(), 4_250_000);
    await reconcile(store, account.id);
  });

  test(`${label}: concurrent requests with one idempotency key reserve exactly once`, { skip: options.skip }, async () => {
    const { store, engine, account, authorize, balance } = await setup();
    await engine.addCredit({ accountId: account.id, amount: "5.00" });
    const results = await Promise.all(Array.from({ length: 10 }, () => authorize("tool_025", { idempotency: { key: "same", requestHash: "h" } })));
    assert.equal(results.filter(r => r.kind === "authorized").length, 1);
    assert.equal(results.filter(r => r.kind === "idempotency_in_progress").length, 9);
    assert.equal(await balance(), 4_750_000);
    await reconcile(store, account.id);
  });

  test(`${label}: subscription allowance is consumed first, falls back to credits, rolls over monthly`, { skip: options.skip }, async () => {
    const { store, engine, account, authorize, balance, setNow } = await setup();
    await engine.addCredit({ accountId: account.id, amount: "1.00" });
    await engine.assignSubscription({ accountId: account.id, plan: "developer", includedUsd: "0.50" });
    for (let i = 0; i < 2; i++) {
      const r = await authorize();
      assert.equal(r.kind === "authorized" && r.authorization.rail, "subscription");
      if (r.kind === "authorized") await engine.settle(r.authorization);
    }
    assert.equal(await balance(), 1_000_000, "credits untouched while the allowance lasts");
    const view = await engine.balanceView(account.id);
    assert.equal(view.subscription!.used, "0.50"); assert.equal(view.subscription!.remaining, "0.00");
    // Exhausted + fallback allowed → prepaid credits.
    const fb = await authorize();
    assert.equal(fb.kind === "authorized" && fb.authorization.rail, "api_credits");
    assert.equal(await balance(), 750_000);
    // Exhausted + fallback NOT allowed (explicit subscription) → subscription_exhausted, no charge.
    const strict = await authorize("tool_025", { rails: ["subscription"], subscriptionFallback: false });
    assert.equal(strict.kind === "insufficient" && strict.reason, "subscription_exhausted");
    // auto without fallback also stops at the exhausted allowance.
    const noFallback = await authorize("tool_025", { subscriptionFallback: false });
    assert.equal(noFallback.kind === "insufficient" && noFallback.reason, "subscription_exhausted");
    assert.equal(await balance(), 750_000);
    // Next billing period (anchored on Jan 31 → Feb 28): fresh allowance.
    setNow(new Date("2026-03-01T00:00:00.000Z"));
    const next = await authorize();
    assert.equal(next.kind === "authorized" && next.authorization.rail, "subscription");
    const snap = await store.getSubscription(account.id, new Date("2026-03-01T00:00:00.000Z"));
    assert.equal(snap!.periodStart, "2026-02-28T10:00:00.000Z");
    assert.equal(snap!.usedMicros, 250_000);
    // Subscription exhausted and no credit → insufficient.
    await engine.adjustCredit({ accountId: account.id, amount: "-0.75", reason: "drain" });
    await authorize();
    const none = await authorize();
    assert.equal(none.kind === "insufficient" && none.reason, "insufficient_credits");
    await reconcile(store, account.id);
  });

  test(`${label}: refund releases a reservation exactly once (credits and allowance), and release-stale recovers crashes`, { skip: options.skip }, async () => {
    const { store, engine, account, authorize, balance, setNow } = await setup();
    await engine.addCredit({ accountId: account.id, amount: "1.00" });
    const r = await authorize("tool_025", { rails: ["api_credits"] });
    assert.ok(r.kind === "authorized");
    const refund1 = await engine.release(r.authorization, "capability_failed");
    const refund2 = await engine.release(r.authorization, "capability_failed");
    assert.ok(refund1); assert.equal(refund2, null);
    assert.equal(await balance(), 1_000_000);
    const entries = await store.listLedger(account.id, { limit: 10 });
    assert.equal(entries.find(e => e.id === r.authorization.transactionId)!.status, "refunded");
    const refund = entries.find(e => e.type === "refund")!;
    assert.equal(refund.relatedEntryId, r.authorization.transactionId);
    assert.equal(refund.amountMicros, 250_000);
    // Subscription refund restores allowance.
    await engine.assignSubscription({ accountId: account.id, plan: "developer", includedUsd: "0.25" });
    const s = await authorize();
    assert.ok(s.kind === "authorized" && s.authorization.rail === "subscription");
    await engine.release(s.authorization, "capability_failed");
    assert.equal((await engine.balanceView(account.id)).subscription!.used, "0.00");
    // A reservation abandoned by a crashed process is refunded by release-stale once it is old.
    const crashed = await authorize("tool_025", { rails: ["api_credits"] });
    assert.ok(crashed.kind === "authorized");
    assert.equal(await balance(), 750_000);
    await engine.releaseStale();
    assert.equal(await balance(), 750_000, "a fresh reservation is not stale yet");
    setNow(new Date(Date.parse("2026-01-31T10:00:00.000Z") + (config.reservationTtlSeconds + 5) * 1000));
    // (>= 1: a shared test database may hold other suites' abandoned reservations too.)
    assert.ok((await engine.releaseStale()).released >= 1);
    assert.equal(await balance(), 1_000_000);
    assert.equal((await store.listLedger(account.id, { limit: 50 })).find(e => e.id === crashed.authorization.transactionId)!.status, "refunded");
    await reconcile(store, account.id);
  });

  test(`${label}: credit top-ups are idempotent by external transaction id; adjustments can't go negative`, { skip: options.skip }, async () => {
    const { store, engine, account, balance } = await setup();
    const a = await engine.addCredit({ accountId: account.id, amount: "10", externalTransactionId: "stripe_pi_1" });
    const b = await engine.addCredit({ accountId: account.id, amount: "10", externalTransactionId: "stripe_pi_1" });
    assert.equal(a.duplicate, false); assert.equal(b.duplicate, true);
    assert.equal(a.transaction.id, b.transaction.id);
    assert.equal(await balance(), 10_000_000);
    await assert.rejects(engine.adjustCredit({ accountId: account.id, amount: "-10.01", reason: "too much" }), { code: "negative_balance" });
    await assert.rejects(engine.addCredit({ accountId: account.id, amount: "-1" }), { code: "invalid_amount" });
    await assert.rejects(engine.addCredit({ accountId: account.id, amount: "0.0000001" }), { code: "invalid_amount" });
    const adj = await engine.adjustCredit({ accountId: account.id, amount: "-2.50", reason: "goodwill reversal" });
    assert.equal(adj.balance.amount, "7.50");
    await reconcile(store, account.id);
  });

  test(`${label}: API keys — hashed at rest, revoked/expired/suspended keys are rejected`, { skip: options.skip }, async () => {
    const { store, engine, account, apiKey, auth, setNow } = await setup();
    assert.match(apiKey, /^raf_live_[A-Za-z0-9_-]{43}$/);
    const keys = await store.listApiKeys(account.id);
    assert.ok(!JSON.stringify(keys).includes(apiKey), "the raw key must never be stored");
    assert.equal(keys[0]!.keyPrefix, apiKey.slice(0, 13));
    assert.equal((await engine.authenticate(apiKey + "x")).ok, false);
    assert.equal((await engine.authenticate("raf_live_" + "A".repeat(43))).ok, false);
    const test = await engine.createApiKey({ accountId: account.id, environment: "test", expiresAt: "2026-02-01T00:00:00.000Z" });
    assert.match(test.apiKey, /^raf_test_/);
    assert.equal((await engine.authenticate(test.apiKey)).ok, true);
    setNow(new Date("2026-02-02T00:00:00.000Z"));
    const expired = await engine.authenticate(test.apiKey);
    assert.equal(!expired.ok && expired.code, "api_key_expired");
    await engine.revokeApiKey(account.id, auth.ok ? auth.key.id : "");
    const revoked = await engine.authenticate(apiKey);
    assert.equal(!revoked.ok && revoked.code, "api_key_revoked");
    const other = await engine.createApiKey({ accountId: account.id });
    await store.setAccountStatus(account.id, "suspended");
    const suspended = await engine.authenticate(other.apiKey);
    assert.equal(!suspended.ok && suspended.code, "account_inactive");
    assert.equal(!suspended.ok && suspended.status, 403);
  });

  test(`${label}: a zero-priced tool authorizes as the free rail with no charge`, { skip: options.skip }, async () => {
    const { engine, authorize, balance } = await setup({ free_tool: 0 });
    const r = await authorize("free_tool");
    assert.ok(r.kind === "authorized");
    assert.equal(r.authorization.rail, "free");
    assert.equal(r.authorization.chargedMicros, 0);
    assert.equal(await balance(), 0);
    void engine;
  });
}

export { disabledBillingConfig };
