import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { Mppx as MppxClient, evm as evmClient } from "mppx/client";
import { Assets } from "mppx/evm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { createApp } from "../src/api/app.js";
import { loadConfig } from "../src/config/env.js";
import { capabilities } from "../src/domain/capabilities.js";
import { prices } from "../src/billing/catalog.js";
import { buildOpenapi } from "../src/api/openapi.js";
import { buildLlmsTxt } from "../src/api/llms-txt.js";
import { buildCapabilitiesRegistry } from "../src/api/agent.js";
import { buildAgentManifest, buildAgentCard } from "../src/api/manifest.js";
import { MemoryRevenueLedger } from "../src/revenue/memoryLedger.js";
import { MemoryAnalyticsRepository } from "../src/analytics/memoryRepository.js";
import { buildReconciliation, isPaidToolExecution } from "../src/revenue/aggregate.js";
import {
  MppxProvider, MppService, MppPaymentFailure, MemoryMppKv, PostgresMppKv, MemoryMppSessionRepository, PostgresMppSessionRepository,
  MemoryMppChargeRedemptionStore, toMppxStore, loadMppConfig, describeMppConfig, mppAudit, MPP_SESSION_LEDGER_TOOL,
  microsToDecimalString, usdToMicros,
  type ChannelState, type ChargeTerms, type MppSessionRepository, type CredentialPreview, type MppProvider, type OpenedSession, type PaymentChallenge,
  type SessionCallTerms, type SessionOpenTerms, type SettledCharge, type SettlementResult, type VerifiedCharge
} from "../src/billing/mpp/index.js";
import { Store } from "mppx";

// ===============================================================================================
// Fixtures
// ===============================================================================================

const key = "test-only-not-a-real-credential-12345";
const PAYEE_KEY = generatePrivateKey();
const EVM_RECIPIENT = "0x29d4d3Ced89d7adcb0Ae47Ef6892CE24BD2b125f";
const baseEnv = { RAFID_API_KEYS: key, LOG_LEVEL: "silent" as const, RATE_LIMIT_ENABLED: "false" };
const mppEnv = {
  ...baseEnv, MPP_ENABLED: "true", MPP_SECRET_KEY: randomBytes(32).toString("base64"), MPP_NETWORK: "tempo-testnet",
  MPP_MODES: "charge,session", MPP_CHARGE_METHODS: "evm,tempo", MPP_EVM_NETWORK: "eip155:84532", MPP_EVM_RECIPIENT: EVM_RECIPIENT,
  MPP_TEMPO_PRIVATE_KEY: PAYEE_KEY
};
const tool = (name: string) => capabilities.find(c => c.name === name)!;
const supplier = tool("oman_supplier_check"); // $0.50
const omanProperty = tool("analyze_oman_property"); // $0.25
const analyzeProperty = tool("analyze_property"); // $0.01

const post = (base: string, path: string, body: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
  method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body)
});

