import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createHash, randomBytes } from "node:crypto";
import { Mppx as MppxClient, evm as evmClient } from "mppx/client";
import { Assets } from "mppx/evm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createApp } from "../src/api/app.js";
import { loadConfig } from "../src/config/env.js";
import { capabilities } from "../src/domain/capabilities.js";
import { deserializeMacaroon, decodeL402Identifier } from "../src/billing/l402/macaroon.js";
import type { LightningBackend } from "../src/billing/l402/lightning.js";
import { MemoryL402RedemptionStore } from "../src/billing/l402/redemptions.js";
import { MppxProvider, MemoryMppKv, toMppxStore } from "../src/billing/mpp/index.js";
import { MemoryBillingStore, BillingEngine } from "../src/billing/unified/index.js";
import { createHostedExecutor } from "../src/mcp/hosted.js";

/**
 * The account-backed rails must coexist with — never replace — the existing machine-payment
 * rails. These tests drive L402 and MPP end to end THROUGH the canonical /api/v1/<tool> route
 * (re-dispatched to their unchanged gates), prove a presented Rafid API key is never charged
 * when another rail is used, and exercise MCP stdio "hosted mode" with RAFID_API_KEY.
 */
const key = "test-only-not-a-real-credential-12345";
const billingEnv = { RAFID_API_KEYS: key, LOG_LEVEL: "silent", RATE_LIMIT_ENABLED: "false", API_CREDITS_ENABLED: "true", SUBSCRIPTIONS_ENABLED: "true" };
const tool = (name: string) => capabilities.find(c => c.name === name)!;
const analyzeProperty = tool("analyze_property");
const omanProperty = tool("analyze_oman_property");
const research = tool("research_company");

async function listen(t: { after(fn: () => void): void }, app: ReturnType<typeof createApp>) {
  const server = app.listen(0, "127.0.0.1");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}
async function fundedKey(store: MemoryBillingStore, amount: string) {
  const engine = new BillingEngine({ config: loadConfig(billingEnv).billing, store, priceUsd: () => 1 });
  const account = await engine.createAccount({ name: "Rail Test" });
  await engine.addCredit({ accountId: account.id, amount });
  const { apiKey } = await engine.createApiKey({ accountId: account.id });
  return { apiKey, balance: async () => (await engine.balanceView(account.id)).credits.available };
}
const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body)
});

class FakeLightning implements LightningBackend {
  readonly name = "fake";
  readonly preimages = new Map<string, Buffer>();
  async createInvoice(args: { amountSats: number; memo: string; expirySeconds: number }) {
    const preimage = randomBytes(32);
    const paymentHash = createHash("sha256").update(preimage).digest();
    this.preimages.set(paymentHash.toString("hex"), preimage);
    return { paymentRequest: `lnbc${args.amountSats}n1fake`, paymentHash };
  }
  pay(macaroonB64: string): string {
    const m = deserializeMacaroon(macaroonB64)!;
    return this.preimages.get(decodeL402Identifier(m.identifier)!.paymentHash.toString("hex"))!.toString("hex");
  }
}

test("L402 through the canonical route: X-Rafid-Payment-Method: l402 → genuine L402 challenge → pay → 200; the API key is never charged", async t => {
  const config = loadConfig({ ...billingEnv, L402_ENABLED: "true", LND_REST_URL: "https://lnd.example.test:8080", LND_INVOICE_MACAROON: "0201036c6e640258030a10".padEnd(60, "a"), L402_ROOT_KEY: "5c".repeat(32) });
  const lightning = new FakeLightning();
  const store = new MemoryBillingStore();
  const base = await listen(t, createApp(config, { logger: () => {}, billingStore: store, l402Backend: lightning, l402Rates: { getRate: async () => ({ btcUsd: 100_000, source: "coinbase", fetchedAt: new Date().toISOString() }) }, l402Redemptions: new MemoryL402RedemptionStore() }));
  const { apiKey, balance } = await fundedKey(store, "5.00");
  const path = "/api/v1" + analyzeProperty.path;
  // The dedicated L402 route and the canonical route answer the same protocol-correct challenge.
  const unpaid = await post(base, path, analyzeProperty.example, { "X-Rafid-Api-Key": apiKey, "X-Rafid-Payment-Method": "l402" });
  assert.equal(unpaid.status, 402);
  const header = unpaid.headers.get("www-authenticate") ?? "";
  const m = /^L402 macaroon="([^"]+)", invoice="([^"]+)"$/.exec(header);
  assert.ok(m, header);
  assert.equal((await post(base, "/api/v1/l402" + analyzeProperty.path, analyzeProperty.example)).status, 402);
  const preimage = lightning.pay(m[1]!);
  // auto + an L402 credential (no API key) → the L402 gate verifies and the tool runs once.
  const paid = await post(base, path, analyzeProperty.example, { Authorization: `L402 ${m[1]}:${preimage}` });
  assert.equal(paid.status, 200);
  const body = await paid.json() as any;
  assert.deepEqual(body.data, await analyzeProperty.execute(analyzeProperty.example));
  assert.equal(body.meta.billing, undefined, "L402 responses keep their exact existing shape");
  assert.equal(await balance(), "5.00");
  // The dedicated route is unchanged: the same token can't be replayed there either.
  assert.equal((await post(base, "/api/v1/l402" + analyzeProperty.path, analyzeProperty.example, { Authorization: `L402 ${m[1]}:${preimage}` })).status, 402);
  // Discovery lists l402 once enabled.
  const methods = (await (await fetch(base + "/api/v1/payment-methods")).json() as any).data.methods.map((x: any) => x.id);
  assert.deepEqual(methods, ["api_credits", "subscription", "l402"]);
});

