import { THRESHOLDS } from "../config.js";
import { out, sum } from "../money.js";
import { dayToIso } from "../text.js";
import type { AnalysisContext, Anomaly } from "../types.js";
import { round2 } from "./common.js";
import { lineSetSimilarity } from "./duplicates.js";

/**
 * SPLIT_INVOICE_PATTERN — a risk indicator (never an allegation) that a purchase may have been
 * divided into several invoices so each stays at or below the single-invoice approval threshold.
 * Requires approvalContext.approvalThreshold and same-supplier history. Two patterns:
 *  1. Split group: this invoice plus same-supplier active invoices within splitWindowDays (default 7)
 *     are each ≤ the threshold but together exceed it. Confidence 0.5, +0.15 when all fall within
 *     one day, +0.15 when their line items are similar (≥ 0.5) or share the PO, +0.1 when every
 *     piece is ≥ 85% of the threshold ("just under"); high severity from 0.7.
 *  2. Repeated just-below: ≥ 3 invoices (incl. this one) in [90%, 100%] of the threshold within
 *     90 days — medium, 0.6.
 * Invoices already matched as possible duplicates are excluded (a duplicate is not a split).
 */
export function checkSplitInvoices(ctx: AnalysisContext): { anomalies: Anomaly[]; notes: string[] } {
  const { req } = ctx;
  const inv = req.invoice;
  const a = req.approval;
  const notes: string[] = [];
  if (!a || a.threshold === null) return { anomalies: [], notes };
  const T = a.threshold;
  const cur = inv.currency;
  if (a.currency && cur && a.currency !== cur) { notes.push("Split-invoice detection was skipped: the approval threshold currency differs from the invoice currency."); return { anomalies: [], notes }; }
  if (inv.total > T || inv.invoiceDate === null) {
    if (inv.invoiceDate === null) notes.push("Split-invoice detection needs invoice.invoiceDate.");
    return { anomalies: [], notes };
  }
  if (!ctx.supplierKnown) { notes.push("Split-invoice detection needs the invoice supplier (supplierId or supplierName)."); return { anomalies: [], notes }; }
  const pool = ctx.activeSupplierHistory.filter(h => !ctx.duplicateMatchIndexes.has(h.index) && h.invoiceDate !== null && (!h.currency || !cur || h.currency === cur));

  const window = a.splitWindowDays;
  const group = pool.filter(h => Math.abs(h.invoiceDate! - inv.invoiceDate!) <= window && h.total <= T);
  if (group.length > 0) {
    const combined = inv.total + sum(group.map(h => h.total));
    if (combined > T) {
      const dates = [inv.invoiceDate, ...group.map(h => h.invoiceDate!)];
      const sameDay = Math.max(...dates) - Math.min(...dates) <= 1;
      const sims = group.map(h => lineSetSimilarity(inv.lines, h.lines)).filter((s): s is number => s !== null);
      const avgSim = sims.length ? round2(sims.reduce((x, y) => x + y, 0) / sims.length) : null;
      const samePo = Boolean(inv.poNumber) && group.some(h => h.poNumber === inv.poNumber);
      const justUnder = [inv.total, ...group.map(h => h.total)].every(t => Number(t) >= Number(T) * THRESHOLDS.splitJustUnderShare);
      const confidence = round2(Math.min(0.95, 0.5 + (sameDay ? 0.15 : 0) + ((avgSim !== null && avgSim >= 0.5) || samePo ? 0.15 : 0) + (justUnder ? 0.1 : 0)));
      const signals = ["same_supplier", `within_${window}_days`, "each_invoice_at_or_below_threshold", "combined_amount_above_threshold",
        ...(sameDay ? ["same_or_adjacent_dates"] : []), ...(avgSim !== null && avgSim >= 0.5 ? ["similar_line_items"] : []), ...(samePo ? ["same_po_number"] : []), ...(justUnder ? ["all_just_under_threshold"] : [])];
      return { notes, anomalies: [{
        code: "SPLIT_INVOICE_PATTERN", severity: confidence >= 0.7 ? "high" : "medium", confidence, field: "total",
        explanation: `${group.length + 1} invoices from this supplier within ${window} day(s) are each at or below the approval threshold but together total ${out(combined, cur)} ${cur ?? ""}`.trim()
          + ", above it. This pattern can indicate a purchase split to stay under an approval limit and should be verified; it is not by itself evidence of wrongdoing.",
        evidence: {
          pattern: "split_group_below_threshold", approvalThreshold: out(T, cur), combinedAmount: out(combined, cur), invoiceCount: group.length + 1,
          relatedInvoices: group.slice(0, 20).map(h => ({ historicalIndex: h.index, invoiceNumber: h.rawNumber, invoiceDate: dayToIso(h.invoiceDate!), total: out(h.total, cur) })),
          averageLineItemSimilarity: avgSim, samePoNumber: samePo, allJustUnderThreshold: justUnder, signals, currency: cur
        }
      }] };
    }
  }

  const band = (t: bigint) => Number(t) >= Number(T) * THRESHOLDS.repeatedBelowShare && t <= T;
  if (band(inv.total)) {
    const near = pool.filter(h => Math.abs(h.invoiceDate! - inv.invoiceDate!) <= THRESHOLDS.repeatedBelowWindowDays && band(h.total));
    if (near.length + 1 >= THRESHOLDS.repeatedBelowMinCount) {
      return { notes, anomalies: [{
        code: "SPLIT_INVOICE_PATTERN", severity: "medium", confidence: 0.6, field: "total",
        explanation: `${near.length + 1} invoices from this supplier within ${THRESHOLDS.repeatedBelowWindowDays} days fall just below the approval threshold (90–100% of it). Repeated just-below amounts warrant a check that approval limits are being applied as intended.`,
        evidence: {
          pattern: "repeated_just_below_threshold", approvalThreshold: out(T, cur), bandLower: out(T * 9n / 10n, cur), invoiceCount: near.length + 1,
          relatedInvoices: near.slice(0, 20).map(h => ({ historicalIndex: h.index, invoiceNumber: h.rawNumber, invoiceDate: dayToIso(h.invoiceDate!), total: out(h.total, cur) })), currency: cur
        }
      }] };
    }
  }
  return { anomalies: [], notes };
}
