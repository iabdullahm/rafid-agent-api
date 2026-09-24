import { matchKey, trimTokens } from "./normalization.js";
import type { Subject } from "./subject.js";
import type { Condition, VehicleComparable } from "./types.js";

/**
 * Weighted 0–1 similarity between the subject and one comparable. make + model equality is
 * MANDATORY (a comparable of another model is never scored — it is excluded before this point);
 * everything else contributes through these weights (sum = 1):
 */
export const SIMILARITY_WEIGHTS = Object.freeze({
  trim: 0.25, year: 0.20, mileage: 0.20, location: 0.15, condition: 0.05, fuelTransmission: 0.05, bodyDrivetrain: 0.05, recency: 0.05
});

const DAY_MS = 86_400_000;
const CONDITION_RANK: Readonly<Record<Condition, number | null>> = { excellent: 4, very_good: 3, good: 2, fair: 1, poor: 0, unknown: null };

export type LocationMatch = "same_city" | "same_country" | "regional";

export interface ScoredComparable {
  comparable: VehicleComparable;
  /** Price converted into the result currency. */
  price: number;
  similarity: number;
  components: Record<keyof typeof SIMILARITY_WEIGHTS, number>;
  trimMatch: "exact" | "partial" | "different" | "unknown";
  location: LocationMatch;
  ageDays: number | null;
}

export function trimSimilarity(subject: Subject, c: VehicleComparable): { score: number; match: ScoredComparable["trimMatch"] } {
  if (!subject.trimKey || !c.trim) return { score: subject.trimKey ? 0.4 : 0.5, match: "unknown" };
  if (matchKey(c.trim) === subject.trimKey) return { score: 1, match: "exact" };
  const a = new Set(subject.trimTokens);
  const b = new Set(trimTokens(c.trim));
  const shared = [...a].filter(t => b.has(t)).length;
  const union = new Set([...a, ...b]).size;
  if (shared > 0) return { score: 0.4 + 0.4 * (shared / union), match: "partial" };
  return { score: 0, match: "different" };
}

export const yearSimilarity = (subjectYear: number, year: number) => Math.max(0, 1 - 0.3 * Math.abs(subjectYear - year));

export function mileageSimilarity(subjectKm: number | null, km: number | undefined): number {
  if (subjectKm === null || km === undefined) return 0.5;
  const scale = Math.max(60_000, 0.8 * Math.max(subjectKm, km));
  return Math.max(0, 1 - Math.abs(subjectKm - km) / scale);
}

export function locationOf(subject: Subject, c: VehicleComparable): { score: number; match: LocationMatch } {
  if (c.country !== subject.countryCode) return { score: 0.35, match: "regional" };
  const cityKey = c.city ? matchKey(c.city) : null;
  if (subject.cityKey && cityKey) return subject.cityKey === cityKey ? { score: 1, match: "same_city" } : { score: 0.7, match: "same_country" };
  return { score: 0.8, match: "same_country" };
}

export function conditionSimilarity(a: Condition, b: Condition | undefined): number {
  const ra = CONDITION_RANK[a];
  const rb = b ? CONDITION_RANK[b] : null;
  if (ra === null || rb === null || rb === undefined) return 0.6;
  return Math.max(0, 1 - 0.3 * Math.abs(ra - rb));
}

const attr = (a: string | null, b: string | undefined) => (a === null || b === undefined ? 0.6 : a === b ? 1 : 0);

/** Days between observation and the end of the valuation day; null when not dated. */
export function ageDays(subject: Subject, c: VehicleComparable): number | null {
  if (!c.observedAt) return null;
  return Math.max(0, Math.floor((subject.valuationEndMs - Date.parse(c.observedAt)) / DAY_MS));
}

export function recencySimilarity(days: number | null): number {
  if (days === null) return 0;
  if (days <= 30) return 1;
  if (days <= 180) return 1 - 0.8 * ((days - 30) / 150);
  if (days <= 365) return 0.2 * (1 - (days - 180) / 185);
  return 0;
}

export function scoreComparable(subject: Subject, c: VehicleComparable, price: number): ScoredComparable {
  const trim = trimSimilarity(subject, c);
  const location = locationOf(subject, c);
  const days = ageDays(subject, c);
  const components = {
    trim: trim.score,
    year: yearSimilarity(subject.year, c.year),
    mileage: mileageSimilarity(subject.mileageKm, c.mileageKm),
    location: location.score,
    condition: conditionSimilarity(subject.condition, c.condition),
    fuelTransmission: (attr(subject.fuelType, c.fuelType) + attr(subject.transmission, c.transmission)) / 2,
    bodyDrivetrain: (attr(subject.bodyType, c.bodyType) + attr(subject.drivetrain, c.drivetrain)) / 2,
    recency: recencySimilarity(days)
  };
  const similarity = (Object.keys(SIMILARITY_WEIGHTS) as (keyof typeof SIMILARITY_WEIGHTS)[])
    .reduce((sum, k) => sum + SIMILARITY_WEIGHTS[k] * components[k], 0);
  return { comparable: c, price, similarity: Math.round(similarity * 10_000) / 10_000, components, trimMatch: trim.match, location: location.match, ageDays: days };
}