async function listen(t: { after(fn: () => void): void }, app: ReturnType<typeof createApp>) {
  const server = app.listen(0, "127.0.0.1");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

/** x402-compatible facilitator stand-in for evm/charge: the ONLY mocked network hop. The real
 *  mppx server still verifies the EIP-712 signature, amount, recipient, scope and challenge HMAC. */
class FakeFacilitator {
  verifies = 0; settles = 0; failSettle = false;
  async verify(payload: { payload?: { authorization?: { from?: string } } }) { this.verifies++; return { isValid: true, payer: payload?.payload?.authorization?.from }; }
  async settle(payload: { payload?: { authorization?: { from?: string } } }, requirements: { network: string }) {
    this.settles++;
    if (this.failSettle) return { success: false, errorReason: "insufficient_funds", transaction: "", network: requirements.network };
    return { success: true, transaction: "0x" + randomBytes(32).toString("hex"), network: requirements.network, payer: payload?.payload?.authorization?.from };
  }
}

function realChargeApp(t: { after(fn: () => void): void }, env: Record<string, string> = {}) {
  const config = loadConfig({ ...mppEnv, ...env });
  const facilitator = new FakeFacilitator();
  const kv = new MemoryMppKv();
  const provider = new MppxProvider(config.mpp, { chargeStore: toMppxStore(kv, "c:"), sessionStore: toMppxStore(kv, "s:"), evmFacilitator: facilitator });
  const revenueLedger = new MemoryRevenueLedger();
  const analyticsRepository = new MemoryAnalyticsRepository();
  const audit: Record<string, unknown>[] = [];
  const app = createApp(config, { logger: () => {}, mppProvider: provider, revenueLedger, analyticsRepository, mppAudit: e => audit.push(e) });
  return listen(t, app).then(base => ({ base, config, facilitator, revenueLedger, analyticsRepository, audit }));
}

/** A real MPP client (the official mppx SDK) paying evm/charge challenges with a throwaway key. */
function payer() {
  const client = MppxClient.create({ polyfill: false, methods: [evmClient.charge({ account: privateKeyToAccount(generatePrivateKey()), currencies: [Assets.baseSepolia.USDC] })] as never });
  return {
    credentialFor: async (res: Response) => client.createCredential(res as never) as Promise<string>
  };
}

// ===============================================================================================
// Config
// ===============================================================================================

test("MPP is disabled by default and loadConfig fails closed on every MPP misconfiguration", () => {
  const off = loadConfig(baseEnv);
  assert.equal(off.mpp.enabled, false);
  assert.deepEqual(describeMppConfig(off.mpp).modes, []);
  for (const env of [
    { ...mppEnv, MPP_SECRET_KEY: "short" },
    { ...mppEnv, MPP_SECRET_KEY: "replace-with-a-random-secret-of-32-bytes-min" },
    { ...mppEnv, MPP_PROVIDER: "something-else" },
    { ...mppEnv, MPP_NETWORK: "ethereum" },
    { ...mppEnv, MPP_MODES: "charge,subscription" },
    { ...mppEnv, MPP_CURRENCY: "EUR" },
    { ...mppEnv, MPP_CHARGE_METHODS: "stripe" },
    { ...mppEnv, MPP_TEMPO_PRIVATE_KEY: "" },                                          // session needs the payee key
    { ...mppEnv, MPP_TEMPO_PRIVATE_KEY: "0x1234" },
    { ...mppEnv, MPP_EVM_NETWORK: "eip155:8453" },                                     // mainnet evm/charge needs CDP
    { ...mppEnv, MPP_TEMPO_RPC_URL: "http://insecure.example" },
    { ...mppEnv, MPP_MIN_SESSION_BUDGET_USD: "50", MPP_MAX_SESSION_BUDGET_USD: "10" }
  ]) assert.throws(() => loadConfig(env), Error, JSON.stringify(env).slice(0, 200));
  assert.throws(() => loadConfig({ ...mppEnv, NODE_ENV: "production", AUTH_MODE: "postgres" }, { requireApiKeys: false }), /DATABASE_URL/);
  const on = loadConfig(mppEnv);
  assert.equal(on.mpp.enabled, true);
  assert.deepEqual([...on.mpp.modes], ["charge", "session"]);
  assert.equal(on.mpp.tempo.chainId, 42431);
  assert.equal(on.mpp.tempo.recipient, privateKeyToAccount(PAYEE_KEY).address); // derived from the payee key
  const described = JSON.stringify(describeMppConfig(on.mpp));
  assert.equal(described.includes(PAYEE_KEY.slice(2)), false);
  assert.equal(described.includes(on.mpp.secretKey), false);
});

test("money helpers are exact in integer micros", () => {
  assert.equal(usdToMicros(0.25), 250_000);
  assert.equal(usdToMicros(0.1 + 0.2), 300_000);
  assert.equal(microsToDecimalString(250_000), "0.25");
  assert.equal(microsToDecimalString(20_000_000), "20");
  assert.equal(microsToDecimalString(1), "0.000001");
});

// ===============================================================================================
// Disabled behavior + discovery regression
// ===============================================================================================

test("MPP disabled: payment routes answer 404 MPP_DISABLED, info/status always answer, discovery unchanged except an explicit enabled:false", async t => {
  const config = loadConfig(baseEnv);
  const base = await listen(t, createApp(config, { logger: () => {} }));
  for (const [method, path] of [["POST", "/api/v1/mpp/charge/analyze_property"], ["POST", "/api/v1/mpp/sessions"], ["GET", "/api/v1/mpp/sessions/mpp_x"]] as const) {
    const r = await fetch(base + path, { method, headers: { "Content-Type": "application/json" }, ...(method === "POST" ? { body: "{}" } : {}) });
    assert.equal(r.status, 404);
    assert.equal((await r.json()).error.code, "MPP_DISABLED");
  }
  const status = await (await fetch(base + "/api/v1/mpp/status")).json();
  assert.equal(status.data.enabled, false);
  const info = await (await fetch(base + "/api/v1/mpp")).json();
  assert.equal(info.data.tools.length, capabilities.length);
  const registry = buildCapabilitiesRegistry(config);
  assert.ok(registry.every(c => !c.paymentMethods.includes("mpp-charge") && !("mppChargeEndpoint" in c)));
  assert.deepEqual(buildAgentManifest(config).payments.mpp, { enabled: false, modes: [] });
  const paths = buildOpenapi(config).paths as Record<string, unknown>;
  assert.ok(paths["/api/v1/mpp/status"]);
  assert.equal(paths["/api/v1/mpp/charge/{tool}"], undefined);
  // Existing rails are untouched.
  assert.equal((await post(base, "/api/v1" + analyzeProperty.path, analyzeProperty.example, { "X-API-Key": key })).status, 200);
});

test("MPP enabled: discovery (/agent.json, /.well-known/agent.json, /llms.txt, /api/v1/capabilities, OpenAPI) advertises MPP without breaking existing fields", async t => {
  const { base, config } = await realChargeApp(t);
  const caps = (await (await fetch(base + "/api/v1/capabilities")).json()).data;
  assert.equal(caps.length, capabilities.length);
  for (const c of caps) {
    assert.equal(typeof c.price, "number");                       // unchanged field
    assert.equal(c.price, prices[c.name as keyof typeof prices]);  // from the registry
    assert.ok(c.paymentMethods.includes("mpp-charge") && c.paymentMethods.includes("mpp-session"));
    assert.equal(c.mppChargeEndpoint, `/api/v1/mpp/charge/${c.name}`);
  }
  const manifest = await (await fetch(base + "/agent.json")).json();
  assert.deepEqual(manifest.payments.mpp.modes, ["charge", "session"]);
  assert.deepEqual(manifest.tools, buildCapabilitiesRegistry(config));
  assert.ok(manifest.protocols.some((p: { protocol: string }) => p.protocol === "mpp"));
  const card = await (await fetch(base + "/.well-known/agent.json")).json();
  assert.ok(card.authentication.schemes.includes("mpp"));
  assert.equal(card.skills.length, capabilities.length);
  assert.deepEqual(card, buildAgentCard(config, base));
  const llms = await (await fetch(base + "/llms.txt")).text();
  assert.equal(llms, buildLlmsTxt(config));
  assert.match(llms, /MPP charge: {4}POST \/api\/v1\/mpp\/charge\/analyze_property/);
  assert.match(llms, /## Payment \(MPP \/ Machine Payments Protocol\)/);
  const openapi = await (await fetch(base + "/openapi.json")).json();
  for (const p of ["/api/v1/mpp/charge/{tool}", "/api/v1/mpp/sessions", "/api/v1/mpp/sessions/{sessionId}", "/api/v1/mpp/sessions/{sessionId}/tools/{tool}", "/api/v1/mpp/sessions/{sessionId}/close"]) assert.ok(openapi.paths[p], p);
  const callOp = openapi.paths["/api/v1/mpp/sessions/{sessionId}/tools/{tool}"].post;
  for (const s of ["200", "400", "402", "403", "404", "409", "410", "422"]) assert.ok(callOp.responses[s], s);
  assert.ok(callOp.responses["402"].content["application/json"].examples.budget);
  // Every operationId stays unique.
  const ids = Object.values(openapi.paths as Record<string, Record<string, { operationId: string }>>).flatMap(p => Object.values(p).map(o => o.operationId));
  assert.equal(new Set(ids).size, ids.length);
});

// ===============================================================================================
// Charge — the real mppx SDK end to end (client signs, server validates/settles)
// ===============================================================================================

test("MPP charge: unpaid → 402 with real Payment challenges; invalid input → 400 before any payment step", async t => {
  const { base, facilitator } = await realChargeApp(t);
  const bad = await post(base, "/api/v1/mpp/charge/analyze_oman_property", { governorate: "Muscat" });
  assert.equal(bad.status, 400);
  assert.equal(bad.headers.get("www-authenticate"), null);
  assert.equal((await bad.json()).error.code, "INVALID_INPUT");

  const unpaid = await post(base, "/api/v1/mpp/charge/analyze_oman_property", omanProperty.example);
  assert.equal(unpaid.status, 402);
  const www = unpaid.headers.get("www-authenticate") ?? "";
  assert.match(www, /^Payment id="/);
  assert.match(www, /method="evm"/);
  assert.match(www, /method="tempo"/);
  assert.match(unpaid.headers.get("access-control-expose-headers") ?? "", /Payment-Receipt/);
  const body = await unpaid.json();
  assert.equal(body.protocol, "mpp");
  assert.equal(body.mode, "charge");
  assert.equal(body.tool, "analyze_oman_property");
  assert.equal(body.amount, 0.25);
  assert.equal(body.currency, "USD");
  assert.equal(body.paymentRequired, true);
  assert.equal(body.challenges.length, 2);
  for (const c of body.challenges) assert.equal(c.request.amount, "250000"); // 0.25 in 6-decimal raw units, from the registry
  assert.equal(facilitator.verifies + facilitator.settles, 0);

  const unknown = await post(base, "/api/v1/mpp/charge/do_everything", {});
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, "MPP_UNSUPPORTED_TOOL");
});

test("MPP charge: valid payment → tool executes once, settles once, Payment-Receipt, one ledger row; replay rejected", async t => {
  const { base, facilitator, revenueLedger, analyticsRepository, audit } = await realChargeApp(t);
  const path = "/api/v1/mpp/charge/analyze_oman_property";
  const unpaid = await post(base, path, omanProperty.example);
  const credential = await payer().credentialFor(unpaid);
  assert.match(credential, /^Payment /);

  const paid = await post(base, path, omanProperty.example, { Authorization: credential });
  assert.equal(paid.status, 200);
  const body = await paid.json();
  assert.equal(body.success, true);
  assert.ok(body.data.normalizedLocation);
  assert.equal(body.payment.protocol, "mpp");
  assert.equal(body.payment.method, "evm");
  assert.equal(body.payment.amount, 0.25);
  assert.ok(paid.headers.get("payment-receipt"));
  assert.equal(facilitator.settles, 1);

  const replay = await post(base, path, omanProperty.example, { Authorization: credential });
  assert.equal(replay.status, 402);
  assert.equal((await replay.json()).error.code, "MPP_PAYMENT_REPLAYED");
  assert.equal(facilitator.settles, 1);

  await new Promise(r => setTimeout(r, 20));
  const rows = await revenueLedger.query({ since: null });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.toolName, "analyze_oman_property");
  assert.equal(rows[0]!.amountDecimal, 0.25);
  assert.equal(rows[0]!.network, "eip155:84532");
  assert.equal(rows[0]!.facilitator, "mpp:evm");
  const events = await analyticsRepository.queryEvents(new Date(0));
  const paidExec = events.filter(e => isPaidToolExecution(e));
  assert.equal(paidExec.length, 1);
  const anomalies = buildReconciliation({ settlements: rows, x402ToolExecutionCounts: { analyze_oman_property: 1 }, catalogPriceByTool: { ...prices } });
  assert.deepEqual(anomalies, []);
  // Audit trail, and no credential material in it.
  for (const e of ["mpp.charge.challenge", "mpp.charge.verified", "mpp.charge.settled", "mpp.charge.replay_rejected"]) assert.ok(audit.some(a => a.event === e), e);
  const auditText = JSON.stringify(audit);
  assert.equal(auditText.includes(credential.slice(8, 60)), false);
});

test("MPP charge: invalid/tampered/wrong-tool credentials rejected; valid credential + invalid input is not charged", async t => {
  const { base, facilitator } = await realChargeApp(t);
  const garbage = await post(base, "/api/v1/mpp/charge/analyze_property", analyzeProperty.example, { Authorization: "Payment not-a-credential" });
  assert.equal(garbage.status, 402);
  assert.equal((await garbage.json()).error.code, "MPP_INVALID_PAYMENT");

  // A credential paid for the $0.01 tool cannot buy the $2.00 tool (amount + scope are bound).
  const cheap = await post(base, "/api/v1/mpp/charge/analyze_property", analyzeProperty.example);
  const cheapCredential = await payer().credentialFor(cheap);
  const dd = tool("due_diligence_oman_company");
  const swapped = await post(base, "/api/v1/mpp/charge/due_diligence_oman_company", dd.example, { Authorization: cheapCredential });
  assert.equal(swapped.status, 402);
  assert.equal((await swapped.json()).error.code, "MPP_INVALID_PAYMENT");

  // Tampered credential (payload edited) fails signature/binding verification.
  const [scheme, token] = cheapCredential.split(" ");
  const decoded = JSON.parse(Buffer.from(token!, "base64url").toString());
  decoded.payload.value = "1";
  const tampered = `${scheme} ${Buffer.from(JSON.stringify(decoded)).toString("base64url")}`;
  assert.equal((await post(base, "/api/v1/mpp/charge/analyze_property", analyzeProperty.example, { Authorization: tampered })).status, 402);

  // Valid credential but invalid tool input → 400, nothing settled, credential still usable.
  const invalidInput = await post(base, "/api/v1/mpp/charge/analyze_property", { propertyValue: -1 }, { Authorization: cheapCredential });
  assert.equal(invalidInput.status, 400);
  assert.equal(facilitator.settles, 0);
  const ok = await post(base, "/api/v1/mpp/charge/analyze_property", analyzeProperty.example, { Authorization: cheapCredential });
  assert.equal(ok.status, 200);
  assert.equal(facilitator.settles, 1);
});

test("MPP charge: a settlement failure withholds the result and releases the credential claim", async t => {
  const { base, facilitator, revenueLedger } = await realChargeApp(t);
  facilitator.failSettle = true;
  const unpaid = await post(base, "/api/v1/mpp/charge/analyze_property", analyzeProperty.example);
  const credential = await payer().credentialFor(unpaid);
  const r = await post(base, "/api/v1/mpp/charge/analyze_property", analyzeProperty.example, { Authorization: credential });
  assert.equal(r.status, 402);
  const body = await r.json();
  assert.equal(body.error.code, "MPP_SETTLEMENT_FAILED");
  assert.equal(body.data, undefined);
  assert.equal((await revenueLedger.query({ since: null })).length, 0);
  facilitator.failSettle = false;
  assert.equal((await post(base, "/api/v1/mpp/charge/analyze_property", analyzeProperty.example, { Authorization: credential })).status, 200);
});

test("MPP (real SDK, offline): tempo/session open and voucher challenges are genuine Payment challenges bound to their scope", async () => {
  const config = loadConfig(mppEnv);
  const kv = new MemoryMppKv();
  const provider = new MppxProvider(config.mpp, { chargeStore: toMppxStore(kv, "c:"), sessionStore: toMppxStore(kv, "s:"), evmFacilitator: new FakeFacilitator() });
  const open = await provider.createSession({ scope: "rafid:session-open:mpp_" + "a".repeat(32), meta: { terms: "d".repeat(64) }, suggestedDepositMicros: 10_000_000, unitAmountMicros: 10_000, url: "https://api.rafidsystem.com/api/v1/mpp/sessions", description: "t" });
  assert.match(open.headers[0]![1], /intent="session"/);
  assert.equal(open.challenges[0]!.intent, "session");
  assert.equal(open.challenges[0]!.request.suggestedDeposit, "10000000");
  assert.equal(open.challenges[0]!.request.amount, "10000");
  assert.equal((open.challenges[0]!.request.methodDetails as { chainId: number }).chainId, 42431);
  const channelId = "0x" + "ab".repeat(32);
  const voucher = await provider.sessionCallChallenge({ channelId, amountMicros: 500_000, scope: "rafid:session:mpp_x", url: "https://api.rafidsystem.com/x", description: "v" });
  assert.equal(voucher.challenges[0]!.request.amount, "500000");
  // A forged credential is rejected by the SDK, never accepted.
  const forged = "Payment " + Buffer.from(JSON.stringify({ challenge: { ...open.challenges[0], id: "forged" }, payload: { action: "open", channelId } })).toString("base64url");
  await assert.rejects(provider.verifySession(forged, { scope: "rafid:session-open:mpp_" + "a".repeat(32), meta: { terms: "d".repeat(64) }, suggestedDepositMicros: 10_000_000, unitAmountMicros: 10_000, url: "https://x", description: "t" }), MppPaymentFailure);
  assert.equal(await provider.getChannel(channelId), null);
});

// ===============================================================================================
// Session — business logic with a deterministic TIP-1034 channel simulator behind MppProvider
// ===============================================================================================

interface FakeChannel { deposit: number; accepted: number; spent: number; settled: number; finalized: boolean }
interface FakeChallenge { id: string; scope: string; meta: Record<string, string>; kind: "open" | "voucher"; channelId?: string; amount: number; suggestedDeposit?: number }

/** Simulates a Tempo payment channel with the SDK's real semantics: cumulative vouchers must not
 *  decrease and can't exceed the deposit; spend only advances via recordUsage; server settle
 *  captures the highest voucher; payer close captures exactly the metered spend. */
class FakeChannelProvider implements MppProvider {
  readonly name = "fake-tempo";
  readonly challenges = new Map<string, FakeChallenge>();
  readonly channels = new Map<string, FakeChannel>();
  settlements = 0;
  /** Failure injection for settlement paths (consumed once). */
  failNextSettle: MppPaymentFailure | null = null;
  failNextClose: MppPaymentFailure | null = null;
  probes = 0;
  private issue(c: Omit<FakeChallenge, "id">): PaymentChallenge {
    const id = randomUUID();
    this.challenges.set(id, { ...c, id });
    return {
      headers: [["WWW-Authenticate", `Payment id="${id}", realm="test", method="tempo", intent="session"`]],
      challenges: [{ id, method: "tempo", intent: "session", realm: "test", request: { amount: String(c.amount), ...(c.suggestedDeposit ? { suggestedDeposit: String(c.suggestedDeposit) } : {}), ...(c.channelId ? { channelId: c.channelId } : {}) }, description: null, expires: null }],
      problem: { status: 402 },
      wire: []
    };
  }
  /** Client side: what an MPP wallet would send back. */
  credential(challengeId: string, payload: Record<string, unknown>): string {
    const c = this.challenges.get(challengeId);
    return "Payment " + Buffer.from(JSON.stringify({ challenge: { id: challengeId, scope: c?.scope, meta: c?.meta }, payload })).toString("base64url");
  }
  private decode(auth: string): { challenge: { id: string; scope: string; meta: Record<string, string> }; payload: Record<string, unknown> } {
    try { return JSON.parse(Buffer.from(auth.replace(/^Payment\s+/i, ""), "base64url").toString()); }
    catch { throw new MppPaymentFailure("invalid", "malformed-credential"); }
  }
  private issued(auth: string) {
    const d = this.decode(auth);
    const c = this.challenges.get(d.challenge.id);
    if (!c || c.scope !== d.challenge.scope || JSON.stringify(c.meta) !== JSON.stringify(d.challenge.meta)) throw new MppPaymentFailure("invalid", "challenge-not-issued");
    return { c, payload: d.payload };
  }
  async createCharge(): Promise<PaymentChallenge> { throw new MppPaymentFailure("unavailable", "charge not simulated"); }
  async verifyCharge(): Promise<VerifiedCharge> { throw new MppPaymentFailure("unavailable", "charge not simulated"); }
  async settleCharge(_a: string, _t: ChargeTerms): Promise<SettledCharge> { throw new MppPaymentFailure("unavailable", "charge not simulated"); }
  previewCredential(auth: string): CredentialPreview | null {
    try {
      const d = this.decode(auth);
      return { challengeId: d.challenge.id, method: "tempo", intent: "session", scope: d.challenge.scope ?? null, meta: d.challenge.meta ?? {}, action: String(d.payload.action ?? ""), channelId: typeof d.payload.channelId === "string" ? d.payload.channelId : null };
    } catch { return null; }
  }
  async createSession(t: SessionOpenTerms) { return this.issue({ scope: t.scope, meta: t.meta, kind: "open", amount: t.unitAmountMicros, suggestedDeposit: t.suggestedDepositMicros }); }
  async verifySession(auth: string, t: SessionOpenTerms): Promise<OpenedSession> {
    const { c, payload } = this.issued(auth);
    if (c.kind !== "open" || c.scope !== t.scope || payload.action !== "open") throw new MppPaymentFailure("invalid", "not-open");
    const channelId = String(payload.channelId);
    if (this.channels.has(channelId)) throw new MppPaymentFailure("invalid", "channel-exists");
    // Like the real SDK: the open credential carries a first voucher for the challenge's unit
    // amount — accepted (authorized) but not metered.
    this.channels.set(channelId, { deposit: Number(payload.deposit), accepted: c.amount, spent: 0, settled: 0, finalized: false });
    return { channelId, reference: "0xopen" + channelId.slice(2, 10), depositMicros: Number(payload.deposit), receiptHeader: "receipt-open" };
  }
  async sessionCallChallenge(a: SessionCallTerms & { url: string; description: string }) { return this.issue({ scope: a.scope, meta: {}, kind: "voucher", channelId: a.channelId, amount: a.amountMicros }); }
  private checkVoucher(auth: string, a: SessionCallTerms) {
    const { c, payload } = this.issued(auth);
    if (payload.action !== "voucher" || c.scope !== a.scope || payload.channelId !== a.channelId || c.channelId !== a.channelId) throw new MppPaymentFailure("invalid", "voucher-mismatch");
    const ch = this.channels.get(a.channelId);
    if (!ch || ch.finalized) throw new MppPaymentFailure("closed", "channel-closed");
    const cumulative = Number(payload.cumulative);
    if (cumulative > ch.deposit) throw new MppPaymentFailure("insufficient", "exceeds-deposit");
    if (cumulative < ch.accepted) throw new MppPaymentFailure("invalid", "voucher-decreased");
    return { ch, cumulative };
  }
  async verifySessionCall(auth: string, a: SessionCallTerms) { this.checkVoucher(auth, a); }
  async recordUsage(auth: string, a: SessionCallTerms): Promise<{ channel: ChannelState; receiptHeader: string }> {
    const { ch, cumulative } = this.checkVoucher(auth, a);
    ch.accepted = Math.max(ch.accepted, cumulative);
    if (ch.accepted - ch.spent < a.amountMicros) throw new MppPaymentFailure("insufficient", "voucher-headroom");
    ch.spent += a.amountMicros;
    return { channel: (await this.getChannel(a.channelId))!, receiptHeader: `receipt-spent-${ch.spent}` };
  }
  async getChannel(id: string): Promise<ChannelState | null> {
    const ch = this.channels.get(id);
    return ch ? { channelId: id, depositMicros: ch.deposit, acceptedMicros: ch.accepted, spentMicros: ch.spent, settledMicros: ch.settled, finalized: ch.finalized, closeRequested: false } : null;
  }
  async settleSession(id: string): Promise<SettlementResult | null> {
    if (this.failNextSettle) { const f = this.failNextSettle; this.failNextSettle = null; throw f; }
    const ch = this.channels.get(id);
    if (!ch || ch.finalized || ch.accepted !== ch.spent || ch.spent <= ch.settled) return null;
    const delta = ch.accepted - ch.settled;
    ch.settled = ch.accepted;
    this.settlements++;
    return { reference: "0xsettle" + this.settlements, settledMicros: ch.settled, deltaMicros: delta, network: "tempo:42431", asset: "pathUSD", payTo: "0xpayee" };
  }
  async closeSession(auth: string, a: { channelId: string; scope: string }): Promise<SettlementResult> {
    const { payload } = this.issued(auth);
    if (payload.action !== "close" || payload.channelId !== a.channelId) throw new MppPaymentFailure("invalid", "not-close");
    if (this.failNextClose) { const f = this.failNextClose; this.failNextClose = null; throw f; }
    const ch = this.channels.get(a.channelId)!;
    if (ch.finalized) throw new MppPaymentFailure("closed", "channel-finalized");
    const before = ch.settled;
    ch.settled = Math.max(ch.spent, ch.settled);
    ch.finalized = true;
    this.settlements++;
    return { reference: "0xclose" + this.settlements, settledMicros: ch.settled, deltaMicros: ch.settled - before, receiptHeader: "receipt-close-" + this.settlements, finalized: true, network: "tempo:42431", asset: "pathUSD", payTo: "0xpayee" };
  }
  async readOnChainChannel(id: string) {
    const ch = this.channels.get(id);
    return ch ? { depositMicros: ch.deposit, settledMicros: ch.settled, closeRequested: false } : null;
  }
  async probe() { this.probes++; return { reachable: true, chainId: 42431, reason: null }; }
}

async function startSessionApp(t: { after(fn: () => void): void }, opts: { env?: Record<string, string>; now?: () => Date; sessions?: MppSessionRepository } = {}) {
  const config = loadConfig({ ...mppEnv, MPP_MODES: "session", ...(opts.env ?? {}) });
  const provider = new FakeChannelProvider();
  const sessions = opts.sessions ?? new MemoryMppSessionRepository();
  const revenueLedger = new MemoryRevenueLedger();
  const analyticsRepository = new MemoryAnalyticsRepository();
  const audit: Record<string, unknown>[] = [];
  const app = createApp(config, { logger: () => {}, mppProvider: provider, mppSessions: sessions, revenueLedger, analyticsRepository, mppAudit: e => audit.push(e), mppNow: opts.now });
  const base = await listen(t, app);

  /** A minimal agent: opens a session, then pays each call with the next cumulative voucher. */
  const agent = {
    async open(body: { maxBudget: number; allowedTools: string[]; currency?: string }, depositUsd = body.maxBudget) {
      const pending = await post(base, "/api/v1/mpp/sessions", body);
      assert.equal(pending.status, 402);
      const p = await pending.json();
      const channelId = "0x" + randomBytes(32).toString("hex");
      const credential = provider.credential(p.challenges[0].id, { action: "open", channelId, deposit: usdToMicros(depositUsd) });
      const opened = await post(base, "/api/v1/mpp/sessions", body, { Authorization: credential });
      return { pending: p, opened, channelId, credential };
    },
    /** Probe for the voucher challenge, then pay it with cumulative = channel spent + price (what
     *  an mppx client derives from the server's session snapshot). */
    async call(sessionId: string, name: string, input: unknown, idem: string, opts2: { cumulative?: number } = {}) {
      const path = `/api/v1/mpp/sessions/${sessionId}/tools/${name}`;
      const probe = await post(base, path, input, { "Idempotency-Key": idem });
      if (probe.status !== 402) return probe;
      const pb = await probe.json();
      if (!pb.challenges) return new Response(JSON.stringify(pb), { status: 402 });
      const ch = provider.channels.get(pb.challenges[0].request.channelId)!;
      const cumulative = opts2.cumulative ?? ch.spent + Number(pb.challenges[0].request.amount);
      const credential = provider.credential(pb.challenges[0].id, { action: "voucher", channelId: pb.challenges[0].request.channelId, cumulative });
      return post(base, path, input, { "Idempotency-Key": idem, Authorization: credential });
    }
  };
  return { base, config, provider, sessions, revenueLedger, analyticsRepository, audit, agent };
}

test("MPP session: create (402 pending → open credential → 201 active) with budget, tools and channel binding", async t => {
  const { base, agent, provider } = await startSessionApp(t);
  const body = { maxBudget: 20, currency: "USD", allowedTools: ["oman_supplier_check", "analyze_oman_property"] };
  const { pending, opened, channelId } = await agent.open(body);
  assert.equal(pending.protocol, "mpp");
  assert.equal(pending.mode, "session");
  assert.equal(pending.status, "pending");
  assert.match(pending.sessionId, /^mpp_[0-9a-f]{32}$/);
  assert.equal(opened.status, 201);
  const s = (await opened.json()).data;
  assert.equal(s.sessionId, pending.sessionId);
  assert.equal(s.status, "active");
  assert.equal(s.maxBudget, 20);
  assert.equal(s.spent, 0);
  assert.equal(s.remaining, 20);
  assert.equal(s.currency, "USD");
  assert.deepEqual(s.allowedTools, body.allowedTools);
  assert.equal(s.payment.channelId, channelId);
  assert.equal(s.payment.method, "tempo/session");
  assert.equal(provider.channels.get(channelId)!.deposit, 20_000_000);

  // Validation: unknown tool, over-limit budget, bad currency, unknown fields.
  for (const bad of [
    { maxBudget: 5, allowedTools: ["nope"] }, { maxBudget: 5000, allowedTools: ["analyze_property"] },
    { maxBudget: 5, currency: "EUR", allowedTools: ["analyze_property"] }, { maxBudget: 5, allowedTools: ["analyze_property"], price: 0 },
    { maxBudget: 0.1, allowedTools: ["oman_supplier_check"] }
  ]) assert.ok([400, 404].includes((await post(base, "/api/v1/mpp/sessions", bad)).status), JSON.stringify(bad));
});

test("MPP session: open credential cannot be replayed, and session terms cannot be swapped after the challenge", async t => {
  const { base, agent, provider } = await startSessionApp(t);
  const body = { maxBudget: 2, allowedTools: ["analyze_property"] };
  const { opened, credential } = await agent.open(body);
  assert.equal(opened.status, 201);
  const again = await post(base, "/api/v1/mpp/sessions", body, { Authorization: credential });
  assert.equal(again.status, 200); // idempotent: same session back, nothing re-opened
  assert.equal((await again.json()).idempotentReplay, true);
  assert.equal(provider.channels.size, 1);

  // Challenge issued for a $2 budget, credential presented with a $200 body → refused.
  const pending = await (await post(base, "/api/v1/mpp/sessions", { maxBudget: 2, allowedTools: ["analyze_property"] })).json();
  const cred = provider.credential(pending.challenges[0].id, { action: "open", channelId: "0x" + "cd".repeat(32), deposit: 2_000_000 });
  const swapped = await post(base, "/api/v1/mpp/sessions", { maxBudget: 200, allowedTools: ["analyze_property", "due_diligence_oman_company"] }, { Authorization: cred });
  assert.equal(swapped.status, 409);
  assert.equal((await swapped.json()).error.code, "MPP_TERMS_MISMATCH");
});

test("MPP session: effective budget is capped by the actual channel deposit", async t => {
  const { agent } = await startSessionApp(t);
  const { opened } = await agent.open({ maxBudget: 10, allowedTools: ["analyze_property"] }, 3);
  const s = (await opened.json()).data;
  assert.equal(s.requestedMaxBudget, 10);
  assert.equal(s.maxBudget, 3);
});

test("MPP session: multiple metered calls — spent/remaining/calls/per-tool usage correct, price from the registry, Payment-Receipt per call", async t => {
  const { base, agent, provider } = await startSessionApp(t);
  const { opened, channelId } = await agent.open({ maxBudget: 20, allowedTools: ["oman_supplier_check", "analyze_oman_property"] });
  const id = (await opened.json()).data.sessionId;

  // Unpaid probe: 402 voucher challenge, nothing reserved or charged.
  const probe = await post(base, `/api/v1/mpp/sessions/${id}/tools/oman_supplier_check`, supplier.example, { "Idempotency-Key": "probe-1", "X-Price": "0.0001" });
  assert.equal(probe.status, 402);
  const pb = await probe.json();
  assert.equal(pb.amount, 0.5);                            // registry price, not the client's X-Price
  assert.equal(pb.challenges[0].request.amount, "500000");
  assert.equal(pb.remaining, 20);

  let expectedSpent = 0;
  const plan = [["oman_supplier_check", supplier.example, 0.5], ["analyze_oman_property", omanProperty.example, 0.25], ["oman_supplier_check", supplier.example, 0.5]] as const;
  for (const [i, [name, input, price]] of plan.entries()) {
    const r = await agent.call(id, name, input, `call-${i}`);
    assert.equal(r.status, 200, `call ${i}`);
    assert.ok(r.headers.get("payment-receipt"));
    const b = await r.json();
    expectedSpent += price;
    assert.equal(b.usage.charge, price);
    assert.equal(b.usage.spent, expectedSpent);
    assert.equal(b.usage.remaining, 20 - expectedSpent);
    assert.equal(b.usage.calls, i + 1);
    assert.ok(b.data); // normal tool output, billing metadata kept outside it
    assert.equal(b.data.usage, undefined);
  }
  const view = (await (await fetch(base + `/api/v1/mpp/sessions/${id}`)).json()).data;
  assert.equal(view.status, "active");
  assert.equal(view.spent, 1.25);
  assert.equal(view.remaining, 18.75);
  assert.equal(view.calls, 3);
  assert.deepEqual(view.usageByTool, { oman_supplier_check: { calls: 2, spent: 1 }, analyze_oman_property: { calls: 1, spent: 0.25 } });
  assert.equal(view.payment.channel.metered, 1.25);
  assert.equal(provider.channels.get(channelId)!.spent, 1_250_000); // channel metering agrees with Rafid's
});

test("MPP session: disallowed tool, invalid input and unknown tool are rejected before any authorization or charge", async t => {
  const { base, agent, provider } = await startSessionApp(t);
  const { opened, channelId } = await agent.open({ maxBudget: 5, allowedTools: ["analyze_property"] });
  const id = (await opened.json()).data.sessionId;
  const notAllowed = await agent.call(id, "due_diligence_oman_company", tool("due_diligence_oman_company").example, "k1");
  assert.equal(notAllowed.status, 403);
  assert.equal((await notAllowed.json()).error.code, "MPP_TOOL_NOT_ALLOWED");
  const invalid = await post(base, `/api/v1/mpp/sessions/${id}/tools/analyze_property`, { propertyValue: "x" }, { "Idempotency-Key": "k2" });
  assert.equal(invalid.status, 400);
  const unknown = await post(base, `/api/v1/mpp/sessions/${id}/tools/nope`, {}, { "Idempotency-Key": "k3" });
  assert.equal(unknown.status, 404);
  assert.equal(provider.channels.get(channelId)!.spent, 0);
  assert.equal(provider.challenges.size, 1); // only the open challenge was ever issued
});

test("MPP session: insufficient budget is refused BEFORE execution with MPP_SESSION_BUDGET_EXCEEDED; last affordable call exhausts the session", async t => {
  const { agent, provider, base } = await startSessionApp(t);
  // $1.00 budget, $0.50 tool: two calls fit exactly; the session is then exhausted.
  const { opened, channelId } = await agent.open({ maxBudget: 1, allowedTools: ["oman_supplier_check", "analyze_oman_property"] });
  const id = (await opened.json()).data.sessionId;
  assert.equal((await agent.call(id, "oman_supplier_check", supplier.example, "a")).status, 200);
  assert.equal((await agent.call(id, "analyze_oman_property", omanProperty.example, "b")).status, 200); // spent 0.75, remaining 0.25
  const over = await agent.call(id, "oman_supplier_check", supplier.example, "c");
  assert.equal(over.status, 402);
  const ob = await over.json();
  assert.equal(ob.error.code, "MPP_SESSION_BUDGET_EXCEEDED");
  assert.equal(ob.required, 0.5);
  assert.equal(ob.remaining, 0.25);
  assert.equal(provider.channels.get(channelId)!.spent, 750_000);
  // The cheaper allowed tool still fits and exhausts the budget.
  const last = await agent.call(id, "analyze_oman_property", omanProperty.example, "d");
  assert.equal(last.status, 200);
  assert.equal((await last.json()).usage.status, "exhausted");
  const after = await post(base, `/api/v1/mpp/sessions/${id}/tools/analyze_oman_property`, omanProperty.example, { "Idempotency-Key": "e" });
  assert.equal(after.status, 402);
  assert.equal((await after.json()).error.code, "MPP_SESSION_EXHAUSTED");
});

test("MPP session: parallel calls can never exceed maxBudget (atomic reservation), even with a deposit larger than the budget", async t => {
  const { agent, provider, base } = await startSessionApp(t);
  const { opened, channelId } = await agent.open({ maxBudget: 1, allowedTools: ["oman_supplier_check"] }, 5);
  const id = (await opened.json()).data.sessionId;
  // Each concurrent call carries a voucher authorizing the whole $5 deposit, so the channel alone
  // would allow 10 calls; Rafid's $1 budget must allow exactly 2.
  const probe = await (await post(base, `/api/v1/mpp/sessions/${id}/tools/oman_supplier_check`, supplier.example, { "Idempotency-Key": "p" })).json();
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => {
    const credential = provider.credential(probe.challenges[0].id, { action: "voucher", channelId, cumulative: 5_000_000 });
    return post(base, `/api/v1/mpp/sessions/${id}/tools/oman_supplier_check`, supplier.example, { "Idempotency-Key": `par-${i}`, Authorization: credential });
  }));
  const statuses = results.map(r => r.status).sort();
  assert.equal(statuses.filter(s => s === 200).length, 2);
  for (const r of results.filter(r => r.status !== 200)) {
    assert.equal(r.status, 402);
    assert.ok(["MPP_SESSION_BUDGET_EXCEEDED", "MPP_SESSION_EXHAUSTED"].includes((await r.json()).error.code));
  }
  const view = (await (await fetch(base + `/api/v1/mpp/sessions/${id}`)).json()).data;
  assert.equal(view.spent, 1);
  assert.equal(view.remaining, 0);
  assert.equal(view.calls, 2);
  assert.equal(provider.channels.get(channelId)!.spent, 1_000_000);
});

