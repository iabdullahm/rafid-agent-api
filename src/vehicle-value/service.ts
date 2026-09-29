import { TtlCache } from "../intelligence/cache.js";
import type { CapabilityPreviewBody } from "../preview/types.js";
import { vehicleValueEstimateInput } from "../schemas/vehicleValueInputs.js";
import type { VehicleValueEstimateOutput } from "../schemas/vehicleValueOutputs.js";
import { ApiError } from "../utils/errors.js";
import { FALLBACK_DESCRIPTIONS, MIN_COMPARABLES, preparePool, selectComparables } from "./comparables.js";
import { STALE_AFTER_DAYS, computeConfidence, type ConfidenceResult } from "./confidence.js";
import {
  getExchangeRateApiKey, getMarketCheckApiKey, getMarketCheckPages, getVehicleFxCacheTtlMs, getVehicleFxSources,
  getVehicleMarketCountries, getVehicleMarketDataMode, getVehicleMarketDatabaseUrl, getVehicleMaxListingAgeDays,
  getVehicleProviderTimeoutMs, getVehicleSearchCacheTtlMs, getVehicleVinDecoder, getVehicleVinDecoderTimeoutMs
} from "./config.js";
import { EcbRateSource, ExchangeRateApiSource, ExchangeRateService, SameCurrencyOnly } from "./currency.js";
import { HttpFeedVehicleProvider, parseFeedConfigs } from "./providers/httpFeed.js";
import { MarketCheckVehicleProvider } from "./providers/marketcheck.js";
import { DatabaseVehicleMarketProvider } from "./providers/providers.js";
import { NhtsaVinDecoder, hashVin, type DecodedVin, type VinDecoder } from "./vin.js";
import { analyzeVin, type VinCheck } from "./vinCheck.js";
import { gatherComparables, selectProviders, type GatherResult } from "./providers/router.js";
import type { ScoredComparable } from "./similarity.js";
import { median, mean, round } from "./stats.js";
import { PostgresVehicleMarketRepository } from "./store/postgres.js";
import { buildSubject, type Subject } from "./subject.js";
import { recordVehicleValuation } from "./telemetry.js";
import {
  FALLBACK_LEVELS, RISK_FLAGS, type ExchangeRateProvider, type FallbackLevel, type MarketPosition, type RiskFlag,
  type VehicleComparable, type VehicleMarketProvider
} from "./types.js";
import { lerp, roundTo, roundingStep, runValuation, type ValuationCore } from "./valuation.js";

export const DISCLAIMER = "Estimate derived from available market evidence using deterministic methods. It is not a physical inspection, a vehicle-history check, a formal appraisal, or a guarantee of sale price, and it is not financial, lending or insurance advice.";

/** Deterministic asking-price thresholds (percent difference from the estimated midpoint). */
export const MARKET_POSITION_THRESHOLDS = Object.freeze({ wellBelow: -15, below: -5, above: 5, wellAbove: 15 });
const RECENT_WINDOW_DAYS = 30;
const HIGH_DISPERSION = 0.20;

export interface VehicleValueDependencies {
  providers?: readonly VehicleMarketProvider[];
  fx?: ExchangeRateProvider;
  today?: () => Date;
  now?: () => number;
  timeoutMs?: number;
  cache?: TtlCache<VehicleComparable[]> | null;
  maxListingAgeDays?: number;
  /** Live exchange-rate service (ignored when `fx` is given). */
  fxService?: ExchangeRateService | null;
  vinDecoder?: VinDecoder | null;
  vinDecoderTimeoutMs?: number;
}

// ---- runtime (env-configured providers) -----------------------------------------------------------

interface Runtime { providers: VehicleMarketProvider[]; cache: TtlCache<VehicleComparable[]>; fxService: ExchangeRateService | null; vinDecoder: VinDecoder | null }
let runtime: Runtime | null = null;

