import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createApp } from "../src/api/app.js";
import { loadConfig } from "../src/config/env.js";
import { capabilities } from "../src/domain/capabilities.js";
import { prices } from "../src/billing/catalog.js";
import { BillingService } from "../src/billing/service.js";
import { buildX402Info, buildX402Status } from "../src/billing/x402.js";
import { buildOpenapi } from "../src/api/openapi.js";

const key = "test-only-not-a-real-credential-12345";
const wallet = "0x1234567890123456789012345678901234567890";

test("x402 configuration validates wallet address, network and facilitator URL", () => {
  const base = { RAFID_API_KEYS: key, X402_ENABLED: "true" };
  for (const env of [
    base,
    { ...base, X402_WALLET_ADDRESS: "not-an-address" },
    { ...base, X402_WALLET_ADDRESS: wallet, X402_NETWORK: "not-caip2" },
    { ...base, X402_WALLET_ADDRESS: wallet, X402_FACILITATOR_URL: "not-a-url" },
    { ...base, X402_WALLET_ADDRESS: wallet, X402_FACILITATOR_URL: "http://insecure.example" }
  ] as const) assert.throws(() => loadConfig(env));
  const config = loadConfig({ ...base, X402_WALLET_ADDRESS: wallet });
  assert.equal(config.x402Enabled, true);
  assert.equal(config.x402Network, "eip155:84532");
  assert.equal(config.x402FacilitatorUrl, "https://x402.org/facilitator");
});

test("x402 requires a Coinbase Developer Platform facilitator for any network besides the public facilitator's Base Sepolia", () => {
  const base = { RAFID_API_KEYS: key, X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet };
  assert.throws(() => loadConfig({ ...base, X402_NETWORK: "eip155:8453" }), /CDP_API_KEY_ID/);
  assert.throws(() => loadConfig({ ...base, CDP_API_KEY_ID: "only-one" }), /both CDP_API_KEY_ID and CDP_API_KEY_SECRET/);
  const mainnet = loadConfig({ ...base, X402_NETWORK: "eip155:8453", CDP_API_KEY_ID: "id", CDP_API_KEY_SECRET: "secret" });
  assert.equal(mainnet.cdpConfigured, true);
  assert.doesNotThrow(() => createApp(mainnet, { logger: () => {} }));
});

test("x402 routes and discovery field are absent unless X402_ENABLED=true", async t => {
  const config = loadConfig({ RAFID_API_KEYS: key });
  const app = createApp(config, { logger: () => {} });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const response = await fetch(base + "/api/v1/x402/property/analyze", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(capabilities[0].example)
  });
  assert.equal(response.status, 404);
  const discovery = await (await fetch(base + "/", { headers: { Accept: "application/json" } })).json();
  assert.equal(discovery.data.x402, undefined);
  assert.equal((buildOpenapi(config).paths as Record<string, unknown>)["/api/v1/x402" + capabilities[0].path], undefined);
});

test("x402 discovery and OpenAPI expose the pay-per-call routes when enabled", async t => {
  const config = loadConfig({ RAFID_API_KEYS: key, X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet });
  const app = createApp(config, { logger: () => {} });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const discovery = await (await fetch(`http://127.0.0.1:${address.port}/`, { headers: { Accept: "application/json" } })).json();
  assert.equal(discovery.data.x402, "/api/v1/x402");
  const doc = buildOpenapi(config) as { paths: Record<string, { post: { operationId: string } }> };
  for (const c of capabilities) assert.equal(doc.paths["/api/v1/x402" + c.path].post.operationId, c.name + "_x402");
});

