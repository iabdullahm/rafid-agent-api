import { createHash } from "node:crypto";

/**
 * vehicle_value_estimate — optional VIN support.
 *
 * Privacy: a VIN identifies one physical vehicle. It is validated and (optionally) decoded for
 * the duration of the request only — never stored, never logged, never put in analytics,
 * telemetry, cache keys or preview fingerprints. Responses carry it masked (the 6-character
 * serial section hidden). Provider listings' VINs are reduced to a SHA-256 hash, used only to
 * exclude the subject vehicle's own listing from its comparables.
 */

const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
const TRANSLITERATION: Readonly<Record<string, number>> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9, S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];
/** Model-year codes (position 10) for the 1980–2009 cycle; the 2010–2039 cycle reuses them. */
const YEAR_CODES = "ABCDEFGHJKLMNPRSTVWXY123456789";

export function normalizeVin(raw: string): string {
  return raw.replace(/[\s-]+/g, "").toUpperCase();
}

export function isVinFormatValid(vin: string): boolean {
  return VIN_RE.test(vin);
}

export function computeCheckDigit(vin: string): string {
  let sum = 0;
  for (let i = 0; i < 17; i++) {
    const c = vin[i]!;
    const v = /\d/.test(c) ? Number(c) : TRANSLITERATION[c] ?? 0;
    sum += v * WEIGHTS[i]!;
  }
  const r = sum % 11;
  return r === 10 ? "X" : String(r);
}

export type WmiRegion = "north_america" | "south_america" | "europe" | "asia" | "africa" | "oceania" | "unknown";

export function wmiRegion(vin: string): WmiRegion {
  const c = vin[0]!;
  if ("12345".includes(c)) return "north_america";
  if ("67".includes(c)) return "oceania";
  if ("89".includes(c)) return "south_america";
  if ("ABCDEFGH".includes(c)) return "africa";
  if ("JKLMNPR".includes(c)) return "asia";
  if ("STUVWXYZ".includes(c)) return "europe";
  return "unknown";
}

/** Candidate model years encoded at position 10 (one per 30-year cycle); [] when the code is not
 *  a year code. Position 7 disambiguates for North American VINs (letter → 2010+). */
export function modelYearCandidates(vin: string): number[] {
  const idx = YEAR_CODES.indexOf(vin[9]!);
  if (idx < 0) return [];
  return [1980 + idx, 2010 + idx];
}

/** A deliberately partial WMI → make table for common manufacturers (offline decode). Unknown
 *  WMIs return null — never a guess. */
const WMI_MAKES: readonly [string, string][] = [
  ["JTH", "Lexus"], ["JTJ", "Lexus"], ["2T2", "Lexus"], ["JT", "Toyota"], ["2T", "Toyota"], ["4T", "Toyota"], ["5T", "Toyota"], ["MR0", "Toyota"], ["AHT", "Toyota"], ["SB1", "Toyota"], ["NMT", "Toyota"],
  ["JN8", "Nissan"], ["JN1", "Nissan"], ["1N4", "Nissan"], ["1N6", "Nissan"], ["3N1", "Nissan"], ["5N1", "Nissan"], ["JNK", "Infiniti"], ["JNR", "Infiniti"], ["5N3", "Infiniti"],
  ["JHM", "Honda"], ["JHL", "Honda"], ["1HG", "Honda"], ["2HG", "Honda"], ["5FN", "Honda"], ["5J6", "Honda"], ["19U", "Acura"], ["JH4", "Acura"],
  ["KMH", "Hyundai"], ["KM8", "Hyundai"], ["5NP", "Hyundai"], ["KNA", "Kia"], ["KND", "Kia"], ["5XY", "Kia"], ["KMU", "Genesis"],
  ["JF", "Subaru"], ["4S3", "Subaru"], ["4S4", "Subaru"], ["JM", "Mazda"], ["JA3", "Mitsubishi"], ["JA4", "Mitsubishi"], ["JMY", "Mitsubishi"], ["JS", "Suzuki"],
  ["WBA", "BMW"], ["WBS", "BMW"], ["WBY", "BMW"], ["5UX", "BMW"], ["5YM", "BMW"], ["WMW", "MINI"],
  ["WDD", "Mercedes-Benz"], ["WDB", "Mercedes-Benz"], ["WDC", "Mercedes-Benz"], ["W1K", "Mercedes-Benz"], ["W1N", "Mercedes-Benz"], ["4JG", "Mercedes-Benz"],
  ["WVW", "Volkswagen"], ["WVG", "Volkswagen"], ["3VW", "Volkswagen"], ["1VW", "Volkswagen"], ["WAU", "Audi"], ["WA1", "Audi"], ["WP0", "Porsche"], ["WP1", "Porsche"],
  ["SAL", "Land Rover"], ["SAJ", "Jaguar"], ["YV1", "Volvo"], ["YV4", "Volvo"], ["ZFF", "Ferrari"], ["ZHW", "Lamborghini"], ["ZAM", "Maserati"], ["SCB", "Bentley"], ["SCA", "Rolls-Royce"],
  ["1FA", "Ford"], ["1FM", "Ford"], ["1FT", "Ford"], ["3FA", "Ford"], ["1LN", "Lincoln"], ["5LM", "Lincoln"],
  ["1G1", "Chevrolet"], ["1GC", "Chevrolet"], ["1GN", "Chevrolet"], ["3GN", "Chevrolet"], ["1GT", "GMC"], ["1GK", "GMC"], ["3GT", "GMC"], ["1GY", "Cadillac"],
  ["1C6", "Ram"], ["3C6", "Ram"], ["1J4", "Jeep"], ["1J8", "Jeep"], ["2C3", "Dodge"], ["2C4", "Chrysler"], ["5YJ", "Tesla"], ["7SA", "Tesla"], ["LRW", "Tesla"],
  ["VF1", "Renault"], ["VF3", "Peugeot"], ["VF7", "Citroen"], ["ZFA", "Fiat"], ["ZAR", "Alfa Romeo"], ["TMB", "Skoda"], ["VSS", "SEAT"], ["W0L", "Opel"], ["LVV", "Chery"], ["LGW", "Haval"], ["LGX", "BYD"]
];

