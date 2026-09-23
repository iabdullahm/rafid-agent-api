import { normalizeCompanyName } from "../business-data/normalizers/companyName.js";
import { bigramSimilarity } from "../business-data/matching/search.js";
import type { SanctionsListEntry } from "./providers/sanctionsProviders.js";

/**
 * Conservative fuzzy company-name matching for sanctions screening.
 *
 * Rules (documented, deterministic, no model):
 *  1. Both names go through the registry's normalizer, then generic corporate words (LTD, INC,
 *     COMPANY, THE, ...) are removed so "Acme Trading Co" and "ACME TRADING LTD" compare on their
 *     distinctive core.
 *  2. score = max(bigram Dice on the cores, bigram Dice on the alphabetically sorted tokens) —
 *     so word order alone ("Trading Acme" vs "Acme Trading") doesn't hide a match.
 *  3. A candidate is a POTENTIAL match only if score >= POTENTIAL_MATCH_THRESHOLD (0.88) AND at
 *     least 60% of distinctive tokens overlap AND the core is at least 5 characters long (short
 *     cores like "ABC" collide with too many unrelated names; they must match exactly).
 *  4. Even an exact normalized-name match is reported as `potential_match` with
 *     matchType "exact_normalized_name" — never as "sanctioned". Name equality is not identity:
 *     confirming a listing requires comparing addresses, registration numbers and other
 *     identifiers at the source list, which a human must do.
 */

export const POTENTIAL_MATCH_THRESHOLD = 0.88;
const MIN_TOKEN_OVERLAP = 0.6;
const MIN_CORE_LENGTH = 5;

const GENERIC_WORDS = new Set([
  "THE", "AND", "CO", "COMPANY", "LTD", "LIMITED", "INC", "CORP", "CORPORATION", "PLC", "GMBH", "SA", "SAL",
  "FZE", "FZCO", "FZ", "LLC", "SAOC", "SAOG", "SPC", "WLL", "EST", "OF"
]);

function core(name: string): string[] {
  return normalizeCompanyName(name.replace(/&/g, " and ")).normalized
    .split(" ").filter(t => t && !GENERIC_WORDS.has(t));
}

export function nameMatchScore(a: string, b: string): { score: number; tokenOverlap: number; exact: boolean; coreLength: number } {
  const ta = core(a), tb = core(b);
  const ca = ta.join(" "), cb = tb.join(" ");
  if (!ca || !cb) return { score: 0, tokenOverlap: 0, exact: false, coreLength: 0 };
  const exact = ca === cb;
  const sortedA = [...ta].sort().join(" "), sortedB = [...tb].sort().join(" ");
  const score = exact ? 1 : Math.max(bigramSimilarity(ca, cb), bigramSimilarity(sortedA, sortedB));
  const setA = new Set(ta), setB = new Set(tb);
  const shared = [...setA].filter(t => setB.has(t)).length;
  const tokenOverlap = shared / Math.max(setA.size, setB.size);
  return { score: Math.round(score * 100) / 100, tokenOverlap, exact, coreLength: Math.min(ca.length, cb.length) };
}

export interface SanctionsMatch {
  name: string;
  matchedAlias: string | null;
  source: string;
  reference: string | null;
  sourceUrl: string | null;
  matchScore: number;
  matchType: "exact_normalized_name" | "fuzzy_name";
  reason: string;
}

export function findPotentialMatches(companyName: string, entries: readonly SanctionsListEntry[]): SanctionsMatch[] {
  const matches: SanctionsMatch[] = [];
  for (const entry of entries) {
    let best: { name: string; alias: string | null; r: ReturnType<typeof nameMatchScore> } | null = null;
    for (const [candidate, alias] of [[entry.name, null] as const, ...entry.aliases.map(a => [a, a] as const)]) {
      const r = nameMatchScore(companyName, candidate);
      if (!best || r.score > best.r.score) best = { name: candidate, alias, r };
    }
    if (!best) continue;
    const { r } = best;
    const qualifies = r.exact
      ? true
      : r.score >= POTENTIAL_MATCH_THRESHOLD && r.tokenOverlap >= MIN_TOKEN_OVERLAP && r.coreLength >= MIN_CORE_LENGTH;
    if (!qualifies) continue;
    matches.push({
      name: entry.name, matchedAlias: best.alias, source: entry.listName, reference: entry.reference, sourceUrl: entry.sourceUrl,
      matchScore: r.score,
      matchType: r.exact ? "exact_normalized_name" : "fuzzy_name",
      reason: r.exact
        ? `The supplier's normalized name is identical to ${best.alias ? `an alias ("${best.alias}") of` : "the name of"} a listed entity. Name equality alone does not establish that this is the same entity — verify identifiers at the source list.`
        : `Automated fuzzy name similarity of ${r.score.toFixed(2)} (threshold ${POTENTIAL_MATCH_THRESHOLD}) with ${Math.round(r.tokenOverlap * 100)}% distinctive-token overlap. This is a potential match only, not a confirmed listing.`
    });
  }
  // Deduplicate the same listed name reported by two lists; keep the highest score.
  const byKey = new Map<string, SanctionsMatch>();
  for (const m of matches) {
    const key = `${m.source}|${m.name.toUpperCase()}`;
    const existing = byKey.get(key);
    if (!existing || m.matchScore > existing.matchScore) byKey.set(key, m);
  }
  return [...byKey.values()].sort((a, b) => b.matchScore - a.matchScore).slice(0, 10);
}
