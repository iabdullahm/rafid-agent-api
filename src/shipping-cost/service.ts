import { shippingCostEstimateInput, type ShippingEstimateInput } from "../schemas/shippingCostInputs.js";
import { shippingCostEstimateOutput, type ShippingEstimateOutput } from "../schemas/shippingCostOutputs.js";
import { shippingRateProviders, type ShippingRateQuote } from "./providers.js";

const DIVISOR = Number(process.env.SHIPPING_VOLUMETRIC_DIVISOR ?? 5000);
const round = (n: number) => Math.round(n * 100) / 100;
const isDomestic = (i: ShippingEstimateInput) => i.origin.country === i.destination.country;
const region = (country: string) => ["US", "CA", "MX"].includes(country) ? "north_america" : ["CN", "JP", "KR", "SG", "IN"].includes(country) ? "asia" : ["GB", "DE", "FR", "IT", "ES", "NL"].includes(country) ? "europe" : ["AE", "OM", "SA", "QA", "KW", "BH", "JO", "IL"].includes(country) ? "middle_east" : "other";

function heuristic(input: ShippingEstimateInput, mode: string, level: string, weight: number): ShippingRateQuote {
  const domestic = isDomestic(input); const crossRegion = region(input.origin.country) !== region(input.destination.country);
  const modeBase: Record<string, number> = { courier: 18, air: 14, sea: 28, road: 12, postal: 10 };
  const modeKg: Record<string, number> = { courier: 5.8, air: 4.2, sea: 1.7, road: 2.6, postal: 3.2 };
  const levelFactor: Record<string, number> = { economy: 0.82, standard: 1, express: 1.55 };
  const distanceFactor = domestic ? 0.72 : crossRegion ? 1.28 : 1.05;
  const factor = (levelFactor[level] ?? 1) * distanceFactor;
  return { provider: "heuristic", source: "heuristic_estimate", currency: input.currency, baseRate: modeBase[mode] * factor, ratePerKg: modeKg[mode] * factor, minimumCharge: modeBase[mode] * factor, fuelSurchargePercent: mode === "sea" ? 8 : 12, handlingFee: domestic ? 3 : 6, remoteAreaSurcharge: 0, oversizeSurcharge: 0, estimatedOtherFees: domestic ? 1 : 4, transitDaysMin: level === "express" ? 2 : level === "economy" ? 7 : 4, transitDaysMax: level === "express" ? 5 : level === "economy" ? 18 : 10 };
}

function convert(amount: number, from: string, to: string): { amount: number; source: string | null } {
  if (from === to) return { amount, source: "same_currency" };
  try {
    const rates = JSON.parse(process.env.SHIPPING_FX_RATES_JSON ?? "{}");
    const direct = Number(rates[`${from}_${to}`]);
    if (Number.isFinite(direct) && direct > 0) return { amount: amount * direct, source: "configured_fx" };
  } catch { /* fall through honestly */ }
  return { amount, source: null };
}

function quoteToResult(q: ShippingRateQuote, input: ShippingEstimateInput, actual: number, volumetric: number, mode: string, level: string, assumptions: string[], riskFlags: { code: string; severity: "low" | "medium" | "high"; message: string }[]): ShippingEstimateOutput {
  const raw = Math.max(q.minimumCharge, q.baseRate + q.ratePerKg * Math.max(actual, volumetric));
  const fuel = raw * q.fuelSurchargePercent / 100;
  const total = raw + fuel + q.handlingFee + q.remoteAreaSurcharge + q.oversizeSurcharge + q.estimatedOtherFees;
  const converted = convert(total, q.currency, input.currency);
  const currencyUnavailable = converted.source === null;
  const min = round(currencyUnavailable ? total * 0.9 : converted.amount * 0.9);
  const max = round(currencyUnavailable ? total * 1.25 : converted.amount * 1.25);
  const source = q.source;
  const levelConfidence: "high" | "medium" | "low" = source === "live_carrier" && input.origin.postalCode && input.destination.postalCode && volumetric > 0 ? "high" : source === "internal_estimate" ? "medium" : "low";
  if (currencyUnavailable) { assumptions.push(`FX conversion from ${q.currency} to ${input.currency} was unavailable; amounts are returned in ${q.currency}.`); riskFlags.push({ code: "FX_UNAVAILABLE", severity: "medium", message: "Configured FX data was unavailable, so the provider quote currency is retained." }); }
  // Day precision keeps the public timestamp useful while preserving the capability's
  // deterministic/idempotent contract for repeated calls on the same UTC day.
  const generatedAt = `${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`;
  return { estimatedCost: { min, max, currency: currencyUnavailable ? q.currency : input.currency }, recommendedEstimate: round((min + max) / 2), actualWeightKg: actual, volumetricWeightKg: round(volumetric), chargeableWeightKg: round(Math.max(actual, volumetric)), shippingMode: mode as never, serviceLevel: level as never, estimatedTransitDays: { min: q.transitDaysMin, max: q.transitDaysMax }, costBreakdown: { baseFreight: round(q.baseRate + q.ratePerKg * Math.max(actual, volumetric)), fuelSurcharge: round(fuel), handling: round(q.handlingFee), remoteAreaSurcharge: round(q.remoteAreaSurcharge), oversizeSurcharge: round(q.oversizeSurcharge), estimatedOtherFees: round(q.estimatedOtherFees) }, rateSource: source, provider: q.provider === "heuristic" ? null : q.provider, dutiesAndTaxes: { included: false, estimatedAmount: null, note: "Import duties and taxes are not included in the shipping estimate." }, confidence: { level: levelConfidence, reason: source === "live_carrier" ? "A configured carrier provider returned a quote." : source === "internal_estimate" ? "A matching internal route/rate record was used." : "No live or internal route quote was available; this is an explicitly labeled heuristic estimate." }, assumptions, riskFlags, options: [], recommendedOptionReason: null, generatedAt };
}

