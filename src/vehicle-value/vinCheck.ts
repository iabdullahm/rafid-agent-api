import {
  BODY_SYNONYMS, DRIVETRAIN_SYNONYMS, FUEL_SYNONYMS, TRANSMISSION_SYNONYMS, matchKey, normalizeMake, normalizeTrim, trimTokens
} from "./normalization.js";
import type { Subject } from "./subject.js";
import { BODY_TYPES, DRIVETRAINS, FUEL_TYPES, TRANSMISSIONS } from "./types.js";
import {
  computeCheckDigit, maskVin, modelYearCandidates, wmiMake, wmiRegion, type DecodedVin, type WmiRegion
} from "./vin.js";

export type VinDecodeStatus = "decoded" | "not_decoded" | "unavailable" | "not_configured";

export interface VinCheck {
  vinMasked: string;
  wmiRegion: WmiRegion;
  checkDigit: "valid" | "invalid" | "not_applicable";
  decoder: string;
  decodeStatus: VinDecodeStatus;
  decoded: {
    make: string | null; model: string | null; modelYear: number | null; trim: string | null;
    bodyClass: string | null; fuelType: string | null; driveType: string | null; transmission: string | null; engine: string | null;
  };
  matches: { make: boolean | null; model: boolean | null; year: boolean | null };
  enrichedFields: string[];
  notes: string[];
}

function pick<T extends readonly string[]>(raw: string | null, synonyms: Readonly<Record<string, string>>, allowed: T): T[number] | null {
  if (!raw) return null;
  const direct = synonyms[matchKey(raw)];
  if (direct && (allowed as readonly string[]).includes(direct)) return direct as T[number];
  for (const w of raw.split(/[^A-Za-z0-9]+/)) {
    const hit = synonyms[matchKey(w)];
    if (hit && (allowed as readonly string[]).includes(hit)) return hit as T[number];
  }
  if (/sport utility|suv|multipurpose/i.test(raw) && (allowed as readonly string[]).includes("suv")) return "suv" as T[number];
  return null;
}

/**
 * Offline + (optional) online VIN analysis. Mutates `subject` only to FILL fields the caller did
 * not supply (trim, body, fuel, drivetrain, transmission, engine) and only when the decoded make
 * and model year agree with the request — a mismatching VIN never overrides the request, it is
 * flagged (VIN_MISMATCH) instead.
 */
export function analyzeVin(subject: Subject, vin: string, decoded: DecodedVin | null, decoderId: string | null, decoderFailed: boolean): VinCheck {
  const region = wmiRegion(vin);
  const northAmerica = region === "north_america";
  const checkDigit = northAmerica ? (computeCheckDigit(vin) === vin[8] ? "valid" : "invalid") : "not_applicable";
  const notes: string[] = [];
  const offlineMake = wmiMake(vin);

  const decodedMake = decoded?.make ? normalizeMake(decoded.make) : null;
  const makeMatch = decodedMake ? decodedMake.key === subject.makeKey
    : offlineMake ? normalizeMake(offlineMake).key === subject.makeKey : null;

  const decodedModelKey = decoded?.model ? matchKey(decoded.model) : null;
  const modelMatch = decodedModelKey ? (decodedModelKey === subject.modelKey || decodedModelKey.includes(subject.modelKey) || subject.modelKey.includes(decodedModelKey)) : null;

  let yearMatch: boolean | null = null;
  if (decoded?.modelYear) yearMatch = decoded.modelYear === subject.year;
  else if (northAmerica) {
    const candidates = modelYearCandidates(vin);
    // North American VINs: position 7 alphabetic ⇒ the 2010–2039 cycle.
    const cycle = /[A-Z]/.test(vin[6]!) ? candidates.filter(y => y >= 2010) : candidates.filter(y => y < 2010);
    yearMatch = cycle.length ? cycle.includes(subject.year) : null;
  }

  if (!decoded) notes.push(decoderId
    ? (decoderFailed ? "The VIN decoder could not be reached; only offline checks were applied." : "The VIN decoder returned no data for this VIN; only offline checks were applied.")
    : "No online VIN decoder is configured; offline checks only (format, check digit for North American VINs, manufacturer prefix, model-year code).");
  if (!northAmerica) notes.push("Check digit and model-year code are only mandatory for North American VINs; they are not enforced for this VIN.");
  if (offlineMake === null && !decoded) notes.push("The manufacturer prefix (WMI) is not in Rafid's offline table; make could not be verified offline.");

  const enriched: string[] = [];
  if (decoded && makeMatch !== false && yearMatch !== false) {
    if (!subject.trimKey && decoded.trim) {
      const t = normalizeTrim(decoded.trim);
      if (t) { subject.trim = t.display; subject.trimKey = t.key; subject.trimTokens = trimTokens(t.display); enriched.push("trim"); }
    }
    if (!subject.bodyType) { const v = pick(decoded.bodyClass, BODY_SYNONYMS, BODY_TYPES); if (v) { subject.bodyType = v; enriched.push("bodyType"); } }
    if (!subject.fuelType) { const v = pick(decoded.fuelType, FUEL_SYNONYMS, FUEL_TYPES); if (v) { subject.fuelType = v; enriched.push("fuelType"); } }
    if (!subject.drivetrain) { const v = pick(decoded.driveType, DRIVETRAIN_SYNONYMS, DRIVETRAINS); if (v) { subject.drivetrain = v; enriched.push("drivetrain"); } }
    if (!subject.transmission) { const v = pick(decoded.transmission, TRANSMISSION_SYNONYMS, TRANSMISSIONS); if (v) { subject.transmission = v; enriched.push("transmission"); } }
    if (!subject.engine && decoded.engine) { subject.engine = decoded.engine; enriched.push("engine"); }
  }

  return {
    vinMasked: maskVin(vin), wmiRegion: region, checkDigit,
    decoder: decoderId ?? "offline",
    decodeStatus: decoded ? "decoded" : decoderId ? (decoderFailed ? "unavailable" : "not_decoded") : "not_configured",
    decoded: {
      make: decodedMake?.display ?? offlineMake ?? null, model: decoded?.model ?? null, modelYear: decoded?.modelYear ?? null, trim: decoded?.trim ?? null,
      bodyClass: decoded?.bodyClass ?? null, fuelType: decoded?.fuelType ?? null, driveType: decoded?.driveType ?? null,
      transmission: decoded?.transmission ?? null, engine: decoded?.engine ?? null
    },
    matches: { make: makeMatch, model: modelMatch, year: yearMatch },
    enrichedFields: enriched,
    notes
  };
}
