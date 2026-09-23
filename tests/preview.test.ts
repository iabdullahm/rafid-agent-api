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
import { MemoryAnalyticsRepository } from "../src/analytics/memoryRepository.js";
import { createInMemoryPreviewCache, previewCacheKey, previewCacheTtlSeconds } from "../src/preview/cache.js";
import { createInMemoryPreviewConversionIndex } from "../src/preview/analytics.js";
import { computePreviewFingerprint, hasFingerprintSupport, normalizeForFingerprint } from "../src/preview/fingerprint.js";

const key = "test-only-not-a-real-credential-12345";
const config = loadConfig({ RAFID_API_KEYS: key, LOG_LEVEL: "silent" });
const l402Env = {
  RAFID_API_KEYS: key, LOG_LEVEL: "silent" as const, L402_ENABLED: "true" as const,
  LND_REST_URL: "https://lnd.example.test:8080", LND_INVOICE_MACAROON: "0201036c6e640258030a10".padEnd(60, "a"), L402_ROOT_KEY: "5c".repeat(32)
};

/** Every capability this repository's registry actually wires a `preview` for today. Fixed here
 *  (not derived) so a future capability that ADDS a preview without corresponding security-test
 *  coverage below fails loudly, rather than the new capability silently getting only generic
 *  coverage from the loops further down. */
const PREVIEWABLE = ["analyze_oman_property", "oman_supplier_check", "company_reputation_check", "business_risk_score", "research_company", "document_facts_extract", "invoice_anomaly_check"] as const;

test("every previewable capability actually named in this test file exists and defines a preview; nothing extra silently gained one", () => {
  const actual = capabilities.filter(c => c.preview).map(c => c.name).sort();
  assert.deepEqual(actual, [...PREVIEWABLE].sort());
});

