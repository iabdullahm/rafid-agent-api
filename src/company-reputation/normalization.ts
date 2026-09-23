import { bigramSimilarity } from "../business-data/matching/search.js";

/**
 * Deterministic, dependency-free normalization for company_reputation_check. Pure functions only:
 * the same input always yields the same keys, which is what makes evidence-cache keys, dedup and
 * scoring reproducible. GLOBAL by design — nothing here assumes Oman.
 */

// ---------------------------------------------------------------------------------------------
// Countries (ISO 3166-1 alpha-2)
// ---------------------------------------------------------------------------------------------

const ISO2_CODES = (
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
  "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
  "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
  "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT " +
  "MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW " +
  "SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG " +
  "UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW"
).split(" ");
const ISO2_SET = new Set(ISO2_CODES);

/** Common aliases, abbreviations and ISO alpha-3 codes that Intl display names don't cover. */
const COUNTRY_ALIASES: Readonly<Record<string, string>> = {
  "UK": "GB", "U K": "GB", "GREAT BRITAIN": "GB", "BRITAIN": "GB", "ENGLAND": "GB", "SCOTLAND": "GB", "WALES": "GB", "NORTHERN IRELAND": "GB", "GBR": "GB",
  "USA": "US", "U S A": "US", "U S": "US", "UNITED STATES OF AMERICA": "US", "AMERICA": "US",
  "UAE": "AE", "U A E": "AE", "ARE": "AE", "EMIRATES": "AE",
  "KSA": "SA", "SAU": "SA", "SAUDI": "SA", "OMN": "OM", "SULTANATE OF OMAN": "OM", "QAT": "QA", "KWT": "KW", "BHR": "BH",
  "DEU": "DE", "FRA": "FR", "ITA": "IT", "ESP": "ES", "NLD": "NL", "HOLLAND": "NL", "THE NETHERLANDS": "NL", "BEL": "BE", "CHE": "CH", "SWISS": "CH",
  "AUT": "AT", "SWE": "SE", "NOR": "NO", "DNK": "DK", "FIN": "FI", "IRL": "IE", "PRT": "PT", "POL": "PL", "GRC": "GR", "TUR": "TR", "TURKIYE": "TR",
  "RUS": "RU", "RUSSIAN FEDERATION": "RU", "UKR": "UA", "CHN": "CN", "PRC": "CN", "PEOPLES REPUBLIC OF CHINA": "CN", "JPN": "JP", "KOR": "KR", "SOUTH KOREA": "KR",
  "REPUBLIC OF KOREA": "KR", "NORTH KOREA": "KP", "IND": "IN", "PAK": "PK", "BGD": "BD", "SGP": "SG", "MYS": "MY", "IDN": "ID", "THA": "TH", "VNM": "VN", "VIET NAM": "VN",
  "PHL": "PH", "AUS": "AU", "NZL": "NZ", "CAN": "CA", "MEX": "MX", "BRA": "BR", "ARG": "AR", "CHL": "CL", "COL": "CO", "PER": "PE", "ZAF": "ZA", "NGA": "NG",
  "KEN": "KE", "EGY": "EG", "MAR": "MA", "ISR": "IL", "JOR": "JO", "LBN": "LB", "IRN": "IR", "IRQ": "IQ", "HKG": "HK", "TWN": "TW", "IVORY COAST": "CI",
  "KOREA REPUBLIC OF": "KR", "KOREA": "KR", "IRAN ISLAMIC REPUBLIC OF": "IR", "RUSSIA": "RU", "VIETNAM": "VN", "CZECH REPUBLIC": "CZ", "CZECHIA": "CZ", "BURMA": "MM", "SYRIA": "SY", "LAOS": "LA", "MOLDOVA": "MD", "VATICAN": "VA", "PALESTINE": "PS", "TANZANIA": "TZ", "BOLIVIA": "BO", "VENEZUELA": "VE"
};

