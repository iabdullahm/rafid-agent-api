import type { VehicleValueEstimateInput } from "../schemas/vehicleValueInputs.js";
import { ApiError } from "../utils/errors.js";
import { marketFor, type MarketParameters } from "./markets.js";
import {
  collapseSpaces, normalizeCity, normalizeCountry, normalizeCurrencyCode, normalizeMake, normalizeModel, normalizeOptions, normalizeTrim, trimTokens
} from "./normalization.js";
import type { AccidentHistory, BodyType, Condition, Drivetrain, FuelType, ServiceHistory, Transmission } from "./types.js";

/** The fully normalized subject vehicle — the only representation of the request the engine uses. */
export interface Subject {
  make: string; makeKey: string;
  model: string; modelKey: string;
  year: number;
  trim: string | null; trimKey: string | null; trimTokens: string[];
  mileageKm: number | null;
  condition: Condition;
  countryCode: string; countryName: string;
  city: string | null; cityKey: string | null;
  currency: string;
  fuelType: FuelType | null; transmission: Transmission | null; bodyType: BodyType | null; drivetrain: Drivetrain | null;
  engine: string | null;
  accidentHistory: AccidentHistory;
  accidentFromBoolean: boolean;
  serviceHistory: ServiceHistory;
  owners: number | null;
  color: string | null;
  options: string[]; premiumOptions: string[];
  askingPrice: number | null;
  /** Normalized VIN (request-scoped only; never persisted or logged). */
  vin: string | null;
  valuationDate: string;
  /** End of the valuation day (UTC, ms) — evidence observed after it is ignored. */
  valuationEndMs: number;
  ageYears: number;
  market: MarketParameters;
  marketConfigured: boolean;
}

const DAY_MS = 86_400_000;
const YEAR_MS = 365.25 * DAY_MS;

export const currencyRequired = () => new ApiError(400, "CURRENCY_REQUIRED",
  "currency is required for this country: Rafid has no default currency configured for its market. Supply an ISO 4217 code such as USD. No payment was taken.", { path: "currency" });

export function buildSubject(input: VehicleValueEstimateInput, today: () => Date): Subject {
  const country = normalizeCountry(input.country)!;
  const { params: market, configured } = marketFor(country.code, country.name);
  const currency = input.currency ? normalizeCurrencyCode(input.currency)! : market.defaultCurrency;
  if (!currency) throw currencyRequired();
  const make = normalizeMake(input.make);
  const model = normalizeModel(input.model);
  const trim = normalizeTrim(input.trim);
  const city = normalizeCity(input.city);
  const options = normalizeOptions(input.options);
  const valuationDate = input.valuationDate ?? today().toISOString().slice(0, 10);
  const valuationEndMs = Date.parse(`${valuationDate}T00:00:00Z`) + DAY_MS - 1;
  // A model year typically goes on sale around September of the previous calendar year.
  const ageYears = Math.max(0.25, Math.round(((valuationEndMs - Date.UTC(input.year - 1, 8, 1)) / YEAR_MS) * 10) / 10);
  const accident: AccidentHistory = input.accidentHistory === undefined ? "unknown" : input.accidentHistory === false ? "none" : input.accidentHistory === true ? "reported" : input.accidentHistory;
  return {
    make: make.display, makeKey: make.key, model: model.display, modelKey: model.key, year: input.year,
    trim: trim?.display ?? null, trimKey: trim?.key ?? null, trimTokens: trimTokens(trim?.display),
    mileageKm: input.mileageKm ?? null, condition: input.condition ?? "unknown",
    countryCode: country.code, countryName: country.name, city: city?.display ?? null, cityKey: city?.key ?? null, currency,
    fuelType: input.fuelType ?? null, transmission: input.transmission ?? null, bodyType: input.bodyType ?? null, drivetrain: input.drivetrain ?? null,
    engine: input.engine ? collapseSpaces(input.engine) : null,
    accidentHistory: accident, accidentFromBoolean: input.accidentHistory === true,
    serviceHistory: input.serviceHistory ?? "unknown", owners: input.owners ?? null,
    color: input.color ? collapseSpaces(input.color).toLowerCase() : null,
    options: options.all, premiumOptions: options.premium,
    askingPrice: input.askingPrice ?? null,
    vin: input.vin ?? null,
    valuationDate, valuationEndMs, ageYears, market, marketConfigured: configured
  };
}
