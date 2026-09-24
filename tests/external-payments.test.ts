import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { createApp } from "../src/api/app.js";
import { loadConfig } from "../src/config/env.js";
import { hashAdminPassword } from "../src/middleware/adminAuth.js";
import { capabilities } from "../src/domain/capabilities.js";
import { MemoryBillingStore, usdToMicros, type LedgerEntry } from "../src/billing/unified/index.js";
import { loadExternalPaymentsConfig, disabledExternalPaymentsConfig } from "../src/billing/external/config.js";
import { buildExternalPaymentsReconciliation } from "../src/billing/external/reconciliation.js";
import type { ExternalPaymentStore } from "../src/billing/external/store.js";
import type { StripeClient, StripeWebhookEvent } from "../src/billing/external/stripeClient.js";
import type { JsonRpcCall } from "../src/billing/external/usdcTopup.js";
import type { ExternalPayment } from "../src/billing/external/types.js";

/**
 * Comprehensive tests for the external payment-collection layer (src/billing/external/) — Stripe
 * Checkout + USDC-on-Base top-ups that fund unified billing's prepaid credits from OUTSIDE this
 * codebase (spec section 27's ~27 scenarios). Every test here injects a FAKE StripeClient and a
 * FAKE JsonRpcCall via createApp()'s test-only options (see app.ts) — this file, and therefore
 * CI, never makes a real network call to Stripe or a real Base RPC endpoint. Mirrors
 * tests/billing.test.ts's start()-helper HTTP-testing pattern and tests/revenue.test.ts's
 * topicFor()/JsonRpcCall-mocking pattern for the sibling on-chain verifier.
 */

const key = "test-only-not-a-real-credential-12345";
const ADMIN = "billing-admin-secret-for-tests-only-0123456789";
const USDC_CONTRACT = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RECEIVING_ADDRESS = "0x1111111111111111111111111111111111abcd";
const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topicFor = (address: string): string => "0x" + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
/** A well-formed 0x + 64-hex-char transaction hash, deterministically derived from a readable
 *  label — verifyUsdcTransfer() rejects anything that doesn't match this shape before it ever
 *  makes an RPC call, so every fixture transaction hash in this file must satisfy it. */
const txHash = (label: string): string => "0x" + createHash("sha256").update(label).digest("hex");
const research = capabilities.find(c => c.name === "research_company")!; // $0.15

const externalEnv: Record<string, string> = {
  RAFID_API_KEYS: key, LOG_LEVEL: "silent", RATE_LIMIT_ENABLED: "false",
  API_CREDITS_ENABLED: "true", SUBSCRIPTIONS_ENABLED: "true", BILLING_ADMIN_SECRET: ADMIN,
  STRIPE_SECRET_KEY: "sk_test_not_a_real_key", STRIPE_WEBHOOK_SECRET: "whsec_not_a_real_secret",
  STRIPE_SUCCESS_URL: "https://example.test/success", STRIPE_CANCEL_URL: "https://example.test/cancel",
  STRIPE_TOPUP_MIN_USD: "1", STRIPE_TOPUP_MAX_USD: "1000",
  BASE_RPC_URL: "https://fake-base-rpc.test", BASE_USDC_CONTRACT: USDC_CONTRACT, TOPUP_RECEIVING_ADDRESS: RECEIVING_ADDRESS,
  TOPUP_CONFIRMATIONS: "3", USDC_TOPUP_MIN_USD: "1", USDC_TOPUP_MAX_USD: "1000", TOPUP_EXPIRY_MINUTES: "45"
};

// -------------------------------------------------------------------------------------------
// Fakes — no real network egress, ever.
// -------------------------------------------------------------------------------------------

class FakeStripeClient implements StripeClient {
  sessions: Array<{ id: string; url: string; topupReference: string; accountId: string; amountUsd: number }> = [];
  private n = 0;
  async createCheckoutSession(input: { amountUsd: number; accountId: string; topupReference: string; successUrl: string; cancelUrl: string }) {
    this.n++;
    const id = `cs_test_${this.n}`;
    const url = `https://checkout.stripe.test/${id}`;
    this.sessions.push({ id, url, topupReference: input.topupReference, accountId: input.accountId, amountUsd: input.amountUsd });
    return { id, url };
  }
  constructWebhookEvent(payload: Buffer, signature: string): StripeWebhookEvent {
    if (signature !== "valid-test-signature") throw new Error("No signatures found matching the expected signature for payload");
    return JSON.parse(payload.toString("utf8"));
  }
  async retrieveBalance() { return { availableUsd: 4321.55, pendingUsd: 12.34 }; }
}

function stripeEventBody(id: string, type: string, object: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify({ id, type, data: { object } }));
}

function makeRpcCall(opts: { currentBlock?: number; chainIdHex?: string } = {}) {
  const receipts = new Map<string, unknown>();
  const state = { currentBlock: opts.currentBlock ?? 1000, chainIdHex: opts.chainIdHex ?? "0x2105" }; // 0x2105 = 8453 (Base)
  const rpcCall: JsonRpcCall = (async (method: string, params: unknown[]) => {
    if (method === "eth_chainId") return state.chainIdHex;
    if (method === "eth_blockNumber") return "0x" + state.currentBlock.toString(16);
    if (method === "eth_getTransactionReceipt") {
      const hash = (params as string[])[0]!;
      return receipts.has(hash) ? receipts.get(hash) : null;
    }
    throw new Error(`unexpected RPC method ${method}`);
  }) as JsonRpcCall;
  return { rpcCall, receipts, state };
}

function transferReceipt(opts: { status?: string; contract: string; to: string; amountAtomic: number; blockNumber: number }) {
  return {
    status: opts.status ?? "0x1",
    blockNumber: "0x" + opts.blockNumber.toString(16),
    logs: [{
      address: opts.contract,
      topics: [ERC20_TRANSFER_TOPIC, topicFor("0x0000000000000000000000000000000000dead"), topicFor(opts.to)],
      data: "0x" + BigInt(opts.amountAtomic).toString(16).padStart(64, "0")
    }]
  };
}

// -------------------------------------------------------------------------------------------
// HTTP test harness — mirrors tests/billing.test.ts's start().
// -------------------------------------------------------------------------------------------

