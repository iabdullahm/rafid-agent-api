import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { ZodError } from "zod";
import { analyzeOmanProperty } from "../src/services/omanProperty.js";
import { normalizeLocation, MUSCAT_GOVERNORATE, SUPPORTED_MUSCAT_AREAS } from "../src/domain/oman/locations.js";
import { selectComparables, computeRangeStats, MIN_COMPARABLES } from "../src/domain/oman/comparables.js";
import { computeConfidence } from "../src/domain/oman/confidence.js";
import { normalizedMonthlyRent } from "../src/domain/oman/types.js";
import { RENTAL_FIXTURES, SALE_FIXTURES } from "../src/domain/oman/fixtures.js";
import { capabilities } from "../src/domain/capabilities.js";
import { prices } from "../src/billing/catalog.js";
import { buildOpenapi } from "../src/api/openapi.js";
import { buildX402Info } from "../src/billing/x402.js";
import { BillingService } from "../src/billing/service.js";
import { createApp } from "../src/api/app.js";
import { loadConfig } from "../src/config/env.js";

const capability = capabilities.find(c => c.name === "analyze_oman_property")!;
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

// ---------------------------------------------------------------------------------------------
// Valid Al Mouj apartment (happy path) — richly populated market/investment output, one outlier
// correctly excluded, sale side honestly reported as insufficient in this example.
// ---------------------------------------------------------------------------------------------
test("analyze_oman_property: valid Al Mouj apartment produces a fully populated, internally consistent result", async () => {
  const result = await analyzeOmanProperty({
    governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: 2, sizeSqm: 130, askingPriceOMR: 118000
  }) as any;

  assert.deepEqual(result.normalizedLocation, { governorate: "Muscat", wilayat: "Muscat", area: "Al Mouj", inputArea: "Al Mouj", matchType: "exact", supported: true });
  assert.equal(result.subjectProperty.furnished, "unspecified");
  assert.equal(result.market.comparableCount, 4);
  assert.equal(result.market.sampleSizeUsed, 3);
  assert.deepEqual(result.market.estimatedMonthlyRentOMR, { low: 696.43, median: 731.25, high: 731.85 });
  assert.equal(result.market.estimatedAnnualRentOMR, 8775);
  assert.equal(result.investment.grossYieldPct, 7.44);
  assert.equal(result.investment.estimatedOperatingCostOMR, 0);
  assert.equal(result.investment.estimatedNetIncomeOMR, 8775);
  assert.equal(result.investment.netYieldPct, 7.44);
  assert.equal(result.pricePosition.askingPricePerSqmOMR, 907.69);
  assert.deepEqual(result.comparablesSummary, { medianRentPerSqm: 5.63, lowRentPerSqm: 5.36, highRentPerSqm: 5.63 });
  assert.equal(result.insufficientMarketData, false);
  assert.equal(result.confidence.level, "high");
  assert.ok(result.confidence.score > 0 && result.confidence.score <= 1);
  assert.ok(result.riskFlags.includes("demo_dataset_not_live_market_data"));
  assert.ok(result.riskFlags.includes("outliers_removed"));
  assert.equal(result.currency, "OMR");
  assert.equal(result.dataQuality.sampleSize, 3);
  assert.equal(result.dataQuality.sourceTypes.length, 1);
  assert.equal(result.dataQuality.sourceTypes[0], "manual_benchmark");
  assert.equal(result.dataQuality.staleMarketData, false);
  assert.ok(capability.output.safeParse(result).success, "result must satisfy the capability's own strict output schema");
});

test("analyze_oman_property: never claims a hard-coded good/bad investment verdict", async () => {
  const result = await analyzeOmanProperty(capability.example) as any;
  const serialized = JSON.stringify(result).toLowerCase();
  for (const verdict of ["good investment", "bad investment", "recommend", "should buy", "should not buy"]) {
    assert.ok(!serialized.includes(verdict), `unexpected verdict language: ${verdict}`);
  }
});

