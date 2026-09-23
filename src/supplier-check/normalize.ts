import { normalizeCompanyName } from "../business-data/normalizers/companyName.js";
import type { NormalizedPhone, NormalizedSupplierInput } from "./types.js";

/**
 * Deterministic input normalization for oman_supplier_check. Every function is pure (no I/O) so
 * the exact same input always normalizes to the exact same keys — which is what makes the
 * capability idempotent (cache/evidence keys are derived from these values) and auditable.
 *
 * Company-name normalization deliberately REUSES the Oman company registry's own normalizer
 * (src/business-data/normalizers/companyName.ts) rather than introducing a second one, so a
 * supplier name and a registry record are always compared on identical keys.
 */

const ARABIC_CHARS = /[؀-ۿ]/;
const LATIN_CHARS = /[A-Za-z]/;

/** Common Arabic company-name tokens (legal forms and business descriptors) and their usual
 *  English rendering in Omani commercial names. This is a small, conservative glossary — NOT a
 *  transliteration engine: proper nouns (family/brand names) are left untranslated, so an
 *  Arabic-only name still matches the registry mainly through each record's own nameAr field.
 *  Folded forms (see foldArabicForGlossary) are used as keys. */
const ARABIC_NAME_GLOSSARY: ReadonlyArray<readonly [string, string]> = [
  ["شركه", ""], ["مؤسسه", "EST"], ["مجموعه", "GROUP"],
  ["للتجاره", "TRADING"], ["التجاريه", "TRADING"], ["تجاره", "TRADING"], ["التجاره", "TRADING"],
  ["للخدمات", "SERVICES"], ["الخدمات", "SERVICES"], ["خدمات", "SERVICES"],
  ["الهندسيه", "ENGINEERING"], ["للهندسه", "ENGINEERING"], ["هندسه", "ENGINEERING"],
  ["للمقاولات", "CONTRACTING"], ["المقاولات", "CONTRACTING"], ["مقاولات", "CONTRACTING"],
  ["الفنيه", "TECHNICAL"], ["الدوليه", "INTERNATIONAL"], ["العالميه", "INTERNATIONAL"],
  ["للاستثمار", "INVESTMENT"], ["المتحده", "UNITED"], ["الوطنيه", "NATIONAL"], ["الحديثه", "MODERN"],
  ["للتكنولوجيا", "TECHNOLOGY"], ["التقنيه", "TECHNOLOGY"], ["للحلول", "SOLUTIONS"], ["الحلول", "SOLUTIONS"],
  ["للتكييف", "AIR CONDITIONING"], ["التكييف", "AIR CONDITIONING"], ["للصيانه", "MAINTENANCE"], ["الصيانه", "MAINTENANCE"],
  ["للنقل", "TRANSPORT"], ["اللوجستيه", "LOGISTICS"], ["الخليج", "GULF"], ["عمان", "OMAN"],
  ["مسقط", "MUSCAT"], ["صحار", "SOHAR"], ["صلاله", "SALALAH"], ["نزوي", "NIZWA"], ["صور", "SUR"]
];

/** Arabic legal-form abbreviations used in Oman (ش.م.م = LLC, ش.م.ع.م = SAOC, ش.م.ع.ع = SAOG),
 *  matched with optional dots/spaces between letters. */
const ARABIC_LEGAL_FORMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/ش\s*\.?\s*م\s*\.?\s*ع\s*\.?\s*م\s*\.?/g, " SAOC "],
  [/ش\s*\.?\s*م\s*\.?\s*ع\s*\.?\s*ع\s*\.?/g, " SAOG "],
  [/ش\s*\.?\s*م\s*\.?\s*م\s*\.?/g, " LLC "]
];

