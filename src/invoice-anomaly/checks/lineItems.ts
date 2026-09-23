import { out } from "../money.js";
import { jaccard } from "../text.js";
import type { Anomaly, Issue, NormInvoice } from "../types.js";
import { fold } from "./common.js";

/** Pairwise near-duplicate comparison is quadratic; above this many lines only exact repeats are checked. */
const NEAR_CHECK_MAX_LINES = 300;
const NEAR_SIMILARITY = 0.9;

/**
 * DUPLICATE_LINE_ITEM — the same line billed twice on one invoice.
 *  exact repeat: identical normalized description (or SKU), unit price and quantity → medium, 0.85
 *  near repeat:  description similarity ≥ 0.9 with the same unit price → low, 0.6
 * Repeated descriptions at DIFFERENT prices/quantities (e.g. the same service on different dates
 * with different rates) are not flagged.
 */
export function checkDuplicateLines(inv: NormInvoice): { anomalies: Anomaly[]; notes: string[] } {
  const notes: string[] = [];
  const lines = inv.lines.filter(l => l.descriptionKey || l.sku);
  const issues: Issue[] = [];
  const seen = new Map<string, number>();
  const reported = new Set<number>();
  for (const l of lines) {
    const key = `${l.sku ?? l.descriptionKey}|${l.unitPrice ?? ""}|${l.quantity ?? ""}`;
    const first = seen.get(key);
    if (first !== undefined) {
      reported.add(l.index);
      issues.push({ reason: "exact_repeat", severity: "medium", confidence: 0.85, detail: {
        lineIndexes: [first, l.index], description: l.description,
        unitPrice: l.unitPrice === null ? null : out(l.unitPrice, inv.currency, 2), quantity: l.quantity === null ? null : out(l.quantity, null, 4),
        lineTotal: l.total === null ? null : out(l.total, inv.currency)
      } });
    } else seen.set(key, l.index);
  }
  if (lines.length <= NEAR_CHECK_MAX_LINES) {
    for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i]!, b = lines[j]!;
      if (reported.has(b.index) || a.unitPrice === null || a.unitPrice !== b.unitPrice || a.descriptionKey === b.descriptionKey) continue;
      const sim = jaccard(a.tokens, b.tokens);
      if (sim >= NEAR_SIMILARITY) {
        reported.add(b.index);
        issues.push({ reason: "near_repeat", severity: "low", confidence: 0.6, detail: { lineIndexes: [a.index, b.index], descriptions: [a.description, b.description], descriptionSimilarity: Math.round(sim * 100) / 100, unitPrice: out(a.unitPrice, inv.currency, 2) } });
      }
    }
  } else notes.push(`Near-duplicate line comparison was limited to exact repeats because the invoice has more than ${NEAR_CHECK_MAX_LINES} lines.`);
  const a = fold("DUPLICATE_LINE_ITEM", "lineItems", issues, (_t, all) => `${all.length} line item(s) repeat an earlier line on the same invoice (same description and price).`, { repeatedLineCount: issues.length });
  return { anomalies: a ? [a] : [], notes };
}
