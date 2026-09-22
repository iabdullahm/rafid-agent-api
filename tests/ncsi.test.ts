import assert from "node:assert/strict";
import { test } from "node:test";
import { NcsiApiError, NcsiClient } from "../src/services/ncsi/ncsiClient.js";
import { OfficialOmanDataProvider } from "../src/domain/oman/dataProviders.js";
import { MemoryOfficialMarketContextCache } from "../src/domain/oman/officialContextCache.js";
import {
  findGovernorateRecord, mapNcsiRecordToContext, ncsiFieldMapSchema, unavailableOfficialContext
} from "../src/domain/oman/officialContext.js";
import { getNcsiFieldMap } from "../src/domain/oman/config.js";
import { runOmanPropertyAnalysis } from "../src/services/omanProperty.js";
import { CompositeOmanPropertyDataProvider, ManualDatasetProvider } from "../src/domain/oman/dataProviders.js";
import { RENTAL_FIXTURES, SALE_FIXTURES } from "../src/domain/oman/fixtures.js";

// ---------------------------------------------------------------------------------------------
// Test helpers: a minimal fake `fetch` so these tests never touch the network or depend on live
// NCSI availability (Section 11 of this feature's spec).
// ---------------------------------------------------------------------------------------------
function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function malformedResponse(status = 200): Response {
  return new Response("not json{{{", { status, headers: { "content-type": "application/json" } });
}