test("MPP session: Idempotency-Key — retries are never double-charged, conflicts are refused, the key is required", async t => {
  const { agent, base, provider } = await startSessionApp(t);
  const { opened, channelId } = await agent.open({ maxBudget: 5, allowedTools: ["oman_supplier_check", "analyze_property"] });
  const id = (await opened.json()).data.sessionId;
  const first = await agent.call(id, "oman_supplier_check", supplier.example, "same-key");
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  const retry = await post(base, `/api/v1/mpp/sessions/${id}/tools/oman_supplier_check`, supplier.example, { "Idempotency-Key": "same-key" });
  assert.equal(retry.status, 200);
  assert.equal(retry.headers.get("idempotent-replay"), "true");
  const retryBody = await retry.json();
  assert.deepEqual(retryBody.data, firstBody.data);
  assert.equal(retryBody.usage.charge, 0);
  assert.equal(retryBody.usage.idempotentReplay, true);
  assert.equal(retryBody.usage.spent, 0.5);
  assert.equal(provider.channels.get(channelId)!.spent, 500_000);

  const conflict = await post(base, `/api/v1/mpp/sessions/${id}/tools/analyze_property`, analyzeProperty.example, { "Idempotency-Key": "same-key" });
  assert.equal(conflict.status, 422);
  assert.equal((await conflict.json()).error.code, "MPP_IDEMPOTENCY_CONFLICT");
  const missing = await post(base, `/api/v1/mpp/sessions/${id}/tools/analyze_property`, analyzeProperty.example);
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, "MPP_IDEMPOTENCY_KEY_REQUIRED");
  const view = (await (await fetch(base + `/api/v1/mpp/sessions/${id}`)).json()).data;
  assert.equal(view.calls, 1);
  assert.equal(view.spent, 0.5);
});