/** Builds the provider / FX / VIN-decoder set from the environment. Everything is off by default. */
export function buildVehicleRuntime(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): Runtime {
  const providers: VehicleMarketProvider[] = [];
  if (getVehicleMarketDataMode(env) === "database") {
    const url = getVehicleMarketDatabaseUrl(env);
    if (!url) throw new Error("VEHICLE_MARKET_DATA_MODE=database requires VEHICLE_MARKET_DATABASE_URL or DATABASE_URL");
    providers.push(new DatabaseVehicleMarketProvider(new PostgresVehicleMarketRepository(url), getVehicleMarketCountries(env)));
  }
  const marketCheckKey = getMarketCheckApiKey(env);
  if (marketCheckKey) providers.push(new MarketCheckVehicleProvider({ apiKey: marketCheckKey, pages: getMarketCheckPages(env), fetchImpl }));
  for (const feed of parseFeedConfigs(env.VEHICLE_MARKET_FEEDS_JSON)) providers.push(new HttpFeedVehicleProvider(feed, { fetchImpl, env }));
  const fxSources = getVehicleFxSources(env).map(id => (id === "ecb" ? new EcbRateSource({ fetchImpl }) : new ExchangeRateApiSource({ apiKey: getExchangeRateApiKey(env), fetchImpl })));
  return {
    providers,
    cache: new TtlCache<VehicleComparable[]>(getVehicleSearchCacheTtlMs(env)),
    fxService: fxSources.length ? new ExchangeRateService(fxSources, { ttlMs: getVehicleFxCacheTtlMs(env) }) : null,
    vinDecoder: getVehicleVinDecoder(env) === "nhtsa" ? new NhtsaVinDecoder({ fetchImpl }) : null
  };
}

function defaultRuntime(): Runtime {
  runtime ??= buildVehicleRuntime();
  return runtime;
}

/** Tests only: forget env-built providers and the search cache. */
export function resetVehicleValueRuntime(): void { runtime = null; }

/** The providers the deployment is configured with (for discovery / preview). */
export function configuredVehicleProviders(): readonly VehicleMarketProvider[] { return defaultRuntime().providers; }

export const valuationFailed = () => new ApiError(500, "VALUATION_FAILED", "The vehicle could not be valued due to an internal error. No payment was taken.", { status: "valuation_failed" });

// ---- engine ---------------------------------------------------------------------------------------