function foldText(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[’'`´]/g, " ").toUpperCase().replace(/[^A-Z0-9]+/g, " ").trim();
}

let countryIndex: Map<string, string> | null = null;
function buildCountryIndex(): Map<string, string> {
  const index = new Map<string, string>();
  let display: Intl.DisplayNames | null = null;
  try { display = new Intl.DisplayNames(["en"], { type: "region" }); } catch { display = null; }
  for (const code of ISO2_CODES) {
    const name = display?.of(code);
    if (name && name !== code) {
      index.set(foldText(name), code);
      // "Korea, Republic of"-style and "(the)" variants
      index.set(foldText(name.replace(/\(.*?\)/g, "")), code);
      if (/^the /i.test(name)) index.set(foldText(name.slice(4)), code);
    }
  }
  for (const [alias, code] of Object.entries(COUNTRY_ALIASES)) index.set(foldText(alias), code);
  return index;
}

export interface NormalizedCountry { code: string; name: string }

/** ISO alpha-2 code, ISO alpha-3 (common), English name or common alias → { code, name }. */
export function normalizeCountry(raw: string | null | undefined): NormalizedCountry | null {
  if (!raw) return null;
  const folded = foldText(raw);
  if (!folded) return null;
  countryIndex ??= buildCountryIndex();
  const code = folded.length === 2 && ISO2_SET.has(folded) ? folded : countryIndex.get(folded) ?? null;
  if (!code) return null;
  return { code, name: countryName(code) };
}

const DEMONYMS: Readonly<Record<string, string>> = {
  "BRITISH": "GB", "AMERICAN": "US", "OMANI": "OM", "EMIRATI": "AE", "SAUDI": "SA", "QATARI": "QA", "KUWAITI": "KW", "BAHRAINI": "BH",
  "GERMAN": "DE", "FRENCH": "FR", "ITALIAN": "IT", "SPANISH": "ES", "DUTCH": "NL", "SWISS": "CH", "IRISH": "IE", "CANADIAN": "CA",
  "AUSTRALIAN": "AU", "INDIAN": "IN", "PAKISTANI": "PK", "CHINESE": "CN", "JAPANESE": "JP", "KOREAN": "KR", "SINGAPOREAN": "SG",
  "RUSSIAN": "RU", "TURKISH": "TR", "EGYPTIAN": "EG", "NIGERIAN": "NG", "SOUTH AFRICAN": "ZA", "BRAZILIAN": "BR", "MEXICAN": "MX"
};

/** ISO-2 codes of countries explicitly named in free text (names ≥ 4 chars, common aliases like
 *  UK/USA/UAE, and demonyms). Used only to LOWER an item's relevance when it clearly concerns a
 *  different jurisdiction — never to raise it. */
export function countriesMentioned(text: string): string[] {
  countryIndex ??= buildCountryIndex();
  const hay = ` ${foldText(text)} `;
  const found = new Set<string>();
  for (const [name, code] of countryIndex) {
    if ((name.length >= 4 || name === "UK" || name === "USA" || name === "UAE" || name === "KSA") && hay.includes(` ${name} `)) found.add(code);
  }
  for (const [demonym, code] of Object.entries(DEMONYMS)) if (hay.includes(` ${demonym} `)) found.add(code);
  return [...found].sort();
}

/** Legal forms written right after the company's core name in free text ("ABC HOLDINGS LTD said…"). */
export function legalFormsNearName(text: string, companyName: string): string[] {
  const key = normalizeCompanyName(companyName).key;
  if (!key) return [];
  const hay = foldText(text);
  const forms = new Set<string>();
  let idx = hay.indexOf(key);
  while (idx >= 0) {
    let after = ` ${hay.slice(idx + key.length).trim().split(" ").slice(0, 4).join(" ")} `;
    for (const [pattern, canonical] of LEGAL_FORMS) { after = after.replace(pattern, canonical); pattern.lastIndex = 0; }
    for (const token of after.trim().split(" ")) {
      if (!LEGAL_FORM_TOKENS.has(token) || token === "CO") break;
      forms.add(LEGAL_FORM_FAMILY[token] ?? token);
    }
    idx = hay.indexOf(key, idx + key.length);
  }
  return [...forms];
}

export function legalFormFamilies(companyName: string): string[] {
  return [...new Set(normalizeCompanyName(companyName).legalForms.map(f => LEGAL_FORM_FAMILY[f] ?? f))];
}

export function countryName(code: string): string {
  try { return new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? code; } catch { return code; }
}

// ---------------------------------------------------------------------------------------------
// Company names
// ---------------------------------------------------------------------------------------------

/** Legal-form tokens (post-folding) recognized globally, canonical form → family. Families let us
 *  detect a genuine legal-form conflict (an LLC vs a PLC) without treating LTD/LIMITED as different. */
const LEGAL_FORMS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bL L C\b|\bLLC\b/g, "LLC"], [/\bL L P\b|\bLLP\b/g, "LLP"], [/\bP L C\b|\bPLC\b/g, "PLC"],
  [/\bLIMITED\b|\bLTD\b/g, "LTD"], [/\bINCORPORATED\b|\bINC\b/g, "INC"], [/\bCORPORATION\b|\bCORP\b/g, "CORP"],
  [/\bGMBH\b/g, "GMBH"], [/\bAKTIENGESELLSCHAFT\b|\bAG\b/g, "AG"], [/\bS A S\b|\bSAS\b/g, "SAS"], [/\bSARL\b/g, "SARL"],
  [/\bS P A\b|\bSPA\b/g, "SPA"], [/\bS R L\b|\bSRL\b/g, "SRL"], [/\bB V\b|\bBV\b/g, "BV"], [/\bN V\b|\bNV\b/g, "NV"],
  [/\bPTY\b/g, "PTY"], [/\bPTE\b/g, "PTE"], [/\bPVT\b|\bPRIVATE\b/g, "PVT"], [/\bK K\b|\bKK\b/g, "KK"], [/\bPJSC\b/g, "PJSC"], [/\bOJSC\b|\bJSC\b/g, "JSC"],
  [/\bS A O C\b|\bSAOC\b/g, "SAOC"], [/\bS A O G\b|\bSAOG\b/g, "SAOG"], [/\bS P C\b|\bSPC\b/g, "SPC"], [/\bW L L\b|\bWLL\b/g, "WLL"],
  [/\bFZCO\b/g, "FZCO"], [/\bFZE\b/g, "FZE"], [/\bFZ\b/g, "FZ"], [/\bS A\b|\bSA\b/g, "SA"], [/\bAB\b/g, "AB"], [/\bOYJ\b|\bOY\b/g, "OY"],
  [/\bSE\b/g, "SE"], [/\bLP\b/g, "LP"], [/\bCOMPANY\b|\bCO\b/g, "CO"], [/\bESTABLISHMENT\b|\bEST\b/g, "EST"]
];
const LEGAL_FORM_TOKENS = new Set(LEGAL_FORMS.map(([, c]) => c));
/** Families: forms that mean the same kind of entity (LTD ~ LIMITED ~ PLC-private variants are NOT merged). */
const LEGAL_FORM_FAMILY: Readonly<Record<string, string>> = {
  LLC: "llc", LTD: "ltd", PLC: "plc", INC: "corp", CORP: "corp", GMBH: "gmbh", AG: "ag", SAS: "sas", SARL: "sarl", SPA: "spa", SRL: "srl",
  BV: "bv", NV: "nv", PTY: "ltd", PTE: "ltd", PVT: "ltd", KK: "kk", PJSC: "jsc", JSC: "jsc", SAOC: "saoc", SAOG: "saog", SPC: "spc", WLL: "wll",
  FZCO: "fz", FZE: "fz", FZ: "fz", SA: "sa", AB: "ab", OY: "oy", SE: "se", LP: "lp", LLP: "llp", EST: "est"
};
/** Words too generic to identify a company on their own (removed from the matching CORE only). */
const GENERIC_WORDS = new Set(["THE", "AND", "OF", "GROUP", "HOLDING", "HOLDINGS", "INTERNATIONAL", "GLOBAL", "CO", "COMPANY"]);

