import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createApp } from "../src/api/app.js";
import { loadConfig } from "../src/config/env.js";
import { capabilities } from "../src/domain/capabilities.js";
import { plannedCapabilities } from "../src/domain/roadmap.js";
import { prices } from "../src/billing/catalog.js";
import { buildOpenapi } from "../src/api/openapi.js";
import { buildAgentManifest, buildAiPluginManifest, buildAgentCard } from "../src/api/manifest.js";
import { buildLlmsTxt } from "../src/api/llms-txt.js";
import { buildCapabilitiesRegistry } from "../src/api/agent.js";

// This suite covers requirement 18: the AI-agent-first refocus must not introduce a second,
// driftable copy of any tool's name, price, schema or description. Every assertion below
// checks that a public surface (a route response, the OpenAPI document, or a manifest
// builder) still reads from the single `capabilities` registry in src/domain/capabilities.ts —
// never a hand-copied literal. MCP's own use of the registry is covered by tests/mcp.test.ts,
// which spawns the compiled server and asserts its tools/list names AND descriptions match
// `capabilities` exactly (including the appended `whenToUse` sentence).

const key = "test-only-not-a-real-credential-12345";
const wallet = "0x1234567890123456789012345678901234567890";

async function withServer<T>(config: ReturnType<typeof loadConfig>, fn: (base: string) => Promise<T>): Promise<T> {
  const app = createApp(config, { logger: () => {} });
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a network address");
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

test("capability registry and pricing never drift: prices[name] === capability.price for every tool", () => {
  assert.equal(Object.keys(prices).length, capabilities.length);
  for (const c of capabilities) assert.equal(prices[c.name], c.price);
});

test("x402 per-tool pricing (info, gate requirements, OpenAPI 402 docs) all read the same registry-derived prices object", async () => {
  const config = loadConfig({ RAFID_API_KEYS: key, X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet });
  await withServer(config, async base => {
    const info = await (await fetch(base + "/api/v1/x402")).json();
    for (const tool of info.data.tools) assert.equal(tool.price, prices[tool.name as keyof typeof prices]);
    const capsRegistry = await (await fetch(base + "/api/v1/capabilities")).json();
    for (const entry of capsRegistry.data) assert.equal(entry.price, prices[entry.name as keyof typeof prices]);
  });
  const doc = buildOpenapi(config) as { paths: Record<string, { post?: { responses: Record<string, { description: string }> } } > };
  for (const c of capabilities) {
    const x402Path = doc.paths["/api/v1/x402" + c.path];
    assert.ok(x402Path?.post?.responses["402"].description.includes(prices[c.name].toFixed(2)));
  }
});

test("OpenAPI operationIds match capability names exactly for the primary (non-legacy, non-x402) routes", () => {
  const doc = buildOpenapi(loadConfig({ RAFID_API_KEYS: key })) as { paths: Record<string, { post?: { operationId: string } }> };
  for (const c of capabilities) {
    assert.equal(doc.paths["/api/v1" + c.path]?.post?.operationId, c.name);
  }
  assert.equal(new Set(capabilities.map(c => c.name)).size, capabilities.length);
});

test("GET /api/v1/capabilities is a machine-first registry that matches src/domain/capabilities.ts one-to-one", async () => {
  const config = loadConfig({ RAFID_API_KEYS: key });
  await withServer(config, async base => {
    const response = await fetch(base + "/api/v1/capabilities");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.length, capabilities.length);
    for (const c of capabilities) {
      const entry = body.data.find((e: any) => e.name === c.name);
      assert.ok(entry, `expected a capabilities entry for ${c.name}`);
      assert.equal(entry.description, c.description);
      assert.equal(entry.whenToUse, c.whenToUse);
      assert.deepEqual(entry.useCases, c.useCases);
      assert.equal(entry.price, c.price);
      assert.equal(entry.paymentProtocol, "x402");
      assert.equal(entry.idempotent, c.idempotent);
      assert.equal(entry.sideEffects, c.sideEffects);
      assert.equal(entry.inputSchema.additionalProperties, false);
      assert.deepEqual(entry.inputSchema.examples, [c.example]);
      assert.ok(entry.outputSchema);
    }
    assert.deepEqual(body.data, buildCapabilitiesRegistry(config));
  });
});

