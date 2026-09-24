import assert from "node:assert/strict";
import { test } from "node:test";
import { runVehicleValueEstimate, buildVehicleRuntime } from "../src/vehicle-value/service.js";
import { MarketCheckVehicleProvider, mapMarketCheckListing } from "../src/vehicle-value/providers/marketcheck.js";
import { HttpFeedVehicleProvider, parseFeedConfigs } from "../src/vehicle-value/providers/httpFeed.js";
import { DatabaseVehicleMarketProvider, StaticVehicleMarketProvider } from "../src/vehicle-value/providers/providers.js";
import { EcbRateSource, ExchangeRateApiSource, ExchangeRateService, parseEcbXml, parseExchangeRateApi, type ExchangeRateSource } from "../src/vehicle-value/currency.js";
import { MemoryVehicleMarketRepository } from "../src/vehicle-value/store/repository.js";
import { validateNewPriceRows, validateVehicleMarketRows } from "../src/vehicle-value/store/records.js";
import { NhtsaVinDecoder, computeCheckDigit, hashVin, isVinFormatValid, maskVin, normalizeVin, wmiMake, wmiRegion, type VinDecoder } from "../src/vehicle-value/vin.js";
import { vehicleValueEstimateOutput } from "../src/schemas/vehicleValueOutputs.js";
import { normalizeForFingerprint } from "../src/preview/fingerprint.js";
import { getVehicleValuationTelemetry, resetVehicleValuationTelemetry } from "../src/vehicle-value/telemetry.js";
import { FIXTURE_AS_OF, LAND_CRUISER_REQUEST, OMAN_LAND_CRUISER_LISTINGS, UAE_LAND_CRUISER_LISTINGS, fixtureToday } from "../src/vehicle-value/examples/fixtures.js";
import type { VehicleComparable } from "../src/vehicle-value/types.js";

/**
 * vehicle_value_estimate — live data sources (MarketCheck, partner HTTPS feeds), exchange rates
 * (ECB, ExchangeRate-API), new-vehicle price references and VIN support. Every upstream is a mocked
 * `fetch` that reproduces the provider's DOCUMENTED response shape; no test touches the network.
 */

const REQ = { ...LAND_CRUISER_REQUEST, valuationDate: FIXTURE_AS_OF };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const ok = (out: unknown) => { const r = vehicleValueEstimateOutput.safeParse(out); assert.ok(r.success, JSON.stringify(r.error?.issues?.slice(0, 3))); };

/** A valid North-American VIN built from a 16-character body with the correct check digit at position 9. */
function naVin(prefix8: string, rest8: string): string {
  const draft = `${prefix8}0${rest8}`;
  return `${prefix8}${computeCheckDigit(draft)}${rest8}`;
}

// ---- MarketCheck --------------------------------------------------------------------------------

/** MarketCheck-shaped listings (documented fields) built from the synthetic Land Cruiser set: USD, miles. */
const mcListings = OMAN_LAND_CRUISER_LISTINGS.map((l, i) => ({
  id: `mc-${i + 1}`, vin: naVin("JTMABABJ", `N${String(400000 + i).padStart(7, "0")}`.slice(0, 8)), price: Math.round(l.askingPrice * 2.6), miles: Math.round(l.mileageKm! / 1.609344),
  vdp_url: `https://dealer-${i}.example/vdp/${i}?utm_source=mc`, last_seen_at_date: l.observedAt, msrp: l.year === 2022 && l.trim === "GXR" ? 76_000 + (i % 3) * 500 : 0,
  inventory_type: "used",
  build: { year: l.year, make: "Toyota", model: "Land Cruiser", trim: l.trim, body_type: "SUV", fuel_type: "Gasoline", transmission: "Automatic", drivetrain: "4WD" },
  dealer: { city: "Houston", state: "TX", country: "US", phone: "+1 555 0100", name: "Example Motors" }
}));

function marketCheckFetch(calls: URL[], listings = mcListings) {
  return (async (input: string | URL) => {
    const url = new URL(String(input));
    calls.push(url);
    const start = Number(url.searchParams.get("start"));
    // MarketCheck scopes results to the requested market; these fixtures are US inventory.
    const market = url.searchParams.get("country") === "us" ? listings : [];
    return json({ num_found: market.length, listings: market.slice(start, start + 50) });
  }) as typeof fetch;
}

