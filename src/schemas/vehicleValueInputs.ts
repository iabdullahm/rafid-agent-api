import { z } from "zod";
import {
  ACCIDENT_HISTORIES, BODY_TYPES, CONDITIONS, DRIVETRAINS, FUEL_TYPES, SERVICE_HISTORIES, TRANSMISSIONS
} from "../vehicle-value/types.js";
import { isVinFormatValid, normalizeVin } from "../vehicle-value/vin.js";
import {
  ACCIDENT_SYNONYMS, BODY_SYNONYMS, CONDITION_SYNONYMS, DRIVETRAIN_SYNONYMS, FUEL_SYNONYMS, SERVICE_SYNONYMS, TRANSMISSION_SYNONYMS,
  matchKey, normalizeCountry, normalizeCurrencyCode
} from "../vehicle-value/normalization.js";

/**
 * vehicle_value_estimate input. Strict (unknown fields rejected). make, model, year and country
 * are required; mileageKm, trim, city and condition are strongly recommended (each one missing
 * lowers confidence and is reported as a risk flag). Categorical fields accept common synonyms
 * ("gasoline" → petrol, "auto" → automatic, "4x4" → 4wd) and are normalized to enums before the
 * engine sees them; anything that is not a recognizable value is rejected (400), never guessed.
 *
 * Validation failures are the shared INVALID_INPUT (400) and are never charged.
 */

/** The latest model year accepted: next calendar year (model years run ahead of the calendar). */
export const MAX_MODEL_YEAR = new Date().getUTCFullYear() + 1;
export const MIN_MODEL_YEAR = 1950;
export const MAX_MILEAGE_KM = 2_000_000;
export const MAX_OWNERS = 20;
export const MAX_ASKING_PRICE = 100_000_000;

const text = (min: number, max: number) => z.string().trim().min(min).max(max);

/** Maps synonyms to the canonical enum value, leaving anything unrecognized untouched so the enum
 *  rejects it with the list of allowed values. */
const synonymEnum = <T extends readonly [string, ...string[]]>(values: T, synonyms: Readonly<Record<string, string>>) =>
  z.preprocess(v => (typeof v === "string" ? synonyms[matchKey(v)] ?? v.trim().toLowerCase() : v), z.enum(values));

export const vehicleValueEstimateInput = z.strictObject({
  make: text(1, 60).refine(v => matchKey(v).length > 0, "make must contain letters or digits").describe("Manufacturer, e.g. Toyota. Required. Common aliases are normalized (VW → Volkswagen, Mercedes → Mercedes-Benz)."),
  model: text(1, 80).refine(v => matchKey(v).length > 0, "model must contain letters or digits").describe("Model, e.g. Land Cruiser. Required."),
  year: z.number().int().min(MIN_MODEL_YEAR).max(MAX_MODEL_YEAR).describe(`Model year (${MIN_MODEL_YEAR}–next calendar year). Required.`),
  country: text(2, 60).refine(v => normalizeCountry(v) !== null, "country must be an ISO 3166 alpha-2 code (e.g. OM), a common alpha-3 code or a recognizable English country name")
    .describe("Market the vehicle is sold in — ISO 3166 alpha-2 (e.g. OM, AE, US, GB) or country name. Required."),
  trim: text(1, 60).optional().describe("Trim / grade, e.g. GXR, VXR, XLE. Strongly recommended — trim-level comparables are preferred over model-level ones."),
  mileageKm: z.number().int().min(0).max(MAX_MILEAGE_KM).optional().describe("Odometer reading in kilometres. Strongly recommended — without it no mileage adjustment is possible and confidence drops."),
  condition: synonymEnum(CONDITIONS, CONDITION_SYNONYMS).optional().describe("Overall condition: excellent, very_good, good, fair, poor or unknown. Strongly recommended."),
  city: text(1, 80).optional().describe("City or region, e.g. Muscat. Strongly recommended — same-city comparables score higher."),
  currency: text(1, 8).refine(v => normalizeCurrencyCode(v) !== null, "currency must be a 3-letter ISO 4217 code such as OMR, AED, USD or EUR")
    .optional().describe("Result currency (ISO 4217). Defaults to the market's local currency; askingPrice is interpreted in this currency."),
  fuelType: synonymEnum(FUEL_TYPES, FUEL_SYNONYMS).optional().describe("petrol, diesel, hybrid, plug_in_hybrid, electric, lpg, cng, hydrogen or other (synonyms such as gasoline accepted)."),
  transmission: synonymEnum(TRANSMISSIONS, TRANSMISSION_SYNONYMS).optional().describe("automatic, manual, cvt, dct or other."),
  bodyType: synonymEnum(BODY_TYPES, BODY_SYNONYMS).optional().describe("sedan, hatchback, suv, crossover, pickup, coupe, convertible, wagon, van, minivan or other."),
  engine: text(1, 60).optional().describe("Engine description, e.g. 4.0L V6 (recorded; not priced separately)."),
  drivetrain: synonymEnum(DRIVETRAINS, DRIVETRAIN_SYNONYMS).optional().describe("fwd, rwd, awd or 4wd."),
  accidentHistory: z.union([z.boolean(), synonymEnum(ACCIDENT_HISTORIES, ACCIDENT_SYNONYMS)]).optional()
    .describe("false / \"none\" = no known accident; \"minor_cosmetic\", \"repaired\", \"structural\"; true / \"reported\" = an accident with unstated severity; \"unknown\"."),
  serviceHistory: synonymEnum(SERVICE_HISTORIES, SERVICE_SYNONYMS).optional().describe("full, partial, none or unknown."),
  owners: z.number().int().min(1).max(MAX_OWNERS).optional().describe(`Number of previous registered owners (1–${MAX_OWNERS}).`),
  color: text(1, 40).optional().describe("Exterior colour (recorded; not priced separately)."),
  options: z.array(text(1, 60)).max(40).optional().describe("Notable equipment, e.g. [\"sunroof\", \"leather seats\", \"360 camera\"] (max 40)."),
  vin: z.preprocess(v => (typeof v === "string" ? normalizeVin(v) : v), z.string().refine(isVinFormatValid, "vin must be a 17-character VIN (letters and digits, excluding I, O and Q)"))
    .optional().describe("Optional 17-character VIN. Validated (and decoded when the deployment enables a VIN decoder) to confirm make/model/year, fill missing trim/body/fuel/drivetrain, and exclude the vehicle's own listing from its comparables. Never stored or logged; returned masked."),
  askingPrice: z.number().positive().max(MAX_ASKING_PRICE).optional().describe("Asking price to assess, in `currency` (or the market currency). Adds askingPriceAnalysis with the exact difference from the estimated midpoint."),
  valuationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "valuationDate must be YYYY-MM-DD")
    .refine(v => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), "valuationDate must be a real calendar date")
    .refine(v => Date.parse(`${v}T00:00:00Z`) <= Date.now(), "valuationDate cannot be in the future")
    .optional().describe("Optional as-of date (YYYY-MM-DD, not in the future). Defaults to today (UTC). Market evidence observed after this date is ignored — useful for insurance or historical valuation.")
});

export type VehicleValueEstimateInput = z.infer<typeof vehicleValueEstimateInput>;
