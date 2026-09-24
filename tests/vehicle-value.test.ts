import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import http from "node:http";
import { createApp } from "../src/api/app.js";
import { loadConfig } from "../src/config/env.js";
import { buildOpenapi } from "../src/api/openapi.js";
import { capabilities } from "../src/domain/capabilities.js";
import { prices } from "../src/billing/catalog.js";
import { BillingService } from "../src/billing/service.js";
import { MemoryUsageRepository } from "../src/billing/usage.js";
import { MAX_DISCOVERY_DECLARATION_CHARS, buildX402Info, discoveryDeclaration } from "../src/billing/x402.js";
import { buildL402Info } from "../src/billing/l402/gate.js";
import { buildMppInfo } from "../src/billing/mpp/routes.js";
import { classifyDataSource } from "../src/analytics/dataSource.js";
import { MemoryAnalyticsRepository } from "../src/analytics/memoryRepository.js";
import { publicError } from "../src/utils/errors.js";
import { AGENT_GROUPS } from "../src/api/dashboard/service.js";
import { TtlCache } from "../src/intelligence/cache.js";
import { vehicleValueEstimateInput, MAX_MODEL_YEAR } from "../src/schemas/vehicleValueInputs.js";
import { vehicleValueEstimateOutput, type VehicleValueEstimateOutput } from "../src/schemas/vehicleValueOutputs.js";
import { runVehicleValueEstimate, previewVehicleValueEstimate, MARKET_POSITION_THRESHOLDS, type VehicleValueDependencies } from "../src/vehicle-value/service.js";
import { StaticVehicleMarketProvider, DatabaseVehicleMarketProvider } from "../src/vehicle-value/providers/providers.js";
import { deduplicate, sanitizeComparable } from "../src/vehicle-value/providers/router.js";
import { TableExchangeRates } from "../src/vehicle-value/currency.js";
import { MemoryVehicleMarketRepository } from "../src/vehicle-value/store/repository.js";
import { validateVehicleMarketRows } from "../src/vehicle-value/store/records.js";
import { VEHICLE_MARKET_SCHEMA_SQL } from "../src/vehicle-value/store/postgres.js";
import { normalizeCountry, normalizeMake } from "../src/vehicle-value/normalization.js";
import { outlierMask } from "../src/vehicle-value/valuation.js";
import { getVehicleValuationTelemetry, resetVehicleValuationTelemetry } from "../src/vehicle-value/telemetry.js";
import { MARKETS } from "../src/vehicle-value/markets.js";
import type { VehicleComparable } from "../src/vehicle-value/types.js";
import {
  FIXTURE_AS_OF, LAND_CRUISER_REQUEST, OMAN_LAND_CRUISER_LISTINGS, OMAN_LAND_CRUISER_OUTLIERS, SPARSE_PATROL_LISTINGS, STALE_LAND_CRUISER_LISTINGS,
  UAE_LAND_CRUISER_LISTINGS, fixtureToday, syntheticOmanProviders
} from "../src/vehicle-value/examples/fixtures.js";
import { VEHICLE_EXAMPLE_INPUT, VEHICLE_VALUE_EXAMPLE_OUTPUT } from "../src/domain/examples/vehicleValueEstimateExample.js";
import { VEHICLE_SYNTHETIC_EXAMPLE_NOTICE } from "../src/vehicle-value/examples/syntheticNotice.js";

/**
 * vehicle_value_estimate. Every listing is SYNTHETIC (src/vehicle-value/examples/fixtures.ts); no
 * external provider is ever called. Every engine call pins valuationDate / today so results are
 * reproducible. Assertions target relationships the fixtures imply (ordering, signs, flags,
 * arithmetic) rather than one arbitrary valuation number.
 */

const key = "test-only-not-a-real-credential-12345";
const wallet = "0x1234567890123456789012345678901234567890";
const ENDPOINT = "/api/v1/automotive/vehicle-value-estimate";
const cap = capabilities.find(c => c.name === "vehicle_value_estimate")!;
const REQ = { ...LAND_CRUISER_REQUEST, valuationDate: FIXTURE_AS_OF };
const MCP_DESCRIPTION = "Estimate the fair market value of a vehicle using make, model, year, trim, mileage, condition, ownership history, location and available market comparables. Returns a valuation range, private-sale estimate, dealer buy/retail estimates, depreciation, transparent valuation adjustments, confidence and risk flags.";
const WHEN_TO_USE = "Use this capability when an AI agent needs to estimate the current market value of a passenger vehicle, determine whether an asking price is reasonable, estimate private-sale or dealer values, assess depreciation, or evaluate a vehicle using local or regional market comparables.";

const omanProvider = () => new StaticVehicleMarketProvider("om-fixture", [...OMAN_LAND_CRUISER_LISTINGS, ...OMAN_LAND_CRUISER_OUTLIERS, ...SPARSE_PATROL_LISTINGS], { coverage: ["OM"] });
const deps = (extra: VehicleValueDependencies = {}): VehicleValueDependencies => ({ providers: [omanProvider()], today: fixtureToday, cache: null, ...extra });
const run = (input: Record<string, unknown>, extra: VehicleValueDependencies = {}) => runVehicleValueEstimate(input, deps(extra));
const adj = (r: VehicleValueEstimateOutput, factor: string) => r.adjustments.find(a => a.factor === factor);

function assertOrdering(r: VehicleValueEstimateOutput) {
  assert.ok(vehicleValueEstimateOutput.safeParse(r).success, JSON.stringify(vehicleValueEstimateOutput.safeParse(r).error?.issues?.slice(0, 3)));
  assert.ok(r.confidence.score >= 0 && r.confidence.score <= 1);
  if (r.status !== "estimated") return;
  const v = r.estimatedValue!;
  assert.ok(v.low <= v.mid && v.mid <= v.high, `low ≤ mid ≤ high: ${JSON.stringify(v)}`);
  assert.ok(r.estimatedDealerBuyPrice! <= r.estimatedPrivateSalePrice! && r.estimatedPrivateSalePrice! <= r.estimatedDealerRetailPrice!, "dealerBuy ≤ privateSale ≤ dealerRetail");
}

async function withServer<T>(config: ReturnType<typeof loadConfig>, fn: (base: string) => Promise<T>, options: Parameters<typeof createApp>[1] = {}): Promise<T> {
  const app = createApp(config, { logger: () => {}, ...options });
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally { server.closeAllConnections(); server.close(); }
}

// ---- 1–4: evidence regimes ------------------------------------------------------------------------

test("1. exact comparable match: same trim + same year + local market is preferred and yields a high-confidence estimate", async () => {
  const r = await run(REQ);
  assertOrdering(r);
  assert.equal(r.status, "estimated");
  assert.equal(r.methodology.fallbackLevel, "same_trim_same_year");
  assert.ok(r.marketStats.comparableCount >= 5);
  assert.ok(r.marketComparables.every(c => c.trim === "GXR" && c.year === 2022 && c.country === "OM"));
  assert.ok(r.marketComparables.every(c => c.similarityScore >= 0.8));
  assert.equal(r.confidence.level, "high");
  assert.equal(r.currency, "OMR");
  assert.equal(r.estimatedValue!.currency, "OMR");
  assert.ok(r.marketCoverage.liveMarketDataAvailable);
  // Fixture price model: 2022 GXR ≈ OMR 23,000 at 60,000 km — the midpoint lands in that neighbourhood.
  assert.ok(r.estimatedValue!.mid > 20_000 && r.estimatedValue!.mid < 26_000, String(r.estimatedValue!.mid));
});

