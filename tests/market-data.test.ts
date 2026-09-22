import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { PostgresPropertyMarketRepository } from "../src/db/marketStore.js";
import { capabilities } from "../src/domain/capabilities.js";
import { buildOpenapi } from "../src/api/openapi.js";
import { loadConfig } from "../src/config/env.js";
import {
  MemoryPropertyMarketRepository, type MarketRecordInput
} from "../src/domain/oman/marketRepository.js";
import {
  DatabaseOmanPropertyDataProvider, CompositeOmanPropertyDataProvider, ManualDatasetProvider,
  OfficialOmanDataProvider, ListingDataProvider
} from "../src/domain/oman/dataProviders.js";
import { RENTAL_FIXTURES, SALE_FIXTURES } from "../src/domain/oman/fixtures.js";
import { runOmanPropertyAnalysis } from "../src/services/omanProperty.js";
import {
  importMarketRecords, parseCsv, parseJsonRows, loadImportRows, MAX_IMPORT_ROWS, SIZE_BOUNDS_BY_PROPERTY_TYPE
} from "../src/domain/oman/importPipeline.js";
import { getOmanPropertyDataMode, getOmanMarketDatabaseUrl, getOmanMarketStaleDays, getOmanMarketCacheTtlMs, getOmanRecentSalesDays } from "../src/domain/oman/config.js";
import { MemoryComparableCache, buildComparableCacheKey } from "../src/domain/oman/cache.js";
import { computeConfidence } from "../src/domain/oman/confidence.js";
import { selectComparables, selectSaleComparables } from "../src/domain/oman/comparables.js";

const key = "test-only-not-a-real-credential-12345";

function baseInput(overrides: Partial<MarketRecordInput> = {}): MarketRecordInput {
  return {
    governorate: "Muscat", wilayat: "Muscat", area: "Al Mouj", normalizedArea: "al mouj",
    propertyType: "apartment", bedrooms: 2, bathrooms: 2, sizeSqm: 130,
    transactionType: "rental", priceOMR: 750, rentPeriod: "monthly", furnished: "furnished",
    sourceType: "listing_asking_price", sourceName: "Test Feed", sourceRecordId: null, sourceUrl: null,
    observedAt: new Date().toISOString(), metadata: {},
    ...overrides
  };
}

// ---------------------------------------------------------------------------------------------
// Phase 1: async execution architecture
// ---------------------------------------------------------------------------------------------
test("Phase 1: every capability's execute() returns a real Promise, not a synchronous value", () => {
  for (const c of capabilities) {
    const result = c.execute(c.example);
    assert.ok(result instanceof Promise, `${c.name}.execute() must return a Promise`);
    result.catch(() => {}); // avoid an unhandled-rejection warning if a capability ever rejects here
  }
});

test("Phase 1: OpenAPI generation never calls execute() — examples come from registry metadata (exampleOutput), not runtime execution", () => {
  const originals = capabilities.map(c => c.execute);
  let called = false;
  for (const c of capabilities) (c as any).execute = (...args: unknown[]) => { called = true; return originals[capabilities.indexOf(c)]!(...args as [unknown]); };
  try {
    const doc = buildOpenapi(loadConfig({ RAFID_API_KEYS: key })) as { paths: Record<string, { post?: { responses: { "200": { content: { "application/json": { examples: { default: { value: { data: unknown } } } } } } } } }> };
    assert.equal(called, false, "buildOpenapi() must not execute any capability");
    for (const c of capabilities) {
      const example = doc.paths["/api/v1" + c.path]!.post!.responses["200"].content["application/json"].examples.default.value.data;
      assert.deepEqual(example, c.exampleOutput);
    }
  } finally {
    capabilities.forEach((c, i) => { (c as any).execute = originals[i]; });
  }
});

test("Phase 1: existing synchronous calculator capabilities still work correctly through the async contract", async () => {
  const analyzeProperty = capabilities.find(c => c.name === "analyze_property")!;
  const result = await analyzeProperty.execute(analyzeProperty.example) as any;
  assert.equal(result.currency, "OMR");
  assert.ok(analyzeProperty.output.safeParse(result).success);
});

// ---------------------------------------------------------------------------------------------
// Phase 2/3: PropertyMarketRepository — filtering, in-memory implementation
// ---------------------------------------------------------------------------------------------
test("MemoryPropertyMarketRepository: filters rentals by normalizedArea, propertyType, transactionType and recency", async () => {
  const repo = new MemoryPropertyMarketRepository();
  await repo.upsertMarketRecords([
    baseInput({ sourceRecordId: "a" }),
    baseInput({ sourceRecordId: "b", propertyType: "villa" }), // wrong property type
    baseInput({ sourceRecordId: "c", normalizedArea: "qurum", area: "Qurum" }), // wrong area
    baseInput({ sourceRecordId: "d", transactionType: "sale", rentPeriod: null, priceOMR: 120000 }), // wrong transaction type
    baseInput({ sourceRecordId: "e", observedAt: new Date(Date.now() - 1000 * 86_400_000).toISOString() }) // too old
  ]);
  const matches = await repo.findRentalComparables({ normalizedArea: "al mouj", propertyType: "apartment", transactionType: "rental", maxAgeDays: 540 });
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.sourceRecordId, "a");
});

test("MemoryPropertyMarketRepository: upsertMarketRecords deduplicates on (sourceName, sourceRecordId); records without a sourceRecordId are always inserted as new", async () => {
  const repo = new MemoryPropertyMarketRepository();
  const first = await repo.upsertMarketRecords([baseInput({ sourceRecordId: "dup-1", priceOMR: 700 })]);
  assert.deepEqual(first, { inserted: 1, updated: 0, skipped: 0 });
  const second = await repo.upsertMarketRecords([baseInput({ sourceRecordId: "dup-1", priceOMR: 900 })]);
  assert.deepEqual(second, { inserted: 0, updated: 1, skipped: 0 });
  assert.equal(repo.all().length, 1);
  assert.equal(repo.all()[0]!.priceOMR, 900, "the update must overwrite the prior record's fields");

  const sourceless = await repo.upsertMarketRecords([baseInput({ sourceRecordId: null }), baseInput({ sourceRecordId: null })]);
  assert.deepEqual(sourceless, { inserted: 2, updated: 0, skipped: 0 });
  assert.equal(repo.all().length, 3);
});

test("MemoryPropertyMarketRepository: findMarketStatistics and getLatestDataTimestamp return null for a zero-record query, never fabricated", async () => {
  const repo = new MemoryPropertyMarketRepository();
  assert.equal(await repo.findMarketStatistics({ normalizedArea: "ghubrah", propertyType: "villa", transactionType: "sale" }), null);
  assert.equal(await repo.getLatestDataTimestamp({ normalizedArea: "ghubrah", propertyType: "villa", transactionType: "sale" }), null);
});