test("MarketCheck: documented request contract, field mapping (miles→km, USD, enums), no dealer contact or raw VIN kept", async () => {
  const calls: URL[] = [];
  const provider = new MarketCheckVehicleProvider({ apiKey: "mc-secret-key", fetchImpl: marketCheckFetch(calls) });
  assert.equal(provider.supports({ country: "US", regionalCountries: ["CA"] }), true);
  assert.equal(provider.supports({ country: "OM", regionalCountries: ["AE"] }), false, "no GCC coverage is claimed");
  const rows = await provider.searchComparables({ makeKey: "toyota", modelKey: "landcruiser", make: "Toyota", model: "Land Cruiser", yearMin: 2020, yearMax: 2024, countries: ["US"], observedAfter: "2025-09-24T00:00:00Z" }, new AbortController().signal);
  const u = calls[0]!;
  assert.equal(u.origin + u.pathname, "https://api.marketcheck.com/v2/search/car/active");
  assert.deepEqual(Object.fromEntries(["api_key", "make", "model", "year_range", "car_type", "country", "rows", "start"].map(k => [k, u.searchParams.get(k)])),
    { api_key: "mc-secret-key", make: "toyota", model: "land cruiser", year_range: "2020-2024", car_type: "used", country: "us", rows: "50", start: "0" });
  assert.equal(calls.length, 1, "pagination stops when a page has fewer than 50 listings (US only requested)");
  assert.equal(rows.length, mcListings.length);
  const first = rows.find(r => r.sourceRecordId === "mc-1")!;
  assert.equal(first.currency, "USD");
  assert.equal(first.mileageKm, Math.round(mcListings[0]!.miles * 1.609344));
  assert.deepEqual([first.fuelType, first.transmission, first.drivetrain, first.bodyType], ["petrol", "automatic", "4wd", "suv"]);
  assert.equal(first.city, "Houston");
  assert.match(first.vinHash!, /^[0-9a-f]{64}$/);
  const serialized = JSON.stringify(rows);
  for (const secret of ["555 0100", "Example Motors", mcListings[0]!.vin]) assert.ok(!serialized.includes(secret), secret);
  assert.equal(mapMarketCheckListing({ price: 0, build: { year: 2022, make: "Toyota", model: "Land Cruiser" } }, "US"), null, "unpriced listings dropped");
});

test("MarketCheck pagination: up to MARKETCHECK_PAGES × 50 listings per market, then stops", async () => {
  const many = Array.from({ length: 130 }, (_, i) => ({ ...mcListings[i % mcListings.length]!, id: `mc-page-${i}` }));
  const calls: URL[] = [];
  const provider = new MarketCheckVehicleProvider({ apiKey: "k", pages: 2, fetchImpl: marketCheckFetch(calls, many) });
  const rows = await provider.searchComparables({ makeKey: "toyota", modelKey: "landcruiser", make: "Toyota", model: "Land Cruiser", yearMin: 2020, yearMax: 2024, countries: ["US", "CA"], observedAfter: "2025-09-24T00:00:00Z" }, new AbortController().signal);
  assert.deepEqual(calls.map(c => `${c.searchParams.get("country")}:${c.searchParams.get("start")}`), ["us:0", "us:50", "ca:0"]);
  assert.equal(rows.length, 100);
});