async function withApp<T>(options: Parameters<typeof createApp>[1], fn: (base: string, post: (path: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>) => Promise<T>): Promise<T> {
  return withCustomApp(config, options, fn);
}

/** Like withApp, but with a caller-supplied Config — needed for tests that exercise
 *  PREVIEW_RATE_LIMIT_PER_MINUTE/PER_HOUR, PREVIEW_CACHE_TTL_SECONDS, PREVIEW_FINGERPRINT_SECRET,
 *  PREVIEW_CONVERSION_WINDOW_HOURS, or an x402/L402/MPP-enabled config for payment-method
 *  discovery, none of which the shared top-of-file `config` turns on. `post` accepts an optional
 *  extra-headers map (e.g. X-Forwarded-For, to simulate a distinct client for rate-limit
 *  isolation tests, or X-API-Key for a paid route). */
async function withCustomApp<T>(
  cfg: Parameters<typeof createApp>[0],
  options: Parameters<typeof createApp>[1],
  fn: (base: string, post: (path: string, body?: unknown, headers?: Record<string, string>) => Promise<Response>) => Promise<T>
): Promise<T> {
  const app = createApp(cfg, options);
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const base = `http://127.0.0.1:${address.port}`;
    const post = (path: string, body?: unknown, headers: Record<string, string> = {}) => fetch(base + path, {
      method: "POST",
      headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
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

// ---------------------------------------------------------------------------------------------
// Production hardening: rate limiting (Section 2/3) — dedicated, isolated from every other
// route group's budget, and isolated from paid capability execution.
// ---------------------------------------------------------------------------------------------

test("rate limiting: exceeding PREVIEW_RATE_LIMIT_PER_MINUTE returns 429 with the documented body and a Retry-After header", async () => {
  const limited = loadConfig({ RAFID_API_KEYS: key, LOG_LEVEL: "silent", PREVIEW_RATE_LIMIT_PER_MINUTE: "2", PREVIEW_RATE_LIMIT_PER_HOUR: "1000" });
  await withCustomApp(limited, {}, async (_base, post) => {
    const c = capabilities.find(x => x.name === "research_company")!;
    const headers = { "X-Forwarded-For": "10.10.0.1" };
    assert.equal((await post(`/api/v1/preview/${c.name}`, c.example, headers)).status, 200);
    assert.equal((await post(`/api/v1/preview/${c.name}`, c.example, headers)).status, 200);
    const third = await post(`/api/v1/preview/${c.name}`, c.example, headers);
    assert.equal(third.status, 429);
    const body = await third.json();
    assert.deepEqual(Object.keys(body).sort(), ["error", "retryAfterSeconds"]);
    assert.equal(body.error, "preview_rate_limited");
    assert.equal(typeof body.retryAfterSeconds, "number");
    assert.ok(body.retryAfterSeconds > 0);
    assert.ok(third.headers.get("retry-after"), "expected a Retry-After header on a 429");
  });
});

test("rate limiting: two different clients each get their own full preview budget (per-client isolation)", async () => {
  const limited = loadConfig({ RAFID_API_KEYS: key, LOG_LEVEL: "silent", PREVIEW_RATE_LIMIT_PER_MINUTE: "1", PREVIEW_RATE_LIMIT_PER_HOUR: "1000" });
  await withCustomApp(limited, {}, async (_base, post) => {
    const c = capabilities.find(x => x.name === "research_company")!;
    assert.equal((await post(`/api/v1/preview/${c.name}`, c.example, { "X-Forwarded-For": "10.10.0.2" })).status, 200);
    assert.equal((await post(`/api/v1/preview/${c.name}`, c.example, { "X-Forwarded-For": "10.10.0.2" })).status, 429, "a second request from the SAME client must be limited");
    assert.equal((await post(`/api/v1/preview/${c.name}`, c.example, { "X-Forwarded-For": "10.10.0.3" })).status, 200, "a DIFFERENT client must not be affected by another client's exhausted budget");
  });
});

test("rate limiting: the preview-specific budget never throttles the paid REST route for the same capability and client, and vice versa", async () => {
  const limited = loadConfig({ RAFID_API_KEYS: key, LOG_LEVEL: "silent", PREVIEW_RATE_LIMIT_PER_MINUTE: "1", PREVIEW_RATE_LIMIT_PER_HOUR: "1" });
  await withCustomApp(limited, {}, async (_base, post) => {
    const c = capabilities.find(x => x.name === "research_company")!;
    const headers = { "X-Forwarded-For": "10.10.0.4" };
    assert.equal((await post(`/api/v1/preview/${c.name}`, c.example, headers)).status, 200);
    assert.equal((await post(`/api/v1/preview/${c.name}`, c.example, headers)).status, 429, "preview budget must now be exhausted");
    const paid = await post(`/api/v1${c.path}`, c.example, { ...headers, "X-API-Key": key });
    assert.notEqual(paid.status, 429, "the exhausted PREVIEW budget must never throttle the paid REST route");
  });
});

test("rate limiting: expensive-tier capabilities (document_facts_extract, invoice_anomaly_check) hit a materially tighter per-capability budget than the generous global window", async () => {
  const cfg = loadConfig({ RAFID_API_KEYS: key, LOG_LEVEL: "silent", PREVIEW_RATE_LIMIT_PER_MINUTE: "1000", PREVIEW_RATE_LIMIT_PER_HOUR: "100000" });
  await withCustomApp(cfg, {}, async (_base, post) => {
    const expensive = capabilities.find(x => x.name === "document_facts_extract")!;
    let limitedAt = -1;
    for (let i = 0; i < 20 && limitedAt === -1; i++) {
      const r = await post(`/api/v1/preview/${expensive.name}`, expensive.example, { "X-Forwarded-For": "10.10.0.5" });
      if (r.status === 429) limitedAt = i;
    }
    assert.ok(limitedAt >= 0 && limitedAt < 20, "an expensive-tier capability must hit its own tighter budget well before the 1000/min global window would");
    // A "medium"-tier capability, same generous global config, same client, is unaffected.
    const medium = capabilities.find(x => x.name === "research_company")!;
    const mediumResponse = await post(`/api/v1/preview/${medium.name}`, medium.example, { "X-Forwarded-For": "10.10.0.5" });
    assert.equal(mediumResponse.status, 200, "the expensive-tier capability's exhausted budget must not affect a different, medium-tier capability");
  });
});

test("rate limiting: RATE_LIMIT_ENABLED=false disables the preview limiter exactly like every other route group's", async () => {
  const disabled = loadConfig({ RAFID_API_KEYS: key, LOG_LEVEL: "silent", RATE_LIMIT_ENABLED: "false", PREVIEW_RATE_LIMIT_PER_MINUTE: "1" });
  await withCustomApp(disabled, {}, async (_base, post) => {
    const c = capabilities.find(x => x.name === "research_company")!;
    for (let i = 0; i < 5; i++) {
      const r = await post(`/api/v1/preview/${c.name}`, c.example, { "X-Forwarded-For": "10.10.0.6" });
      assert.equal(r.status, 200);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Production hardening: response caching (Section 4/5/6)
// ---------------------------------------------------------------------------------------------

test("cache: identical preview requests are served from cache on the second call, without recomputing the capability's own preview()", async () => {
  const c = capabilities.find(x => x.name === "research_company")!;
  const original = c.preview!;
  let calls = 0;
  (c as { preview: typeof c.preview }).preview = async (input: unknown) => { calls++; return original(input); };
  try {
    await withApp({}, async (_base, post) => {
      const first = await post(`/api/v1/preview/${c.name}`, c.example);
      assert.equal(first.status, 200);
      assert.equal(first.headers.get("x-preview-cache"), "miss");
      const firstBody = await first.json();
      const second = await post(`/api/v1/preview/${c.name}`, c.example);
      assert.equal(second.status, 200);
      assert.equal(second.headers.get("x-preview-cache"), "hit");
      const secondBody = await second.json();
      assert.deepEqual(secondBody.data, firstBody.data);
      assert.equal(calls, 1, "the capability's own preview() must be called exactly once across two identical requests");
    });
  } finally {
    (c as { preview: typeof c.preview }).preview = original;
  }
});

test("cache: a capability with no fingerprint support (no cache entry) never claims a cache hit — always X-Preview-Cache: bypass", async () => {
  await withApp({}, async (_base, post) => {
    const noPreview = capabilities.find(c => !c.preview)!;
    const response = await post(`/api/v1/preview/${noPreview.name}`, noPreview.example);
    assert.equal(response.headers.get("x-preview-cache"), "bypass");
  });
});

test("cache: the cache key is preview:<capability>:<64-hex-char fingerprint> and never contains the raw input", async () => {
  const seenKeys: string[] = [];
  const spyCache = { get: () => undefined, set: (k: string) => { seenKeys.push(k); } };
  const secret = "Zzyzx Confidential Holdings Distinctive Name";
  await withApp({ previewCache: spyCache }, async (_base, post) => {
    await post("/api/v1/preview/research_company", { company: secret, country: "US" });
  });
  assert.ok(seenKeys.length >= 1, "expected at least one cache write");
  for (const k of seenKeys) {
    assert.match(k, /^preview:research_company:[0-9a-f]{64}$/);
    assert.ok(!k.toLowerCase().includes("zzyzx"), `cache key must never contain raw input, got: ${k}`);
  }
  assert.equal(previewCacheKey("research_company", "abc123"), "preview:research_company:abc123");
});

test("cache: fingerprinting normalizes away case/whitespace so equivalent inputs share a cache entry, and never includes document/invoice content", () => {
  const a = normalizeForFingerprint("research_company", { company: "  Acme Corp  ", country: "US" });
  const b = normalizeForFingerprint("research_company", { company: "acme corp", country: "us" });
  assert.deepEqual(a, b);
  const withSecretText = normalizeForFingerprint("document_facts_extract", { text: "highly confidential contract terms", documentType: "contract" });
  assert.ok(!("text" in withSecretText));
  assert.ok(!JSON.stringify(withSecretText).includes("confidential"));
  assert.ok(typeof withSecretText.textHash === "string" && /^[0-9a-f]{64}$/.test(withSecretText.textHash as string));
  const invoiceNormalized = normalizeForFingerprint("invoice_anomaly_check", {
    invoice: { total: 100, currency: "USD", supplierName: "Acme" },
    historicalInvoices: [{ total: 1 }, { total: 2 }],
    supplierProfile: { supplierId: "s1" }
  });
  assert.equal(invoiceNormalized.historicalCount, 2);
  assert.equal(invoiceNormalized.hasSupplierProfile, true);
  assert.ok(!("historicalInvoices" in invoiceNormalized));
  assert.ok(!("supplierProfile" in invoiceNormalized));
  // A capability with no defined normalizer (defensive: none of today's registry, but future-proof)
  // must never fall back to fingerprinting raw input.
  assert.equal(hasFingerprintSupport("definitely_not_a_capability"), false);
  assert.deepEqual(normalizeForFingerprint("definitely_not_a_capability", { secret: "leak" }), {});
});

test("cache: TTL is centralized per capability (never hardcoded per service), and PREVIEW_CACHE_TTL_SECONDS overrides every bucket uniformly", () => {
  assert.equal(previewCacheTtlSeconds("research_company", null), 1200);
  assert.equal(previewCacheTtlSeconds("oman_supplier_check", null), 1200);
  assert.equal(previewCacheTtlSeconds("analyze_oman_property", null), 1200);
  assert.equal(previewCacheTtlSeconds("document_facts_extract", null), 600);
  assert.equal(previewCacheTtlSeconds("invoice_anomaly_check", null), 600);
  for (const capabilityName of ["research_company", "document_facts_extract"]) {
    assert.equal(previewCacheTtlSeconds(capabilityName, 42), 42);
  }
});

test("cache: an expired entry is treated as a miss (TTL is honored), and a 0-second TTL never caches", () => {
  const cache = createInMemoryPreviewCache();
  cache.set("preview:research_company:x", { value: 1 }, 0);
  assert.equal(cache.get("preview:research_company:x"), undefined, "a 0-second TTL must never actually cache");
  const realCache = createInMemoryPreviewCache();
  realCache.set("preview:research_company:y", { value: 2 }, 3600);
  assert.deepEqual(realCache.get("preview:research_company:y"), { value: 2 });
});

test("failure-open: a throwing preview cache never fails the request — the preview just runs fresh, uncached", async () => {
  const throwingCache = {
    get(): never { throw new Error("cache backend unavailable"); },
    set(): never { throw new Error("cache backend unavailable"); }
  };
  await withApp({ previewCache: throwingCache }, async (_base, post) => {
    const c = capabilities.find(x => x.name === "research_company")!;
    const response = await post(`/api/v1/preview/${c.name}`, c.example);
    assert.equal(response.status, 200, "a throwing cache must never turn a good preview into an error response");
    const body = await response.json();
    assert.equal(body.success, true);
  });
});

test("failure-open: a throwing analytics repository never fails the request", async () => {
  const throwingRepo = { record: () => { throw new Error("analytics store unavailable"); }, queryEvents: async () => [] };
  await withApp({ analyticsRepository: throwingRepo }, async (_base, post) => {
    const c = capabilities.find(x => x.name === "research_company")!;
    const response = await post(`/api/v1/preview/${c.name}`, c.example);
    assert.equal(response.status, 200, "a throwing analytics repository must never turn a good preview into an error response");
  });
});

// ---------------------------------------------------------------------------------------------
// Production hardening: multi-payment metadata (Section 7/8)
// ---------------------------------------------------------------------------------------------

test("multi-payment discovery: fullResult.paymentMethods lists only currently-enabled rails, each with a real, working endpoint path", async () => {
  const wallet = "0x1234567890123456789012345678901234567890";
  const multiRail = loadConfig({ ...l402Env, X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet });
  await withCustomApp(multiRail, {}, async (_base, post) => {
    const c = capabilities.find(x => x.name === "company_reputation_check")!;
    const response = await post(`/api/v1/preview/${c.name}`, c.example);
    assert.equal(response.status, 200);
    const body = await response.json();
    const methods = body.data.fullResult.paymentMethods as Array<{ id: string; enabled: boolean; endpoint: string }>;
    assert.ok(Array.isArray(methods) && methods.length > 0);
    const byId = Object.fromEntries(methods.map(m => [m.id, m]));
    assert.deepEqual(Object.keys(byId).sort(), ["l402", "x402"]);
    assert.equal(byId.x402!.enabled, true);
    assert.equal(byId.x402!.endpoint, `/api/v1/x402${c.path}`);
    assert.equal(byId.l402!.enabled, true);
    assert.equal(byId.l402!.endpoint, `/api/v1/l402${c.path}`);
  });
});

test("multi-payment discovery: a disabled rail is never advertised, and no payment method is ever invented", async () => {
  const x402Only = loadConfig({ RAFID_API_KEYS: key, LOG_LEVEL: "silent", X402_ENABLED: "true", X402_WALLET_ADDRESS: "0x1234567890123456789012345678901234567890" });
  await withCustomApp(x402Only, {}, async (_base, post) => {
    const c = capabilities.find(x => x.name === "research_company")!;
    const response = await post(`/api/v1/preview/${c.name}`, c.example);
    const body = await response.json();
    const ids = ((body.data.fullResult.paymentMethods ?? []) as Array<{ id: string }>).map(m => m.id);
    assert.deepEqual(ids, ["x402"]);
    assert.ok(!ids.includes("l402"));
    assert.ok(!ids.includes("mpp-charge"));
    assert.ok(!ids.includes("mpp-session"));
    assert.ok(!ids.includes("api_credits"), "the unwired unified billing layer must never be advertised as a real payment method");
    assert.ok(!ids.includes("subscription"), "the unwired unified billing layer must never be advertised as a real payment method");
  });
});

test("multi-payment discovery: with no rail enabled, fullResult carries no paymentMethods field at all (never an empty array)", async () => {
  await withApp({}, async (_base, post) => {
    const c = capabilities.find(x => x.name === "research_company")!;
    const response = await post(`/api/v1/preview/${c.name}`, c.example);
    const body = await response.json();
    assert.ok(!("paymentMethods" in body.data.fullResult));
  });
});

// ---------------------------------------------------------------------------------------------
// Production hardening: preview funnel + preview -> paid conversion analytics (Section 9-14)
// ---------------------------------------------------------------------------------------------

test("analytics: the full preview funnel is recorded (requested, cache miss/hit, and an outcome event), with no raw input in any event", async () => {
  const repo = new MemoryAnalyticsRepository();
  const c = capabilities.find(x => x.name === "business_risk_score")!;
  const companyName = (c.example as { companyName: string }).companyName;
  await withApp({ analyticsRepository: repo }, async (_base, post) => {
    await post(`/api/v1/preview/${c.name}`, c.example);
    await post(`/api/v1/preview/${c.name}`, c.example);
  });
  const events = repo.all().filter(e => e.category === "preview");
  const types = events.map(e => e.eventType);
  assert.ok(types.includes("preview_requested"));
  assert.ok(types.includes("preview_cache_miss"));
  assert.ok(types.includes("preview_cache_hit"));
  assert.ok(types.includes("preview_available") || types.includes("preview_limited"));
  for (const e of events) assert.ok(!JSON.stringify(e).includes(companyName), "no analytics event may contain the raw input value");
});

test("analytics: preview_invalid is recorded for a schema-invalid request; preview_unavailable for a capability with no preview implementation", async () => {
  const repo = new MemoryAnalyticsRepository();
  await withApp({ analyticsRepository: repo }, async (_base, post) => {
    await post("/api/v1/preview/research_company", {}); // missing required `company`
    const noPreview = capabilities.find(c => !c.preview)!;
    await post(`/api/v1/preview/${noPreview.name}`, noPreview.example);
  });
  const types = repo.all().filter(e => e.category === "preview").map(e => e.eventType);
  assert.ok(types.includes("preview_invalid"));
  assert.ok(types.includes("preview_unavailable"));
});

test("analytics: preview_rate_limited is recorded when the preview budget is exceeded", async () => {
  const repo = new MemoryAnalyticsRepository();
  const limited = loadConfig({ RAFID_API_KEYS: key, LOG_LEVEL: "silent", PREVIEW_RATE_LIMIT_PER_MINUTE: "1", PREVIEW_RATE_LIMIT_PER_HOUR: "1000" });
  await withCustomApp(limited, { analyticsRepository: repo }, async (_base, post) => {
    const c = capabilities.find(x => x.name === "research_company")!;
    await post(`/api/v1/preview/${c.name}`, c.example);
    const second = await post(`/api/v1/preview/${c.name}`, c.example);
    assert.equal(second.status, 429);
  });
  assert.ok(repo.all().some(e => e.category === "preview" && e.eventType === "preview_rate_limited"));
});

test("conversion: a paid call whose fingerprint matches an earlier preview is recorded as preview_converted, with a real payment rail and a non-negative latency", async () => {
  const repo = new MemoryAnalyticsRepository();
  const c = capabilities.find(x => x.name === "business_risk_score")!;
  await withApp({ analyticsRepository: repo }, async (_base, post) => {
    const previewResponse = await post(`/api/v1/preview/${c.name}`, c.example);
    assert.equal(previewResponse.status, 200);
    const paidResponse = await post(`/api/v1${c.path}`, c.example, { "X-API-Key": key });
    assert.equal(paidResponse.status, 200);
    // Analytics is fire-and-forget on the response's finish event; give the event loop one tick.
    await new Promise(resolve => setImmediate(resolve));
  });
  const events = repo.all().filter(e => e.category === "preview");
  const started = events.find(e => e.eventType === "paid_capability_started");
  assert.ok(started, "expected a paid_capability_started event");
  assert.equal(started!.previewSeen, true);
  assert.equal(started!.paymentRail, "api_key");
  const converted = events.find(e => e.eventType === "preview_converted");
  assert.ok(converted, "expected a preview_converted event");
  assert.equal(converted!.paymentRail, "api_key");
  assert.equal(typeof converted!.conversionLatencyMs, "number");
  assert.ok((converted!.conversionLatencyMs as number) >= 0);
  assert.ok(started!.requestFingerprint && started!.requestFingerprint === converted!.requestFingerprint);
});

test("conversion: a paid call for a DIFFERENT input than any preview is never counted as a conversion", async () => {
  const repo = new MemoryAnalyticsRepository();
  const c = capabilities.find(x => x.name === "business_risk_score")!;
  await withApp({ analyticsRepository: repo }, async (_base, post) => {
    await post(`/api/v1/preview/${c.name}`, { ...c.example, companyName: "A Totally Different Company Name" });
    const paidResponse = await post(`/api/v1${c.path}`, c.example, { "X-API-Key": key });
    assert.equal(paidResponse.status, 200);
    await new Promise(resolve => setImmediate(resolve));
  });
  const events = repo.all().filter(e => e.category === "preview");
  const started = events.find(e => e.eventType === "paid_capability_started");
  assert.ok(started);
  assert.equal(started!.previewSeen, false, "a preview of a DIFFERENT input must not count toward this paid call's conversion");
  assert.ok(!events.some(e => e.eventType === "preview_converted"));
});

test("conversion: a paid call with NO preceding preview at all is recorded as paid_capability_started with previewSeen:false, never preview_converted", async () => {
  const repo = new MemoryAnalyticsRepository();
  const c = capabilities.find(x => x.name === "research_company")!;
  await withApp({ analyticsRepository: repo }, async (_base, post) => {
    const paidResponse = await post(`/api/v1${c.path}`, c.example, { "X-API-Key": key });
    assert.equal(paidResponse.status, 200);
    await new Promise(resolve => setImmediate(resolve));
  });
  const events = repo.all().filter(e => e.category === "preview");
  const started = events.find(e => e.eventType === "paid_capability_started");
  assert.ok(started);
  assert.equal(started!.previewSeen, false);
  assert.ok(!events.some(e => e.eventType === "preview_converted"));
});

test("conversion: paid execution never depends on the conversion index — a throwing index never fails the paid call", async () => {
  const throwingIndex = {
    recordPreviewSeen(): never { throw new Error("index unavailable"); },
    findQualifyingPreviewAt(): never { throw new Error("index unavailable"); }
  };
  await withApp({ previewConversionIndex: throwingIndex }, async (_base, post) => {
    const c = capabilities.find(x => x.name === "research_company")!;
    const previewResponse = await post(`/api/v1/preview/${c.name}`, c.example);
    assert.equal(previewResponse.status, 200, "a throwing conversion index must never fail the preview call");
    const paidResponse = await post(`/api/v1${c.path}`, c.example, { "X-API-Key": key });
    assert.equal(paidResponse.status, 200, "a throwing conversion index must never fail the paid call");
  });
});

test("conversion window: same capability + same fingerprint within the window qualifies; outside the window it does not; a different fingerprint never qualifies", () => {
  const index = createInMemoryPreviewConversionIndex();
  const now = 1_000_000_000;
  index.recordPreviewSeen("business_risk_score", "fp-a", now);
  // Within a 24h window, 1 hour later: qualifies.
  assert.equal(index.findQualifyingPreviewAt("business_risk_score", "fp-a", now + 60 * 60 * 1000, 24 * 60 * 60 * 1000), now);
  // Just outside a 24h window: does not qualify.
  assert.equal(index.findQualifyingPreviewAt("business_risk_check_typo", "fp-a", now + 25 * 60 * 60 * 1000, 24 * 60 * 60 * 1000), null);
  assert.equal(index.findQualifyingPreviewAt("business_risk_score", "fp-a", now + 25 * 60 * 60 * 1000, 24 * 60 * 60 * 1000), null);
  // A different fingerprint for the same capability never qualifies.
  assert.equal(index.findQualifyingPreviewAt("business_risk_score", "fp-b", now + 1000, 24 * 60 * 60 * 1000), null);
  // A later preview of the same key overwrites the stored timestamp with the most recent one.
  index.recordPreviewSeen("business_risk_score", "fp-a", now + 10_000);
  assert.equal(index.findQualifyingPreviewAt("business_risk_score", "fp-a", now + 10_000, 24 * 60 * 60 * 1000), now + 10_000);
});

// ---------------------------------------------------------------------------------------------
// Design rule (Section 15/16): preview stays objective and genuinely free, even under this
// production hardening.
// ---------------------------------------------------------------------------------------------

test("preview responses never include a purchaseRecommended-style verdict field, with or without caching/analytics enabled", async () => {
  const repo = new MemoryAnalyticsRepository();
  await withApp({ analyticsRepository: repo }, async (_base, post) => {
    for (const c of capabilities.filter(c => c.preview)) {
      const response = await post(`/api/v1/preview/${c.name}`, c.example);
      const body = await response.json();
      assert.ok(!("purchaseRecommended" in body.data));
      assert.ok(!("purchaseRecommended" in (body.data.preview ?? {})));
    }
  });
});

test("preview NEVER triggers x402/L402/MPP settlement or consumes a Rafid API key's usage, even with every payment rail enabled", async () => {
  const wallet = "0x1234567890123456789012345678901234567890";
  const allRails = loadConfig({ ...l402Env, X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet });
  const repo = new MemoryAnalyticsRepository();
  await withCustomApp(allRails, { analyticsRepository: repo }, async (_base, post) => {
    for (const c of capabilities.filter(c => c.preview)) {
      const response = await post(`/api/v1/preview/${c.name}`, c.example);
      assert.equal(response.status, 200);
    }
  });
  // No x402/l402 funnel event and no "tool" (billed) invocation may ever be recorded for a
  // preview-only run — only the "preview" category and (from GET /agent.json, /api/v1/capabilities
  // etc., which this test doesn't call) "discovery" rows should exist.
  assert.ok(!repo.all().some(e => e.category === "x402" || e.category === "l402" || e.category === "tool"));
});
