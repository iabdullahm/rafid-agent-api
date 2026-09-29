import assert from "node:assert/strict";
import { after, test } from "node:test";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { createApp } from "../src/api/app.js";
import { loadConfig } from "../src/config/env.js";
import { PostgresBillingStore } from "../src/billing/unified/index.js";
import { PostgresExternalPaymentStore } from "../src/billing/external/postgresStore.js";
import type { StripeClient, StripeWebhookEvent } from "../src/billing/external/stripeClient.js";
import type { JsonRpcCall } from "../src/billing/external/usdcTopup.js";

/**
 * Runs the external payment-collection layer against a REAL PostgreSQL — proving the unique
 * indexes (rafid_external_payments_provider_event_uniq / _tx_hash_uniq / rafid_topup_intents_
 * open_amount_uniq — see schema.ts) actually hold under genuine multi-connection concurrency, the
 * same way tests/billing-postgres.test.ts proves the unified billing ledger's row-lock design.
 * Opt-in, mirroring that file's pattern exactly:
 *   TEST_DATABASE_URL=postgres://… npm test     (a dedicated test database — never production)
 *
 * Still no real network egress: Stripe and the Base RPC endpoint are the same injectable fakes
 * tests/external-payments.test.ts uses — only the DATA layer here is real.
 */

const url = process.env.TEST_DATABASE_URL;
const usdcContract = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const receivingAddress = "0x1111111111111111111111111111111111abcd";
const ERC20_TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const topicFor = (address: string): string => "0x" + address.toLowerCase().replace(/^0x/, "").padStart(64, "0");
/** A fresh, well-formed 0x + 64-hex-char transaction hash every call — this file runs against a
 *  real, persistent Postgres database (never reset between runs), so every business key a test
 *  relies on being unique (transaction hashes, provider event ids, tagged amounts) is randomized
 *  per run rather than a fixed literal, so reruns never collide with a previous run's rows. */
const randomTxHash = (): string => "0x" + randomBytes(32).toString("hex");

let billingStore: PostgresBillingStore | undefined;
let externalStore: PostgresExternalPaymentStore | undefined;
const stores = async () => {
  if (!billingStore) { billingStore = new PostgresBillingStore(url!, { poolMax: 20 }); await billingStore.migrate(); }
  if (!externalStore) { externalStore = new PostgresExternalPaymentStore(url!, { poolMax: 20 }); await externalStore.migrate(); }
  return { billingStore, externalStore };
};
after(async () => { await billingStore?.close(); await externalStore?.close(); });

class FakeStripeClient implements StripeClient {
  sessions: Array<{ id: string; url: string; topupReference: string }> = [];
  private n = 0;
  async createCheckoutSession(input: { amountUsd: number; accountId: string; topupReference: string; successUrl: string; cancelUrl: string }) {
    this.n++;
    const id = `cs_test_${this.n}`;
    this.sessions.push({ id, url: `https://checkout.stripe.test/${id}`, topupReference: input.topupReference });
    return { id, url: `https://checkout.stripe.test/${id}` };
  }
  constructWebhookEvent(payload: Buffer, signature: string): StripeWebhookEvent {
    if (signature !== "valid-test-signature") throw new Error("bad signature");
    return JSON.parse(payload.toString("utf8"));
  }
  async retrieveBalance() { return { availableUsd: 0, pendingUsd: 0 }; }
}

function transferReceipt(opts: { contract: string; to: string; amountAtomic: number; blockNumber: number }) {
  return {
    status: "0x1", blockNumber: "0x" + opts.blockNumber.toString(16),
    logs: [{ address: opts.contract, topics: [ERC20_TRANSFER_TOPIC, topicFor("0x0000000000000000000000000000000000dead"), topicFor(opts.to)], data: "0x" + BigInt(opts.amountAtomic).toString(16).padStart(64, "0") }]
  };
}

function makeRpcCall(currentBlock = 1010) {
  const receipts = new Map<string, unknown>();
  const rpcCall: JsonRpcCall = (async (method: string, params: unknown[]) => {
    if (method === "eth_chainId") return "0x2105";
    if (method === "eth_blockNumber") return "0x" + currentBlock.toString(16);
    if (method === "eth_getTransactionReceipt") { const hash = (params as string[])[0]!; return receipts.has(hash) ? receipts.get(hash) : null; }
    throw new Error(`unexpected RPC method ${method}`);
  }) as JsonRpcCall;
  return { rpcCall, receipts };
}

