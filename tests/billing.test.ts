import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import express from "express";
import { z } from "zod";
import { createApp } from "../src/api/app.js";
import { loadConfig } from "../src/config/env.js";
import { capabilities } from "../src/domain/capabilities.js";
import { prices } from "../src/billing/catalog.js";
import { BillingService } from "../src/billing/service.js";
import { buildOpenapi } from "../src/api/openapi.js";
import {
  BillingEngine, MemoryBillingStore, createPaymentDispatcher, detectCredentials, formatMicros, loadBillingConfig, selectPayment, usdToMicros,
  type RailAvailability
} from "../src/billing/unified/index.js";
import { billingStoreContract } from "./billing-contract.js";

billingStoreContract("MemoryBillingStore", async () => new MemoryBillingStore());

const key = "test-only-not-a-real-credential-12345";
const ADMIN = "billing-admin-secret-for-tests-only-0123456789";
const wallet = "0x1234567890123456789012345678901234567890";
const billingEnv = { RAFID_API_KEYS: key, LOG_LEVEL: "silent", RATE_LIMIT_ENABLED: "false", API_CREDITS_ENABLED: "true", SUBSCRIPTIONS_ENABLED: "true", BILLING_ADMIN_SECRET: ADMIN };
const tool = (name: string) => capabilities.find(c => c.name === name)!;
const research = tool("research_company");          // $0.15
const omanProperty = tool("analyze_oman_property");  // $0.25
const analyzeProperty = tool("analyze_property");    // $0.01
/** Test seam: temporarily replace a capability's execute() (spy / failure injection). */
const mutable = (c: (typeof capabilities)[number]) => c as unknown as { execute: (i: unknown) => Promise<unknown> };