/** Records every call made to it (url string) so tests can assert call counts (e.g. cache hits). */
function fakeFetch(handler: (url: string) => Response | Promise<Response>): { fetchImpl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push(url);
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    return handler(url);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const MUSCAT_RECORD = {
  GOVERNORATE_EN: "Muscat", PERIOD: "2026-Q2", PRICE_INDEX: 118.4, TRADED_VALUE: 245000000,
  SALE_CONTRACTS: 5231, MORTGAGE_CONTRACTS: 1890, LAST_UPDATED: "2026-07-15"
};
const DHOFAR_RECORD = { GOVERNORATE_EN: "Dhofar", PERIOD: "2026-Q2", PRICE_INDEX: 101.2, LAST_UPDATED: "2026-07-15" };

const FIELD_MAP = {
  governorate: "GOVERNORATE_EN", period: "PERIOD", priceIndexValue: "PRICE_INDEX",
  tradedValueOMR: "TRADED_VALUE", saleContracts: "SALE_CONTRACTS", mortgageContracts: "MORTGAGE_CONTRACTS",
  publishedAt: "LAST_UPDATED"
};

// ---------------------------------------------------------------------------------------------
// NcsiClient: catalog discovery, record parsing, pagination-shape tolerance
// ---------------------------------------------------------------------------------------------
test("NcsiClient.listDatasets: parses a bare-array catalog response into dataset summaries", async () => {
  const { fetchImpl } = fakeFetch(() => jsonResponse(200, [
    { dataset_id: "real-estate-price-index", title: "Real Estate Price Index", description: "Quarterly index" },
    { dataset_id: "population-census", title: "Population Census" }
  ]));
  const client = new NcsiClient({ baseUrl: "https://example.test/ODPAPI", timeoutMs: 5000, fetchImpl });
  const result = await client.listDatasets({ limit: 10 });
  assert.equal(result.datasets.length, 2);
  assert.equal(result.datasets[0]!.datasetId, "real-estate-price-index");
  assert.equal(result.datasets[0]!.title, "Real Estate Price Index");
});

test("NcsiClient.listDatasets: also tolerates a wrapped { datasets: [...] } envelope", async () => {
  const { fetchImpl } = fakeFetch(() => jsonResponse(200, { datasets: [{ id: "housing-stats", title: "Housing Statistics" }], total: 1 }));
  const client = new NcsiClient({ baseUrl: "https://example.test/ODPAPI", timeoutMs: 5000, fetchImpl });
  const result = await client.listDatasets();
  assert.equal(result.datasets.length, 1);
  assert.equal(result.datasets[0]!.datasetId, "housing-stats");
});

test("NcsiClient.listDatasets: an unrecognized envelope shape yields an empty list, never a crash or a guessed structure", async () => {
  const { fetchImpl } = fakeFetch(() => jsonResponse(200, { somethingElse: true }));
  const client = new NcsiClient({ baseUrl: "https://example.test/ODPAPI", timeoutMs: 5000, fetchImpl });
  const result = await client.listDatasets();
  assert.deepEqual(result.datasets, []);
});

test("NcsiClient.getDatasetRecords: parses records from a wrapped envelope and sends Select/Where/limit/offset as documented query params", async () => {
  let capturedUrl = "";
  const { fetchImpl } = fakeFetch(url => { capturedUrl = url; return jsonResponse(200, { records: [MUSCAT_RECORD, DHOFAR_RECORD] }); });
  const client = new NcsiClient({ baseUrl: "https://example.test/ODPAPI", timeoutMs: 5000, fetchImpl });
  const page = await client.getDatasetRecords("real-estate-price-index", { limit: 50, offset: 0, select: "*", where: "GOVERNORATE_EN='Muscat'" });
  assert.equal(page.records.length, 2);
  assert.equal(page.records[0]!.GOVERNORATE_EN, "Muscat");
  const url = new URL(capturedUrl);
  assert.equal(url.pathname, "/ODPAPI/catalog/datasets/real-estate-price-index/records");
  assert.equal(url.searchParams.get("limit"), "50");
  assert.equal(url.searchParams.get("Select"), "*");
  assert.equal(url.searchParams.get("Where"), "GOVERNORATE_EN='Muscat'");
});

test("NcsiClient: a 4xx response is never retried and surfaces as an http_error NcsiApiError", async () => {
  const { fetchImpl, calls } = fakeFetch(() => jsonResponse(404, { error: "not found" }));
  const client = new NcsiClient({ baseUrl: "https://example.test/ODPAPI", timeoutMs: 5000, fetchImpl, maxRetries: 2 });
  await assert.rejects(() => client.getDatasetRecords("nope"), (err: unknown) => err instanceof NcsiApiError && err.kind === "http_error" && err.status === 404);
  assert.equal(calls.length, 1, "a 4xx must not be retried");
});

test("NcsiClient: a 5xx response is retried up to maxRetries, then surfaces as http_error", async () => {
  const { fetchImpl, calls } = fakeFetch(() => jsonResponse(500, { error: "server error" }));
  const client = new NcsiClient({ baseUrl: "https://example.test/ODPAPI", timeoutMs: 5000, fetchImpl, maxRetries: 2 });
  await assert.rejects(() => client.listDatasets(), (err: unknown) => err instanceof NcsiApiError && err.kind === "http_error" && err.status === 500);
  assert.equal(calls.length, 3, "expected 1 initial attempt + 2 retries");
});

test("NcsiClient: a request that times out surfaces as a timeout NcsiApiError", async () => {
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  }) as typeof fetch;
  const client = new NcsiClient({ baseUrl: "https://example.test/ODPAPI", timeoutMs: 20, fetchImpl, maxRetries: 0 });
  await assert.rejects(() => client.listDatasets(), (err: unknown) => err instanceof NcsiApiError && err.kind === "timeout");
});

test("NcsiClient: a response body that isn't valid JSON surfaces as a malformed_response NcsiApiError", async () => {
  const { fetchImpl } = fakeFetch(() => malformedResponse());
  const client = new NcsiClient({ baseUrl: "https://example.test/ODPAPI", timeoutMs: 5000, fetchImpl, maxRetries: 0 });
  await assert.rejects(() => client.listDatasets(), (err: unknown) => err instanceof NcsiApiError && err.kind === "malformed_response");
});

