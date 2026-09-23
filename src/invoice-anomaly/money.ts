import { MINOR_UNITS } from "./config.js";

/**
 * Decimal-safe money arithmetic. Every amount is held as a BigInt scaled by 10^8 ("Dec"), parsed
 * from the decimal text of the input — never compared as binary floating point. Equality checks
 * use explicit tolerances (see arithmetic checks); JavaScript numbers appear only in the output and
 * in ratio/percentage statistics, where exact decimal equality is not the question.
 */
export type Dec = bigint;
export const SCALE = 8;
const F = 10n ** BigInt(SCALE);
/** Largest accepted absolute amount (10^15 units) — far beyond any real invoice, and still exact. */
const MAX_ABS = 10n ** 15n * F;

const DECIMAL = /^([+-])?(\d+)(?:\.(\d+))?$/;

/** Rounds a plain decimal string half away from zero to SCALE places. null when not a decimal. */
function parseDecimalString(s: string): Dec | null {
  const m = DECIMAL.exec(s);
  if (!m) return null;
  const negative = m[1] === "-";
  const intPart = m[2]!;
  const fracRaw = m[3] ?? "";
  const frac = (fracRaw + "0".repeat(SCALE + 1)).slice(0, SCALE + 1);
  let scaled = BigInt(intPart) * F + BigInt(frac.slice(0, SCALE));
  if (Number(frac[SCALE]) >= 5) scaled += 1n;
  const value = negative ? -scaled : scaled;
  return (value < 0n ? -value : value) > MAX_ABS ? null : value;
}

/** Parses a JSON number or plain decimal string ("1234.50"). Numbers are read via their shortest
 *  round-trip decimal representation (so 0.1 is exactly 0.1). null = not a valid amount. */
export function parseMoney(v: number | string): Dec | null {
  if (typeof v === "number") {
    if (!Number.isFinite(v) || Math.abs(v) >= 1e15) return null;
    let s = String(v);
    if (/e/i.test(s)) s = v.toFixed(12); // tiny magnitudes only (large ones rejected above)
    return parseDecimalString(s);
  }
  return parseDecimalString(v.trim());
}

export const ZERO: Dec = 0n;
export const abs = (a: Dec): Dec => (a < 0n ? -a : a);
export const sum = (values: readonly Dec[]): Dec => values.reduce((acc, v) => acc + v, 0n);
/** a × b, rounded half away from zero back to SCALE. */
export function mul(a: Dec, b: Dec): Dec {
  const p = a * b;
  const q = p / F, r = p % F;
  const half = F / 2n;
  if (r >= half) return q + 1n;
  if (r <= -half) return q - 1n;
  return q;
}
/** a × (percent / 100), percent given as a JS number (tax rates such as 5 or 7.5). */
export function percentOf(a: Dec, percent: number): Dec {
  const p = parseMoney(percent);
  if (p === null) return 0n;
  return divRound(mul(a, p), 100n);
}
/** Integer division rounded half away from zero. */
export function divRound(x: bigint, d: bigint): bigint {
  const q = x / d, r = x % d;
  if (r * 2n >= d) return q + 1n;
  if (r * 2n <= -d) return q - 1n;
  return q;
}
/** Rounds to `places` decimals (half away from zero), still scaled by 10^8. */
export function roundTo(a: Dec, places: number): Dec {
  if (places >= SCALE) return a;
  const unit = 10n ** BigInt(SCALE - places);
  const q = a / unit, r = a % unit;
  const half = unit / 2n;
  const rounded = r >= half ? q + 1n : r <= -half ? q - 1n : q;
  return rounded * unit;
}
export function toNumber(a: Dec, places = SCALE): number {
  const r = roundTo(a, places);
  const negative = r < 0n;
  const v = negative ? -r : r;
  const s = `${v / F}.${(v % F).toString().padStart(SCALE, "0")}`;
  return Number((negative ? "-" : "") + s);
}
/** Ratio a / b as a JS number (statistics only). null when b is zero. */
export function ratio(a: Dec, b: Dec): number | null {
  if (b === 0n) return null;
  return Number(a) / Number(b);
}
/** Percentage difference |a − b| / |ref| × 100 rounded to 2 decimals; null when ref is zero. */
export function pctDiff(a: Dec, b: Dec, ref: Dec): number | null {
  const r = ratio(abs(a - b), abs(ref));
  return r === null ? null : Math.round(r * 10000) / 100;
}

export function minorUnits(currency: string | null): number {
  if (!currency) return 2;
  return MINOR_UNITS[currency] ?? 2;
}
/** One minor unit of the currency (0.01 USD, 0.001 OMR, 1 JPY) as a Dec. */
export function minorUnit(currency: string | null): Dec {
  return 10n ** BigInt(SCALE - minorUnits(currency));
}
/** Output formatting: a JS number rounded to the currency's minor units (plus 2 extra places for
 *  unit prices, which legitimately carry more precision). */
export const out = (a: Dec, currency: string | null, extraPlaces = 0): number => toNumber(a, minorUnits(currency) + extraPlaces);

/** Median of Dec values (average of the two middle values for even counts). */
export function median(values: readonly Dec[]): Dec {
  const s = [...values].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2n;
}