test("2. sparse comparable market: two listings never produce an estimate; the real listings are shown, none invented", async () => {
  const r = await run({ ...REQ, make: "Nissan", model: "Patrol", year: 2019, trim: "LE", askingPrice: 15_000 });
  assertOrdering(r);
  assert.equal(r.status, "insufficient_market_data");
  assert.equal(r.estimatedValue, null);
  assert.equal(r.estimatedPrivateSalePrice, null);
  assert.equal(r.estimatedDealerBuyPrice, null);
  assert.equal(r.estimatedDealerRetailPrice, null);
  assert.equal(r.askingPriceAnalysis, null);
  assert.ok(r.riskFlags.includes("INSUFFICIENT_COMPARABLES"));
  assert.ok(r.confidence.score < 0.4);
  assert.equal(r.confidence.level, "very_low");
  const ids = new Set(SPARSE_PATROL_LISTINGS.map(l => `${l.sourceName}|${l.askingPrice}`));
  assert.equal(r.marketComparables.length, 2);
  assert.ok(r.marketComparables.every(c => ids.has(`${c.sourceName}|${c.originalAskingPrice}`)), "only real fixture listings are returned");
});

test("3. no comparable data: no provider covers the market ⇒ structured insufficient_market_data, very low confidence, nothing fabricated", async () => {
  const r = await run(REQ, { providers: [] });
  assertOrdering(r);
  assert.equal(r.status, "insufficient_market_data");
  assert.equal(r.estimatedValue, null);
  assert.deepEqual(r.marketComparables, []);
  assert.deepEqual(r.adjustments, []);
  assert.ok(r.riskFlags.includes("NO_MARKET_DATA_PROVIDER") && r.riskFlags.includes("INSUFFICIENT_COMPARABLES"));
  assert.ok(r.confidence.score < 0.2, String(r.confidence.score));
  assert.equal(r.marketCoverage.liveMarketDataAvailable, false);
  assert.equal(r.marketCoverage.valuationParametersConfigured, true, "valuation parameters exist for Oman even without data");
  assert.ok(r.assumptions.some(a => /No market-data provider covering Oman/.test(a)));
  // A provider that covers only another market is never queried for Oman.
  let called = false;
  const uaeOnly = new StaticVehicleMarketProvider("uae-only", UAE_LAND_CRUISER_LISTINGS, { coverage: ["US"] });
  const spy = Object.assign(uaeOnly, { searchComparables: async () => { called = true; return []; } });
  assert.equal((await run(REQ, { providers: [spy] })).status, "insufficient_market_data");
  assert.equal(called, false);
});

test("4. outlier removal: implausible listings are excluded by a robust (IQR/MAD) rule, not a price threshold, and counted", async () => {
  const withOutliers = await run(REQ);
  const clean = await run(REQ, { providers: [new StaticVehicleMarketProvider("om", OMAN_LAND_CRUISER_LISTINGS)] });
  assert.equal(withOutliers.marketStats.outliersExcluded, 2);
  assert.ok(withOutliers.riskFlags.includes("OUTLIERS_REMOVED"));
  assert.ok(!withOutliers.marketComparables.some(c => c.originalAskingPrice === 45_500 || c.originalAskingPrice === 9_800));
  assert.equal(clean.marketStats.outliersExcluded, 0);
  assert.ok(Math.abs(withOutliers.estimatedValue!.mid - clean.estimatedValue!.mid) / clean.estimatedValue!.mid < 0.02, "outliers do not corrupt the estimate");
  // The rule is relative: the same shape at 10× the price level flags the same members.
  const logs = [10, 10.02, 9.99, 10.01, 10.03, 11.2].map(v => v);
  assert.deepEqual(outlierMask(logs), [true, true, true, true, true, false]);
  assert.deepEqual(outlierMask(logs.map(v => v + Math.log(10))), [true, true, true, true, true, false]);
  assert.deepEqual(outlierMask([10, 10.1, 9.9]), [true, true, true], "n < 4 never removes anything");
});

// ---- 5–9: adjustments ------------------------------------------------------------------------------

test("5. mileage adjustment: relative to the comparable market, monotonic, signed correctly; unknown mileage is flagged, not guessed", async () => {
  const low = await run({ ...REQ, mileageKm: 30_000 });
  const mid = await run(REQ);
  const high = await run({ ...REQ, mileageKm: 160_000 });
  for (const r of [low, mid, high]) assertOrdering(r);
  assert.ok(low.estimatedValue!.mid >= mid.estimatedValue!.mid && mid.estimatedValue!.mid > high.estimatedValue!.mid);
  assert.ok(adj(low, "mileage")!.impactAmount > 0, "below-market mileage raises value");
  assert.ok(adj(high, "mileage")!.impactAmount < 0, "above-market mileage lowers value");
  assert.match(adj(high, "mileage")!.reason, /above the comparable-market median/);
  assert.equal(adj(high, "mileage")!.basis, "market_derived");
  assert.equal(high.vehicle.expectedMileageKm, Math.round(high.vehicle.ageYears * MARKETS.OM!.expectedAnnualKm));
  const { mileageKm, ...noKm } = REQ;
  void mileageKm;
  const unknown = await run(noKm);
  assert.ok(unknown.riskFlags.includes("MILEAGE_UNKNOWN"));
  assert.equal(adj(unknown, "mileage"), undefined);
  assert.equal(unknown.methodology.mileageEffect.basis, "not_applied");
  assert.ok(unknown.confidence.score < mid.confidence.score);
  // Sparse mileage evidence ⇒ conservative market default (heuristic), confidence reduced.
  const fewKm = OMAN_LAND_CRUISER_LISTINGS.filter(l => l.year === 2022 && l.trim === "GXR").slice(0, 5);
  const heuristic = await run(REQ, { providers: [new StaticVehicleMarketProvider("om", fewKm)] });
  assert.equal(heuristic.methodology.mileageEffect.basis, "heuristic");
  assert.ok(heuristic.riskFlags.includes("HEURISTIC_ADJUSTMENTS_USED"));
});

test("6. trim adjustment: a model-level pool is aligned to the subject's trim using the price gap measured in the pool", async () => {
  const gxr = await run(REQ);
  const vxr = await run({ ...REQ, trim: "VXR" });
  const exr = await run({ ...REQ, trim: "EXR" });
  for (const r of [gxr, vxr, exr]) assertOrdering(r);
  assert.ok(vxr.estimatedValue!.mid > gxr.estimatedValue!.mid && gxr.estimatedValue!.mid > exr.estimatedValue!.mid);
  assert.equal(adj(vxr, "trim")!.basis, "market_derived");
  assert.ok(adj(vxr, "trim")!.impactAmount > 0 && adj(exr, "trim")!.impactAmount < 0);
  assert.ok(vxr.riskFlags.includes("BROADENED_COMPARABLE_SEARCH"));
  // An unseen trim is valued at model level and says so — no trim premium is invented.
  const unseen = await run({ ...REQ, trim: "GR Sport" });
  assert.equal(adj(unseen, "trim"), undefined);
  assert.ok(unseen.assumptions.some(a => /GR Sport/.test(a) && /model-level/.test(a)));
  const { trim, ...noTrim } = REQ;
  void trim;
  const unknown = await run(noTrim);
  assert.ok(unknown.riskFlags.includes("TRIM_UNKNOWN"));
  assert.ok(unknown.confidence.score < gxr.confidence.score);
});

test("7. year adjustment: newer model years are worth more; cross-year comparables are aligned with a derived year effect", async () => {
  const y2021 = await run({ ...REQ, year: 2021, mileageKm: 80_000 });
  const y2022 = await run(REQ);
  const y2023 = await run({ ...REQ, year: 2023, mileageKm: 40_000 });
  for (const r of [y2021, y2022, y2023]) assertOrdering(r);
  assert.ok(y2021.estimatedValue!.mid < y2022.estimatedValue!.mid && y2022.estimatedValue!.mid < y2023.estimatedValue!.mid);
  assert.equal(y2022.methodology.yearEffect.basis, "not_needed");
  const yearAdj = adj(y2021, "model_year")!;
  assert.ok(yearAdj.impactAmount < 0, "2022-heavy pool aligned down to 2021");
  assert.equal(y2021.methodology.yearEffect.basis, "market_derived");
  assert.ok(y2021.methodology.yearEffect.annualPercent! > 3 && y2021.methodology.yearEffect.annualPercent! < 25);
  assert.equal(y2021.depreciation.marketImpliedAnnualDepreciationPercent, y2021.methodology.yearEffect.annualPercent);
});

