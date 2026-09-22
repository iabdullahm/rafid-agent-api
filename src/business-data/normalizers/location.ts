/**
 * Oman governorate normalization for the business-intelligence domain. Unlike the property
 * domain (src/domain/oman/locations.ts), which is scoped to Muscat governorate's neighborhoods
 * only, business records can legitimately come from any of Oman's governorates — so this
 * registry covers all eleven, but (deliberately, matching the property domain's own "do not
 * over-generalize" stance) does not attempt an exhaustive wilayat registry: wilayat is
 * normalized for spacing/case only, not resolved against a canonical list, since Oman has over
 * sixty wilayats and misresolving one would misrepresent a company's actual registered location.
 */

export interface OmanGovernorateDefinition {
  canonical: string;
  aliases: readonly string[];
}

export const OMAN_GOVERNORATES: readonly OmanGovernorateDefinition[] = [
  { canonical: "Muscat", aliases: ["muscat", "masqat", "مسقط", "محافظة مسقط"] },
  { canonical: "Dhofar", aliases: ["dhofar", "zufar", "salalah", "ظفار", "محافظة ظفار"] },
  { canonical: "Musandam", aliases: ["musandam", "musandum", "مسندم", "محافظة مسندم"] },
  { canonical: "Al Buraimi", aliases: ["al buraimi", "buraimi", "البريمي", "محافظة البريمي"] },
  { canonical: "Ad Dakhiliyah", aliases: ["ad dakhiliyah", "al dakhiliyah", "dakhiliyah", "nizwa", "الداخلية", "محافظة الداخلية"] },
  { canonical: "Al Batinah North", aliases: ["al batinah north", "north al batinah", "batinah north", "sohar", "شمال الباطنة", "محافظة شمال الباطنة"] },
  { canonical: "Al Batinah South", aliases: ["al batinah south", "south al batinah", "batinah south", "rustaq", "جنوب الباطنة", "محافظة جنوب الباطنة"] },
  { canonical: "Ash Sharqiyah North", aliases: ["ash sharqiyah north", "north ash sharqiyah", "sharqiyah north", "ibra", "شمال الشرقية", "محافظة شمال الشرقية"] },
  { canonical: "Ash Sharqiyah South", aliases: ["ash sharqiyah south", "south ash sharqiyah", "sharqiyah south", "sur", "جنوب الشرقية", "محافظة جنوب الشرقية"] },
  { canonical: "Adh Dhahirah", aliases: ["adh dhahirah", "al dhahirah", "dhahirah", "ibri", "الظاهرة", "محافظة الظاهرة"] },
  { canonical: "Al Wusta", aliases: ["al wusta", "wusta", "الوسطى", "محافظة الوسطى"] }
] as const;

export function normalizeText(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Resolves free-text governorate input (English or Arabic, exact canonical name or a known
 *  alias) to its canonical registry name, or null when unrecognized — an unrecognized governorate
 *  is reported as-is (trimmed) rather than guessed at, exactly like the property domain's
 *  resolveAreaName. */
export function resolveGovernorateName(input: string): string | null {
  const needle = normalizeText(input);
  for (const g of OMAN_GOVERNORATES) {
    if (normalizeText(g.canonical) === needle) return g.canonical;
    if (g.aliases.some(a => normalizeText(a) === needle)) return g.canonical;
  }
  return null;
}

export function normalizeGovernorate(input: string): { value: string; recognized: boolean } {
  const resolved = resolveGovernorateName(input);
  return resolved ? { value: resolved, recognized: true } : { value: input.trim(), recognized: false };
}

/** Wilayat is normalized for whitespace/case only — see this file's doc comment for why no
 *  canonical per-governorate wilayat list is maintained here. */
export function normalizeWilayatText(input: string): string {
  return input.trim().replace(/\s+/g, " ");
}