test("GET /agent.json, /.well-known/ai-plugin.json and /.well-known/agent.json each return valid, well-formed JSON", async () => {
  const config = loadConfig({ RAFID_API_KEYS: key, X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet });
  await withServer(config, async base => {
    for (const path of ["/agent.json", "/.well-known/ai-plugin.json", "/.well-known/agent.json"]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/);
      const text = await response.text();
      assert.doesNotThrow(() => JSON.parse(text), `${path} did not return valid JSON`);
    }
  });
});

test("GET /agent.json's tool catalog is exactly buildCapabilitiesRegistry() — no second tool list", async () => {
  const config = loadConfig({ RAFID_API_KEYS: key, X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet });
  await withServer(config, async base => {
    const manifest = await (await fetch(base + "/agent.json")).json();
    assert.deepEqual(manifest.tools, buildCapabilitiesRegistry(config));
    assert.deepEqual(manifest.roadmap, plannedCapabilities);
    assert.equal(manifest.x402.payTo, wallet);
    assert.equal(manifest.x402.enabled, true);
  });
});

test(".well-known/agent.json lists every capability as an A2A skill with a matching id/name/description", async () => {
  const config = loadConfig({ RAFID_API_KEYS: key });
  await withServer(config, async base => {
    const card = await (await fetch(base + "/.well-known/agent.json")).json();
    assert.equal(card.skills.length, capabilities.length);
    for (const c of capabilities) {
      const skill = card.skills.find((s: any) => s.id === c.name);
      assert.ok(skill);
      assert.equal(skill.name, c.name);
      assert.equal(skill.description, c.description);
    }
  });
});

test("origin-dependent manifests (ai-plugin.json, well-known agent.json) reflect the request's own scheme+host, honoring X-Forwarded-Proto", async () => {
  const config = loadConfig({ RAFID_API_KEYS: key });
  await withServer(config, async base => {
    const plugin = await (await fetch(base + "/.well-known/ai-plugin.json", { headers: { "X-Forwarded-Proto": "https" } })).json();
    assert.match(plugin.api.url, /^https:\/\//);
    assert.ok(plugin.api.url.endsWith("/openapi.json"));
    const card = await (await fetch(base + "/.well-known/agent.json", { headers: { "X-Forwarded-Proto": "https" } })).json();
    assert.match(card.url, /^https:\/\//);
  });
});

test("GET /llms.txt is plain text, mentions every tool by name and price, and never a planned tool as though it were callable", async () => {
  const config = loadConfig({ RAFID_API_KEYS: key });
  await withServer(config, async base => {
    const response = await fetch(base + "/llms.txt");
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/plain/);
    const text = await response.text();
    for (const c of capabilities) {
      assert.ok(text.includes(c.name));
      assert.ok(text.includes(`$${prices[c.name].toFixed(2)}`));
    }
    for (const p of plannedCapabilities) assert.ok(text.includes(p.name));
    assert.equal(text, buildLlmsTxt(config));
  });
});

test("buildAgentManifest / buildAiPluginManifest / buildAgentCard are pure functions of config + the shared registry (no network, no secrets)", () => {
  const config = loadConfig({ RAFID_API_KEYS: key, X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet, CDP_API_KEY_ID: "id", CDP_API_KEY_SECRET: "secret", X402_NETWORK: "eip155:8453" });
  const manifest = buildAgentManifest(config);
  assert.ok(!JSON.stringify(manifest).includes("secret"));
  assert.equal(manifest.tools.length, capabilities.length);
  const plugin = buildAiPluginManifest(config, "https://example.test");
  assert.equal(plugin.api.url, "https://example.test/openapi.json");
  const card = buildAgentCard(config, "https://example.test");
  assert.deepEqual(card.authentication.schemes, ["x402", "apiKey"]);
});

test("the AI-agent-first refocus adds no user-account, dashboard, subscription or billing-portal surface", async () => {
  const config = loadConfig({ RAFID_API_KEYS: key });
  await withServer(config, async base => {
    for (const path of ["/signup", "/login", "/dashboard", "/account", "/billing", "/subscribe", "/checkout"]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 404, `expected ${path} to be unimplemented`);
    }
  });
});
