import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { createApp } from "../src/api/app.js";
import { loadConfig } from "../src/config/env.js";
import { capabilities } from "../src/domain/capabilities.js";
import { prices } from "../src/billing/catalog.js";
import { buildOpenapi } from "../src/api/openapi.js";
import { buildLlmsTxt } from "../src/api/llms-txt.js";
import {
  mintMacaroon, serializeMacaroon, deserializeMacaroon, verifyMacaroonSignature, encodeL402Identifier, decodeL402Identifier
} from "../src/billing/l402/macaroon.js";
import { parseL402Authorization, buildL402Status } from "../src/billing/l402/gate.js";
import { LndRestBackend, LightningBackendError, type LightningBackend } from "../src/billing/l402/lightning.js";
import { PublicBtcUsdRateProvider, usdToSats, type BtcUsdRateProvider } from "../src/billing/l402/rates.js";
import { MemoryL402RedemptionStore } from "../src/billing/l402/redemptions.js";
import { MemoryRevenueLedger } from "../src/revenue/memoryLedger.js";
import { MemoryAnalyticsRepository } from "../src/analytics/memoryRepository.js";
import { buildReconciliation, isPaidToolExecution, summarizeRevenue } from "../src/revenue/aggregate.js";

const key = "test-only-not-a-real-credential-12345";
const l402Env = {
  RAFID_API_KEYS: key, L402_ENABLED: "true", LND_REST_URL: "https://lnd.example.test:8080",
  LND_INVOICE_MACAROON: "0201036c6e640258030a10".padEnd(60, "a"), L402_ROOT_KEY: "5c".repeat(32)
};

// -------------------------------------------------------------------------------------------
// Macaroons — interoperability with js-macaroon / go-macaroon
// -------------------------------------------------------------------------------------------

// Produced by js-macaroon 3.0.4 (newMacaroon v2 + three first-party caveats) with root key
// 0x0f*32 — our implementation must serialize byte-identically and verify it.
const JS_MACAROON_VECTOR = "AgEPcmFmaWQtYWdlbnQtYXBpAkIAAKurq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc3Nzc0AAhdzZXJ2aWNlPXJhZmlkLWFnZW50LWFwaQACG2NhcGFiaWxpdHk9YW5hbHl6ZV9wcm9wZXJ0eQACEmV4cGlyZXM9NDEwMjQ0NDgwMAAABiD7ia544TkriVcP/eLhNSJHCpbCWGtMeuk5LneexjYbAQ==";

test("macaroon: byte-identical to a js-macaroon vector, and verifies it", () => {
  const rootKey = Buffer.from("0f".repeat(32), "hex");
  const identifier = encodeL402Identifier(Buffer.alloc(32, 0xab), Buffer.alloc(32, 0xcd));
  const caveats = ["service=rafid-agent-api", "capability=analyze_property", "expires=4102444800"];
  const ours = serializeMacaroon(mintMacaroon({ rootKey, identifier, location: "rafid-agent-api", caveats }));
  assert.equal(ours, JS_MACAROON_VECTOR);
  const parsed = deserializeMacaroon(JS_MACAROON_VECTOR);
  assert.ok(parsed);
  assert.deepEqual(parsed.caveats, caveats);
  assert.equal(verifyMacaroonSignature(parsed, rootKey), true);
  assert.equal(verifyMacaroonSignature(parsed, Buffer.from("10".repeat(32), "hex")), false);
  assert.equal(verifyMacaroonSignature({ ...parsed, caveats: [...caveats.slice(0, 1), "capability=due_diligence_oman_company", caveats[2]!] }, rootKey), false);
  const id = decodeL402Identifier(parsed.identifier);
  assert.ok(id);
  assert.equal(id.paymentHash.toString("hex"), "ab".repeat(32));
});

test("macaroon: parser rejects malformed, truncated, oversized and non-base64 input without throwing", () => {
  const valid = Buffer.from(JS_MACAROON_VECTOR, "base64");
  for (const bad of ["", "not base64 !!", valid.subarray(0, 40).toString("base64"), Buffer.alloc(5000, 2).toString("base64"),
    Buffer.concat([Buffer.from([1]), valid.subarray(1)]).toString("base64"), Buffer.concat([valid, Buffer.from([0])]).toString("base64")]) {
    assert.equal(deserializeMacaroon(bad), null);
  }
});