export interface NormalizedCompanyName {
  original: string;
  /** Full matching key: folded, punctuation-free, legal forms canonicalized and trailing forms stripped. */
  key: string;
  /** Distinctive tokens (generic words and legal forms removed). */
  coreTokens: string[];
  /** Canonical legal forms found (e.g. ["LTD"]). */
  legalForms: string[];
}

export function normalizeCompanyName(raw: string): NormalizedCompanyName {
  const original = raw.trim().replace(/\s+/g, " ");
  let working = foldText(original.replace(/&/g, " AND ").replace(/\+/g, " PLUS "));
  for (const [pattern, canonical] of LEGAL_FORMS) {
    working = working.replace(pattern, canonical);
    pattern.lastIndex = 0;
  }
  const tokens = working.split(" ").filter(Boolean);
  let end = tokens.length;
  while (end > 1 && LEGAL_FORM_TOKENS.has(tokens[end - 1]!)) end--;
  // Only the TRAILING run is treated as legal form(s); a form-like token inside a name ("AB Foods")
  // stays part of the name.
  const legalForms = [...new Set(tokens.slice(end))].filter(f => f !== "CO");
  const keyTokens = tokens.slice(0, end);
  const coreTokens = keyTokens.filter(t => !GENERIC_WORDS.has(t));
  return { original, key: keyTokens.join(" "), coreTokens: coreTokens.length ? coreTokens : keyTokens, legalForms };
}