test("MarketCheck end-to-end: US valuation from live-shaped listings, dealer-reported MSRP → depreciation, API key never exposed", async () => {
  const calls: URL[] = [];
  const provider = new MarketCheckVehicleProvider({ apiKey: "mc-secret-key", fetchImpl: marketCheckFetch(calls) });
  const r = await runVehicleValueEstimate({ ...REQ, country: "US", city: "Houston", currency: undefined, askingPrice: 59_000 }, { providers: [provider], today: fixtureToday, cache: null });
  ok(r);
  assert.equal(r.status, "estimated");
  assert.equal(r.currency, "USD");
  assert.equal(r.methodology.fallbackLevel, "same_trim_same_year");
  assert.ok(r.marketComparables.every(c => c.sourceName === "marketcheck" && c.sourceUrl!.startsWith("https://dealer-") && !c.sourceUrl!.includes("utm_")));
  assert.equal(r.marketCoverage.marketDataProviders[0]!.id, "marketcheck");
  assert.ok(r.depreciation.estimatedOriginalPrice! >= 76_000 && r.depreciation.estimatedOriginalPrice! <= 77_000);
  assert.match(r.depreciation.originalPriceSource!, /MarketCheck dealer-reported MSRP \(median of \d+ listings\)/);
  const d = r.depreciation;
  assert.equal(d.totalDepreciationAmount, d.estimatedOriginalPrice! - r.estimatedValue!.mid);
  assert.equal(d.totalDepreciationPercent, Math.round((d.totalDepreciationAmount! / d.estimatedOriginalPrice!) * 100 * 100) / 100);
  const expectedAnnual = Math.round((1 - Math.pow(r.estimatedValue!.mid / d.estimatedOriginalPrice!, 1 / r.vehicle.ageYears)) * 100 * 100) / 100;
  assert.equal(d.estimatedAnnualDepreciationPercent, expectedAnnual);
  assert.ok(!JSON.stringify(r).includes("mc-secret-key"));
  // Upstream failure: reported as a provider error without echoing the URL/key.
  const failing = new MarketCheckVehicleProvider({ apiKey: "mc-secret-key", fetchImpl: (async () => json({ message: "quota" }, 429)) as typeof fetch });
  const down = await runVehicleValueEstimate({ ...REQ, country: "US", currency: undefined }, { providers: [failing], today: fixtureToday, cache: null });
  assert.equal(down.marketCoverage.marketDataProviders[0]!.status, "error");
  assert.equal(down.status, "insufficient_market_data");
  assert.ok(!JSON.stringify(down).includes("mc-secret-key"));
});

// ---- partner HTTPS feeds ------------------------------------------------------------------------------

const feedRows = OMAN_LAND_CRUISER_LISTINGS.map(l => ({
  make: l.make, model: l.model, year: l.year, trim: l.trim, mileageKm: l.mileageKm, country: "OM", city: l.city, price: l.askingPrice, currency: "OMR",
  sourceName: "partner-dealer-group", sourceRecordId: `pd-${l.sourceRecordId}`, observedAt: l.observedAt, sellerPhone: "+968 9000 0000", ownerName: "Private Person"
}));
const publicResolver = { resolve: async () => ["93.184.216.34"] };

test("partner HTTPS feed: SSRF-protected fetch, JSON and CSV formats, PII columns dropped, whole-feed cache, Authorization from an env reference", async () => {
  let fetches = 0;
  let authSeen: string | null = null;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    fetches++;
    authSeen = new Headers(init?.headers).get("authorization");
    return json({ records: feedRows });
  }) as typeof fetch;
  const provider = new HttpFeedVehicleProvider({ id: "om-dealer", url: "https://feeds.partner.example/rafid.json", countries: ["OM"], authHeaderEnv: "OM_DEALER_FEED_AUTH" },
    { fetchImpl, env: { OM_DEALER_FEED_AUTH: "Bearer partner-token" }, fetchOptions: { resolver: publicResolver } });
  assert.equal(provider.id, "feed:om-dealer");
  const r1 = await runVehicleValueEstimate(REQ, { providers: [provider], today: fixtureToday, cache: null });
  const r2 = await runVehicleValueEstimate({ ...REQ, mileageKm: 90_000 }, { providers: [provider], today: fixtureToday, cache: null });
  ok(r1);
  assert.equal(r1.status, "estimated");
  assert.equal(fetches, 1, "the feed is fetched once and cached");
  assert.equal(authSeen, "Bearer partner-token");
  assert.ok(r2.estimatedValue!.mid < r1.estimatedValue!.mid);
  const out = JSON.stringify(r1);
  for (const pii of ["9000 0000", "Private Person", "partner-token"]) assert.ok(!out.includes(pii), pii);
  // CSV feed.
  const header = "make,model,year,trim,mileageKm,country,city,price,currency,sourceName,sourceRecordId,observedAt,seller_email";
  const csv = [header, ...feedRows.map(r => [r.make, r.model, r.year, r.trim, r.mileageKm, r.country, r.city, r.price, r.currency, r.sourceName, r.sourceRecordId, r.observedAt, "a@b.example"].join(","))].join("\n");
  const csvProvider = new HttpFeedVehicleProvider({ id: "om-csv", url: "https://feeds.partner.example/rafid.csv", countries: ["OM"] },
    { fetchImpl: (async () => new Response(csv, { headers: { "content-type": "text/csv" } })) as typeof fetch, fetchOptions: { resolver: publicResolver } });
  assert.equal((await runVehicleValueEstimate(REQ, { providers: [csvProvider], today: fixtureToday, cache: null })).status, "estimated");
  // SSRF: a feed pointing at a private address is refused before any request.
  let privateFetched = false;
  const ssrf = new HttpFeedVehicleProvider({ id: "evil", url: "https://internal.example/feed.json", countries: ["OM"] },
    { fetchImpl: (async () => { privateFetched = true; return json([]); }) as typeof fetch, fetchOptions: { resolver: { resolve: async () => ["10.0.0.5"] } } });
  const refused = await runVehicleValueEstimate(REQ, { providers: [ssrf], today: fixtureToday, cache: null });
  assert.equal(refused.marketCoverage.marketDataProviders[0]!.status, "error");
  assert.equal(privateFetched, false);
});