test("PostgresExternalPaymentStore: migrations are idempotent; unique indexes reject a duplicate provider event, a duplicate transaction hash, and a colliding open tagged amount", { skip: !url }, async () => {
  const { billingStore: bs, externalStore: s } = await stores();
  await s.migrate(); await s.migrate();

  // rafid_external_payments / rafid_topup_intents both FK to billing_accounts(id) — real accounts
  // (via the same PostgresBillingStore this layer always funds through) are required first.
  const acct1 = await bs.createAccount({ name: "PG Constraint Co 1" });
  const acct2 = await bs.createAccount({ name: "PG Constraint Co 2" });

  const dupEventId = `evt_pg_dup_${randomUUID()}`;
  const p1 = await s.createExternalPayment({
    id: `extpay_pg_${randomUUID()}`, accountId: acct1.id, provider: "stripe", providerPaymentId: `cs_pg_${randomUUID()}`, providerEventId: dupEventId,
    topupId: null, amountAtomic: 1_000_000, currency: "USD", network: null, asset: null, transactionHash: null,
    status: "confirmed", confirmedAt: new Date().toISOString(), metadata: {}
  });
  assert.equal(p1.providerEventId, dupEventId);
  await assert.rejects(s.createExternalPayment({
    id: `extpay_pg_${randomUUID()}`, accountId: acct1.id, provider: "stripe", providerPaymentId: `cs_pg_${randomUUID()}`, providerEventId: dupEventId,
    topupId: null, amountAtomic: 1_000_000, currency: "USD", network: null, asset: null, transactionHash: null,
    status: "confirmed", confirmedAt: new Date().toISOString(), metadata: {}
  }), (e: any) => e.code === "duplicate_event", "the same Stripe webhook event id must never credit twice, even racing two connections");

  const dupHash = randomTxHash();
  const t1 = await s.createExternalPayment({
    id: `extpay_pg_${randomUUID()}`, accountId: acct1.id, provider: "usdc_base", providerPaymentId: dupHash, providerEventId: null,
    topupId: null, amountAtomic: 1_000_000, currency: "USD", network: "eip155:8453", asset: "USDC", transactionHash: dupHash,
    status: "confirmed", confirmedAt: new Date().toISOString(), metadata: {}
  });
  assert.equal(t1.transactionHash, dupHash);
  await assert.rejects(s.createExternalPayment({
    id: `extpay_pg_${randomUUID()}`, accountId: acct1.id, provider: "usdc_base", providerPaymentId: dupHash, providerEventId: null,
    topupId: null, amountAtomic: 1_000_000, currency: "USD", network: "eip155:8453", asset: "USDC", transactionHash: dupHash,
    status: "confirmed", confirmedAt: new Date().toISOString(), metadata: {}
  }), (e: any) => e.code === "duplicate_transaction_hash", "the same on-chain transaction hash must never fund two top-ups, even racing two connections");

  const expiresAt = new Date(Date.now() + 45 * 60_000).toISOString();
  const collidingAmount = 5_000_000 + Math.floor(Math.random() * 9_000) + 1;
  await s.createTopupIntent({
    id: `topup_pg_${randomUUID()}`, accountId: acct1.id, requestedAmountAtomic: 5_000_000, amountUsdcAtomic: collidingAmount,
    network: "eip155:8453", chainId: 8453, asset: "USDC", recipient: receivingAddress, status: "pending",
    transactionHash: null, externalPaymentId: null, expiresAt, metadata: {}
  });
  await assert.rejects(s.createTopupIntent({
    id: `topup_pg_${randomUUID()}`, accountId: acct2.id, requestedAmountAtomic: 5_000_000, amountUsdcAtomic: collidingAmount,
    network: "eip155:8453", chainId: 8453, asset: "USDC", recipient: receivingAddress, status: "pending",
    transactionHash: null, externalPaymentId: null, expiresAt, metadata: {}
  }), (e: any) => e.code === "amount_collision", "two concurrently-open intents for the same recipient must never claim the same exact tagged amount");
});

