import type { CompanyRecord } from "../sources/companyRepository.js";
import { normalizeCompanyName } from "../normalizers/companyName.js";
import { AUTHORITATIVE_SOURCE_TYPES } from "../types.js";

/**
 * Section 4: deterministic, weighted company search. No LLM inference at any step — every score
 * is a fixed function of measurable string/field agreement between the query and a candidate
 * record. Ranking considers, in descending weight: exact registration number, exact normalized
 * name, prefix name match, fuzzy name similarity, location match, industry match — exactly the
 * ordering the task specifies.
 */

export interface CompanySearchInput {
  query: string;
  governorate?: string;
  wilayat?: string;
  industry?: string;
  limit?: number;
}

export interface RankedCompanyMatch {
  record: CompanyRecord;
  confidence: number;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
/** Candidates scoring below this are dropped entirely rather than returned as noise. */
const MIN_CONFIDENCE = 0.15;

function cleanRegistrationNumber(value: string): string {
  return value.trim().toUpperCase().replace(/[\s-]/g, "");
}

/** Character-bigram Dice coefficient — a standard, deterministic string-similarity measure (no
 *  model, no external service). 1.0 for identical strings, 0 for no shared bigrams. Falls back to
 *  an exact-equality check for strings shorter than 2 characters, where bigrams don't apply. */
function bigramSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const bigrams = (s: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (let i = 0; i < s.length - 1; i++) {
      const bg = s.slice(i, i + 2);
      map.set(bg, (map.get(bg) ?? 0) + 1);
    }
    return map;
  };
  const bigramsA = bigrams(a);
  const bigramsB = bigrams(b);
  let intersection = 0;
  for (const [bg, countA] of bigramsA) {
    const countB = bigramsB.get(bg);
    if (countB) intersection += Math.min(countA, countB);
  }
  const totalA = [...bigramsA.values()].reduce((s, n) => s + n, 0);
  const totalB = [...bigramsB.values()].reduce((s, n) => s + n, 0);
  return (2 * intersection) / (totalA + totalB);
}

/** Best name-similarity score for one candidate against the normalized query, checked against
 *  every name field the record carries (companyName, nameEn, nameAr) — a query in Arabic should
 *  still find a company whose primary companyName is in English, and vice versa, as long as the
 *  matching name field is present. */
function nameMatchScore(record: CompanyRecord, normalizedQuery: string): number {
  const candidates = [record.normalizedName, record.nameEn ? normalizeCompanyName(record.nameEn).normalized : null, record.nameAr ? normalizeCompanyName(record.nameAr).normalized : null]
    .filter((v): v is string => Boolean(v));
  let best = 0;
  for (const candidateName of candidates) {
    let score: number;
    if (candidateName === normalizedQuery) {
      score = 0.94;
    } else if (candidateName.startsWith(normalizedQuery) || normalizedQuery.startsWith(candidateName)) {
      const shorter = Math.min(candidateName.length, normalizedQuery.length);
      const longer = Math.max(candidateName.length, normalizedQuery.length);
      score = 0.75 + 0.08 * (shorter / longer); // 0.75–0.83: closer lengths score higher
    } else {
      score = 0.65 * bigramSimilarity(candidateName, normalizedQuery);
    }
    if (score > best) best = score;
  }
  return best;
}

/** Picks the row that represents a companyId's group of contributing-source rows: prefer an
 *  authoritative source (government/public_registry) over a merely-reported one, then the most
 *  recently observed row among equally-authoritative candidates. Deterministic — never a
 *  heuristic guess about which source is "better" beyond this fixed, documented rule. */
export function pickRepresentative(rows: readonly CompanyRecord[]): CompanyRecord {
  const sorted = [...rows].sort((a, b) => {
    const aAuth = AUTHORITATIVE_SOURCE_TYPES.includes(a.sourceType) ? 1 : 0;
    const bAuth = AUTHORITATIVE_SOURCE_TYPES.includes(b.sourceType) ? 1 : 0;
    if (aAuth !== bAuth) return bAuth - aAuth;
    return b.observedAt.localeCompare(a.observedAt);
  });
  return sorted[0]!;
}

/**
 * Groups raw candidate rows by companyId, scores each group's representative row against the
 * query, and returns ranked matches. `rows` is expected to already be filtered to the relevant
 * candidate pool by the calling CompanyDataProvider (search()) — this function only scores and
 * ranks; it never fetches data itself.
 */
export function rankCompanies(rows: readonly CompanyRecord[], input: CompanySearchInput): RankedCompanyMatch[] {
  const groups = new Map<string, CompanyRecord[]>();
  for (const row of rows) {
    const group = groups.get(row.companyId);
    if (group) group.push(row); else groups.set(row.companyId, [row]);
  }

  const normalizedQuery = normalizeCompanyName(input.query).normalized;
  const cleanedQueryReg = cleanRegistrationNumber(input.query);

  const results: RankedCompanyMatch[] = [];
  for (const group of groups.values()) {
    const record = pickRepresentative(group);
    let score: number;
    if (record.registrationNumber && cleanRegistrationNumber(record.registrationNumber) === cleanedQueryReg && cleanedQueryReg.length >= 4) {
      score = 0.98;
    } else {
      score = nameMatchScore(record, normalizedQuery);
    }
    if (input.governorate && record.governorate?.toLowerCase() === input.governorate.toLowerCase()) score += 0.03;
    if (input.wilayat && record.wilayat?.toLowerCase() === input.wilayat.toLowerCase()) score += 0.02;
    if (input.industry && record.industry?.toLowerCase().includes(input.industry.toLowerCase())) score += 0.03;
    score = Math.max(0, Math.min(1, Math.round(score * 100) / 100));
    if (score >= MIN_CONFIDENCE) results.push({ record, confidence: score });
  }

  results.sort((a, b) => b.confidence - a.confidence || a.record.companyName.localeCompare(b.record.companyName));
  const limit = Math.max(1, Math.min(MAX_LIMIT, input.limit ?? DEFAULT_LIMIT));
  return results.slice(0, limit);
}