test("8. accident history: none ≥ minor > repaired > structural; severity unknown/unverified is explicit", async () => {
  const none = await run(REQ);
  const minor = await run({ ...REQ, accidentHistory: "minor_cosmetic" });
  const repaired = await run({ ...REQ, accidentHistory: "repaired" });
  const structural = await run({ ...REQ, accidentHistory: "structural" });
  for (const r of [none, minor, repaired, structural]) assertOrdering(r);
  assert.ok(none.estimatedValue!.mid > minor.estimatedValue!.mid && minor.estimatedValue!.mid > repaired.estimatedValue!.mid && repaired.estimatedValue!.mid > structural.estimatedValue!.mid);
  assert.equal(adj(structural, "accident_history")!.basis, "heuristic");
  assert.ok(structural.riskFlags.includes("STRUCTURAL_DAMAGE_REPORTED"));
  assert.equal(none.vehicle.accidentHistory, "none");
  assert.ok(none.assumptions.some(a => /No undisclosed accident/.test(a)));
  const reported = await run({ ...REQ, accidentHistory: true });
  assert.equal(reported.vehicle.accidentHistory, "reported");
  assert.ok(reported.riskFlags.includes("ACCIDENT_SEVERITY_UNVERIFIED"));
  assert.ok(reported.assumptions.some(a => /severity could not be verified/.test(a)));
  const { accidentHistory, ...unknownInput } = REQ;
  void accidentHistory;
  const unknown = await run(unknownInput);
  assert.equal(unknown.vehicle.accidentHistory, "unknown");
  assert.ok(unknown.riskFlags.includes("ACCIDENT_HISTORY_UNKNOWN"));
  assert.ok(unknown.assumptions.some(a => /Accident history is unknown/.test(a)));
});

test("9. condition adjustment: ordered, capped, and never dominant over market evidence", async () => {
  const mids = await Promise.all((["excellent", "very_good", "good", "fair", "poor"] as const).map(async c => (await run({ ...REQ, condition: c })).estimatedValue!.mid));
  for (let i = 1; i < mids.length; i++) assert.ok(mids[i - 1]! >= mids[i]!, `condition ordering ${mids.join(" ≥ ")}`);
  assert.ok(mids[0]! > mids[4]!);
  assert.ok(mids[4]! / mids[2]! > 0.8, "poor condition alone moves the value by less than 20%");
  assert.ok(mids[0]! / mids[2]! < 1.07, "excellent condition alone moves the value by less than 7%");
  const worst = await run({ ...REQ, condition: "poor", accidentHistory: "structural", serviceHistory: "none", owners: 6 });
  assertOrdering(worst);
  assert.ok(worst.estimatedValue!.mid / mids[2]! > 0.6, "stacked vehicle-specific factors are capped in total");
  assert.ok(worst.assumptions.some(a => /capped/.test(a)));
  const { condition, ...noCond } = REQ;
  void condition;
  const unknown = await run(noCond);
  assert.ok(unknown.riskFlags.includes("CONDITION_UNKNOWN"));
  assert.equal(adj(unknown, "condition"), undefined);
});

// ---- 10–14: prices, asking price, confidence --------------------------------------------------------

test("10. dealer/private estimates: dealerBuy ≤ privateSale ≤ dealerRetail, from per-market configurable spreads", async () => {
  const om = await run(REQ);
  assertOrdering(om);
  const mid = om.estimatedValue!.mid;
  assert.ok(om.estimatedDealerBuyPrice! < mid && om.estimatedDealerRetailPrice! > mid);
  const m = MARKETS.OM!;
  const inRange = (v: number, r: readonly [number, number]) => v >= r[0] * 100 - 0.05 && v <= r[1] * 100 + 0.05;
  assert.ok(inRange(om.methodology.dealerBuyDiscountPercent!, m.dealerBuyDiscountRange));
  assert.ok(inRange(om.methodology.privateSaleAdjustmentPercent!, m.privateSaleAdjustmentRange));
  assert.ok(inRange(om.methodology.dealerRetailMarkupPercent!, m.dealerRetailMarkupRange));
  // Same evidence re-labelled as a US market uses the US parameters (different spreads, different currency).
  const usListings: VehicleComparable[] = OMAN_LAND_CRUISER_LISTINGS.map(l => ({ ...l, country: "US", city: "Houston", currency: "USD", askingPrice: l.askingPrice * 2 }));
  const us = await run({ ...REQ, country: "US", city: "Houston", currency: undefined, askingPrice: undefined }, { providers: [new StaticVehicleMarketProvider("us", usListings)] });
  assertOrdering(us);
  assert.equal(us.currency, "USD", "market default currency");
  assert.ok(inRange(us.methodology.dealerBuyDiscountPercent!, MARKETS.US!.dealerBuyDiscountRange));
  // Weaker evidence ⇒ a dealer applies a bigger discount.
  const weak = await run(REQ, { providers: [new StaticVehicleMarketProvider("om", OMAN_LAND_CRUISER_LISTINGS.slice(0, 5))] });
  assert.ok(weak.methodology.dealerBuyDiscountPercent! > om.methodology.dealerBuyDiscountPercent!);
});

test("11. asking-price comparison: exact difference and percentage from the midpoint, deterministic thresholds", async () => {
  const r = await run(REQ);
  const mid = r.estimatedValue!.mid;
  const a = r.askingPriceAnalysis!;
  assert.equal(a.askingPrice, 22_500);
  assert.equal(a.differenceFromMid, 22_500 - mid);
  assert.equal(a.differencePercent, Math.round(((22_500 - mid) / mid) * 100 * 100) / 100);
  assert.deepEqual(a.thresholdsPercent, MARKET_POSITION_THRESHOLDS);
  const position = async (ask: number) => (await run({ ...REQ, askingPrice: ask })).askingPriceAnalysis!;
  const cases: [number, string][] = [[0.80, "well_below_market"], [0.90, "below_market"], [1.00, "near_market"], [1.10, "above_market"], [1.25, "well_above_market"]];
  for (const [ratio, expected] of cases) assert.equal((await position(Math.round(mid * ratio))).marketPosition, expected, `${ratio}`);
  assert.equal((await position(mid)).differenceFromMid, 0);
  assert.equal((await position(mid)).withinEstimatedRange, true);
  const hi = await run({ ...REQ, askingPrice: Math.round(mid * 1.3) });
  assert.ok(hi.riskFlags.includes("ASKING_PRICE_SIGNIFICANTLY_ABOVE_MARKET"));
  const lo = await run({ ...REQ, askingPrice: Math.round(mid * 0.7) });
  assert.ok(lo.riskFlags.includes("ASKING_PRICE_SIGNIFICANTLY_BELOW_MARKET"));
  const { askingPrice, ...noAsk } = REQ;
  void askingPrice;
  assert.equal((await run(noAsk)).askingPriceAnalysis, null);
});

test("12. low ≤ mid ≤ high (and dealer ≤ private ≤ retail) across every evidence regime", async () => {
  const fx = new TableExchangeRates({ "OMR/AED": 9.55, "OMR/USD": 2.6 });
  const scenarios: [Record<string, unknown>, VehicleValueDependencies][] = [
    [REQ, {}], [{ ...REQ, trim: "VXR" }, {}], [{ ...REQ, year: 2021 }, {}], [{ ...REQ, mileageKm: 250_000, condition: "poor" }, {}],
    [{ ...REQ, currency: "USD" }, { fx }], [REQ, { providers: [new StaticVehicleMarketProvider("s", STALE_LAND_CRUISER_LISTINGS)] }],
    [REQ, { providers: [new StaticVehicleMarketProvider("o", OMAN_LAND_CRUISER_LISTINGS.slice(0, 2)), new StaticVehicleMarketProvider("a", UAE_LAND_CRUISER_LISTINGS, { coverage: ["AE"] })], fx }]
  ];
  for (const [input, extra] of scenarios) {
    const r = await run(input, extra);
    assert.equal(r.status, "estimated", JSON.stringify(input).slice(0, 80));
    assertOrdering(r);
  }
});

