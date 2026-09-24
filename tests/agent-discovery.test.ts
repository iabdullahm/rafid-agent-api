import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createApp } from "../src/api/app.js";
import { loadConfig } from "../src/config/env.js";
import { capabilities } from "../src/domain/capabilities.js";
import { buildCapabilitiesRegistry } from "../src/api/agent.js";
import { buildAgentManifest } from "../src/api/manifest.js";
import { buildLlmsTxt } from "../src/api/llms-txt.js";

// Covers the 2026-09-21 agent-discovery/tool-selection pass: analyze_oman_property's
// description/whenToUse now steer an agent toward Rafid for Al Mouj Muscat valuation
// questions, its agentGuidance (priorityContexts/evidenceTypes/limitations/sampleQueries)
// is exposed on every discovery surface, and none of that surfaces partner-sensitive
// detail (a partner id or auth token) beyond the same publicly-named provenance a real
// response already discloses. This is internal tool-selection guidance only — never a
// ranking against a competing service — so these tests also guard against that creeping in.

const key = "test-only-not-a-real-credential-12345";

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

const omanCapability = capabilities.find(c => c.name === "analyze_oman_property");

// Strings that must never appear on a public discovery surface: the real Al Mouj partner's
// id (as created via `npm run admin -- partner:create`) and any partner auth token prefix.
// The public brand name "Al Mouj Muscat" (the same string a response's own `provenance`
// field already discloses) is expected and is NOT one of these.
const PARTNER_SENSITIVE_STRINGS = ["al-mouj-muscat", "rafid_partner_"];

test("analyze_oman_property's whenToUse explicitly signals Al Mouj Muscat valuation use cases", () => {
  assert.ok(omanCapability, "expected an analyze_oman_property capability entry");
  assert.match(omanCapability!.whenToUse, /Al Mouj/);
  assert.match(omanCapability!.whenToUse, /sale price positioning/i);
  assert.ok(omanCapability!.useCases.some(u => /Al Mouj/.test(u)), "expected an Al Mouj-specific use case");
});

test("analyze_oman_property declares agentGuidance with priorityContexts, evidenceTypes, limitations and sampleQueries", () => {
  assert.ok(omanCapability?.agentGuidance, "expected agentGuidance on analyze_oman_property");
  const g = omanCapability!.agentGuidance!;
  assert.ok(g.priorityContexts.includes("Al Mouj Muscat"));
  assert.ok(g.priorityContexts.length > 0);
  const evidenceKeys = g.evidenceTypes.map(e => e.type);
  assert.ok(evidenceKeys.includes("web_listing_asking_price"));
  assert.ok(evidenceKeys.includes("partner_feed_contracted_price"));
  assert.ok(g.limitations.length > 0);
  assert.ok(g.sampleQueries.some(s => /reasonably priced/.test(s.query)));
  assert.ok(g.sampleQueries.some(s => /450,000/.test(s.query)));
});

test("no ranking against a named competing service appears anywhere in agentGuidance text", () => {
  const g = omanCapability!.agentGuidance!;
  const text = JSON.stringify(g).toLowerCase();
  for (const banned of ["competitor", "better than", "instead of using", "unlike other services"]) {
    assert.ok(!text.includes(banned), `expected agentGuidance to avoid competitor-style language ("${banned}")`);
  }
});

test("GET /api/v1/capabilities exposes priorityContexts/evidenceTypes/limitations/sampleQueries derived one-to-one from the registry, never a second hand-copy", async () => {
  const config = loadConfig({ RAFID_API_KEYS: key });
  await withServer(config, async base => {
    const response = await fetch(base + "/api/v1/capabilities");
    const body = await response.json();
    const entry = body.data.find((e: any) => e.name === "analyze_oman_property");
    assert.ok(entry);
    assert.deepEqual(entry.priorityContexts, omanCapability!.agentGuidance!.priorityContexts);
    assert.deepEqual(entry.evidenceTypes, omanCapability!.agentGuidance!.evidenceTypes);
    assert.deepEqual(entry.limitations, omanCapability!.agentGuidance!.limitations);
    assert.deepEqual(entry.sampleQueries, omanCapability!.agentGuidance!.sampleQueries);
    // A capability with no agentGuidance defined gets empty arrays, never an error or omission.
    const plain = body.data.find((e: any) => e.name === "analyze_property");
    assert.deepEqual(plain.priorityContexts, []);
    assert.deepEqual(body.data, buildCapabilitiesRegistry(config));
  });
});