test("L402 Authorization header parsing accepts L402 and legacy LSAT schemes", () => {
  assert.deepEqual(parseL402Authorization("L402 abc=:" + "11".repeat(32)), { macaroon: "abc=", preimageHex: "11".repeat(32) });
  assert.deepEqual(parseL402Authorization("LSAT m1,m2:ff"), { macaroon: "m1", preimageHex: "ff" });
  for (const bad of [undefined, "", "Bearer x:y", "L402 nocolon", "L402 :abc", "L402 a b:c"]) assert.equal(parseL402Authorization(bad), null);
});

// -------------------------------------------------------------------------------------------
// Config
// -------------------------------------------------------------------------------------------

test("L402 config fails closed on missing/insecure LND settings, weak root key, and production without a database", () => {
  assert.equal(loadConfig({ RAFID_API_KEYS: key }).l402Enabled, false);
  for (const env of [
    { ...l402Env, LND_REST_URL: "" },
    { ...l402Env, LND_REST_URL: "http://lnd.example.test:8080" },
    { ...l402Env, LND_INVOICE_MACAROON: "not-hex" },
    { ...l402Env, L402_ROOT_KEY: "abcd" },
    { ...l402Env, L402_BTC_USD_FALLBACK: "-5" }
  ]) assert.throws(() => loadConfig(env));
  assert.throws(() => loadConfig({ ...l402Env, NODE_ENV: "production", AUTH_MODE: "postgres", DATABASE_URL: "" }, { requireApiKeys: false }), /DATABASE_URL/);
  const config = loadConfig({ ...l402Env, L402_BTC_USD_FALLBACK: "95000" });
  assert.equal(config.l402Enabled, true);
  assert.equal(config.l402Network, "mainnet");
  assert.equal(config.l402BtcUsdFallback, 95000);
  const status = buildL402Status(config);
  assert.equal(status.mode, "production");
  assert.equal(JSON.stringify(status).includes(config.l402RootKey), false);
  assert.equal(JSON.stringify(status).includes(config.lndInvoiceMacaroon), false);
});

// -------------------------------------------------------------------------------------------
// End-to-end over HTTP with a fake Lightning node
// -------------------------------------------------------------------------------------------

class FakeLightning implements LightningBackend {
  readonly name = "fake";
  readonly preimages = new Map<string, Buffer>();
  invoices: { amountSats: number; memo: string }[] = [];
  fail = false;
  async createInvoice(args: { amountSats: number; memo: string; expirySeconds: number }) {
    if (this.fail) throw new LightningBackendError("down");
    const preimage = randomBytes(32);
    const paymentHash = createHash("sha256").update(preimage).digest();
    this.preimages.set(paymentHash.toString("hex"), preimage);
    this.invoices.push(args);
    return { paymentRequest: `lnbc${args.amountSats}n1fake${this.invoices.length}`, paymentHash };
  }
  /** Simulates paying the invoice: returns the preimage the payer's wallet would receive. */
  pay(macaroonB64: string): string {
    const m = deserializeMacaroon(macaroonB64)!;
    return this.preimages.get(decodeL402Identifier(m.identifier)!.paymentHash.toString("hex"))!.toString("hex");
  }
}

const fixedRate = (btcUsd: number | null): BtcUsdRateProvider => ({
  getRate: async () => btcUsd === null ? null : { btcUsd, source: "coinbase", fetchedAt: new Date().toISOString() }
});

async function startL402App(t: { after(fn: () => void): void }, overrides: { rate?: number | null; now?: () => number } = {}) {
  const config = loadConfig(l402Env);
  const lightning = new FakeLightning();
  const redemptions = new MemoryL402RedemptionStore();
  const revenueLedger = new MemoryRevenueLedger();
  const analyticsRepository = new MemoryAnalyticsRepository();
  const app = createApp(config, {
    logger: () => {}, l402Backend: lightning, l402Rates: fixedRate(overrides.rate === undefined ? 100_000 : overrides.rate),
    l402Redemptions: redemptions, revenueLedger, analyticsRepository, l402Now: overrides.now
  });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return { base: `http://127.0.0.1:${address.port}`, lightning, redemptions, revenueLedger, analyticsRepository, config };
}

