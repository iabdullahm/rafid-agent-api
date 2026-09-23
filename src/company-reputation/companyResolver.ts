import {
  companyNameSimilarity, countriesMentioned, domainLabel, foldForMatch, legalFormConflict, legalFormFamilies, legalFormsNearName,
  mentionStrength, normalizeCompanyName, registrationNumbersMatch
} from "./normalization.js";
import type { ReputationQuery } from "./providers/types.js";
import type { NormalizedEvidence } from "./types.js";

/**
 * Entity resolution. The single most important safety property of a GLOBAL reputation tool:
 * "ABC Holdings LLC" in Oman must never inherit evidence about "ABC Holdings Ltd" in the UK.
 *
 *  1. Registry candidates are scored against the request's identifiers (registration number, LEI,
 *     country, city, legal form, name). A candidate in a DIFFERENT country is never a match. A
 *     registration-number or LEI match is decisive; a name match alone is only "probable".
 *  2. Several similarly-strong candidates with nothing to tell them apart → "ambiguous" (limited
 *     result), never a silent merge.
 *  3. Every non-registry item (news, reviews, forums) gets a relevance score: does it name the
 *     company, the company's domain, or registration number? Does it place the story in another
 *     country, or attach a conflicting legal form to the name? Low-relevance items are excluded from
 *     scoring and reported as "possibly a different entity".
 */

export const RESOLUTION_STATUSES = ["resolved", "probable", "ambiguous", "unresolved", "registry_not_checked"] as const;
export type ResolutionStatus = (typeof RESOLUTION_STATUSES)[number];

export interface RegistryCandidateView {
  evidenceId: string;
  legalName: string;
  country: string | null;
  city: string | null;
  registrationNumber: string | null;
  lei: string | null;
  status: string;
  incorporationDate: string | null;
  registryName: string;
  score: number;
  matchedOn: string[];
  conflicts: string[];
}

export interface Resolution {
  status: ResolutionStatus;
  /** 0-1. */
  confidence: number;
  resolvedName: string | null;
  matched: RegistryCandidateView | null;
  /** Other candidates that belong to the same legal entity (same LEI/registration number from a second registry). */
  corroboratingRecords: RegistryCandidateView[];
  candidates: RegistryCandidateView[];
  methods: string[];
  conflicts: string[];
  websiteCorroborates: boolean;
  domainConsistentWithName: boolean;
}

const MATCH_THRESHOLD = 0.6;
const PROBABLE_THRESHOLD = 0.7;
const RESOLVED_THRESHOLD = 0.85;
const AMBIGUITY_MARGIN = 0.08;

function str(v: unknown): string | null { return typeof v === "string" && v.length > 0 ? v : null; }
function strs(v: unknown): string[] { return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; }

export function scoreCandidate(q: ReputationQuery, e: NormalizedEvidence): RegistryCandidateView {
  const legalName = str(e.metadata.legalName) ?? e.title ?? "";
  const names = [legalName, ...strs(e.metadata.otherNames)];
  const inputNames = [q.companyName, q.legalName].filter((n): n is string => Boolean(n));
  const nameSim = Math.max(0, ...inputNames.flatMap(a => names.map(b => companyNameSimilarity(a, b))));
  const country = str(e.metadata.country);
  const regNo = str(e.metadata.registrationNumber);
  const lei = str(e.metadata.lei);
  const city = str(e.metadata.city);
  const matchedOn: string[] = [], conflicts: string[] = [];

  if (q.country && country && q.country.code !== country) {
    conflicts.push(`country_mismatch:${country}`);
    return { evidenceId: e.id, legalName, country, city, registrationNumber: regNo, lei, status: str(e.metadata.status) ?? "unknown", incorporationDate: str(e.metadata.incorporationDate), registryName: str(e.metadata.registryName) ?? e.sourceName, score: 0, matchedOn, conflicts };
  }
  let score: number;
  const leiMatch = Boolean(q.lei && lei && q.lei === lei);
  const regMatch = registrationNumbersMatch(q.registrationNumber, regNo);
  if (leiMatch) { matchedOn.push("lei"); score = nameSim >= 0.5 ? 0.98 : 0.85; }
  else if (regMatch) { matchedOn.push("registration_number"); score = nameSim >= 0.5 ? 0.95 : 0.8; }
  else score = nameSim * 0.8;
  if ((leiMatch || regMatch) && nameSim < 0.5) conflicts.push("identifier_matches_differently_named_entity");
  if (nameSim >= 0.85) matchedOn.push("name");
  if (q.country && country === q.country.code) { matchedOn.push("country"); if (!leiMatch && !regMatch) score += 0.1; }
  if (q.city && city && foldForMatch(q.city) === foldForMatch(city)) { matchedOn.push("city"); if (!leiMatch && !regMatch) score += 0.05; }
  else if (q.city && city) { conflicts.push("city_differs"); if (!leiMatch && !regMatch) score -= 0.1; }
  if (!leiMatch && !regMatch && inputNames.some(n => names.some(m => legalFormConflict(n, m)))) { conflicts.push("legal_form_conflict"); score -= 0.25; }
  if (q.registrationNumber && regNo && !regMatch) { conflicts.push("registration_number_differs"); score -= 0.4; }
  if (q.lei && lei && !leiMatch) { conflicts.push("lei_differs"); score -= 0.5; }
  score = Math.max(0, Math.min(0.98, Math.round(score * 100) / 100));
  return { evidenceId: e.id, legalName, country, city, registrationNumber: regNo, lei, status: str(e.metadata.status) ?? "unknown", incorporationDate: str(e.metadata.incorporationDate), registryName: str(e.metadata.registryName) ?? e.sourceName, score, matchedOn, conflicts };
}

