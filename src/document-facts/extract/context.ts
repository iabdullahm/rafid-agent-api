import type { DocumentType } from "../../schemas/documentFactsInputs.js";
import type { DocumentModel, SourceEvidence } from "../document.js";
import type { DecimalStyle } from "../normalize.js";

/** Shared state for one extraction run. */
export interface ExtractionContext {
  doc: DocumentModel;
  type: DocumentType;
  subtype: string | null;
  dateOrder: "dmy" | "mdy" | null;
  decimalStyle: DecimalStyle;
  /** Currency declared by an explicit "Currency: XXX" field, applied to bare labeled amounts. */
  declaredCurrency: { code: string; evidence: SourceEvidence } | null;
  /** Character ranges of text addressed to AI systems (prompt-injection-like); excluded from
   *  obligations/requirements/facts so a downstream agent never receives them as actionable data. */
  suspiciousRanges: [number, number][];
  warnings: string[];
}

export function inSuspicious(ctx: ExtractionContext, start: number, end = start + 1): boolean {
  return ctx.suspiciousRanges.some(([s, e]) => start < e && end > s);
}

export type ContextRule<T extends string> = readonly [T, RegExp];

/**
 * The context-classification primitive: finds, within the value's sentence (and, for label-above
 * table layouts, the previous line), the rule whose keyword occurs NEAREST to the value, preferring
 * the left side. Returns the rule's type and the keyword distance (smaller = more certain).
 */
export function nearestRule<T extends string>(doc: DocumentModel, start: number, end: number, rules: readonly ContextRule<T>[], opts: { left?: number; right?: number } = {}): { type: T; distance: number } | null {
  const left = opts.left ?? 100, right = opts.right ?? 40;
  const text = doc.text;
  const sentence = doc.sentenceAt(start);
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lineEndIdx = text.indexOf("\n", end);
  const lineEnd = lineEndIdx === -1 ? text.length : lineEndIdx;
  const sStart = Math.min(sentence?.start ?? lineStart, lineStart);
  let leftText = text.slice(Math.max(sStart, start - left), start).toLowerCase();
  // Label-above layout: nothing but punctuation/space before the value on its line → use previous line.
  if (!/\p{L}{2,}/u.test(text.slice(lineStart, start)) && lineStart > 0) {
    const prevStart = text.lastIndexOf("\n", lineStart - 2) + 1;
    leftText = (text.slice(prevStart, lineStart - 1) + " ").toLowerCase().slice(-left);
  }
  // Measure distance from the keyword's end, ignoring label punctuation ("Due Date: ").
  leftText = leftText.replace(/[\s:：=|–—-]+$/u, "");
  const sEnd = Math.max(sentence?.end ?? lineEnd, end);
  const rightText = text.slice(end, Math.min(sEnd, lineEnd, end + right)).toLowerCase();
  let best: { type: T; distance: number } | null = null;
  for (const [type, re] of rules) {
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let lastIdx = -1;
    for (const m of leftText.matchAll(g)) lastIdx = m.index! + m[0].length;
    if (lastIdx >= 0) {
      const d = leftText.length - lastIdx;
      if (!best || d < best.distance) best = { type, distance: d };
    }
    const r = g.exec(rightText.replace(/^[\s:–-]*/, ""));
    g.lastIndex = 0;
    if (r) {
      const d = r.index + 15; // right-side keywords are weaker evidence than left-side labels
      if (!best || d < best.distance) best = { type, distance: d };
    }
  }
  return best;
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