test("13. confidence: deterministic 0–1 score, level bands, per-factor breakdown and human-readable reasons", async () => {
  const r = await run(REQ);
  assert.ok(r.confidence.score >= 0 && r.confidence.score <= 1);
  const band = (s: number) => (s >= 0.8 ? "high" : s >= 0.6 ? "medium" : s >= 0.4 ? "low" : "very_low");
  assert.equal(r.confidence.level, band(r.confidence.score));
  assert.deepEqual(Object.keys(r.confidence.factors).sort(), ["comparableVolume", "freshness", "locality", "mileageEvidence", "priceConsistency", "providerDiversity", "similarity", "trimMatch"]);
  assert.ok(r.confidence.reasons.length >= 4);
  assert.ok(r.confidence.reasons.every(x => typeof x === "string" && x.length > 10));
  // Low confidence widens the range.
  const weak = await run({ ...REQ, mileageKm: undefined, condition: undefined, trim: undefined }, { providers: [new StaticVehicleMarketProvider("s", STALE_LAND_CRUISER_LISTINGS.slice(0, 6))] });
  assert.ok(weak.methodology.rangeHalfWidthPercent! > r.methodology.rangeHalfWidthPercent!);
});

test("14. confidence decreases as evidence weakens (fewer, older, less specific, less local)", async () => {
  const full = await run(REQ);
  const fewer = await run(REQ, { providers: [new StaticVehicleMarketProvider("o", OMAN_LAND_CRUISER_LISTINGS.filter(l => l.year === 2022 && l.trim === "GXR").slice(0, 4))] });
  const { mileageKm: _k, trim: _t, condition: _c, city: _ci, ...vague } = REQ;
  const lessSpecific = await run(vague);
  const stale = await run(REQ, { providers: [new StaticVehicleMarketProvider("s", STALE_LAND_CRUISER_LISTINGS)] });
  const none = await run(REQ, { providers: [] });
  for (const weaker of [fewer, lessSpecific, stale]) assert.ok(weaker.confidence.score < full.confidence.score, `${weaker.confidence.score} < ${full.confidence.score}`);
  assert.ok(fewer.confidence.score <= 0.59, "fewer than 5 comparables caps confidence below medium");
  assert.ok(none.confidence.score < fewer.confidence.score);
  assert.equal(none.confidence.level, "very_low");
});

// ---- 15–20: market data behaviour --------------------------------------------------------------------

test("15. regional fallback: used only when local evidence is insufficient, flagged, locally adjusted and lower-confidence", async () => {
  const fx = new TableExchangeRates({ "OMR/AED": 9.55 });
  const fewLocal = new StaticVehicleMarketProvider("om", OMAN_LAND_CRUISER_LISTINGS.filter(l => l.year === 2022 && l.trim === "GXR").slice(0, 2), { coverage: ["OM"] });
  const uae = new StaticVehicleMarketProvider("ae", UAE_LAND_CRUISER_LISTINGS, { coverage: ["AE"] });
  const r = await run(REQ, { providers: [fewLocal, uae], fx });
  assertOrdering(r);
  assert.equal(r.status, "estimated");
  assert.equal(r.methodology.fallbackLevel, "regional_same_model_year_plus_minus_2");
  assert.ok(r.riskFlags.includes("REGIONAL_FALLBACK_USED"));
  assert.ok(r.marketComparables.some(c => c.country === "AE" && c.originalCurrency === "AED" && c.currency === "OMR"));
  assert.ok(adj(r, "local_market"), "local-vs-regional gap is measured when ≥2 local comparables exist");
  assert.ok(r.confidence.score < (await run(REQ)).confidence.score);
  // With plenty of local evidence the regional provider's listings are never used.
  const local = await run(REQ, { providers: [omanProvider(), uae], fx });
  assert.ok(!local.riskFlags.includes("REGIONAL_FALLBACK_USED"));
  assert.ok(local.marketComparables.every(c => c.country === "OM"));
  // Markets without a valid regional fallback never widen across borders.
  assert.deepEqual(MARKETS.GB!.regionalCountries, []);
});

test("16. stale data: flagged, lower confidence, wider range; freshness timestamps reported", async () => {
  const fresh = await run(REQ);
  const stale = await run(REQ, { providers: [new StaticVehicleMarketProvider("s", STALE_LAND_CRUISER_LISTINGS)] });
  assert.ok(stale.riskFlags.includes("STALE_MARKET_DATA"));
  assert.ok(!fresh.riskFlags.includes("STALE_MARKET_DATA"));
  assert.ok(stale.confidence.score < fresh.confidence.score);
  assert.ok(stale.methodology.rangeHalfWidthPercent! >= fresh.methodology.rangeHalfWidthPercent!);
  assert.ok(stale.dataFreshness.medianComparableAgeDays! > 90);
  assert.equal(stale.dataFreshness.recentListingCount, 0);
  assert.ok(fresh.dataFreshness.latestComparableAt! >= fresh.dataFreshness.oldestComparableAt!);
  assert.ok(fresh.dataFreshness.recentListingCount > 0);
  // Evidence older than the maximum age, or observed after the valuation date, is never used.
  const ancient = STALE_LAND_CRUISER_LISTINGS.map(l => ({ ...l, observedAt: new Date(Date.parse(l.observedAt!) - 400 * 86_400_000).toISOString() }));
  assert.equal((await run(REQ, { providers: [new StaticVehicleMarketProvider("a", ancient)] })).status, "insufficient_market_data");
  const earlier = await run({ ...REQ, valuationDate: "2026-08-20" });
  assert.ok(earlier.marketComparables.every(c => c.observedAt! <= "2026-08-21"));
});

test("17. currency handling: explicit currency, market default, no guessed FX, conversion only through an injected rate source", async () => {
  const noFx = await run({ ...REQ, currency: "USD", askingPrice: 58_000 });
  assert.equal(noFx.status, "insufficient_market_data");
  assert.ok(noFx.riskFlags.includes("CURRENCY_CONVERSION_UNAVAILABLE"));
  assert.ok(noFx.marketStats.currencyExcludedCount > 0);
  assert.ok(noFx.assumptions.some(a => /never guessed/.test(a)));
  const fx = new TableExchangeRates({ "OMR/USD": 2.6 });
  const usd = await run({ ...REQ, currency: "USD", askingPrice: 58_000 }, { fx });
  const omr = await run(REQ);
  assertOrdering(usd);
  assert.equal(usd.currency, "USD");
  assert.equal(usd.estimatedValue!.currency, "USD");
  assert.ok(Math.abs(usd.estimatedValue!.mid / omr.estimatedValue!.mid - 2.6) < 0.03);
  assert.ok(usd.marketComparables.every(c => c.currency === "USD" && c.originalCurrency === "OMR"));
  assert.equal((await run({ ...REQ, currency: undefined })).currency, "OMR", "Oman's default currency");
  assert.equal((await run({ ...REQ, currency: "ro" })).currency, "OMR", "unambiguous alias normalized");
  // A recognized country without a configured default currency needs an explicit one (never guessed).
  await assert.rejects(run({ ...REQ, country: "Kenya", currency: undefined }), (e: unknown) => publicError(e).error.code === "CURRENCY_REQUIRED" && publicError(e).status === 400);
  const kenya = await run({ ...REQ, country: "KE", currency: "KES" }, { providers: [] });
  assert.equal(kenya.marketCoverage.valuationParametersConfigured, false);
  assert.ok(kenya.assumptions.some(a => /generic conservative market defaults/.test(a)));
});