export function wmiMake(vin: string): string | null {
  const match = WMI_MAKES.find(([prefix]) => vin.startsWith(prefix));
  return match ? match[1] : null;
}

export function maskVin(vin: string): string {
  return `${vin.slice(0, 11)}******`;
}

export function hashVin(vin: string): string {
  return createHash("sha256").update(normalizeVin(vin), "utf8").digest("hex");
}

// ---- online decoding ---------------------------------------------------------------------------

export interface DecodedVin {
  make: string | null;
  model: string | null;
  modelYear: number | null;
  trim: string | null;
  bodyClass: string | null;
  fuelType: string | null;
  driveType: string | null;
  transmission: string | null;
  engine: string | null;
}

export interface VinDecoder {
  readonly id: string;
  decode(vin: string, signal: AbortSignal): Promise<DecodedVin | null>;
}

const clean = (v: unknown): string | null => (typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "not applicable" ? v.trim() : null);

/**
 * NHTSA vPIC (https://vpic.nhtsa.dot.gov/api/) — free, keyless, US-government VIN decoder
 * (`GET /api/vehicles/DecodeVinValues/{VIN}?format=json`). Strongest for vehicles built for North
 * America; many other markets' VINs decode at make/model level. Opt-in (VEHICLE_VIN_DECODER=nhtsa)
 * because it sends the VIN to a third party.
 */
export class NhtsaVinDecoder implements VinDecoder {
  readonly id = "nhtsa_vpic";
  constructor(private readonly options: { fetchImpl?: typeof fetch; baseUrl?: string } = {}) {}

  async decode(vin: string, signal: AbortSignal): Promise<DecodedVin | null> {
    const base = this.options.baseUrl ?? "https://vpic.nhtsa.dot.gov/api";
    const response = await (this.options.fetchImpl ?? fetch)(`${base}/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`, { signal, headers: { Accept: "application/json" } });
    if (!response.ok) return null;
    const body = await response.json() as { Results?: Record<string, unknown>[] };
    const r = body.Results?.[0];
    if (!r) return null;
    const year = Number(r.ModelYear);
    const displacement = clean(r.DisplacementL);
    const cylinders = clean(r.EngineCylinders);
    const decoded: DecodedVin = {
      make: clean(r.Make), model: clean(r.Model), modelYear: Number.isInteger(year) && year > 1900 ? year : null,
      trim: clean(r.Trim), bodyClass: clean(r.BodyClass), fuelType: clean(r.FuelTypePrimary), driveType: clean(r.DriveType),
      transmission: clean(r.TransmissionStyle),
      engine: displacement || cylinders ? [displacement ? `${Number(displacement).toFixed(1)}L` : null, cylinders ? `${cylinders} cyl` : null].filter(Boolean).join(" ") : null
    };
    return decoded.make || decoded.model || decoded.modelYear ? decoded : null;
  }
}