test("VEHICLE_MARKET_FEEDS_JSON is validated strictly at startup", () => {
  assert.deepEqual(parseFeedConfigs(""), []);
  assert.deepEqual(parseFeedConfigs('[{"id":"om-dealer","url":"https://x.example/f.json","countries":["om","AE"],"authHeaderEnv":"FEED_AUTH"}]'),
    [{ id: "om-dealer", url: "https://x.example/f.json", countries: ["OM", "AE"], format: undefined, authHeaderEnv: "FEED_AUTH" }]);
  for (const bad of ['{"id":"x"}', '[{"id":"UPPER","url":"https://x.example","countries":["OM"]}]', '[{"id":"ok-id","url":"http://x.example","countries":["OM"]}]',
    '[{"id":"ok-id","url":"https://x.example","countries":[]}]', '[{"id":"ok-id","url":"https://x.example","countries":["OM"],"authHeaderEnv":"Bearer abc"}]']) {
    assert.throws(() => parseFeedConfigs(bad), Error, bad);
  }
});

// ---- exchange rates -----------------------------------------------------------------------------------

const ECB_XML = `<?xml version="1.0" encoding="UTF-8"?><gesmes:Envelope><Cube><Cube time='2026-09-22'><Cube currency='USD' rate='1.0850'/><Cube currency='GBP' rate='0.8420'/><Cube currency='CAD' rate='1.4710'/></Cube></Cube></gesmes:Envelope>`;
const ERAPI_OPEN = { result: "success", base_code: "USD", time_last_update_unix: Date.parse("2026-09-22T00:02:31Z") / 1000, rates: { USD: 1, OMR: 0.3845, AED: 3.6725, SAR: 3.75, EUR: 0.92 } };

test("exchange-rate parsing: ECB daily XML and ExchangeRate-API (open access `rates` and keyed `conversion_rates`)", () => {
  assert.deepEqual(parseEcbXml(ECB_XML), { source: "ecb", base: "EUR", rates: { USD: 1.085, GBP: 0.842, CAD: 1.471 }, rateDate: "2026-09-22" });
  assert.equal(parseEcbXml("<html>maintenance</html>"), null);
  const open = parseExchangeRateApi(ERAPI_OPEN)!;
  assert.equal(open.base, "USD");
  assert.equal(open.rates.OMR, 0.3845);
  assert.equal(open.rateDate, "2026-09-22");
  const { rates, ...rest } = ERAPI_OPEN;
  assert.equal(parseExchangeRateApi({ ...rest, conversion_rates: rates })!.rates.AED, 3.6725);
  assert.equal(parseExchangeRateApi({ result: "error", "error-type": "invalid-key" }), null);
});