// ---------------------------------------------------------------------------------------------
// Location normalization — Arabic and English variants
// ---------------------------------------------------------------------------------------------
test("analyze_oman_property: Arabic location normalization (الموج / مسقط) resolves to the canonical Al Mouj / Muscat", async () => {
  const result = await analyzeOmanProperty({ governorate: "مسقط", area: "الموج", propertyType: "apartment", bedrooms: 2, sizeSqm: 130, askingPriceOMR: 118000 }) as any;
  assert.deepEqual(result.normalizedLocation, { governorate: "Muscat", wilayat: "Muscat", area: "Al Mouj", inputArea: "الموج", matchType: "alias", supported: true });
});

test("analyze_oman_property: English alias normalization ('the wave', case-insensitive governorate) resolves to Al Mouj / Muscat", async () => {
  const result = await analyzeOmanProperty({ governorate: "muscat", area: "the wave", propertyType: "apartment", bedrooms: 2, sizeSqm: 130, askingPriceOMR: 118000 }) as any;
  assert.deepEqual(result.normalizedLocation, { governorate: "Muscat", wilayat: "Muscat", area: "Al Mouj", inputArea: "the wave", matchType: "alias", supported: true });
});

test("normalizeLocation: exact canonical spelling reports matchType 'exact'; an unlisted place name is 'unmatched' rather than guessed", () => {
  assert.equal(normalizeLocation({ governorate: "Muscat", area: "Al Mouj" }).matchType, "exact");
  const unmatched = normalizeLocation({ governorate: "Muscat", area: "Some Made Up Place" });
  assert.equal(unmatched.matchType, "unmatched");
  assert.equal(unmatched.supported, false);
  assert.equal(unmatched.area, "Some Made Up Place"); // never rewritten to a guessed canonical name
});

test("MUSCAT_GOVERNORATE / SUPPORTED_MUSCAT_AREAS document exactly the coverage this MVP has data for", () => {
  assert.equal(MUSCAT_GOVERNORATE, "Muscat");
  assert.deepEqual([...SUPPORTED_MUSCAT_AREAS], ["Al Mouj", "Muscat Hills", "Qurum", "Bausher", "Azaiba", "Al Khuwair", "Madinat Al Irfan", "Ghubrah"]);
});

// ---------------------------------------------------------------------------------------------
// Fallback behavior — small sample, zero data, unsupported location (Section 10)
// ---------------------------------------------------------------------------------------------
test("analyze_oman_property: small comparable sample (Al Mouj townhouse) withholds market data honestly rather than guessing", async () => {
  const result = await analyzeOmanProperty({ governorate: "Muscat", area: "Al Mouj", propertyType: "townhouse", bedrooms: 3, sizeSqm: 240, askingPriceOMR: 195000 }) as any;
  assert.equal(result.market.comparableCount, 2);
  assert.equal(result.market.sampleSizeUsed, 2);
  assert.ok(result.market.sampleSizeUsed < MIN_COMPARABLES);
  assert.equal(result.market.estimatedMonthlyRentOMR, null);
  assert.equal(result.investment.grossYieldPct, null);
  assert.equal(result.insufficientMarketData, true);
  assert.equal(result.confidence.level, "insufficient");
  assert.ok(result.unavailableOutputs.includes("market.estimatedMonthlyRentOMR"));
  assert.ok(result.unavailableOutputs.includes("investment.grossYieldPct"));
  // Deterministic figures that don't depend on market data are still returned.
  assert.equal(result.pricePosition.askingPricePerSqmOMR, 812.5);
  // Phase 7: dataQuality still reports what little data existed, even below MIN_COMPARABLES.
  assert.equal(result.dataQuality.sampleSize, 2);
  assert.ok(result.dataQuality.dataFreshnessDays !== null);
  assert.ok(capability.output.safeParse(result).success);
});

