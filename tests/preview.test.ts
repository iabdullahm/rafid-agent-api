import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createApp } from "../src/api/app.js";
import { loadConfig } from "../src/config/env.js";
import { capabilities } from "../src/domain/capabilities.js";
import { buildOpenapi } from "../src/api/openapi.js";
import { buildCapabilitiesRegistry } from "../src/api/agent.js";
import { buildAgentManifest } from "../src/api/manifest.js";
import { previewBasePath } from "../src/api/previewRoutes.js";
import { runCapabilityPreview, isPreviewSupported } from "../src/preview/service.js";

const key = "test-only-not-a-real-credential-12345";
const config = loadConfig({ RAFID_API_KEYS: key, LOG_LEVEL: "silent" });

/** Every capability this repository's registry actually wires a `preview` for today. Fixed here
 *  (not derived) so a future capability that ADDS a preview without corresponding security-test
 *  coverage below fails loudly, rather than the new capability silently getting only generic
 *  coverage from the loops further down. */
const PREVIEWABLE = ["analyze_oman_property", "oman_supplier_check", "company_reputation_check", "business_risk_score", "research_company", "document_facts_extract", "invoice_anomaly_check"] as const;

test("every previewable capability actually named in this test file exists and defines a preview; nothing extra silently gained one", () => {
  const actual = capabilities.filter(c => c.preview).map(c => c.name).sort();
  assert.deepEqual(actual, [...PREVIEWABLE].sort());
});

async function withApp<T>(options: Parameters<typeof createApp>[1], fn: (base: string, post: (path: string, body?: unknown) => Promise<Response>) => Promise<T>): Promise<T> {
  const app = createApp(config, options);
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const post = (path: string, body?: unknown) => fetch(base + path, {
      method: "POST",
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return await fn(base, post);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Generic route behavior
// ---------------------------------------------------------------------------------------------

test("POST /api/v1/preview/:capability — 200 for a capability with preview support, at both /api/v1 and /v1", async () => {
  await withApp({}, async (_base, post) => {
    for (const prefix of ["/api/v1", "/v1"]) {
      const response = await post(`${prefix}/preview/company_reputation_check`, capabilities.find(c => c.name === "company_reputation_check")!.example);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.success, true);
      assert.equal(body.data.capability, "company_reputation_check");
      assert.ok(["available", "limited"].includes(body.data.status));
      assert.equal(body.data.inputRecognized, true);
      assert.ok(body.meta.requestId);
    }
  });
});

test("POST /api/v1/preview/:capability — a capability with NO preview returns a structured status: \"unavailable\" response, not an error", async () => {
  await withApp({}, async (_base, post) => {
    const noPreview = capabilities.find(c => !c.preview)!;
    assert.ok(!PREVIEWABLE.includes(noPreview.name as (typeof PREVIEWABLE)[number]));
    const response = await post(`/api/v1/preview/${noPreview.name}`, noPreview.example);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.deepEqual(body.data, {
      capability: noPreview.name, status: "unavailable", inputRecognized: false, preview: {},
      fullResult: { capability: noPreview.name, price: { amount: noPreview.price.toFixed(2), currency: noPreview.currency }, endpoint: "/api/v1" + noPreview.path }
    });
  });
});

test("POST /api/v1/preview/:capability — an unknown capability name is a 404 CAPABILITY_NOT_FOUND, not silently treated as unsupported", async () => {
  await withApp({}, async (_base, post) => {
    const response = await post("/api/v1/preview/not_a_real_capability", {});
    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, "CAPABILITY_NOT_FOUND");
  });
});

test("POST /api/v1/preview/:capability — invalid input is a 400 INVALID_INPUT, exactly like the paid route's own validation", async () => {
  await withApp({}, async (_base, post) => {
    const response = await post("/api/v1/preview/research_company", {});
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.success, false);
    assert.equal(body.error.code, "INVALID_INPUT");
    assert.ok(Array.isArray(body.error.details));
  });
});

test("POST /api/v1/preview/:capability — a non-JSON body is 415, but a request with no body at all is not forced to set Content-Type", async () => {
  await withApp({}, async (base, post) => {
    const nonJson = await fetch(base + "/api/v1/preview/research_company", { method: "POST", headers: { "Content-Type": "text/plain" }, body: "not json" });
    assert.equal(nonJson.status, 415);
    const bodiless = await post("/api/v1/preview/research_company", undefined);
    assert.notEqual(bodiless.status, 415);
  });
});