export async function runVehicleValueEstimate(rawInput: unknown, deps: VehicleValueDependencies = {}): Promise<VehicleValueEstimateOutput> {
  const input = vehicleValueEstimateInput.parse(rawInput);
  const now = deps.now ?? Date.now;
  const started = now();
  const subject = buildSubject(input, deps.today ?? (() => new Date()));
  // Injected providers (tests, examples) never pick up env-configured FX or VIN decoding implicitly.
  const rt = deps.providers ? null : defaultRuntime();
  const providers = deps.providers ?? rt!.providers;
  const cache = deps.cache === undefined ? (rt?.cache ?? null) : deps.cache;
  const fxService = deps.fxService !== undefined ? deps.fxService : (rt?.fxService ?? null);
  const vinDecoder = deps.vinDecoder !== undefined ? deps.vinDecoder : (rt?.vinDecoder ?? null);
  const maxAgeDays = deps.maxListingAgeDays ?? getVehicleMaxListingAgeDays();
  const selectedProviders = selectProviders(providers, { country: subject.countryCode, regionalCountries: subject.market.regionalCountries });

  let gathered: GatherResult = { comparables: [], runs: [], duplicatesRemoved: 0, invalidRemoved: 0, newVehiclePrice: null };
  // VIN decoding runs concurrently with the market search (it only fills fields the search does not use).
  const vinDecode: Promise<{ decoded: DecodedVin | null; failed: boolean }> = subject.vin && vinDecoder
    ? (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), deps.vinDecoderTimeoutMs ?? getVehicleVinDecoderTimeoutMs());
      try { return { decoded: await vinDecoder.decode(subject.vin!, controller.signal), failed: false }; }
      catch { return { decoded: null, failed: true }; }
      finally { clearTimeout(timer); }
    })()
    : Promise.resolve({ decoded: null, failed: false });
  try {
    if (selectedProviders.length) {
      gathered = await gatherComparables(selectedProviders, {
        makeKey: subject.makeKey, modelKey: subject.modelKey, make: subject.make, model: subject.model,
        yearMin: subject.year - 2, yearMax: subject.year + 2,
        countries: [subject.countryCode, ...subject.market.regionalCountries],
        observedAfter: new Date(subject.valuationEndMs - maxAgeDays * 86_400_000).toISOString()
      }, { makeKey: subject.makeKey, modelKey: subject.modelKey, year: subject.year, trimKey: subject.trimKey, country: subject.countryCode },
      { timeoutMs: deps.timeoutMs ?? getVehicleProviderTimeoutMs(), cache, now });
    }
    const { decoded, failed } = await vinDecode;
    const vinCheck = subject.vin ? analyzeVin(subject, subject.vin, decoded, vinDecoder?.id ?? null, failed) : null;
    // Never value a vehicle against its own listing.
    let selfExcluded = 0;
    if (subject.vin) {
      const own = hashVin(subject.vin);
      const before = gathered.comparables.length;
      gathered = { ...gathered, comparables: gathered.comparables.filter(c => c.vinHash !== own) };
      selfExcluded = before - gathered.comparables.length;
    }
    let fx = deps.fx;
    if (!fx) {
      const foreign = gathered.comparables.some(c => c.currency !== subject.currency) || (gathered.newVehiclePrice !== null && gathered.newVehiclePrice.currency !== subject.currency);
      fx = foreign && fxService ? await fxService.prepare() : new SameCurrencyOnly();
    }
    const output = buildOutput(subject, gathered, selectedProviders.length, fx, maxAgeDays, {
      vinCheck, vinDecoderFailed: failed, selfExcluded, fxSourcesConfigured: deps.fx ? ["injected"] : (fxService?.configured ?? [])
    });
    recordVehicleValuation({
      at: new Date(now()).toISOString(), country: subject.countryCode, make: subject.make, model: subject.model, modelYear: subject.year,
      status: output.status, comparableCount: output.marketStats.comparableCount, providerCount: selectedProviders.length,
      providerFailures: gathered.runs.filter(r => r.status === "timeout" || r.status === "error").length,
      confidenceLevel: output.confidence.level, fallbackLevel: output.methodology.fallbackLevel,
      regionalFallback: output.riskFlags.includes("REGIONAL_FALLBACK_USED"), latencyMs: Math.max(0, now() - started)
    }, gathered.runs);
    return output;
  } catch (error) {
    recordVehicleValuation({
      at: new Date(now()).toISOString(), country: subject.countryCode, make: subject.make, model: subject.model, modelYear: subject.year,
      status: "failed", comparableCount: 0, providerCount: selectedProviders.length, providerFailures: 0, confidenceLevel: null,
      fallbackLevel: null, regionalFallback: false, latencyMs: Math.max(0, now() - started)
    }, gathered.runs);
    if (error instanceof ApiError) throw error;
    throw valuationFailed();
  }
}

function sortFlags(flags: Set<RiskFlag>): RiskFlag[] {
  return [...flags].sort((a, b) => RISK_FLAGS.indexOf(a) - RISK_FLAGS.indexOf(b));
}

function positionFor(pct: number): MarketPosition {
  const t = MARKET_POSITION_THRESHOLDS;
  if (pct <= t.wellBelow) return "well_below_market";
  if (pct <= t.below) return "below_market";
  if (pct < t.above) return "near_market";
  if (pct < t.wellAbove) return "above_market";
  return "well_above_market";
}

interface OutputExtras { vinCheck: VinCheck | null; vinDecoderFailed: boolean; selfExcluded: number; fxSourcesConfigured: readonly string[] }

const sig = (v: number) => Number(v.toPrecision(6));