function foldArabicForGlossary(text: string): string {
  return text
    .replace(/[ً-ْٰـ]/g, "")
    .replace(/[إأآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه");
}

function detectScript(name: string): "ar" | "en" | "mixed" {
  const ar = ARABIC_CHARS.test(name), en = LATIN_CHARS.test(name);
  if (ar && en) return "mixed";
  return ar ? "ar" : "en";
}

/** English-key rendering of an Arabic company name via the glossary above; returns null when no
 *  Arabic token was recognized at all (nothing useful to add as a variant). */
export function arabicNameToEnglishKey(name: string): string | null {
  if (!ARABIC_CHARS.test(name)) return null;
  let working = foldArabicForGlossary(name);
  for (const [pattern, replacement] of ARABIC_LEGAL_FORMS) working = working.replace(pattern, replacement);
  let recognized = false;
  const tokens = working.split(/\s+/).filter(Boolean).map(token => {
    const hit = ARABIC_NAME_GLOSSARY.find(([ar]) => ar === token);
    if (hit) { recognized = true; return hit[1]; }
    if (/^(LLC|SAOC|SAOG)$/.test(token)) { recognized = true; return token; }
    return token;
  });
  if (!recognized) return null;
  const rendered = tokens.filter(Boolean).join(" ");
  return normalizeCompanyName(rendered).normalized || null;
}

/** Matching-key variants for a supplier name — deterministic, deduplicated, normalizedName first. */
export function companyNameVariants(name: string): string[] {
  const primary = normalizeCompanyName(name).normalized;
  const variants = new Set<string>([primary]);
  const ampersand = normalizeCompanyName(name.replace(/&/g, " and ")).normalized;
  variants.add(ampersand);
  // "Company"/"Co"/"The" are kept by the registry normalizer (they can be distinguishing), but a
  // supplier often writes "ABC Trading Co." where the registry has "ABC Trading" — add that form
  // as an extra key, never as a replacement.
  const stripped = primary.split(" ").filter(t => !["THE", "CO", "COMPANY"].includes(t)).join(" ");
  if (stripped) variants.add(stripped);
  const arabicKey = arabicNameToEnglishKey(name);
  if (arabicKey) variants.add(arabicKey);
  return [...variants].filter(Boolean);
}

/** Registration (CR) numbers: whitespace/dashes/slashes removed, uppercased. */
export function normalizeCrNumber(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s\-/.]/g, "");
}

const MULTI_PART_SUFFIXES = new Set([
  "co.om", "com.om", "net.om", "org.om", "gov.om", "edu.om", "med.om", "pro.om", "museum.om",
  "co.uk", "org.uk", "com.sa", "com.qa", "com.kw", "com.bh", "co.ae", "com.eg", "co.in", "com.au"
]);

/** Parses a user-supplied website into a canonical https URL + bare hostname (no "www.").
 *  Accepts a bare domain ("example.om") by assuming https. Returns null for anything that is not
 *  a plausible public http(s) hostname. */
export function normalizeWebsite(raw: string): { url: string; domain: string } | null {
  let candidate = raw.trim();
  if (!candidate) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) candidate = `https://${candidate}`;
  let parsed: URL;
  try { parsed = new URL(candidate); } catch { return null; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") || !/^[a-z0-9.-]+$/.test(host)) return null;
  const domain = host.replace(/^www\./, "");
  const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
  return { url: `${parsed.protocol}//${host}${parsed.port ? `:${parsed.port}` : ""}${path}`, domain };
}

/** The registrable ("organizational") domain used to compare website vs email domains —
 *  "mail.example.co.om" and "example.co.om" compare equal. Handles common multi-part suffixes
 *  (co.om, com.om, ...) via a small fixed list rather than a full public-suffix database. */
export function registrableDomain(domain: string): string {
  const labels = domain.toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  return MULTI_PART_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

/** The label that carries the brand ("alnoortrading" in "alnoortrading.co.om"). */
export function domainBrandLabel(domain: string): string {
  return registrableDomain(domain).split(".")[0] ?? "";
}

/** Free/consumer mailbox providers. Using one is common among small Omani businesses and is NOT a
 *  risk on its own (spec: "A Gmail/Outlook address alone should not automatically make the
 *  supplier high risk") — it only means the email cannot corroborate a corporate domain. */
export const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com",
  "icloud.com", "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "mail.com", "zoho.com",
  "yandex.com", "omantel.net.om", "omanmail.com"
]);