// ---------------------------------------------------------------------------------------------
// Phase 5: DatabaseOmanPropertyDataProvider
// ---------------------------------------------------------------------------------------------
test("DatabaseOmanPropertyDataProvider: maps repository rows into RentalComparable/SaleComparable shapes comparables.ts already understands", async () => {
  const repo = new MemoryPropertyMarketRepository();
  await repo.upsertMarketRecords([
    baseInput({ sourceRecordId: "r1" }),
    baseInput({ sourceRecordId: "r2", transactionType: "sale", rentPeriod: null, priceOMR: 118000 })
  ]);
  const provider = new DatabaseOmanPropertyDataProvider(repo);
  const rentals = await provider.findRentalComparables({ area: "Al Mouj", propertyType: "apartment", sizeSqm: 130, bedrooms: 2 });
  assert.equal(rentals.length, 1);
  assert.equal(rentals[0]!.rentAmountOMR, 750);
  assert.equal(rentals[0]!.sourceType, "listing_asking_price");
  const sales = await provider.findSaleComparables({ area: "Al Mouj", propertyType: "apartment", sizeSqm: 130, bedrooms: 2 });
  assert.equal(sales.length, 1);
  assert.equal(sales[0]!.askingPriceOMR, 118000);
});

test("DatabaseOmanPropertyDataProvider: a record missing bedrooms or furnished status is excluded rather than guessed at", async () => {
  const repo = new MemoryPropertyMarketRepository();
  await repo.upsertMarketRecords([
    baseInput({ sourceRecordId: "no-bedrooms", bedrooms: null }),
    baseInput({ sourceRecordId: "no-furnished", furnished: null }),
    baseInput({ sourceRecordId: "complete" })
  ]);
  const provider = new DatabaseOmanPropertyDataProvider(repo);
  const rentals = await provider.findRentalComparables({ area: "Al Mouj", propertyType: "apartment", sizeSqm: 130, bedrooms: 2 });
  assert.equal(rentals.length, 1);
  assert.equal(rentals[0]!.id, "mem-3");
});

test("CompositeOmanPropertyDataProvider: a failing provider degrades to no records from it, rather than crashing the whole lookup", async () => {
  const failing = { name: "failing", findRentalComparables: () => Promise.reject(new Error("connection refused")), findSaleComparables: () => Promise.reject(new Error("connection refused")), getMarketStatistics: () => Promise.reject(new Error("x")) };
  const manual = new ManualDatasetProvider(RENTAL_FIXTURES, SALE_FIXTURES);
  const composite = new CompositeOmanPropertyDataProvider([failing as any, manual]);
  const rentals = await composite.findRentalComparables({ area: "Al Mouj", propertyType: "apartment", sizeSqm: 130, bedrooms: 2 });
  assert.ok(rentals.length > 0, "the manual provider's records must still come through despite the other provider failing");
});

test("CompositeOmanPropertyDataProvider: database-first ordering means a real record wins over a demo record sharing the same id", async () => {
  const repo = new MemoryPropertyMarketRepository();
  await repo.upsertMarketRecords([baseInput({ sourceRecordId: "collide" })]);
  const database = new DatabaseOmanPropertyDataProvider(repo);
  const fakeDemo = { id: "mem-1", area: "Al Mouj", propertyType: "apartment" as const, bedrooms: 9, sizeSqm: 999, furnished: "unfurnished" as const, listedDaysAgo: 1, sourceType: "manual_benchmark" as const, sourceName: "demo", sourceDate: "2026-01-01", rentAmountOMR: 1, rentPeriod: "monthly" as const };
  const manualLike = { name: "manual-like", findRentalComparables: async () => [fakeDemo], findSaleComparables: async () => [], getMarketStatistics: async () => null };
  const composite = new CompositeOmanPropertyDataProvider([database, manualLike as any]);
  const rentals = await composite.findRentalComparables({ area: "Al Mouj", propertyType: "apartment", sizeSqm: 130, bedrooms: 2 });
  const collided = rentals.find(r => r.id === "mem-1");
  assert.ok(collided);
  assert.equal(collided!.sourceType, "listing_asking_price", "the database provider (listed first) must win the id collision, not the demo-like provider");
});

// ---------------------------------------------------------------------------------------------
// Phase 6: provider modes, and the dynamic demo-dataset risk flag
// ---------------------------------------------------------------------------------------------
test("getOmanPropertyDataMode: defaults to 'manual' and rejects an unrecognized mode", () => {
  assert.equal(getOmanPropertyDataMode({}), "manual");
  assert.equal(getOmanPropertyDataMode({ OMAN_PROPERTY_DATA_MODE: "database" }), "database");
  assert.equal(getOmanPropertyDataMode({ OMAN_PROPERTY_DATA_MODE: "COMPOSITE" }), "composite");
  assert.throws(() => getOmanPropertyDataMode({ OMAN_PROPERTY_DATA_MODE: "scrape-everything" }));
});

test("getOmanMarketDatabaseUrl: falls back to DATABASE_URL when OMAN_MARKET_DATABASE_URL is unset", () => {
  assert.equal(getOmanMarketDatabaseUrl({ DATABASE_URL: "postgres://a" }), "postgres://a");
  assert.equal(getOmanMarketDatabaseUrl({ DATABASE_URL: "postgres://a", OMAN_MARKET_DATABASE_URL: "postgres://b" }), "postgres://b");
  assert.equal(getOmanMarketDatabaseUrl({}), undefined);
});

test("runOmanPropertyAnalysis: a database-only provider that actually returns data never carries the demo-dataset risk flag", async () => {
  const repo = new MemoryPropertyMarketRepository();
  const now = new Date().toISOString();
  for (let i = 0; i < 5; i++) {
    await repo.upsertMarketRecords([baseInput({ sourceRecordId: `db-${i}`, priceOMR: 700 + i * 10, sizeSqm: 128 + i, observedAt: now })]);
  }
  const provider = new CompositeOmanPropertyDataProvider([new OfficialOmanDataProvider(), new ListingDataProvider(), new DatabaseOmanPropertyDataProvider(repo)]);
  const result = await runOmanPropertyAnalysis(
    { governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: 2, sizeSqm: 130, askingPriceOMR: 118000 },
    provider
  ) as any;
  assert.equal(result.insufficientMarketData, false);
  assert.ok(!result.riskFlags.includes("demo_dataset_not_live_market_data"));
  assert.deepEqual(result.dataQuality.sourceTypes, ["listing_asking_price"]);
  assert.equal(result.provenance[0].sourceType, "listing_asking_price");
});

test("runOmanPropertyAnalysis: composite mode falls back to the manual/demo provider when the database has no data, and the demo flag reappears", async () => {
  const emptyRepo = new MemoryPropertyMarketRepository();
  const provider = new CompositeOmanPropertyDataProvider([
    new OfficialOmanDataProvider(), new ListingDataProvider(),
    new DatabaseOmanPropertyDataProvider(emptyRepo),
    new ManualDatasetProvider(RENTAL_FIXTURES, SALE_FIXTURES)
  ]);
  const result = await runOmanPropertyAnalysis(
    { governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: 2, sizeSqm: 130, askingPriceOMR: 118000 },
    provider
  ) as any;
  assert.equal(result.insufficientMarketData, false);
  assert.ok(result.riskFlags.includes("demo_dataset_not_live_market_data"));
});

test("runOmanPropertyAnalysis: zero-record database with no manual fallback (database-only mode) reports insufficientMarketData honestly", async () => {
  const emptyRepo = new MemoryPropertyMarketRepository();
  const provider = new CompositeOmanPropertyDataProvider([new OfficialOmanDataProvider(), new ListingDataProvider(), new DatabaseOmanPropertyDataProvider(emptyRepo)]);
  const result = await runOmanPropertyAnalysis(
    { governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: 2, sizeSqm: 130, askingPriceOMR: 118000 },
    provider
  ) as any;
  assert.equal(result.insufficientMarketData, true);
  assert.equal(result.market.sampleSizeUsed, 0);
  assert.deepEqual(result.dataQuality, { latestDataDate: null, dataFreshnessDays: null, sampleSize: 0, sourceTypes: [], staleMarketData: false });
});