function buildOutput(subject: Subject, gathered: GatherResult, providerCount: number, fx: ExchangeRateProvider, maxAgeDays: number, extras: OutputExtras): VehicleValueEstimateOutput {
  const flags = new Set<RiskFlag>();
  const assumptions: string[] = [];
  const pool = preparePool(subject, gathered.comparables, fx, maxAgeDays);
  const { level, selected } = selectComparables(subject, pool.eligible);

  let core: ValuationCore | null = null;
  if (level !== null && selected.length >= MIN_COMPARABLES) {
    core = runValuation(subject, selected, level);
    if (core.used.length < MIN_COMPARABLES) core = null;
  }
  const insufficient = core === null;
  const used: ScoredComparable[] = core?.used ?? selected;

  // ---- flags that do not depend on the estimate ----
  if (providerCount === 0) flags.add("NO_MARKET_DATA_PROVIDER");
  if (gathered.runs.some(r => r.status === "timeout" || r.status === "error")) flags.add("PROVIDER_PARTIAL_FAILURE");
  if (pool.currencyExcluded > 0) flags.add("CURRENCY_CONVERSION_UNAVAILABLE");
  if (subject.mileageKm === null) flags.add("MILEAGE_UNKNOWN");
  if (subject.trimKey === null) flags.add("TRIM_UNKNOWN");
  if (subject.condition === "unknown") flags.add("CONDITION_UNKNOWN");
  if (subject.accidentHistory === "unknown") flags.add("ACCIDENT_HISTORY_UNKNOWN");
  if (subject.accidentHistory === "reported") flags.add("ACCIDENT_SEVERITY_UNVERIFIED");
  if (subject.accidentHistory === "structural") flags.add("STRUCTURAL_DAMAGE_REPORTED");
  const vc = extras.vinCheck;
  if (vc) {
    if (vc.matches.make === false || vc.matches.model === false || vc.matches.year === false) flags.add("VIN_MISMATCH");
    if (vc.checkDigit === "invalid") flags.add("VIN_CHECK_DIGIT_INVALID");
    if (vc.decodeStatus === "unavailable") flags.add("VIN_DECODE_UNAVAILABLE");
  }
  if (extras.selfExcluded > 0) flags.add("SUBJECT_LISTING_EXCLUDED");
  const expectedMileageKm = subject.ageYears >= 0.5 ? Math.round(subject.ageYears * subject.market.expectedAnnualKm) : null;
  const mileageVsExpectedPercent = subject.mileageKm !== null && expectedMileageKm ? round((subject.mileageKm / expectedMileageKm - 1) * 100, 1) : null;
  if (mileageVsExpectedPercent !== null && mileageVsExpectedPercent > 50) flags.add("HIGH_MILEAGE_FOR_AGE");
  if (insufficient) flags.add("INSUFFICIENT_COMPARABLES");
  if (level === "regional_same_model_year_plus_minus_2" && used.some(u => u.comparable.country !== subject.countryCode)) flags.add("REGIONAL_FALLBACK_USED");
  if (level !== null && FALLBACK_LEVELS.indexOf(level) > (subject.trimKey ? 0 : 2)) flags.add("BROADENED_COMPARABLE_SEARCH");

  // ---- evidence statistics ----
  const ages = used.map(u => u.ageDays).filter((d): d is number => d !== null);
  const medianAgeDays = ages.length ? Math.round(median(ages)!) : null;
  if (!insufficient && (medianAgeDays === null || medianAgeDays > STALE_AFTER_DAYS)) flags.add("STALE_MARKET_DATA");
  if (core && core.robustDispersion !== null && core.robustDispersion > HIGH_DISPERSION) flags.add("HIGH_PRICE_DISPERSION");
  if (core && core.outliersExcluded > 0) flags.add("OUTLIERS_REMOVED");
  if (core?.heuristicAdjustmentsUsed) flags.add("HEURISTIC_ADJUSTMENTS_USED");

  const confidence: ConfidenceResult = computeConfidence({
    comparableCount: insufficient ? used.length : core!.used.length,
    meanSimilarity: used.length ? mean(used.map(u => u.similarity))! : 0,
    subjectTrimKnown: subject.trimKey !== null,
    exactTrimShare: used.length ? used.filter(u => u.trimMatch === "exact").length / used.length : 0,
    subjectMileageKnown: subject.mileageKm !== null,
    comparableMileageShare: used.length ? used.filter(u => u.comparable.mileageKm !== undefined).length / used.length : 0,
    meanLocality: used.length ? mean(used.map(u => (u.location === "same_city" ? 1 : u.location === "same_country" ? 0.8 : 0.35)))! : 0,
    medianAgeDays,
    distinctSources: new Set(used.map(u => u.comparable.sourceName.toLowerCase())).size,
    robustDispersion: core?.robustDispersion ?? null,
    conditionUnknown: subject.condition === "unknown",
    mileageEffectHeuristic: core?.fit.kmBasis === "heuristic",
    yearEffectHeuristic: core?.fit.yearBasis === "heuristic",
    regionalFallback: flags.has("REGIONAL_FALLBACK_USED"),
    insufficient
  });
  const weak = confidence.level === "low" || confidence.level === "very_low";

  // ---- prices ----
  let estimatedValue: VehicleValueEstimateOutput["estimatedValue"] = null;
  let privateSale: number | null = null, dealerBuy: number | null = null, dealerRetail: number | null = null;
  let halfWidth: number | null = null, dealerDiscount: number | null = null, privateAdj: number | null = null, retailMarkup: number | null = null;
  let askingPriceAnalysis: VehicleValueEstimateOutput["askingPriceAnalysis"] = null;
  let step = 1;
  if (core) {
    step = roundingStep(core.mid, weak);
    halfWidth = Math.min(0.40, Math.max(0.04, 0.5 * (core.robustDispersion ?? 0.15) + 0.15 * (1 - confidence.score) + 0.02));
    const mid = roundTo(core.mid, step);
    const low = Math.min(mid, roundTo(core.mid * (1 - halfWidth), step));
    const high = Math.max(mid, roundTo(core.mid * (1 + halfWidth), step));
    estimatedValue = { low, mid, high, currency: subject.currency };
    const m = subject.market;
    dealerDiscount = m.dealerBuyDiscountRange[1] - (m.dealerBuyDiscountRange[1] - m.dealerBuyDiscountRange[0]) * confidence.score;
    privateAdj = lerp(m.privateSaleAdjustmentRange, confidence.score);
    retailMarkup = lerp(m.dealerRetailMarkupRange, confidence.score);
    dealerBuy = roundTo(core.mid * (1 - dealerDiscount), step);
    dealerRetail = roundTo(core.mid * (1 + retailMarkup), step);
    privateSale = Math.min(dealerRetail, Math.max(dealerBuy, roundTo(core.mid * (1 + privateAdj), step)));
    if (subject.askingPrice !== null) {
      const diff = round(subject.askingPrice - mid, 2);
      const pct = round((diff / mid) * 100, 2);
      const marketPosition = positionFor(pct);
      if (marketPosition === "well_above_market") flags.add("ASKING_PRICE_SIGNIFICANTLY_ABOVE_MARKET");
      if (marketPosition === "well_below_market") flags.add("ASKING_PRICE_SIGNIFICANTLY_BELOW_MARKET");
      askingPriceAnalysis = {
        askingPrice: subject.askingPrice, differenceFromMid: diff, differencePercent: pct, marketPosition,
        withinEstimatedRange: subject.askingPrice >= low && subject.askingPrice <= high, thresholdsPercent: { ...MARKET_POSITION_THRESHOLDS }
      };
    }
  }

  // ---- depreciation ----
  const ref = gathered.newVehiclePrice;
  const original = ref ? fx.convert(ref.price, ref.currency, subject.currency) : null;
  const originalRounded = original !== null ? roundTo(original, roundingStep(original, false)) : null;
  const midForDep = estimatedValue?.mid ?? null;
  const depreciation: VehicleValueEstimateOutput["depreciation"] = {
    estimatedOriginalPrice: originalRounded,
    originalPriceSource: originalRounded !== null && ref ? `${ref.sourceName} (via ${ref.providerId})` : null,
    totalDepreciationAmount: originalRounded !== null && midForDep !== null ? originalRounded - midForDep : null,
    totalDepreciationPercent: originalRounded !== null && midForDep !== null ? round(((originalRounded - midForDep) / originalRounded) * 100, 2) : null,
    estimatedAnnualDepreciationPercent: originalRounded !== null && midForDep !== null && subject.ageYears >= 1 && midForDep < originalRounded
      ? round((1 - Math.pow(midForDep / originalRounded, 1 / subject.ageYears)) * 100, 2) : null,
    marketImpliedAnnualDepreciationPercent: core && core.fit.yearBasis === "market_derived" ? round((1 - Math.exp(-core.fit.yearCoef)) * 100, 2) : null
  };
  if (ref && original === null) flags.add("CURRENCY_CONVERSION_UNAVAILABLE");

  // ---- assumptions ----
  assumptions.push("Vehicle has clear legal ownership/title status with no outstanding finance, liens or registration restrictions.");
  assumptions.push("Estimate reflects available market evidence, not a physical inspection or a vehicle-history report.");
  switch (subject.accidentHistory) {
    case "none": assumptions.push("No undisclosed accident or structural damage; the stated accident history was not independently verified."); break;
    case "unknown": assumptions.push("Accident history is unknown; the vehicle is valued as having no accident, which overstates its value if it has one."); break;
    case "reported": assumptions.push("An accident was reported but its severity could not be verified; it is valued as a repaired, non-structural accident."); break;
    default: assumptions.push(`Accident severity ("${subject.accidentHistory}") is as stated by the requester and was not independently verified.`);
  }
  if (subject.condition === "unknown") assumptions.push("Condition is unknown; the vehicle is valued at the comparables' typical condition.");
  if (subject.mileageKm === null) assumptions.push("Mileage is unknown; the vehicle is valued at the comparables' typical mileage.");
  if (subject.color || subject.engine) assumptions.push("Colour and engine description are recorded but not priced separately.");
  if (core) for (const n of core.notes) assumptions.push(n);
  if (flags.has("CURRENCY_CONVERSION_UNAVAILABLE")) assumptions.push(`Evidence priced in a currency other than ${subject.currency} was excluded: no reliable exchange-rate source is configured, and rates are never guessed.`);
  if (insufficient) {
    assumptions.push(providerCount === 0
      ? `No market-data provider covering ${subject.countryName} is configured on this deployment, so no comparable evidence could be consulted.`
      : `Fewer than ${MIN_COMPARABLES} usable comparables were found for this vehicle in ${subject.countryName}${subject.market.regionalCountries.length ? " or its regional markets" : ""}.`);
    assumptions.push("No historical price or depreciation model is available for this market, so no estimate is produced without comparable evidence (nothing is fabricated).");
  }
  if (!subject.marketConfigured) assumptions.push(`${subject.countryName} has no dedicated valuation parameters; generic conservative market defaults were used for dealer/private spreads and fallbacks.`);
  if (gathered.newVehiclePrice === null) assumptions.push("No verified original (new) price reference was available, so total depreciation is not reported.");
  if (vc) {
    if (flags.has("VIN_MISMATCH")) assumptions.push("The VIN does not match the stated make/model/year; the vehicle was valued as described in the request. Verify the vehicle's identity before relying on the estimate.");
    if (vc.enrichedFields.length) assumptions.push(`Taken from the VIN decode because they were not supplied: ${vc.enrichedFields.join(", ")}.`);
  }
  if (extras.selfExcluded > 0) assumptions.push(`${extras.selfExcluded} listing(s) of this same vehicle (matched by VIN) were excluded from its comparables.`);

  // ---- comparables output ----
  const byRelevance = [...used].sort((a, b) => b.similarity - a.similarity || a.comparable.sourceName.localeCompare(b.comparable.sourceName) || (a.comparable.sourceRecordId ?? "").localeCompare(b.comparable.sourceRecordId ?? ""));
  const marketComparables = byRelevance.slice(0, 10).map(u => ({
    make: u.comparable.make, model: u.comparable.model, year: u.comparable.year, trim: u.comparable.trim ?? null, mileageKm: u.comparable.mileageKm ?? null,
    askingPrice: round(u.price, 2), currency: subject.currency, originalAskingPrice: u.comparable.askingPrice, originalCurrency: u.comparable.currency,
    country: u.comparable.country, city: u.comparable.city ?? null, sourceName: u.comparable.sourceName, sourceUrl: u.comparable.sourceUrl ?? null,
    observedAt: u.comparable.observedAt ?? null, priceType: u.comparable.priceType ?? "listing", similarityScore: round(u.similarity, 2)
  }));
  const prices = used.map(u => u.price);
  const kms = used.map(u => u.comparable.mileageKm).filter((k): k is number => k !== undefined);
  const observed = used.map(u => u.comparable.observedAt).filter((d): d is string => !!d).sort();
  const recentListingCount = ages.filter(d => d <= RECENT_WINDOW_DAYS).length;
  const adjStep = Math.max(1, step / 10);

  return {
    status: insufficient ? "insufficient_market_data" : "estimated",
    vehicle: {
      make: subject.make, model: subject.model, year: subject.year, trim: subject.trim, mileageKm: subject.mileageKm, condition: subject.condition,
      country: subject.countryName, countryCode: subject.countryCode, city: subject.city, fuelType: subject.fuelType, transmission: subject.transmission,
      bodyType: subject.bodyType, drivetrain: subject.drivetrain, engine: subject.engine, accidentHistory: subject.accidentHistory,
      serviceHistory: subject.serviceHistory, owners: subject.owners, color: subject.color, options: subject.options,
      ageYears: subject.ageYears, expectedMileageKm, mileageVsExpectedPercent
    },
    valuationDate: subject.valuationDate,
    currency: subject.currency,
    estimatedValue,
    estimatedPrivateSalePrice: privateSale,
    estimatedDealerBuyPrice: dealerBuy,
    estimatedDealerRetailPrice: dealerRetail,
    askingPriceAnalysis,
    depreciation,
    adjustments: (core?.adjustments ?? []).map(a => ({ factor: a.factor, impactAmount: roundTo(a.impactAmount, adjStep), impactPercent: round(a.impactPercent, 1), basis: a.basis, reason: a.reason })),
    marketComparables,
    marketStats: {
      comparableCount: insufficient ? used.length : core!.used.length,
      comparablesConsidered: pool.eligible.length,
      outliersExcluded: core?.outliersExcluded ?? 0,
      medianPrice: prices.length ? round(median(prices)!, 2) : null,
      averagePrice: prices.length ? round(mean(prices)!, 2) : null,
      medianMileageKm: kms.length ? Math.round(median(kms)!) : null,
      priceDispersionPercent: core?.robustDispersion != null ? round(core.robustDispersion * 100, 1) : null,
      recentListingCount,
      pricePerKmAdjustment: core && core.fit.kmBasis === "market_derived" ? round(core.mid * (Math.exp(core.fit.kmCoef / 10) - 1), 2) : null,
      currencyExcludedCount: pool.currencyExcluded
    },
    methodology: {
      fallbackLevel: insufficient ? null : level,
      fallbackLevelDescription: insufficient || level === null ? null : FALLBACK_DESCRIPTIONS[level as FallbackLevel],
      outlierMethod: "Tukey IQR fences (1.5×IQR) on log normalized price for n ≥ 5; modified z-score > 3.5 on MAD for n = 4",
      yearEffect: { basis: core?.fit.yearBasis ?? "not_needed", annualPercent: core && core.fit.yearBasis !== "not_needed" ? round((1 - Math.exp(-core.fit.yearCoef)) * 100, 2) : null },
      mileageEffect: { basis: core?.fit.kmBasis ?? "not_applied", percentPer10000Km: core && core.fit.kmBasis !== "not_applied" ? round((Math.exp(core.fit.kmCoef) - 1) * 100, 2) : null },
      rangeHalfWidthPercent: halfWidth === null ? null : round(halfWidth * 100, 1),
      dealerBuyDiscountPercent: dealerDiscount === null ? null : round(dealerDiscount * 100, 1),
      privateSaleAdjustmentPercent: privateAdj === null ? null : round(privateAdj * 100, 1),
      dealerRetailMarkupPercent: retailMarkup === null ? null : round(retailMarkup * 100, 1),
      listingNegotiationDiscountPercent: core ? round(subject.market.listingNegotiationDiscount * 100, 1) : null
    },
    confidence,
    riskFlags: sortFlags(flags),
    assumptions,
    dataFreshness: {
      latestComparableAt: observed.at(-1) ?? null, oldestComparableAt: observed[0] ?? null,
      medianComparableAgeDays: medianAgeDays, recentListingCount, recentWindowDays: RECENT_WINDOW_DAYS
    },
    marketCoverage: {
      countryCode: subject.countryCode, country: subject.countryName, region: subject.market.region,
      valuationParametersConfigured: subject.marketConfigured,
      marketDataProviders: gathered.runs.map(r => ({ id: r.providerId, status: r.status, comparablesReturned: r.comparablesReturned })),
      liveMarketDataAvailable: gathered.runs.some(r => r.status === "ok"),
      regionalFallbackCountries: [...subject.market.regionalCountries]
    },
    vinCheck: vc,
    currencyConversion: {
      resultCurrency: subject.currency,
      sourcesConfigured: [...extras.fxSourcesConfigured],
      conversions: [...new Set([...gathered.comparables.map(c => c.currency), ...(gathered.newVehiclePrice ? [gathered.newVehiclePrice.currency] : [])])]
        .filter(c => c !== subject.currency).sort()
        .flatMap(from => {
          const rate = fx.convert(1, from, subject.currency);
          if (rate === null) return [];
          const d = fx.describe?.(from, subject.currency) ?? null;
          return [{ from, to: subject.currency, rate: sig(rate), source: d?.source ?? "unspecified", rateDate: d?.rateDate ?? null }];
        })
    },
    disclaimer: DISCLAIMER
  };
}