async function start(t: { after(fn: () => void): void }, env: Record<string, string> = {}, store = new MemoryBillingStore()) {
  const config = loadConfig({ ...billingEnv, ...env });
  const app = createApp(config, { logger: () => {}, billingStore: store });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const admin = async (method: string, path: string, body?: unknown, secret = ADMIN) => {
    const r = await fetch(base + "/api/internal/billing" + path, { method, headers: { "X-Billing-Admin-Key": secret, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };
  const newAccount = async (opts: { credit?: string; plan?: string; includedUsd?: string } = {}) => {
    const acct = await admin("POST", "/accounts", { name: "Agent B Inc", email: "ops@agent-b.example" });
    assert.equal(acct.status, 201);
    const accountId = acct.body.data.id as string;
    const k = await admin("POST", `/accounts/${accountId}/api-keys`, { name: "prod" });
    assert.equal(k.status, 201);
    if (opts.credit) assert.equal((await admin("POST", `/accounts/${accountId}/credits`, { amount: opts.credit, reason: "prepaid" })).status, 201);
    if (opts.plan) assert.equal((await admin("PUT", `/accounts/${accountId}/subscription`, { plan: opts.plan, ...(opts.includedUsd ? { includedUsd: opts.includedUsd } : {}) })).status, 200);
    return { accountId, apiKey: k.body.data.apiKey as string, keyId: k.body.data.key.id as string };
  };
  const call = (c: (typeof capabilities)[number], apiKey?: string, headers: Record<string, string> = {}, body: unknown = c.example) => fetch(base + "/api/v1" + c.path, {
    method: "POST", headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), ...headers }, body: JSON.stringify(body)
  });
  const balance = async (apiKey: string) => (await (await fetch(base + "/api/v1/account/balance", { headers: { Authorization: `Bearer ${apiKey}` } })).json() as any).data;
  return { base, config, store, admin, newAccount, call, balance };
}

// ---------------------------------------------------------------------------------------------
// Pure units: money, selection, config
// ---------------------------------------------------------------------------------------------

test("money: exact integer micro-USD conversion and formatting, no floating point drift", () => {
  assert.equal(usdToMicros("0.15"), 150_000);
  assert.equal(usdToMicros(0.15), 150_000);
  assert.equal(usdToMicros(0.1 + 0.2), 300_000);
  assert.equal(usdToMicros("-2.5"), -2_500_000);
  assert.equal(formatMicros(8_350_000), "8.35");
  assert.equal(formatMicros(1), "0.000001");
  assert.equal(formatMicros(10_000_000), "10.00");
  for (const bad of ["abc", "1.0000001", "", "1e3", "NaN"]) assert.throws(() => usdToMicros(bad));
  for (const c of capabilities) assert.equal(usdToMicros(c.price) / 1e6, c.price);
});

test("payment selection: deterministic priority, explicit hints never charge the API key for another rail", () => {
  const all: RailAvailability = { billing: true, apiCredits: true, subscription: true, x402: true, l402: true, mppCharge: true };
  const creds = (h: Record<string, string>) => detectCredentials(n => h[n.toLowerCase()]);
  const k = "raf_live_" + "A".repeat(43);
  const auto = selectPayment(undefined, creds({ authorization: `Bearer ${k}`, "x-payment": "p" }), all, true);
  assert.deepEqual(auto, { kind: "account", apiKey: k, rails: ["subscription", "api_credits"], subscriptionFallback: true, externalFallback: "x402" });
  assert.deepEqual(selectPayment("x402", creds({ authorization: `Bearer ${k}` }), all, true), { kind: "external", rail: "x402" });
  assert.deepEqual(selectPayment("credits", creds({ authorization: `Bearer ${k}` }), all, true), { kind: "account", apiKey: k, rails: ["api_credits"], subscriptionFallback: false, externalFallback: null });
  assert.deepEqual(selectPayment("subscription", creds({ authorization: `Bearer ${k}` }), all, true), { kind: "account", apiKey: k, rails: ["subscription"], subscriptionFallback: false, externalFallback: null });
  assert.equal((selectPayment("credits", creds({}), all, true) as any).code, "api_key_required");
  assert.deepEqual(selectPayment(undefined, creds({ authorization: "L402 mac:pre" }), all, true), { kind: "external", rail: "l402" });
  assert.deepEqual(selectPayment(undefined, creds({ authorization: "Payment abc" }), all, true), { kind: "external", rail: "mpp" });
  assert.deepEqual(selectPayment(undefined, creds({ "x-api-key": key }), all, true), { kind: "legacy" });
  assert.deepEqual(selectPayment(undefined, creds({}), all, true), { kind: "payment_required" });
  assert.deepEqual(selectPayment(undefined, creds({}), { ...all, billing: false, apiCredits: false, subscription: false }, true), { kind: "legacy" });
  assert.equal((selectPayment("l402", creds({}), { ...all, l402: false }, true) as any).code, "payment_method_unavailable");
  assert.equal((selectPayment("bitcoin", creds({}), all, true) as any).code, "invalid_payment_method");
  assert.equal((selectPayment("AUTO", creds({}), all, true)).kind, "payment_required");
});

test("billing config: inert by default, fails closed on unsafe production and weak admin secrets", () => {
  const off = loadConfig({ RAFID_API_KEYS: key });
  assert.equal(off.billing.enabled, false);
  assert.throws(() => loadConfig({ RAFID_API_KEYS: key, API_CREDITS_ENABLED: "yes" }), /API_CREDITS_ENABLED/);
  assert.throws(() => loadConfig({ API_CREDITS_ENABLED: "true", NODE_ENV: "production", AUTH_MODE: "postgres", DATABASE_URL: "" }, { requireApiKeys: false }), /BILLING_DATABASE_URL/);
  assert.equal(loadConfig({ API_CREDITS_ENABLED: "true", NODE_ENV: "production", BILLING_DATABASE_URL: "postgres://x/y" }, { requireApiKeys: false }).billing.enabled, true);
  assert.throws(() => loadConfig({ RAFID_API_KEYS: key, BILLING_ADMIN_SECRET: "short" }), /BILLING_ADMIN_SECRET/);
  assert.throws(() => loadConfig({ RAFID_API_KEYS: key, BILLING_PLANS_JSON: "{" }), /BILLING_PLANS_JSON/);
  const custom = loadBillingConfig({ SUBSCRIPTIONS_ENABLED: "true", BILLING_PLANS_JSON: JSON.stringify({ developer: { monthlyIncludedUsd: "12.5" }, scale: { name: "Scale", monthlyIncludedUsd: 200 } }) }, { nodeEnv: "test" });
  assert.equal(custom.plans.developer!.allowance.monthlyIncludedMicros, 12_500_000);
  assert.equal(custom.plans.scale!.allowance.monthlyIncludedMicros, 200_000_000);
  assert.equal(custom.plans.growth!.allowance.monthlyIncludedMicros, 50_000_000);
  assert.equal(loadConfig({ RAFID_API_KEYS: key, API_CREDITS_ENABLED: "true", API_KEY_AUTH_ENABLED: "false" }).billing.enabled, false);
});

// ---------------------------------------------------------------------------------------------
// HTTP: API credits
// ---------------------------------------------------------------------------------------------

test("API credits over REST: $10.00 → research_company ($0.15) → $9.85, billing meta + headers, settled ledger entry", async t => {
  const { newAccount, call, balance, admin } = await start(t);
  const { apiKey, accountId } = await newAccount({ credit: "10.00" });
  const res = await call(research, apiKey, { "Idempotency-Key": "first-call" });
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.equal(body.success, true);
  assert.deepEqual(body.data, await research.execute(research.example));
  assert.ok(research.output.safeParse(body.data).success, "output schema unchanged");
  assert.equal(body.meta.tool, "research_company");
  assert.equal(body.meta.price, 0.15);
  assert.deepEqual({ ...body.meta.billing, transactionId: undefined }, { rail: "api_credits", amount: "0.15", currency: "USD", remainingBalance: "9.85", transactionId: undefined });
  assert.match(body.meta.billing.transactionId, /^txn_/);
  assert.equal(res.headers.get("x-rafid-billing-rail"), "api_credits");
  assert.equal(res.headers.get("x-rafid-charge"), "0.15");
  assert.equal(res.headers.get("x-rafid-balance-remaining"), "9.85");
  assert.equal(res.headers.get("x-rafid-transaction-id"), body.meta.billing.transactionId);
  assert.match(res.headers.get("access-control-expose-headers") ?? "", /X-Rafid-Balance-Remaining/);
  assert.equal((await balance(apiKey)).credits.available, "9.85");
  const ledger = (await admin("GET", `/accounts/${accountId}/ledger`)).body.data.transactions;
  const debit = ledger.find((e: any) => e.type === "debit");
  assert.deepEqual({ tool: debit.tool, rail: debit.rail, amount: debit.amount, currency: debit.currency, status: debit.status, requestId: debit.requestId },
    { tool: "research_company", rail: "api_credits", amount: "0.15", currency: "USD", status: "settled", requestId: res.headers.get("x-request-id") });
});

test("API credits: insufficient balance → 402 insufficient_credits with price, balance and only enabled rails; nothing charged or executed", async t => {
  const { newAccount, call, balance } = await start(t);
  const { apiKey } = await newAccount({ credit: "0.07" });
  const original = research.execute; let ran = 0;
  mutable(research).execute = async (i: unknown) => { ran++; return original(i); };
  t.after(() => { mutable(research).execute = original; });
  const res = await call(research, apiKey);
  assert.equal(res.status, 402);
  const body = await res.json() as any;
  assert.equal(body.error.code, "insufficient_credits");
  assert.equal(body.tool, "research_company");
  assert.deepEqual(body.price, { amount: "0.15", currency: "USD" });
  assert.deepEqual(body.balance, { amount: "0.07", currency: "USD" });
  assert.deepEqual(body.paymentOptions, ["api_credits", "subscription"], "x402/L402/MPP are disabled here and must not be advertised");
  assert.equal(ran, 0);
  assert.equal((await balance(apiKey)).credits.available, "0.07");
});

test("API credits: invalid, revoked and malformed keys are rejected with 401; legacy X-API-Key still works and is never charged", async t => {
  const { newAccount, call, admin, balance } = await start(t);
  const { apiKey, accountId, keyId } = await newAccount({ credit: "1.00" });
  const bad = await call(analyzeProperty, "raf_live_" + "Z".repeat(43));
  assert.equal(bad.status, 401);
  assert.equal((await bad.json() as any).error.code, "invalid_api_key");
  assert.match(bad.headers.get("www-authenticate") ?? "", /^Bearer /);
  assert.equal((await call(analyzeProperty, "raf_live_short")).status, 401);
  assert.equal((await admin("POST", `/accounts/${accountId}/api-keys/${keyId}/revoke`)).status, 200);
  const revoked = await call(analyzeProperty, apiKey);
  assert.equal(revoked.status, 401);
  assert.equal((await revoked.json() as any).error.code, "api_key_revoked");
  // Legacy customer keys keep their exact old behavior (no billing).
  const legacy = await call(analyzeProperty, undefined, { "X-API-Key": key });
  assert.equal(legacy.status, 200);
  assert.equal((await legacy.json() as any).meta.billing, undefined);
  assert.equal((await call(analyzeProperty, undefined, { "X-API-Key": "wrong" })).status, 401);
  const other = await admin("POST", `/accounts/${accountId}/api-keys`, {});
  assert.equal((await balance(other.body.data.apiKey)).credits.available, "1.00");
});

test("no usable credential → generic 402 payment_required with discovery (not x402-only), schema-invalid input is never charged", async t => {
  const { call, newAccount, balance } = await start(t, { X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet });
  const res = await call(research);
  assert.equal(res.status, 402);
  const body = await res.json() as any;
  assert.equal(body.error.code, "payment_required");
  assert.deepEqual(body.price, { amount: "0.15", currency: "USD" });
  assert.deepEqual(body.paymentOptions.x402, { enabled: true, network: "eip155:84532", asset: "USDC", selectWith: "X-Rafid-Payment-Method: x402" });
  assert.equal(body.paymentOptions.apiCredits.enabled, true);
  assert.equal(body.paymentOptions.subscription.enabled, true);
  assert.deepEqual(body.paymentOptions.l402, { enabled: false });
  assert.deepEqual(body.paymentOptions.mpp, { enabled: false });
  assert.equal(body.paymentMethods, "/api/v1/payment-methods");
  const { apiKey } = await newAccount({ credit: "1.00" });
  const invalid = await call(research, apiKey, {}, { nope: true });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json() as any).error.code, "INVALID_INPUT");
  assert.equal((await call(research, apiKey, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await balance(apiKey)).credits.available, "1.00");
  const badHint = await call(research, apiKey, { "X-Rafid-Payment-Method": "bitcoin" });
  assert.equal(badHint.status, 400);
  assert.equal((await badHint.json() as any).error.code, "invalid_payment_method");
  const unavailable = await call(research, apiKey, { "X-Rafid-Payment-Method": "l402" });
  assert.equal((await unavailable.json() as any).error.code, "payment_method_unavailable");
});