test("ExchangeRateService: sources tried in order per pair, cross rates, daily cache, failing source skipped, keyed endpoint", async () => {
  let ecbLoads = 0; let erLoads = 0; let erUrl = "";
  const ecb = new EcbRateSource({ fetchImpl: (async () => { ecbLoads++; return new Response(ECB_XML); }) as typeof fetch });
  const er = new ExchangeRateApiSource({ apiKey: "er-key", fetchImpl: (async (url: string) => { erLoads++; erUrl = String(url); return json(ERAPI_OPEN); }) as typeof fetch });
  let t = 0;
  const service = new ExchangeRateService([ecb, er], { now: () => t });
  const rates = await service.prepare();
  assert.equal(erUrl, "https://v6.exchangerate-api.com/v6/er-key/latest/USD");
  // USD→GBP is priced by ECB (first source): 0.842 / 1.085.
  assert.ok(Math.abs(rates.convert(100, "USD", "GBP")! - 100 * 0.842 / 1.085) < 1e-9);
  assert.deepEqual(rates.describe("USD", "GBP"), { source: "ecb", rateDate: "2026-09-22" });
  // AED→OMR only exists in ExchangeRate-API: 0.3845 / 3.6725.
  assert.ok(Math.abs(rates.convert(1000, "AED", "OMR")! - 1000 * 0.3845 / 3.6725) < 1e-9);
  assert.equal(rates.describe("AED", "OMR")!.source, "exchangerate_api");
  assert.equal(rates.convert(1, "OMR", "XYZ"), null, "unknown pairs are never guessed");
  t += 60_000;
  await service.prepare();
  assert.deepEqual([ecbLoads, erLoads], [1, 1], "rates are cached between valuations");
  const broken = new ExchangeRateService([{ id: "ecb", load: async () => { throw new Error("down"); } } as ExchangeRateSource, er]);
  assert.ok((await broken.prepare()).convert(1, "AED", "OMR"), "a failing source is skipped");
  assert.equal(new ExchangeRateApiSource().constructor.name, "ExchangeRateApiSource");
});

test("currency conversion end-to-end: regional AED evidence converted with a dated, reported rate; the key never leaks", async () => {
  const er = new ExchangeRateApiSource({ apiKey: "er-key", fetchImpl: (async () => json(ERAPI_OPEN)) as typeof fetch });
  const fewLocal = new StaticVehicleMarketProvider("om", OMAN_LAND_CRUISER_LISTINGS.filter(l => l.year === 2022 && l.trim === "GXR").slice(0, 2), { coverage: ["OM"] });
  const uae = new StaticVehicleMarketProvider("ae", UAE_LAND_CRUISER_LISTINGS, { coverage: ["AE"] });
  const r = await runVehicleValueEstimate(REQ, { providers: [fewLocal, uae], today: fixtureToday, cache: null, fxService: new ExchangeRateService([er]) });
  ok(r);
  assert.equal(r.status, "estimated");
  assert.ok(r.riskFlags.includes("REGIONAL_FALLBACK_USED") && !r.riskFlags.includes("CURRENCY_CONVERSION_UNAVAILABLE"));
  assert.deepEqual(r.currencyConversion.sourcesConfigured, ["exchangerate_api"]);
  assert.deepEqual(r.currencyConversion.conversions, [{ from: "AED", to: "OMR", rate: Number((0.3845 / 3.6725).toPrecision(6)), source: "exchangerate_api", rateDate: "2026-09-22" }]);
  const aed = r.marketComparables.find(c => c.originalCurrency === "AED")!;
  assert.ok(Math.abs(aed.askingPrice - aed.originalAskingPrice * 0.3845 / 3.6725) < 0.01);
  assert.ok(!JSON.stringify(r).includes("er-key"));
  const none = await runVehicleValueEstimate(REQ, { providers: [fewLocal, uae], today: fixtureToday, cache: null });
  assert.deepEqual(none.currencyConversion, { resultCurrency: "OMR", sourcesConfigured: [], conversions: [] });
  assert.ok(none.riskFlags.includes("CURRENCY_CONVERSION_UNAVAILABLE"));
});

// ---- new-vehicle prices -----------------------------------------------------------------------------------