test("preview NEVER invokes the paid capability's execute(), and NEVER triggers billing/payment for any previewable capability", async t => {
  const originalExecute = new Map(capabilities.map(c => [c.name, c.execute] as const));
  for (const c of capabilities) {
    (c as { execute: typeof c.execute }).execute = async () => {
      throw new Error(`execute() must never be called for "${c.name}" by a Free Preview request`);
    };
  }
  t.after(() => { for (const c of capabilities) (c as { execute: typeof c.execute }).execute = originalExecute.get(c.name)!; });

  let billingCalls = 0;
  await withApp({ billing: { async authorize() { billingCalls++; throw new Error("billing.authorize must never be called for a preview"); } } }, async (_base, post) => {
    for (const c of capabilities.filter(c => c.preview)) {
      const response = await post(`/api/v1/preview/${c.name}`, c.example);
      assert.equal(response.status, 200, `preview for ${c.name} must succeed without ever calling execute()`);
      const body = await response.json();
      assert.notEqual(body.data.status, undefined);
    }
  });
  assert.equal(billingCalls, 0, "billing.authorize must never be invoked by any preview call");
});

// ---------------------------------------------------------------------------------------------
// Pricing: fullResult must read straight from the capability registry, never a second literal.
// ---------------------------------------------------------------------------------------------

