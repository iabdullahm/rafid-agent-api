/**
 * Section 3: deterministic Oman company name normalization. No LLM, no fuzzy guessing at this
 * stage — a fixed set of regex/token rules, so the exact same input always normalizes to the
 * exact same output and the transformation is fully auditable.
 *
 * Two outputs are always kept (Section 3's explicit requirement):
 *  - `original`: the input, trimmed only — never mutated further, always shown back to the agent.
 *  - `normalized`: uppercased, punctuation-collapsed, with recognized legal-form suffixes
 *    (LLC/SAOC/SAOG/SPC/WLL/EST) canonicalized and then stripped from the END only — used purely
 *    as a matching key by src/business-data/matching/search.ts, never displayed as "the" company
 *    name.
 *
 * Deliberately conservative: only the trailing legal-form token is stripped, never a token in the
 * middle of the name, and at least one token is always kept — "do not aggressively merge unrelated
 * companies" (Section 3). Plain business-descriptor words the task also calls out (Trading,
 * Services, International, Enterprises, Projects) are recognized and case/punctuation-normalized
 * like everything else, but deliberately NOT stripped from the matching key: they carry real
 * distinguishing business content (a Trading company and a Services company sharing the same core
 * name are not the same entity), so stripping them risked exactly the aggressive-merging failure
 * mode Section 3 warns against — "Al Noor Trading LLC" and "Al Noor Services LLC" must normalize
 * to different keys, and now do. Only truly identical core names (down to the legal form) collide,
 * and even then, registration-number matching (see matching/search.ts) is what actually confirms
 * identity — normalizedName is one signal among several, never the sole determinant.
 */

/** Legal-form patterns matched with flexible punctuation/spacing (periods and internal spaces
 *  optional) so "LLC", "L.L.C.", "L. L. C." and "llc" all canonicalize the same way, applied
 *  BEFORE punctuation stripping so the pattern still sees the original periods/spacing. */
const LEGAL_FORM_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bL\.?\s*L\.?\s*C\.?\b/gi, "LLC"],
  [/\bS\.?\s*A\.?\s*O\.?\s*C\.?\b/gi, "SAOC"],
  [/\bS\.?\s*A\.?\s*O\.?\s*G\.?\b/gi, "SAOG"],
  [/\bS\.?\s*P\.?\s*C\.?\b/gi, "SPC"],
  [/\bW\.?\s*L\.?\s*L\.?\b/gi, "WLL"],
  [/\bEstablishment\b/gi, "EST"],
  [/\bEst\.?\b/gi, "EST"]
];

/** Trailing legal-form tokens stripped from `normalized` after canonicalization above. Business-
 *  descriptor words (Trading, Services, International, Enterprises, Projects, Group, Holding(s),
 *  Co/Company) are deliberately NOT in this set — see this module's doc comment for why stripping
 *  them risked merging genuinely different companies. Never stripped from the middle of a name,
 *  only a trailing run, and never down to zero tokens. */
const GENERIC_TRAILING_TOKENS = new Set(["LLC", "SAOC", "SAOG", "SPC", "WLL", "EST"]);

/** Light, safe Arabic normalization: strips tashkeel (diacritics) and tatweel, and folds the
 *  common alef/yeh/ta-marbuta variants to one canonical form each — standard, conservative Arabic
 *  text-normalization steps, not a full morphological analyzer. Latin text passes through
 *  untouched (none of these code points appear in it). */
function foldArabic(text: string): string {
  return text
    .replace(/[ً-ْٰـ]/g, "") // tashkeel + tatweel
    .replace(/[إأآا]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه");
}

export interface NormalizedCompanyName {
  /** Trimmed, otherwise-unmodified input — the name to actually display. */
  original: string;
  /** Matching key: uppercased, punctuation-collapsed, trailing generic tokens stripped. */
  normalized: string;
  /** The single legal-form token detected in the name (its canonical spelling), or null if none
   *  was recognized — a useful hint for `legalType` when a source didn't supply one explicitly. */
  legalTypeGuess: string | null;
}

export function normalizeCompanyName(input: string): NormalizedCompanyName {
  const original = input.trim().replace(/\s+/g, " ");
  let working = foldArabic(original);

  let legalTypeGuess: string | null = null;
  for (const [pattern, canonical] of LEGAL_FORM_PATTERNS) {
    if (pattern.test(working)) {
      legalTypeGuess = legalTypeGuess ?? canonical;
      working = working.replace(pattern, canonical);
    }
    pattern.lastIndex = 0;
  }

  // Strip remaining punctuation (periods, commas, hyphens, parentheses) to spaces, collapse
  // whitespace, uppercase. Arabic letters and digits are left untouched by this character class.
  working = working
    .replace(/[.,\-()/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();

  const tokens = working.split(" ").filter(Boolean);
  let end = tokens.length;
  while (end > 1 && GENERIC_TRAILING_TOKENS.has(tokens[end - 1]!)) end--;
  const normalized = tokens.slice(0, end).join(" ") || tokens.join(" ");

  return { original, normalized, legalTypeGuess };
}