class FakeFacilitator {
  settles = 0;
  async verify(payload: { payload?: { authorization?: { from?: string } } }) { return { isValid: true, payer: payload?.payload?.authorization?.from }; }
  async settle(payload: { payload?: { authorization?: { from?: string } } }, requirements: { network: string }) {
    this.settles++;
    return { success: true, transaction: "0x" + randomBytes(32).toString("hex"), network: requirements.network, payer: payload?.payload?.authorization?.from };
  }
}

test("MPP through the canonical route: X-Rafid-Payment-Method: mpp → real Payment challenge → real mppx client pays → 200; the API key is never charged", async t => {
  const config = loadConfig({
    ...billingEnv, MPP_ENABLED: "true", MPP_SECRET_KEY: randomBytes(32).toString("base64"), MPP_NETWORK: "tempo-testnet",
    MPP_MODES: "charge,session", MPP_CHARGE_METHODS: "evm,tempo", MPP_EVM_NETWORK: "eip155:84532", MPP_EVM_RECIPIENT: "0x29d4d3Ced89d7adcb0Ae47Ef6892CE24BD2b125f",
    MPP_TEMPO_PRIVATE_KEY: generatePrivateKey()
  });
  const facilitator = new FakeFacilitator();
  const kv = new MemoryMppKv();
  const provider = new MppxProvider(config.mpp, { chargeStore: toMppxStore(kv, "c:"), sessionStore: toMppxStore(kv, "s:"), evmFacilitator: facilitator });
  const store = new MemoryBillingStore();
  const base = await listen(t, createApp(config, { logger: () => {}, billingStore: store, mppProvider: provider, mppAudit: () => {} }));
  const { apiKey, balance } = await fundedKey(store, "5.00");
  const path = "/api/v1" + omanProperty.path;
  const unpaid = await post(base, path, omanProperty.example, { "X-Rafid-Api-Key": apiKey, "X-Rafid-Payment-Method": "mpp" });
  assert.equal(unpaid.status, 402);
  assert.match(unpaid.headers.get("www-authenticate") ?? "", /^Payment /);
  const client = MppxClient.create({ polyfill: false, methods: [evmClient.charge({ account: privateKeyToAccount(generatePrivateKey()), currencies: [Assets.baseSepolia.USDC] })] as never });
  const credential = await client.createCredential(unpaid as never) as string;
  const paid = await post(base, path, omanProperty.example, { Authorization: credential });
  assert.equal(paid.status, 200);
  const body = await paid.json() as any;
  assert.equal(body.payment.protocol, "mpp");
  assert.equal(body.payment.amount, 0.25, "MPP charges the same canonical price");
  assert.equal(facilitator.settles, 1);
  assert.equal(await balance(), "5.00");
  // The dedicated MPP route still works independently.
  assert.equal((await post(base, `/api/v1/mpp/charge/${omanProperty.name}`, omanProperty.example)).status, 402);
  const caps = (await (await fetch(base + "/api/v1/capabilities")).json() as any).data;
  assert.deepEqual(caps.find((c: any) => c.name === omanProperty.name).paymentMethods, ["mpp-charge", "mpp-session", "api_credits", "subscription"]);
});

test("MCP stdio hosted mode: RAFID_API_KEY forwards tools/call to the API, billed to the key's account", { timeout: 30000 }, async t => {
  const store = new MemoryBillingStore();
  const base = await listen(t, createApp(loadConfig(billingEnv), { logger: () => {}, billingStore: store }));
  const { apiKey, balance } = await fundedKey(store, "1.00");
  // Unit: the executor itself.
  const exec = createHostedExecutor({ apiKey, baseUrl: base });
  const r = await exec(research as never, research.example);
  assert.deepEqual(r.data, await research.execute(research.example));
  assert.equal((r.meta!["com.rafidsystem/billing"] as any).remainingBalance, "0.85");
  await assert.rejects(createHostedExecutor({ apiKey: "raf_live_" + "N".repeat(43), baseUrl: base })(research as never, research.example), { code: "invalid_api_key" });
  // End to end: the compiled stdio server (npm run build first; `npm test` does via pretest).
  const child = spawn(process.execPath, ["dist/mcp.js"], { env: { ...process.env, LOG_LEVEL: "silent", RAFID_API_KEY: apiKey, RAFID_API_URL: base }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  const pending = new Map<number, (v: any) => void>();
  lines.on("line", line => { const msg = JSON.parse(line); if (msg.id !== undefined) { pending.get(msg.id)?.(msg); pending.delete(msg.id); } });
  t.after(() => { lines.close(); child.stdin.end(); child.kill(); });
  let id = 0;
  const call = (method: string, params: unknown) => new Promise<any>((resolve, reject) => {
    const current = ++id; const timer = setTimeout(() => reject(new Error("MCP timeout")), 15000);
    pending.set(current, v => { clearTimeout(timer); resolve(v); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: current, method, params }) + "\n");
  });
  await call("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "rafid-tests", version: "1.0.0" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  const result = await call("tools/call", { name: "research_company", arguments: research.example });
  assert.equal(result.result.isError, undefined);
  assert.deepEqual(result.result.structuredContent, await research.execute(research.example));
  assert.equal(result.result._meta["com.rafidsystem/billing"].rail, "api_credits");
  assert.equal(await balance(), "0.70");
  // Insufficient balance surfaces the 402 details as a tool error, never a silent free call.
  const expensive = tool("due_diligence_oman_company");
  const poor = await call("tools/call", { name: expensive.name, arguments: expensive.example });
  assert.equal(poor.result.isError, true);
  assert.equal(JSON.parse(poor.result.content[0].text).error.code, "insufficient_credits");
  assert.equal(await balance(), "0.70");
});