test("billing disabled (default): canonical routes behave exactly as before — no key → 401, raf key alone → 401, account routes absent", async t => {
  const config = loadConfig({ RAFID_API_KEYS: key, LOG_LEVEL: "silent" });
  const app = createApp(config, { logger: () => {} });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const post = (headers: Record<string, string>) => fetch(base + "/api/v1" + analyzeProperty.path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(analyzeProperty.example) });
  assert.equal((await post({})).status, 401);
  assert.equal((await post({ Authorization: "Bearer raf_live_" + "A".repeat(43) })).status, 401);
  assert.equal((await post({ "X-API-Key": key })).status, 200);
  assert.equal((await fetch(base + "/api/v1/account/balance")).status, 404);
  assert.equal((await fetch(base + "/api/internal/billing/accounts", { method: "POST" })).status, 503);
  const methods = (await (await fetch(base + "/api/v1/payment-methods")).json() as any).data;
  assert.deepEqual(methods.methods, []);
  const caps = (await (await fetch(base + "/api/v1/capabilities")).json() as any).data;
  assert.ok(caps.every((c: any) => !c.paymentMethods.includes("api_credits") && !c.paymentMethods.includes("subscription")));
});

test("concurrency over HTTP: 10 parallel $0.25 calls against $0.75 → exactly 3 succeed, balance exactly $0.00", async t => {
  const { newAccount, call, balance, admin } = await start(t);
  const { apiKey, accountId } = await newAccount({ credit: "0.75" });
  const results = await Promise.all(Array.from({ length: 10 }, () => call(omanProperty, apiKey)));
  assert.equal(results.filter(r => r.status === 200).length, 3);
  assert.equal(results.filter(r => r.status === 402).length, 7);
  assert.equal((await balance(apiKey)).credits.available, "0.00");
  const ledger = (await admin("GET", `/accounts/${accountId}/ledger`)).body.data.transactions;
  assert.equal(ledger.filter((e: any) => e.type === "debit" && e.status === "settled").length, 3);
});