test("analyze_oman_property: no comparable data at all (Qurum villas) returns insufficientMarketData with zero fabricated figures", async () => {
  const result = await analyzeOmanProperty({ governorate: "Muscat", area: "Qurum", propertyType: "villa", bedrooms: 3, sizeSqm: 300, askingPriceOMR: 250000 }) as any;
  assert.equal(result.market.comparableCount, 0);
  assert.equal(result.market.sampleSizeUsed, 0);
  assert.equal(result.market.dataFreshnessDays, null);
  assert.equal(result.provenance.length, 0);
  assert.equal(result.pricePosition.marketPosition, "insufficient_data");
  assert.equal(result.insufficientMarketData, true);
  assert.equal(result.confidence.score, 0);
  assert.equal(result.confidence.level, "insufficient");
  assert.deepEqual(result.dataQuality, { latestDataDate: null, dataFreshnessDays: null, sampleSize: 0, sourceTypes: [], staleMarketData: false });
});

test("analyze_oman_property: unsupported area is reported honestly, never guessed at, and deterministic figures still compute", async () => {
  const result = await analyzeOmanProperty({ governorate: "Muscat", area: "Nowhereville", propertyType: "apartment", sizeSqm: 100, askingPriceOMR: 50000 }) as any;
  assert.equal(result.normalizedLocation.matchType, "unmatched");
  assert.equal(result.normalizedLocation.supported, false);
  assert.equal(result.insufficientMarketData, true);
  assert.ok(result.riskFlags.includes("unsupported_location"));
  assert.equal(result.pricePosition.askingPricePerSqmOMR, 500);
  assert.equal(result.investment.estimatedOperatingCostOMR, 0);
  assert.deepEqual(result.dataQuality, { latestDataDate: null, dataFreshnessDays: null, sampleSize: 0, sourceTypes: [], staleMarketData: false });
});

test("analyze_oman_property: unsupported governorate is reported honestly even when the area name itself is recognized", async () => {
  const result = await analyzeOmanProperty({ governorate: "Dhofar", area: "Al Mouj", propertyType: "apartment", sizeSqm: 100, askingPriceOMR: 50000 }) as any;
  assert.equal(result.normalizedLocation.supported, false);
  assert.equal(result.normalizedLocation.governorate, "Dhofar");
  assert.equal(result.insufficientMarketData, true);
  assert.ok(result.assumptions.some((a: string) => a.includes("Dhofar")));
});

// ---------------------------------------------------------------------------------------------
// Outlier removal, rent normalization, furnished mismatch, property-type isolation, size tolerance
// ---------------------------------------------------------------------------------------------
test("analyze_oman_property: outlier removal excludes a statistically extreme comparable from the estimate", async () => {
  const result = await analyzeOmanProperty({ governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: 2, sizeSqm: 130, askingPriceOMR: 118000 }) as any;
  assert.equal(result.market.comparableCount, 4); // includes the outlier record
  assert.equal(result.market.sampleSizeUsed, 3); // outlier excluded from the used sample
  assert.ok(result.riskFlags.includes("outliers_removed"));
  assert.ok(result.assumptions.some((a: string) => /outlier/i.test(a)));
  // Had the outlier (2400/mo on 130 sqm) been included, the median would be far higher than this.
  assert.ok(result.market.estimatedMonthlyRentOMR.median < 1000);
});

test("normalizedMonthlyRent: monthly/annual rent normalization is a pure, deterministic conversion", () => {
  assert.equal(normalizedMonthlyRent({ rentAmountOMR: 600, rentPeriod: "monthly" } as any), 600);
  assert.equal(normalizedMonthlyRent({ rentAmountOMR: 7200, rentPeriod: "annual" } as any), 600);
});

