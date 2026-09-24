/**
 * vehicle_value_estimate — deterministic normalization of free-text vehicle identity and
 * categorical fields. Everything downstream of validation works on canonical keys and enums,
 * never on caller-formatted strings ("VW" / "volkswagen" / "Volks Wagen" → key "volkswagen").
 */

/** Lowercase, strip diacritics and every non-alphanumeric character: the comparison key used
 *  for make/model/trim/city matching ("Land-Cruiser" and "land cruiser" → "landcruiser"). */
export function matchKey(value: string): string {
  return value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, "");
}

export function collapseSpaces(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim();
}

function titleCase(value: string): string {
  return collapseSpaces(value).split(" ").map(w => (w.length <= 3 && /^[A-Z0-9]+$/.test(w)) ? w : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(" ");
}

/** Canonical display names for common makes, keyed by matchKey — plus aliases. Unknown makes are
 *  still accepted (global coverage) and title-cased; matching always uses the key. */
const MAKE_CANONICAL: Readonly<Record<string, string>> = (() => {
  const names = [
    "Toyota", "Lexus", "Nissan", "Infiniti", "Honda", "Acura", "Mitsubishi", "Mazda", "Subaru", "Suzuki", "Isuzu", "Daihatsu",
    "Hyundai", "Kia", "Genesis", "Ford", "Lincoln", "Chevrolet", "GMC", "Cadillac", "Buick", "Jeep", "Dodge", "Ram", "Chrysler",
    "Tesla", "Volkswagen", "Audi", "Porsche", "BMW", "MINI", "Mercedes-Benz", "Land Rover", "Jaguar", "Volvo", "Peugeot",
    "Renault", "Citroen", "Fiat", "Alfa Romeo", "Skoda", "SEAT", "Cupra", "Opel", "Vauxhall", "MG", "Chery", "Geely", "Haval",
    "Great Wall", "Changan", "BYD", "Jetour", "GAC", "Hongqi", "Polestar", "Ferrari", "Lamborghini", "Maserati", "Bentley",
    "Rolls-Royce", "Aston Martin", "McLaren", "Lotus", "Dacia", "Smart", "Rivian", "Lucid"
  ];
  const map: Record<string, string> = Object.fromEntries(names.map(n => [matchKey(n), n]));
  const aliases: Record<string, string> = {
    vw: "Volkswagen", volks: "Volkswagen", mercedes: "Mercedes-Benz", merc: "Mercedes-Benz", benz: "Mercedes-Benz", mb: "Mercedes-Benz",
    chevy: "Chevrolet", landrover: "Land Rover", rollsroyce: "Rolls-Royce", alfa: "Alfa Romeo", greatwallmotors: "Great Wall",
    citroën: "Citroen", mitsubishimotors: "Mitsubishi", toyotamotor: "Toyota", hyundaimotor: "Hyundai"
  };
  for (const [alias, canonical] of Object.entries(aliases)) map[matchKey(alias)] = canonical;
  return Object.freeze(map);
})();

export function normalizeMake(raw: string): { display: string; key: string } {
  const key = matchKey(raw);
  const canonical = MAKE_CANONICAL[key];
  return canonical ? { display: canonical, key: matchKey(canonical) } : { display: titleCase(raw), key };
}

export function normalizeModel(raw: string): { display: string; key: string } {
  return { display: collapseSpaces(raw), key: matchKey(raw) };
}

export function normalizeTrim(raw: string | undefined): { display: string; key: string } | null {
  if (raw === undefined) return null;
  const display = collapseSpaces(raw);
  const key = matchKey(display);
  return key ? { display, key } : null;
}

/** Word tokens of a trim, for partial matching ("GXR V6" vs "GXR" share "gxr"). */
export function trimTokens(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.normalize("NFKD").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export function normalizeCity(raw: string | undefined): { display: string; key: string } | null {
  if (raw === undefined) return null;
  const display = titleCase(raw);
  const key = matchKey(display);
  return key ? { display, key } : null;
}

// ---- country ------------------------------------------------------------------------------------

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

/** Every ISO 3166-1 alpha-2 code Intl recognizes, with its English name — built once, so any
 *  country in the world can be named, not only the configured markets. */
const COUNTRY_BY_CODE: ReadonlyMap<string, string> = (() => {
  const map = new Map<string, string>();
  const A = "A".charCodeAt(0);
  for (let i = 0; i < 26; i++) for (let j = 0; j < 26; j++) {
    const code = String.fromCharCode(A + i, A + j);
    let name: string | undefined;
    try { name = regionNames.of(code); } catch { name = undefined; }
    if (name && name !== code && !/unknown/i.test(name)) map.set(code, name);
  }
  // Exclude user-assigned / exceptional reservations that Intl may name.
  for (const reserved of ["EU", "EZ", "UN", "XA", "XB", "QO", "ZZ", "AA"]) map.delete(reserved);
  return map;
})();

const COUNTRY_ALIASES: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(Object.entries({
  uae: "AE", emirates: "AE", unitedarabemirates: "AE", are: "AE", ksa: "SA", saudi: "SA", saudiarabia: "SA", kingdomofsaudiarabia: "SA", sau: "SA",
  omn: "OM", sultanateofoman: "OM", qat: "QA", bhr: "BH", kwt: "KW", usa: "US", us: "US", unitedstatesofamerica: "US", america: "US",
  can: "CA", uk: "GB", gbr: "GB", greatbritain: "GB", britain: "GB", england: "GB", scotland: "GB", wales: "GB", aus: "AU",
  deu: "DE", fra: "FR", ita: "IT", esp: "ES", nld: "NL", holland: "NL", bel: "BE", aut: "AT", irl: "IE", prt: "PT", fin: "FI",
  swe: "SE", dnk: "DK", pol: "PL", che: "CH", nzl: "NZ", ind: "IN", jpn: "JP", egy: "EG", jor: "JO",
  عمان: "OM", سلطنةعمان: "OM", الامارات: "AE", الإمارات: "AE", السعودية: "SA", قطر: "QA", البحرين: "BH", الكويت: "KW"
}).map(([k, v]) => [matchKey(k), v])));

const COUNTRY_BY_NAME_KEY: ReadonlyMap<string, string> = new Map([...COUNTRY_BY_CODE].map(([code, name]) => [matchKey(name), code]));

/** ISO alpha-2 / alpha-3 (common) / English name / common alias → { code, name }; null when not a
 *  recognizable country. */
export function normalizeCountry(raw: string): { code: string; name: string } | null {
  const trimmed = collapseSpaces(raw);
  if (/^[A-Za-z]{2}$/.test(trimmed)) {
    const code = trimmed.toUpperCase();
    const name = COUNTRY_BY_CODE.get(code);
    if (name) return { code, name };
  }
  const key = matchKey(trimmed);
  const code = COUNTRY_ALIASES[key] ?? COUNTRY_BY_NAME_KEY.get(key);
  if (code) return { code, name: COUNTRY_BY_CODE.get(code) ?? code };
  return null;
}

export function countryName(code: string): string {
  return COUNTRY_BY_CODE.get(code) ?? code;
}

// ---- categorical synonyms (consumed by the input schema's preprocessors) ------------------------

function synonymMap(groups: Record<string, readonly string[]>): Readonly<Record<string, string>> {
  const map: Record<string, string> = {};
  for (const [canonical, synonyms] of Object.entries(groups)) for (const s of [canonical, ...synonyms]) map[matchKey(s)] = canonical;
  return Object.freeze(map);
}

export const CONDITION_SYNONYMS = synonymMap({
  excellent: ["like new", "mint", "as new"], very_good: ["very good", "verygood"], good: ["average plus"],
  fair: ["average", "acceptable", "used"], poor: ["bad", "rough", "needs work"], unknown: ["not specified", "n/a", "na"]
});
export const FUEL_SYNONYMS = synonymMap({
  petrol: ["gasoline", "gas", "benzine", "benzin", "unleaded", "بنزين"], diesel: ["gasoil", "ديزل"], hybrid: ["hev", "full hybrid", "mild hybrid", "mhev"],
  plug_in_hybrid: ["plug-in hybrid", "plugin hybrid", "phev"], electric: ["ev", "bev", "battery electric", "كهربائي"], lpg: ["autogas"],
  cng: ["natural gas"], hydrogen: ["fcev", "fuel cell"], other: []
});
export const TRANSMISSION_SYNONYMS = synonymMap({
  automatic: ["auto", "at", "tiptronic", "steptronic", "اوتوماتيك", "أوتوماتيك"], manual: ["mt", "stick", "standard", "gear", "عادي", "يدوي"],
  cvt: ["continuously variable"], dct: ["dsg", "dual clutch", "dual-clutch", "pdk"], other: []
});
export const BODY_SYNONYMS = synonymMap({
  sedan: ["saloon"], hatchback: ["hatch"], suv: ["4x4 suv", "sport utility", "jeep"], crossover: ["cuv"],
  pickup: ["pick-up", "pick up", "truck", "ute"], coupe: ["coupé"], convertible: ["cabriolet", "cabrio", "roadster"],
  wagon: ["estate", "station wagon", "touring"], van: ["panel van"], minivan: ["mpv", "people carrier"], other: []
});
export const DRIVETRAIN_SYNONYMS = synonymMap({
  fwd: ["front wheel drive", "2wd front", "ff"], rwd: ["rear wheel drive", "2wd rear"], awd: ["all wheel drive", "quattro", "xdrive", "4matic", "4motion"],
  "4wd": ["4x4", "four wheel drive", "4wd", "part-time 4wd"]
});
export const ACCIDENT_SYNONYMS = synonymMap({
  none: ["no", "no accident", "no known accident", "clean", "accident free", "false"], minor_cosmetic: ["minor", "cosmetic", "scratch", "dent"],
  repaired: ["moderate", "repaired accident", "previous accident repaired"], structural: ["major", "severe", "frame", "chassis", "structural damage", "total loss", "salvage"],
  reported: ["yes", "true", "accident", "had accident"], unknown: ["not specified", "n/a", "na"]
});
export const SERVICE_SYNONYMS = synonymMap({
  full: ["complete", "fsh", "full service history", "dealer serviced", "agency maintained"], partial: ["some", "incomplete", "part"],
  none: ["no", "no history", "missing"], unknown: ["not specified", "n/a", "na"]
});

/** Currency symbols/aliases → ISO 4217. Only unambiguous aliases (never "$" alone). */
const CURRENCY_ALIASES: Readonly<Record<string, string>> = Object.freeze({ "RO": "OMR", "OR": "OMR", "ر.ع": "OMR", "DHS": "AED", "DH": "AED", "SR": "SAR", "QR": "QAR", "BD": "BHD", "KD": "KWD", "€": "EUR", "£": "GBP", "US$": "USD", "C$": "CAD", "A$": "AUD" });

export function normalizeCurrencyCode(raw: string): string | null {
  const t = collapseSpaces(raw).toUpperCase();
  if (CURRENCY_ALIASES[t]) return CURRENCY_ALIASES[t];
  return /^[A-Z]{3}$/.test(t) ? t : null;
}

/** Options that plausibly carry resale value — used only for a small, capped, clearly heuristic
 *  adjustment (see valuation.ts); every other option is recorded but not priced. */
const PREMIUM_OPTION_KEYS = new Set([
  "sunroof", "panoramicsunroof", "panoramicroof", "moonroof", "leatherseats", "leather", "360camera", "surroundviewcamera", "navigation", "navigationsystem",
  "premiumsound", "premiumaudio", "adaptivecruisecontrol", "headsupdisplay", "headupdisplay", "ventilatedseats", "heatedseats", "towpackage",
  "airsuspension", "rearentertainment", "sportpackage", "technologypackage", "coolbox", "fridge", "kdss", "rearlocker", "difflock"
]);

export function normalizeOptions(raw: readonly string[] | undefined): { all: string[]; premium: string[] } {
  const seen = new Map<string, string>();
  for (const r of raw ?? []) {
    const display = collapseSpaces(r).toLowerCase();
    const key = matchKey(display);
    if (key && !seen.has(key)) seen.set(key, display);
  }
  const all = [...seen.entries()].sort(([a], [b]) => a.localeCompare(b));
  return { all: all.map(([, d]) => d), premium: all.filter(([k]) => PREMIUM_OPTION_KEYS.has(k)).map(([, d]) => d) };
}