const tool = capabilities[0];
const post = (base: string, path: string, body: unknown, authorization?: string) => fetch(base + path, {
  method: "POST", headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) }, body: JSON.stringify(body)
});
const challengeOf = (res: Response) => {
  const header = res.headers.get("www-authenticate") ?? "";
  const m = /^L402 macaroon="([^"]+)", invoice="([^"]+)"$/.exec(header);
  assert.ok(m, `expected an L402 challenge header, got: ${header}`);
  return { macaroon: m[1]!, invoice: m[2]! };
};
const tick = () => new Promise(r => setTimeout(r, 20));

test("L402 routes, discovery field and OpenAPI paths are absent unless L402_ENABLED=true; info/status always answer", async t => {
  const config = loadConfig({ RAFID_API_KEYS: key });
  const app = createApp(config, { logger: () => {} });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  assert.equal((await post(base, "/api/v1/l402" + tool.path, tool.example)).status, 404);
  const discovery = await (await fetch(base + "/", { headers: { Accept: "application/json" } })).json();
  assert.equal(discovery.data.l402, undefined);
  const status = await (await fetch(base + "/api/v1/l402/status")).json();
  assert.equal(status.data.enabled, false);
  assert.equal(status.data.mode, "disabled");
  const info = await (await fetch(base + "/api/v1/l402")).json();
  assert.equal(info.data.tools.length, capabilities.length);
  const paths = buildOpenapi(config).paths as Record<string, unknown>;
  assert.equal(paths["/api/v1/l402" + tool.path], undefined);
  assert.ok(paths["/api/v1/l402/status"]);
});

test("L402 end to end: 402 challenge → pay → 200, one ledger row in BTC, token cannot be reused, reconciliation clean", async t => {
  const { base, lightning, revenueLedger, analyticsRepository } = await startL402App(t);
  const path = "/api/v1/l402" + tool.path;

  const unpaid = await post(base, path, tool.example);
  assert.equal(unpaid.status, 402);
  assert.match(unpaid.headers.get("access-control-expose-headers") ?? "", /WWW-Authenticate/);
  const { macaroon, invoice } = challengeOf(unpaid);
  const body = await unpaid.json();
  const expectedSats = usdToSats(prices[tool.name], 100_000);
  assert.equal(body.l402.amountSats, expectedSats);
  assert.equal(body.l402.invoice, invoice);
  assert.equal(body.l402.priceUsd, prices[tool.name]);
  assert.equal(lightning.invoices[0]!.amountSats, expectedSats);

  const preimage = lightning.pay(macaroon);
  const paid = await post(base, path, tool.example, `L402 ${macaroon}:${preimage}`);
  assert.equal(paid.status, 200);
  const result = await paid.json();
  assert.equal(result.success, true);
  assert.equal(result.meta.tool, tool.name);

  // Same token again → a fresh challenge, flagged as already redeemed.
  const replay = await post(base, path, tool.example, `L402 ${macaroon}:${preimage}`);
  assert.equal(replay.status, 402);
  assert.equal(replay.headers.get("x-l402-error"), "already_redeemed");

  await tick();
  const rows = revenueLedger.all();
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.status, "settlement_succeeded");
  assert.equal(row.currency, "BTC");
  assert.equal(row.network, "lightning:mainnet");
  assert.equal(row.amountAtomic, String(expectedSats));
  assert.equal(row.amountDecimal, expectedSats / 1e8);
  assert.equal(row.facilitator, "lnd");
  assert.equal(row.transactionHash, createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex"));
  assert.equal(JSON.stringify(rows).includes(preimage), false, "the preimage must never be stored");

  const summary = summarizeRevenue(rows, "all");
  assert.deepEqual(summary.revenueByCurrency, { BTC: expectedSats / 1e8 });

  const events = await analyticsRepository.queryEvents(new Date(0));
  const toolEvents = events.filter(e => e.category === "tool");
  assert.equal(toolEvents.length, 1, "unpaid challenges and rejected replays are not tool invocations");
  assert.equal(toolEvents[0]!.channel, "l402");
  assert.equal(events.filter(e => e.category === "l402" && e.eventType === "challenge").length, 2);
  assert.equal(events.filter(e => e.category === "l402" && e.eventType === "settlement_success").length, 1);
  assert.equal(events.filter(e => e.category === "x402").length, 0, "the x402 funnel is untouched");

  const counts: Record<string, number> = {};
  for (const e of events) if (isPaidToolExecution(e) && e.toolName) counts[e.toolName] = (counts[e.toolName] ?? 0) + 1;
  const anomalies = buildReconciliation({ settlements: rows, x402ToolExecutionCounts: counts, catalogPriceByTool: { ...prices } });
  assert.deepEqual(anomalies, []);
});

test("L402 rejects a wrong preimage, a token for another tool, a tampered caveat and an expired token — each with a fresh challenge", async t => {
  let nowMs = Date.now();
  const { base, lightning, revenueLedger } = await startL402App(t, { now: () => nowMs });
  const path = "/api/v1/l402" + tool.path;
  const { macaroon } = challengeOf(await post(base, path, tool.example));
  const preimage = lightning.pay(macaroon);

  const wrong = await post(base, path, tool.example, `L402 ${macaroon}:${"00".repeat(32)}`);
  assert.equal(wrong.status, 402);
  assert.equal(wrong.headers.get("x-l402-error"), "bad_preimage");

  const other = capabilities[1];
  const otherTool = await post(base, "/api/v1/l402" + other.path, other.example, `L402 ${macaroon}:${preimage}`);
  assert.equal(otherTool.status, 402);
  assert.equal(otherTool.headers.get("x-l402-error"), "wrong_capability");

  const parsed = deserializeMacaroon(macaroon)!;
  const tampered = serializeMacaroon({ ...parsed, caveats: parsed.caveats.map(c => c.startsWith("amount_sats=") ? "amount_sats=1" : c) });
  const tamperedRes = await post(base, path, tool.example, `L402 ${tampered}:${preimage}`);
  assert.equal(tamperedRes.status, 402);
  assert.equal(tamperedRes.headers.get("x-l402-error"), "bad_signature");

  const forged = serializeMacaroon(mintMacaroon({ rootKey: randomBytes(32), identifier: parsed.identifier, location: parsed.location, caveats: parsed.caveats }));
  assert.equal((await post(base, path, tool.example, `L402 ${forged}:${preimage}`)).headers.get("x-l402-error"), "bad_signature");

  nowMs += 3 * 24 * 60 * 60 * 1000;
  const expired = await post(base, path, tool.example, `L402 ${macaroon}:${preimage}`);
  assert.equal(expired.status, 402);
  assert.equal(expired.headers.get("x-l402-error"), "expired");

  await tick();
  assert.equal(revenueLedger.all().length, 0, "no rejected token is ever recorded as revenue");
});

test("L402: a failed call (400 invalid input) does not consume the paid token; the corrected retry succeeds", async t => {
  const { base, lightning, redemptions, revenueLedger } = await startL402App(t);
  const path = "/api/v1/l402" + tool.path;
  const { macaroon } = challengeOf(await post(base, path, tool.example));
  const preimage = lightning.pay(macaroon);
  const bad = await post(base, path, { definitelyNotAValidField: true }, `L402 ${macaroon}:${preimage}`);
  assert.equal(bad.status, 400);
  await tick();
  const hash = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
  assert.equal(redemptions.status(hash), undefined, "token released after the failed call");
  assert.equal(revenueLedger.all().length, 0);
  const good = await post(base, path, tool.example, `L402 ${macaroon}:${preimage}`);
  assert.equal(good.status, 200);
  await tick();
  assert.equal(redemptions.status(hash), "redeemed");
  assert.equal(revenueLedger.all().length, 1);
});

test("L402 returns 503 (never a guessed price or a fake invoice) when no BTC/USD rate or no Lightning node is available", async t => {
  const noRate = await startL402App(t, { rate: null });
  const r1 = await post(noRate.base, "/api/v1/l402" + tool.path, tool.example);
  assert.equal(r1.status, 503);
  assert.equal((await r1.json()).error.code, "L402_PRICING_UNAVAILABLE");
  assert.equal(noRate.lightning.invoices.length, 0);

  const down = await startL402App(t);
  down.lightning.fail = true;
  const r2 = await post(down.base, "/api/v1/l402" + tool.path, tool.example);
  assert.equal(r2.status, 503);
  const body = await r2.json();
  assert.equal(body.error.code, "L402_LIGHTNING_UNAVAILABLE");
  assert.equal(JSON.stringify(body).includes("lnd.example.test"), false, "the node's host is never leaked");
});

test("L402 discovery: root, /agent.json, llms.txt and OpenAPI advertise the Lightning route family when enabled", async t => {
  const { base, config } = await startL402App(t);
  const discovery = await (await fetch(base + "/", { headers: { Accept: "application/json" } })).json();
  assert.equal(discovery.data.l402, "/api/v1/l402");
  const manifest = await (await fetch(base + "/agent.json")).json();
  assert.ok(JSON.stringify(manifest).includes("lightning:mainnet"));
  const status = await (await fetch(base + "/api/v1/l402/status")).json();
  assert.equal(status.data.enabled, true);
  assert.equal(status.data.paymentEnforcement, true);
  assert.match(buildLlmsTxt(config), /L402 route: {4}POST \/api\/v1\/l402\//);
  const doc = buildOpenapi(config) as { paths: Record<string, { post: { operationId: string } }> };
  for (const c of capabilities) assert.equal(doc.paths["/api/v1/l402" + c.path].post.operationId, c.name + "_l402");
});

// -------------------------------------------------------------------------------------------
// LND REST backend and BTC/USD rates (no network)
// -------------------------------------------------------------------------------------------

test("LndRestBackend: POST /v1/invoices with the invoice macaroon header; parses r_hash; errors never leak node details", async () => {
  const hash = randomBytes(32);
  let seen: { url: URL; body: string; headers: Record<string, string>; ca?: string } | null = null;
  const backend = new LndRestBackend({
    restUrl: "https://node.example:8080", invoiceMacaroonHex: "abcd1234", tlsCert: Buffer.from("-----BEGIN CERTIFICATE-----\nX\n-----END CERTIFICATE-----").toString("base64"),
    requester: async args => { seen = args; return { status: 200, body: JSON.stringify({ r_hash: hash.toString("base64"), payment_request: "lnbc1500n1pexample" }) }; }
  });
  const invoice = await backend.createInvoice({ amountSats: 150, memo: "Rafid test", expirySeconds: 600 });
  assert.ok(invoice.paymentHash.equals(hash));
  assert.equal(invoice.paymentRequest, "lnbc1500n1pexample");
  assert.ok(seen);
  const s = seen as { url: URL; body: string; headers: Record<string, string>; ca?: string };
  assert.equal(s.url.toString(), "https://node.example:8080/v1/invoices");
  assert.equal(s.headers["Grpc-Metadata-macaroon"], "abcd1234");
  assert.deepEqual(JSON.parse(s.body), { value: "150", memo: "Rafid test", expiry: "600" });
  assert.match(s.ca ?? "", /BEGIN CERTIFICATE/);

  const failing = new LndRestBackend({ restUrl: "https://node.example:8080", invoiceMacaroonHex: "ab", requester: async () => { throw new Error("connect ECONNREFUSED 10.0.0.5:8080"); } });
  await assert.rejects(failing.createInvoice({ amountSats: 1, memo: "", expirySeconds: 60 }), (e: Error) => e instanceof LightningBackendError && !e.message.includes("10.0.0.5"));
  const rejecting = new LndRestBackend({ restUrl: "https://node.example:8080", invoiceMacaroonHex: "ab", requester: async () => ({ status: 403, body: "permission denied" }) });
  await assert.rejects(rejecting.createInvoice({ amountSats: 1, memo: "", expirySeconds: 60 }), /HTTP 403/);
  const garbage = new LndRestBackend({ restUrl: "https://node.example:8080", invoiceMacaroonHex: "ab", requester: async () => ({ status: 200, body: JSON.stringify({ r_hash: "short", payment_request: "x" }) }) });
  await assert.rejects(garbage.createInvoice({ amountSats: 1, memo: "", expirySeconds: 60 }), /invalid invoice/);
});

test("BTC/USD rates: Coinbase first, Kraken fallback, implausible values rejected, caching, stale cache, configured fallback, then null", async () => {
  let now = 1_000_000;
  const responses: Record<string, unknown> = {
    coinbase: { data: { amount: "100000.50" } },
    kraken: { result: { XXBTZUSD: { c: ["99000.1", "1"] } } }
  };
  let calls = 0;
  const fetchImpl = async (url: string) => {
    calls++;
    const body = url.includes("coinbase") ? responses.coinbase : responses.kraken;
    return { ok: body !== undefined, json: async () => body };
  };
  const provider = new PublicBtcUsdRateProvider({ cacheMs: 60_000, fallbackBtcUsd: 90_000, fetchImpl, now: () => now });
  assert.deepEqual((await provider.getRate())?.btcUsd, 100000.5);
  await provider.getRate();
  assert.equal(calls, 1, "second call within the cache window is served from cache");

  now += 61_000; responses.coinbase = { data: { amount: "5" } }; // implausible → falls through to Kraken
  const q = await provider.getRate();
  assert.equal(q?.source, "kraken");
  assert.equal(q?.btcUsd, 99000.1);

  now += 61_000; responses.coinbase = undefined; responses.kraken = undefined;
  assert.equal((await provider.getRate())?.source, "stale_cache");
  now += 20 * 60_000;
  assert.deepEqual(await provider.getRate().then(r => [r?.source, r?.btcUsd]), ["configured_fallback", 90_000]);

  const none = new PublicBtcUsdRateProvider({ cacheMs: 60_000, fallbackBtcUsd: null, fetchImpl: async () => ({ ok: false, json: async () => ({}) }) });
  assert.equal(await none.getRate(), null);
});

test("usdToSats always rounds up and never returns less than 1 sat", () => {
  assert.equal(usdToSats(0.15, 100_000), 150);
  assert.equal(usdToSats(0.05, 97_123.45), Math.ceil((0.05 / 97_123.45) * 1e8));
  assert.equal(usdToSats(0.0000001, 100_000), 1);
});

// -------------------------------------------------------------------------------------------
// BOLT11 reader + Voltage Payments backend (L402_BACKEND=voltage)
// -------------------------------------------------------------------------------------------

import { decodeBolt11 } from "../src/billing/l402/bolt11.js";
import { VoltagePaymentsBackend } from "../src/billing/l402/voltage.js";

// Encoded and signed with the `bolt11` npm package (payment hash 0001…0102), cross-checked here.
const INVOICE_150_SATS_MAINNET = "lnbc1500n1pj48ugqpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsdqs2fskv6tyyp6x2um59qypqsqxqrrsscqpfndvdxlx6w4ywd3p9ve360cqs297s2syug99rcarqez8sqjmawkundx4xt06dvayq2lpmnxjtut00fkxsxcxwk7qmyux9w3lklp280uspquu97a";
const INVOICE_263_SATS_SIGNET = "lntbs2630n1pj48ugqpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsdqs2fskv6tyyp6x2um59qypqsqxqrrsscqpfmlkg6mx2lmc22y6muhhs8fnwxcj39cjcknegykcfdfajfpuepaty3rnev2jd4ctpqsnlmxpwpk6lc9qh3f9ghgm9g4nc7pfenf0fhhcqj677w2";
const VECTOR_HASH = "0001020304050607080900010203040506070809000102030405060708090102";

test("BOLT11: decodes payment hash, amount and network from real invoices; rejects a bad checksum", () => {
  const a = decodeBolt11(INVOICE_150_SATS_MAINNET)!;
  assert.equal(a.network, "bc");
  assert.equal(a.amountMsat, 150_000n);
  assert.equal(a.paymentHash.toString("hex"), VECTOR_HASH);
  const b = decodeBolt11(INVOICE_263_SATS_SIGNET)!;
  assert.equal(b.network, "tbs");
  assert.equal(b.amountMsat, 263_000n);
  const flipped = INVOICE_150_SATS_MAINNET.slice(0, -1) + (INVOICE_150_SATS_MAINNET.endsWith("q") ? "p" : "q");
  assert.equal(decodeBolt11(flipped), null);
  assert.equal(decodeBolt11("not an invoice"), null);
});

function voltageFake(script: Array<{ status: number; body?: unknown }>) {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  let i = 0;
  const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, ...init });
    const step = script[Math.min(i++, script.length - 1)]!;
    return { status: step.status, ok: step.status < 300, text: async () => step.body === undefined ? "" : JSON.stringify(step.body) };
  };
  const backend = new VoltagePaymentsBackend({
    apiUrl: "https://voltageapi.com/v1", apiKey: "vk_test", organizationId: "org-1", environmentId: "env-1", walletId: "wal-1",
    fetchImpl, sleep: async () => {}, maxWaitMs: 200, pollIntervalMs: 1
  });
  return { backend, calls };
}