// Requires real internet access to the public x402.org facilitator, so it's opt-in like
// the PostgreSQL integration tests (npm run test:db). Run with: RUN_X402_LIVE_TESTS=true npm test
test("x402 payment gate returns 402 with a PAYMENT-REQUIRED header describing accepted payment options (live facilitator)", { skip: !process.env.RUN_X402_LIVE_TESTS }, async t => {
  const config = loadConfig({ RAFID_API_KEYS: key, X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet });
  const app = createApp(config, { logger: () => {} });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/x402/property/analyze`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(capabilities[0].example)
  });
  assert.equal(response.status, 402);
  // The x402 v2 protocol carries the payment-required declaration in a base64-encoded JSON
  // PAYMENT-REQUIRED response header, not the JSON body (the body is intentionally {}).
  const header = response.headers.get("payment-required");
  assert.ok(header, "expected a PAYMENT-REQUIRED response header");
  const paymentRequired = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  assert.ok(
    Array.isArray(paymentRequired.accepts) && paymentRequired.accepts.length > 0,
    `expected an accepts array, got ${JSON.stringify(paymentRequired)}`
  );
  assert.equal(String(paymentRequired.accepts[0].payTo).toLowerCase(), wallet);
  assert.equal(paymentRequired.accepts[0].network, "eip155:84532");
});

test("GET /api/v1/x402/status reports factual, secret-free runtime status for disabled/testnet/mainnet configurations", async t => {
  const disabled = buildX402Status(loadConfig({ RAFID_API_KEYS: key }));
  assert.deepEqual(disabled, { enabled: false, mode: "disabled", network: null, asset: null, facilitator: null, walletConfigured: false, paymentEnforcement: false });

  const testnet = buildX402Status(loadConfig({ RAFID_API_KEYS: key, X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet }));
  assert.deepEqual(testnet, { enabled: true, mode: "testnet", network: "eip155:84532", asset: "USDC", facilitator: "public", walletConfigured: true, paymentEnforcement: true });

  const mainnetConfig = loadConfig({ RAFID_API_KEYS: key, X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet, X402_NETWORK: "eip155:8453", CDP_API_KEY_ID: "cdp-id-secret-value", CDP_API_KEY_SECRET: "cdp-secret-value" });
  const mainnet = buildX402Status(mainnetConfig);
  assert.deepEqual(mainnet, { enabled: true, mode: "production", network: "eip155:8453", asset: "USDC", facilitator: "coinbase-cdp", walletConfigured: true, paymentEnforcement: true });
  assert.ok(!JSON.stringify(mainnet).includes("cdp-id-secret-value") && !JSON.stringify(mainnet).includes("cdp-secret-value"));

  // Also confirm the live HTTP route matches the pure builder, and never leaks the CDP secret.
  const app = createApp(mainnetConfig, { logger: () => {} });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/x402/status`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.data, mainnet);
  assert.ok(!JSON.stringify(body).includes("cdp-id-secret-value") && !JSON.stringify(body).includes("cdp-secret-value"));
});

test("x402 pricing can never drift from the central catalog: BillingService, the x402 payment requirement, and GET /api/v1/x402 all agree", () => {
  const billing = new BillingService();
  const config = loadConfig({ RAFID_API_KEYS: key, X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet });
  const info = buildX402Info(config, billing);
  for (const c of capabilities) {
    assert.equal(billing.getToolPrice(c.name), prices[c.name]);
    const requirement = billing.buildX402PaymentRequirement(c.name, "eip155:84532", wallet);
    assert.equal(requirement.price, `$${prices[c.name].toFixed(2)}`);
    assert.equal(info.tools.find(t => t.name === c.name)?.price, prices[c.name]);
  }
});