test("analyze_oman_property: an annually-quoted comparable contributes its normalized monthly equivalent, not the raw annual figure", async () => {
  // rent-6 in the fixture set (Al Mouj apartment, 2 bed, 140 sqm) is quoted as 9000/year — its
  // normalized monthly rent (750) must land inside the used sample's low/high band, not 9000.
  const result = await analyzeOmanProperty({ governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: 2, sizeSqm: 130, askingPriceOMR: 118000 }) as any;
  assert.ok(result.market.estimatedMonthlyRentOMR.high < 1000, "an un-normalized annual figure (9000) would blow far past this band");
});

test("analyze_oman_property: furnished-status mismatch relaxes the filter (with no exact match) instead of returning zero comparables", async () => {
  const base = { governorate: "Muscat", area: "Al Mouj", propertyType: "apartment" as const, bedrooms: 2, sizeSqm: 130, askingPriceOMR: 118000 };
  const unfiltered = await analyzeOmanProperty(base) as any;
  const withFurnished = await analyzeOmanProperty({ ...base, furnished: "unfurnished" as const }) as any;
  // No "unfurnished" 2-bed Al Mouj apartment exists in the fixture set, so the filter must relax
  // rather than starve the sample to zero.
  assert.ok(withFurnished.riskFlags.includes("furnished_filter_relaxed"));
  assert.ok(withFurnished.assumptions.some((a: string) => /furnished/i.test(a)));
  assert.equal(withFurnished.market.sampleSizeUsed, unfiltered.market.sampleSizeUsed);
});

test("selectComparables: property-type isolation — a villa is never matched against an apartment query", () => {
  const selection = selectComparables(RENTAL_FIXTURES, { area: "Al Mouj", propertyType: "apartment", bedrooms: 2, sizeSqm: 130 }, normalizedMonthlyRent);
  assert.ok(selection.candidatePool.every(r => r.propertyType === "apartment"));
  assert.ok(selection.used.every(r => r.propertyType === "apartment"));
  assert.ok(selection.candidatePool.length > 0);
});

test("selectComparables: size tolerance is a hard ±20% boundary, inclusive at the edge", () => {
  const base = { id: "x", area: "TestArea", propertyType: "apartment" as const, bedrooms: 2, furnished: "unfurnished" as const, listedDaysAgo: 30, sourceType: "manual_benchmark" as const, sourceName: "test", sourceDate: "2026-01-01" };
  const pool = [
    { ...base, id: "at-boundary", sizeSqm: 120, rentAmountOMR: 500, rentPeriod: "monthly" as const },
    { ...base, id: "just-outside", sizeSqm: 121, rentAmountOMR: 500, rentPeriod: "monthly" as const }
  ];
  const selection = selectComparables(pool, { area: "TestArea", propertyType: "apartment", sizeSqm: 100 }, normalizedMonthlyRent);
  const idsInPool = selection.candidatePool.map(r => r.id);
  assert.ok(idsInPool.includes("at-boundary"), "100 * 1.20 = 120 must be included (inclusive boundary)");
  assert.ok(!idsInPool.includes("just-outside"), "121 is outside the ±20% tolerance and must be excluded");
});

// ---------------------------------------------------------------------------------------------
// Confidence engine — deterministic, never model-invented
// ---------------------------------------------------------------------------------------------
test("computeConfidence: below the minimum comparable threshold always returns score 0 / level 'insufficient', regardless of other factors", () => {
  const result = computeConfidence({
    sampleSizeUsed: MIN_COMPARABLES - 1, dataFreshnessDays: 1, perSqmValues: [5, 5], sizeDeviationRatios: [0, 0],
    bedroomExactMatchRatio: 1, wilayatMismatch: false, bedroomToleranceApplied: false, furnishedFilterRelaxed: false, outliersRemoved: 0
  });
  assert.equal(result.score, 0);
  assert.equal(result.level, "insufficient");
});

