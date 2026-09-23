import { companyNameSimilarity, normalizeCompanyName } from "../company-reputation/normalization.js";
import { THRESHOLDS } from "./config.js";
import type { InvoiceNumberInfo, SupplierRef } from "./types.js";

/** Deterministic text helpers: normalization, similarity, invoice-number structure, masking. */

export const collapse = (s: string) => s.normalize("NFKC").replace(/[​-‏‪-‮⁠﻿]/g, "").replace(/\s+/g, " ").trim();

const STOP = new Set(["the", "a", "an", "of", "for", "and", "to", "in", "on", "with", "per", "by", "at"]);
/** Lower-case, punctuation-free, single-spaced line description ("Consulting  Services." → "consulting services"). */
export function descriptionKey(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const k = collapse(raw).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return k || null;
}
export function tokens(key: string | null): Set<string> {
  if (!key) return new Set();
  return new Set(key.split(" ").filter(t => t.length > 1 && !STOP.has(t)));
}
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Levenshtein distance with an early exit once it exceeds `max` (strings here are short ids). */
export function levenshtein(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}
export function similarity(a: string, b: string): number {
  const len = Math.max(a.length, b.length);
  if (len === 0) return 0;
  return 1 - levenshtein(a, b) / len;
}

// ---- invoice numbers --------------------------------------------------------------------------

export function invoiceNumberInfo(raw: string | undefined | null): InvoiceNumberInfo | null {
  if (!raw) return null;
  const clean = collapse(raw).toUpperCase();
  const compact = clean.replace(/[^\p{L}\p{N}]/gu, "");
  if (!compact) return { raw: clean, compact: "", digits: "", shape: clean, prefix: "", trailing: null };
  const digits = compact.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  const shape = clean.replace(/\p{L}/gu, "A").replace(/\p{N}/gu, "9");
  const m = /^(.*?)(\d+)$/.exec(compact);
  return { raw: clean, compact, digits: compact.replace(/\D/g, "") ? digits : "", shape, prefix: m ? m[1]! : compact, trailing: m ? BigInt(m[2]!) : null };
}

export type NumberRelation = "identical" | "equivalent" | "variant" | "sequential" | "similar" | "different";

/**
 * How two invoice numbers relate:
 *  - identical:  same after removing spaces/punctuation/case ("INV-1043" = "inv 1043")
 *  - equivalent: same digits, differing only in letters/prefix ("1043" vs "INV-001043")
 *  - variant:    a resubmission-style edit — one extends the other by ≤ 2 characters
 *                ("INV1043" → "INV1043A"), or a single typo/transposition that is NOT simply the
 *                next number in sequence
 *  - sequential: same prefix, trailing numbers within THRESHOLDS.sequentialGapMax (ordinary numbering)
 *  - similar:    Levenshtein similarity ≥ THRESHOLDS.invoiceNumberSimilar otherwise
 */
export function numberRelation(a: InvoiceNumberInfo | null, b: InvoiceNumberInfo | null): NumberRelation {
  if (!a || !b || !a.compact || !b.compact) return "different";
  if (a.compact === b.compact) return "identical";
  if (a.digits.length >= 3 && a.digits === b.digits && /^[\p{L}]*0*\d+$/u.test(a.compact) && /^[\p{L}]*0*\d+$/u.test(b.compact)) return "equivalent";
  const sequential = a.trailing !== null && b.trailing !== null && a.prefix === b.prefix
    && (a.trailing > b.trailing ? a.trailing - b.trailing : b.trailing - a.trailing) <= BigInt(THRESHOLDS.sequentialGapMax);
  const [short, long] = a.compact.length <= b.compact.length ? [a.compact, b.compact] : [b.compact, a.compact];
  if (long.startsWith(short) && long.length - short.length <= 2 && short.length >= 3 && !/^\d+$/.test(long.slice(short.length))) return "variant";
  if (sequential) return "sequential";
  if (short.length >= 4 && levenshtein(a.compact, b.compact, 1) === 1) return "variant";
  if (isTransposition(a.compact, b.compact)) return "variant";
  return similarity(a.compact, b.compact) >= THRESHOLDS.invoiceNumberSimilar ? "similar" : "different";
}
function isTransposition(a: string, b: string): boolean {
  if (a.length !== b.length || a.length < 4) return false;
  const diff: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff.push(i);
  return diff.length === 2 && diff[1] === diff[0]! + 1 && a[diff[0]!] === b[diff[1]!] && a[diff[1]!] === b[diff[0]!];
}

const PLACEHOLDER_NUMBER = /^(0+|NA|N\/A|TBD|TBC|NONE|NULL|X+|UNKNOWN|INVOICE|INV|-+|\?+)$/i;
export const isPlaceholderNumber = (n: InvoiceNumberInfo) => !n.compact || PLACEHOLDER_NUMBER.test(n.raw.replace(/\s+/g, "")) || PLACEHOLDER_NUMBER.test(n.compact);

// ---- suppliers --------------------------------------------------------------------------------

export function supplierRef(id: string | undefined | null, name: string | undefined | null): SupplierRef {
  const cleanName = name ? collapse(name) : null;
  const key = cleanName ? normalizeCompanyName(cleanName).key : null;
  return { id: id ? collapse(id).toUpperCase() : null, name: cleanName, nameKey: key || null };
}
export const supplierKnown = (s: SupplierRef) => Boolean(s.id || s.nameKey);

/** "same" / "different" / "unknown". Ids are authoritative when both sides carry one; otherwise
 *  names are compared with the deterministic company-name similarity (legal forms ignored). */
export function sameSupplier(a: SupplierRef, b: SupplierRef, aliases: readonly string[] = []): "same" | "different" | "unknown" {
  if (a.id && b.id) return a.id === b.id ? "same" : "different";
  if (!a.name || !b.name) return "unknown";
  if (a.nameKey && a.nameKey === b.nameKey) return "same";
  for (const candidate of [b.name, ...aliases]) {
    if (companyNameSimilarity(a.name, candidate) >= THRESHOLDS.supplierNameMatch) return "same";
  }
  return "different";
}

// ---- payment details --------------------------------------------------------------------------

/** Upper-case, spaces/dashes/dots/slashes removed ("GB29 NWBK-6016.1331" → "GB29NWBK60161331"). */
export const accountKey = (raw: string) => collapse(raw).toUpperCase().replace(/[\s\-./_]/g, "");
/** "****6789" — never more than the last 4 characters; very short identifiers are fully masked. */
export function maskAccount(key: string | null): string | null {
  if (!key) return null;
  return key.length <= 6 ? "****" : `****${key.slice(-4)}`;
}

// ---- dates ------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;
/** Parses YYYY-MM-DD or a full ISO 8601 date-time into a UTC day number (days since epoch).
 *  Calendar-validated (2026-02-30 is rejected). null = invalid. */
export function parseDay(raw: string): number | null {
  const s = raw.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(s);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (s.length > 10) {
    const t = Date.parse(s);
    if (Number.isNaN(t)) return null;
    // A date-time: use its UTC calendar date, but still require the stated date to be real.
  }
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  if (s.length > 10) return Math.floor(Date.parse(s) / DAY_MS);
  return Math.floor(t / DAY_MS);
}
export const dayToIso = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);
export const todayDay = () => Math.floor(Date.now() / DAY_MS);