test("MPP session: vouchers are bound to the session's channel — a voucher from another channel, or one that is too small, is rejected and not charged", async t => {
  const { agent, base, provider } = await startSessionApp(t);
  const a = await agent.open({ maxBudget: 5, allowedTools: ["analyze_property"] });
  const b = await agent.open({ maxBudget: 5, allowedTools: ["analyze_property"] });
  const idA = (await a.opened.json()).data.sessionId;
  const probe = await (await post(base, `/api/v1/mpp/sessions/${idA}/tools/analyze_property`, analyzeProperty.example, { "Idempotency-Key": "x" })).json();
  const foreign = provider.credential(probe.challenges[0].id, { action: "voucher", channelId: b.channelId, cumulative: 10_000 });
  const r1 = await post(base, `/api/v1/mpp/sessions/${idA}/tools/analyze_property`, analyzeProperty.example, { "Idempotency-Key": "x", Authorization: foreign });
  assert.equal(r1.status, 402);
  assert.equal((await r1.json()).error.code, "MPP_INVALID_PAYMENT");
  // A voucher that authorizes nothing new: the tool may run, but the result is withheld and nothing is charged.
  const tooSmall = provider.credential(probe.challenges[0].id, { action: "voucher", channelId: a.channelId, cumulative: 0 });
  const r2 = await post(base, `/api/v1/mpp/sessions/${idA}/tools/analyze_property`, analyzeProperty.example, { "Idempotency-Key": "y", Authorization: tooSmall });
  assert.equal(r2.status, 402);
  assert.equal((await r2.json()).data, undefined);
  const view = (await (await fetch(base + `/api/v1/mpp/sessions/${idA}`)).json()).data;
  assert.equal(view.spent, 0);
  assert.equal(view.reserved, 0);
  assert.equal(provider.channels.get(a.channelId)!.spent, 0);
  // Forged / unknown session ids.
  assert.equal((await fetch(base + "/api/v1/mpp/sessions/mpp_" + "0".repeat(32))).status, 404);
  assert.equal((await agent.call("mpp_" + "0".repeat(32), "analyze_property", analyzeProperty.example, "z")).status, 404);
});