test("idempotency over HTTP: a retry replays without a second charge; a different body with the same key → 409 idempotency_conflict", async t => {
  const { newAccount, call, balance, admin } = await start(t);
  const { apiKey, accountId } = await newAccount({ credit: "1.00" });
  const first = await call(research, apiKey, { "Idempotency-Key": "order-42" });
  const firstBody = await first.json() as any;
  assert.equal(first.status, 200);
  const retry = await call(research, apiKey, { "Idempotency-Key": "order-42" });
  assert.equal(retry.status, 200);
  assert.equal(retry.headers.get("idempotent-replay"), "true");
  assert.deepEqual(await retry.json(), firstBody);
  // Key order doesn't matter: the canonical JSON is hashed.
  const reordered = Object.fromEntries(Object.entries(research.example as Record<string, unknown>).reverse());
  assert.equal((await call(research, apiKey, { "Idempotency-Key": "order-42" }, reordered)).status, 200);
  const conflict = await call(research, apiKey, { "Idempotency-Key": "order-42" }, { ...(research.example as object), company: "A Different Company Ltd" });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json() as any).error.code, "idempotency_conflict");
  assert.equal((await balance(apiKey)).credits.available, "0.85", "charged exactly once");
  const debits = (await admin("GET", `/accounts/${accountId}/ledger`)).body.data.transactions.filter((e: any) => e.type === "debit");
  assert.equal(debits.length, 1);
  assert.equal((await call(research, apiKey, { "Idempotency-Key": "x".repeat(300) })).status, 400);
});

test("idempotency survives a process restart: a new app instance over the same store replays instead of charging", async t => {
  const store = new MemoryBillingStore();
  const a = await start(t, {}, store);
  const { apiKey } = await a.newAccount({ credit: "1.00" });
  const first = await a.call(research, apiKey, { "Idempotency-Key": "restart-1" });
  assert.equal(first.status, 200);
  const b = await start(t, {}, store);
  const again = await b.call(research, apiKey, { "Idempotency-Key": "restart-1" });
  assert.equal(again.status, 200);
  assert.equal(again.headers.get("idempotent-replay"), "true");
  assert.equal((await b.balance(apiKey)).credits.available, "0.85");
});

test("subscription over HTTP: allowance used before credits (auto), exhausted → credit fallback, exhausted + no credit → 402, explicit subscription never falls back", async t => {
  const { newAccount, call, balance } = await start(t);
  const { apiKey } = await newAccount({ credit: "0.25", plan: "developer", includedUsd: "0.50" });
  for (let i = 0; i < 2; i++) {
    const r = await call(omanProperty, apiKey);
    assert.equal(r.status, 200);
    const b = await r.json() as any;
    assert.equal(b.meta.billing.rail, "subscription");
    assert.equal(r.headers.get("x-rafid-subscription-remaining"), i === 0 ? "0.25" : "0.00");
  }
  let view = await balance(apiKey);
  assert.equal(view.credits.available, "0.25");
  assert.deepEqual({ plan: view.subscription.plan, included: view.subscription.included, used: view.subscription.used, remaining: view.subscription.remaining }, { plan: "developer", included: "0.50", used: "0.50", remaining: "0.00" });
  const explicit = await call(omanProperty, apiKey, { "X-Rafid-Payment-Method": "subscription" });
  assert.equal(explicit.status, 402);
  assert.equal((await explicit.json() as any).error.code, "subscription_exhausted");
  const fallback = await call(omanProperty, apiKey);
  assert.equal(fallback.status, 200);
  assert.equal((await fallback.json() as any).meta.billing.rail, "api_credits");
  view = await balance(apiKey);
  assert.equal(view.credits.available, "0.00");
  const none = await call(omanProperty, apiKey);
  assert.equal(none.status, 402);
  const noneBody = await none.json() as any;
  assert.equal(noneBody.error.code, "insufficient_credits");
  assert.equal(noneBody.subscription.remaining, "0.00");
  // Explicit credits skips the allowance entirely.
  const acct2 = await newAccount({ credit: "1.00", plan: "developer" });
  const credits = await call(omanProperty, acct2.apiKey, { "X-Rafid-Payment-Method": "credits" });
  assert.equal((await credits.json() as any).meta.billing.rail, "api_credits");
  assert.equal((await balance(acct2.apiKey)).subscription.used, "0.00");
});