test("18. duplicate provider records: same sourceName+sourceRecordId and cross-site reposts count once", async () => {
  const single = await run(REQ);
  const mirrored = await run(REQ, { providers: [omanProvider(), new StaticVehicleMarketProvider("om-mirror", [...OMAN_LAND_CRUISER_LISTINGS, ...OMAN_LAND_CRUISER_OUTLIERS])] });
  assert.equal(mirrored.marketStats.comparableCount, single.marketStats.comparableCount);
  assert.deepEqual(mirrored.estimatedValue, single.estimatedValue);
  const reposted = OMAN_LAND_CRUISER_LISTINGS.slice(0, 3).map(l => ({ ...l, sourceName: "synthetic-repost-site", sourceRecordId: `rp-${l.sourceRecordId}`, sourceUrl: undefined }));
  const { kept, removed } = deduplicate([...OMAN_LAND_CRUISER_LISTINGS, ...OMAN_LAND_CRUISER_LISTINGS, ...reposted]);
  assert.equal(kept.length, OMAN_LAND_CRUISER_LISTINGS.length);
  assert.equal(removed, OMAN_LAND_CRUISER_LISTINGS.length + 3);
  // Different listings that merely share a price are both kept.
  const twins = [OMAN_LAND_CRUISER_LISTINGS[0]!, { ...OMAN_LAND_CRUISER_LISTINGS[0]!, sourceRecordId: "other", mileageKm: 99_999 }];
  assert.equal(deduplicate(twins).kept.length, 2);
});

test("19. provider timeout: a slow provider is abandoned at its timeout and the valuation proceeds on the others", async () => {
  const slow = new StaticVehicleMarketProvider("slow-provider", OMAN_LAND_CRUISER_LISTINGS, { delayMs: 2_000 });
  const started = Date.now();
  const r = await run(REQ, { providers: [omanProvider(), slow], timeoutMs: 60 });
  assert.ok(Date.now() - started < 1_500, "one slow provider never blocks the request");
  assert.equal(r.status, "estimated");
  assert.deepEqual(r.marketCoverage.marketDataProviders.find(p => p.id === "slow-provider"), { id: "slow-provider", status: "timeout", comparablesReturned: 0 });
  assert.ok(r.riskFlags.includes("PROVIDER_PARTIAL_FAILURE"));
  const onlySlow = await run(REQ, { providers: [slow], timeoutMs: 60 });
  assert.equal(onlySlow.status, "insufficient_market_data");
});

test("20. partial provider failure: an erroring provider is reported, never fatal, and never leaks its error", async () => {
  const broken = new StaticVehicleMarketProvider("broken-provider", [], { fail: true });
  const r = await run(REQ, { providers: [broken, omanProvider()] });
  assert.equal(r.status, "estimated");
  assert.equal(r.marketCoverage.marketDataProviders.find(p => p.id === "broken-provider")!.status, "error");
  assert.ok(r.riskFlags.includes("PROVIDER_PARTIAL_FAILURE"));
  assert.ok(!JSON.stringify(r).includes("unavailable\""), "no provider error text in the output");
  const clean = await run(REQ);
  assert.deepEqual(r.estimatedValue, clean.estimatedValue, "the failure does not change the valuation of the surviving evidence");
});

// ---- 21: input validation & normalization --------------------------------------------------------------

test("21. schema validation: realistic ranges, strict fields, enum normalization; failures are structured 400s", async () => {
  const bad: [Record<string, unknown>, string][] = [
    [{ model: "Land Cruiser", year: 2022, country: "OM" }, "make"],
    [{ make: "Toyota", year: 2022, country: "OM" }, "model"],
    [{ make: "Toyota", model: "Land Cruiser", country: "OM" }, "year"],
    [{ make: "Toyota", model: "Land Cruiser", year: 2022 }, "country"],
    [{ ...REQ, year: 1900 }, "year"], [{ ...REQ, year: MAX_MODEL_YEAR + 1 }, "year"], [{ ...REQ, year: 2022.5 }, "year"],
    [{ ...REQ, mileageKm: -1 }, "mileageKm"], [{ ...REQ, mileageKm: 3_000_000 }, "mileageKm"],
    [{ ...REQ, owners: 0 }, "owners"], [{ ...REQ, owners: 25 }, "owners"],
    [{ ...REQ, askingPrice: 0 }, "askingPrice"], [{ ...REQ, askingPrice: -5 }, "askingPrice"], [{ ...REQ, askingPrice: 1e12 }, "askingPrice"],
    [{ ...REQ, country: "Narnia" }, "country"], [{ ...REQ, fuelType: "steam" }, "fuelType"], [{ ...REQ, condition: "shiny" }, "condition"],
    [{ ...REQ, currency: "dollars" }, "currency"], [{ ...REQ, valuationDate: "2999-01-01" }, "valuationDate"], [{ ...REQ, valuationDate: "2026-02-30" }, "valuationDate"],
    [{ ...REQ, vin: "JTMHV01J804012345" }, ""], [{ ...REQ, sellerPhone: "+96899999999" }, ""]
  ];
  for (const [input, path] of bad) {
    const result = vehicleValueEstimateInput.safeParse(input);
    assert.equal(result.success, false, JSON.stringify(input).slice(0, 100));
    if (path) assert.ok(result.error!.issues.some(i => i.path.join(".") === path), `${path}: ${JSON.stringify(result.error!.issues)}`);
    await assert.rejects(run(input), (e: unknown) => publicError(e).status === 400 && publicError(e).error.code === "INVALID_INPUT");
  }
  const parsed = vehicleValueEstimateInput.parse({ make: "vw", model: " golf ", year: 2020, country: "UAE", fuelType: "Gasoline", transmission: "Auto", drivetrain: "4x4", bodyType: "Saloon", condition: "Very Good", serviceHistory: "FSH", accidentHistory: "none" });
  assert.deepEqual([parsed.fuelType, parsed.transmission, parsed.drivetrain, parsed.bodyType, parsed.condition, parsed.serviceHistory], ["petrol", "automatic", "4wd", "sedan", "very_good", "full"]);
  assert.deepEqual(normalizeMake("vw"), { display: "Volkswagen", key: "volkswagen" });
  assert.deepEqual(normalizeMake("Mercedes"), { display: "Mercedes-Benz", key: "mercedesbenz" });
  for (const c of ["OM", "om", "Oman", "OMN", "Sultanate of Oman", "عمان"]) assert.equal(normalizeCountry(c)?.code, "OM", c);
  for (const c of ["UAE", "AE", "United Arab Emirates"]) assert.equal(normalizeCountry(c)?.code, "AE", c);
  assert.equal(normalizeCountry("Japan")?.code, "JP", "any country Intl recognizes");
  const r = await run({ ...REQ, make: "TOYOTA", model: "land-cruiser", trim: "gxr", city: "muscat", country: "om" });
  assert.equal(r.vehicle.make, "Toyota");
  assert.equal(r.vehicle.countryCode, "OM");
  assert.equal(r.methodology.fallbackLevel, "same_trim_same_year", "normalized keys still match the fixture listings");
});

// ---- 22–27: integration -------------------------------------------------------------------------------