test("new-vehicle price references: validated import, exact-trim or unambiguous match only, verified list outranks dealer-reported MSRP", async () => {
  const { records, errors } = validateNewPriceRows([
    { make: "Toyota", model: "Land Cruiser", year: "2022", trim: "GXR", country: "Oman", price: "29,500", currency: "OMR", sourceName: "Distributor price list 2022 (synthetic)", effectiveDate: "2021-10-01" },
    { make: "Toyota", model: "Land Cruiser", year: 2022, trim: "VXR", country: "OM", price: 36_900, currency: "OMR", sourceName: "Distributor price list 2022 (synthetic)" },
    { make: "Toyota", model: "Land Cruiser", year: 2022, country: "OM", price: -1, currency: "OMR", sourceName: "bad" }
  ]);
  assert.equal(records.length, 2);
  assert.equal(errors.length, 1);
  const repo = new MemoryVehicleMarketRepository();
  await repo.upsertRecords(validateVehicleMarketRows(OMAN_LAND_CRUISER_LISTINGS.map(l => ({ ...l, price: l.askingPrice, country: l.country }))).records);
  assert.deepEqual(await repo.upsertNewPrices(records), { inserted: 2, updated: 0 });
  assert.equal((await repo.findNewPrice({ makeKey: "toyota", modelKey: "landcruiser", year: 2022, trimKey: "gxr", country: "OM" }))!.price, 29_500);
  assert.equal(await repo.findNewPrice({ makeKey: "toyota", modelKey: "landcruiser", year: 2022, trimKey: null, country: "OM" }), null, "two trims, no trim given ⇒ ambiguous ⇒ none");
  assert.equal(await repo.findNewPrice({ makeKey: "toyota", modelKey: "landcruiser", year: 2022, trimKey: "exr", country: "OM" }), null);
  const db = new DatabaseVehicleMarketProvider(repo, ["OM"]);
  const dealerReported = Object.assign(new StaticVehicleMarketProvider("dealer-msrp", [], { newPrices: { "toyota|landcruiser|2022|gxr|OM": { price: 99_999, currency: "OMR", sourceName: "dealer-reported" } } }), { newPriceRank: 50 });
  const r = await runVehicleValueEstimate(REQ, { providers: [dealerReported, db], today: fixtureToday, cache: null });
  ok(r);
  assert.equal(r.depreciation.estimatedOriginalPrice, 29_500);
  assert.equal(r.depreciation.originalPriceSource, "Distributor price list 2022 (synthetic) (effective 2021-10-01) (via vehicle_market_records)");
  assert.equal(r.depreciation.totalDepreciationAmount, 29_500 - r.estimatedValue!.mid);
  assert.ok(r.depreciation.estimatedAnnualDepreciationPercent! > 0);
  assert.ok(!r.assumptions.some(a => /No verified original/.test(a)));
});

// ---- VIN ----------------------------------------------------------------------------------------------

test("VIN primitives: normalization, ISO 3779 format, North-American check digit, WMI region/make, masking, hashing", () => {
  assert.equal(normalizeVin(" 1m8gdm9a-xkp042788 "), "1M8GDM9AXKP042788");
  assert.equal(computeCheckDigit("1M8GDM9AXKP042788"), "X", "textbook check-digit example");
  assert.ok(isVinFormatValid("1M8GDM9AXKP042788"));
  assert.ok(!isVinFormatValid("1M8GDM9AXKP04278O"), "O is not allowed");
  assert.ok(!isVinFormatValid("1M8GDM9AXKP0427"), "17 characters required");
  assert.equal(wmiRegion("JTMHV01J804012345"), "asia");
  assert.equal(wmiRegion("1FTFW1E50NFA00001"), "north_america");
  assert.equal(wmiRegion("WBA00000000000000"), "europe");
  assert.equal(wmiMake("JTMHV01J804012345"), "Toyota");
  assert.equal(wmiMake("JTHBA1BL0NA000001"), "Lexus", "longest, most specific prefix wins");
  assert.equal(wmiMake("ZZZ00000000000000"), null, "unknown WMI is never guessed");
  assert.equal(maskVin("JTMHV01J804012345"), "JTMHV01J804******");
  assert.equal(hashVin("jtmhv01j804012345"), hashVin("JTMHV01J804012345"));
});

const JAPAN_LC_VIN = "JTMHV01J804012345";