test("computeConfidence: is a pure deterministic function of its inputs — identical inputs always produce identical output", () => {
  const factors = {
    sampleSizeUsed: 6, dataFreshnessDays: 100, perSqmValues: [5, 5.2, 4.9, 5.1], sizeDeviationRatios: [0.02, 0.05, 0.01, 0.03],
    bedroomExactMatchRatio: 0.75, wilayatMismatch: false, bedroomToleranceApplied: true, furnishedFilterRelaxed: false, outliersRemoved: 1
  };
  const a = computeConfidence(factors);
  const b = computeConfidence(factors);
  assert.deepEqual(a, b);
  assert.ok(a.score >= 0 && a.score <= 1);
  assert.ok(a.reasons.some(r => /outlier/i.test(r)));
  assert.ok(a.reasons.some(r => /bedroom/i.test(r)));
});

test("computeConfidence: a stale sample is penalized deterministically and says so in its reasons", () => {
  const factors = {
    sampleSizeUsed: 6, dataFreshnessDays: 100, perSqmValues: [5, 5.2, 4.9, 5.1], sizeDeviationRatios: [0.02, 0.05, 0.01, 0.03],
    bedroomExactMatchRatio: 0.75, wilayatMismatch: false, bedroomToleranceApplied: false, furnishedFilterRelaxed: false, outliersRemoved: 0
  };
  const fresh = computeConfidence(factors);
  const stale = computeConfidence({ ...factors, stale: true });
  assert.ok(stale.score < fresh.score);
  assert.ok(stale.reasons.some(r => /stale|freshness/i.test(r)));
});

test("analyze_oman_property: confidence score/level are always present and bounded 0-1 in the full pipeline", async () => {
  for (const input of [
    { governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: 2, sizeSqm: 130, askingPriceOMR: 118000 },
    { governorate: "Muscat", area: "Ghubrah", propertyType: "apartment", bedrooms: 1, sizeSqm: 65, askingPriceOMR: 40000 },
    { governorate: "Muscat", area: "Qurum", propertyType: "villa", sizeSqm: 300, askingPriceOMR: 250000 }
  ]) {
    const result = await analyzeOmanProperty(input) as any;
    assert.ok(result.confidence.score >= 0 && result.confidence.score <= 1);
    assert.ok(["insufficient", "low", "medium", "high"].includes(result.confidence.level));
    assert.ok(Array.isArray(result.confidence.reasons) && result.confidence.reasons.length > 0);
  }
});

// ---------------------------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------------------------
test("analyze_oman_property: provenance always distinguishes sourceType and states this MVP's data is a curated benchmark, not live/official data", async () => {
  const result = await analyzeOmanProperty(capability.example) as any;
  assert.ok(result.provenance.length > 0);
  for (const entry of result.provenance) {
    assert.equal(entry.sourceType, "manual_benchmark");
    assert.match(entry.sourceName, /demo|MVP|curated/i);
    assert.match(entry.sourceName, /not.*(live|transaction)/i);
    assert.ok(entry.recordCount > 0);
    assert.match(entry.sourceDate, /^\d{4}-\d{2}-\d{2}$/);
  }
  // Both the rental and sale samples used come from the same ManualDatasetProvider, so they
  // collapse into one provenance entry whose recordCount is their sum.
  assert.equal(result.provenance.length, 1);
  const insufficientSaleUsed = result.pricePosition.observedComparableRange === null;
  assert.equal(result.provenance[0].recordCount, result.market.sampleSizeUsed + (insufficientSaleUsed ? 2 : 0));
});

test("analyze_oman_property: no market/sale comparables at all means an empty provenance array, never a fabricated source", async () => {
  const result = await analyzeOmanProperty({ governorate: "Muscat", area: "Qurum", propertyType: "villa", sizeSqm: 300, askingPriceOMR: 250000 }) as any;
  assert.deepEqual(result.provenance, []);
});

