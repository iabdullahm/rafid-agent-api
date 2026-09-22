/**
 * Oman location normalization — Section 5.
 *
 * Scope (Section 14): Muscat governorate only for this MVP. A small, explicit registry of
 * known Muscat areas and their common English/Arabic spellings is matched exactly against the
 * caller's input. This deliberately does NOT do fuzzy/phonetic matching or attempt to resolve
 * ambiguous or unlisted place names — an unrecognized area is reported as "unmatched" rather
 * than guessed at (see the task's explicit "do not over-generalize ambiguous place names").
 *
 * Wilayat assignments below are a reasonable-effort administrative approximation for display
 * purposes (most of these neighborhoods sit within Muscat or Bawshar wilayat), not authoritative
 * cadastral/administrative-boundary data — do not treat `wilayat` as a legal fact.
 */

export interface OmanAreaDefinition {
  /** Canonical display name returned in `normalizedLocation.area`. */
  canonical: string;
  wilayat: string;
  /** Lowercased/trimmed English and verbatim Arabic spellings that resolve to this area.
   *  The canonical name itself does not need to be repeated here. */
  aliases: readonly string[];
}

export const MUSCAT_GOVERNORATE = "Muscat";
const GOVERNORATE_ALIASES = new Set(["muscat", "muscat governorate", "مسقط", "محافظة مسقط"]);

/** Muscat governorate's wilayats, for optional normalization of the `wilayat` input field.
 *  Not used to select comparables (area is the unit comparables are matched on) — purely
 *  informational / for surfacing a wilayat mismatch against the area registry below. */
const WILAYAT_ALIASES: Record<string, readonly string[]> = {
  "Muscat": ["muscat", "مسقط"],
  "Muttrah": ["muttrah", "mutrah", "مطرح"],
  "Bawshar": ["bawshar", "bausher", "بوشر"],
  "Seeb": ["seeb", "a'seeb", "as seeb", "السيب"],
  "Al Amerat": ["al amerat", "amerat", "العامرات"],
  "Qurayyat": ["qurayyat", "quriyat", "قريات"]
};

/** The Muscat areas this MVP's curated dataset (and therefore this capability) actually has
 *  data for — see domain/oman/fixtures.ts. Documented explicitly (Section 14): do not claim
 *  coverage for an area not listed here. */
export const MUSCAT_AREAS: readonly OmanAreaDefinition[] = [
  { canonical: "Al Mouj", wilayat: "Muscat", aliases: ["al mouj", "almouj", "al-mouj", "the wave", "the wave muscat", "الموج", "الموج مسقط"] },
  { canonical: "Muscat Hills", wilayat: "Bawshar", aliases: ["muscat hills", "muscathills", "muscat hill", "مسقط هيلز"] },
  { canonical: "Qurum", wilayat: "Muscat", aliases: ["qurum", "qurm", "qurum heights", "القرم"] },
  { canonical: "Bausher", wilayat: "Bawshar", aliases: ["bausher", "bawshar", "بوشر"] },
  { canonical: "Azaiba", wilayat: "Bawshar", aliases: ["azaiba", "al azaiba", "azeiba", "العذيبة"] },
  { canonical: "Al Khuwair", wilayat: "Bawshar", aliases: ["al khuwair", "khuwair", "al-khuwair", "الخوير"] },
  { canonical: "Madinat Al Irfan", wilayat: "Seeb", aliases: ["madinat al irfan", "al irfan", "madinat irfan", "مدينة العرفان", "العرفان"] },
  { canonical: "Ghubrah", wilayat: "Bawshar", aliases: ["ghubrah", "al ghubrah", "ghubra", "al ghubra", "الغبرة"] }
] as const;

export const SUPPORTED_MUSCAT_AREAS: readonly string[] = MUSCAT_AREAS.map(a => a.canonical);

/** Lowercased/trimmed/whitespace-collapsed form of a place name. Exported (not just used
 *  internally) because the production database layer needs the exact same normalization to
 *  compute `normalized_area` for indexing/matching (src/db/marketSchema.ts, marketStore.ts) — one
 *  normalization rule, reused, rather than a second slightly-different implementation. */
export function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function findArea(input: string): { area: OmanAreaDefinition; matchType: "exact" | "alias" } | null {
  const needle = normalize(input);
  for (const area of MUSCAT_AREAS) {
    if (normalize(area.canonical) === needle) return { area, matchType: "exact" };
    if (area.aliases.some(alias => normalize(alias) === needle)) return { area, matchType: "alias" };
  }
  return null;
}

function normalizeWilayat(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const needle = normalize(input);
  for (const [canonical, aliases] of Object.entries(WILAYAT_ALIASES)) {
    if (normalize(canonical) === needle || aliases.some(a => normalize(a) === needle)) return canonical;
  }
  return input.trim();
}

export interface NormalizedLocation {
  governorate: string;
  governorateSupported: boolean;
  wilayat: string;
  area: string;
  inputArea: string;
  matchType: "exact" | "alias" | "unmatched";
  /** True only when both the governorate is supported (Muscat, for this MVP) and the area was
   *  recognized — i.e. this capability actually has comparable data to look up. */
  supported: boolean;
  /** True when the caller supplied a `wilayat` that conflicts with the matched area's own
   *  registry wilayat — surfaced as a riskFlag/assumption by the calling service, not silently
   *  overridden without comment. */
  wilayatMismatch: boolean;
}

/** Resolves free-text area input (English or Arabic, exact canonical name or a known alias) to
 *  its canonical registry name, or null when unrecognized. Used by normalizeLocation() below and
 *  by the market-data import pipeline (importPipeline.ts), so an imported record and an analysis
 *  request for "the wave" / "الموج" / "Al Mouj" all resolve to the exact same canonical area. */
export function resolveAreaName(input: string): string | null {
  return findArea(input)?.area.canonical ?? null;
}

export function normalizeLocation(input: { governorate: string; wilayat?: string; area: string }): NormalizedLocation {
  const governorateSupported = GOVERNORATE_ALIASES.has(normalize(input.governorate));
  const governorate = governorateSupported ? MUSCAT_GOVERNORATE : input.governorate.trim();
  const found = findArea(input.area);
  const suppliedWilayat = normalizeWilayat(input.wilayat);
  if (!found) {
    return {
      governorate, governorateSupported,
      wilayat: suppliedWilayat ?? "",
      area: input.area.trim(), inputArea: input.area,
      matchType: "unmatched", supported: false, wilayatMismatch: false
    };
  }
  const wilayatMismatch = suppliedWilayat !== undefined && suppliedWilayat !== found.area.wilayat;
  return {
    governorate, governorateSupported,
    wilayat: found.area.wilayat,
    area: found.area.canonical, inputArea: input.area,
    matchType: found.matchType,
    supported: governorateSupported,
    wilayatMismatch
  };
}