// ---- Free Preview -----------------------------------------------------------------------------------

/**
 * vehicle_value_estimate's Free Preview: validate + normalize the request and report which
 * configured providers COVER the market — without querying any provider, without computing a
 * valuation, and without returning any price. It answers "would a paid call have market evidence
 * to work with here?", never "what is the car worth?".
 */
export async function previewVehicleValueEstimate(rawInput: unknown, deps: Pick<VehicleValueDependencies, "providers" | "today"> = {}): Promise<CapabilityPreviewBody> {
  const input = vehicleValueEstimateInput.parse(rawInput);
  const subject = buildSubject(input, deps.today ?? (() => new Date()));
  const providers = selectProviders(deps.providers ?? configuredVehicleProviders(), { country: subject.countryCode, regionalCountries: subject.market.regionalCountries });
  const recommended = [subject.mileageKm !== null, subject.trimKey !== null, subject.cityKey !== null, subject.condition !== "unknown"];
  const coverageScore = round((providers.length ? 0.6 : 0) + 0.4 * (recommended.filter(Boolean).length / recommended.length), 2);
  return {
    capability: "vehicle_value_estimate",
    status: providers.length ? "available" : "limited",
    inputRecognized: true,
    preview: {
      entity: `${subject.year} ${subject.make} ${subject.model}${subject.trim ? ` ${subject.trim}` : ""}`,
      entityType: "vehicle",
      coverageScore,
      dataCoverage: coverageScore >= 0.8 ? "high" : coverageScore >= 0.5 ? "medium" : "low",
      availableSections: ["estimatedValue", "estimatedPrivateSalePrice", "estimatedDealerBuyPrice", "estimatedDealerRetailPrice", "askingPriceAnalysis", "depreciation", "adjustments", "marketComparables", "marketStats", "confidence", "riskFlags", "dataFreshness"],
      signals: {
        previewData: "coverage_signals_only",
        country: subject.countryCode,
        currency: subject.currency,
        valuationParametersConfigured: subject.marketConfigured,
        marketDataProvidersCovering: providers.length,
        regionalFallbackAvailable: subject.market.regionalCountries.length > 0,
        mileageProvided: subject.mileageKm !== null,
        trimProvided: subject.trimKey !== null,
        cityProvided: subject.cityKey !== null,
        conditionProvided: subject.condition !== "unknown",
        askingPriceProvided: subject.askingPrice !== null
      }
    }
  };
}