test("subscription with BILLING_SUBSCRIPTION_CREDIT_FALLBACK=false: an exhausted allowance does not spend prepaid credits", async t => {
  const { newAccount, call, balance } = await start(t, { BILLING_SUBSCRIPTION_CREDIT_FALLBACK: "false" });
  const { apiKey } = await newAccount({ credit: "5.00", plan: "developer", includedUsd: "0.25" });
  assert.equal((await call(omanProperty, apiKey)).status, 200);
  const blocked = await call(omanProperty, apiKey);
  assert.equal(blocked.status, 402);
  assert.equal((await blocked.json() as any).error.code, "subscription_exhausted");
  assert.equal((await balance(apiKey)).credits.available, "5.00");
  const noSub = await newAccount({ credit: "1.00" });
  assert.equal((await call(omanProperty, noSub.apiKey)).status, 200, "accounts without a subscription still pay from credits");
});

test("capability failure after authorization releases the reservation: refunded + refund ledger entries, balance restored, retry re-executes", async t => {
  const { newAccount, call, balance, admin } = await start(t);
  const { apiKey, accountId } = await newAccount({ credit: "1.00" });
  const original = research.execute; let fail = true;
  mutable(research).execute = async (i: unknown) => { if (fail) throw new Error("provider exploded: private detail"); return original(i); };
  t.after(() => { mutable(research).execute = original; });
  const res = await call(research, apiKey, { "Idempotency-Key": "retry-me" });
  assert.equal(res.status, 500);
  const text = await res.text();
  assert.ok(!text.includes("private detail"));
  assert.equal(res.headers.get("x-rafid-charge"), "0.00");
  assert.match(res.headers.get("x-rafid-refunded-transaction-id") ?? "", /^txn_/);
  assert.equal((await balance(apiKey)).credits.available, "1.00");
  const ledger = (await admin("GET", `/accounts/${accountId}/ledger`)).body.data.transactions;
  const debit = ledger.find((e: any) => e.type === "debit");
  const refund = ledger.find((e: any) => e.type === "refund");
  assert.equal(debit.status, "refunded");
  assert.equal(refund.status, "settled");
  assert.equal(refund.amount, "0.15");
  assert.equal(refund.relatedTransactionId, debit.id);
  assert.equal(refund.reason, "capability_failed");
  fail = false;
  const retry = await call(research, apiKey, { "Idempotency-Key": "retry-me" });
  assert.equal(retry.status, 200);
  assert.equal(retry.headers.get("idempotent-replay"), null, "a failed attempt is retried, not replayed");
  assert.equal((await balance(apiKey)).credits.available, "0.85");
});

test("x402 price equals API-credit debit for every capability (single canonical price)", () => {
  const service = new BillingService();
  const engine = new BillingEngine({ config: loadBillingConfig({ API_CREDITS_ENABLED: "true" }, { nodeEnv: "test" }), store: new MemoryBillingStore(), priceUsd: t => service.getToolPrice(t as never) });
  for (const c of capabilities) {
    const x402 = service.buildX402PaymentRequirement(c.name, "eip155:84532", wallet).price;
    assert.equal(x402, "$" + formatMicros(engine.priceMicros(c.name)));
    assert.equal(engine.priceMicros(c.name), usdToMicros(prices[c.name]));
  }
});

test("explicit x402 selection never charges the API key: the canonical route re-dispatches to the unchanged x402 gate", async t => {
  const { newAccount, base, balance } = await start(t, { X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet });
  const { apiKey } = await newAccount({ credit: "5.00" });
  const post = (path: string, headers: Record<string, string>) => fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(analyzeProperty.example) });
  const viaCanonical = await post("/api/v1" + analyzeProperty.path, { Authorization: `Bearer ${apiKey}`, "X-Rafid-Payment-Method": "x402" });
  const viaDedicated = await post("/api/v1/x402" + analyzeProperty.path, {});
  assert.notEqual(viaCanonical.status, 200);
  assert.equal(viaCanonical.status, viaDedicated.status, "same gate, same protocol response");
  assert.equal(viaCanonical.headers.get("payment-required") === null, viaDedicated.headers.get("payment-required") === null);
  assert.equal(viaCanonical.headers.get("x-rafid-billing-rail"), null);
  assert.equal((await balance(apiKey)).credits.available, "5.00");
  // auto + an x402 credential and no API key also goes to the x402 gate, not a billing 402.
  const autoX402 = await post("/api/v1" + analyzeProperty.path, { "X-PAYMENT": "not-a-real-payment" });
  const body = await autoX402.json().catch(() => ({})) as any;
  assert.notEqual(body?.error?.code, "payment_required");
  // auto + a Rafid key that can't pay + an x402 credential → falls through to x402 (priority 3).
  const broke = await newAccount({});
  const fallthrough = await post("/api/v1" + analyzeProperty.path, { Authorization: `Bearer ${broke.apiKey}`, "X-PAYMENT": "not-a-real-payment" });
  const dedicatedPaid = await post("/api/v1/x402" + analyzeProperty.path, { "X-PAYMENT": "not-a-real-payment" });
  assert.equal(fallthrough.status, dedicatedPaid.status);
  assert.notEqual(((await fallthrough.json().catch(() => ({}))) as any)?.error?.code, "insufficient_credits");
});