// ---------------------------------------------------------------------------------------------
// officialContext.ts: field-map-driven parsing, never a hardcoded field name
// ---------------------------------------------------------------------------------------------
test("findGovernorateRecord: matches case-insensitively via the configured field, ignores unrelated governorates", () => {
  const match = findGovernorateRecord([DHOFAR_RECORD, MUSCAT_RECORD], FIELD_MAP, "muscat");
  assert.deepEqual(match, MUSCAT_RECORD);
  assert.equal(findGovernorateRecord([DHOFAR_RECORD], FIELD_MAP, "Muscat"), null);
});

test("mapNcsiRecordToContext: populates every field the map covers, straight from the raw record", () => {
  const ctx = mapNcsiRecordToContext(MUSCAT_RECORD, FIELD_MAP, "Muscat", {
    datasetId: "real-estate-price-index", datasetTitle: "Real Estate Price Index", retrievedAt: "2026-09-01T00:00:00.000Z",
    sourceUrl: "https://example.test/ODPAPI/catalog/datasets/real-estate-price-index"
  });
  assert.equal(ctx.available, true);
  assert.equal(ctx.governorate, "Muscat");
  assert.equal(ctx.period, "2026-Q2");
  assert.equal(ctx.realEstatePriceIndex.value, 118.4);
  assert.equal(ctx.marketActivity.tradedValueOMR, 245000000);
  assert.equal(ctx.marketActivity.saleContracts, 5231);
  assert.equal(ctx.marketActivity.mortgageContracts, 1890);
  assert.equal(ctx.provenance.datasetId, "real-estate-price-index");
  assert.equal(ctx.provenance.publishedAt, "2026-07-15");
  assert.equal(ctx.provenance.sourceUrl, "https://example.test/ODPAPI/catalog/datasets/real-estate-price-index");
  assert.equal(ctx.provenance.sourceType, "official_statistics");
  assert.equal(ctx.sourceType, "official_statistics");
});

test("mapNcsiRecordToContext: a field the map doesn't cover (missing metric) is reported as null, never guessed", () => {
  const partialMap = { governorate: "GOVERNORATE_EN", period: "PERIOD" }; // no priceIndexValue/tradedValueOMR/etc.
  const ctx = mapNcsiRecordToContext(MUSCAT_RECORD, partialMap, "Muscat", { datasetId: "d", datasetTitle: null, retrievedAt: "2026-09-01T00:00:00.000Z", sourceUrl: null });
  assert.equal(ctx.realEstatePriceIndex.value, null);
  assert.equal(ctx.marketActivity.tradedValueOMR, null);
  assert.equal(ctx.marketActivity.saleContracts, null);
  assert.equal(ctx.marketActivity.mortgageContracts, null);
  assert.equal(ctx.dataFreshnessDays, null, "no publishedAt field configured means freshness can't be assessed");
  assert.equal(ctx.confidence.level, "low");
});

test("mapNcsiRecordToContext: an old (but present) publication date is 'medium' confidence rather than 'high', without becoming unavailable", () => {
  const staleRecord = { ...MUSCAT_RECORD, LAST_UPDATED: "2020-01-01" };
  const ctx = mapNcsiRecordToContext(staleRecord, FIELD_MAP, "Muscat", { datasetId: "d", datasetTitle: null, retrievedAt: "2026-09-01T00:00:00.000Z", sourceUrl: null });
  assert.equal(ctx.available, true);
  assert.equal(ctx.confidence.level, "medium");
  assert.ok(ctx.dataFreshnessDays! > 400);
});

test("getNcsiFieldMap: valid JSON matching the schema parses; missing/invalid JSON returns null rather than throwing", () => {
  assert.deepEqual(getNcsiFieldMap({ NCSI_FIELD_MAP_JSON: JSON.stringify(FIELD_MAP) }), FIELD_MAP);
  assert.equal(getNcsiFieldMap({}), null);
  assert.equal(getNcsiFieldMap({ NCSI_FIELD_MAP_JSON: "{not json" }), null);
  assert.equal(getNcsiFieldMap({ NCSI_FIELD_MAP_JSON: JSON.stringify({ notGovernorate: "x" }) }), null, "missing the required governorate key must fail validation");
});

