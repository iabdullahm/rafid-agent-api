import { findPotentialMatches, POTENTIAL_MATCH_THRESHOLD } from "../../shared/sanctions/nameMatching.js";
import type { SanctionsListEntry } from "../../shared/sanctions/listProviders.js";
import { normalizeCountry, registrationNumbersMatch } from "../normalization.js";
import type { Signal } from "../types.js";
import { checked, runsFor, signal, str, strs, type AnalysisContext } from "./context.js";

/**
 * Sanctions analysis over normalized "sanctions" evidence (list entries returned for the company's
 * name). Name similarity uses the SAME conservative matcher as oman_supplier_check
 * (src/shared/sanctions/nameMatching.ts: normalized cores, ≥ 0.88 bigram similarity, ≥ 60%
 * distinctive-token overlap, short cores must match exactly).
 *
 * Two confidence levels, never "sanctioned":
 *  - possible: the name qualifies as a potential match, but nothing else ties the listing to THIS
 *    company. Reported for manual verification; modest score impact.
 *  - high:     an exact normalized-name match AND a corroborating identifier from the list
 *    (registration number/LEI equal, or a listed country equal to the company's country), with no
 *    contradicting country. Only then is a strong penalty (and score cap) applied.
 * Listed individuals are ignored (company-level screening only). A listed entity whose published
 * countries all differ from the company's country stays at most "possible", with that noted.
 */

export interface SanctionsMatchView {
  listedName: string;
  matchedAlias: string | null;
  list: string;
  reference: string | null;
  sourceUrl: string | null;
  matchScore: number;
  matchType: "exact_normalized_name" | "fuzzy_name";
  confidence: "possible" | "high";
  corroboratingIdentifiers: string[];
  contradictions: string[];
  evidenceId: string;
  reason: string;
}

export interface SanctionsSection {
  status: "no_match_found" | "possible_match" | "high_confidence_match" | "not_checked" | "unavailable" | "partial";
  listsChecked: string[];
  listsUnavailable: string[];
  matches: SanctionsMatchView[];
  highestConfidence: "possible" | "high" | null;
  signals: Signal[];
}

export function analyzeSanctions(ctx: AnalysisContext): SanctionsSection {
  const runs = runsFor(ctx, "sanctions");
  const listsChecked = runs.filter(checked).map(r => r.providerName);
  const listsUnavailable = runs.filter(r => r.status === "unavailable" || r.status === "timeout" || r.status === "rate_limited").map(r => r.providerName);
  const companyCountry = ctx.query.country?.code ?? ctx.resolution.matched?.country ?? null;
  const regNo = ctx.query.registrationNumber ?? ctx.resolution.matched?.registrationNumber ?? null;
  const lei = ctx.query.lei ?? ctx.resolution.matched?.lei ?? null;

  const matches: SanctionsMatchView[] = [];
  for (const e of ctx.sanctions) {
    const subjectType = str(e.metadata.subjectType);
    if (subjectType && /person|individual/.test(subjectType)) continue;
    const entry: SanctionsListEntry = { name: e.title ?? "", aliases: strs(e.metadata.aliases), listName: str(e.metadata.listName) ?? e.sourceName, reference: str(e.metadata.reference), sourceUrl: e.sourceUrl };
    const queried = strs(e.metadata.queriedNames);
    const best = queried.flatMap(name => findPotentialMatches(name, [entry])).sort((a, b) => b.matchScore - a.matchScore)[0];
    if (!best) continue;
    const listCountries = strs(e.metadata.countries).map(c => normalizeCountry(c)?.code).filter((c): c is string => Boolean(c));
    const identifiers = strs(e.metadata.identifiers);
    const corroborating: string[] = [];
    const contradictions: string[] = [];
    if (regNo && identifiers.some(id => registrationNumbersMatch(id, regNo))) corroborating.push("registration_number");
    if (lei && identifiers.some(id => id.toUpperCase() === lei)) corroborating.push("lei");
    if (companyCountry && listCountries.includes(companyCountry)) corroborating.push("country");
    if (companyCountry && listCountries.length > 0 && !listCountries.includes(companyCountry)) contradictions.push(`listed_countries:${listCountries.join(",")}`);
    const high = best.matchType === "exact_normalized_name" && corroborating.length > 0 && contradictions.length === 0;
    matches.push({
      listedName: best.name, matchedAlias: best.matchedAlias, list: best.source, reference: best.reference, sourceUrl: best.sourceUrl,
      matchScore: best.matchScore, matchType: best.matchType, confidence: high ? "high" : "possible",
      corroboratingIdentifiers: corroborating, contradictions, evidenceId: e.id,
      reason: high
        ? `Exact normalized-name match corroborated by ${corroborating.join(" and ")} on the list entry. Treat as a high-confidence potential match and verify at the source list before any transaction.`
        : `${best.reason}${contradictions.length ? " The listed entity is associated with other countries than the company's." : ""} Manual verification recommended; this is not a determination that the company is sanctioned.`
    });
  }
  matches.sort((a, b) => (a.confidence === b.confidence ? 0 : a.confidence === "high" ? -1 : 1) || b.matchScore - a.matchScore || a.listedName.localeCompare(b.listedName));
  const top = matches.slice(0, 10);

  const signals: Signal[] = [];
  const highMatches = top.filter(m => m.confidence === "high");
  const possible = top.filter(m => m.confidence === "possible");
  if (highMatches.length > 0) {
    signals.push(signal("SANCTIONS_HIGH_CONFIDENCE_MATCH", "legalRegulatory", "negative", "critical", `High-confidence potential sanctions-list match: ${highMatches.map(m => `"${m.listedName}" (${m.list})`).join("; ")}. Verify at the source list; do not transact until resolved.`, highMatches.map(m => m.evidenceId), 1, 1));
  }
  if (possible.length > 0) {
    const exactButUncorroborated = possible.some(m => m.matchType === "exact_normalized_name" && m.contradictions.length === 0);
    const strength = exactButUncorroborated ? 0.5 : 0.25;
    signals.push(signal("SANCTIONS_POSSIBLE_NAME_MATCH", "legalRegulatory", "negative", "medium", `Possible sanctions-list name match (not confirmed): ${possible.slice(0, 3).map(m => `"${m.listedName}" (${m.list}, similarity ${m.matchScore.toFixed(2)})`).join("; ")}. Name similarity alone does not establish identity — manual verification recommended.`, possible.map(m => m.evidenceId), strength, 1));
  }
  if (top.length === 0 && listsChecked.length > 0) {
    signals.push(signal("NO_SANCTIONS_MATCH_IN_CHECKED_LISTS", "legalRegulatory", "positive", "info", `No sanctions-list name match above the ${POTENTIAL_MATCH_THRESHOLD} similarity threshold was found in: ${listsChecked.join("; ")}. Lists not checked are not covered.`, [], 0, 1));
  }

  const status: SanctionsSection["status"] = highMatches.length > 0 ? "high_confidence_match"
    : possible.length > 0 ? "possible_match"
    : listsChecked.length > 0 ? (listsUnavailable.length > 0 ? "partial" : "no_match_found")
    : listsUnavailable.length > 0 ? "unavailable" : "not_checked";
  return { status, listsChecked, listsUnavailable, matches: top, highestConfidence: highMatches.length ? "high" : possible.length ? "possible" : null, signals };
}
