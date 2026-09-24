import { z } from "zod";
import { hashVin, isVinFormatValid, normalizeVin } from "../vin.js";
import { BODY_TYPES, CONDITIONS, DRIVETRAINS, FUEL_TYPES, TRANSMISSIONS } from "../types.js";
import {
  BODY_SYNONYMS, CONDITION_SYNONYMS, DRIVETRAIN_SYNONYMS, FUEL_SYNONYMS, TRANSMISSION_SYNONYMS,
  matchKey, normalizeCity, normalizeCountry, normalizeCurrencyCode, normalizeMake, normalizeModel, normalizeTrim
} from "../normalization.js";

/**
 * vehicle_market_records — the normalized, provider-independent storage shape for vehicle market
 * evidence (listing asking prices or recorded sale prices) imported from an approved source.
 *
 * Privacy: vehicle and market evidence ONLY. There is no column for a seller's name, phone number,
 * e-mail address, VIN or any other personal identifier; import rows carrying such columns are
 * accepted but those columns are dropped (and reported in `droppedPersonalDataColumns`), never
 * stored.
 */
export interface VehicleMarketRecord {
  make: string; normalizedMake: string;
  model: string; normalizedModel: string;
  year: number;
  trim: string | null; normalizedTrim: string | null;
  mileageKm: number | null;
  condition: (typeof CONDITIONS)[number] | null;
  bodyType: (typeof BODY_TYPES)[number] | null;
  fuelType: (typeof FUEL_TYPES)[number] | null;
  transmission: (typeof TRANSMISSIONS)[number] | null;
  drivetrain: (typeof DRIVETRAINS)[number] | null;
  country: string;
  city: string | null; normalizedCity: string | null;
  region: string | null;
  price: number;
  currency: string;
  priceType: "listing" | "sale";
  sourceType: "licensed_feed" | "partner_feed" | "marketplace_api" | "manual_import" | "auction_results";
  sourceName: string;
  sourceRecordId: string | null;
  sourceUrl: string | null;
  observedAt: string;
  metadata: Record<string, string | number | boolean | null>;
  /** SHA-256 of a VIN column when the source supplied one — never persisted, never the VIN itself;
   *  used only to exclude the subject vehicle's own listing from its comparables. */
  vinHash?: string;
}

const cat = <T extends readonly [string, ...string[]]>(values: T, synonyms: Readonly<Record<string, string>>) =>
  z.preprocess(v => (typeof v === "string" && v.trim() !== "" ? synonyms[matchKey(v)] ?? v.trim().toLowerCase() : v === "" ? undefined : v), z.enum(values).optional());
const num = z.preprocess(v => (typeof v === "string" ? (v.trim() === "" ? undefined : Number(v.replace(/[, ]/g, ""))) : v), z.number().finite().optional());
const str = (max: number) => z.preprocess(v => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().min(1).max(max).optional());

const SOURCE_TYPES = ["licensed_feed", "partner_feed", "marketplace_api", "manual_import", "auction_results"] as const;

/** One import row. Unknown columns are ignored (and PII-looking ones reported); known ones are
 *  validated strictly. */