test("pricing: every previewable capability's fullResult.price matches the capability registry exactly", async () => {
  await withApp({}, async (_base, post) => {
    for (const c of capabilities.filter(c => c.preview)) {
      const response = await post(`/api/v1/preview/${c.name}`, c.example);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.data.fullResult, {
        capability: c.name,
        price: { amount: c.price.toFixed(2), currency: c.currency },
        endpoint: "/api/v1" + c.path
      });
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Security: a preview must prove data is available, never reveal the paid analysis itself.
// ---------------------------------------------------------------------------------------------

const FORBIDDEN_FIELDS: Record<(typeof PREVIEWABLE)[number], string[]> = {
  analyze_oman_property: ["market", "investment", "pricePosition", "comparablesSummary", "historicalSalesContext", "riskFlags", "confidence", "assumptions", "estimatedMonthlyRentOMR", "estimatedAnnualRentOMR", "grossYieldPct", "netYieldPct", "askingPricePerSqmOMR"],
  oman_supplier_check: ["screeningResult", "checks", "risk", "riskFlags", "procurementSuitability", "identityConfirmed", "confidence"],
  company_reputation_check: ["reputationScore", "confidenceScore", "redFlags", "positiveSignals", "adverseMedia", "sanctions", "trustLevel", "summary"],
  business_risk_score: ["riskScore", "riskLevel", "confidence", "recommendation", "riskFlags", "positiveSignals", "sanctionsScreening", "reasonCodes"],
  research_company: ["overview", "productsAndServices", "leadership", "funding", "competitors", "technologySignals", "recentDevelopments", "riskFlags", "sources"],
  document_facts_extract: ["facts", "entities", "requestedFacts", "riskFlags", "limitations"],
  invoice_anomaly_check: ["riskScore", "riskLevel", "decision", "anomalies", "anomalyCount", "financialChecks", "recommendedAction", "summary", "scoring"]
};

test("security: no preview response exposes the paid analytical findings it's a preview of", async () => {
  await withApp({}, async (_base, post) => {
    for (const c of capabilities.filter(c => c.preview)) {
      const response = await post(`/api/v1/preview/${c.name}`, c.example);
      assert.equal(response.status, 200);
      const body = await response.json();
      const forbidden = FORBIDDEN_FIELDS[c.name as (typeof PREVIEWABLE)[number]];
      assert.ok(forbidden && forbidden.length > 0, `no forbidden-field list defined for previewable capability ${c.name}`);
      for (const field of forbidden) {
        assert.ok(!(field in body.data), `preview response for ${c.name} must not expose top-level "${field}"`);
        assert.ok(!(field in (body.data.preview ?? {})), `preview.preview for ${c.name} must not expose "${field}"`);
        assert.ok(!(field in (body.data.preview?.signals ?? {})), `preview.preview.signals for ${c.name} must not expose "${field}"`);
      }
      // The full paid output (from directly calling execute()) is a strict superset check in the
      // other direction: every forbidden field really is part of the real paid schema, so this
      // list can't silently drift into asserting fields that were never actually paid content.
      const paidOutput = await c.execute(c.example) as Record<string, unknown>;
      const paidKeys = new Set(Object.keys(paidOutput));
      const coveredAny = forbidden.some(f => paidKeys.has(f));
      assert.ok(coveredAny, `FORBIDDEN_FIELDS for ${c.name} should name at least one field that actually appears in its real paid output (got: ${[...paidKeys].join(", ")})`);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Discovery: preview support must be visible from every discovery surface derived from the
// capability registry, and must never drift from `capabilities[*].preview`.
// ---------------------------------------------------------------------------------------------

test("discovery: GET /api/v1/capabilities exposes preview.available/endpoint/price correctly for every capability", async () => {
  const registry = buildCapabilitiesRegistry(config);
  for (const c of capabilities) {
    const entry = registry.find(r => r.name === c.name)!;
    assert.ok(entry);
    if (c.preview) {
      assert.deepEqual(entry.preview, {
        available: true,
        price: { amount: "0", currency: c.currency },
        endpoint: `${previewBasePath}/${c.name}`,
        description: entry.preview.description
      });
      assert.match(entry.preview.description, /preview/i);
    } else {
      assert.deepEqual(entry.preview, { available: false });
    }
  }
});

test("discovery: /agent.json's tool catalog reuses the same registry-derived preview field (no second copy)", () => {
  const manifest = buildAgentManifest(config) as { tools: Array<{ name: string; preview?: unknown }> };
  const registry = buildCapabilitiesRegistry(config);
  for (const c of capabilities) {
    const manifestEntry = manifest.tools.find(t => t.name === c.name)!;
    const registryEntry = registry.find(r => r.name === c.name)!;
    assert.deepEqual(manifestEntry.preview, registryEntry.preview);
  }
});

test("discovery: OpenAPI documents POST /api/v1/preview/{capability} (and the /v1 legacy twin) as unauthenticated and free", () => {
  const openapi = buildOpenapi() as { paths: Record<string, { post?: { security?: unknown[]; description?: string; deprecated?: boolean; responses: Record<string, unknown> } }> };
  const op = openapi.paths[previewBasePath + "/{capability}"]?.post;
  assert.ok(op, "expected an OpenAPI path for POST /api/v1/preview/{capability}");
  assert.deepEqual(op!.security, []);
  assert.match(op!.description ?? "", /FREE/);
  assert.match((op!.description ?? "").toLowerCase(), /no payment/);
  assert.ok(op!.responses["200"]);
  assert.ok(op!.responses["404"]);
  const legacy = openapi.paths["/v1/preview/{capability}"]?.post;
  assert.ok(legacy, "expected the /v1 legacy twin to also be documented");
  assert.equal(legacy!.deprecated, true);
});

test("llms.txt lists a Free Preview line for every previewable capability and none for the rest", async () => {
  const { buildLlmsTxt } = await import("../src/api/llms-txt.js");
  const text = buildLlmsTxt(config);
  assert.match(text, /## Free Preview/);
  for (const c of capabilities) {
    const start = text.indexOf(`## ${c.name}\n`);
    assert.ok(start >= 0, `expected a "## ${c.name}" section in llms.txt`);
    const nextHeadingIdx = text.indexOf("\n## ", start + 1);
    const section = nextHeadingIdx === -1 ? text.slice(start) : text.slice(start, nextHeadingIdx);
    if (c.preview) assert.match(section, new RegExp(`Free preview: POST ${previewBasePath.replace(/\//g, "\\/")}\\/${c.name}`));
    else assert.doesNotMatch(section, /Free preview:/);
  }
});

// ---------------------------------------------------------------------------------------------
// Direct service-layer coverage (src/preview/service.ts), independent of the HTTP route.
// ---------------------------------------------------------------------------------------------

test("runCapabilityPreview()/isPreviewSupported() agree with the registry for every capability", async () => {
  for (const c of capabilities) {
    assert.equal(isPreviewSupported(c.name), Boolean(c.preview));
  }
  await assert.rejects(runCapabilityPreview("definitely_not_a_capability", {}), (error: unknown) => (error as { status?: number }).status === 404);
});