/** Does the domain's brand label plausibly belong to this company name (e.g. "exampletech" for
 *  "Example Technologies", or an acronym)? Conservative: used only as weak corroboration. */
export function domainConsistentWithName(domain: string | null, companyName: string): boolean {
  if (!domain) return false;
  const label = domainLabel(domain).replace(/[^a-z0-9]/g, "").toUpperCase();
  const core = normalizeCompanyName(companyName).coreTokens;
  if (label.length < 2 || core.length === 0) return false;
  const joined = core.join("");
  const acronym = core.map(t => t[0]).join("");
  if (label === joined || label === acronym) return true;
  if (joined.startsWith(label) && label.length >= 4) return true;
  return core.some(t => t.length >= 4 && label.includes(t));
}

export function resolveIdentity(q: ReputationQuery, registryEvidence: readonly NormalizedEvidence[], registryChecked: boolean, websiteEvidence: NormalizedEvidence | null): Resolution {
  const all = registryEvidence.map(e => scoreCandidate(q, e)).sort((a, b) => b.score - a.score || a.evidenceId.localeCompare(b.evidenceId));
  const candidates = all.filter(c => c.score >= MATCH_THRESHOLD);

  const siteText = websiteEvidence && websiteEvidence.metadata.reachable === true ? `${websiteEvidence.title ?? ""} ${str(websiteEvidence.metadata.textExcerpt) ?? ""}` : "";
  const websiteCorroborates = Boolean(siteText) && [q.companyName, q.legalName].some(n => n && mentionStrength(siteText, n) >= 0.6);
  const domainConsistent = domainConsistentWithName(q.domain, q.legalName ?? q.companyName);

  const methods: string[] = [];
  const conflicts: string[] = [...new Set(all.flatMap(c => c.conflicts.filter(x => x === "identifier_matches_differently_named_entity")))];
  if (websiteCorroborates) methods.push("website_mentions_company_name");
  if (domainConsistent) methods.push("domain_consistent_with_name");

  // Group candidates that are the SAME legal entity seen in two registries (shared LEI or reg no + country).
  const best = candidates[0] ?? null;
  const sameEntity = (a: RegistryCandidateView, b: RegistryCandidateView) =>
    (a.lei && b.lei && a.lei === b.lei) || (a.registrationNumber && b.registrationNumber && a.country === b.country && registrationNumbersMatch(a.registrationNumber, b.registrationNumber));
  const corroborating = best ? candidates.slice(1).filter(c => sameEntity(best, c)) : [];
  const competitors = best ? candidates.slice(1).filter(c => !sameEntity(best, c) && best.score - c.score < AMBIGUITY_MARGIN) : [];

  const inputOnlyConfidence = () => Math.min(0.45, 0.2 + (websiteCorroborates ? 0.15 : 0) + (domainConsistent ? 0.05 : 0) + (q.country ? 0.05 : 0));

  if (!best) {
    return {
      status: registryChecked ? "unresolved" : "registry_not_checked", confidence: round(inputOnlyConfidence()), resolvedName: null, matched: null,
      corroboratingRecords: [], candidates: all.slice(0, 5), methods: [...methods, "input_identifiers_only"], conflicts, websiteCorroborates, domainConsistentWithName: domainConsistent
    };
  }
  const decisive = best.matchedOn.includes("lei") || best.matchedOn.includes("registration_number");
  if (competitors.length > 0 && !decisive) {
    return {
      status: "ambiguous", confidence: 0.35, resolvedName: null, matched: null, corroboratingRecords: [],
      candidates: candidates.slice(0, 5), methods: [...methods, "multiple_registry_candidates"], conflicts: [...conflicts, "ambiguous_registry_candidates"],
      websiteCorroborates, domainConsistentWithName: domainConsistent
    };
  }
  methods.unshift(...best.matchedOn.map(m => `registry_${m}_match`));
  if (corroborating.length > 0) methods.push("same_entity_in_multiple_registries");
  let confidence: number;
  let status: ResolutionStatus;
  if (best.score >= RESOLVED_THRESHOLD) { status = "resolved"; confidence = best.score; }
  else if (best.score >= PROBABLE_THRESHOLD) { status = "probable"; confidence = best.score * 0.9; }
  else { status = "probable"; confidence = best.score * 0.8; }
  if (websiteCorroborates) confidence += 0.05;
  if (corroborating.length > 0) confidence += 0.03;
  if (best.conflicts.includes("identifier_matches_differently_named_entity")) confidence = Math.min(confidence, 0.6);
  return {
    status, confidence: round(Math.min(0.99, confidence)), resolvedName: best.legalName, matched: best, corroboratingRecords: corroborating,
    candidates: candidates.slice(0, 5), methods, conflicts, websiteCorroborates, domainConsistentWithName: domainConsistent
  };
}