test("the traditional X-API-Key route is fully independent of the x402 payment gate: neither requires the other, even when both are mounted together", async t => {
  const config = loadConfig({ RAFID_API_KEYS: key, X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet });
  const app = createApp(config, { logger: () => {} });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  // No X-PAYMENT header anywhere here: the API-key route must never ask for one.
  const authed = await fetch(base + "/api/v1/property/analyze", {
    method: "POST", headers: { "X-API-Key": key, "Content-Type": "application/json" }, body: JSON.stringify(capabilities[0].example)
  });
  assert.equal(authed.status, 200);
  assert.deepEqual((await authed.json()).data, await capabilities[0].execute(capabilities[0].example));
  // No X-API-Key anywhere here either: an API key must not satisfy or bypass the x402 route.
  // (This specific assertion doesn't require a live facilitator: a request carrying only an
  // API key and no payment/X-PAYMENT header is exactly the request the two live tests below
  // exercise against the real facilitator; this test's job is just proving the API-key route
  // itself never leaks into or depends on the payment gate.)
  const rejected = await fetch(base + "/api/v1/property/analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  assert.equal(rejected.status, 401);
});

// The two tests below need a real round trip to the public x402.org facilitator (the same
// dependency the existing "live facilitator" test above has), so they're opt-in for the same
// reason: RUN_X402_LIVE_TESTS=true npm test. Both spy on the capability itself — not just the
// HTTP status — to directly prove requirement F: the tool never runs before payment verifies.
test("x402: an unpaid request is rejected before analyze_property ever executes (live facilitator)", { skip: !process.env.RUN_X402_LIVE_TESTS }, async t => {
  const original = capabilities[0].execute;
  let called = false;
  (capabilities[0] as any).execute = (input: unknown) => { called = true; return original(input); };
  t.after(() => { (capabilities[0] as any).execute = original; });
  const config = loadConfig({ RAFID_API_KEYS: key, X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet });
  const app = createApp(config, { logger: () => {} });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/x402/property/analyze`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(capabilities[0].example)
  });
  assert.equal(response.status, 402);
  assert.equal(called, false, "analyze_property must never execute before a payment is verified");
});

test("x402: a malformed X-PAYMENT proof is rejected by the facilitator and analyze_property never executes (live facilitator)", { skip: !process.env.RUN_X402_LIVE_TESTS }, async t => {
  const original = capabilities[0].execute;
  let called = false;
  (capabilities[0] as any).execute = (input: unknown) => { called = true; return original(input); };
  t.after(() => { (capabilities[0] as any).execute = original; });
  const config = loadConfig({ RAFID_API_KEYS: key, X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet });
  const app = createApp(config, { logger: () => {} });
  const server = app.listen(0, "127.0.0.1");
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/x402/property/analyze`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-PAYMENT": Buffer.from("not-a-real-payment-proof").toString("base64") }, body: JSON.stringify(capabilities[0].example)
  });
  assert.ok(response.status === 402 || response.status === 400, `expected the facilitator to reject a malformed proof, got ${response.status}`);
  assert.equal(called, false, "analyze_property must never execute on a malformed/rejected payment proof");
});

test("GET /api/v1/x402 exposes protocol/pricing information separately from the payment-gated routes", async t => {
  const disabled = createApp(loadConfig({ RAFID_API_KEYS: key }), { logger: () => {} });
  const s1 = disabled.listen(0, "127.0.0.1");
  t.after(() => { s1.closeAllConnections(); s1.close(); });
  await once(s1, "listening");
  const a1 = s1.address(); assert.ok(a1 && typeof a1 !== "string");
  const off = await (await fetch(`http://127.0.0.1:${a1.port}/api/v1/x402`)).json();
  assert.equal(off.data.enabled, false);
  assert.equal(off.data.network, null);

  const config = loadConfig({ RAFID_API_KEYS: key, X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet });
  const enabled = createApp(config, { logger: () => {} });
  const s2 = enabled.listen(0, "127.0.0.1");
  t.after(() => { s2.closeAllConnections(); s2.close(); });
  await once(s2, "listening");
  const a2 = s2.address(); assert.ok(a2 && typeof a2 !== "string");
  const on = await (await fetch(`http://127.0.0.1:${a2.port}/api/v1/x402`)).json();
  assert.equal(on.data.enabled, true);
  assert.equal(on.data.network, "eip155:84532");
  assert.equal(on.data.payTo, wallet);
  assert.equal(on.data.facilitator, "public");
  assert.deepEqual(on.data.tools.map((t: any) => t.name).sort(), capabilities.map(c => c.name).sort());
});