test("VIN offline: accepted, masked, make checked against the WMI; a mismatching VIN is flagged, never trusted over the request", async () => {
  const provider = new StaticVehicleMarketProvider("om", OMAN_LAND_CRUISER_LISTINGS);
  const r = await runVehicleValueEstimate({ ...REQ, vin: JAPAN_LC_VIN }, { providers: [provider], today: fixtureToday, cache: null });
  ok(r);
  assert.equal(r.vinCheck!.vinMasked, "JTMHV01J804******");
  assert.equal(r.vinCheck!.decodeStatus, "not_configured");
  assert.equal(r.vinCheck!.checkDigit, "not_applicable");
  assert.deepEqual(r.vinCheck!.matches, { make: true, model: null, year: null });
  assert.ok(!r.riskFlags.some(f => f.startsWith("VIN_")));
  assert.ok(!JSON.stringify(r).includes(JAPAN_LC_VIN), "the full VIN is never returned");
  const ford = naVin("1FTFW1E5", "NFA00001");
  const mismatch = await runVehicleValueEstimate({ ...REQ, vin: ford }, { providers: [provider], today: fixtureToday, cache: null });
  assert.equal(mismatch.vinCheck!.matches.make, false);
  assert.equal(mismatch.vinCheck!.checkDigit, "valid");
  assert.equal(mismatch.vinCheck!.matches.year, true, "position-10 'N' in the 2010+ cycle = 2022");
  assert.ok(mismatch.riskFlags.includes("VIN_MISMATCH"));
  assert.equal(mismatch.vehicle.make, "Toyota", "the request, not the VIN, is valued");
  assert.ok(mismatch.assumptions.some(a => /VIN does not match/.test(a)));
  const badCheck = `${ford.slice(0, 8)}${ford[8] === "0" ? "1" : "0"}${ford.slice(9)}`;
  const bad = await runVehicleValueEstimate({ ...REQ, vin: badCheck }, { providers: [provider], today: fixtureToday, cache: null });
  assert.ok(bad.riskFlags.includes("VIN_CHECK_DIGIT_INVALID"));
  assert.equal((await runVehicleValueEstimate(REQ, { providers: [provider], today: fixtureToday, cache: null })).vinCheck, null);
});

test("VIN decoding (NHTSA vPIC contract): fills only missing fields when identity agrees; decoder failure is reported, not fatal", async () => {
  let requested = "";
  const vpic = new NhtsaVinDecoder({ fetchImpl: (async (url: string) => {
    requested = String(url);
    return json({ Count: 1, Message: "Results returned successfully", Results: [{ Make: "TOYOTA", Model: "Land Cruiser", ModelYear: "2022", Trim: "GXR", BodyClass: "Sport Utility Vehicle (SUV)/Multi-Purpose Vehicle (MPV)", FuelTypePrimary: "Gasoline", DriveType: "4WD/4-Wheel Drive/4x4", TransmissionStyle: "Automatic", DisplacementL: "3.5", EngineCylinders: "6", ErrorCode: "0" }] });
  }) as typeof fetch });
  const provider = new StaticVehicleMarketProvider("om", OMAN_LAND_CRUISER_LISTINGS);
  const { trim, bodyType, fuelType, drivetrain, transmission, engine, ...sparse } = REQ;
  void trim; void bodyType; void fuelType; void drivetrain; void transmission; void engine;
  const r = await runVehicleValueEstimate({ ...sparse, vin: JAPAN_LC_VIN }, { providers: [provider], today: fixtureToday, cache: null, vinDecoder: vpic });
  ok(r);
  assert.equal(requested, `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${JAPAN_LC_VIN}?format=json`);
  assert.equal(r.vinCheck!.decodeStatus, "decoded");
  assert.equal(r.vinCheck!.decoder, "nhtsa_vpic");
  assert.deepEqual(r.vinCheck!.matches, { make: true, model: true, year: true });
  assert.deepEqual(r.vinCheck!.enrichedFields, ["trim", "bodyType", "fuelType", "drivetrain", "transmission", "engine"]);
  assert.equal(r.vehicle.trim, "GXR");
  assert.equal(r.vehicle.engine, "3.5L 6 cyl");
  assert.equal(r.methodology.fallbackLevel, "same_trim_same_year", "the decoded trim enables trim-level comparables");
  assert.ok(!r.riskFlags.includes("TRIM_UNKNOWN"));
  // A supplied field is never overwritten by the decoder.
  const kept = await runVehicleValueEstimate({ ...REQ, trim: "VXR", vin: JAPAN_LC_VIN }, { providers: [provider], today: fixtureToday, cache: null, vinDecoder: vpic });
  assert.equal(kept.vehicle.trim, "VXR");
  assert.ok(!kept.vinCheck!.enrichedFields.includes("trim"));
  // Decoder down / slow ⇒ VIN_DECODE_UNAVAILABLE; the valuation still completes.
  const slow: VinDecoder = { id: "nhtsa_vpic", decode: (_vin, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))) };
  const down = await runVehicleValueEstimate({ ...REQ, vin: JAPAN_LC_VIN }, { providers: [provider], today: fixtureToday, cache: null, vinDecoder: slow, vinDecoderTimeoutMs: 30 });
  assert.equal(down.status, "estimated");
  assert.equal(down.vinCheck!.decodeStatus, "unavailable");
  assert.ok(down.riskFlags.includes("VIN_DECODE_UNAVAILABLE"));
});