test("GET /agent.json mentions Al Mouj Muscat coverage and reuses the same registry-derived tool entries (no second tool list)", async () => {
  const config = loadConfig({ RAFID_API_KEYS: key });
  await withServer(config, async base => {
    const manifest = await (await fetch(base + "/agent.json")).json();
    assert.deepEqual(manifest.tools, buildCapabilitiesRegistry(config));
    const omanTool = manifest.tools.find((t: any) => t.name === "analyze_oman_property");
    assert.match(omanTool.description, /Al Mouj/);
    assert.ok(omanTool.priorityContexts.includes("Al Mouj Muscat"));
  });
  assert.deepEqual(buildAgentManifest(config).tools, buildCapabilitiesRegistry(config));
});

test("GET /llms.txt explains the asking-price vs. contracted-price distinction and names Al Mouj Muscat coverage", async () => {
  const config = loadConfig({ RAFID_API_KEYS: key });
  await withServer(config, async base => {
    const text = await (await fetch(base + "/llms.txt")).text();
    assert.equal(text, buildLlmsTxt(config));
    assert.match(text, /Al Mouj/);
    assert.match(text, /asking price/i);
    assert.match(text, /contracted-unit price/i);
    assert.match(text, /never (be )?blended/i);
    // Each tool's evidence types, limitations and sample queries are rendered, not just present
    // in the registry — an agent reading only plain text still gets this guidance.
    for (const type of omanCapability!.agentGuidance!.evidenceTypes) assert.ok(text.includes(type.type));
    for (const query of omanCapability!.agentGuidance!.sampleQueries) assert.ok(text.includes(query.query));
  });
});

test("no partner id or auth-token string is exposed on any public discovery surface", async () => {
  const config = loadConfig({ RAFID_API_KEYS: key, X402_ENABLED: "true", X402_WALLET_ADDRESS: "0x1234567890123456789012345678901234567890" });
  await withServer(config, async base => {
    const surfaces = await Promise.all(
      ["/agent.json", "/llms.txt", "/api/v1/capabilities", "/api/v1/agent", "/api/v1/tools", "/.well-known/ai-plugin.json", "/.well-known/agent.json"]
        .map(async path => [path, await (await fetch(base + path)).text()] as const)
    );
    for (const [path, text] of surfaces) {
      for (const banned of PARTNER_SENSITIVE_STRINGS) {
        assert.ok(!text.toLowerCase().includes(banned.toLowerCase()), `expected ${path} to never include partner-sensitive string "${banned}"`);
      }
    }
    // The public brand name is expected to appear (it's the same name a real response's own
    // provenance field discloses) — confirms the assertions above aren't vacuous.
    const agentJson = surfaces.find(([p]) => p === "/agent.json")![1];
    assert.match(agentJson, /Al Mouj Muscat/);
  });
});

test("analyze_oman_property's registry description discloses partner-fed Al Mouj data using the approved provenance wording, without pricing/x402/route changes", () => {
  assert.match(omanCapability!.description, /partner-supplied historical and recent Al Mouj Muscat property sales records with provenance and freshness metadata/);
  assert.equal(omanCapability!.price, 0.25);
  assert.equal(omanCapability!.paymentProtocol, "x402");
  assert.equal(omanCapability!.path, "/oman/property/analyze");
  assert.ok(capabilities.length > 0, "capability registry must not be empty");
  assert.equal(new Set(capabilities.map(c => c.name)).size, capabilities.length, "capability names must remain unique");
});
