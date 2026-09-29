import assert from "node:assert/strict";
import { after, test } from "node:test";
import { once } from "node:events";
import { createApp } from "../src/api/app.js";
import { loadConfig } from "../src/config/env.js";
import { capabilities } from "../src/domain/capabilities.js";
import { BillingEngine, PostgresBillingStore } from "../src/billing/unified/index.js";
import { billingStoreContract } from "./billing-contract.js";

/**
 * Runs the full billing store contract (and HTTP concurrency) against a REAL PostgreSQL, proving
 * the row-lock + conditional-update design under genuine multi-connection concurrency. Opt-in:
 *   TEST_DATABASE_URL=postgres://… npm test     (a dedicated test database — never production)
 */
const url = process.env.TEST_DATABASE_URL;
let shared: PostgresBillingStore | undefined;
const store = async () => {
  if (!shared) { shared = new PostgresBillingStore(url!, { poolMax: 20 }); await shared.migrate(); }
  return shared;
};
after(async () => { await shared?.close(); });

billingStoreContract("PostgresBillingStore", store, { skip: !url });

test("PostgresBillingStore: migrations are idempotent; database constraints forbid negative balances, allowance overdraw and double refunds", { skip: !url }, async () => {
  const s = await store();
  await s.migrate(); await s.migrate();
  const engine = new BillingEngine({ config: loadConfig({ API_CREDITS_ENABLED: "true", SUBSCRIPTIONS_ENABLED: "true" }, { requireApiKeys: false }).billing, store: s, priceUsd: () => 0.25 });
  const acct = await engine.createAccount({ name: "Constraint Co" });
  await assert.rejects(s.pool.query("UPDATE billing_accounts SET credit_balance_micros = -1 WHERE id=$1", [acct.id]), /check/i);
  await engine.assignSubscription({ accountId: acct.id, plan: "developer", includedUsd: "1" });
  await s.getSubscription(acct.id, new Date());
  await assert.rejects(s.pool.query("UPDATE subscription_usage SET used_micros = included_micros + 1 WHERE subscription_id IN (SELECT id FROM billing_subscriptions WHERE account_id=$1)", [acct.id]), /check/i);
  await engine.addCredit({ accountId: acct.id, amount: "1" });
  const { apiKey } = await engine.createApiKey({ accountId: acct.id });
  const auth = await engine.authenticate(apiKey); assert.ok(auth.ok);
  const r = await engine.authorize({ toolName: "t", account: auth.account, key: auth.key, rails: ["api_credits"], subscriptionFallback: true, requestId: "r1" });
  assert.ok(r.kind === "authorized");
  await engine.release(r.authorization, "x");
  await assert.rejects(s.pool.query("INSERT INTO billing_ledger(id,account_id,type,amount_micros,rail,status,related_entry_id) VALUES('txn_dup',$1,'refund',250000,'api_credits','settled',$2)", [acct.id, r.authorization.transactionId]), /unique|duplicate/i);
  const rawKeyRows = await s.pool.query("SELECT * FROM billing_api_keys WHERE account_id=$1", [acct.id]);
  assert.ok(!JSON.stringify(rawKeyRows.rows).includes(apiKey), "the raw API key is never stored");
});

test("PostgresBillingStore over HTTP: 12 parallel $0.25 calls against $1.00 across a real connection pool → exactly 4 succeed", { skip: !url, timeout: 60000 }, async t => {
  const s = await store();
  const config = loadConfig({ RAFID_API_KEYS: "test-only-not-a-real-credential-12345", LOG_LEVEL: "silent", RATE_LIMIT_ENABLED: "false", API_CREDITS_ENABLED: "true" });
  const app = createApp(config, { logger: () => {}, billingStore: s });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const engine = new BillingEngine({ config: config.billing, store: s, priceUsd: () => 0.25 });
  const acct = await engine.createAccount({ name: "HTTP PG" });
  await engine.addCredit({ accountId: acct.id, amount: "1.00" });
  const { apiKey } = await engine.createApiKey({ accountId: acct.id });
  const c = capabilities.find(x => x.name === "analyze_oman_property")!;
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => fetch(`http://127.0.0.1:${address.port}/api/v1${c.path}`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, ...(i % 3 === 0 ? { "Idempotency-Key": `k-${i}` } : {}) }, body: JSON.stringify(c.example)
  })));
  assert.equal(results.filter(r => r.status === 200).length, 4);
  assert.equal(results.filter(r => r.status === 402).length, 8);
  assert.equal((await engine.balanceView(acct.id)).credits.available, "0.00");
  const ledger = await s.listLedger(acct.id, { limit: 100 });
  assert.equal(ledger.filter(e => e.type === "debit" && e.status === "settled").length, 4);
  assert.equal(ledger.filter(e => e.status === "pending").length, 0);
});