test("VIN self-exclusion and privacy: the vehicle's own listing is not its comparable; the VIN reaches no telemetry or preview fingerprint", async () => {
  const own: VehicleComparable = { ...OMAN_LAND_CRUISER_LISTINGS[0]!, sourceRecordId: "own-listing", askingPrice: 31_000, vinHash: hashVin(JAPAN_LC_VIN) };
  const provider = new StaticVehicleMarketProvider("om", [...OMAN_LAND_CRUISER_LISTINGS, own]);
  resetVehicleValuationTelemetry();
  const r = await runVehicleValueEstimate({ ...REQ, vin: JAPAN_LC_VIN }, { providers: [provider], today: fixtureToday, cache: null });
  assert.ok(r.riskFlags.includes("SUBJECT_LISTING_EXCLUDED"));
  assert.ok(!r.marketComparables.some(c => c.originalAskingPrice === 31_000));
  assert.ok(r.assumptions.some(a => /same vehicle \(matched by VIN\)/.test(a)));
  assert.ok(!JSON.stringify(getVehicleValuationTelemetry()).includes("JTMHV01J8"), "no VIN in telemetry");
  assert.equal("vin" in normalizeForFingerprint("vehicle_value_estimate", { ...REQ, vin: JAPAN_LC_VIN }), false, "no VIN in preview fingerprints");
  // Imported feed/table rows with a VIN column keep only its hash.
  const imported = validateVehicleMarketRows([{ ...OMAN_LAND_CRUISER_LISTINGS[0]!, price: 20_000, vin: JAPAN_LC_VIN }]);
  assert.equal(imported.records[0]!.vinHash, hashVin(JAPAN_LC_VIN));
  assert.ok(!JSON.stringify(imported.records).includes(JAPAN_LC_VIN));
  assert.ok(imported.droppedPersonalDataColumns.includes("vin"));
});

// ---- runtime configuration ----------------------------------------------------------------------------------

test("runtime: every live source is off by default and switched on only by explicit configuration", () => {
  const none = buildVehicleRuntime({});
  assert.deepEqual([none.providers.length, none.fxService, none.vinDecoder], [0, null, null]);
  const all = buildVehicleRuntime({
    MARKETCHECK_API_KEY: "k", VEHICLE_MARKET_FEEDS_JSON: '[{"id":"om-dealer","url":"https://x.example/f.json","countries":["OM"]}]',
    VEHICLE_FX_SOURCES: "ecb, exchangerate_api", VEHICLE_VIN_DECODER: "nhtsa"
  });
  assert.deepEqual(all.providers.map(p => p.id), ["marketcheck", "feed:om-dealer"]);
  assert.deepEqual(all.fxService!.configured, ["ecb", "exchangerate_api"]);
  assert.equal(all.vinDecoder!.id, "nhtsa_vpic");
  assert.throws(() => buildVehicleRuntime({ VEHICLE_FX_SOURCES: "guess" }), /VEHICLE_FX_SOURCES/);
  assert.throws(() => buildVehicleRuntime({ VEHICLE_VIN_DECODER: "carfax" }), /VEHICLE_VIN_DECODER/);
  assert.throws(() => buildVehicleRuntime({ VEHICLE_MARKET_DATA_MODE: "database" }), /requires VEHICLE_MARKET_DATABASE_URL/);
});