/** Deterministic 0-1 company-name similarity on distinctive cores (order-insensitive). */
export function companyNameSimilarity(a: string, b: string): number {
  const na = normalizeCompanyName(a), nb = normalizeCompanyName(b);
  const ca = na.coreTokens.join(" "), cb = nb.coreTokens.join(" ");
  if (!ca || !cb) return 0;
  if (ca === cb) return 1;
  const sa = [...na.coreTokens].sort().join(" "), sb = [...nb.coreTokens].sort().join(" ");
  if (sa === sb) return 0.97;
  const dice = Math.max(bigramSimilarity(ca, cb), bigramSimilarity(sa, sb));
  const setA = new Set(na.coreTokens), setB = new Set(nb.coreTokens);
  const overlap = [...setA].filter(t => setB.has(t)).length / Math.max(setA.size, setB.size);
  return Math.round(Math.min(dice, 0.5 + overlap / 2) * 100) / 100;
}

/** True when both names carry explicit legal forms from DIFFERENT families (LLC vs PLC). A missing
 *  legal form is never a conflict. */
export function legalFormConflict(a: string, b: string): boolean {
  const fa = new Set(normalizeCompanyName(a).legalForms.map(f => LEGAL_FORM_FAMILY[f] ?? f));
  const fb = new Set(normalizeCompanyName(b).legalForms.map(f => LEGAL_FORM_FAMILY[f] ?? f));
  if (fa.size === 0 || fb.size === 0) return false;
  return ![...fa].some(f => fb.has(f));
}

/** Does free text mention the company? Returns the strength of the mention (0-1). A mention of all
 *  distinctive core tokens as a phrase = 1; all tokens but scattered = 0.6; otherwise 0. Short
 *  single-token cores (≤ 3 chars) require an exact phrase with a legal form/generic word nearby. */
export function mentionStrength(text: string, companyName: string): number {
  const n = normalizeCompanyName(companyName);
  const hay = ` ${foldText(text)} `;
  const core = n.coreTokens.join(" ");
  if (!core) return 0;
  if (n.coreTokens.length === 1 && core.length <= 3) {
    return hay.includes(` ${n.key} `) ? 0.8 : 0;
  }
  if (hay.includes(` ${core} `)) return 1;
  if (hay.includes(` ${n.key} `)) return 1;
  const allTokens = n.coreTokens.every(t => hay.includes(` ${t} `));
  return allTokens && n.coreTokens.length > 1 ? 0.6 : 0;
}

// ---------------------------------------------------------------------------------------------
// Domains and URLs
// ---------------------------------------------------------------------------------------------

const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "ltd.uk", "plc.uk", "me.uk", "com.au", "net.au", "org.au", "co.nz", "org.nz", "co.jp", "or.jp", "ne.jp",
  "co.kr", "com.cn", "net.cn", "com.hk", "com.sg", "com.my", "co.id", "co.in", "net.in", "org.in", "com.pk", "com.br", "com.ar", "com.mx", "co.za",
  "com.tr", "com.sa", "net.sa", "com.om", "co.om", "net.om", "org.om", "gov.om", "com.qa", "com.kw", "com.bh", "co.ae", "com.eg", "co.il", "com.ng",
  "co.ke", "com.tw", "com.ph", "com.vn", "co.th", "com.co", "com.pe", "com.ua", "com.ru"
]);