// ---------------------------------------------------------------------------------------------
// Phase 7: data freshness / staleness
// ---------------------------------------------------------------------------------------------
test("getOmanMarketStaleDays: defaults to 365 and honors a valid override", () => {
  assert.equal(getOmanMarketStaleDays({}), 365);
  assert.equal(getOmanMarketStaleDays({ OMAN_MARKET_STALE_DAYS: "30" }), 30);
  assert.equal(getOmanMarketStaleDays({ OMAN_MARKET_STALE_DAYS: "not-a-number" }), 365);
});

test("getOmanRecentSalesDays: defaults to 730 and honors a valid override, never hardcoded in analysis logic", () => {
  assert.equal(getOmanRecentSalesDays({}), 730);
  assert.equal(getOmanRecentSalesDays({ OMAN_RECENT_SALES_DAYS: "365" }), 365);
  assert.equal(getOmanRecentSalesDays({ OMAN_RECENT_SALES_DAYS: "not-a-number" }), 730);
  assert.equal(getOmanRecentSalesDays({ OMAN_RECENT_SALES_DAYS: "-5" }), 730);
});

test("runOmanPropertyAnalysis: a comparable sample older than the staleness threshold is flagged and penalized, a fresh one is not", async () => {
  const staleRepo = new MemoryPropertyMarketRepository();
  const oldDate = new Date(Date.now() - 400 * 86_400_000).toISOString(); // > default 365-day threshold, < 540-day hard cutoff
  for (let i = 0; i < 5; i++) await staleRepo.upsertMarketRecords([baseInput({ sourceRecordId: `stale-${i}`, priceOMR: 700 + i * 5, sizeSqm: 128 + i, observedAt: oldDate })]);
  const staleProvider = new CompositeOmanPropertyDataProvider([new OfficialOmanDataProvider(), new ListingDataProvider(), new DatabaseOmanPropertyDataProvider(staleRepo)]);
  const staleResult = await runOmanPropertyAnalysis({ governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: 2, sizeSqm: 130, askingPriceOMR: 118000 }, staleProvider) as any;
  assert.equal(staleResult.dataQuality.staleMarketData, true);
  assert.ok(staleResult.riskFlags.includes("stale_market_data"));

  const freshRepo = new MemoryPropertyMarketRepository();
  const freshDate = new Date().toISOString();
  for (let i = 0; i < 5; i++) await freshRepo.upsertMarketRecords([baseInput({ sourceRecordId: `fresh-${i}`, priceOMR: 700 + i * 5, sizeSqm: 128 + i, observedAt: freshDate })]);
  const freshProvider = new CompositeOmanPropertyDataProvider([new OfficialOmanDataProvider(), new ListingDataProvider(), new DatabaseOmanPropertyDataProvider(freshRepo)]);
  const freshResult = await runOmanPropertyAnalysis({ governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: 2, sizeSqm: 130, askingPriceOMR: 118000 }, freshProvider) as any;
  assert.equal(freshResult.dataQuality.staleMarketData, false);
  assert.ok(!freshResult.riskFlags.includes("stale_market_data"));
  assert.ok(freshResult.confidence.score > staleResult.confidence.score, "stale data must score lower confidence than an otherwise-identical fresh sample");
});

// ---------------------------------------------------------------------------------------------
// Phase 8: provenance already covered extensively in oman-property.test.ts; this adds the
// manual-vs-database distinction specifically.
// ---------------------------------------------------------------------------------------------
test("provenance distinguishes a database-sourced answer from a manual/demo one by sourceType, never blending the label", async () => {
  const repo = new MemoryPropertyMarketRepository();
  const now = new Date().toISOString();
  for (let i = 0; i < 4; i++) await repo.upsertMarketRecords([baseInput({ sourceRecordId: `p-${i}`, priceOMR: 700 + i * 5, sizeSqm: 128 + i, observedAt: now, sourceType: "official_statistics", sourceName: "NCSI Rental Index" })]);
  const provider = new CompositeOmanPropertyDataProvider([new OfficialOmanDataProvider(), new ListingDataProvider(), new DatabaseOmanPropertyDataProvider(repo)]);
  const result = await runOmanPropertyAnalysis({ governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: 2, sizeSqm: 130, askingPriceOMR: 118000 }, provider) as any;
  assert.equal(result.provenance.length, 1);
  assert.equal(result.provenance[0].sourceType, "official_statistics");
  assert.equal(result.provenance[0].sourceName, "NCSI Rental Index");
});

// ---------------------------------------------------------------------------------------------
// Al Mouj historical-sales production-readiness pass (Section 6/7/8): historicalSalesContext —
// a separate, additive enrichment of analyze_oman_property, never mixed into market/pricePosition/
// comparablesSummary/confidence, which stay driven exclusively by the current-comparable pool.
// ---------------------------------------------------------------------------------------------

function saleInput(overrides: Partial<MarketRecordInput> = {}): MarketRecordInput {
  return baseInput({
    transactionType: "sale", rentPeriod: null, furnished: null, priceOMR: 150_000,
    sourceType: "partner_feed", sourceName: "Al Mouj Muscat",
    metadata: { saleRecordType: "contracted_unit_price" },
    ...overrides
  });
}

test("historicalSalesContext: unavailable (available:false, all-empty) when the provider chain has no real transaction-level history, e.g. manual/demo mode", async () => {
  const provider = new CompositeOmanPropertyDataProvider([new OfficialOmanDataProvider(), new ListingDataProvider(), new ManualDatasetProvider(RENTAL_FIXTURES, SALE_FIXTURES)]);
  const result = await runOmanPropertyAnalysis({ governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: 2, sizeSqm: 130, askingPriceOMR: 118000 }, provider) as any;
  assert.deepEqual(result.historicalSalesContext, {
    available: false, recordsAvailable: 0, recentComparableSales: 0,
    medianHistoricalPricePerSqmOMR: null, recentMedianPricePerSqmOMR: null,
    oldestRecordDate: null, latestRecordDate: null, sourceTypes: [], priceSemantics: [], phaseBreakdown: []
  });
});

test("historicalSalesContext: unavailable for an unsupported location, same as every other market.* figure", async () => {
  const repo = new MemoryPropertyMarketRepository();
  await repo.upsertMarketRecords([saleInput({ sourceRecordId: "s-1" })]);
  const provider = new CompositeOmanPropertyDataProvider([new OfficialOmanDataProvider(), new ListingDataProvider(), new DatabaseOmanPropertyDataProvider(repo)]);
  const result = await runOmanPropertyAnalysis({ governorate: "Muscat", area: "Nowhereville", propertyType: "apartment", sizeSqm: 130, askingPriceOMR: 118000 }, provider) as any;
  assert.equal(result.historicalSalesContext.available, false);
});