test("ncsiFieldMapSchema: rejects unknown extra keys (strict object), just like the rest of this project's schemas", () => {
  assert.throws(() => ncsiFieldMapSchema.parse({ ...FIELD_MAP, unexpectedExtra: "x" }));
});

// ---------------------------------------------------------------------------------------------
// OfficialOmanDataProvider.getMarketContext: end-to-end against the mocked HTTP layer
// ---------------------------------------------------------------------------------------------
test("OfficialOmanDataProvider.getMarketContext: unconfigured (no dataset id / field map) is unavailable with no network call", async () => {
  const { fetchImpl, calls } = fakeFetch(() => jsonResponse(200, { records: [MUSCAT_RECORD] }));
  const client = new NcsiClient({ baseUrl: "https://example.test/ODPAPI", timeoutMs: 5000, fetchImpl });
  const provider = new OfficialOmanDataProvider({ client }); // datasetId/fieldMap omitted
  const ctx = await provider.getMarketContext("Muscat");
  assert.equal(ctx.available, false);
  assert.equal(ctx.reason, "ncsi_not_configured");
  assert.equal(ctx.provenance.retrievedAt, null, "nothing was actually retrieved");
  assert.equal(calls.length, 0);
});

test("OfficialOmanDataProvider.getMarketContext: a configured dataset resolves a real Muscat context", async () => {
  const { fetchImpl } = fakeFetch(() => jsonResponse(200, { records: [DHOFAR_RECORD, MUSCAT_RECORD] }));
  const client = new NcsiClient({ baseUrl: "https://example.test/ODPAPI", timeoutMs: 5000, fetchImpl });
  const provider = new OfficialOmanDataProvider({ client, datasetId: "real-estate-price-index", fieldMap: FIELD_MAP });
  const ctx = await provider.getMarketContext("Muscat");
  assert.equal(ctx.available, true);
  assert.equal(ctx.governorate, "Muscat");
  assert.equal(ctx.realEstatePriceIndex.value, 118.4);
  assert.equal(ctx.provenance.datasetId, "real-estate-price-index");
});

test("OfficialOmanDataProvider.getMarketContext: no record for the requested governorate reports unavailable, not a fabricated fallback", async () => {
  const { fetchImpl } = fakeFetch(() => jsonResponse(200, { records: [DHOFAR_RECORD] }));
  const client = new NcsiClient({ baseUrl: "https://example.test/ODPAPI", timeoutMs: 5000, fetchImpl });
  const provider = new OfficialOmanDataProvider({ client, datasetId: "d", fieldMap: FIELD_MAP });
  const ctx = await provider.getMarketContext("Muscat");
  assert.equal(ctx.available, false);
  assert.equal(ctx.reason, "no_data_for_governorate");
});

test("OfficialOmanDataProvider.getMarketContext: NCSI 5xx failure degrades to unavailable, never fabricates or throws", async () => {
  const { fetchImpl } = fakeFetch(() => jsonResponse(503, {}));
  const client = new NcsiClient({ baseUrl: "https://example.test/ODPAPI", timeoutMs: 5000, fetchImpl, maxRetries: 0 });
  const provider = new OfficialOmanDataProvider({ client, datasetId: "d", fieldMap: FIELD_MAP });
  const ctx = await provider.getMarketContext("Muscat");
  assert.equal(ctx.available, false);
  assert.equal(ctx.reason, "official_source_temporarily_unavailable");
});

test("OfficialOmanDataProvider.getMarketContext: NCSI timeout is reported as ncsi_timeout", async () => {
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  })) as typeof fetch;
  const client = new NcsiClient({ baseUrl: "https://example.test/ODPAPI", timeoutMs: 15, fetchImpl, maxRetries: 0 });
  const provider = new OfficialOmanDataProvider({ client, datasetId: "d", fieldMap: FIELD_MAP });
  const ctx = await provider.getMarketContext("Muscat");
  assert.equal(ctx.available, false);
  assert.equal(ctx.reason, "ncsi_timeout");
});