test("Voltage backend: POST receive payment (msats), poll until the BOLT11 appears, hash read from the invoice", async () => {
  const { backend, calls } = voltageFake([
    { status: 202 },
    { status: 404 },
    { status: 200, body: { status: "generating", data: {} } },
    { status: 200, body: { status: "receiving", data: { payment_request: INVOICE_150_SATS_MAINNET } } }
  ]);
  const invoice = await backend.createInvoice({ amountSats: 150, memo: "Rafid analyze_property (1 call)", expirySeconds: 600 });
  assert.equal(invoice.paymentRequest, INVOICE_150_SATS_MAINNET);
  assert.equal(invoice.paymentHash.toString("hex"), VECTOR_HASH);
  const post = calls[0]!;
  assert.equal(post.method, "POST");
  assert.equal(post.url, "https://voltageapi.com/v1/organizations/org-1/environments/env-1/payments");
  assert.equal(post.headers["x-api-key"], "vk_test");
  const body = JSON.parse(post.body!);
  assert.equal(body.wallet_id, "wal-1");
  assert.equal(body.payment_kind, "bolt11");
  assert.deepEqual(body.amount, { currency: "btc", amount: 150_000, unit: "msats" });
  assert.equal(body.expiration, 600);
  assert.equal(calls[1]!.url, `${post.url}/${body.id}`);
});