export function registrableDomain(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, "").replace(/^www\d?\./, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  return MULTI_PART_SUFFIXES.has(lastTwo) ? labels.slice(-3).join(".") : lastTwo;
}

/** The brand-bearing label ("example" for "shop.example.co.uk"). */
export function domainLabel(host: string): string {
  return registrableDomain(host).split(".")[0] ?? "";
}

const HOST_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

/** "HTTPS://WWW.Example.com/about?x=1" or "example.com" → "example.com" (lowercase, no www, no
 *  port/path), or null when it is not a plausible public hostname (IP literals rejected). */
export function normalizeDomain(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `https://${s}`;
  let host: string;
  try { host = new URL(s).hostname; } catch { return null; }
  host = host.replace(/\.$/, "").replace(/^www\d?\./, "");
  if (/^\d+(\.\d+){3}$/.test(host) || host.includes(":")) return null;
  return HOST_PATTERN.test(host) ? host : null;
}

/** Website → canonical https origin ("https://example.com"), or null when not an http(s) URL with
 *  a public-looking hostname. Credentials in URLs are rejected. */
export function normalizeWebsite(raw: string | null | undefined): { url: string; domain: string } | null {
  if (!raw) return null;
  let s = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  let url: URL;
  try { url = new URL(s); } catch { return null; }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  const domain = normalizeDomain(url.hostname);
  if (!domain) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  return { url: `https://${host}`, domain };
}

/** Canonical URL for dedup: https, no www/m./amp, no query tracking params, no fragment, no
 *  trailing slash. */
export function canonicalUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const host = u.hostname.toLowerCase().replace(/^(www\d?|m|amp|mobile)\./, "");
    const params = [...u.searchParams.entries()].filter(([k]) => !/^(utm_|fbclid|gclid|mc_|ref$|src$|cmpid|ocid|taid|smid)/i.test(k)).sort();
    let path = u.pathname.replace(/\/amp\/?$/i, "/").replace(/\/+$/, "");
    if (path === "") path = "/";
    const query = params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join("&")}` : "";
    return `https://${host}${path}${query}`;
  } catch {
    return null;
  }
}

export function hostOf(raw: string | null): string | null {
  if (!raw) return null;
  try { return new URL(raw).hostname.toLowerCase().replace(/^www\d?\./, ""); } catch { return null; }
}

// ---------------------------------------------------------------------------------------------
// Identifiers
// ---------------------------------------------------------------------------------------------

/** Registration numbers compare on uppercase alphanumerics only ("12-345.678 " → "12345678").
 *  Leading zeros are kept (they are significant in several registries, e.g. UK "00445790"). */
export function normalizeRegistrationNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length >= 2 ? s : null;
}

/** Two registration numbers refer to the same record: equal after normalization, or equal after
 *  stripping leading zeros when both are purely numeric (registries differ on zero-padding). */
export function registrationNumbersMatch(a: string | null, b: string | null): boolean {
  const na = normalizeRegistrationNumber(a), nb = normalizeRegistrationNumber(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return /^\d+$/.test(na) && /^\d+$/.test(nb) && na.replace(/^0+/, "") === nb.replace(/^0+/, "");
}

/** ISO 17442 LEI: 20 chars, 18 alphanumerics + 2 check digits (ISO 7064 MOD 97-10). */
export function isValidLei(raw: string): boolean {
  const lei = raw.trim().toUpperCase();
  if (!/^[A-Z0-9]{18}[0-9]{2}$/.test(lei)) return false;
  const numeric = lei.replace(/[A-Z]/g, c => String(c.charCodeAt(0) - 55));
  let remainder = 0;
  for (const ch of numeric) remainder = (remainder * 10 + Number(ch)) % 97;
  return remainder === 1;
}

export function normalizeLei(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const lei = raw.trim().toUpperCase().replace(/\s+/g, "");
  return isValidLei(lei) ? lei : null;
}

export function foldForMatch(s: string): string {
  return foldText(s);
}