// ---------------------------------------------------------------------------------------------
// Gross/net yield and pricePosition market-band classification
// ---------------------------------------------------------------------------------------------
test("analyze_oman_property: gross vs net yield reflects supplied operating costs exactly", async () => {
  const base = { governorate: "Muscat", area: "Al Mouj", propertyType: "apartment" as const, bedrooms: 2, sizeSqm: 130, askingPriceOMR: 118000 };
  const noCosts = await analyzeOmanProperty(base) as any;
  assert.equal(noCosts.investment.grossYieldPct, noCosts.investment.netYieldPct); // zero operating cost => identical
  const withCosts = await analyzeOmanProperty({ ...base, optionalAnnualServiceChargeOMR: 600, optionalAnnualMaintenanceOMR: 300 }) as any;
  assert.equal(withCosts.investment.grossYieldPct, 7.44); // unaffected by operating cost
  assert.equal(withCosts.investment.estimatedOperatingCostOMR, 900);
  assert.equal(withCosts.investment.estimatedNetIncomeOMR, 7875);
  assert.equal(withCosts.investment.netYieldPct, 6.67);
  assert.ok(withCosts.investment.netYieldPct < withCosts.investment.grossYieldPct);
});

test("analyze_oman_property: pricePosition classifies below/at/above market from the observed sale-comparable median with a ±10% band", async () => {
  const base = { governorate: "Muscat", area: "Al Mouj", propertyType: "villa" as const, bedrooms: 4, sizeSqm: 410 };
  assert.equal((await analyzeOmanProperty({ ...base, askingPriceOMR: 280000 }) as any).pricePosition.marketPosition, "below_market");
  assert.equal((await analyzeOmanProperty({ ...base, askingPriceOMR: 330000 }) as any).pricePosition.marketPosition, "at_market");
  assert.equal((await analyzeOmanProperty({ ...base, askingPriceOMR: 400000 }) as any).pricePosition.marketPosition, "above_market");
});