test("free tools resolve on the free rail with no account or payment (unified dispatcher)", async t => {
  const config = loadConfig({ ...billingEnv });
  const engine = new BillingEngine({ config: config.billing, store: new MemoryBillingStore(), priceUsd: t => t === "free_echo" ? 0 : 1 });
  const freeTool = { name: "free_echo", path: "/free/echo", input: z.strictObject({ text: z.string() }), execute: async (i: unknown) => ({ echoed: (i as { text: string }).text }) };
  const app = express();
  app.use((_req, res, next) => { res.locals.requestId = "req-free"; next(); });
  app.use(createPaymentDispatcher({ engine, config, capabilities: [freeTool], priceUsd: () => 0, bodyParserFor: () => express.json(), externalPath: () => "/nowhere" }));
  const server = app.listen(0, "127.0.0.1");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const res = await fetch(`http://127.0.0.1:${address.port}/api/v1/free/echo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "hi" }) });
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.deepEqual(body.data, { echoed: "hi" });
  assert.deepEqual(body.meta.billing, { rail: "free", amount: "0.00", currency: "USD" });
  const auth = await engine.authorize({ toolName: "free_echo", account: { id: "acct_x" } as never, key: { id: "key_x" } as never, rails: ["api_credits"], subscriptionFallback: true, requestId: "r" });
  assert.deepEqual(auth, { kind: "authorized", authorization: { authorized: true, rail: "free", priceMicros: 0, chargedMicros: 0, accountId: "acct_x", apiKeyId: "key_x" } });
});

// ---------------------------------------------------------------------------------------------
// Customer + admin endpoints
// ---------------------------------------------------------------------------------------------

test("customer account endpoints: balance, usage and transactions for the calling key only", async t => {
  const { newAccount, call, base } = await start(t);
  const a = await newAccount({ credit: "12.40", plan: "developer" });
  const b = await newAccount({ credit: "3.00" });
  await call(research, a.apiKey, { "X-Rafid-Payment-Method": "credits" });
  await call(omanProperty, a.apiKey);
  const get = (path: string, k?: string) => fetch(base + path, { headers: k ? { Authorization: `Bearer ${k}` } : {} });
  assert.equal((await get("/api/v1/account/balance")).status, 401);
  assert.equal((await get("/api/v1/account/balance", "raf_live_" + "Q".repeat(43))).status, 401);
  const bal = (await (await get("/api/v1/account/balance", a.apiKey)).json() as any).data;
  assert.equal(bal.accountId, a.accountId);
  assert.deepEqual(bal.credits, { available: "12.25", currency: "USD" });
  assert.deepEqual({ plan: bal.subscription.plan, included: bal.subscription.included, used: bal.subscription.used, remaining: bal.subscription.remaining }, { plan: "developer", included: "10.00", used: "0.25", remaining: "9.75" });
  const usage = (await (await get("/api/v1/account/usage", a.apiKey)).json() as any).data;
  assert.deepEqual(usage.tools.map((u: any) => [u.tool, u.rail, u.calls, u.charged.amount]), [["analyze_oman_property", "subscription", 1, "0.25"], ["research_company", "api_credits", 1, "0.15"]]);
  assert.equal(usage.total.amount, "0.40");
  const txns = (await (await get("/api/v1/account/transactions?limit=2", a.apiKey)).json() as any).data;
  assert.equal(txns.transactions.length, 2);
  assert.ok(txns.nextBefore);
  const page2 = (await (await get(`/api/v1/account/transactions?before=${txns.nextBefore}`, a.apiKey)).json() as any).data;
  assert.deepEqual(page2.transactions.map((x: any) => x.type), ["credit"]);
  const other = (await (await get("/api/v1/account/balance", b.apiKey)).json() as any).data;
  assert.equal(other.credits.available, "3.00");
  assert.equal(other.subscription, null);
});

test("billing admin API: secret-protected (503 unset, 401 wrong), full account lifecycle, raw key shown exactly once", async t => {
  const unset = await start(t, { BILLING_ADMIN_SECRET: "" });
  assert.equal((await unset.admin("POST", "/accounts", { name: "x" })).status, 503);
  const { admin, call } = await start(t);
  assert.equal((await admin("POST", "/accounts", { name: "x" }, "wrong-secret-wrong-secret-wrong-secret")).status, 401);
  assert.equal((await fetch((await start(t)).base + "/api/internal/billing/accounts", { method: "POST", headers: { Authorization: `Bearer ${ADMIN}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Bearer Admin" }) })).status, 201);
  assert.equal((await admin("POST", "/accounts", { name: "" })).status, 400);
  const acct = (await admin("POST", "/accounts", { name: "Enterprise Platform C" })).body.data;
  assert.match(acct.id, /^acct_/);
  const created = (await admin("POST", `/accounts/${acct.id}/api-keys`, { name: "ci", environment: "test" })).body.data;
  assert.match(created.apiKey, /^raf_test_/);
  const listed = (await admin("GET", `/accounts/${acct.id}/api-keys`)).body;
  assert.ok(!JSON.stringify(listed).includes(created.apiKey));
  assert.equal(listed.data[0].prefix, created.apiKey.slice(0, 13));
  const topup = await admin("POST", `/accounts/${acct.id}/credits`, { amount: "25.00", reason: "wire", externalTransactionId: "wire-001" });
  assert.equal(topup.body.data.balance.amount, "25.00");
  const dupe = await admin("POST", `/accounts/${acct.id}/credits`, { amount: "25.00", externalTransactionId: "wire-001" });
  assert.equal(dupe.body.data.duplicate, true);
  assert.equal(dupe.body.data.balance.amount, "25.00");
  assert.equal((await admin("POST", `/accounts/${acct.id}/credits`, { amount: "abc" })).body.error.code, "invalid_amount");
  assert.equal((await admin("POST", `/accounts/${acct.id}/adjustments`, { amount: "-30", reason: "x" })).body.error.code, "negative_balance");
  assert.equal((await admin("POST", `/accounts/${acct.id}/adjustments`, { amount: "-5", reason: "correction" })).body.data.balance.amount, "20.00");
  assert.equal((await admin("PUT", `/accounts/${acct.id}/subscription`, { plan: "platinum" })).body.error.code, "unknown_plan");
  const sub = (await admin("PUT", `/accounts/${acct.id}/subscription`, { plan: "enterprise", includedUsd: "1000" })).body.data;
  assert.equal(sub.plan, "enterprise"); assert.equal(sub.included.amount, "1000.00");
  const view = (await admin("GET", `/accounts/${acct.id}`)).body.data;
  assert.equal(view.credits.available, "20.00");
  assert.equal(view.subscription.included, "1000.00");
  assert.equal((await call(research, created.apiKey)).status, 200);
  assert.equal((await admin("DELETE", `/accounts/${acct.id}/subscription`)).body.data.status, "canceled");
  assert.equal((await admin("DELETE", `/accounts/${acct.id}/subscription`)).status, 404);
  assert.equal((await admin("POST", `/accounts/${acct.id}/status`, { status: "suspended" })).status, 200);
  const suspended = await call(research, created.apiKey);
  assert.equal(suspended.status, 403);
  assert.equal((await suspended.json() as any).error.code, "account_inactive");
  assert.equal((await admin("GET", "/accounts/acct_nope")).status, 404);
  assert.equal((await admin("POST", "/maintenance/release-stale")).body.data.released, 0);
});

// ---------------------------------------------------------------------------------------------
// Discovery, OpenAPI, MCP
// ---------------------------------------------------------------------------------------------

test("discovery: payment-methods, capabilities, pricing, agent.json, well-known manifests, llms.txt and OpenAPI advertise exactly the enabled rails", async t => {
  const { base, config } = await start(t, { X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet });
  const j = async (p: string) => (await (await fetch(base + p)).json()) as any;
  const methods = (await j("/api/v1/payment-methods")).data;
  assert.deepEqual(methods.methods.map((m: any) => m.id), ["x402", "api_credits", "subscription"]);
  assert.equal(methods.selection.header, "X-Rafid-Payment-Method");
  assert.deepEqual(methods.selection.autoPriority, ["subscription", "api_credits", "x402"]);
  assert.deepEqual(methods.methods.find((m: any) => m.id === "subscription").plans.map((p: any) => p.id), ["free", "developer", "growth", "enterprise"]);
  assert.ok(!methods.methods.some((m: any) => m.id === "l402" || m.id === "mpp"), "disabled rails are never listed");
  const caps = (await j("/api/v1/capabilities")).data;
  const rc = caps.find((c: any) => c.name === "research_company");
  assert.deepEqual(rc.paymentMethods, ["x402", "api_credits", "subscription"]);
  assert.deepEqual(rc.pricing, { amount: "0.15", currency: "USD" });
  assert.equal(rc.price, 0.15, "the numeric price field is unchanged");
  const pricing = (await j("/api/v1/pricing")).data;
  assert.deepEqual(pricing.tools, prices);
  assert.deepEqual(pricing.paymentMethods, ["x402", "api_credits", "subscription"]);
  const manifest = await j("/agent.json");
  assert.deepEqual(manifest.tools.find((x: any) => x.name === "research_company").paymentMethods, ["x402", "api_credits", "subscription"]);
  assert.equal(manifest.paymentMethods, "/api/v1/payment-methods");
  assert.equal(manifest.billing.enabled, true);
  assert.ok(manifest.protocols.some((p: any) => p.protocol === "api-key-billing"));
  assert.deepEqual(manifest.payments.methods, ["x402", "api_credits", "subscription"]);
  const card = await j("/.well-known/agent.json");
  assert.deepEqual(card.authentication.schemes, ["x402", "apiKey", "bearer"]);
  const plugin = await j("/.well-known/ai-plugin.json");
  assert.match(plugin.description_for_model, /raf_live_/);
  const agent = (await j("/api/v1/agent")).data;
  assert.equal(agent.paymentMethods, "/api/v1/payment-methods");
  const llms = await (await fetch(base + "/llms.txt")).text();
  assert.match(llms, /Credits route: POST \/api\/v1\/intelligence\/research-company/);
  assert.match(llms, /Idempotency-Key/);
  assert.match(llms, /\/api\/v1\/payment-methods/);
  for (const text of [JSON.stringify(methods), JSON.stringify(manifest), llms, JSON.stringify(caps)]) {
    assert.ok(!text.includes("/api/internal/billing"), "admin endpoints must never be advertised");
    assert.ok(!text.includes(ADMIN));
  }
  const openapi = buildOpenapi(config) as any;
  assert.ok(openapi.components.securitySchemes.BillingApiKey);
  assert.ok(openapi.paths["/api/v1/payment-methods"]);
  assert.ok(openapi.paths["/api/v1/account/balance"]);
  assert.ok(openapi.paths["/mcp/credits"]);
  const op = openapi.paths["/api/v1/intelligence/research-company"].post;
  assert.ok(op.responses["402"]); assert.ok(op.responses["409"]);
  assert.deepEqual(op.security, [{ ApiKeyAuth: [] }, { BillingApiKey: [] }]);
  assert.ok(op.parameters.some((p: any) => p.name === "X-Rafid-Payment-Method"));
  assert.ok(op.parameters.some((p: any) => p.name === "Idempotency-Key"));
  assert.ok(!JSON.stringify(openapi).includes("/api/internal/billing"));
  // Disabled billing: none of the account-backed rails appear anywhere.
  const off = buildOpenapi(loadConfig({ RAFID_API_KEYS: key })) as any;
  assert.equal(off.components.securitySchemes.BillingApiKey, undefined);
  assert.equal(off.paths["/api/v1/account/balance"], undefined);
  assert.equal(off.paths["/api/v1/intelligence/research-company"].post.responses["402"], undefined);
});

const mcpCall = (base: string, path: string, body: unknown, apiKey?: string, headers: Record<string, string> = {}) => fetch(base + path, {
  method: "POST",
  headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), ...headers },
  body: JSON.stringify(body)
});