test("MPP session: expired sessions reject calls (410) and closed sessions reject calls (409); close is idempotent, settles the metered spend once", async t => {
  let now = Date.now();
  const { agent, base, provider, revenueLedger, audit } = await startSessionApp(t, { now: () => new Date(now), env: { MPP_SESSION_TTL_SECONDS: "60" } });
  const { opened, channelId } = await agent.open({ maxBudget: 5, allowedTools: ["analyze_property", "oman_supplier_check"] });
  const id = (await opened.json()).data.sessionId;
  assert.equal((await agent.call(id, "oman_supplier_check", supplier.example, "k1")).status, 200);

  // Close: stops calls, finalizes metering, settles exactly the metered spend.
  const closed = await post(base, `/api/v1/mpp/sessions/${id}/close`, {});
  assert.equal(closed.status, 200);
  const c = (await closed.json()).data;
  assert.equal(c.status, "closed");
  assert.equal(c.spent, 0.5);
  assert.equal(c.settlement.status, "settled");
  assert.equal(c.settlement.settled, 0.5);
  assert.equal(provider.channels.get(channelId)!.settled, 500_000);
  const again = await post(base, `/api/v1/mpp/sessions/${id}/close`, {});
  assert.equal(again.status, 200);
  assert.equal((await again.json()).idempotentReplay, true);
  assert.equal(provider.settlements, 1); // no duplicate settlement
  const afterClose = await agent.call(id, "analyze_property", analyzeProperty.example, "k2");
  assert.equal(afterClose.status, 409);
  assert.equal((await afterClose.json()).error.code, "MPP_SESSION_CLOSED");
  await new Promise(r => setTimeout(r, 20));
  const rows = await revenueLedger.query({ since: null });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.toolName, MPP_SESSION_LEDGER_TOOL);
  assert.equal(rows[0]!.amountDecimal, 0.5);
  assert.deepEqual(buildReconciliation({ settlements: rows, x402ToolExecutionCounts: {}, catalogPriceByTool: { ...prices } }), []);

  // Expiry.
  const second = await agent.open({ maxBudget: 5, allowedTools: ["analyze_property"] });
  const id2 = (await second.opened.json()).data.sessionId;
  now += 61_000;
  const expired = await agent.call(id2, "analyze_property", analyzeProperty.example, "k3");
  assert.equal(expired.status, 410);
  assert.equal((await expired.json()).error.code, "MPP_SESSION_EXPIRED");
  assert.equal((await (await fetch(base + `/api/v1/mpp/sessions/${id2}`)).json()).data.status, "expired");
  const closeExpired = await post(base, `/api/v1/mpp/sessions/${id2}/close`, {});
  assert.equal(closeExpired.status, 200);
  assert.equal((await closeExpired.json()).data.settlement.status, "nothing_to_settle");
  for (const e of ["mpp.session.pending", "mpp.session.activated", "mpp.session.call", "mpp.session.usage_recorded", "mpp.session.closed", "mpp.session.settlement_pending", "mpp.session.settled", "mpp.session.expired"]) assert.ok(audit.some(a => a.event === e), e);
});

test("MPP session: a payer close credential captures exactly the metered spend; unconsumed voucher headroom is never settled by the server", async t => {
  const { agent, base, provider } = await startSessionApp(t);
  const { opened, channelId } = await agent.open({ maxBudget: 5, allowedTools: ["oman_supplier_check"] });
  const id = (await opened.json()).data.sessionId;
  // Over-authorize: the voucher says $3 but only one $0.50 call is metered.
  assert.equal((await agent.call(id, "oman_supplier_check", supplier.example, "k", { cumulative: 3_000_000 })).status, 200);
  const noCredential = await (await post(base, `/api/v1/mpp/sessions/${id}/close`, {})).json();
  assert.equal(noCredential.data.settlement.status, "pending_payer_close"); // server settle would capture $3 — refused
  assert.equal(provider.channels.get(channelId)!.settled, 0);
  const challengeId = [...provider.challenges.values()].filter(c => c.kind === "voucher").at(-1)!.id;
  const closeCredential = provider.credential(challengeId, { action: "close", channelId, cumulative: 3_000_000 });
  const closed = await (await post(base, `/api/v1/mpp/sessions/${id}/close`, {}, { Authorization: closeCredential })).json();
  assert.equal(closed.data.settlement.status, "settled");
  assert.equal(closed.data.settlement.settled, 0.5);
  assert.equal(provider.channels.get(channelId)!.settled, 500_000);
});

test("MPP session: a tool failure after authorization is not charged and releases the reservation (service level)", async () => {
  const config = loadConfig({ ...mppEnv, MPP_MODES: "session" });
  const provider = new FakeChannelProvider();
  const sessions = new MemoryMppSessionRepository();
  let executions = 0;
  const flaky = { name: "analyze_property", input: z.object({ x: z.number() }).strict(), execute: async () => { executions++; throw new Error("upstream down"); } };
  const ledger = new MemoryRevenueLedger();
  const service = new MppService({
    config: config.mpp, provider, sessions, redemptions: new MemoryMppChargeRedemptionStore(),
    getTool: n => n === "analyze_property" ? flaky : undefined, priceUsd: () => 0.5, audit: () => {}, recordSettlement: r => ledger.record(r)
  });
  const body = { maxBudget: 2, allowedTools: ["analyze_property"] };
  const pending = await service.createSession({ body, authorization: undefined, url: "https://x/y", requestId: "r1" });
  const challengeId = (pending.body.challenges as { id: string }[])[0]!.id;
  const channelId = "0x" + "ee".repeat(32);
  const opened = await service.createSession({ body, authorization: provider.credential(challengeId, { action: "open", channelId, deposit: 2_000_000 }), url: "https://x/y", requestId: "r2" });
  const id = (opened.body.data as { sessionId: string }).sessionId;
  const probe = await service.callTool({ sessionId: id, tool: "analyze_property", body: { x: 1 }, authorization: undefined, idempotencyKey: "i1", url: "https://x", requestId: "r3" });
  const voucherChallenge = (probe.body.challenges as { id: string }[])[0]!.id;
  const res = await service.callTool({ sessionId: id, tool: "analyze_property", body: { x: 1 }, authorization: provider.credential(voucherChallenge, { action: "voucher", channelId, cumulative: 500_000 }), idempotencyKey: "i1", url: "https://x", requestId: "r4" });
  assert.equal(res.status, 500);
  assert.equal(executions, 1);
  const s = (await sessions.get(id))!;
  assert.equal(s.spentMicros, 0);
  assert.equal(s.reservedMicros, 0);
  assert.equal(provider.channels.get(channelId)!.spent, 0);
  assert.equal((await sessions.events(id))[0]!.status, "failed");
  // Budget refusal happens before execution.
  executions = 0;
  const big = await service.callTool({ sessionId: id, tool: "analyze_property", body: { x: 1 }, authorization: undefined, idempotencyKey: "i2", url: "https://x", requestId: "r5" });
  assert.equal(big.status, 402);
  assert.equal(executions, 0);
});

test("MPP audit log drops anything that looks like a credential or signature", () => {
  const out: Record<string, unknown>[] = [];
  mppAudit(e => out.push(e), "mpp.payment.failed", { reason: "Payment eyJhbGciOi...", reference: "0x" + "ab".repeat(65), tool: "analyze_property", channelId: "0x" + "cd".repeat(32) });
  assert.equal(out[0]!.reason, undefined);
  assert.equal(out[0]!.reference, undefined);
  assert.equal(out[0]!.tool, "analyze_property");
  assert.equal(out[0]!.channelId, "0x" + "cd".repeat(32));
});

// ===============================================================================================
// PostgreSQL persistence (runs when MPP_TEST_DATABASE_URL points at a disposable database)
// ===============================================================================================

const pgUrl = process.env.MPP_TEST_DATABASE_URL;

test("MPP Postgres: schema, atomic budget reservation under concurrency, idempotency unique key, commit/release", { skip: !pgUrl && "set MPP_TEST_DATABASE_URL to run" }, async t => {
  const pool = new Pool({ connectionString: pgUrl, max: 20 });
  t.after(() => pool.end());
  const repo = new PostgresMppSessionRepository(pool);
  const s = await repo.createPending({ requestedBudgetMicros: 1_500_000, maxBudgetMicros: 1_500_000, allowedTools: ["oman_supplier_check"], paymentProvider: "test", paymentMethod: "tempo/session", termsDigest: "d", expiresAt: new Date(Date.now() + 60_000).toISOString(), metadata: {} });
  const channel = "0x" + randomBytes(32).toString("hex");
  const active = await repo.activate(s.id, { externalSessionId: channel, maxBudgetMicros: 1_500_000, authorizationReference: null, expiresAt: new Date(Date.now() + 60_000).toISOString() }, new Date());
  assert.equal(active?.status, "active");
  // A second session can never bind the same channel.
  const s2 = await repo.createPending({ requestedBudgetMicros: 1_000_000, maxBudgetMicros: 1_000_000, allowedTools: ["oman_supplier_check"], paymentProvider: "test", paymentMethod: "tempo/session", termsDigest: "d", expiresAt: new Date(Date.now() + 60_000).toISOString(), metadata: {} });
  assert.equal(await repo.activate(s2.id, { externalSessionId: channel, maxBudgetMicros: 1_000_000, authorizationReference: null, expiresAt: new Date(Date.now() + 60_000).toISOString() }, new Date()), null);

  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => repo.reserve({ sessionId: s.id, toolName: "oman_supplier_check", amountMicros: 500_000, idempotencyKey: `k${i}`, requestHash: "h", now: new Date() })));
  const won = results.filter(r => r.ok);
  assert.equal(won.length, 3);
  assert.ok(results.filter(r => !r.ok).every(r => !r.ok && r.reason === "budget"));
  const dup = await repo.reserve({ sessionId: s.id, toolName: "oman_supplier_check", amountMicros: 500_000, idempotencyKey: "k0", requestHash: "h", now: new Date() });
  assert.equal(dup.ok, false);
  for (const r of won.slice(0, 2)) if (r.ok) await repo.commit(r.event.id, { response: { ok: true }, cheapestAllowedMicros: 500_000 });
  const last = won[2]!;
  if (last.ok) await repo.release(last.event.id, "failed");
  const after = (await repo.get(s.id))!;
  assert.equal(after.spentMicros, 1_000_000);
  assert.equal(after.reservedMicros, 0);
  assert.equal(after.calls, 2);
  assert.equal(after.status, "active");
  assert.deepEqual(await repo.usageByTool(s.id), { oman_supplier_check: { calls: 2, spent: 1 } });
  // The DB-level invariant holds even against a buggy writer.
  await assert.rejects(pool.query("UPDATE mpp_sessions SET spent_micros = max_budget_micros + 1 WHERE id = $1", [s.id]));
  const closed = await repo.close(s.id, new Date());
  assert.equal(closed.ok, true);
  assert.equal((await repo.close(s.id, new Date())).ok && (await repo.close(s.id, new Date()) as { alreadyClosed: boolean }).alreadyClosed, true);
});