test("22. MCP registration: exact description, strict schema with the four required fields, same engine result", async () => {
  await withServer(loadConfig({ RAFID_API_KEYS: key, MCP_REMOTE_ENABLED: "true" }), async base => {
    const rpc = async (id: number, method: string, params: unknown) => (await (await fetch(base + "/mcp", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
    })).json()) as any;
    const listed = await rpc(1, "tools/list", {});
    const tool = listed.result.tools.find((t: any) => t.name === "vehicle_value_estimate");
    assert.ok(tool);
    assert.ok(tool.description.includes(MCP_DESCRIPTION));
    assert.ok(tool.description.includes(WHEN_TO_USE));
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual([...tool.inputSchema.required].sort(), ["country", "make", "model", "year"]);
    assert.ok(tool.outputSchema.properties.estimatedValue && tool.outputSchema.properties.confidence);
    const called = await rpc(2, "tools/call", { name: "vehicle_value_estimate", arguments: VEHICLE_EXAMPLE_INPUT });
    assert.ok(!called.result.isError, JSON.stringify(called).slice(0, 300));
    assert.deepEqual(called.result.structuredContent, await cap.execute(VEHICLE_EXAMPLE_INPUT));
    assert.equal(called.result.structuredContent.status, "insufficient_market_data", "default deployment: no provider, honest result");
    const bad = await rpc(3, "tools/call", { name: "vehicle_value_estimate", arguments: { make: "Toyota", model: "X", year: 1800, country: "OM" } });
    assert.ok(bad.result?.isError || bad.error);
    assert.ok(!JSON.stringify(bad).includes("at runVehicleValueEstimate"), "no stack traces");
  });
});

test("23. REST registration: success envelope with tool/price meta, structured 400s with requestId, API key required", async () => {
  await withServer(loadConfig({ RAFID_API_KEYS: key }), async base => {
    const post = (body: unknown, headers: Record<string, string> = { "X-API-Key": key }) => fetch(base + ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
    const ok = await post(VEHICLE_EXAMPLE_INPUT);
    assert.equal(ok.status, 200);
    const body = await ok.json() as any;
    assert.equal(body.meta.tool, "vehicle_value_estimate");
    assert.equal(body.meta.price, 0.25);
    assert.equal(body.meta.currency, "USD");
    assert.ok(vehicleValueEstimateOutput.safeParse(body.data).success);
    const bad = await post({ ...VEHICLE_EXAMPLE_INPUT, mileageKm: -10 });
    assert.equal(bad.status, 400);
    const b = await bad.json() as any;
    assert.equal(b.error.code, "INVALID_INPUT");
    assert.equal(b.error.details[0].path, "mileageKm");
    assert.ok(b.meta.requestId);
    assert.equal((await post({ ...VEHICLE_EXAMPLE_INPUT, country: "Kenya", currency: undefined })).status, 400);
    assert.equal((await post("{\"make\": ")).status, 400);
    assert.equal((await post(VEHICLE_EXAMPLE_INPUT, {})).status, 401);
    assert.equal((await fetch(base + "/v1/automotive/vehicle-value-estimate", { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": key }, body: JSON.stringify(VEHICLE_EXAMPLE_INPUT) })).status, 200, "legacy /v1 alias");
  });
});

test("24. OpenAPI: REST + x402 operations, Automotive tag, strict schema, static synthetic example; never executes the engine", () => {
  const original = cap.execute;
  let called = false;
  (cap as any).execute = () => { called = true; return original(cap.example); };
  try {
    const doc = buildOpenapi(loadConfig({ RAFID_API_KEYS: key, X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet })) as { paths: Record<string, any>; tags: any[] };
    const op = doc.paths[ENDPOINT].post;
    assert.equal(op.operationId, "vehicle_value_estimate");
    assert.deepEqual(op.tags, ["Automotive"]);
    const schema = op.requestBody.content["application/json"].schema;
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual([...schema.required].sort(), ["country", "make", "model", "year"]);
    assert.deepEqual(op.requestBody.content["application/json"].examples.default.value, cap.example);
    assert.deepEqual(op.responses["200"].content["application/json"].examples.default.value.data, VEHICLE_VALUE_EXAMPLE_OUTPUT);
    assert.equal(op.responses["500"].content["application/json"].examples.default.value.error.code, "VALUATION_FAILED");
    assert.equal(doc.paths["/api/v1/x402" + cap.path].post.operationId, "vehicle_value_estimate_x402");
    assert.ok(doc.tags.find((t: any) => t.name === "Automotive").description.includes("vehicle_value_estimate"));
    assert.equal(called, false);
  } finally { (cap as any).execute = original; }
});

test("25. discovery manifests: agent.json, .well-known/agent.json, llms.txt, capabilities, tools, pricing, dashboard group", async () => {
  assert.equal(cap.path, "/automotive/vehicle-value-estimate");
  assert.equal(cap.category, "automotive");
  assert.equal(cap.description, MCP_DESCRIPTION);
  assert.equal(cap.whenToUse, WHEN_TO_USE);
  assert.equal(capabilities.filter(c => c.name === "vehicle_value_estimate").length, 1, "one registry definition, no copies");
  assert.ok(!/\bOman\b/.test(cap.description + cap.whenToUse), "global capability");
  assert.equal(AGENT_GROUPS.filter(g => g.toolNames.includes("vehicle_value_estimate")).length, 1);
  await withServer(loadConfig({ RAFID_API_KEYS: key, X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet }), async base => {
    for (const path of ["/agent.json", "/.well-known/agent.json", "/llms.txt", "/api/v1/capabilities", "/api/v1/pricing", "/api/v1/tools", "/api/v1/agent", "/openapi.json", "/api/v1/x402"]) {
      const text = await (await fetch(base + path)).text();
      assert.ok(text.includes("vehicle_value_estimate") || text.includes("automotive/vehicle-value-estimate"), path);
    }
    assert.match(await (await fetch(base + "/llms.txt")).text(), /vehicle_value_estimate[\s\S]*\$0\.25/);
    const caps = await (await fetch(base + "/api/v1/capabilities")).json() as any;
    const entry = caps.data.find((x: any) => x.name === "vehicle_value_estimate");
    assert.equal(entry.price, 0.25);
    assert.equal(entry.category, "automotive");
    assert.equal(entry.whenToUse, WHEN_TO_USE);
    assert.ok(entry.sampleQueries.length >= 5);
    assert.ok(entry.sampleQueries.some((q: any) => q.query.includes("OMR 22,500")));
    assert.equal(entry.preview.available, true);
    const card = await (await fetch(base + "/.well-known/agent.json")).json() as any;
    assert.ok(card.skills.some((s: any) => s.id === "vehicle_value_estimate" || s.name === "vehicle_value_estimate"));
    const agent = await (await fetch(base + "/agent.json")).json() as any;
    const tool = (agent.tools ?? agent.data?.tools).find((t: any) => t.name === "vehicle_value_estimate");
    assert.equal(tool.x402Endpoint, "/api/v1/x402/automotive/vehicle-value-estimate");
  });
});

test("26. pricing exposure: $0.25 in the catalog, BillingService, x402 requirement, x402, L402 and MPP info; zero upstream cost", async () => {
  assert.equal(cap.price, 0.25);
  assert.equal(prices.vehicle_value_estimate, 0.25);
  const billing = new BillingService(new MemoryUsageRepository());
  assert.equal(billing.getToolPrice("vehicle_value_estimate"), 0.25);
  assert.equal(billing.buildX402PaymentRequirement("vehicle_value_estimate", "eip155:8453", wallet).price, "$0.25");
  const info = buildX402Info(loadConfig({ RAFID_API_KEYS: key, X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet }), billing);
  const tool = info.tools.find(t => t.name === "vehicle_value_estimate")!;
  assert.equal(tool.price, 0.25);
  assert.equal(tool.endpoint, "/api/v1/x402/automotive/vehicle-value-estimate");
  const l402 = buildL402Info({ l402Enabled: true, l402Network: "testnet" } as any, n => prices[n]);
  assert.equal((l402.tools as any[]).find(t => t.name === "vehicle_value_estimate").priceUsd, 0.25);
  const mppConfig = loadConfig({
    RAFID_API_KEYS: key, MPP_ENABLED: "true", MPP_SECRET_KEY: Buffer.alloc(32, 7).toString("base64"), MPP_NETWORK: "tempo-testnet",
    MPP_MODES: "charge", MPP_CHARGE_METHODS: "evm", MPP_EVM_NETWORK: "eip155:84532", MPP_EVM_RECIPIENT: wallet
  }).mpp;
  const mpp = buildMppInfo(mppConfig, n => prices[n]) as any;
  const mppTool = mpp.tools.find((t: any) => t.name === "vehicle_value_estimate");
  assert.equal(mppTool.price, 0.25);
  assert.equal(mppTool.chargeEndpoint, "/api/v1/mpp/charge/vehicle_value_estimate");
  const { ESTIMATED_UPSTREAM_COST_USD } = await import("../src/intelligence/costEstimator.js");
  assert.deepEqual([ESTIMATED_UPSTREAM_COST_USD.vehicle_value_estimate!.providerCostUSD, ESTIMATED_UPSTREAM_COST_USD.vehicle_value_estimate!.llmCostUSD], [0, 0]);
  assert.ok(JSON.stringify(discoveryDeclaration(cap)).length <= MAX_DISCOVERY_DECLARATION_CHARS);
});

test("27. payment-protected execution: x402 402 at 250000 atomic units before execution; L402 token survives a schema-invalid call and buys exactly one successful call", async () => {
  const facilitator = http.createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }], extensions: ["bazaar"], signers: {} })); });
  facilitator.listen(0, "127.0.0.1");
  await once(facilitator, "listening");
  const original = cap.execute;
  let executed = false;
  (cap as any).execute = async (input: unknown) => { executed = true; return original(input); };
  try {
    const config = { ...loadConfig({ RAFID_API_KEYS: key, X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet }), x402FacilitatorUrl: `http://127.0.0.1:${(facilitator.address() as any).port}` };
    await withServer(config, async base => {
      const res = await fetch(base + "/api/v1/x402" + cap.path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cap.example) });
      assert.equal(res.status, 402);
      const required = JSON.parse(Buffer.from(res.headers.get("payment-required")!, "base64").toString());
      assert.equal(required.accepts[0].amount, "250000");
      assert.equal(required.accepts[0].payTo, wallet);
      assert.ok(String(required.resource.url).endsWith("/api/v1/x402/automotive/vehicle-value-estimate"));
      const withKey = await fetch(base + "/api/v1/x402" + cap.path, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": key }, body: JSON.stringify(cap.example) });
      assert.equal(withKey.status, 402, "an API key does not bypass x402");
    });
    assert.equal(executed, false, "no valuation runs before payment");
  } finally { (cap as any).execute = original; facilitator.close(); }

  const { createHash, randomBytes } = await import("node:crypto");
  const { deserializeMacaroon, decodeL402Identifier } = await import("../src/billing/l402/macaroon.js");
  const { MemoryL402RedemptionStore } = await import("../src/billing/l402/redemptions.js");
  const preimages = new Map<string, Buffer>();
  const lightning = { name: "fake", async createInvoice(args: { amountSats: number }) { const p = randomBytes(32); const h = createHash("sha256").update(p).digest(); preimages.set(h.toString("hex"), p); return { paymentRequest: `lnbc${args.amountSats}n1fake`, paymentHash: h }; } };
  const pay = (mac: string) => preimages.get(decodeL402Identifier(deserializeMacaroon(mac)!.identifier)!.paymentHash.toString("hex"))!.toString("hex");
  const env = { RAFID_API_KEYS: key, L402_ENABLED: "true", LND_REST_URL: "https://lnd.example.test:8080", LND_INVOICE_MACAROON: "0201036c6e640258030a10".padEnd(60, "a"), L402_ROOT_KEY: "5c".repeat(32) };
  await withServer(loadConfig(env), async base => {
    const post = (body: unknown, auth?: string) => fetch(base + "/api/v1/l402" + cap.path, { method: "POST", headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) }, body: JSON.stringify(body) });
    const unpaid = await post(VEHICLE_EXAMPLE_INPUT);
    assert.equal(unpaid.status, 402);
    const challenge = /macaroon="([^"]+)"/.exec(unpaid.headers.get("www-authenticate") ?? "")![1]!;
    const auth = `L402 ${challenge}:${pay(challenge)}`;
    const invalid = await post({ ...VEHICLE_EXAMPLE_INPUT, year: 1800 }, auth);
    assert.equal(invalid.status, 400);
    assert.equal(((await invalid.json()) as any).error.code, "INVALID_INPUT");
    const paid = await post(VEHICLE_EXAMPLE_INPUT, auth);
    assert.equal(paid.status, 200, "the token survived the schema-invalid call (not charged)");
    assert.equal(((await paid.json()) as any).meta.tool, "vehicle_value_estimate");
    assert.equal((await post(VEHICLE_EXAMPLE_INPUT, auth)).status, 402, "one token buys one successful call");
  }, { l402Backend: lightning as any, l402Rates: { getRate: async () => ({ btcUsd: 100_000, source: "coinbase", fetchedAt: new Date().toISOString() }) } as any, l402Redemptions: new MemoryL402RedemptionStore() });
});