export async function estimateShippingCost(raw: unknown): Promise<ShippingEstimateOutput> {
  const parsed = shippingCostEstimateInput.parse(raw);
  const input: ShippingEstimateInput = { ...parsed, origin: { ...parsed.origin, country: parsed.origin.country.toUpperCase() }, destination: { ...parsed.destination, country: parsed.destination.country.toUpperCase() }, currency: parsed.currency.toUpperCase() };
  const { shipment } = input;
  const hasDimensions = [shipment.lengthCm, shipment.widthCm, shipment.heightCm].every(v => v !== undefined);
  const volumetric = hasDimensions ? (shipment.lengthCm! * shipment.widthCm! * shipment.heightCm! * shipment.quantity) / DIVISOR : 0;
  const assumptions: string[] = []; const riskFlags: { code: string; severity: "low" | "medium" | "high"; message: string }[] = [];
  if (!hasDimensions) { assumptions.push("Dimensions were not supplied; chargeable weight uses actual weight only."); riskFlags.push({ code: "DIMENSIONS_MISSING", severity: "medium", message: "Volumetric weight could not be calculated because shipment dimensions were not supplied." }); }
  if (!input.origin.postalCode || !input.destination.postalCode) riskFlags.push({ code: "POSTAL_CODE_MISSING", severity: "low", message: "Postal code coverage is incomplete; remote-area and route precision may be limited." });
  if (shipment.weightKg > 30) riskFlags.push({ code: "HEAVY_SHIPMENT", severity: "medium", message: "The shipment is heavy; carrier handling rules may change the final price." });
  if (hasDimensions && Math.max(shipment.lengthCm!, shipment.widthCm!, shipment.heightCm!) > 120) riskFlags.push({ code: "OVERSIZE_SHIPMENT", severity: "medium", message: "A supplied dimension exceeds 120 cm; oversize handling may apply." });
  if (!isDomestic(input)) {
    riskFlags.push({ code: "CUSTOMS_NOT_INCLUDED", severity: "medium", message: "Import duties and taxes are not included in the shipping estimate." });
    if (shipment.declaredValue === undefined) riskFlags.push({ code: "DECLARED_VALUE_MISSING", severity: "low", message: "Declared value was not supplied; customs-related carrier fees cannot be assessed." });
  }
  const mode = input.shippingMode === "auto" ? (isDomestic(input) ? "road" : "air") : input.shippingMode;
  const level = input.serviceLevel === "auto" ? "standard" : input.serviceLevel;
  const providers = shippingRateProviders.filter(p => p.supports(input));
  let quote: ShippingRateQuote | undefined;
  for (const provider of providers) { try { quote = (await provider.estimate(input)).find(q => q.currency && q.baseRate >= 0); if (quote) break; } catch { /* provider failures are isolated */ } }
  if (!quote) { quote = heuristic(input, mode, level, Math.max(shipment.weightKg, volumetric)); assumptions.push("No live carrier or matching internal route quote was available; a conservative route heuristic was used."); riskFlags.push({ code: "HEURISTIC_ESTIMATE", severity: "medium", message: "This is a heuristic estimate, not an official carrier quote." }, { code: "ROUTE_DATA_LIMITED", severity: "low", message: "No exact route rate data was configured for this origin and destination." }, { code: "LIVE_RATE_UNAVAILABLE", severity: "low", message: "No configured live carrier provider returned a quote." }); }
  const result = quoteToResult(quote, input, shipment.weightKg, volumetric, mode, level, assumptions, riskFlags);
  return shippingCostEstimateOutput.parse(result);
}

export async function previewShippingCost(raw: unknown) {
  const parsed = shippingCostEstimateInput.parse(raw);
  const input: ShippingEstimateInput = { ...parsed, origin: { ...parsed.origin, country: parsed.origin.country.toUpperCase() }, destination: { ...parsed.destination, country: parsed.destination.country.toUpperCase() }, currency: parsed.currency.toUpperCase() };
  const hasDimensions = [input.shipment.lengthCm, input.shipment.widthCm, input.shipment.heightCm].every(v => v !== undefined);
  const volumetric = hasDimensions ? (input.shipment.lengthCm! * input.shipment.widthCm! * input.shipment.heightCm! * input.shipment.quantity) / DIVISOR : 0;
  return { capability: "shipping_cost_estimate", status: "available" as const, inputRecognized: true, preview: { availableSections: ["estimatedCost", "chargeableWeightKg", "estimatedTransitDays", "costBreakdown", "confidence", "riskFlags"], dataCoverage: shippingRateProviders.some(p => p.supports(input)) ? "medium" as const : "low" as const, signals: { chargeableWeightKg: Math.max(input.shipment.weightKg, volumetric), dimensionsSupplied: hasDimensions, domestic: isDomestic(input) } } };
}