export interface RelevanceAssessment { relevance: number; possibleDifferentEntity: boolean; reasons: string[] }

/** Relevance of a third-party item (news/review/forum) to the requested company. */
export function assessRelevance(e: NormalizedEvidence, q: ReputationQuery, resolution: Resolution): RelevanceAssessment {
  const text = `${e.title ?? ""} ${e.summary ?? ""}`;
  const names = [q.companyName, q.legalName, resolution.resolvedName].filter((n): n is string => Boolean(n));
  const reasons: string[] = [];
  const folded = foldForMatch(text);
  if (q.domain && (e.sourceDomain && (e.sourceDomain === q.domain || e.sourceDomain.endsWith(`.${q.domain}`)) || folded.includes(foldForMatch(q.domain)))) {
    return { relevance: 1, possibleDifferentEntity: false, reasons: ["mentions_company_domain"] };
  }
  const regNo = q.registrationNumber ?? resolution.matched?.registrationNumber ?? null;
  if (regNo && regNo.length >= 5 && folded.replace(/\s/g, "").includes(regNo)) return { relevance: 1, possibleDifferentEntity: false, reasons: ["mentions_registration_number"] };

  let relevance = Math.max(0, ...names.map(n => mentionStrength(text, n)));
  if (relevance === 0) return { relevance: 0.1, possibleDifferentEntity: false, reasons: ["company_not_named"] };
  if (relevance < 1) reasons.push("partial_name_mention");

  const country = q.country?.code ?? resolution.matched?.country ?? null;
  if (country) {
    const mentioned = countriesMentioned(text);
    if (mentioned.length > 0 && !mentioned.includes(country)) {
      relevance *= 0.4;
      reasons.push(`other_jurisdiction_mentioned:${mentioned.join(",")}`);
    } else if (mentioned.includes(country)) {
      reasons.push("requested_country_mentioned");
    }
  }
  const inputForms = new Set(names.flatMap(n => legalFormFamilies(n)));
  if (inputForms.size > 0) {
    const nearForms = names.flatMap(n => legalFormsNearName(text, n));
    if (nearForms.length > 0 && !nearForms.some(f => inputForms.has(f))) {
      relevance *= 0.5;
      reasons.push(`different_legal_form_in_text:${[...new Set(nearForms)].join(",")}`);
    }
  }
  relevance = round(relevance);
  return { relevance, possibleDifferentEntity: relevance < 0.5, reasons };
}

function round(n: number): number { return Math.round(n * 100) / 100; }