async function start(t: { after(fn: () => void): void }, env: Record<string, string> = {}, opts: {
  externalPaymentStore?: ExternalPaymentStore;
  stripeClient?: StripeClient;
  usdcRpcCall?: JsonRpcCall;
  externalPaymentsNow?: () => Date;
} = {}) {
  const config = loadConfig({ ...externalEnv, ...env });
  const app = createApp(config, {
    logger: () => {}, externalPaymentStore: opts.externalPaymentStore, stripeClient: opts.stripeClient,
    usdcRpcCall: opts.usdcRpcCall, externalPaymentsNow: opts.externalPaymentsNow
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const admin = async (method: string, path: string, body?: unknown, secret = ADMIN) => {
    const r = await fetch(base + "/api/internal/billing" + path, { method, headers: { "X-Billing-Admin-Key": secret, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };
  const newAccount = async () => {
    const acct = await admin("POST", "/accounts", { name: "Test Customer", email: "customer@example.test" });
    assert.equal(acct.status, 201);
    const accountId = acct.body.data.id as string;
    const k = await admin("POST", `/accounts/${accountId}/api-keys`, { name: "prod" });
    assert.equal(k.status, 201);
    return { accountId, apiKey: k.body.data.apiKey as string };
  };
  const post = async (path: string, apiKey: string | undefined, body: unknown) => {
    const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  };
  const get = async (path: string, apiKey?: string) => {
    const r = await fetch(base + path, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  };
  const webhook = async (id: string, type: string, object: Record<string, unknown>, signature = "valid-test-signature") => {
    const r = await fetch(base + "/api/v1/billing/webhooks/stripe", { method: "POST", headers: { "Content-Type": "application/json", "stripe-signature": signature }, body: stripeEventBody(id, type, object) as unknown as BodyInit });
    return { status: r.status, body: await r.json().catch(() => null) as any };
  };
  const call = (c: (typeof capabilities)[number], apiKey?: string) => fetch(base + "/api/v1" + c.path, {
    method: "POST", headers: { "Content-Type": "application/json", ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }, body: JSON.stringify(c.example)
  });
  return { base, config, admin, newAccount, post, get, webhook, call };
}

// -------------------------------------------------------------------------------------------
// Config
// -------------------------------------------------------------------------------------------

test("external payments config: inert by default, Stripe/USDC independently optional, production requires a database", () => {
  const off = loadExternalPaymentsConfig({}, { nodeEnv: "test" });
  assert.deepEqual(off, disabledExternalPaymentsConfig);

  const stripeOnly = loadExternalPaymentsConfig({ STRIPE_SECRET_KEY: "sk_x", STRIPE_WEBHOOK_SECRET: "whsec_x" }, { nodeEnv: "test" });
  assert.equal(stripeOnly.stripe.enabled, true);
  assert.equal(stripeOnly.usdc.enabled, false);

  const usdcOnly = loadExternalPaymentsConfig({ BASE_RPC_URL: "https://x", BASE_USDC_CONTRACT: "0xabc", TOPUP_RECEIVING_ADDRESS: "0xdef" }, { nodeEnv: "test" });
  assert.equal(usdcOnly.usdc.enabled, true);
  assert.equal(usdcOnly.stripe.enabled, false);

  assert.throws(() => loadExternalPaymentsConfig({ STRIPE_SECRET_KEY: "sk_x", STRIPE_WEBHOOK_SECRET: "whsec_x" }, { nodeEnv: "production" }), /EXTERNAL_PAYMENTS_DATABASE_URL/);
  assert.doesNotThrow(() => loadExternalPaymentsConfig({ STRIPE_SECRET_KEY: "sk_x", STRIPE_WEBHOOK_SECRET: "whsec_x", EXTERNAL_PAYMENTS_DATABASE_URL: "postgres://x/y" }, { nodeEnv: "production" }));
});

test("BillingStore additions (MemoryBillingStore): listCreditPurchases isolates credit_purchase rows; totalOutstandingBalanceMicros sums every account, including admin-granted credit", async () => {
  const store = new MemoryBillingStore();
  const a = await store.createAccount({ name: "A" });
  const b = await store.createAccount({ name: "B" });
  await store.applyCredit({ accountId: a.id, amountMicros: 10_000_000, type: "credit_purchase", reason: "stripe topup", externalTransactionId: "extpay_1", now: new Date() });
  await store.applyCredit({ accountId: b.id, amountMicros: 5_000_000, type: "credit_purchase", reason: "usdc topup", externalTransactionId: "extpay_2", now: new Date() });
  await store.applyCredit({ accountId: a.id, amountMicros: 2_000_000, type: "credit", reason: "admin grant", now: new Date() });

  const purchases = await store.listCreditPurchases(null);
  assert.equal(purchases.length, 2);
  assert.ok(purchases.every(p => p.type === "credit_purchase"));

  assert.equal(await store.totalOutstandingBalanceMicros(), 10_000_000 + 5_000_000 + 2_000_000);

  const future = new Date(Date.now() + 60_000);
  assert.equal((await store.listCreditPurchases(future)).length, 0);
});

// -------------------------------------------------------------------------------------------
// Stripe checkout creation
// -------------------------------------------------------------------------------------------

test("Stripe checkout: creates a session for a server-bounded amount; rejects out-of-bounds/missing amounts; requires a Rafid API key; never leaks secrets", async t => {
  const stripe = new FakeStripeClient();
  const { newAccount, post } = await start(t, {}, { stripeClient: stripe });
  const { apiKey } = await newAccount();

  const ok = await post("/api/v1/billing/topup/stripe", apiKey, { amountUSD: 20 });
  assert.equal(ok.status, 201);
  assert.match(ok.body.data.checkoutUrl, /^https:\/\/checkout\.stripe\.test\//);
  assert.match(ok.body.data.sessionId, /^cs_test_/);
  assert.equal(stripe.sessions.length, 1);
  assert.doesNotMatch(JSON.stringify(ok.body), /sk_test_not_a_real_key|whsec_not_a_real_secret/);

  assert.equal((await post("/api/v1/billing/topup/stripe", apiKey, { amountUSD: 0.5 })).status, 400);
  assert.equal((await post("/api/v1/billing/topup/stripe", apiKey, { amountUSD: 5000 })).status, 400);
  assert.equal((await post("/api/v1/billing/topup/stripe", apiKey, {})).status, 400);
  assert.equal((await post("/api/v1/billing/topup/stripe", undefined, { amountUSD: 20 })).status, 401);
});

test("Stripe: unconfigured rail answers a single consistent 503, never 404", async t => {
  const { newAccount, post } = await start(t, { STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "" });
  const { apiKey } = await newAccount();
  assert.equal((await post("/api/v1/billing/topup/stripe", apiKey, { amountUSD: 20 })).status, 503);
});

test("Both rails disabled: every external-payments route (including balance) answers 503, never 404", async t => {
  const { newAccount, post, get } = await start(t, { STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "", BASE_RPC_URL: "", BASE_USDC_CONTRACT: "", TOPUP_RECEIVING_ADDRESS: "" });
  const { apiKey } = await newAccount();
  assert.equal((await post("/api/v1/billing/topup/stripe", apiKey, { amountUSD: 5 })).status, 503);
  assert.equal((await post("/api/v1/billing/topup/usdc", apiKey, { amountUSD: 5 })).status, 503);
  assert.equal((await get("/api/v1/billing/balance", apiKey)).status, 503);
});

// -------------------------------------------------------------------------------------------
// Stripe webhook: signature verification + idempotency
// -------------------------------------------------------------------------------------------

test("Stripe webhook: an invalid signature is rejected before anything is trusted; a missing signature header is rejected", async t => {
  const stripe = new FakeStripeClient();
  const { webhook, base } = await start(t, {}, { stripeClient: stripe });
  const bad = await webhook("evt_1", "checkout.session.completed", { metadata: { rafidTopupReference: "extpay_x" }, payment_status: "paid", currency: "usd", amount_total: 1000 }, "wrong-signature");
  assert.equal(bad.status, 400);
  assert.equal(bad.body.success, false);

  const noHeader = await fetch(base + "/api/v1/billing/webhooks/stripe", { method: "POST", headers: { "Content-Type": "application/json" }, body: stripeEventBody("evt_1", "checkout.session.completed", {}) as unknown as BodyInit });
  assert.equal(noHeader.status, 400);
});

test("Stripe checkout completed: funds the account exactly once from a verified webhook; a redelivered event never double-funds", async t => {
  const stripe = new FakeStripeClient();
  const { newAccount, post, webhook, get, admin } = await start(t, {}, { stripeClient: stripe });
  const { accountId, apiKey } = await newAccount();

  const checkout = await post("/api/v1/billing/topup/stripe", apiKey, { amountUSD: 20 });
  assert.equal(checkout.status, 201);
  const topupReference = stripe.sessions.at(-1)!.topupReference;

  assert.equal((await get("/api/v1/billing/balance", apiKey)).body.data.availableUSD, 0);

  const completed = await webhook("evt_checkout_1", "checkout.session.completed", { metadata: { rafidTopupReference: topupReference }, payment_status: "paid", currency: "usd", amount_total: 2000, payment_intent: "pi_1" });
  assert.equal(completed.status, 200);
  assert.deepEqual(completed.body.data, { handled: true, type: "checkout.session.completed" });
  assert.equal((await get("/api/v1/billing/balance", apiKey)).body.data.availableUSD, 20);

  const ledger = (await admin("GET", `/accounts/${accountId}/ledger`)).body.data.transactions;
  const purchases = ledger.filter((e: any) => e.type === "credit_purchase");
  assert.equal(purchases.length, 1);
  assert.equal(purchases[0].amount, "20.00");

  // Redelivered webhook (identical event id) — the true idempotency key — must not double-fund.
  const replay = await webhook("evt_checkout_1", "checkout.session.completed", { metadata: { rafidTopupReference: topupReference }, payment_status: "paid", currency: "usd", amount_total: 2000, payment_intent: "pi_1" });
  assert.equal(replay.status, 200);
  assert.equal((await get("/api/v1/billing/balance", apiKey)).body.data.availableUSD, 20);
});

test("Stripe checkout expired: marks the payment failed and never funds it", async t => {
  const stripe = new FakeStripeClient();
  const { newAccount, post, webhook, get } = await start(t, {}, { stripeClient: stripe });
  const { apiKey } = await newAccount();
  await post("/api/v1/billing/topup/stripe", apiKey, { amountUSD: 15 });
  const topupReference = stripe.sessions.at(-1)!.topupReference;
  const r = await webhook("evt_exp_1", "checkout.session.expired", { metadata: { rafidTopupReference: topupReference } });
  assert.equal(r.status, 200);
  assert.equal((await get("/api/v1/billing/balance", apiKey)).body.data.availableUSD, 0);
});

test("Stripe payment_intent.payment_failed: marks the payment failed, correlated via the metadata Checkout mirrors onto the PaymentIntent", async t => {
  const stripe = new FakeStripeClient();
  const { newAccount, post, webhook, get } = await start(t, {}, { stripeClient: stripe });
  const { apiKey } = await newAccount();
  await post("/api/v1/billing/topup/stripe", apiKey, { amountUSD: 10 });
  const topupReference = stripe.sessions.at(-1)!.topupReference;
  const r = await webhook("evt_fail_1", "payment_intent.payment_failed", { metadata: { rafidTopupReference: topupReference }, last_payment_error: { message: "Your card was declined." } });
  assert.equal(r.status, 200);
  assert.equal((await get("/api/v1/billing/balance", apiKey)).body.data.availableUSD, 0);
});

test("Stripe refund: reverses the ledger when the full amount is still available; flags requires_review (no ledger write, balance untouched) when some was already spent", async t => {
  const stripe = new FakeStripeClient();
  const { newAccount, post, webhook, get, call, admin } = await start(t, {}, { stripeClient: stripe });

  // Case A: nothing spent yet -> clean reversal.
  const acctA = await newAccount();
  await post("/api/v1/billing/topup/stripe", acctA.apiKey, { amountUSD: 20 });
  const refA = stripe.sessions.at(-1)!.topupReference;
  await webhook("evt_a_completed", "checkout.session.completed", { metadata: { rafidTopupReference: refA }, payment_status: "paid", currency: "usd", amount_total: 2000, payment_intent: "pi_a" });
  assert.equal((await get("/api/v1/billing/balance", acctA.apiKey)).body.data.availableUSD, 20);
  const refundA = await webhook("evt_a_refund", "charge.refunded", { payment_intent: "pi_a", amount_refunded: 2000 });
  assert.equal(refundA.status, 200);
  assert.equal((await get("/api/v1/billing/balance", acctA.apiKey)).body.data.availableUSD, 0);
  const paymentsA = (await admin("GET", `/external-payments?accountId=${acctA.accountId}`)).body.data as any[];
  assert.equal(paymentsA.find(p => p.metadata.stripePaymentIntentId === "pi_a")?.status, "refunded");

  // Case B: some already spent -> requires_review, balance never silently altered.
  const acctB = await newAccount();
  await post("/api/v1/billing/topup/stripe", acctB.apiKey, { amountUSD: 20 });
  const refB = stripe.sessions.at(-1)!.topupReference;
  await webhook("evt_b_completed", "checkout.session.completed", { metadata: { rafidTopupReference: refB }, payment_status: "paid", currency: "usd", amount_total: 2000, payment_intent: "pi_b" });
  const spend = await call(research, acctB.apiKey);
  assert.equal(spend.status, 200);
  assert.equal((await get("/api/v1/billing/balance", acctB.apiKey)).body.data.availableUSD, 19.85);
  const refundB = await webhook("evt_b_refund", "charge.refunded", { payment_intent: "pi_b", amount_refunded: 2000 });
  assert.equal(refundB.status, 200);
  assert.equal((await get("/api/v1/billing/balance", acctB.apiKey)).body.data.availableUSD, 19.85, "balance must never go negative or be silently altered");
  const paymentsB = (await admin("GET", `/external-payments?accountId=${acctB.accountId}`)).body.data as any[];
  assert.equal(paymentsB.find(p => p.metadata.stripePaymentIntentId === "pi_b")?.status, "requires_review");
});

// -------------------------------------------------------------------------------------------
// USDC-on-Base top-ups
// -------------------------------------------------------------------------------------------

test("USDC top-up: creates an intent with a unique tagged exact amount; rejects out-of-bounds/missing amounts", async t => {
  const { rpcCall } = makeRpcCall();
  const { newAccount, post } = await start(t, {}, { usdcRpcCall: rpcCall });
  const { apiKey } = await newAccount();

  const a = await post("/api/v1/billing/topup/usdc", apiKey, { amountUSD: 10 });
  assert.equal(a.status, 201);
  assert.equal(a.body.data.network, "Base");
  assert.equal(a.body.data.chainId, 8453);
  assert.equal(a.body.data.asset, "USDC");
  assert.equal(a.body.data.recipient, RECEIVING_ADDRESS);
  const amountUSDC = Number(a.body.data.amountUSDC);
  assert.ok(amountUSDC > 10 && amountUSDC < 10.01, `expected the requested amount plus a small sub-cent tag, got ${amountUSDC}`);

  const b = await post("/api/v1/billing/topup/usdc", apiKey, { amountUSD: 10 });
  assert.notEqual(a.body.data.amountUSDC, b.body.data.amountUSDC, "two concurrently open intents for the same requested amount must get distinct exact amounts");

  assert.equal((await post("/api/v1/billing/topup/usdc", apiKey, { amountUSD: 0.5 })).status, 400);
  assert.equal((await post("/api/v1/billing/topup/usdc", apiKey, {})).status, 400);
});

test("USDC: unconfigured rail answers 503", async t => {
  const { newAccount, post } = await start(t, { BASE_RPC_URL: "", BASE_USDC_CONTRACT: "", TOPUP_RECEIVING_ADDRESS: "" });
  const { apiKey } = await newAccount();
  assert.equal((await post("/api/v1/billing/topup/usdc", apiKey, { amountUSD: 10 })).status, 503);
});

test("USDC confirm: a top-up intent can only be confirmed by the account that created it", async t => {
  const { rpcCall } = makeRpcCall();
  const { newAccount, post } = await start(t, {}, { usdcRpcCall: rpcCall });
  const owner = await newAccount();
  const stranger = await newAccount();
  const intent = (await post("/api/v1/billing/topup/usdc", owner.apiKey, { amountUSD: 10 })).body.data;
  const r = await post(`/api/v1/billing/topup/usdc/${intent.topupId}/confirm`, stranger.apiKey, { transactionHash: "0x" + "2".repeat(64) });
  assert.equal(r.status, 404);
});

test("USDC confirm: independently re-derives everything from the chain — wrong recipient/amount/token never credits the account and leaves the intent open for a retry with the correct hash", async t => {
  const { rpcCall, receipts } = makeRpcCall({ currentBlock: 1010 });
  const { newAccount, post, get } = await start(t, {}, { usdcRpcCall: rpcCall });
  const { apiKey } = await newAccount();
  const intent = (await post("/api/v1/billing/topup/usdc", apiKey, { amountUSD: 10 })).body.data;
  const amountAtomic = usdToMicros(intent.amountUSDC);

  receipts.set(txHash("wrongrecipient"), transferReceipt({ contract: USDC_CONTRACT, to: "0x00000000000000000000000000000000000ff0", amountAtomic, blockNumber: 1000 }));
  assert.equal((await post(`/api/v1/billing/topup/usdc/${intent.topupId}/confirm`, apiKey, { transactionHash: txHash("wrongrecipient") })).body.data.status, "failed");

  receipts.set(txHash("wrongamount"), transferReceipt({ contract: USDC_CONTRACT, to: RECEIVING_ADDRESS, amountAtomic: amountAtomic - 1, blockNumber: 1000 }));
  assert.equal((await post(`/api/v1/billing/topup/usdc/${intent.topupId}/confirm`, apiKey, { transactionHash: txHash("wrongamount") })).body.data.status, "failed");

  receipts.set(txHash("wrongtoken"), transferReceipt({ contract: "0x000000000000000000000000000000000000fe", to: RECEIVING_ADDRESS, amountAtomic, blockNumber: 1000 }));
  assert.equal((await post(`/api/v1/billing/topup/usdc/${intent.topupId}/confirm`, apiKey, { transactionHash: txHash("wrongtoken") })).body.data.status, "failed");

  assert.equal((await get("/api/v1/billing/balance", apiKey)).body.data.availableUSD, 0, "none of the rejected attempts above may have credited anything");

  // A retry with the correct hash still succeeds — none of the mismatches above permanently failed the intent.
  receipts.set(txHash("correct"), transferReceipt({ contract: USDC_CONTRACT, to: RECEIVING_ADDRESS, amountAtomic, blockNumber: 1000 }));
  const confirmed = await post(`/api/v1/billing/topup/usdc/${intent.topupId}/confirm`, apiKey, { transactionHash: txHash("correct") });
  assert.equal(confirmed.body.data.status, "confirmed");
  // The credited amount is the intent's EXACT tagged amount (requested $10 plus a unique sub-cent
  // tag — see usdcTopup.ts's correlation-strategy doc comment), never a rounded $10.00.
  assert.equal((await get("/api/v1/billing/balance", apiKey)).body.data.availableUSD, Number(intent.amountUSDC));
});

test("USDC confirm: a reverted on-chain transaction permanently fails the top-up intent", async t => {
  const { rpcCall, receipts } = makeRpcCall({ currentBlock: 1010 });
  const { newAccount, post } = await start(t, {}, { usdcRpcCall: rpcCall });
  const { apiKey } = await newAccount();
  const intent = (await post("/api/v1/billing/topup/usdc", apiKey, { amountUSD: 10 })).body.data;
  const amountAtomic = usdToMicros(intent.amountUSDC);
  receipts.set(txHash("reverted"), transferReceipt({ status: "0x0", contract: USDC_CONTRACT, to: RECEIVING_ADDRESS, amountAtomic, blockNumber: 1000 }));
  const first = await post(`/api/v1/billing/topup/usdc/${intent.topupId}/confirm`, apiKey, { transactionHash: txHash("reverted") });
  assert.equal(first.body.data.status, "failed");

  receipts.set(txHash("correct-too-late"), transferReceipt({ contract: USDC_CONTRACT, to: RECEIVING_ADDRESS, amountAtomic, blockNumber: 1000 }));
  const second = await post(`/api/v1/billing/topup/usdc/${intent.topupId}/confirm`, apiKey, { transactionHash: txHash("correct-too-late") });
  assert.equal(second.body.data.status, "failed", "an intent whose transaction reverted stays permanently failed, even against a different, otherwise-valid hash");
});

test("USDC confirm: an RPC endpoint on the wrong chain is rejected before any receipt is trusted", async t => {
  const { rpcCall } = makeRpcCall({ chainIdHex: "0x1" }); // Ethereum mainnet, not Base
  const { newAccount, post } = await start(t, {}, { usdcRpcCall: rpcCall });
  const { apiKey } = await newAccount();
  const intent = (await post("/api/v1/billing/topup/usdc", apiKey, { amountUSD: 10 })).body.data;
  const r = await post(`/api/v1/billing/topup/usdc/${intent.topupId}/confirm`, apiKey, { transactionHash: "0x" + "1".repeat(64) });
  assert.equal(r.body.data.status, "failed");
});

test("USDC confirm: a transfer with too few confirmations stays pending, never credited early", async t => {
  const { rpcCall, receipts } = makeRpcCall({ currentBlock: 1001 }); // receipt at block 1000 -> 2 confirmations, TOPUP_CONFIRMATIONS=3
  const { newAccount, post, get } = await start(t, {}, { usdcRpcCall: rpcCall });
  const { apiKey } = await newAccount();
  const intent = (await post("/api/v1/billing/topup/usdc", apiKey, { amountUSD: 10 })).body.data;
  const amountAtomic = usdToMicros(intent.amountUSDC);
  receipts.set(txHash("pending"), transferReceipt({ contract: USDC_CONTRACT, to: RECEIVING_ADDRESS, amountAtomic, blockNumber: 1000 }));
  const pending = await post(`/api/v1/billing/topup/usdc/${intent.topupId}/confirm`, apiKey, { transactionHash: txHash("pending") });
  assert.equal(pending.body.data.status, "pending");
  assert.equal((await get("/api/v1/billing/balance", apiKey)).body.data.availableUSD, 0);
});

test("USDC confirm: a verified, sufficiently-confirmed transfer funds the account exactly once; a transaction hash can never fund a second top-up", async t => {
  const { rpcCall, receipts } = makeRpcCall({ currentBlock: 1010 });
  const { newAccount, post, get, admin } = await start(t, {}, { usdcRpcCall: rpcCall });
  const { accountId, apiKey } = await newAccount();
  const intent = (await post("/api/v1/billing/topup/usdc", apiKey, { amountUSD: 10 })).body.data;
  const amountAtomic = usdToMicros(intent.amountUSDC);
  receipts.set(txHash("good"), transferReceipt({ contract: USDC_CONTRACT, to: RECEIVING_ADDRESS, amountAtomic, blockNumber: 1000 }));

  const confirmed = await post(`/api/v1/billing/topup/usdc/${intent.topupId}/confirm`, apiKey, { transactionHash: txHash("good") });
  assert.equal(confirmed.body.data.status, "confirmed");
  const expectedUsd = Number(intent.amountUSDC); // requested $10 plus a unique sub-cent tag
  assert.equal(confirmed.body.data.balanceUSD, expectedUsd.toFixed(2));
  assert.equal((await get("/api/v1/billing/balance", apiKey)).body.data.availableUSD, expectedUsd);

  const ledger = (await admin("GET", `/accounts/${accountId}/ledger`)).body.data.transactions;
  assert.equal(ledger.filter((e: any) => e.type === "credit_purchase").length, 1);

  // Re-confirming the same intent is idempotent.
  const again = await post(`/api/v1/billing/topup/usdc/${intent.topupId}/confirm`, apiKey, { transactionHash: txHash("good") });
  assert.equal(again.body.data.status, "confirmed");
  assert.equal((await get("/api/v1/billing/balance", apiKey)).body.data.availableUSD, expectedUsd);

  // A second, different intent trying to reuse the same on-chain transaction hash must never double-credit.
  const intent2 = (await post("/api/v1/billing/topup/usdc", apiKey, { amountUSD: 10 })).body.data;
  const clash = await post(`/api/v1/billing/topup/usdc/${intent2.topupId}/confirm`, apiKey, { transactionHash: txHash("good") });
  assert.equal(clash.body.data.status, "failed");
  assert.equal((await get("/api/v1/billing/balance", apiKey)).body.data.availableUSD, expectedUsd, "the clashing second intent must not add a second credit");
});

test("USDC confirm: concurrent confirmation attempts for the same transaction are idempotent — exactly one credit is ever applied", async t => {
  const { rpcCall, receipts } = makeRpcCall({ currentBlock: 1010 });
  const { newAccount, post, get } = await start(t, {}, { usdcRpcCall: rpcCall });
  const { apiKey } = await newAccount();
  const intent = (await post("/api/v1/billing/topup/usdc", apiKey, { amountUSD: 10 })).body.data;
  const amountAtomic = usdToMicros(intent.amountUSDC);
  receipts.set(txHash("race"), transferReceipt({ contract: USDC_CONTRACT, to: RECEIVING_ADDRESS, amountAtomic, blockNumber: 1000 }));
  const [r1, r2] = await Promise.all([
    post(`/api/v1/billing/topup/usdc/${intent.topupId}/confirm`, apiKey, { transactionHash: txHash("race") }),
    post(`/api/v1/billing/topup/usdc/${intent.topupId}/confirm`, apiKey, { transactionHash: txHash("race") })
  ]);
  assert.equal(r1.body.data.status, "confirmed");
  assert.equal(r2.body.data.status, "confirmed");
  assert.equal((await get("/api/v1/billing/balance", apiKey)).body.data.availableUSD, Number(intent.amountUSDC), "a race between two confirm calls must never double-credit");
});

test("USDC top-up expiry: a late but genuinely valid transfer is flagged for manual review, never auto-credited", async t => {
  const clock = { now: new Date("2026-01-01T00:00:00.000Z") };
  const { rpcCall, receipts } = makeRpcCall({ currentBlock: 1010 });
  const { newAccount, post, admin, get } = await start(t, { TOPUP_EXPIRY_MINUTES: "5" }, { usdcRpcCall: rpcCall, externalPaymentsNow: () => clock.now });
  const { apiKey } = await newAccount();
  const intent = (await post("/api/v1/billing/topup/usdc", apiKey, { amountUSD: 10 })).body.data;
  const amountAtomic = usdToMicros(intent.amountUSDC);

  clock.now = new Date(clock.now.getTime() + 6 * 60_000); // past the 5-minute expiry
  assert.equal((await admin("POST", "/maintenance/expire-stale-topups")).body.data.expired, 1);

  receipts.set(txHash("late"), transferReceipt({ contract: USDC_CONTRACT, to: RECEIVING_ADDRESS, amountAtomic, blockNumber: 1000 }));
  const late = await post(`/api/v1/billing/topup/usdc/${intent.topupId}/confirm`, apiKey, { transactionHash: txHash("late") });
  assert.equal(late.body.data.status, "expired");
  assert.match(late.body.data.detail, /manual review/i);
  assert.equal((await get("/api/v1/billing/balance", apiKey)).body.data.availableUSD, 0, "a late payment against an expired intent must never be auto-credited");

  const payments = (await admin("GET", "/external-payments")).body.data as any[];
  const reviewRow = payments.find(p => p.transactionHash === txHash("late"));
  assert.equal(reviewRow?.status, "requires_review");
});

test("USDC top-up expiry: an intent that expires with nothing submitted is simply reported expired", async t => {
  const clock = { now: new Date("2026-01-01T00:00:00.000Z") };
  const { rpcCall } = makeRpcCall();
  const { newAccount, post, admin } = await start(t, { TOPUP_EXPIRY_MINUTES: "5" }, { usdcRpcCall: rpcCall, externalPaymentsNow: () => clock.now });
  const { apiKey } = await newAccount();
  const intent = (await post("/api/v1/billing/topup/usdc", apiKey, { amountUSD: 10 })).body.data;
  clock.now = new Date(clock.now.getTime() + 6 * 60_000);
  await admin("POST", "/maintenance/expire-stale-topups");
  const r = await post(`/api/v1/billing/topup/usdc/${intent.topupId}/confirm`, apiKey, {});
  assert.equal(r.body.data.status, "expired");
});

// -------------------------------------------------------------------------------------------
// GET balance + discovery
// -------------------------------------------------------------------------------------------

test("GET /api/v1/billing/balance: reflects the same account state as the rest of unified billing; requires a valid API key", async t => {
  const { newAccount, get, admin } = await start(t);
  const { accountId, apiKey } = await newAccount();
  await admin("POST", `/accounts/${accountId}/credits`, { amount: "5.00", reason: "test grant" });
  const bal = await get("/api/v1/billing/balance", apiKey);
  assert.equal(bal.status, 200);
  assert.deepEqual(bal.body.data, { currency: "USD", balanceUSD: 5, reservedUSD: 0, availableUSD: 5 });
  assert.equal((await get("/api/v1/billing/balance")).status, 401);
});

test("GET /api/v1/payment-methods: api_credits lists exactly the enabled funding rails and their top-up endpoints", async t => {
  const stripe = new FakeStripeClient();
  const { rpcCall } = makeRpcCall();
  const { base } = await start(t, {}, { stripeClient: stripe, usdcRpcCall: rpcCall });
  const body = await (await fetch(base + "/api/v1/payment-methods")).json() as any;
  const apiCredits = body.data.methods.find((m: any) => m.id === "api_credits");
  assert.ok(apiCredits);
  assert.deepEqual(new Set(apiCredits.fundingMethods), new Set(["stripe", "usdc_base"]));
  assert.deepEqual(apiCredits.topup, { stripe: "POST /api/v1/billing/topup/stripe", usdc_base: "POST /api/v1/billing/topup/usdc" });
});

test("GET /api/v1/payment-methods: an unconfigured rail is never listed as a funding method", async t => {
  const { base } = await start(t, { STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "" });
  const body = await (await fetch(base + "/api/v1/payment-methods")).json() as any;
  const apiCredits = body.data.methods.find((m: any) => m.id === "api_credits");
  assert.deepEqual(apiCredits.fundingMethods, ["usdc_base"]);
});

// -------------------------------------------------------------------------------------------
// Full end-to-end flow (spec section 20)
// -------------------------------------------------------------------------------------------

test("End-to-end (spec section 20): a $10 top-up funds the account, then a $0.15 capability call debits it to $9.85 — funding and consumption are never conflated", async t => {
  const stripe = new FakeStripeClient();
  const { newAccount, post, webhook, get, call, admin } = await start(t, {}, { stripeClient: stripe });
  const { accountId, apiKey } = await newAccount();

  assert.equal((await get("/api/v1/billing/balance", apiKey)).body.data.availableUSD, 0);
  await post("/api/v1/billing/topup/stripe", apiKey, { amountUSD: 10 });
  const ref = stripe.sessions.at(-1)!.topupReference;
  await webhook("evt_e2e", "checkout.session.completed", { metadata: { rafidTopupReference: ref }, payment_status: "paid", currency: "usd", amount_total: 1000, payment_intent: "pi_e2e" });
  assert.equal((await get("/api/v1/billing/balance", apiKey)).body.data.availableUSD, 10);

  const res = await call(research, apiKey);
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.equal(body.meta.billing.remainingBalance, "9.85");
  assert.equal((await get("/api/v1/billing/balance", apiKey)).body.data.availableUSD, 9.85);

  const ledger = (await admin("GET", `/accounts/${accountId}/ledger`)).body.data.transactions;
  assert.equal(ledger.filter((e: any) => e.type === "credit_purchase").length, 1, "funding recorded once");
  assert.equal(ledger.filter((e: any) => e.type === "debit").length, 1, "consumption recorded separately, never summed with funding");
});

test("Existing prepaid billing is unaffected by the external payments layer being enabled alongside it", async t => {
  const { newAccount, admin, call, get } = await start(t, {}, { stripeClient: new FakeStripeClient() });
  const { accountId, apiKey } = await newAccount();
  await admin("POST", `/accounts/${accountId}/credits`, { amount: "5.00", reason: "manual grant" });
  const res = await call(research, apiKey);
  assert.equal(res.status, 200);
  const body = await res.json() as any;
  assert.equal(body.meta.billing.remainingBalance, "4.85");
  assert.equal((await get("/api/v1/billing/balance", apiKey)).body.data.availableUSD, 4.85);
});

// -------------------------------------------------------------------------------------------
// Admin visibility + reconciliation + rate limiting
// -------------------------------------------------------------------------------------------

test("Admin: GET stripe-balance reports Stripe's own balance; null when Stripe is unconfigured; unauthorized requests are rejected", async t => {
  const stripe = new FakeStripeClient();
  const { admin } = await start(t, {}, { stripeClient: stripe });
  const r = await admin("GET", "/stripe-balance");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data, { availableUsd: 4321.55, pendingUsd: 12.34 });
  assert.equal((await admin("GET", "/external-payments", undefined, "wrong-admin-secret")).status, 401);
});

test("Admin: GET stripe-balance is null (not an error) when Stripe is unconfigured", async t => {
  const { admin } = await start(t, { STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "" });
  const r = await admin("GET", "/stripe-balance");
  assert.equal(r.status, 200);
  assert.equal(r.body.data, null);
});

test("Admin: GET reconciliation cross-checks external payments against the ledger over HTTP — a clean funding flow produces zero anomalies", async t => {
  const stripe = new FakeStripeClient();
  const { newAccount, post, webhook, admin } = await start(t, {}, { stripeClient: stripe });
  const { apiKey } = await newAccount();
  await post("/api/v1/billing/topup/stripe", apiKey, { amountUSD: 10 });
  const ref = stripe.sessions.at(-1)!.topupReference;
  await webhook("evt_recon", "checkout.session.completed", { metadata: { rafidTopupReference: ref }, payment_status: "paid", currency: "usd", amount_total: 1000, payment_intent: "pi_recon" });
  const r = await admin("GET", "/reconciliation");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.data.anomalies, []);
  assert.equal(r.body.data.paymentsChecked, 1);
  assert.equal(r.body.data.creditPurchasesChecked, 1);
});

test("Rate limiting: Stripe checkout creation and USDC top-up creation are each independently rate-limited", async t => {
  const stripe = new FakeStripeClient();
  const { rpcCall } = makeRpcCall();
  const { newAccount, post } = await start(t, { RATE_LIMIT_ENABLED: "true", RATE_LIMIT_MAX: "2", RATE_LIMIT_WINDOW_MS: "60000" }, { stripeClient: stripe, usdcRpcCall: rpcCall });
  const { apiKey } = await newAccount();

  const stripeResults: number[] = [];
  for (let i = 0; i < 4; i++) stripeResults.push((await post("/api/v1/billing/topup/stripe", apiKey, { amountUSD: 5 })).status);
  assert.ok(stripeResults.includes(429), `expected a 429 after exceeding the Stripe checkout limit, got: ${stripeResults.join(",")}`);

  const usdcResults: number[] = [];
  for (let i = 0; i < 4; i++) usdcResults.push((await post("/api/v1/billing/topup/usdc", apiKey, { amountUSD: 5 })).status);
  assert.ok(usdcResults.includes(429), `expected a 429 after exceeding the USDC top-up limit, got: ${usdcResults.join(",")}`);
});

// -------------------------------------------------------------------------------------------
// Reconciliation (pure function) — every documented anomaly kind
// -------------------------------------------------------------------------------------------

function payment(overrides: Partial<ExternalPayment> = {}): ExternalPayment {
  const now = new Date().toISOString();
  return {
    id: "extpay_1", accountId: "acct_1", provider: "stripe", providerPaymentId: "cs_1", providerEventId: "evt_1",
    topupId: null, amountAtomic: 10_000_000, currency: "USD", network: null, asset: null, transactionHash: null,
    status: "confirmed", confirmedAt: now, createdAt: now, updatedAt: now, metadata: {}, ...overrides
  };
}

function creditEntry(overrides: Partial<LedgerEntry> = {}): LedgerEntry {
  const now = new Date().toISOString();
  return {
    id: "txn_1", accountId: "acct_1", apiKeyId: null, requestId: null, toolName: null, type: "credit_purchase",
    amountMicros: 10_000_000, currency: "USD", rail: "admin", status: "settled", externalTransactionId: "extpay_1",
    relatedEntryId: null, createdAt: now, updatedAt: now, metadata: {}, ...overrides
  };
}

test("Reconciliation: a matched, correctly-amounted confirmed payment + credit_purchase pair produces zero anomalies", () => {
  const clean = buildExternalPaymentsReconciliation({
    payments: [payment({ id: "extpay_ok", accountId: "acct_ok" })],
    creditPurchases: [creditEntry({ id: "txn_ok", accountId: "acct_ok", externalTransactionId: "extpay_ok" })],
    expectedUsdcNetwork: "eip155:8453", expectedUsdcAsset: "USDC"
  });
  assert.deepEqual(clean, []);
});

test("Reconciliation: detects every documented anomaly kind", () => {
  const base = { expectedUsdcNetwork: "eip155:8453", expectedUsdcAsset: "USDC" };

  const a1 = buildExternalPaymentsReconciliation({ payments: [payment({ id: "extpay_orphan" })], creditPurchases: [], ...base });
  assert.ok(a1.some(a => a.kind === "confirmed_payment_without_credit" && a.externalPaymentId === "extpay_orphan"));

  const a2 = buildExternalPaymentsReconciliation({ payments: [], creditPurchases: [creditEntry({ id: "txn_orphan", externalTransactionId: "extpay_missing" })], ...base });
  assert.ok(a2.some(a => a.kind === "credit_without_confirmed_payment"));

  const a3 = buildExternalPaymentsReconciliation({ payments: [payment({ id: "extpay_d1", providerEventId: "evt_dup" }), payment({ id: "extpay_d2", providerEventId: "evt_dup" })], creditPurchases: [], ...base });
  assert.ok(a3.some(a => a.kind === "duplicate_provider_event"));

  const a4 = buildExternalPaymentsReconciliation({
    payments: [
      payment({ id: "extpay_t1", provider: "usdc_base", providerEventId: null, transactionHash: "0xdup", network: "eip155:8453", asset: "USDC" }),
      payment({ id: "extpay_t2", provider: "usdc_base", providerEventId: null, transactionHash: "0xdup", network: "eip155:8453", asset: "USDC" })
    ], creditPurchases: [], ...base
  });
  assert.ok(a4.some(a => a.kind === "duplicate_transaction_hash"));

  const a5 = buildExternalPaymentsReconciliation({ payments: [payment({ id: "extpay_amt", amountAtomic: 10_000_000 })], creditPurchases: [creditEntry({ externalTransactionId: "extpay_amt", amountMicros: 9_000_000 })], ...base });
  assert.ok(a5.some(a => a.kind === "amount_mismatch"));

  const a6 = buildExternalPaymentsReconciliation({ payments: [payment({ id: "extpay_cur", status: "requires_review", metadata: { currency: "eur" } })], creditPurchases: [], ...base });
  assert.ok(a6.some(a => a.kind === "currency_mismatch"));

  const a7 = buildExternalPaymentsReconciliation({ payments: [payment({ id: "extpay_net", provider: "usdc_base", network: "eip155:1", asset: "USDC" })], creditPurchases: [], ...base });
  assert.ok(a7.some(a => a.kind === "wrong_network"));

  const a8 = buildExternalPaymentsReconciliation({ payments: [payment({ id: "extpay_tok", provider: "usdc_base", network: "eip155:8453", asset: "USDT" })], creditPurchases: [], ...base });
  assert.ok(a8.some(a => a.kind === "wrong_token"));
});

// -------------------------------------------------------------------------------------------
// Dashboard: Collection & Funding
// -------------------------------------------------------------------------------------------

const dashboardAdminUsername = "ops-admin";
const dashboardAdminPassword = "correct-horse-battery-staple-not-real";
const dashboardAdminSessionSecret = "test-only-dashboard-session-secret-0123456789";

async function loginAndGetSessionCookie(base: string): Promise<string> {
  const response = await fetch(base + "/internal/dashboard/login", {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: dashboardAdminUsername, password: dashboardAdminPassword }).toString()
  });
  assert.equal(response.status, 302);
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "expected a Set-Cookie header on successful dashboard login");
  return setCookie!.split(";")[0]!;
}

test("Dashboard Collection & Funding: reports Stripe collected, USDC confirmed, and outstanding balance without ever summing them into revenue", async t => {
  const stripe = new FakeStripeClient();
  const { rpcCall, receipts } = makeRpcCall({ currentBlock: 1010 });
  const { base, newAccount, post, webhook, call } = await start(t, {
    ADMIN_USERNAME: dashboardAdminUsername, ADMIN_PASSWORD_HASH: hashAdminPassword(dashboardAdminPassword), ADMIN_SESSION_SECRET: dashboardAdminSessionSecret
  }, { stripeClient: stripe, usdcRpcCall: rpcCall });

  const { apiKey } = await newAccount();
  await post("/api/v1/billing/topup/stripe", apiKey, { amountUSD: 10 });
  const ref = stripe.sessions.at(-1)!.topupReference;
  await webhook("evt_dash_1", "checkout.session.completed", { metadata: { rafidTopupReference: ref }, payment_status: "paid", currency: "usd", amount_total: 1000, payment_intent: "pi_dash" });

  const intent = (await post("/api/v1/billing/topup/usdc", apiKey, { amountUSD: 5 })).body.data;
  const amountAtomic = usdToMicros(intent.amountUSDC);
  const expectedUsdcUsd = Number(intent.amountUSDC); // requested $5 plus a unique sub-cent tag
  const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
  receipts.set(txHash("dashusdc"), transferReceipt({ contract: USDC_CONTRACT, to: RECEIVING_ADDRESS, amountAtomic, blockNumber: 1000 }));
  await post(`/api/v1/billing/topup/usdc/${intent.topupId}/confirm`, apiKey, { transactionHash: txHash("dashusdc") });

  await call(research, apiKey); // spends $0.15 of prepaid credit — consumption, never funding

  const cookie = await loginAndGetSessionCookie(base);
  const data = await (await fetch(base + "/internal/dashboard/data", { headers: { Cookie: cookie } })).json() as any;

  assert.equal(data.data.collectionFunding.stripeCollectedUsd, 10);
  assert.equal(data.data.collectionFunding.usdcTopupsConfirmedUsd, expectedUsdcUsd);
  assert.equal(data.data.collectionFunding.prepaidOutstandingBalanceUsd, round6(10 + expectedUsdcUsd - 0.15));

  assert.equal(data.data.revenueOverview.externalFundingCollectedUsd, round6(10 + expectedUsdcUsd));
  assert.equal(data.data.revenueOverview.outstandingPrepaidBalanceUsd, round6(10 + expectedUsdcUsd - 0.15));

  const stripeRow = data.data.externalPaymentsTable.find((r: any) => r.provider === "stripe");
  assert.ok(stripeRow);
  assert.equal(stripeRow.status, "confirmed");
  const usdcRow = data.data.externalPaymentsTable.find((r: any) => r.provider === "usdc_base");
  assert.ok(usdcRow);
  assert.equal(usdcRow.status, "confirmed");
});