test("MPP Postgres: the mppx AtomicStore adapter is linearizable across concurrent read-modify-writes", { skip: !pgUrl && "set MPP_TEST_DATABASE_URL to run" }, async t => {
  const pool = new Pool({ connectionString: pgUrl, max: 20 });
  t.after(() => pool.end());
  const store = toMppxStore(new PostgresMppKv(pool), `test:${randomUUID()}:`);
  await Promise.all(Array.from({ length: 25 }, () => store.update("counter", (current: unknown) => {
    const n = typeof current === "number" ? current : 0;
    return { op: "set", value: n + 1, result: n + 1 } as Store.Change<unknown, number>;
  })));
  assert.equal(await store.get("counter"), 25);
  assert.equal(await Store.tryClaim(store, "replay", Date.now() + 60_000), true);
  assert.equal(await Store.tryClaim(store, "replay", Date.now() + 60_000), false);
});

// ===============================================================================================
// MCP — the MPP MCP transport binding, driven by the official mppx McpClient
// ===============================================================================================

test("MPP over MCP (MPP_MCP_ENABLED): mppx McpClient pays a tools/call on /mcp/mpp; /mcp stays free and unchanged", async t => {
  const { McpClient } = await import("mppx/mcp/client");
  const { base, facilitator } = await realChargeApp(t, { MPP_MCP_ENABLED: "true" });
  const rpc = async (path: string, method: string, params: unknown, id = 1) => {
    const r = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    return r.json();
  };
  // Discovery is delegated verbatim to the standard MCP server.
  const list = await rpc("/mcp/mpp", "tools/list", {});
  // Free Preview (src/preview/) adds one extra generic "preview_capability" tool to every MCP
  // transport (src/mcp/server.ts), including this MPP-over-MCP one — discovery here is
  // delegated verbatim to the standard MCP server, so the count grows by exactly one.
  assert.equal(list.result.tools.length, capabilities.length + 1);
  // Unpaid tools/call → JSON-RPC -32042 with real MPP challenges.
  const unpaid = await rpc("/mcp/mpp", "tools/call", { name: "analyze_property", arguments: analyzeProperty.example });
  assert.equal(unpaid.error.code, -32042);
  assert.equal(unpaid.error.data.httpStatus, 402);
  assert.ok(unpaid.error.data.challenges.length >= 1);

  // A minimal MCP client (JSON-RPC over HTTP) wrapped by the official mppx McpClient.
  const raw = {
    async callTool(params: { name: string; arguments?: unknown; _meta?: unknown }) {
      const body = await rpc("/mcp/mpp", "tools/call", params, 2);
      if (body.error) throw Object.assign(new Error(body.error.message), { code: body.error.code, data: body.error.data });
      return body.result;
    }
  };
  const client = McpClient.wrap(raw as never, { methods: [evmClient.charge({ account: privateKeyToAccount(generatePrivateKey()), currencies: [Assets.baseSepolia.USDC] })] as never });
  const paid = await (client as unknown as { callTool: (p: unknown) => Promise<{ structuredContent: unknown; receipt?: { reference?: string; method?: string } }> }).callTool({ name: "analyze_property", arguments: analyzeProperty.example });
  assert.ok(paid.structuredContent);
  assert.equal(paid.receipt?.method, "evm");
  assert.ok(paid.receipt?.reference);
  assert.equal(facilitator.settles, 1);

  // The free /mcp endpoint is untouched: no payment required there.
  const free = await rpc("/mcp", "tools/call", { name: "analyze_property", arguments: analyzeProperty.example });
  assert.ok(free.result.structuredContent);
});

test("MPP over MCP is not mounted unless MPP_MCP_ENABLED=true", async t => {
  const { base } = await realChargeApp(t);
  const r = await fetch(base + "/mcp/mpp", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal(r.status, 404);
});

test("MPP Postgres end to end: parallel HTTP session calls against PostgreSQL never exceed the budget; idempotent replay survives", { skip: !pgUrl && "set MPP_TEST_DATABASE_URL to run" }, async t => {
  const pool = new Pool({ connectionString: pgUrl, max: 20 });
  t.after(() => pool.end());
  const { agent, provider, base } = await startSessionApp(t, { sessions: new PostgresMppSessionRepository(pool) });
  const { opened, channelId } = await agent.open({ maxBudget: 1.5, allowedTools: ["oman_supplier_check"] }, 10);
  const id = (await opened.json()).data.sessionId;
  const probe = await (await post(base, `/api/v1/mpp/sessions/${id}/tools/oman_supplier_check`, supplier.example, { "Idempotency-Key": "p" })).json();
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => post(base, `/api/v1/mpp/sessions/${id}/tools/oman_supplier_check`, supplier.example, {
    "Idempotency-Key": `pg-${i}`, Authorization: provider.credential(probe.challenges[0].id, { action: "voucher", channelId, cumulative: 10_000_000 })
  })));
  assert.equal(results.filter(r => r.status === 200).length, 3);
  const view = (await (await fetch(base + `/api/v1/mpp/sessions/${id}`)).json()).data;
  assert.equal(view.spent, 1.5);
  assert.equal(view.calls, 3);
  assert.equal(view.status, "exhausted");
  const replay = await post(base, `/api/v1/mpp/sessions/${id}/tools/oman_supplier_check`, supplier.example, { "Idempotency-Key": "pg-0" });
  const firstOk = results.findIndex(r => r.status === 200);
  if (firstOk === 0) assert.equal(replay.status, 200);
  assert.equal(provider.channels.get(channelId)!.spent, 1_500_000);
  const closed = await (await post(base, `/api/v1/mpp/sessions/${id}/close`, {})).json();
  assert.equal(closed.data.settlement.status, "pending_payer_close"); // vouchers over-authorized ($10) → server won't over-capture
});

test("MPP charge: the official mppx fetch wrapper pays a Rafid 402 automatically (the flow examples/mpp-client uses)", async t => {
  const { base, facilitator } = await realChargeApp(t, { MPP_CHARGE_METHODS: "evm" });
  const client = MppxClient.create({ polyfill: false, methods: [evmClient.charge({ account: privateKeyToAccount(generatePrivateKey()), currencies: [Assets.baseSepolia.USDC] })] as never });
  const res = await client.fetch(base + "/api/v1/mpp/charge/compare_properties", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(tool("compare_properties").example) });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.payment.amount, 0.03);
  assert.equal(body.meta.tool, "compare_properties");
  assert.equal(facilitator.settles, 1);
});

// ===============================================================================================
// Production hardening: pending cleanup, abuse limits, settlement reconciliation, status
// ===============================================================================================

function sessionService(opts: { env?: Record<string, string>; now?: () => Date; sessions?: MppSessionRepository; provider?: FakeChannelProvider } = {}) {
  const config = loadConfig({ ...mppEnv, MPP_MODES: "session", ...(opts.env ?? {}) });
  const provider = opts.provider ?? new FakeChannelProvider();
  const sessions = opts.sessions ?? new MemoryMppSessionRepository();
  const audit: Record<string, unknown>[] = [];
  const ledger: unknown[] = [];
  const executions: string[] = [];
  const service = new MppService({
    config: config.mpp, provider, sessions, redemptions: new MemoryMppChargeRedemptionStore(),
    getTool: n => { const c = capabilities.find(x => x.name === n); return c ? { ...c, execute: async (i: unknown) => { executions.push(n); return c.execute(i as never); } } as never : undefined; },
    priceUsd: n => prices[n as keyof typeof prices] ?? 0, audit: e => audit.push(e), recordSettlement: r => ledger.push(r), now: opts.now
  });
  const url = "https://api.test/api/v1/mpp/sessions";
  async function pending(body: { maxBudget: number; allowedTools: string[] }, clientKey: string | null = null) {
    const r = await service.createSession({ body, authorization: undefined, url, requestId: "p", clientKey });
    return { r, id: (r.body.sessionId as string), challengeId: (r.body.challenges as { id: string }[] | undefined)?.[0]?.id };
  }
  async function open(body: { maxBudget: number; allowedTools: string[] }) {
    const p = await pending(body);
    const channelId = "0x" + randomBytes(32).toString("hex");
    const opened = await service.createSession({ body, authorization: provider.credential(p.challengeId!, { action: "open", channelId, deposit: usdToMicros(body.maxBudget) }), url, requestId: "o" });
    return { id: p.id, channelId, opened };
  }
  async function pay(id: string, name: string, input: unknown, idem: string) {
    const probe = await service.callTool({ sessionId: id, tool: name, body: input, authorization: undefined, idempotencyKey: idem, url: "https://x", requestId: "c" });
    if (probe.status !== 402 || !probe.body.challenges) return probe;
    const c = (probe.body.challenges as { id: string; request: { channelId: string; amount: string } }[])[0]!;
    const ch = provider.channels.get(c.request.channelId)!;
    return service.callTool({ sessionId: id, tool: name, body: input, authorization: provider.credential(c.id, { action: "voucher", channelId: c.request.channelId, cumulative: ch.spent + Number(c.request.amount) }), idempotencyKey: idem, url: "https://x", requestId: "c" });
  }
  const close = (id: string, authorization?: string) => service.closeSession({ sessionId: id, authorization, requestId: "x" });
  return { config, provider, sessions, service, audit, ledger, executions, pending, open, pay, close };
}

test("MPP cleanup: overdue pending sessions expire in a batch, idempotently, and can never be activated afterwards; active sessions are untouched", async () => {
  let now = Date.now();
  const f = sessionService({ now: () => new Date(now) });
  const p1 = await f.pending({ maxBudget: 2, allowedTools: ["analyze_property"] });
  const p2 = await f.pending({ maxBudget: 2, allowedTools: ["analyze_property"] });
  const live = await f.open({ maxBudget: 2, allowedTools: ["analyze_property"] });
  assert.equal(live.opened.status, 201);
  // Pending expiry = challenge TTL + grace (300 + 60 s by default).
  assert.equal(Date.parse((await f.sessions.get(p1.id))!.expiresAt) - now, (f.config.mpp.challengeTtlSeconds + f.config.mpp.pendingGraceSeconds) * 1000);
  assert.deepEqual(await f.service.expirePendingSessions(), []); // nothing overdue yet
  now += (f.config.mpp.challengeTtlSeconds + f.config.mpp.pendingGraceSeconds + 1) * 1000;
  const expired = await f.service.expirePendingSessions();
  assert.deepEqual(expired.sort(), [p1.id, p2.id].sort());
  assert.deepEqual(await f.service.expirePendingSessions(), []); // idempotent
  assert.equal((await f.sessions.get(p1.id))!.status, "expired");
  assert.equal((await f.sessions.get(live.id))!.status, "active"); // active channel untouched
  assert.equal(f.audit.filter(a => a.event === "mpp.session.expired").length, 2);
  // The open credential for the expired session is refused BEFORE any channel is opened.
  const channelId = "0x" + randomBytes(32).toString("hex");
  const late = await f.service.createSession({ body: { maxBudget: 2, allowedTools: ["analyze_property"] }, authorization: f.provider.credential(p1.challengeId!, { action: "open", channelId, deposit: 2_000_000 }), url: "https://x", requestId: "l" });
  assert.equal(late.status, 409);
  assert.equal(f.provider.channels.has(channelId), false);
  assert.equal((await f.sessions.get(p1.id))!.status, "expired");
  // The repository refuses activation of an expired pending row outright.
  assert.equal(await f.sessions.activate(p2.id, { externalSessionId: channelId, maxBudgetMicros: 1, authorizationReference: null, expiresAt: new Date(now + 60_000).toISOString() }, new Date(now)), null);
  // The live session still works.
  assert.equal((await f.pay(live.id, "analyze_property", analyzeProperty.example, "k1")).status, 200);
});

