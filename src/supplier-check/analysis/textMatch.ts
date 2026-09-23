import { normalizeCompanyName } from "../../business-data/normalizers/companyName.js";
import { bigramSimilarity } from "../../business-data/matching/search.js";
import { domainBrandLabel } from "../normalize.js";

/** Words too generic to prove that a page/result is about a specific company. */
const NON_DISTINCTIVE = new Set([
  "THE", "AND", "CO", "COMPANY", "LLC", "SAOC", "SAOG", "SPC", "WLL", "EST", "LTD", "LIMITED", "GROUP",
  "TRADING", "SERVICES", "SERVICE", "INTERNATIONAL", "ENTERPRISES", "PROJECTS", "HOLDING", "HOLDINGS",
  "OMAN", "MUSCAT", "GENERAL", "TECHNICAL", "SOLUTIONS", "ENGINEERING", "CONTRACTING", "AL", "EL"
]);

/** Distinctive uppercase tokens of a company name (legal forms and generic descriptors removed).
 *  Falls back to all tokens when every token is generic (e.g. "Gulf Services LLC" → ["GULF"]). */
export function distinctiveTokens(name: string): string[] {
  const all = normalizeCompanyName(name).normalized.split(" ").filter(t => t.length >= 2);
  const distinctive = all.filter(t => !NON_DISTINCTIVE.has(t));
  return distinctive.length > 0 ? distinctive : all.filter(t => !["LLC", "SAOC", "SAOG", "SPC", "WLL", "EST"].includes(t));
}

/** True when EVERY distinctive token of at least one of `names` appears as a whole word in
 *  `text` (case-insensitive; Arabic compared after the registry's own folding). */
export function nameAppearsIn(text: string, names: readonly (string | null | undefined)[]): boolean {
  const hay = ` ${normalizeCompanyName(text).normalized} `;
  for (const name of names) {
    if (!name) continue;
    const toks = distinctiveTokens(name);
    if (toks.length === 0) continue;
    if (toks.every(t => hay.includes(` ${t} `))) return true;
  }
  return false;
}

/** Does a domain's brand label plausibly correspond to the company name? (e.g. "alnoortrading.om"
 *  for "Al Noor Trading LLC", "abctrading.com" for "ABC Trading", or an acronym "nts.om" for
 *  "Nizwa Technical Services"). Deterministic, deliberately lenient — it only feeds "consistent",
 *  never an accusation. */
export function domainResemblesName(domain: string, name: string): boolean {
  const brand = domainBrandLabel(domain).toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (brand.length < 2) return false;
  const all = normalizeCompanyName(name).normalized.split(" ").filter(Boolean);
  const joined = all.join("");
  if (!joined) return false;
  if (joined.includes(brand) || brand.includes(joined)) return true;
  const distinct = distinctiveTokens(name);
  if (distinct.some(t => t.length >= 3 && brand.includes(t))) return true;
  const acronym = all.filter(t => !["LLC", "SAOC", "SAOG", "SPC", "WLL", "EST", "AND", "THE"].includes(t)).map(t => t[0]).join("");
  if (acronym.length >= 2 && brand.startsWith(acronym)) return true;
  return bigramSimilarity(brand, joined) >= 0.6;
}

/** Two DIFFERENT registrable domains whose brand labels are nearly identical (e.g.
 *  "alnoortrading.om" vs "alnoor-trading.com", "barka-eng.om" vs "barka-engg.om") — an automated
 *  lookalike-domain indicator commonly seen in supplier impersonation. */
export function isLookalikeDomain(a: string, b: string): boolean {
  const la = domainBrandLabel(a).replace(/[^a-z0-9]/g, ""), lb = domainBrandLabel(b).replace(/[^a-z0-9]/g, "");
  if (!la || !lb) return false;
  if (a === b) return false;
  if (la === lb) return true; // same brand on a different TLD
  return la.length >= 5 && lb.length >= 5 && bigramSimilarity(la, lb) >= 0.8;
}
