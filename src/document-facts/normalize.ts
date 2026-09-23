/**
 * Value normalization for document_facts_extract: dates, monetary amounts/currencies, percentages
 * and durations. Every normalizer returns the ORIGINAL text alongside the normalized value and
 * refuses to normalize when the text is genuinely ambiguous (e.g. 03/04/2026 with no evidence of
 * the document's day/month order, a bare "$", "48.000" with no decimal-style evidence).
 */

// ---- Dates -------------------------------------------------------------------------------------

const MONTHS: Record<string, number> = {};
const addMonths = (names: readonly string[][]) => names.forEach((alts, i) => alts.forEach(n => { MONTHS[n] = i + 1; }));
addMonths([
  ["january", "jan", "janvier", "janv", "enero", "ene", "januar", "janeiro", "gennaio", "januari", "يناير", "كانون الثاني"],
  ["february", "feb", "février", "fevrier", "févr", "febrero", "februar", "fevereiro", "febbraio", "februari", "فبراير", "شباط"],
  ["march", "mar", "mars", "marzo", "märz", "marz", "março", "marco", "maart", "مارس", "آذار", "اذار"],
  ["april", "apr", "avril", "avr", "abril", "abr", "aprile", "أبريل", "ابريل", "نيسان"],
  ["may", "mai", "mayo", "maio", "maggio", "mei", "مايو", "أيار", "ايار"],
  ["june", "jun", "juin", "junio", "juni", "junho", "giugno", "يونيو", "يونيه", "حزيران"],
  ["july", "jul", "juillet", "juil", "julio", "juli", "julho", "luglio", "يوليو", "يوليه", "تموز"],
  ["august", "aug", "août", "aout", "agosto", "ago", "augustus", "أغسطس", "اغسطس", "آب"],
  ["september", "sep", "sept", "septembre", "septiembre", "setembro", "settembre", "سبتمبر", "أيلول", "ايلول"],
  ["october", "oct", "octobre", "octubre", "oktober", "okt", "outubro", "ottobre", "أكتوبر", "اكتوبر", "تشرين الأول"],
  ["november", "nov", "novembre", "noviembre", "novembro", "نوفمبر", "تشرين الثاني"],
  ["december", "dec", "décembre", "decembre", "déc", "diciembre", "dic", "dezember", "dez", "dezembro", "dicembre", "ديسمبر", "كانون الأول"]
]);
const MONTH_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).map(m => m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
const B = "(?<![\\p{L}\\p{N}])"; // unicode-aware word boundary (start)
const E = "(?![\\p{L}\\p{N}])";  // (end)

export type DatePrecision = "day" | "month";
export interface DateMatch {
  start: number; end: number; original: string;
  /** ISO 8601 (YYYY-MM-DD, or YYYY-MM for month precision); absent when ambiguous or invalid. */
  normalized?: string;
  precision: DatePrecision;
  ambiguous: boolean;
  /** Confidence in the normalization itself (1 for textual months/ISO, lower for numeric forms). */
  certainty: number;
}

export const DATE_PATTERNS = {
  iso: new RegExp(`${B}(\\d{4})-(\\d{1,2})-(\\d{1,2})${E}`, "gu"),
  dmyText: new RegExp(`${B}(\\d{1,2})(?:st|nd|rd|th|er|º)?(?:\\s+day\\s+of|\\s+de)?[\\s.\\-/]+(${MONTH_ALT})\\.?(?:[\\s,.\\-/]+(?:de\\s+)?)(\\d{4})${E}`, "giu"),
  mdyText: new RegExp(`${B}(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})${E}`, "giu"),
  monthYear: new RegExp(`${B}(${MONTH_ALT})\\.?,?\\s+(\\d{4})${E}`, "giu"),
  numeric: new RegExp(`${B}(\\d{1,2})([/.\\-])(\\d{1,2})\\2(\\d{4}|\\d{2})${E}`, "gu")
};

function validYmd(y: number, m: number, d: number): boolean {
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}
const iso = (y: number, m: number, d?: number) => `${y}-${String(m).padStart(2, "0")}${d === undefined ? "" : "-" + String(d).padStart(2, "0")}`;

/** Document-level evidence of numeric date order: "dmy" if some numeric date has first component
 *  > 12, "mdy" if some has second component > 12; null when no evidence or contradictory. */
export function inferNumericDateOrder(text: string): "dmy" | "mdy" | null {
  let dmy = false, mdy = false;
  for (const m of text.matchAll(DATE_PATTERNS.numeric)) {
    const a = Number(m[1]), b = Number(m[3]);
    if (a > 12 && b <= 12) dmy = true;
    if (b > 12 && a <= 12) mdy = true;
  }
  return dmy === mdy ? null : dmy ? "dmy" : "mdy";
}

export function findDates(text: string, order: "dmy" | "mdy" | null = inferNumericDateOrder(text)): DateMatch[] {
  const out: DateMatch[] = [];
  const taken: [number, number][] = [];
  const free = (s: number, e: number) => !taken.some(([a, b]) => s < b && e > a);
  const add = (m: DateMatch) => { if (free(m.start, m.end)) { out.push(m); taken.push([m.start, m.end]); } };

  for (const m of text.matchAll(DATE_PATTERNS.iso)) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (!validYmd(y, mo, d)) continue;
    add({ start: m.index!, end: m.index! + m[0].length, original: m[0], normalized: iso(y, mo, d), precision: "day", ambiguous: false, certainty: 1 });
  }
  const invalid = (m: RegExpMatchArray) => { taken.push([m.index!, m.index! + m[0].length]); };
  for (const m of text.matchAll(DATE_PATTERNS.dmyText)) {
    const [d, mo, y] = [Number(m[1]), MONTHS[m[2]!.toLowerCase()]!, Number(m[3])];
    if (!validYmd(y, mo, d)) { invalid(m); continue; }
    add({ start: m.index!, end: m.index! + m[0].length, original: m[0], normalized: iso(y, mo, d), precision: "day", ambiguous: false, certainty: 1 });
  }
  for (const m of text.matchAll(DATE_PATTERNS.mdyText)) {
    const [mo, d, y] = [MONTHS[m[1]!.toLowerCase()]!, Number(m[2]), Number(m[3])];
    if (!validYmd(y, mo, d)) { invalid(m); continue; }
    add({ start: m.index!, end: m.index! + m[0].length, original: m[0], normalized: iso(y, mo, d), precision: "day", ambiguous: false, certainty: 1 });
  }
  for (const m of text.matchAll(DATE_PATTERNS.numeric)) {
    const a = Number(m[1]), b = Number(m[3]);
    let y = Number(m[4]);
    let certainty = 0.95;
    if (m[4]!.length === 2) {
      if (m[2] === ".") continue; // "1.2.24" is far more often a clause/version number than a date
      y += y <= 69 ? 2000 : 1900; certainty = 0.85;
    }
    const start = m.index!, end = start + m[0].length;
    // Guard against version numbers / decimals like 1.2.2024 inside a longer numeric run.
    if (/[\d.]/.test(text[end] ?? "") && text[end] !== ".") continue;
    let dmy: [number, number] | null = null;
    let ambiguous = false;
    if (a > 12 && b <= 12) dmy = [a, b];
    else if (b > 12 && a <= 12) dmy = [b, a];
    else if (a === b) dmy = [a, b];
    else if (a <= 12 && b <= 12) {
      if (order === "dmy") { dmy = [a, b]; certainty -= 0.1; }
      else if (order === "mdy") { dmy = [b, a]; certainty -= 0.1; }
      else ambiguous = true;
    }
    if (ambiguous) { add({ start, end, original: m[0], precision: "day", ambiguous: true, certainty: 0 }); continue; }
    if (!dmy || !validYmd(y, dmy[1], dmy[0])) continue;
    add({ start, end, original: m[0], normalized: iso(y, dmy[1], dmy[0]), precision: "day", ambiguous: false, certainty });
  }
  for (const m of text.matchAll(DATE_PATTERNS.monthYear)) {
    const mo = MONTHS[m[1]!.toLowerCase()]!, y = Number(m[2]);
    if (y < 1900 || y > 2200) continue;
    // "may 2026" — "may" is also a modal verb; require a capital letter for bare "May".
    if (/^may$/i.test(m[1]!) && m[1] !== "May") continue;
    add({ start: m.index!, end: m.index! + m[0].length, original: m[0], normalized: iso(y, mo), precision: "month", ambiguous: false, certainty: 0.9 });
  }
  return out.sort((x, y) => x.start - y.start);
}