test("MPP cleanup: a channel that opens after its pending session expired is never activated — the session is marked failed with the orphan channel recorded", async () => {
  let now = Date.now();
  const provider = new FakeChannelProvider();
  const f = sessionService({ now: () => new Date(now), provider });
  const p = await f.pending({ maxBudget: 2, allowedTools: ["analyze_property"] });
  const verify = provider.verifySession.bind(provider);
  provider.verifySession = async (a, t) => { const r = await verify(a, t); now += 3600_000; return r; }; // expiry passes mid-open
  const channelId = "0x" + randomBytes(32).toString("hex");
  const r = await f.service.createSession({ body: { maxBudget: 2, allowedTools: ["analyze_property"] }, authorization: provider.credential(p.challengeId!, { action: "open", channelId, deposit: 2_000_000 }), url: "https://x", requestId: "r" });
  assert.equal(r.status, 410);
  assert.equal((r.body.error as { code: string }).code, "MPP_SESSION_EXPIRED");
  assert.equal(r.body.channelId, channelId);
  const s = (await f.sessions.get(p.id))!;
  assert.equal(s.status, "failed");
  assert.equal(s.externalSessionId, null);
  assert.equal(s.metadata.orphanChannelId, channelId);
  assert.equal((await f.pay(p.id, "analyze_property", analyzeProperty.example, "k")).status, 409);
});

test("MPP maintenance endpoint: 503 without a secret, 401 on a missing/wrong bearer, 200 with CRON_SECRET or MPP_MAINTENANCE_SECRET; expires overdue pending sessions", async t => {
  const none = await startSessionApp(t);
  assert.equal((await fetch(none.base + "/api/v1/mpp/internal/maintenance")).status, 503);
  let now = Date.now();
  const secret = "cron-" + randomBytes(16).toString("hex");
  const app = await startSessionApp(t, { now: () => new Date(now), env: { CRON_SECRET: secret } });
  const pending = await post(app.base, "/api/v1/mpp/sessions", { maxBudget: 2, allowedTools: ["analyze_property"] });
  const sessionId = (await pending.json()).sessionId;
  assert.equal((await fetch(app.base + "/api/v1/mpp/internal/maintenance")).status, 401);
  assert.equal((await fetch(app.base + "/api/v1/mpp/internal/maintenance", { headers: { Authorization: "Bearer wrong-" + secret } })).status, 401);
  now += 3600_000;
  const ok = await fetch(app.base + "/api/v1/mpp/internal/maintenance", { headers: { Authorization: `Bearer ${secret}` } });
  assert.equal(ok.status, 200);
  const summary = (await ok.json()).data;
  assert.equal(summary.expiredPending, 1);
  assert.equal((await app.sessions.get(sessionId))!.status, "expired");
  const again = await (await fetch(app.base + "/api/v1/mpp/internal/maintenance", { headers: { Authorization: `Bearer ${secret}` } })).json();
  assert.equal(again.data.expiredPending, 0);
  assert.ok(app.audit.some(a => a.event === "mpp.maintenance.run"));
  // The maintenance route is internal: not in OpenAPI.
  assert.ok(!JSON.stringify(buildOpenapi()).includes("internal/maintenance"));
  // MPP_MAINTENANCE_SECRET takes precedence; a too-short secret fails config.
  assert.throws(() => loadConfig({ ...mppEnv, MPP_MAINTENANCE_SECRET: "short" }));
});

test("MPP abuse: per-client pending-session cap (hashed IP, never a wallet) and the session-create rate limit", async t => {
  let now = Date.now();
  const app = await startSessionApp(t, { now: () => new Date(now), env: { MPP_MAX_PENDING_SESSIONS_PER_CLIENT: "2" } });
  const body = { maxBudget: 2, allowedTools: ["analyze_property"] };
  const as = (ip: string) => post(app.base, "/api/v1/mpp/sessions", body, { "X-Forwarded-For": ip });
  assert.equal((await as("198.51.100.7")).status, 402);
  assert.equal((await as("198.51.100.7")).status, 402);
  const capped = await as("198.51.100.7");
  assert.equal(capped.status, 429);
  assert.equal((await capped.json()).error.code, "MPP_TOO_MANY_PENDING_SESSIONS");
  assert.ok(capped.headers.get("retry-after"));
  assert.equal((await as("198.51.100.8")).status, 402); // another client has its own cap
  // The stored client key is an HMAC, not the IP.
  const stored = [...(app.sessions as unknown as { sessions: Map<string, { clientKey: string | null }> }).sessions.values()].map(s => s.clientKey);
  assert.ok(stored.every(k => k && /^[0-9a-f]{32}$/.test(k) && !k.includes("198")));
  now += 3600_000; // pending sessions expired → the cap frees up
  assert.equal((await as("198.51.100.7")).status, 402);
  assert.ok(app.audit.some(a => a.event === "mpp.session.pending_rejected"));

  const limited = await startSessionApp(t, { env: { RATE_LIMIT_ENABLED: "true", MPP_SESSION_CREATE_RATE_LIMIT_MAX: "3", MPP_MAX_PENDING_SESSIONS_PER_CLIENT: "100" } });
  const statuses: number[] = [];
  for (let i = 0; i < 4; i++) statuses.push((await post(limited.base, "/api/v1/mpp/sessions", body, { "X-Forwarded-For": "203.0.113.9" })).status);
  assert.deepEqual(statuses, [402, 402, 402, 429]);
  assert.equal((await post(limited.base, "/api/v1/mpp/sessions", body, { "X-Forwarded-For": "203.0.113.10" })).status, 402);
});

test("MPP settlement: concurrent closes settle exactly once and write one ledger row", async () => {
  const f = sessionService();
  const s = await f.open({ maxBudget: 5, allowedTools: ["oman_supplier_check"] });
  assert.equal((await f.pay(s.id, "oman_supplier_check", supplier.example, "k1")).status, 200);
  const results = await Promise.all(Array.from({ length: 10 }, () => f.close(s.id)));
  assert.ok(results.every(r => r.status === 200));
  assert.equal(f.provider.settlements, 1);
  assert.equal(f.ledger.length, 1);
  const final = (await f.sessions.get(s.id))!;
  assert.equal(final.settlementStatus, "settled");
  assert.equal(final.settledMicros, 500_000);
  assert.equal(final.settlementAttempts, 1);
  // Reconciliation finds nothing to do.
  assert.deepEqual(await f.service.reconcileSettlements(), { checked: 0, settled: 0, pendingPayerClose: 0, failed: 0, unknown: 0, skipped: 0 });
});

test("MPP settlement: an unknown outcome stays pending (never reported as settled); the reconciler reads the chain before resubmitting", async () => {
  let now = Date.now();
  const f = sessionService({ now: () => new Date(now) });
  // Case 1: the settle tx never landed → reconciler settles it after the lease expires.
  const a = await f.open({ maxBudget: 5, allowedTools: ["oman_supplier_check"] });
  await f.pay(a.id, "oman_supplier_check", supplier.example, "k");
  f.provider.failNextSettle = new MppPaymentFailure("unavailable", "rpc-timeout");
  const r = await f.close(a.id);
  assert.equal(r.status, 502);
  assert.equal((r.body.error as { code: string }).code, "MPP_SETTLEMENT_UNCONFIRMED");
  assert.equal((await f.sessions.get(a.id))!.settlementStatus, "pending");
  assert.equal(f.ledger.length, 0);
  assert.deepEqual((await f.service.reconcileSettlements()).checked, 0); // lease still held
  now += (f.config.mpp.settlementLeaseSeconds + 1) * 1000;
  const rec = await f.service.reconcileSettlements();
  assert.equal(rec.settled, 1);
  assert.equal((await f.sessions.get(a.id))!.settlementStatus, "settled");
  assert.equal(f.provider.channels.get(a.channelId)!.settled, 500_000);
  assert.equal(f.ledger.length, 1);

  // Case 2: the settle tx DID land before the error → reconciler records it without resubmitting.
  const b = await f.open({ maxBudget: 5, allowedTools: ["oman_supplier_check"] });
  await f.pay(b.id, "oman_supplier_check", supplier.example, "k");
  f.provider.failNextSettle = new MppPaymentFailure("unavailable", "rpc-timeout");
  await f.close(b.id);
  f.provider.channels.get(b.channelId)!.settled = 500_000; // what the chain shows
  const before = f.provider.settlements;
  now += (f.config.mpp.settlementLeaseSeconds + 1) * 1000;
  assert.equal((await f.service.reconcileSettlements()).settled, 1);
  assert.equal(f.provider.settlements, before); // nothing resubmitted
  assert.equal((await f.sessions.get(b.id))!.settlementStatus, "settled");
  assert.ok(f.audit.some(e => e.event === "mpp.session.settlement_pending"));
});

test("MPP settlement: a definitive failure is recorded as failed and retried by the reconciler; payer close with a rejected credential gets a fresh 402", async () => {
  const f = sessionService();
  const s = await f.open({ maxBudget: 5, allowedTools: ["oman_supplier_check"] });
  await f.pay(s.id, "oman_supplier_check", supplier.example, "k");
  f.provider.failNextSettle = new MppPaymentFailure("invalid", "settle-reverted");
  const r = await f.close(s.id);
  assert.equal(r.status, 200);
  const failed = (await f.sessions.get(s.id))!;
  assert.equal(failed.settlementStatus, "failed");
  assert.equal(failed.settlementError, "settle-reverted");
  assert.ok(f.audit.some(e => e.event === "mpp.session.settlement_failed"));
  assert.equal((await f.service.reconcileSettlements()).settled, 1);
  assert.equal((await f.sessions.get(s.id))!.settlementStatus, "settled");

  // Payer close: an invalid close credential → 402 with a fresh challenge, state restored.
  const g = await f.open({ maxBudget: 5, allowedTools: ["oman_supplier_check"] });
  await f.pay(g.id, "oman_supplier_check", supplier.example, "k");
  const challengeId = [...f.provider.challenges.values()].filter(c => c.kind === "voucher").at(-1)!.id;
  f.provider.failNextClose = new MppPaymentFailure("payment_required", "challenge-expired");
  const rejected = await f.close(g.id, f.provider.credential(challengeId, { action: "close", channelId: g.channelId, cumulative: 500_000 }));
  assert.equal(rejected.status, 402);
  assert.ok((rejected.body.challenges as unknown[]).length > 0);
  assert.notEqual((await f.sessions.get(g.id))!.settlementStatus, "pending");
  const fresh = (rejected.body.challenges as { id: string }[])[0]!.id;
  const ok = await f.close(g.id, f.provider.credential(fresh, { action: "close", channelId: g.channelId, cumulative: 500_000 }));
  assert.equal(ok.status, 200);
  assert.ok(ok.headers.some(([k, v]) => k === "Payment-Receipt" && v.startsWith("receipt-close")));
  assert.equal((await f.sessions.get(g.id))!.settlementStatus, "settled");
  // A close credential for another channel is refused.
  const other = await f.close(s.id, f.provider.credential(fresh, { action: "close", channelId: g.channelId, cumulative: 1 }));
  assert.equal(other.status, 400);
});