test("OfficialOmanDataProvider.getMarketContext: a malformed NCSI response is reported as ncsi_malformed_response", async () => {
  const { fetchImpl } = fakeFetch(() => malformedResponse());
  const client = new NcsiClient({ baseUrl: "https://example.test/ODPAPI", timeoutMs: 5000, fetchImpl, maxRetries: 0 });
  const provider = new OfficialOmanDataProvider({ client, datasetId: "d", fieldMap: FIELD_MAP });
  const ctx = await provider.getMarketContext("Muscat");
  assert.equal(ctx.available, false);
  assert.equal(ctx.reason, "ncsi_malformed_response");
});

test("OfficialOmanDataProvider: findRentalComparables/findSaleComparables always return empty, even fully configured with real NCSI data available — aggregate statistics never enter the comparable list", async () => {
  const { fetchImpl } = fakeFetch(() => jsonResponse(200, { records: [MUSCAT_RECORD] }));
  const client = new NcsiClient({ baseUrl: "https://example.test/ODPAPI", timeoutMs: 5000, fetchImpl });
  const provider = new OfficialOmanDataProvider({ client, datasetId: "d", fieldMap: FIELD_MAP });
  assert.deepEqual(await provider.findRentalComparables(), []);
  assert.deepEqual(await provider.findSaleComparables(), []);
});

// ---------------------------------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------------------------------
test("OfficialOmanDataProvider: a cache hit avoids a second NCSI request for the same governorate", async () => {
  const { fetchImpl, calls } = fakeFetch(() => jsonResponse(200, { records: [MUSCAT_RECORD] }));
  const client = new NcsiClient({ baseUrl: "https://example.test/ODPAPI", timeoutMs: 5000, fetchImpl });
  const cache = new MemoryOfficialMarketContextCache(60_000);
  const provider = new OfficialOmanDataProvider({ client, datasetId: "d", fieldMap: FIELD_MAP, cache });
  await provider.getMarketContext("Muscat");
  await provider.getMarketContext("Muscat");
  assert.equal(calls.length, 1, "the second call must be served from cache");
  assert.equal(cache.size(), 1);
});

test("MemoryOfficialMarketContextCache: an expired entry is treated as a miss", async () => {
  const cache = new MemoryOfficialMarketContextCache(10);
  await cache.set("Muscat", unavailableOfficialContext("Muscat", "ncsi_not_configured"));
  assert.ok(await cache.get("Muscat"));
  await new Promise(r => setTimeout(r, 25));
  assert.equal(await cache.get("Muscat"), null);
});

test("OfficialOmanDataProvider: a failed lookup is never cached, so the next call retries NCSI", async () => {
  let attempt = 0;
  const { fetchImpl } = fakeFetch(() => { attempt++; return jsonResponse(500, {}); });
  const client = new NcsiClient({ baseUrl: "https://example.test/ODPAPI", timeoutMs: 5000, fetchImpl, maxRetries: 0 });
  const cache = new MemoryOfficialMarketContextCache(60_000);
  const provider = new OfficialOmanDataProvider({ client, datasetId: "d", fieldMap: FIELD_MAP, cache });
  await provider.getMarketContext("Muscat");
  await provider.getMarketContext("Muscat");
  assert.equal(attempt, 2, "a failed (unavailable) result must not be cached");
});

// ---------------------------------------------------------------------------------------------
// Full pipeline integration: NCSI failure must never break analyze_oman_property itself
// ---------------------------------------------------------------------------------------------
const comparableProvider = new CompositeOmanPropertyDataProvider([new ManualDatasetProvider(RENTAL_FIXTURES, SALE_FIXTURES)]);
const validInput = { governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: 2, sizeSqm: 130, askingPriceOMR: 118000 };