test("PostgresExternalPaymentStore over HTTP: Stripe checkout + USDC top-up each fund a real Postgres-backed account exactly once", { skip: !url, timeout: 60000 }, async t => {
  const { billingStore: bs, externalStore: es } = await stores();
  const stripe = new FakeStripeClient();
  const { rpcCall, receipts } = makeRpcCall();
  const config = loadConfig({
    RAFID_API_KEYS: "test-only-not-a-real-credential-12345", LOG_LEVEL: "silent", RATE_LIMIT_ENABLED: "false",
    API_CREDITS_ENABLED: "true", BILLING_ADMIN_SECRET: "billing-admin-secret-for-tests-only-0123456789",
    STRIPE_SECRET_KEY: "sk_test_not_a_real_key", STRIPE_WEBHOOK_SECRET: "whsec_not_a_real_secret",
    STRIPE_SUCCESS_URL: "https://example.test/success", STRIPE_CANCEL_URL: "https://example.test/cancel",
    BASE_RPC_URL: "https://fake-base-rpc.test", BASE_USDC_CONTRACT: usdcContract, TOPUP_RECEIVING_ADDRESS: receivingAddress, TOPUP_CONFIRMATIONS: "3"
  });
  const app = createApp(config, { logger: () => {}, billingStore: bs, externalPaymentStore: es, stripeClient: stripe, usdcRpcCall: rpcCall });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  const admin = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + "/api/internal/billing" + path, { method, headers: { "X-Billing-Admin-Key": "billing-admin-secret-for-tests-only-0123456789", "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };
  const acct = await admin("POST", "/accounts", { name: "PG HTTP Customer" });
  assert.equal(acct.status, 201);
  const accountId = acct.body.data.id as string;
  const k = await admin("POST", `/accounts/${accountId}/api-keys`, { name: "prod" });
  const apiKey = k.body.data.apiKey as string;
  const post = async (path: string, body: unknown) => {
    const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };
  const balance = async () => (await (await fetch(base + "/api/v1/billing/balance", { headers: { Authorization: `Bearer ${apiKey}` } })).json() as any).data.availableUSD;

  assert.equal(await balance(), 0);

  const checkout = await post("/api/v1/billing/topup/stripe", { amountUSD: 10 });
  assert.equal(checkout.status, 201);
  const ref = stripe.sessions.at(-1)!.topupReference;
  const webhookRes = await fetch(base + "/api/v1/billing/webhooks/stripe", {
    method: "POST", headers: { "Content-Type": "application/json", "stripe-signature": "valid-test-signature" },
    body: Buffer.from(JSON.stringify({ id: `evt_pg_http_${randomUUID()}`, type: "checkout.session.completed", data: { object: { metadata: { rafidTopupReference: ref }, payment_status: "paid", currency: "usd", amount_total: 1000, payment_intent: `pi_pg_http_${randomUUID()}` } } })) as unknown as BodyInit
  });
  assert.equal(webhookRes.status, 200);
  assert.equal(await balance(), 10);

  const intent = (await post("/api/v1/billing/topup/usdc", { amountUSD: 5 })).body.data;
  const amountAtomic = Math.round(Number(intent.amountUSDC) * 1_000_000);
  const hash = randomTxHash();
  receipts.set(hash, transferReceipt({ contract: usdcContract, to: receivingAddress, amountAtomic, blockNumber: 1000 }));
  const confirm = await post(`/api/v1/billing/topup/usdc/${intent.topupId}/confirm`, { transactionHash: hash });
  assert.equal(confirm.body.data.status, "confirmed");
  assert.equal(await balance(), Math.round((10 + Number(intent.amountUSDC)) * 1e6) / 1e6);

  const ledger = (await admin("GET", `/accounts/${accountId}/ledger`)).body.data.transactions;
  assert.equal(ledger.filter((e: any) => e.type === "credit_purchase").length, 2, "exactly two credit_purchase rows — Stripe once, USDC once — over a real connection pool");
});

test("PostgresExternalPaymentStore over HTTP: concurrent USDC confirm calls for the same transaction hash, across a real connection pool, credit exactly once", { skip: !url, timeout: 60000 }, async t => {
  const { billingStore: bs, externalStore: es } = await stores();
  const { rpcCall, receipts } = makeRpcCall();
  const config = loadConfig({
    RAFID_API_KEYS: "test-only-not-a-real-credential-12345", LOG_LEVEL: "silent", RATE_LIMIT_ENABLED: "false",
    API_CREDITS_ENABLED: "true", BILLING_ADMIN_SECRET: "billing-admin-secret-for-tests-only-0123456789",
    BASE_RPC_URL: "https://fake-base-rpc.test", BASE_USDC_CONTRACT: usdcContract, TOPUP_RECEIVING_ADDRESS: receivingAddress, TOPUP_CONFIRMATIONS: "3"
  });
  const app = createApp(config, { logger: () => {}, billingStore: bs, externalPaymentStore: es, usdcRpcCall: rpcCall });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  const admin = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + "/api/internal/billing" + path, { method, headers: { "X-Billing-Admin-Key": "billing-admin-secret-for-tests-only-0123456789", "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };
  const acct = await admin("POST", "/accounts", { name: "PG Race Customer" });
  const accountId = acct.body.data.id as string;
  const k = await admin("POST", `/accounts/${accountId}/api-keys`, { name: "prod" });
  const apiKey = k.body.data.apiKey as string;
  const post = async (path: string, body: unknown) => {
    const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };
  const balance = async () => (await (await fetch(base + "/api/v1/billing/balance", { headers: { Authorization: `Bearer ${apiKey}` } })).json() as any).data.availableUSD;

  const intent = (await post("/api/v1/billing/topup/usdc", { amountUSD: 8 })).body.data;
  const amountAtomic = Math.round(Number(intent.amountUSDC) * 1_000_000);
  const hash = randomTxHash();
  receipts.set(hash, transferReceipt({ contract: usdcContract, to: receivingAddress, amountAtomic, blockNumber: 1000 }));

  const results = await Promise.all(Array.from({ length: 5 }, () => post(`/api/v1/billing/topup/usdc/${intent.topupId}/confirm`, { transactionHash: hash })));
  assert.ok(results.every(r => r.body.data.status === "confirmed"), `expected every concurrent confirm to report "confirmed", got: ${JSON.stringify(results.map(r => r.body.data.status))}`);
  assert.equal(await balance(), Number(intent.amountUSDC), "5 concurrent confirms of the same transaction hash across real connections must credit exactly once");
});