test("historicalSalesContext: reports accurate full-history figures (recordsAvailable, date range, median, sourceTypes, priceSemantics) via DB-side aggregation", async () => {
  const repo = new MemoryPropertyMarketRepository();
  const oldDate = new Date(Date.now() - 3000 * 86_400_000).toISOString(); // ~8 years ago
  const midDate = new Date(Date.now() - 1000 * 86_400_000).toISOString();
  const recentDate = new Date(Date.now() - 30 * 86_400_000).toISOString();
  await repo.upsertMarketRecords([
    saleInput({ sourceRecordId: "h-1", priceOMR: 100_000, sizeSqm: 100, observedAt: oldDate }),  // 1000/sqm
    saleInput({ sourceRecordId: "h-2", priceOMR: 150_000, sizeSqm: 100, observedAt: midDate }),  // 1500/sqm
    saleInput({ sourceRecordId: "h-3", priceOMR: 200_000, sizeSqm: 100, observedAt: recentDate }) // 2000/sqm
  ]);
  const provider = new CompositeOmanPropertyDataProvider([new OfficialOmanDataProvider(), new ListingDataProvider(), new DatabaseOmanPropertyDataProvider(repo)]);
  const result = await runOmanPropertyAnalysis({ governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", sizeSqm: 100, askingPriceOMR: 118000 }, provider) as any;
  assert.equal(result.historicalSalesContext.available, true);
  assert.equal(result.historicalSalesContext.recordsAvailable, 3);
  assert.equal(result.historicalSalesContext.oldestRecordDate, oldDate);
  assert.equal(result.historicalSalesContext.latestRecordDate, recentDate);
  assert.equal(result.historicalSalesContext.medianHistoricalPricePerSqmOMR, 1500);
  assert.deepEqual(result.historicalSalesContext.sourceTypes, ["partner_feed"]);
  assert.deepEqual(result.historicalSalesContext.priceSemantics, ["contracted_unit_price"]);
});

test("historicalSalesContext.phaseBreakdown: only phases meeting the minimum sample size are reported, sorted by recordCount, never a trend claimed from an insufficient sample", async () => {
  const repo = new MemoryPropertyMarketRepository();
  const now = new Date().toISOString();
  // Phase A: 4 records (meets MIN_COMPARABLES) — must appear.
  for (let i = 0; i < 4; i++) await repo.upsertMarketRecords([saleInput({ sourceRecordId: `a-${i}`, priceOMR: 100_000 + i * 1000, sizeSqm: 100, observedAt: now, metadata: { saleRecordType: "contracted_unit_price", phaseName: "Phase A" } })]);
  // Phase B: 2 records (below MIN_COMPARABLES) — must be omitted entirely, not flagged/caveated.
  for (let i = 0; i < 2; i++) await repo.upsertMarketRecords([saleInput({ sourceRecordId: `b-${i}`, priceOMR: 200_000, sizeSqm: 100, observedAt: now, metadata: { saleRecordType: "contracted_unit_price", phaseName: "Phase B" } })]);
  const provider = new CompositeOmanPropertyDataProvider([new OfficialOmanDataProvider(), new ListingDataProvider(), new DatabaseOmanPropertyDataProvider(repo)]);
  const result = await runOmanPropertyAnalysis({ governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", sizeSqm: 100, askingPriceOMR: 118000 }, provider) as any;
  assert.equal(result.historicalSalesContext.phaseBreakdown.length, 1);
  assert.equal(result.historicalSalesContext.phaseBreakdown[0].phaseName, "Phase A");
  assert.equal(result.historicalSalesContext.phaseBreakdown[0].recordCount, 4);
});

test("historicalSalesContext.recentComparableSales: respects the configurable OMAN_RECENT_SALES_DAYS window and size similarity — never counts every historical sale", async () => {
  const repo = new MemoryPropertyMarketRepository();
  const veryOld = new Date(Date.now() - 1500 * 86_400_000).toISOString(); // outside default 730-day window
  const recent = new Date(Date.now() - 30 * 86_400_000).toISOString();
  await repo.upsertMarketRecords([saleInput({ sourceRecordId: "old-1", sizeSqm: 100, priceOMR: 100_000, observedAt: veryOld })]);
  for (let i = 0; i < 3; i++) await repo.upsertMarketRecords([saleInput({ sourceRecordId: `recent-${i}`, sizeSqm: 100 + i, priceOMR: 150_000 + i * 1000, observedAt: recent })]);
  await repo.upsertMarketRecords([saleInput({ sourceRecordId: "recent-wrong-size", sizeSqm: 500, priceOMR: 600_000, observedAt: recent })]); // recent but far outside ±20% size tolerance
  const provider = new CompositeOmanPropertyDataProvider([new OfficialOmanDataProvider(), new ListingDataProvider(), new DatabaseOmanPropertyDataProvider(repo)]);
  const query = { governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", sizeSqm: 100, askingPriceOMR: 118000 };

  const defaultResult = await runOmanPropertyAnalysis(query, provider) as any;
  assert.equal(defaultResult.historicalSalesContext.recordsAvailable, 5, "full history is unaffected by the recent window");
  assert.equal(defaultResult.historicalSalesContext.recentComparableSales, 3, "only the 3 recent, similarly-sized sales count — not the very old one, not the wrong-size one");
  assert.ok(defaultResult.historicalSalesContext.recentMedianPricePerSqmOMR !== null);

  process.env.OMAN_RECENT_SALES_DAYS = "10"; // narrower than the 30-day-old "recent" fixtures above
  try {
    const narrowResult = await runOmanPropertyAnalysis(query, provider) as any;
    assert.equal(narrowResult.historicalSalesContext.recentComparableSales, 0, "a narrower configured window must exclude sales outside it — the window is never hardcoded");
    assert.equal(narrowResult.historicalSalesContext.recordsAvailable, 5, "the configurable recent window must never affect the full-history aggregate");
  } finally {
    delete process.env.OMAN_RECENT_SALES_DAYS;
  }
});

test("historicalSalesContext: a completed-sale record with no recorded furnished status (true of every real partner sale) still counts as historical sales intelligence, and (Al Mouj production-readiness fix) now ALSO contributes to the current sale-comparable pool instead of being dropped", async () => {
  const repo = new MemoryPropertyMarketRepository();
  const now = new Date().toISOString();
  for (let i = 0; i < 4; i++) await repo.upsertMarketRecords([saleInput({ sourceRecordId: `nf-${i}`, sizeSqm: 130, priceOMR: 150_000 + i * 1000, observedAt: now })]); // furnished: null throughout (saleInput's default)
  const provider = new CompositeOmanPropertyDataProvider([new OfficialOmanDataProvider(), new ListingDataProvider(), new DatabaseOmanPropertyDataProvider(repo)]);
  const result = await runOmanPropertyAnalysis({ governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: 2, sizeSqm: 130, askingPriceOMR: 118000 }, provider) as any;
  // Al Mouj production-readiness fix: furnished: null must NOT cause a valid sale record to be
  // dropped from the CURRENT sale-comparable pipeline (pricePosition) any more — these 4 records
  // meet MIN_COMPARABLES on area/propertyType/bedrooms/size/recency alone, so pricePosition is now
  // computable from them despite none carrying a furnished status.
  assert.notEqual(result.pricePosition.marketPosition, "insufficient_data");
  assert.ok(result.pricePosition.observedComparableRange !== null);
  assert.ok(!result.riskFlags.includes("insufficient_sale_market_data"));
  const saleProvenance = result.provenance.find((p: any) => p.sourceType === "partner_feed" && p.sourceName === "Al Mouj Muscat");
  assert.ok(saleProvenance, "the furnished-null partner_feed sale records must be traceable in provenance");
  assert.equal(saleProvenance.recordCount, 4);
  // historicalSalesContext, which never required furnished either, still honestly reports them —
  // completely unchanged by this fix.
  assert.equal(result.historicalSalesContext.available, true);
  assert.equal(result.historicalSalesContext.recordsAvailable, 4);
  assert.equal(result.historicalSalesContext.recentComparableSales, 4);
});

// ---------------------------------------------------------------------------------------------
// Al Mouj production-readiness fix: furnished must behave differently for SALE comparables than
// for RENTAL comparables. See src/domain/oman/comparables.ts's selectSaleComparables() (new) and
// selectComparables() (unchanged, now type-restricted to non-nullable-furnished pools only), and
// DatabaseOmanPropertyDataProvider.findSaleComparables() in dataProviders.ts.
// ---------------------------------------------------------------------------------------------
test("selectSaleComparables: a sale comparable with furnished=null is accepted into both the candidate pool and the used sample", () => {
  const pool = SALE_FIXTURES.map(s => ({ ...s, furnished: null }));
  const selection = selectSaleComparables(pool, { area: "Al Mouj", propertyType: "apartment", bedrooms: 2, sizeSqm: 130 }, r => r.askingPriceOMR);
  assert.ok(selection.candidatePool.length > 0, "furnished:null records must not be excluded from the candidate pool");
  assert.ok(selection.used.length > 0, "furnished:null records must not be excluded from the used sample");
  assert.ok(selection.used.every(r => r.furnished === null), "furnished must remain null, never coerced");
});

test("selectSaleComparables: furnished=true (\"furnished\") and furnished=false (\"unfurnished\") sale comparables are both accepted identically to furnished=null", () => {
  const query = { area: "Al Mouj", propertyType: "apartment" as const, bedrooms: 2, sizeSqm: 130 };
  const nullPool = SALE_FIXTURES.map(s => ({ ...s, furnished: null }));
  const furnishedPool = SALE_FIXTURES.map(s => ({ ...s, furnished: "furnished" as const }));
  const unfurnishedPool = SALE_FIXTURES.map(s => ({ ...s, furnished: "unfurnished" as const }));
  const nullSelection = selectSaleComparables(nullPool, query, r => r.askingPriceOMR);
  const furnishedSelection = selectSaleComparables(furnishedPool, query, r => r.askingPriceOMR);
  const unfurnishedSelection = selectSaleComparables(unfurnishedPool, query, r => r.askingPriceOMR);
  // Identical candidate/used counts regardless of furnished value — furnished is never inspected.
  assert.equal(furnishedSelection.used.length, nullSelection.used.length);
  assert.equal(unfurnishedSelection.used.length, nullSelection.used.length);
});

test("selectSaleComparables: a mismatched furnished status never eliminates an otherwise-valid sale comparable — furnished is never filtered at all", () => {
  const query = { area: "Al Mouj", propertyType: "apartment" as const, bedrooms: 2, sizeSqm: 130, furnished: "furnished" as const };
  // Every record in this pool explicitly mismatches the query's furnished value.
  const allUnfurnished = SALE_FIXTURES.map(s => ({ ...s, furnished: "unfurnished" as const }));
  const selection = selectSaleComparables(allUnfurnished, query, r => r.askingPriceOMR);
  assert.ok(selection.used.length > 0, "a furnished mismatch must never drop an otherwise-valid sale comparable");
});

test("selectSaleComparables: furnished:null is never coerced to furnished:false/\"unfurnished\" anywhere in the selection output", () => {
  const pool = SALE_FIXTURES.filter(s => s.area === "Al Mouj" && s.propertyType === "apartment").map(s => ({ ...s, furnished: null }));
  const selection = selectSaleComparables(pool, { area: "Al Mouj", propertyType: "apartment", bedrooms: 2, sizeSqm: 130 }, r => r.askingPriceOMR);
  for (const r of [...selection.candidatePool, ...selection.used]) {
    assert.equal(r.furnished, null, "null must stay null, never become \"unfurnished\"");
    assert.notEqual(r.furnished, "unfurnished");
  }
});

test("selectComparables: rental furnished-matching behavior is completely unchanged by the sale-side fix — exact match still preferred, relaxed only per the existing rule", () => {
  // Reuses the exact same pool/query shape as the pre-existing rental furnished-relaxation test in
  // oman-property.test.ts, as a direct regression check on selectComparables() itself.
  const exactMatch = selectComparables(RENTAL_FIXTURES, { area: "Al Mouj", propertyType: "apartment", bedrooms: 2, sizeSqm: 130, furnished: "furnished" }, r => (r.rentPeriod === "annual" ? r.rentAmountOMR / 12 : r.rentAmountOMR));
  assert.ok(exactMatch.used.every(r => r.furnished === "furnished" || exactMatch.furnishedFilterRelaxed), "furnished must still be exact-matched (or honestly reported as relaxed) for rentals");
});

test("DatabaseOmanPropertyDataProvider.findSaleComparables: a partner sale record with furnished=null is no longer excluded, but bedrooms=null still is (unchanged)", async () => {
  const repo = new MemoryPropertyMarketRepository();
  await repo.upsertMarketRecords([
    saleInput({ sourceRecordId: "no-furnished-sale", furnished: null }),
    saleInput({ sourceRecordId: "no-bedrooms-sale", bedrooms: null }),
    saleInput({ sourceRecordId: "complete-sale", furnished: "furnished" })
  ]);
  const provider = new DatabaseOmanPropertyDataProvider(repo);
  const sales = await provider.findSaleComparables({ area: "Al Mouj", propertyType: "apartment", sizeSqm: 130, bedrooms: 2 });
  const ids = sales.map(s => s.id);
  assert.equal(sales.length, 2, "furnished:null is now accepted, bedrooms:null is still excluded");
  assert.ok(sales.some(s => s.furnished === null), "the furnished:null record's furnished value must be preserved as null, not coerced");
});

test("DatabaseOmanPropertyDataProvider.findRentalComparables: a rental record with furnished=null is still excluded, exactly as before this fix", async () => {
  const repo = new MemoryPropertyMarketRepository();
  await repo.upsertMarketRecords([
    baseInput({ sourceRecordId: "no-furnished-rental", furnished: null }),
    baseInput({ sourceRecordId: "complete-rental" })
  ]);
  const provider = new DatabaseOmanPropertyDataProvider(repo);
  const rentals = await provider.findRentalComparables({ area: "Al Mouj", propertyType: "apartment", sizeSqm: 130, bedrooms: 2 });
  assert.equal(rentals.length, 1, "rental furnished:null exclusion must remain completely unchanged");
  assert.equal(rentals[0]!.id, "mem-2");
});

test("runOmanPropertyAnalysis: Al Mouj partner sale records with furnished=null contribute to pricePosition and are attributable to partner_feed in provenance", async () => {
  const repo = new MemoryPropertyMarketRepository();
  const now = new Date().toISOString();
  for (let i = 0; i < 4; i++) {
    await repo.upsertMarketRecords([saleInput({ sourceRecordId: `pf-${i}`, sizeSqm: 130, priceOMR: 148_000 + i * 2000, observedAt: now })]); // furnished: null (saleInput's default)
  }
  const provider = new CompositeOmanPropertyDataProvider([new OfficialOmanDataProvider(), new ListingDataProvider(), new DatabaseOmanPropertyDataProvider(repo)]);
  const result = await runOmanPropertyAnalysis({ governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: 2, sizeSqm: 130, askingPriceOMR: 118000 }, provider) as any;
  assert.ok(result.pricePosition.observedComparableRange !== null, "pricePosition must be computable from furnished-null partner sale records alone");
  assert.notEqual(result.pricePosition.marketPosition, "insufficient_data");
  const partnerProvenance = result.provenance.find((p: any) => p.sourceType === "partner_feed");
  assert.ok(partnerProvenance, "provenance must show partner_feed contributing");
  assert.ok(!result.riskFlags.includes("demo_dataset_not_live_market_data"), "real partner data alone must never carry the demo-dataset flag");
});

test("confidence: sale-comparable furnished status (present, absent, or a mix) never affects the confidence score, since confidence is computed only from the rental sample", async () => {
  const rentalRepo = new MemoryPropertyMarketRepository();
  const now = new Date().toISOString();
  for (let i = 0; i < 5; i++) await rentalRepo.upsertMarketRecords([baseInput({ sourceRecordId: `r-${i}`, priceOMR: 700 + i * 5, sizeSqm: 128 + i, observedAt: now })]);

  const withNullFurnishedSales = new MemoryPropertyMarketRepository();
  const withSpecifiedFurnishedSales = new MemoryPropertyMarketRepository();
  for (const [repo, furnished] of [[withNullFurnishedSales, null], [withSpecifiedFurnishedSales, "furnished" as const]] as const) {
    for (let i = 0; i < 5; i++) await repo.upsertMarketRecords([baseInput({ sourceRecordId: `r-${i}`, priceOMR: 700 + i * 5, sizeSqm: 128 + i, observedAt: now })]);
    for (let i = 0; i < 4; i++) await repo.upsertMarketRecords([saleInput({ sourceRecordId: `s-${i}`, sizeSqm: 130, priceOMR: 150_000 + i * 1000, observedAt: now, furnished })]);
  }
  const providerA = new CompositeOmanPropertyDataProvider([new OfficialOmanDataProvider(), new ListingDataProvider(), new DatabaseOmanPropertyDataProvider(withNullFurnishedSales)]);
  const providerB = new CompositeOmanPropertyDataProvider([new OfficialOmanDataProvider(), new ListingDataProvider(), new DatabaseOmanPropertyDataProvider(withSpecifiedFurnishedSales)]);
  const resultA = await runOmanPropertyAnalysis({ governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: 2, sizeSqm: 130, askingPriceOMR: 118000 }, providerA) as any;
  const resultB = await runOmanPropertyAnalysis({ governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: 2, sizeSqm: 130, askingPriceOMR: 118000 }, providerB) as any;
  assert.equal(resultA.confidence.score, resultB.confidence.score, "unknown vs. known sale furnishing must never change the confidence score");
  assert.equal(resultA.confidence.level, resultB.confidence.level);
  assert.deepEqual(resultA.confidence.reasons, resultB.confidence.reasons);
});

test("historicalSalesContext code path is completely unaffected by the sale-comparable furnished fix — same inputs still produce the same historicalSalesContext regardless of pricePosition now succeeding", async () => {
  const repo = new MemoryPropertyMarketRepository();
  const now = new Date().toISOString();
  for (let i = 0; i < 4; i++) await repo.upsertMarketRecords([saleInput({ sourceRecordId: `hsc-${i}`, sizeSqm: 130, priceOMR: 150_000 + i * 1000, observedAt: now })]);
  const provider = new CompositeOmanPropertyDataProvider([new OfficialOmanDataProvider(), new ListingDataProvider(), new DatabaseOmanPropertyDataProvider(repo)]);
  const result = await runOmanPropertyAnalysis({ governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: 2, sizeSqm: 130, askingPriceOMR: 118000 }, provider) as any;
  // Same shape/values this feature has always produced for this exact input (see the
  // "reports accurate full-history figures" test above) — pricePosition now succeeding where it
  // used to report insufficient_data has no bearing on historicalSalesContext whatsoever.
  assert.equal(result.historicalSalesContext.available, true);
  assert.equal(result.historicalSalesContext.recordsAvailable, 4);
  assert.equal(result.historicalSalesContext.recentComparableSales, 4);
  assert.deepEqual(result.historicalSalesContext.sourceTypes, ["partner_feed"]);
  assert.deepEqual(result.historicalSalesContext.priceSemantics, ["contracted_unit_price"]);
});

test("historicalSalesContext validates against analyze_oman_property's published output schema", async () => {
  const repo = new MemoryPropertyMarketRepository();
  await repo.upsertMarketRecords([saleInput({ sourceRecordId: "schema-1", sizeSqm: 130, priceOMR: 150_000, metadata: { saleRecordType: "contracted_unit_price", phaseName: "Phase A" } })]);
  const provider = new CompositeOmanPropertyDataProvider([new OfficialOmanDataProvider(), new ListingDataProvider(), new DatabaseOmanPropertyDataProvider(repo)]);
  const result = await runOmanPropertyAnalysis({ governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: 2, sizeSqm: 130, askingPriceOMR: 118000 }, provider);
  const capability = capabilities.find(c => c.name === "analyze_oman_property")!;
  const parsed = capability.output.safeParse(result);
  assert.ok(parsed.success, parsed.success ? "" : JSON.stringify((parsed as any).error.issues, null, 2));
});

// ---------------------------------------------------------------------------------------------
// Phase 9: caching
// ---------------------------------------------------------------------------------------------
test("MemoryComparableCache: returns what was set until the TTL expires, then reports a miss", async () => {
  const cache = new MemoryComparableCache(50);
  await cache.set("k", [{ id: "1" }]);
  assert.deepEqual(await cache.get("k"), [{ id: "1" }]);
  await new Promise(r => setTimeout(r, 80));
  assert.equal(await cache.get("k"), null);
});

test("buildComparableCacheKey: differs by area/propertyType/transactionType/furnished, but collapses nearby sizes into the same bucket", () => {
  const a = buildComparableCacheKey({ area: "Al Mouj", propertyType: "apartment", sizeSqm: 128, transactionType: "rental" });
  const b = buildComparableCacheKey({ area: "Al Mouj", propertyType: "apartment", sizeSqm: 135, transactionType: "rental" });
  const c = buildComparableCacheKey({ area: "Al Mouj", propertyType: "villa", sizeSqm: 128, transactionType: "rental" });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("DatabaseOmanPropertyDataProvider: with a cache configured, a second identical query does not hit the repository again", async () => {
  const repo = new MemoryPropertyMarketRepository();
  await repo.upsertMarketRecords([baseInput({ sourceRecordId: "cached-1" })]);
  let calls = 0;
  const countingRepo = new Proxy(repo, { get(target, prop, receiver) {
    if (prop === "findRentalComparables") { calls++; return Reflect.get(target, prop, receiver).bind(target); }
    return Reflect.get(target, prop, receiver);
  } });
  const provider = new DatabaseOmanPropertyDataProvider(countingRepo, new MemoryComparableCache(60_000));
  const query = { area: "Al Mouj", propertyType: "apartment" as const, sizeSqm: 130, bedrooms: 2 };
  await provider.findRentalComparables(query);
  await provider.findRentalComparables(query);
  assert.equal(calls, 1, "the second call should be served from cache, not the repository");
});

// ---------------------------------------------------------------------------------------------
// Phase 4/10: import pipeline — validation, normalization, dedup, security limits
// ---------------------------------------------------------------------------------------------
test("parseCsv: handles quoted fields with embedded commas and escaped quotes", () => {
  const rows = parseCsv('a,b\n"hello, world","she said ""hi"""\n');
  assert.deepEqual(rows, [{ a: "hello, world", b: 'she said "hi"' }]);
});

test("parseJsonRows: accepts a bare array or a { records: [...] } wrapper, rejects anything else", () => {
  assert.deepEqual(parseJsonRows("[1,2]"), [1, 2]);
  assert.deepEqual(parseJsonRows('{"records":[1,2]}'), [1, 2]);
  assert.throws(() => parseJsonRows('{"foo":1}'));
});

test("importMarketRecords: valid rows are normalized and upserted; malformed rows are rejected individually with a row number, not the whole batch", async () => {
  const repo = new MemoryPropertyMarketRepository();
  const rows = [
    { governorate: "Muscat", wilayat: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: "2", bathrooms: "2", sizeSqm: "130", transactionType: "rental", priceOMR: "750", rentPeriod: "monthly", furnished: "furnished", sourceType: "listing_asking_price", sourceName: "Feed", sourceRecordId: "ok-1", sourceUrl: "", observedAt: "2026-07-01", metadata: "" },
    { governorate: "Muscat", area: "Nowhereville", propertyType: "apartment", sizeSqm: "100", transactionType: "sale", priceOMR: "50000", sourceType: "listing_asking_price", sourceName: "Feed", observedAt: "2026-07-01" }, // unrecognized area
    { governorate: "Muscat", area: "Al Mouj", propertyType: "boat", sizeSqm: "100", transactionType: "sale", priceOMR: "50000", sourceType: "listing_asking_price", sourceName: "Feed", observedAt: "2026-07-01" } // bad propertyType
  ];
  const result = await importMarketRecords(rows, repo);
  assert.equal(result.totalRows, 3);
  assert.equal(result.imported, 1);
  assert.equal(result.errors.length, 2);
  assert.equal(result.errors[0]!.row, 2);
  assert.equal(result.errors[1]!.row, 3);
  assert.match(result.errors[0]!.reason, /not a recognized Muscat area/);
  assert.match(result.errors[1]!.reason, /propertyType/);
});

test("importMarketRecords: accepts a normal apartment within the apartment size bound", async () => {
  const repo = new MemoryPropertyMarketRepository();
  const bounds = SIZE_BOUNDS_BY_PROPERTY_TYPE.apartment;
  const midSize = Math.round((bounds.min + bounds.max) / 2);
  const result = await importMarketRecords([{
    governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", sizeSqm: String(midSize), transactionType: "sale",
    priceOMR: "150000", sourceType: "listing_asking_price", sourceName: "Feed", sourceRecordId: "apt-normal", observedAt: "2026-07-01"
  }], repo);
  assert.equal(result.imported, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(repo.all()[0]!.sizeSqm, midSize);
});

test("importMarketRecords: rejects an oversized apartment above the apartment size bound", async () => {
  const repo = new MemoryPropertyMarketRepository();
  const oversized = SIZE_BOUNDS_BY_PROPERTY_TYPE.apartment.max + 500;
  const result = await importMarketRecords([{
    governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", sizeSqm: String(oversized), transactionType: "sale",
    priceOMR: "150000", sourceType: "listing_asking_price", sourceName: "Feed", sourceRecordId: "apt-oversized", observedAt: "2026-07-01"
  }], repo);
  assert.equal(result.imported, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]!.code, "INVALID_SIZE");
  assert.match(result.errors[0]!.reason, /apartment/);
});

test("importMarketRecords: accepts a normal villa within the villa size bound", async () => {
  const repo = new MemoryPropertyMarketRepository();
  const result = await importMarketRecords([{
    governorate: "Muscat", area: "Al Mouj", propertyType: "villa", sizeSqm: "450", transactionType: "sale",
    priceOMR: "650000", sourceType: "listing_asking_price", sourceName: "Feed", sourceRecordId: "villa-normal", observedAt: "2026-07-01"
  }], repo);
  assert.equal(result.imported, 1);
  assert.equal(result.errors.length, 0);
});

test("importMarketRecords: accepts an ultra-luxury villa above the old generic 3,000 sqm cap (e.g. a Zunairah-style villa)", async () => {
  const repo = new MemoryPropertyMarketRepository();
  assert.ok(SIZE_BOUNDS_BY_PROPERTY_TYPE.villa.max > 3000, "villa bound must exceed the old generic 3,000 sqm cap for this test to be meaningful");
  const result = await importMarketRecords([{
    governorate: "Muscat", area: "Al Mouj", propertyType: "villa", sizeSqm: "6367", transactionType: "sale",
    priceOMR: "5800000", sourceType: "partner_feed", sourceName: "Al Mouj Muscat", sourceRecordId: "villa-zunairah", observedAt: "2026-07-01"
  }], repo);
  assert.equal(result.imported, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(repo.all()[0]!.sizeSqm, 6367);
});

test("importMarketRecords: rejects an extreme, implausible villa size outside the villa bound", async () => {
  const repo = new MemoryPropertyMarketRepository();
  const extreme = SIZE_BOUNDS_BY_PROPERTY_TYPE.villa.max + 50_000;
  const result = await importMarketRecords([{
    governorate: "Muscat", area: "Al Mouj", propertyType: "villa", sizeSqm: String(extreme), transactionType: "sale",
    priceOMR: "5800000", sourceType: "listing_asking_price", sourceName: "Feed", sourceRecordId: "villa-extreme", observedAt: "2026-07-01"
  }], repo);
  assert.equal(result.imported, 0);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]!.code, "INVALID_SIZE");
  assert.match(result.errors[0]!.reason, /villa/);
});

test("importMarketRecords: accepts a normal townhouse within the townhouse size bound", async () => {
  const repo = new MemoryPropertyMarketRepository();
  const bounds = SIZE_BOUNDS_BY_PROPERTY_TYPE.townhouse;
  const midSize = Math.round((bounds.min + bounds.max) / 2);
  const result = await importMarketRecords([{
    governorate: "Muscat", area: "Al Mouj", propertyType: "townhouse", sizeSqm: String(midSize), transactionType: "sale",
    priceOMR: "300000", sourceType: "listing_asking_price", sourceName: "Feed", sourceRecordId: "townhouse-normal", observedAt: "2026-07-01"
  }], repo);
  assert.equal(result.imported, 1);
  assert.equal(result.errors.length, 0);
  assert.equal(repo.all()[0]!.sizeSqm, midSize);
});

test("importMarketRecords: rejects a row with an unknown/extra column instead of silently accepting it", async () => {
  const repo = new MemoryPropertyMarketRepository();
  const result = await importMarketRecords([{ ...{
    governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", sizeSqm: "130", transactionType: "sale", priceOMR: "118000", sourceType: "listing_asking_price", sourceName: "Feed", observedAt: "2026-07-01"
  }, unexpectedColumn: "surprise" }], repo);
  assert.equal(result.imported, 0);
  assert.equal(result.errors.length, 1);
});

test("importMarketRecords: Arabic and English area spellings both resolve to the same canonical normalizedArea", async () => {
  const repo = new MemoryPropertyMarketRepository();
  const rowFor = (area: string, id: string) => ({
    governorate: "Muscat", area, propertyType: "apartment", sizeSqm: "130", transactionType: "sale",
    priceOMR: "118000", sourceType: "listing_asking_price", sourceName: "Feed", sourceRecordId: id, observedAt: "2026-07-01"
  });
  await importMarketRecords([rowFor("الموج", "ar"), rowFor("the wave", "en"), rowFor("Al Mouj", "canonical")], repo);
  const stored = repo.all();
  assert.equal(stored.length, 3);
  assert.ok(stored.every(r => r.normalizedArea === "al mouj"));
});

test("importMarketRecords: re-importing the same file updates rather than duplicates records that have a sourceRecordId", async () => {
  const repo = new MemoryPropertyMarketRepository();
  const rows = [{ governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", sizeSqm: "130", transactionType: "sale", priceOMR: "118000", sourceType: "listing_asking_price", sourceName: "Feed", sourceRecordId: "same-id", observedAt: "2026-07-01" }];
  const first = await importMarketRecords(rows, repo);
  const second = await importMarketRecords(rows, repo);
  assert.equal(first.imported, 1);
  assert.equal(second.imported, 0);
  assert.equal(second.updated, 1);
  assert.equal(repo.all().length, 1);
});

test("importMarketRecords: normalizes monthly/annual rent-period aliases and rejects a rental row missing rentPeriod", async () => {
  const repo = new MemoryPropertyMarketRepository();
  const result = await importMarketRecords([
    { governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", sizeSqm: "130", transactionType: "rental", priceOMR: "9000", rentPeriod: "yearly", sourceType: "listing_asking_price", sourceName: "Feed", sourceRecordId: "y1", observedAt: "2026-07-01" },
    { governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", sizeSqm: "130", transactionType: "rental", priceOMR: "750", sourceType: "listing_asking_price", sourceName: "Feed", sourceRecordId: "missing-period", observedAt: "2026-07-01" }
  ], repo);
  assert.equal(result.imported, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]!.reason, /rentPeriod is required/);
  assert.equal(repo.all()[0]!.rentPeriod, "annual");
});

test("importMarketRecords: strips control characters from free-text fields rather than storing them verbatim", async () => {
  const repo = new MemoryPropertyMarketRepository();
  await importMarketRecords([{
    governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", sizeSqm: "130", transactionType: "sale",
    priceOMR: "118000", sourceType: "listing_asking_price", sourceName: "Feed\u0007WithBell", sourceRecordId: "ctrl-1", observedAt: "2026-07-01"
  }], repo);
  assert.equal(repo.all()[0]!.sourceName, "FeedWithBell");
});

test("importMarketRecords: rejects a batch larger than MAX_IMPORT_ROWS instead of accepting an unbounded file", async () => {
  const repo = new MemoryPropertyMarketRepository();
  const rows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, () => ({}));
  await assert.rejects(() => importMarketRecords(rows, repo), /exceeds the maximum/);
});

test("loadImportRows: rejects an unsupported file extension and a nonexistent path", () => {
  const dir = mkdtempSync(join(tmpdir(), "rafid-import-test-"));
  const badExt = join(dir, "data.txt");
  writeFileSync(badExt, "a,b\n1,2\n");
  assert.throws(() => loadImportRows(badExt), /Unsupported import file extension/);
  assert.throws(() => loadImportRows(join(dir, "does-not-exist.csv")));
});

test("loadImportRows: reads the project's sample CSV end-to-end and every row imports cleanly", async () => {
  const rows = loadImportRows("data/example-oman-market-import.csv");
  assert.ok(rows.length >= 5);
  const repo = new MemoryPropertyMarketRepository();
  const result = await importMarketRecords(rows, repo);
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  assert.equal(result.imported, rows.length);
});

// ---------------------------------------------------------------------------------------------
// PostgreSQL integration (dedicated test database required — same opt-in pattern as
// tests/customers.test.ts's CustomerStore integration test: skipped unless TEST_DATABASE_URL is
// set, since it needs a real, reachable Postgres instance rather than mocking one out).
// ---------------------------------------------------------------------------------------------
const dbUrl = process.env.TEST_DATABASE_URL;
test("PostgreSQL market-data integration: independent migration ledger, upsert/dedup, comparable queries, and the market:import CLI", { skip: !dbUrl }, async t => {
  const repo = new PostgresPropertyMarketRepository(dbUrl!);
  t.after(async () => { await repo.close(); });
  await repo.migrate();
  await repo.ready();

  const area = `Al Mouj`;
  const normalizedArea = "al mouj";
  const marker = randomUUID();

  await t.test("upsert inserts new rows and updates a re-imported one with the same (sourceName, sourceRecordId)", async () => {
    const first = await repo.upsertMarketRecords([{
      governorate: "Muscat", wilayat: "Muscat", area, normalizedArea, propertyType: "apartment",
      bedrooms: 2, bathrooms: 2, sizeSqm: 130, transactionType: "rental", priceOMR: 750, rentPeriod: "monthly",
      furnished: "furnished", sourceType: "listing_asking_price", sourceName: `pg-test-${marker}`, sourceRecordId: "1",
      sourceUrl: null, observedAt: new Date().toISOString(), metadata: {}
    }]);
    assert.deepEqual(first, { inserted: 1, updated: 0, skipped: 0 });
    const second = await repo.upsertMarketRecords([{
      governorate: "Muscat", wilayat: "Muscat", area, normalizedArea, propertyType: "apartment",
      bedrooms: 2, bathrooms: 2, sizeSqm: 130, transactionType: "rental", priceOMR: 800, rentPeriod: "monthly",
      furnished: "furnished", sourceType: "listing_asking_price", sourceName: `pg-test-${marker}`, sourceRecordId: "1",
      sourceUrl: null, observedAt: new Date().toISOString(), metadata: {}
    }]);
    assert.deepEqual(second, { inserted: 0, updated: 1, skipped: 0 });
  });

  await t.test("findRentalComparables/findSaleComparables/findMarketStatistics/getLatestDataTimestamp all see the upserted row", async () => {
    const query = { normalizedArea, propertyType: "apartment" as const, transactionType: "rental" as const, maxAgeDays: 30 };
    const rentals = await repo.findRentalComparables(query);
    assert.ok(rentals.some(r => r.sourceName === `pg-test-${marker}` && r.priceOMR === 800));
    const stats = await repo.findMarketStatistics(query);
    assert.ok(stats && stats.sampleSize >= 1);
    const latest = await repo.getLatestDataTimestamp(query);
    assert.ok(latest);
  });

  await t.test("npm run market:import CLI validates, migrates and upserts the sample CSV against a live database", () => {
    const output = execFileSync(process.execPath, ["--import", "tsx", "src/marketImportCli.ts", "data/example-oman-market-import.csv"], {
      env: { ...process.env, DATABASE_URL: dbUrl }, encoding: "utf8", windowsHide: true
    });
    const result = JSON.parse(output);
    assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
    assert.ok(result.imported + result.updated >= 5);
  });
});