// ---- 28–30: preview, analytics, determinism --------------------------------------------------------------

test("28. Free Preview: coverage signals only — no provider query, no price, no valuation; limited without a covering provider", async () => {
  let searched = false;
  const spyProvider = Object.assign(omanProvider(), { searchComparables: async () => { searched = true; return []; } });
  const available = await previewVehicleValueEstimate(REQ, { providers: [spyProvider], today: fixtureToday });
  assert.equal(available.status, "available");
  assert.equal(available.preview.entityType, "vehicle");
  assert.equal(available.preview.signals!.marketDataProvidersCovering, 1);
  assert.equal(available.preview.signals!.previewData, "coverage_signals_only");
  assert.equal(searched, false, "a preview never runs a provider search");
  const serialized = JSON.stringify(available);
  for (const leaked of ["\"estimatedValue\":", "\"mid\"", "\"confidence\":", "askingPriceAnalysis\":", "22500"]) assert.ok(!serialized.includes(leaked), leaked);
  const limited = await previewVehicleValueEstimate(REQ, { providers: [], today: fixtureToday });
  assert.equal(limited.status, "limited");
  await withServer(loadConfig({ RAFID_API_KEYS: key }), async base => {
    const res = await fetch(base + "/api/v1/preview/vehicle_value_estimate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(VEHICLE_EXAMPLE_INPUT) });
    assert.equal(res.status, 200);
    const body = await res.json() as any;
    assert.equal(body.data.capability, "vehicle_value_estimate");
    assert.equal(body.data.status, "limited", "default deployment has no provider");
    assert.equal(body.data.fullResult.price.amount, "0.25");
    const bad = await fetch(base + "/api/v1/preview/vehicle_value_estimate", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ make: "Toyota" }) });
    assert.equal(bad.status, 400);
  });
});