test("Voltage backend: refuses a wrong-amount invoice, failed/expired status, HTTP errors and timeouts", async () => {
  const wrongAmount = voltageFake([{ status: 202 }, { status: 200, body: { status: "receiving", data: { payment_request: INVOICE_263_SATS_SIGNET } } }]);
  await assert.rejects(wrongAmount.backend.createInvoice({ amountSats: 150, memo: "", expirySeconds: 600 }), /wrong amount/);
  const failed = voltageFake([{ status: 202 }, { status: 200, body: { status: "failed", data: {} } }]);
  await assert.rejects(failed.backend.createInvoice({ amountSats: 150, memo: "", expirySeconds: 600 }), /could not generate/);
  const rejected = voltageFake([{ status: 401, body: { error: "bad key" } }]);
  await assert.rejects(rejected.backend.createInvoice({ amountSats: 150, memo: "", expirySeconds: 600 }), /HTTP 401/);
  const slow = voltageFake([{ status: 202 }, { status: 200, body: { status: "generating", data: {} } }]);
  await assert.rejects(slow.backend.createInvoice({ amountSats: 150, memo: "", expirySeconds: 600 }), /in time/);
});

test("L402_BACKEND=voltage config: requires API key + org/env/wallet ids, no LND settings needed; status reports the backend", () => {
  const base = { RAFID_API_KEYS: key, L402_ENABLED: "true", L402_BACKEND: "voltage", L402_ROOT_KEY: "5c".repeat(32), L402_NETWORK: "signet" };
  assert.throws(() => loadConfig(base), /VOLTAGE_API_KEY/);
  assert.throws(() => loadConfig({ ...base, VOLTAGE_API_KEY: "k", VOLTAGE_ORGANIZATION_ID: "o", VOLTAGE_ENVIRONMENT_ID: "e", VOLTAGE_WALLET_ID: "w", VOLTAGE_API_URL: "http://insecure" }), /https/);
  const config = loadConfig({ ...base, VOLTAGE_API_KEY: "k", VOLTAGE_ORGANIZATION_ID: "o", VOLTAGE_ENVIRONMENT_ID: "e", VOLTAGE_WALLET_ID: "w" });
  assert.equal(config.l402Backend, "voltage");
  const status = buildL402Status(config);
  assert.equal(status.backend, "voltage");
  assert.equal(status.mode, "testnet");
  assert.equal(status.lightningBackendConfigured, true);
  assert.equal(JSON.stringify(status).includes("\"k\""), false);
  assert.doesNotThrow(() => createApp(config, { logger: () => {}, l402Redemptions: new MemoryL402RedemptionStore() }));
});