test("MCP + API credits (/mcp/credits): paid tools/call billed to the key's account, billing in _meta, /mcp unchanged and free", async t => {
  const { base, newAccount, balance } = await start(t);
  const { apiKey } = await newAccount({ credit: "0.20" });
  const unauth = await mcpCall(base, "/mcp/credits", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  assert.equal(unauth.status, 401);
  assert.equal((await unauth.json() as any).error.code, -32001);
  const badKey = await mcpCall(base, "/mcp/credits", { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, "raf_live_" + "B".repeat(43));
  assert.equal(badKey.status, 401);
  const listed = await (await mcpCall(base, "/mcp/credits", { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, apiKey)).json() as any;
  assert.ok(listed.result.tools.some((x: any) => x.name === "research_company"));
  const paid = await (await mcpCall(base, "/mcp/credits", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "research_company", arguments: research.example, _meta: { "com.rafidsystem/idempotency-key": "mcp-1" } } }, apiKey)).json() as any;
  assert.equal(paid.result.isError, undefined);
  assert.deepEqual(paid.result.structuredContent, await research.execute(research.example));
  const billing = paid.result._meta["com.rafidsystem/billing"];
  assert.equal(billing.rail, "api_credits"); assert.equal(billing.amount, "0.15"); assert.equal(billing.remainingBalance, "0.05");
  const replay = await (await mcpCall(base, "/mcp/credits", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "research_company", arguments: research.example, _meta: { "com.rafidsystem/idempotency-key": "mcp-1" } } }, apiKey)).json() as any;
  assert.equal(replay.result._meta["com.rafidsystem/billing"].idempotentReplay, true);
  assert.equal((await balance(apiKey)).credits.available, "0.05");
  const poor = await (await mcpCall(base, "/mcp/credits", { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "research_company", arguments: research.example } }, apiKey)).json() as any;
  assert.equal(poor.result.isError, true);
  const poorBody = JSON.parse(poor.result.content[0].text);
  assert.equal(poorBody.error.code, "insufficient_credits");
  assert.deepEqual(poorBody.balance, { amount: "0.05", currency: "USD" });
  const invalid = await (await mcpCall(base, "/mcp/credits", { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "research_company", arguments: { bogus: 1 } } }, apiKey)).json() as any;
  assert.equal(JSON.parse(invalid.result.content[0].text).error.code, "INVALID_INPUT");
  const wrongRail = await (await mcpCall(base, "/mcp/credits", { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "research_company", arguments: research.example } }, apiKey, { "X-Rafid-Payment-Method": "x402" })).json() as any;
  assert.equal(JSON.parse(wrongRail.result.content[0].text).error.code, "payment_method_unavailable");
  const preview = await (await mcpCall(base, "/mcp/credits", { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "preview_capability", arguments: { capability: "research_company", input: research.example } } }, apiKey)).json() as any;
  assert.ok(preview.result.structuredContent, "free preview tool stays free over /mcp/credits");
  assert.equal((await balance(apiKey)).credits.available, "0.05");
  // The original free /mcp endpoint needs no key and charges nothing.
  const free = await (await mcpCall(base, "/mcp", { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "research_company", arguments: research.example } })).json() as any;
  assert.deepEqual(free.result.structuredContent, await research.execute(research.example));
  assert.equal((await balance(apiKey)).credits.available, "0.05");
});