// ---------------------------------------------------------------------------------------------
// Input validation (strict schema, minimum required fields, supported property types)
// ---------------------------------------------------------------------------------------------
test("analyze_oman_property: rejects missing required fields and unknown fields", async () => {
  for (const input of [
    {}, { governorate: "Muscat" },
    { governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", sizeSqm: 100 }, // missing askingPriceOMR
    { governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", sizeSqm: 100, askingPriceOMR: 50000, unexpectedField: true },
    { governorate: "Muscat", area: "Al Mouj", propertyType: "boat", sizeSqm: 100, askingPriceOMR: 50000 }
  ]) await assert.rejects(() => analyzeOmanProperty(input), ZodError);
});

test("analyze_oman_property: apartments, villas and townhouses are all accepted property types", async () => {
  for (const propertyType of ["apartment", "villa", "townhouse"] as const) {
    await analyzeOmanProperty({ governorate: "Muscat", area: "Al Mouj", propertyType, sizeSqm: 150, askingPriceOMR: 100000 });
  }
});

// ---------------------------------------------------------------------------------------------
// Registry/pricing/OpenAPI/MCP parity — no duplicated metadata or pricing (Section 12)
// ---------------------------------------------------------------------------------------------
test("analyze_oman_property: registered once in the shared capability registry with the requested price, x402 protocol, idempotent/no-side-effects flags", () => {
  assert.equal(capability.path, "/oman/property/analyze");
  assert.equal(capability.price, 0.25);
  assert.equal(capability.currency, "USD");
  assert.equal(capability.paymentProtocol, "x402");
  assert.equal(capability.idempotent, true);
  assert.equal(capability.sideEffects, false);
  assert.equal(prices.analyze_oman_property, 0.25);
});

test("analyze_oman_property: x402 pricing info reads the exact same registry price — no second literal", () => {
  const billing = new BillingService();
  const config = loadConfig({ RAFID_API_KEYS: key, X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet });
  const info = buildX402Info(config, billing);
  const entry = info.tools.find(t => t.name === "analyze_oman_property");
  assert.ok(entry);
  assert.equal(entry!.price, 0.25);
  assert.equal(entry!.endpoint, "/api/v1/x402/oman/property/analyze");
});

test("analyze_oman_property: OpenAPI documents it under both route families with the capability name as operationId, tagged 'Oman'", () => {
  const config = loadConfig({ RAFID_API_KEYS: key, X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet });
  const doc = buildOpenapi(config) as { paths: Record<string, any> };
  const primary = doc.paths["/api/v1/oman/property/analyze"].post;
  assert.equal(primary.operationId, "analyze_oman_property");
  assert.deepEqual(primary.tags, ["Oman"]);
  assert.equal(primary.requestBody.content["application/json"].schema.additionalProperties, false);
  const x402 = doc.paths["/api/v1/x402/oman/property/analyze"].post;
  assert.equal(x402.operationId, "analyze_oman_property_x402");
  assert.ok(x402.responses["402"].description.includes("0.25"));
});

test("analyze_oman_property: reachable over REST with an API key and returns the exact service-layer result", async () => {
  const config = loadConfig({ RAFID_API_KEYS: key });
  await withServer(config, async base => {
    const response = await fetch(base + "/api/v1/oman/property/analyze", {
      method: "POST", headers: { "X-API-Key": key, "Content-Type": "application/json" }, body: JSON.stringify(capability.example)
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data, await capability.execute(capability.example));
    assert.equal(body.meta.tool, "analyze_oman_property");
    assert.equal(body.meta.price, 0.25);
  });
});

test("analyze_oman_property: MCP tool registration matches the shared registry exactly (name, description, schemas) and executes identically to the REST route", async () => {
  const config = loadConfig({ RAFID_API_KEYS: key });
  await withServer(config, async base => {
    let id = 1;
    const rpc = async (method: string, params: unknown = {}) => {
      const response = await fetch(base + "/mcp", {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params })
      });
      return await response.json() as any;
    };
    const listed = await rpc("tools/list");
    const tool = listed.result.tools.find((t: any) => t.name === "analyze_oman_property");
    assert.ok(tool, "expected an MCP tool entry for analyze_oman_property");
    assert.ok(tool.description.includes(capability.description));
    assert.ok(tool.description.includes(capability.whenToUse));
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.ok(tool.outputSchema);

    const called = await rpc("tools/call", { name: "analyze_oman_property", arguments: capability.example });
    assert.equal(called.error, undefined);
    assert.ok(!called.result.isError);
    assert.deepEqual(called.result.structuredContent, await capability.execute(capability.example));

    const invalid = await rpc("tools/call", { name: "analyze_oman_property", arguments: { governorate: "Muscat" } });
    assert.ok(invalid.result?.isError);
  });
});

// ---------------------------------------------------------------------------------------------
// Discovery surfaces — no second copy of name/description/price (Section 12)
// ---------------------------------------------------------------------------------------------
test("analyze_oman_property appears exactly once in every discovery surface, with matching metadata", async () => {
  const config = loadConfig({ RAFID_API_KEYS: key, X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet });
  await withServer(config, async base => {
    for (const path of ["/api/v1/capabilities", "/api/v1/tools"]) {
      const body = await (await fetch(base + path)).json();
      const matches = body.data.filter((t: any) => t.name === "analyze_oman_property");
      assert.equal(matches.length, 1, `expected exactly one entry for analyze_oman_property in ${path}`);
      assert.equal(matches[0].description, capability.description);
      assert.equal(matches[0].price, 0.25);
    }
    const manifest = await (await fetch(base + "/agent.json")).json();
    assert.equal(manifest.tools.filter((t: any) => t.name === "analyze_oman_property").length, 1);
    const roadmap = manifest.roadmap as { name: string }[];
    assert.ok(!roadmap.some(r => r.name === "analyze_oman_property"), "a now-implemented capability must be removed from the roadmap list");
    const llmsTxt = await (await fetch(base + "/llms.txt")).text();
    assert.ok(llmsTxt.includes("analyze_oman_property"));
    assert.ok(llmsTxt.includes("Al Mouj") && llmsTxt.includes("Ghubrah")); // supported areas documented
  });
});