test("29. analytics: tool invocations classified by data source; valuation telemetry has market dimensions and no VIN/PII", async () => {
  const estimated = await run(REQ);
  assert.equal(classifyDataSource("vehicle_value_estimate", estimated), "live_provider");
  assert.equal(classifyDataSource("vehicle_value_estimate", await run(REQ, { providers: [] })), "not_configured");
  assert.equal(classifyDataSource("vehicle_value_estimate", VEHICLE_VALUE_EXAMPLE_OUTPUT), "live_provider");
  resetVehicleValuationTelemetry();
  await run(REQ);
  await run(REQ, { providers: [] });
  await run(REQ, { providers: [new StaticVehicleMarketProvider("broken", [], { fail: true }), omanProvider()] });
  const t = getVehicleValuationTelemetry();
  assert.equal(t.calls, 3);
  assert.deepEqual(t.byStatus, { estimated: 2, insufficient_market_data: 1 });
  assert.equal(t.byCountry.OM, 3);
  const e = t.recent[0]!;
  assert.deepEqual([e.country, e.make, e.model, e.modelYear, e.status, e.confidenceLevel, e.fallbackLevel], ["OM", "Toyota", "Land Cruiser", 2022, "estimated", "high", "same_trim_same_year"]);
  assert.ok(e.comparableCount >= 5 && e.providerCount === 1 && typeof e.latencyMs === "number");
  assert.equal(t.recent[2]!.providerFailures, 1);
  assert.ok(t.providers.broken!.errors === 1);
  assert.ok(!/askingPrice|22500|vin|phone|email/i.test(JSON.stringify(t)), "no prices, VINs or personal data in telemetry");
  // End-to-end: the REST call is recorded as a tool invocation in the analytics layer.
  const analyticsRepository = new MemoryAnalyticsRepository();
  await withServer(loadConfig({ RAFID_API_KEYS: key }), async base => {
    await fetch(base + ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": key }, body: JSON.stringify(VEHICLE_EXAMPLE_INPUT) });
  }, { analyticsRepository });
  const events = analyticsRepository.all().filter(ev => ev.category === "tool" && ev.toolName === "vehicle_value_estimate");
  assert.equal(events.length, 1);
  assert.equal(events[0]!.success, true);
  assert.equal(events[0]!.dataSource, "not_configured");
});

test("30. deterministic output: same normalized input + same evidence ⇒ identical output, regardless of provider order or record order", async () => {
  const a = await run(REQ);
  const b = await run(REQ);
  assert.deepEqual(a, b);
  const reversed = new StaticVehicleMarketProvider("om-fixture", [...OMAN_LAND_CRUISER_LISTINGS, ...OMAN_LAND_CRUISER_OUTLIERS, ...SPARSE_PATROL_LISTINGS].reverse(), { coverage: ["OM"] });
  assert.deepEqual(await run(REQ, { providers: [reversed] }), a, "record order does not matter");
  const normalizedVariant = await run({ ...REQ, make: " toyota ", model: "LAND CRUISER", country: "OMN", trim: "gxr" });
  assert.deepEqual(normalizedVariant.estimatedValue, a.estimatedValue, "normalized-equivalent input ⇒ same valuation");
  // The documented example IS the real engine output over the synthetic fixtures.
  assert.deepEqual(cap.example, VEHICLE_EXAMPLE_INPUT);
  assert.ok(vehicleValueEstimateInput.safeParse(cap.example).success);
  assert.ok(vehicleValueEstimateOutput.safeParse(cap.exampleOutput).success);
  const regenerated = await runVehicleValueEstimate(VEHICLE_EXAMPLE_INPUT, { providers: syntheticOmanProviders(), today: fixtureToday, cache: null });
  assert.deepEqual(cap.exampleOutput, { ...regenerated, assumptions: [VEHICLE_SYNTHETIC_EXAMPLE_NOTICE, ...regenerated.assumptions] }, "run scripts/generateVehicleValueExample.ts after changing the engine");
  assert.ok(!JSON.stringify(cap.exampleOutput).match(/https?:\/\/(?![a-z0-9.-]+\.example\/)/), "example cites only reserved .example domains");
});

// ---- supporting infrastructure -------------------------------------------------------------------------

test("caching: provider searches (never valuations) are cached per market + make/model + year window", async () => {
  let calls = 0;
  const base = omanProvider();
  const counting = Object.assign(base, { searchComparables: async (...args: Parameters<typeof base.searchComparables>) => { calls++; return StaticVehicleMarketProvider.prototype.searchComparables.apply(base, args); } });
  const cache = new TtlCache<VehicleComparable[]>(60_000);
  const first = await runVehicleValueEstimate(REQ, { providers: [counting], today: fixtureToday, cache });
  const second = await runVehicleValueEstimate({ ...REQ, askingPrice: 30_000, condition: "fair" }, { providers: [counting], today: fixtureToday, cache });
  assert.equal(calls, 1, "second valuation reused the cached search");
  assert.notDeepEqual(first.estimatedValue, second.estimatedValue, "the valuation itself is recomputed for the new vehicle details");
  await runVehicleValueEstimate({ ...REQ, model: "Prado" }, { providers: [counting], today: fixtureToday, cache });
  await runVehicleValueEstimate({ ...REQ, country: "AE", currency: "AED" }, { providers: [counting], today: fixtureToday, cache });
  assert.equal(calls, 3, "different model and different market never share a cache entry");
});

test("data layer: imported records are validated, PII columns dropped, de-duplicated on source id, and served by the database provider", async () => {
  const rows = OMAN_LAND_CRUISER_LISTINGS.map(l => ({
    make: l.make, model: l.model, year: String(l.year), trim: l.trim, mileageKm: String(l.mileageKm), condition: l.condition, fuelType: "Gasoline",
    transmission: "Auto", bodyType: "SUV", drivetrain: "4x4", country: "Oman", city: l.city, price: String(l.askingPrice), currency: "OMR",
    sourceName: l.sourceName, sourceRecordId: l.sourceRecordId, sourceUrl: l.sourceUrl, observedAt: l.observedAt,
    seller_phone: "+968 9999 0000", seller_email: "seller@example.com", VIN: "JTMHV01J804012345", listing_title: "Land Cruiser for sale"
  }));
  const invalid = { ...rows[0]!, price: "-1", sourceRecordId: "bad-1" };
  const result = validateVehicleMarketRows([...rows, invalid]);
  assert.equal(result.records.length, rows.length);
  assert.equal(result.errors.length, 1);
  assert.deepEqual(result.droppedPersonalDataColumns, ["VIN", "seller_email", "seller_phone"]);
  assert.deepEqual(result.ignoredColumns, ["listing_title"]);
  assert.ok(!JSON.stringify(result.records).match(/9999|seller@|JTMHV/), "no personal data or VIN stored");
  assert.equal(result.records[0]!.fuelType, "petrol");
  assert.equal(result.records[0]!.country, "OM");
  const repo = new MemoryVehicleMarketRepository();
  assert.deepEqual(await repo.upsertRecords(result.records), { inserted: rows.length, updated: 0 });
  assert.deepEqual(await repo.upsertRecords(result.records.slice(0, 3)), { inserted: 0, updated: 3 }, "re-import updates, never duplicates");
  const provider = new DatabaseVehicleMarketProvider(repo, ["OM"]);
  assert.equal(provider.supports({ country: "OM", regionalCountries: [] }), true);
  assert.equal(provider.supports({ country: "US", regionalCountries: ["CA"] }), false, "coverage is explicit");
  const r = await runVehicleValueEstimate(REQ, { providers: [provider], today: fixtureToday, cache: null });
  assert.equal(r.status, "estimated");
  assert.equal(r.marketCoverage.marketDataProviders[0]!.id, "vehicle_market_records");
  // Schema: indexes and provider-level de-duplication exist.
  const sql = VEHICLE_MARKET_SCHEMA_SQL.join("\n");
  for (const fragment of ["normalized_make, normalized_model, year", "normalized_trim", "country, normalized_city", "mileage_km", "observed_at DESC", "UNIQUE INDEX", "(source_name, source_record_id)"]) assert.ok(sql.includes(fragment), fragment);
  assert.ok(!/phone|email|vin|seller/i.test(sql), "no personal-data columns in the table");
});

test("sanitization: provider payload fields outside the comparable model (seller contact, VIN, tracking params) never pass through", () => {
  const dirty = { ...OMAN_LAND_CRUISER_LISTINGS[0]!, sourceUrl: "https://listings-a.example/listing/1?utm_source=x&session=abc", sellerPhone: "+96899990000", vin: "JTMHV01J804012345" } as unknown as VehicleComparable;
  const clean = sanitizeComparable(dirty)!;
  assert.equal(clean.sourceUrl, "https://listings-a.example/listing/1");
  assert.ok(!("sellerPhone" in clean) && !("vin" in clean));
  assert.equal(sanitizeComparable({ ...dirty, askingPrice: -5 }), null);
  assert.equal(sanitizeComparable({ ...dirty, currency: "omr" }), null);
});