export const vehicleMarketRecordRow = z.object({
  make: z.string().trim().min(1).max(60),
  model: z.string().trim().min(1).max(80),
  year: z.preprocess(v => (typeof v === "string" ? Number(v) : v), z.number().int().min(1950).max(2100)),
  trim: str(60),
  mileageKm: num.refine(v => v === undefined || (v >= 0 && v <= 2_000_000), "mileageKm must be 0–2,000,000"),
  condition: cat(CONDITIONS, CONDITION_SYNONYMS),
  bodyType: cat(BODY_TYPES, BODY_SYNONYMS),
  fuelType: cat(FUEL_TYPES, FUEL_SYNONYMS),
  transmission: cat(TRANSMISSIONS, TRANSMISSION_SYNONYMS),
  drivetrain: cat(DRIVETRAINS, DRIVETRAIN_SYNONYMS),
  country: z.string().trim().refine(v => normalizeCountry(v) !== null, "unrecognized country"),
  city: str(80),
  region: str(80),
  price: z.preprocess(v => (typeof v === "string" ? Number(v.replace(/[, ]/g, "")) : v), z.number().positive().max(100_000_000)),
  currency: z.string().trim().refine(v => normalizeCurrencyCode(v) !== null, "currency must be ISO 4217"),
  priceType: z.preprocess(v => (v === "" ? undefined : v), z.enum(["listing", "sale"]).optional()),
  sourceType: z.preprocess(v => (v === "" ? undefined : v), z.enum(SOURCE_TYPES).optional()),
  sourceName: z.string().trim().min(1).max(120),
  sourceRecordId: str(200),
  sourceUrl: str(1000).refine(v => v === undefined || /^https?:\/\//i.test(v), "sourceUrl must be http(s)"),
  observedAt: z.string().trim().refine(v => !Number.isNaN(Date.parse(v)), "observedAt must be an ISO 8601 date/time")
});

/** Column names that look like personal data — never stored, reported back to the importer. */
const PERSONAL_DATA_COLUMN = /(phone|mobile|whats ?app|e-?mail|seller|owner|contact|dealer_?name|name_of|first_?name|last_?name|full_?name|address|national_?id|civil_?id|passport|\bvin\b|chassis|plate|licen[cs]e_?plate|registration_?number)/i;

export interface RecordValidationResult {
  records: VehicleMarketRecord[];
  errors: { row: number; issues: string[] }[];
  droppedPersonalDataColumns: string[];
  ignoredColumns: string[];
}

const KNOWN_COLUMNS = new Set(Object.keys(vehicleMarketRecordRow.shape));

export function validateVehicleMarketRows(rows: readonly Record<string, unknown>[], defaults: { sourceType?: VehicleMarketRecord["sourceType"] } = {}): RecordValidationResult {
  const records: VehicleMarketRecord[] = [];
  const errors: RecordValidationResult["errors"] = [];
  const dropped = new Set<string>();
  const ignored = new Set<string>();
  rows.forEach((row, index) => {
    const known: Record<string, unknown> = {};
    let vinHash: string | undefined;
    for (const [column, value] of Object.entries(row ?? {})) {
      if (/^vin$/i.test(column) && typeof value === "string" && isVinFormatValid(normalizeVin(value))) vinHash = hashVin(value);
      if (KNOWN_COLUMNS.has(column)) known[column] = value;
      else if (PERSONAL_DATA_COLUMN.test(column)) dropped.add(column);
      else ignored.add(column);
    }
    const parsed = vehicleMarketRecordRow.safeParse(known);
    if (!parsed.success) { errors.push({ row: index + 1, issues: parsed.error.issues.map(i => `${i.path.join(".") || "row"}: ${i.message}`) }); return; }
    const r = parsed.data;
    const make = normalizeMake(r.make);
    const model = normalizeModel(r.model);
    const trim = normalizeTrim(r.trim);
    const country = normalizeCountry(r.country)!;
    const city = normalizeCity(r.city);
    records.push({
      make: make.display, normalizedMake: make.key, model: model.display, normalizedModel: model.key, year: r.year,
      trim: trim?.display ?? null, normalizedTrim: trim?.key ?? null,
      mileageKm: r.mileageKm === undefined ? null : Math.round(r.mileageKm),
      condition: r.condition ?? null, bodyType: r.bodyType ?? null, fuelType: r.fuelType ?? null, transmission: r.transmission ?? null, drivetrain: r.drivetrain ?? null,
      country: country.code, city: city?.display ?? null, normalizedCity: city?.key ?? null, region: r.region ?? null,
      price: r.price, currency: normalizeCurrencyCode(r.currency)!, priceType: r.priceType ?? "listing",
      sourceType: r.sourceType ?? defaults.sourceType ?? "manual_import", sourceName: r.sourceName,
      sourceRecordId: r.sourceRecordId ?? null, sourceUrl: r.sourceUrl ?? null, observedAt: new Date(Date.parse(r.observedAt)).toISOString(),
      metadata: {},
      ...(vinHash ? { vinHash } : {})
    });
  });
  return { records, errors, droppedPersonalDataColumns: [...dropped].sort(), ignoredColumns: [...ignored].sort() };
}

// ---- new-vehicle (original) price references ------------------------------------------------------

/**
 * vehicle_new_prices — verified original / new-vehicle prices (e.g. a distributor's official
 * price list for a model year, a manufacturer's published MSRP) imported by an operator. Used only
 * for depreciation; a valuation never assumes an original price that is not on record.
 */
export interface VehicleNewPriceRecord {
  make: string; normalizedMake: string;
  model: string; normalizedModel: string;
  year: number;
  trim: string | null; normalizedTrim: string | null;
  country: string;
  price: number;
  currency: string;
  sourceName: string;
  sourceUrl: string | null;
  effectiveDate: string | null;
}

export const vehicleNewPriceRow = z.object({
  make: z.string().trim().min(1).max(60),
  model: z.string().trim().min(1).max(80),
  year: z.preprocess(v => (typeof v === "string" ? Number(v) : v), z.number().int().min(1950).max(2100)),
  trim: str(60),
  country: z.string().trim().refine(v => normalizeCountry(v) !== null, "unrecognized country"),
  price: z.preprocess(v => (typeof v === "string" ? Number(v.replace(/[, ]/g, "")) : v), z.number().positive().max(100_000_000)),
  currency: z.string().trim().refine(v => normalizeCurrencyCode(v) !== null, "currency must be ISO 4217"),
  sourceName: z.string().trim().min(1).max(160),
  sourceUrl: str(1000).refine(v => v === undefined || /^https?:\/\//i.test(v), "sourceUrl must be http(s)"),
  effectiveDate: str(40).refine(v => v === undefined || !Number.isNaN(Date.parse(v)), "effectiveDate must be a date")
});

export function validateNewPriceRows(rows: readonly Record<string, unknown>[]): { records: VehicleNewPriceRecord[]; errors: { row: number; issues: string[] }[] } {
  const records: VehicleNewPriceRecord[] = [];
  const errors: { row: number; issues: string[] }[] = [];
  rows.forEach((row, index) => {
    const parsed = vehicleNewPriceRow.safeParse(row);
    if (!parsed.success) { errors.push({ row: index + 1, issues: parsed.error.issues.map(i => `${i.path.join(".") || "row"}: ${i.message}`) }); return; }
    const r = parsed.data;
    const make = normalizeMake(r.make); const model = normalizeModel(r.model); const trim = normalizeTrim(r.trim);
    records.push({
      make: make.display, normalizedMake: make.key, model: model.display, normalizedModel: model.key, year: r.year,
      trim: trim?.display ?? null, normalizedTrim: trim?.key ?? null, country: normalizeCountry(r.country)!.code,
      price: r.price, currency: normalizeCurrencyCode(r.currency)!, sourceName: r.sourceName, sourceUrl: r.sourceUrl ?? null,
      effectiveDate: r.effectiveDate ? new Date(Date.parse(r.effectiveDate)).toISOString().slice(0, 10) : null
    });
  });
  return { records, errors };
}

/** Exact trim match when the subject's trim is known; when it is not, only an unambiguous single
 *  price for the model year (never an average of different trims). */
export function pickNewPrice(candidates: readonly VehicleNewPriceRecord[], trimKey: string | null): VehicleNewPriceRecord | null {
  if (trimKey) return candidates.find(c => c.normalizedTrim === trimKey) ?? null;
  const distinct = new Set(candidates.map(c => `${c.price}|${c.currency}`));
  return candidates.length && distinct.size === 1 ? candidates[0]! : null;
}