test("runOmanPropertyAnalysis: an NCSI outage does not prevent the comparable analysis from completing", async () => {
  const { fetchImpl } = fakeFetch(() => jsonResponse(500, {}));
  const client = new NcsiClient({ baseUrl: "https://example.test/ODPAPI", timeoutMs: 5000, fetchImpl, maxRetries: 0 });
  const officialProvider = new OfficialOmanDataProvider({ client, datasetId: "d", fieldMap: FIELD_MAP });
  const result = await runOmanPropertyAnalysis(validInput, comparableProvider, officialProvider);
  assert.equal(result.insufficientMarketData, false);
  assert.ok(result.market.estimatedMonthlyRentOMR, "comparable-based market figures must still be computed");
  assert.equal(result.officialMarketContext.available, false);
  assert.equal(result.officialMarketContext.reason, "official_source_temporarily_unavailable");
});

test("runOmanPropertyAnalysis: a healthy, configured NCSI source enriches the response with officialMarketContext, without touching comparablesSummary/market/confidence", async () => {
  const { fetchImpl } = fakeFetch(() => jsonResponse(200, { records: [MUSCAT_RECORD] }));
  const client = new NcsiClient({ baseUrl: "https://example.test/ODPAPI", timeoutMs: 5000, fetchImpl });
  const officialProvider = new OfficialOmanDataProvider({ client, datasetId: "real-estate-price-index", fieldMap: FIELD_MAP });
  const withoutNcsi = await runOmanPropertyAnalysis(validInput, comparableProvider, new OfficialOmanDataProvider());
  const withNcsi = await runOmanPropertyAnalysis(validInput, comparableProvider, officialProvider);

  assert.deepEqual(withNcsi.market, withoutNcsi.market);
  assert.deepEqual(withNcsi.comparablesSummary, withoutNcsi.comparablesSummary);
  assert.deepEqual(withNcsi.confidence, withoutNcsi.confidence, "comparable confidence must be unaffected by official context");
  assert.deepEqual(withNcsi.provenance, withoutNcsi.provenance, "NCSI must never enter the comparable provenance list");

  assert.equal(withNcsi.officialMarketContext.available, true);
  assert.equal(withNcsi.officialMarketContext.realEstatePriceIndex.value, 118.4);
  assert.equal(withNcsi.officialMarketContext.confidence.level, "high");
});

test("runOmanPropertyAnalysis: officialMarketContext is still populated on the early-return (unsupported area) path", async () => {
  const { fetchImpl } = fakeFetch(() => jsonResponse(200, { records: [MUSCAT_RECORD] }));
  const client = new NcsiClient({ baseUrl: "https://example.test/ODPAPI", timeoutMs: 5000, fetchImpl });
  const officialProvider = new OfficialOmanDataProvider({ client, datasetId: "d", fieldMap: FIELD_MAP });
  const result = await runOmanPropertyAnalysis({ ...validInput, area: "Somewhere Unlisted" }, comparableProvider, officialProvider);
  assert.equal(result.insufficientMarketData, true);
  assert.equal(result.officialMarketContext.available, true, "NCSI's own governorate coverage is independent of this MVP's area coverage");
  assert.equal(result.officialMarketContext.governorate, "Muscat");
});

test("runOmanPropertyAnalysis: zero-record NCSI dataset (dataset exists but has no matching governorate) never fabricates figures", async () => {
  const { fetchImpl } = fakeFetch(() => jsonResponse(200, { records: [] }));
  const client = new NcsiClient({ baseUrl: "https://example.test/ODPAPI", timeoutMs: 5000, fetchImpl });
  const officialProvider = new OfficialOmanDataProvider({ client, datasetId: "d", fieldMap: FIELD_MAP });
  const result = await runOmanPropertyAnalysis(validInput, comparableProvider, officialProvider);
  assert.equal(result.officialMarketContext.available, false);
  assert.equal(result.officialMarketContext.reason, "no_data_for_governorate");
});