export function normalizeEmail(raw: string): { email: string; domain: string; free: boolean } | null {
  const email = raw.trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  const domain = email.slice(at + 1).replace(/\.$/, "");
  if (!domain.includes(".")) return null;
  return { email, domain, free: FREE_EMAIL_DOMAINS.has(domain) || FREE_EMAIL_DOMAINS.has(registrableDomain(domain)) };
}

/**
 * Oman phone numbers: 8-digit national numbers, landlines starting with 2, mobiles with 7 or 9;
 * country code +968. Accepts "+968 2440 1234", "00968-24401234", "24401234", "968 9123 4567".
 * A number with placeholder characters (e.g. "24XXXXXX") keeps its digits but never yields an
 * e164 value — it is not a real, comparable number.
 */
export function normalizePhone(raw: string): NormalizedPhone {
  const input = raw.trim();
  const hasPlaceholder = /[xX*#?]/.test(input);
  let digits = input.replace(/\D/g, "");
  const explicitInternational = input.startsWith("+") || digits.startsWith("00");
  if (digits.startsWith("00")) digits = digits.slice(2);
  let national = digits;
  let countryIsOman = !explicitInternational;
  if (digits.startsWith("968") && digits.length === 11) { national = digits.slice(3); countryIsOman = true; }
  else if (explicitInternational && !digits.startsWith("968")) countryIsOman = false;
  const validNational = national.length === 8 && /^[279]/.test(national);
  const isOman = countryIsOman && validNational && !hasPlaceholder;
  const lineType = !isOman ? "unknown" : national.startsWith("2") ? "landline" : "mobile";
  return { input, e164: isOman ? `+968${national}` : null, digits: isOman ? national : digits, isOman, lineType };
}

function collapseWhitespace(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed || null;
}

export interface RawSupplierInput {
  companyName: string;
  crNumber?: string;
  website?: string;
  email?: string;
  phone?: string;
  address?: string;
  requiredProductOrService?: string;
}

export function normalizeSupplierInput(input: RawSupplierInput): NormalizedSupplierInput {
  const companyName = collapseWhitespace(input.companyName) ?? "";
  const name = normalizeCompanyName(companyName);
  const website = input.website ? normalizeWebsite(input.website) : null;
  const email = input.email ? normalizeEmail(input.email) : null;
  return {
    companyName,
    normalizedName: name.normalized,
    nameVariants: companyNameVariants(companyName),
    nameScript: detectScript(companyName),
    legalTypeGuess: name.legalTypeGuess,
    crNumber: input.crNumber ? normalizeCrNumber(input.crNumber) || null : null,
    website: website?.url ?? null,
    websiteDomain: website?.domain ?? null,
    email: email?.email ?? null,
    emailDomain: email?.domain ?? null,
    freeEmailProvider: email?.free ?? false,
    phone: input.phone ? normalizePhone(input.phone) : null,
    address: collapseWhitespace(input.address),
    requiredProductOrService: collapseWhitespace(input.requiredProductOrService)
  };
}

/** Stable identity key for caching/evidence — two requests that normalize to the same supplier
 *  identity (e.g. "ABC Trading L.L.C." vs "abc trading llc") share one key. */
export function supplierIdentityKey(n: Pick<NormalizedSupplierInput, "normalizedName" | "crNumber">): string {
  return `${n.normalizedName}|${n.crNumber ?? ""}`;
}

/** Token set for fuzzy comparisons (uppercase alphanumerics/Arabic, length >= 2). */
export function tokens(text: string): string[] {
  return text.toUpperCase().split(/[^A-Z0-9؀-ۿ]+/).filter(t => t.length >= 2);
}