test("MPP session management: a body-less close credential POSTed to a tool route (what mppx's sessionManager.close() does) closes and settles without running the tool; topUp is refused", async t => {
  const { agent, base, provider } = await startSessionApp(t);
  const { opened, channelId } = await agent.open({ maxBudget: 5, allowedTools: ["oman_supplier_check"] });
  const id = (await opened.json()).data.sessionId;
  assert.equal((await agent.call(id, "oman_supplier_check", supplier.example, "k1")).status, 200);
  const challengeId = [...provider.challenges.values()].filter(c => c.kind === "voucher").at(-1)!.id;
  const topUp = await fetch(base + `/api/v1/mpp/sessions/${id}/tools/oman_supplier_check`, { method: "POST", headers: { Authorization: provider.credential(challengeId, { action: "topUp", channelId }) } });
  assert.equal(topUp.status, 400);
  const res = await fetch(base + `/api/v1/mpp/sessions/${id}/tools/oman_supplier_check`, { method: "POST", headers: { Authorization: provider.credential(challengeId, { action: "close", channelId, cumulative: 500_000 }) } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("payment-receipt") ?? "", /^receipt-close/);
  const body = await res.json();
  assert.equal(body.data.status, "closed");
  assert.equal(body.data.calls, 1); // the tool did not run again
  assert.equal(body.data.settlement.status, "settled");
  assert.equal(provider.channels.get(channelId)!.finalized, true);
  // Same close credential via the create route (looked up by channel) is an idempotent no-op.
  const again = await fetch(base + "/api/v1/mpp/sessions", { method: "POST", headers: { Authorization: provider.credential(challengeId, { action: "close", channelId, cumulative: 500_000 }) } });
  assert.equal(again.status, 200);
  assert.equal(provider.settlements, 1);
});

test("MPP status: configured / provider reachable / database ready / charge / session / network — probe cached, no payment", async t => {
  const app = await startSessionApp(t);
  const s1 = (await (await fetch(app.base + "/api/v1/mpp/status")).json()).data;
  await fetch(app.base + "/api/v1/mpp/status");
  assert.equal(s1.configured, true);
  assert.equal(s1.provider.reachable, true);
  assert.equal(s1.database.ready, true);
  assert.equal(s1.charge.enabled, false);
  assert.equal(s1.session.enabled, true);
  assert.equal(s1.network.chainId, 42431);
  assert.equal(s1.network.testnet, true);
  assert.equal(app.provider.probes, 1); // cached
  assert.equal(app.provider.settlements, 0);
  assert.equal(app.provider.challenges.size, 0); // no challenge / payment created
  assert.ok(!JSON.stringify(s1).includes(mppEnv.MPP_SECRET_KEY));
  const off = createApp(loadConfig(baseEnv), { logger: () => {} });
  const offBase = await listen(t, off);
  const d = (await (await fetch(offBase + "/api/v1/mpp/status")).json()).data;
  assert.equal(d.configured, false);
});

test("MPP charge: an unknown settlement outcome keeps the credential claimed, withholds the result and is never reported as success", async () => {
  const config = loadConfig({ ...mppEnv, MPP_MODES: "charge" });
  const redemptions = new MemoryMppChargeRedemptionStore();
  let settles = 0, executions = 0;
  const provider = new FakeChannelProvider() as unknown as MppProvider;
  Object.assign(provider, {
    createCharge: async () => ({ headers: [], challenges: [{ id: "c1" }], problem: {}, wire: [] }),
    verifyCharge: async () => ({ challengeId: "chal-1", method: "tempo", intent: "charge", payer: null }),
    settleCharge: async () => { settles++; throw new MppPaymentFailure("unavailable", "rpc-timeout"); }
  });
  const audit: Record<string, unknown>[] = [];
  const service = new MppService({
    config: config.mpp, provider, sessions: new MemoryMppSessionRepository(), redemptions,
    getTool: () => ({ name: "analyze_property", input: z.object({}).passthrough(), execute: async () => { executions++; return { payload: "TOOL-OUTPUT-XYZ" }; } }),
    priceUsd: () => 0.01, audit: e => audit.push(e), recordSettlement: () => assert.fail("must not record revenue")
  });
  const r = await service.charge({ tool: "analyze_property", body: {}, authorization: "Payment abc", url: "https://x", requestId: "r" });
  assert.equal(r.status, 502);
  assert.equal((r.body.error as { code: string }).code, "MPP_SETTLEMENT_UNCONFIRMED");
  assert.ok(!JSON.stringify(r.body).includes("TOOL-OUTPUT-XYZ"));
  assert.equal(redemptions.claimed.get("chal-1"), "settlement_unknown");
  const replay = await service.charge({ tool: "analyze_property", body: {}, authorization: "Payment abc", url: "https://x", requestId: "r2" });
  assert.equal(replay.status, 402);
  assert.equal((replay.body.error as { code: string }).code, "MPP_PAYMENT_REPLAYED");
  assert.equal(executions, 1);
  assert.equal(settles, 1);
  assert.ok(audit.some(e => e.event === "mpp.charge.replay_rejected"));
});

test("MPP Postgres: DB-level constraints reject every invariant violation, even from a buggy writer", { skip: !pgUrl && "set MPP_TEST_DATABASE_URL to run" }, async t => {
  const pool = new Pool({ connectionString: pgUrl, max: 25 });
  t.after(() => pool.end());
  const repo = new PostgresMppSessionRepository(pool);
  const mk = (budget = 1_000_000, expiresInMs = 60_000, clientKey: string | null = null) => repo.createPending({ requestedBudgetMicros: budget, maxBudgetMicros: budget, allowedTools: ["analyze_property"], paymentProvider: "test", paymentMethod: "tempo/session", termsDigest: "d", expiresAt: new Date(Date.now() + expiresInMs).toISOString(), metadata: {}, clientKey });
  const s = await mk();
  const channel = "0x" + randomBytes(32).toString("hex");
  await repo.activate(s.id, { externalSessionId: channel, maxBudgetMicros: 1_000_000, authorizationReference: null, expiresAt: new Date(Date.now() + 60_000).toISOString() }, new Date());
  const violates = async (sql: string, params: unknown[], constraint: RegExp) => {
    await assert.rejects(pool.query(sql, params), (e: { message: string; constraint?: string }) => constraint.test(e.constraint ?? e.message));
  };
  await violates("UPDATE mpp_sessions SET spent_micros = max_budget_micros + 1 WHERE id = $1", [s.id], /budget|spent_within/);
  await violates("UPDATE mpp_sessions SET reserved_micros = max_budget_micros + 1 WHERE id = $1", [s.id], /remaining|budget_invariant/);
  await violates("UPDATE mpp_sessions SET spent_micros = -1 WHERE id = $1", [s.id], /spent_micros|check/);
  await violates("UPDATE mpp_sessions SET max_budget_micros = requested_budget_micros + 1 WHERE id = $1", [s.id], /budget_within_request/);
  await violates("UPDATE mpp_sessions SET calls = -1 WHERE id = $1", [s.id], /counters_nonnegative/);
  await violates("UPDATE mpp_sessions SET settlement_status = 'magic' WHERE id = $1", [s.id], /settlement_status/);
  await violates("UPDATE mpp_sessions SET external_session_id = NULL WHERE id = $1", [s.id], /channel_required/);
  // One channel can never back two sessions.
  const s2 = await mk();
  await violates("UPDATE mpp_sessions SET external_session_id = $2, status = 'active' WHERE id = $1", [s2.id, channel], /external_session_id/);
  // One usage event per (session, Idempotency-Key).
  const r1 = await repo.reserve({ sessionId: s.id, toolName: "analyze_property", amountMicros: 10_000, idempotencyKey: "idem", requestHash: "h", now: new Date() });
  assert.ok(r1.ok);
  await violates("INSERT INTO mpp_usage_events (id, session_id, tool_name, request_id, request_hash, amount_micros, status) VALUES ($1, $2, 'analyze_property', 'idem', 'h', 1, 'reserved')", [randomUUID(), s.id], /idempotency/);
  // Charge credentials: 20 concurrent claims of one challenge → exactly one wins; a redeemed or
  // settlement_unknown credential is never claimable again; unknown statuses are rejected.
  const { PostgresMppChargeRedemptionStore } = await import("../src/billing/mpp/sessions.js");
  const store = new PostgresMppChargeRedemptionStore(pool);
  const chal = "chal-" + randomUUID();
  const claims = await Promise.all(Array.from({ length: 20 }, () => store.claim(chal, "analyze_property")));
  assert.equal(claims.filter(Boolean).length, 1);
  await store.markRedeemed(chal, "0xref");
  assert.equal(await store.claim(chal, "analyze_property"), false);
  const unk = "chal-" + randomUUID();
  assert.equal(await store.claim(unk, "analyze_property"), true);
  await store.markSettlementUnknown(unk, "rpc-timeout");
  await store.release(unk); // release never frees an unknown-outcome claim
  assert.equal(await store.claim(unk, "analyze_property"), false);
  await violates("UPDATE mpp_charge_redemptions SET status = 'free' WHERE challenge_id = $1", [chal], /status_valid/);
});

test("MPP Postgres: pending expiry, settlement claims and purge are multi-instance safe", { skip: !pgUrl && "set MPP_TEST_DATABASE_URL to run" }, async t => {
  const pool = new Pool({ connectionString: pgUrl, max: 25 });
  t.after(() => pool.end());
  const repos = [new PostgresMppSessionRepository(pool), new PostgresMppSessionRepository(pool), new PostgresMppSessionRepository(pool)];
  const repo = repos[0]!;
  const client = "client-" + randomUUID();
  const mk = (expiresInMs: number) => repo.createPending({ requestedBudgetMicros: 1_000_000, maxBudgetMicros: 1_000_000, allowedTools: ["analyze_property"], paymentProvider: "test", paymentMethod: "tempo/session", termsDigest: "d", expiresAt: new Date(Date.now() + expiresInMs).toISOString(), metadata: {}, clientKey: client });
  const overdue = await Promise.all(Array.from({ length: 12 }, () => mk(-1000)));
  const fresh = await mk(60_000);
  assert.equal(await repo.countPendingForClient(client, new Date()), 1);
  // Three "instances" expire concurrently: every overdue row is expired exactly once.
  const runs = await Promise.all(repos.map(r => r.expirePending(new Date(), 1000)));
  const mine = runs.flat().filter(id => overdue.some(o => o.id === id));
  assert.equal(mine.length, 12);
  assert.equal(new Set(mine).size, 12);
  assert.equal((await repo.get(fresh.id))!.status, "pending");
  assert.equal(await repo.activate(overdue[0]!.id, { externalSessionId: "0x" + randomBytes(32).toString("hex"), maxBudgetMicros: 1, authorizationReference: null, expiresAt: new Date(Date.now() + 60_000).toISOString() }, new Date()), null);
  // Settlement claims: 10 concurrent claimers → one lease.
  const s = await mk(60_000);
  const channel = "0x" + randomBytes(32).toString("hex");
  await repo.activate(s.id, { externalSessionId: channel, maxBudgetMicros: 1_000_000, authorizationReference: null, expiresAt: new Date(Date.now() + 60_000).toISOString() }, new Date());
  await repo.close(s.id, new Date());
  const claims = await Promise.all(Array.from({ length: 10 }, (_, i) => repos[i % 3]!.claimSettlement(s.id, new Date(), 120)));
  assert.equal(claims.filter(Boolean).length, 1);
  await repo.finishSettlement(s.id, { settlementStatus: "settled", settlementReference: "0xabc", settledMicros: 0 });
  assert.equal(await repo.claimSettlement(s.id, new Date(), 120), null); // settled: never re-claimed
  assert.ok(await repo.claimSettlement(s.id, new Date(), 120, { allowSettled: true })); // payer close only
  // Purge: only expired, never-opened rows older than the cutoff.
  const purged = await repo.purgeExpiredPending(new Date(Date.now() + 1000), 1000);
  assert.ok(purged >= 12);
  assert.equal(await repo.get(overdue[0]!.id), null);
  assert.ok(await repo.get(s.id));
  assert.ok(await repo.get(fresh.id));
});