/** Parses one date string (e.g. from an LLM answer or a labeled field). */
export function normalizeDateString(s: string): string | undefined {
  const m = findDates(s)[0];
  return m && !m.ambiguous ? m.normalized : undefined;
}

// ---- Numbers -----------------------------------------------------------------------------------

export type DecimalStyle = "dot" | "comma" | null;

/** Document-level decimal-separator evidence from unambiguous numbers: "1,234.56" ⇒ dot, "1.234,56" ⇒ comma. */
export function inferDecimalStyle(text: string): DecimalStyle {
  const dot = /\d{1,3}(?:,\d{3})+\.\d{1,3}(?!\d)|(?<![\d.])\d+\.\d{1,2}(?![\d.,])/.test(text);
  const comma = /\d{1,3}(?:\.\d{3})+,\d{1,3}(?!\d)|(?<![\d,])\d+,\d{1,2}(?![\d.,])(?!\s*\d)/.test(text);
  return dot === comma ? (dot ? null : null) : dot ? "dot" : "comma";
}

/** Parses a formatted number. Returns null for genuinely ambiguous forms ("48.000" / "48,000" is
 *  resolved only with style evidence or a 3-minor-unit currency). */
export function parseNumber(raw: string, style: DecimalStyle, minorUnits = 2): number | null {
  const s = raw.replace(/[\s'’]/g, "");
  if (!/^\d[\d.,]*$/.test(s)) return null;
  const dots = (s.match(/\./g) ?? []).length, commas = (s.match(/,/g) ?? []).length;
  const toNum = (intPart: string, frac = "") => Number(`${intPart}${frac ? "." + frac : ""}`);
  if (dots === 0 && commas === 0) return Number(s);
  if (dots > 0 && commas > 0) {
    const lastDot = s.lastIndexOf("."), lastComma = s.lastIndexOf(",");
    if (lastDot > lastComma) { if (!/^\d{1,3}(,\d{3})*\.\d+$/.test(s)) return null; return toNum(s.slice(0, lastDot).replace(/,/g, ""), s.slice(lastDot + 1)); }
    if (!/^\d{1,3}(\.\d{3})*,\d+$/.test(s)) return null;
    return toNum(s.slice(0, lastComma).replace(/\./g, ""), s.slice(lastComma + 1));
  }
  const sep = dots > 0 ? "." : ",";
  const count = dots || commas;
  const parts = s.split(sep);
  if (count > 1) { // repeated separator ⇒ thousands grouping
    if (!parts.slice(1).every(p => p.length === 3) || parts[0]!.length > 3) return null;
    return Number(parts.join(""));
  }
  const [a, b] = parts as [string, string];
  if (b.length !== 3) return toNum(a, b); // "48.5", "48,50", "1234.5" — a decimal separator
  // Exactly one separator followed by exactly 3 digits: thousands or decimals?
  if (a.length > 3 || a === "0") return toNum(a, b);
  const decimalSep = style === "dot" ? "." : style === "comma" ? "," : null;
  if (decimalSep) return sep === decimalSep ? toNum(a, b) : Number(a + b);
  if (sep === ",") return Number(a + b); // "48,000": comma grouping is by far the norm without contrary evidence
  return minorUnits === 3 ? toNum(a, b) : null; // "48.000": ambiguous unless a 3-decimal currency
}

// ---- Currencies & amounts ------------------------------------------------------------------------

const ISO_CURRENCIES = "USD EUR GBP JPY CNY CHF CAD AUD NZD SGD HKD INR PKR BDT LKR NPR OMR AED SAR QAR KWD BHD JOD EGP MAD TND DZD LYD IQD LBP TRY ZAR NGN KES GHS ETB TZS UGX BRL MXN ARS CLP COP PEN RUB UAH PLN CZK HUF RON BGN SEK NOK DKK ISK ILS KRW TWD THB MYR IDR PHP VND".split(" ");
export const THREE_DECIMAL_CURRENCIES = new Set(["OMR", "BHD", "KWD", "JOD", "TND", "LYD", "IQD"]);

const SYMBOLS: [string, string | null][] = [
  ["US$", "USD"], ["USD$", "USD"], ["A$", "AUD"], ["AU$", "AUD"], ["C$", "CAD"], ["CA$", "CAD"], ["S$", "SGD"], ["HK$", "HKD"], ["NZ$", "NZD"], ["R$", "BRL"], ["MX$", "MXN"],
  ["€", "EUR"], ["£", "GBP"], ["₹", "INR"], ["₩", "KRW"], ["₺", "TRY"], ["₦", "NGN"], ["₱", "PHP"], ["₫", "VND"], ["₪", "ILS"], ["₽", "RUB"], ["₴", "UAH"], ["฿", "THB"],
  ["R.O.", "OMR"], ["RO", "OMR"], ["Dhs", "AED"], ["QR", "QAR"], ["BD", "BHD"], ["KD", "KWD"],
  ["$", null], ["¥", null], ["kr", null], ["Rs.", null], ["Rs", null]
];
const WORD_CURRENCIES: [RegExp, string | null][] = [
  [/^u\.?s\.?\s*dollars?$|^united states dollars?$/i, "USD"], [/^euros?$/i, "EUR"], [/^(?:pounds? sterling|british pounds?|sterling)$/i, "GBP"],
  [/^(?:omani ri[a-y]?als?|ri[a-y]?als? omani)$/i, "OMR"], [/^saudi (?:ri[a-y]?als?|riyals?)$/i, "SAR"], [/^qatari ri[a-y]?als?$/i, "QAR"],
  [/^(?:uae|emirati) dirhams?$/i, "AED"], [/^kuwaiti dinars?$/i, "KWD"], [/^bahraini dinars?$/i, "BHD"], [/^jordanian dinars?$/i, "JOD"],
  [/^egyptian pounds?$/i, "EGP"], [/^indian rupees?$/i, "INR"], [/^pakistani rupees?$/i, "PKR"], [/^(?:japanese )?yen$/i, "JPY"], [/^(?:chinese )?(?:yuan|renminbi)$/i, "CNY"],
  [/^swiss francs?$/i, "CHF"], [/^canadian dollars?$/i, "CAD"], [/^australian dollars?$/i, "AUD"], [/^singapore dollars?$/i, "SGD"], [/^(?:south african )?rand$/i, "ZAR"],
  [/^(?:nigerian )?naira$/i, "NGN"], [/^(?:turkish )?lira$/i, "TRY"],
  [/^(?:ريال عماني|ر\.ع\.?|ر ع)$/, "OMR"], [/^ريال سعودي$/, "SAR"], [/^ريال قطري$/, "QAR"], [/^درهم إماراتي$|^درهم اماراتي$/, "AED"],
  [/^دينار كويتي$/, "KWD"], [/^دينار بحريني$/, "BHD"], [/^دينار أردني$|^دينار اردني$/, "JOD"], [/^جنيه مصري$/, "EGP"], [/^دولار أمريكي$|^دولار امريكي$/, "USD"], [/^يورو$/, "EUR"],
  [/^dollars?$|^rupees?$|^dirhams?$|^dinars?$|^ri[a-y]?als?$|^pounds?$|^francs?$|^ريال$|^درهم$|^دينار$|^دولار$/i, null]
];

const SYMBOL_ALT = SYMBOLS.map(([s]) => s).sort((a, b) => b.length - a.length).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
const WORD_ALT = "u\\.?s\\.?\\s*dollars?|united states dollars?|euros?|pounds? sterling|british pounds?|omani ri[a-y]?als?|ri[a-y]?als? omani|saudi ri[a-y]?als?|qatari ri[a-y]?als?|(?:uae|emirati) dirhams?|kuwaiti dinars?|bahraini dinars?|jordanian dinars?|egyptian pounds?|indian rupees?|pakistani rupees?|japanese yen|yen|chinese yuan|yuan|renminbi|swiss francs?|canadian dollars?|australian dollars?|singapore dollars?|south african rand|nigerian naira|naira|turkish lira|dollars?|rupees?|dirhams?|dinars?|ri[a-y]?als?|ريال عماني|ر\\.ع\\.?|ريال سعودي|ريال قطري|درهم إماراتي|درهم اماراتي|دينار كويتي|دينار بحريني|دينار أردني|جنيه مصري|دولار أمريكي|يورو|ريال|درهم|دينار|دولار";
const NUM = "\\d{1,3}(?:[,. '’]\\d{3})+(?:[.,]\\d{1,3})?|\\d+(?:[.,]\\d{1,3})?";
const SCALE = "(?:\\s?(million|mn|m|billion|bn|thousand|k)(?![\\p{L}]))?";
const CUR_PREFIX = `(${ISO_CURRENCIES.join("|")}|${SYMBOL_ALT})`;

export const AMOUNT_PATTERNS = {
  prefixed: new RegExp(`(?<![\\p{L}\\d])${CUR_PREFIX}\\s?(${NUM})${SCALE}(?![\\d%])`, "gu"),
  suffixed: new RegExp(`(?<![\\p{L}\\d.,])(${NUM})${SCALE}\\s?(${ISO_CURRENCIES.join("|")}|${WORD_ALT}|€|£)(?![\\p{L}])`, "giu")
};

export interface AmountMatch {
  start: number; end: number; original: string;
  amount: number | null;
  currency?: string;
  /** The currency marker as written, when it could not be mapped to one ISO code (e.g. "$"). */
  currencySymbol?: string;
  ambiguousCurrency: boolean;
  ambiguousNumber: boolean;
}

function resolveCurrency(token: string): { code?: string; ambiguous: boolean } {
  const t = token.trim();
  if (ISO_CURRENCIES.includes(t.toUpperCase()) && t === t.toUpperCase()) return { code: t.toUpperCase(), ambiguous: false };
  for (const [sym, code] of SYMBOLS) if (sym === t) return code ? { code, ambiguous: false } : { ambiguous: true };
  for (const [re, code] of WORD_CURRENCIES) if (re.test(t)) return code ? { code, ambiguous: false } : { ambiguous: true };
  return { ambiguous: true };
}

const SCALES: Record<string, number> = { thousand: 1e3, k: 1e3, million: 1e6, mn: 1e6, m: 1e6, billion: 1e9, bn: 1e9 };

export function findAmounts(text: string, style: DecimalStyle = inferDecimalStyle(text)): AmountMatch[] {
  const out: AmountMatch[] = [];
  const taken: [number, number][] = [];
  const add = (a: AmountMatch) => { if (!taken.some(([s, e]) => a.start < e && a.end > s)) { out.push(a); taken.push([a.start, a.end]); } };
  const build = (start: number, original: string, numRaw: string, curRaw: string, scaleRaw: string | undefined): AmountMatch | null => {
    // Short all-caps symbols ("RO", "QR", "BD", "KD") must be real tokens, not e.g. part of "PRO".
    const cur = resolveCurrency(curRaw);
    const minor = cur.code && THREE_DECIMAL_CURRENCIES.has(cur.code) ? 3 : 2;
    let amount = parseNumber(numRaw.trim(), style, minor);
    if (amount !== null && scaleRaw) amount = amount * SCALES[scaleRaw.toLowerCase()]!;
    if (amount !== null) amount = Math.round(amount * 1000) / 1000;
    return {
      start, end: start + original.length, original: original.trim(), amount,
      ...(cur.code ? { currency: cur.code } : { currencySymbol: curRaw.trim() }),
      ambiguousCurrency: cur.ambiguous, ambiguousNumber: amount === null
    };
  };
  for (const m of text.matchAll(AMOUNT_PATTERNS.prefixed)) {
    const cur = m[1]!;
    if (/^(RO|QR|BD|KD|kr|Rs)$/.test(cur) && /[\p{L}]/u.test(text[m.index! - 1] ?? "")) continue;
    const a = build(m.index!, m[0], m[2]!, cur, m[3]);
    if (a) add(a);
  }
  for (const m of text.matchAll(AMOUNT_PATTERNS.suffixed)) {
    const a = build(m.index!, m[0], m[1]!, m[3]!, m[2]);
    if (a) add(a);
  }
  return out.sort((x, y) => x.start - y.start);
}

/** A labeled amount with no currency marker ("Total: 1,050.00"). */
export function parseBareAmount(raw: string, style: DecimalStyle): number | null {
  const m = /^\(?\s*(\d[\d.,' ]*\d|\d)\s*\)?$/.exec(raw.trim());
  return m ? parseNumber(m[1]!, style) : null;
}

// ---- Percentages -------------------------------------------------------------------------------

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fortyfive: 45, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100
};
const WORD_NUM = "(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)(?:[- ](?:one|two|three|four|five|six|seven|eight|nine))?";
function wordToNumber(w: string): number | null {
  const parts = w.toLowerCase().split(/[- ]/);
  let total = 0;
  for (const p of parts) { const v = NUMBER_WORDS[p]; if (v === undefined) return null; total += v; }
  return total;
}

export interface PercentMatch { start: number; end: number; original: string; value: number; ratio: number }
const PERCENT_RE = new RegExp(`(?<![\\p{L}\\d.,])(?:(\\d+(?:[.,]\\d+)?)\\s?(?:%|percent|per cent|pct)|(${WORD_NUM})(?:\\s*\\((\\d+(?:[.,]\\d+)?)\\s?%?\\))?\\s(?:percent|per cent)(?:\\s*\\((\\d+(?:[.,]\\d+)?)\\s?%\\))?)(?![\\p{L}])`, "giu");

export function findPercentages(text: string): PercentMatch[] {
  const out: PercentMatch[] = [];
  for (const m of text.matchAll(PERCENT_RE)) {
    const digits = m[1] ?? m[3] ?? m[4];
    const value = digits !== undefined ? Number(digits.replace(",", ".")) : wordToNumber(m[2]!);
    if (value === null || !Number.isFinite(value) || value > 1000) continue;
    out.push({ start: m.index!, end: m.index! + m[0].length, original: m[0], value, ratio: Math.round((value / 100) * 1e6) / 1e6 });
  }
  return out;
}

// ---- Durations ---------------------------------------------------------------------------------

export type DurationUnit = "day" | "week" | "month" | "year" | "hour";
export interface DurationMatch {
  start: number; end: number; original: string;
  value: number; unit: DurationUnit; dayKind?: "calendar" | "business";
  /** ISO 8601 duration, e.g. P30D, P3M, P1Y, PT48H. */
  iso: string;
}
const DURATION_RE = new RegExp(`(?<![\\p{L}\\d])(?:(\\d{1,4})|(${WORD_NUM})(?:\\s*\\((\\d{1,4})\\))?)\\s*(?:\\((\\d{1,4})\\)\\s*)?(calendar\\s+|business\\s+|working\\s+)?(hours?|days?|weeks?|months?|years?)(?![\\p{L}])`, "giu");

export function findDurations(text: string): DurationMatch[] {
  const out: DurationMatch[] = [];
  for (const m of text.matchAll(DURATION_RE)) {
    const digits = m[1] ?? m[3] ?? m[4];
    const value = digits !== undefined ? Number(digits) : wordToNumber(m[2]!);
    if (value === null || value <= 0) continue;
    const unitWord = m[6]!.toLowerCase().replace(/s$/, "") as DurationUnit;
    const kind = m[5]?.trim().toLowerCase();
    const isoUnit = { day: "D", week: "W", month: "M", year: "Y", hour: "H" }[unitWord];
    out.push({
      start: m.index!, end: m.index! + m[0].length, original: m[0].trim(), value, unit: unitWord,
      ...(kind ? { dayKind: kind === "calendar" ? "calendar" as const : "business" as const } : {}),
      iso: unitWord === "hour" ? `PT${value}H` : `P${value}${isoUnit}`
    });
  }
  return out;
}

export function durationInDays(d: { value: number; unit: DurationUnit }): number {
  return d.unit === "day" ? d.value : d.unit === "week" ? d.value * 7 : d.unit === "month" ? d.value * 30 : d.unit === "year" ? d.value * 365 : d.value / 24;
}
