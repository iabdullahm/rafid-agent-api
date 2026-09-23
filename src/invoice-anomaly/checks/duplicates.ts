import { THRESHOLDS } from "../config.js";
import { abs, minorUnit, out, pctDiff, type Dec } from "../money.js";
import { dayToIso, jaccard, numberRelation, sameSupplier, type NumberRelation } from "../text.js";
import type { AnalysisContext, Anomaly, NormHistorical, NormLine, Severity } from "../types.js";
import { round2 } from "./common.js";

/** Symmetric line-set similarity (0–1): each line's best description match on the other invoice,
 *  averaged both ways. null when either side has no described lines. */
export function lineSetSimilarity(a: readonly NormLine[], b: readonly NormLine[]): number | null {
  const la = a.filter(l => l.tokens.size > 0), lb = b.filter(l => l.tokens.size > 0);
  if (la.length === 0 || lb.length === 0) return null;
  const oneWay = (x: readonly NormLine[], y: readonly NormLine[]) => x.reduce((acc, l) => acc + Math.max(...y.map(m => jaccard(l.tokens, m.tokens))), 0) / x.length;
  return round2((oneWay(la, lb) + oneWay(lb, la)) / 2);
}

interface Candidate {
  code: "DUPLICATE_INVOICE" | "POSSIBLE_DUPLICATE";
  severity: Severity;
  confidence: number;
  reason: string;
  record: NormHistorical | null;
  signals: string[];
  relation: NumberRelation;
  dateDiff: number | null;
  amountDiffPct: number | null;
  lineSim: number | null;
  samePo: boolean;
  recurring: boolean;
  paymentIndex: number | null;
}

/**
 * Duplicate detection against supplied history (and payment history). Conservative by design:
 *  - DUPLICATE_INVOICE only when the same supplier's active invoice carries the same (or the same
 *    digits of the) invoice number AND the same amount — or a recorded payment does.
 *  - POSSIBLE_DUPLICATE for weaker combinations: same supplier + same amount within the duplicate
 *    window plus a corroborating signal (invoice-number variant such as a suffix or typo, similar
 *    number, same line items, same PO), same supplier + same amount within 3 days, a reused invoice
 *    number with a different amount, a resubmission of a cancelled/rejected invoice, or the same
 *    number and amount recorded under another supplier record.
 *  - False-positive resistance: ordinary next-in-sequence numbers are not corroboration, and when
 *    the supplier bills the same amount repeatedly (rent, subscriptions) a near match needs a strong
 *    number signal or a ≤ 2-day gap.
 */
export function checkDuplicates(ctx: AnalysisContext): Anomaly[] {
  const { req } = ctx;
  const inv = req.invoice;
  const tol: Dec = req.options.roundingTolerance !== null ? abs(req.options.roundingTolerance) : minorUnit(inv.currency);
  const window = req.options.duplicateWindowDays;
  const aliases = req.profile?.aliases ?? [];
  const candidates: Candidate[] = [];
  const supplierIdx = new Set(ctx.supplierHistory.map(h => h.index));

  const sameAmountCount = (exclude: number) => ctx.activeSupplierHistory.filter(h => h.index !== exclude && sameCurrency(inv.currency, h.currency) && abs(h.total - inv.total) <= tol).length;

  for (const h of req.history) {
    if (inv.invoiceId && h.invoiceId && inv.invoiceId === h.invoiceId) continue; // the same record
    const relation = numberRelation(inv.number, h.number);
    const supplier = supplierIdx.has(h.index) ? "same" : sameSupplier(inv.supplier, h.supplier, aliases);
    const amountEqual = sameCurrency(inv.currency, h.currency) && abs(inv.total - h.total) <= tol;
    const dateDiff = inv.invoiceDate !== null && h.invoiceDate !== null ? Math.abs(inv.invoiceDate - h.invoiceDate) : null;
    const samePo = Boolean(inv.poNumber && inv.poNumber === h.poNumber);
    let lineSim: number | null | undefined;
    const lines = () => (lineSim === undefined ? (lineSim = lineSetSimilarity(inv.lines, h.lines)) : lineSim);
    const base = { record: h, relation, dateDiff, amountDiffPct: sameCurrency(inv.currency, h.currency) ? pctDiff(inv.total, h.total, h.total) : null, samePo, paymentIndex: null };
    const push = (c: Omit<Candidate, keyof typeof base | "lineSim" | "recurring"> & { recurring?: boolean }) =>
      candidates.push({ ...base, lineSim: lines(), ...c, recurring: c.recurring ?? false });

    if (supplier === "same") {
      if (relation === "identical" || relation === "equivalent") {
        if (amountEqual && !h.inactive) {
          push({ code: "DUPLICATE_INVOICE", severity: "high", confidence: relation === "identical" ? 0.98 : 0.93, reason: "same_supplier_same_invoice_number_same_amount", signals: ["same_supplier", `invoice_number_${relation}`, "same_amount"] });
        } else if (amountEqual) {
          push({ code: "POSSIBLE_DUPLICATE", severity: "medium", confidence: 0.6, reason: `resubmission_of_${h.status}_invoice`, signals: ["same_supplier", `invoice_number_${relation}`, "same_amount", `matched_invoice_${h.status}`] });
        } else {
          push({ code: "POSSIBLE_DUPLICATE", severity: h.inactive ? "low" : "medium", confidence: h.inactive ? 0.5 : 0.7, reason: "invoice_number_reused_with_different_amount", signals: ["same_supplier", `invoice_number_${relation}`, "different_amount"] });
        }
        continue;
      }
      if (!amountEqual) continue;
      const recurring = sameAmountCount(h.index) >= THRESHOLDS.recurringSameAmountMin;
      const ls = lines();
      const corroboration = [
        ...(relation === "variant" ? ["invoice_number_variant"] : relation === "similar" ? ["similar_invoice_number"] : []),
        ...(ls !== null && ls >= THRESHOLDS.lineSimilarityStrong ? ["same_line_items"] : []),
        ...(samePo ? ["same_po_number"] : [])
      ];
      const signals = ["same_supplier", "same_amount", ...(dateDiff !== null ? [`date_gap_${dateDiff}_days`] : []), ...corroboration];
      if (dateDiff === null) {
        if (relation === "variant" || (ls !== null && ls >= THRESHOLDS.lineSimilarityStrong && samePo))
          push({ code: "POSSIBLE_DUPLICATE", severity: "medium", confidence: 0.6, reason: "same_supplier_same_amount_dates_unknown", signals, recurring });
        continue;
      }
      if (dateDiff > window) continue;
      if (relation === "variant") {
        push({ code: "POSSIBLE_DUPLICATE", severity: "high", confidence: 0.9, reason: "invoice_number_variant_same_amount", signals, recurring });
      } else if (!recurring && corroboration.length > 0) {
        push({ code: "POSSIBLE_DUPLICATE", severity: "high", confidence: Math.min(0.9, 0.75 + 0.05 * corroboration.length + (dateDiff <= THRESHOLDS.uncorroboratedDuplicateDays ? 0.05 : 0)), reason: "same_supplier_same_amount_nearby_date_corroborated", signals, recurring });
      } else if (!recurring && dateDiff <= THRESHOLDS.uncorroboratedDuplicateDays) {
        push({ code: "POSSIBLE_DUPLICATE", severity: "medium", confidence: 0.6, reason: "same_supplier_same_amount_nearby_date", signals, recurring });
      } else if (recurring && dateDiff <= 2 && corroboration.length > 0) {
        push({ code: "POSSIBLE_DUPLICATE", severity: "medium", confidence: 0.55, reason: "recurring_amount_invoiced_twice_within_days", signals: [...signals, "recurring_amount_pattern"], recurring });
      }
    } else if (relation === "identical" && amountEqual && (dateDiff === null || dateDiff <= Math.max(window, 30))) {
      push({ code: "POSSIBLE_DUPLICATE", severity: "medium", confidence: supplier === "unknown" ? 0.7 : 0.6, reason: "same_number_and_amount_under_different_supplier_record", signals: [`supplier_${supplier}`, "invoice_number_identical", "same_amount"] });
    }
  }

  // Recorded payments for the same invoice number (already paid).
  for (const p of req.payments) {
    const relation = numberRelation(inv.number, p.number);
    if (relation !== "identical" && relation !== "equivalent") continue;
    const supplier = sameSupplier(inv.supplier, p.supplier, aliases);
    if (supplier === "different") continue;
    const amountEqual = p.amount !== null && sameCurrency(inv.currency, p.currency) && abs(inv.total - p.amount) <= tol;
    const base = { record: null, relation, dateDiff: inv.invoiceDate !== null && p.paymentDate !== null ? Math.abs(inv.invoiceDate - p.paymentDate) : null,
      amountDiffPct: p.amount !== null && sameCurrency(inv.currency, p.currency) ? pctDiff(inv.total, p.amount, p.amount) : null, samePo: false, lineSim: null, recurring: false, paymentIndex: p.index };
    if (amountEqual && supplier === "same") candidates.push({ ...base, code: "DUPLICATE_INVOICE", severity: "high", confidence: 0.92, reason: "invoice_number_and_amount_already_paid", signals: ["same_supplier", `invoice_number_${relation}`, "same_amount", "payment_recorded"] });
    else candidates.push({ ...base, code: "POSSIBLE_DUPLICATE", severity: "medium", confidence: amountEqual ? 0.7 : 0.6, reason: "invoice_number_already_paid", signals: [`supplier_${supplier}`, `invoice_number_${relation}`, amountEqual ? "same_amount" : "amount_differs_or_unknown", "payment_recorded"] });
  }

  const rank = (c: Candidate) => [c.severity === "high" ? 1 : 0, c.confidence, -(c.dateDiff ?? 9999)];
  const better = (a: Candidate, b: Candidate) => { const ra = rank(a), rb = rank(b); for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i]! > rb[i]!; return false; };
  const best = (code: Candidate["code"], exclude: Candidate | null) => candidates.filter(c => c.code === code && (!exclude || c.record === null || c.record !== exclude.record))
    .reduce<Candidate | null>((m, c) => (m === null || better(c, m) ? c : m), null);

  const dup = best("DUPLICATE_INVOICE", null);
  const possible = best("POSSIBLE_DUPLICATE", dup);
  for (const c of candidates) if (c.record && c.confidence >= 0.55) ctx.duplicateMatchIndexes.add(c.record.index);

  const paidNumbers = (h: NormHistorical | null) => h !== null && req.payments.some(p => {
    const r = numberRelation(h.number, p.number);
    return (r === "identical" || r === "equivalent") && sameSupplier(h.supplier, p.supplier, aliases) !== "different";
  });
  const toAnomaly = (c: Candidate): Anomaly => {
    const others = candidates.filter(x => x !== c && x.code === c.code).length;
    const h = c.record;
    const p = c.paymentIndex !== null ? req.payments[c.paymentIndex]! : null;
    return {
      code: c.code, severity: c.severity, confidence: round2(c.confidence), field: "invoiceNumber",
      explanation: c.code === "DUPLICATE_INVOICE"
        ? (p ? "A payment is already recorded for this supplier, invoice number and amount." : "An invoice from the same supplier with the same invoice number and amount already exists in the supplied history.")
        : explainPossible(c),
      evidence: {
        reason: c.reason,
        matchSignals: c.signals,
        matchedInvoice: h ? {
          historicalIndex: h.index, invoiceId: h.invoiceId, invoiceNumber: h.rawNumber, supplierName: h.supplier.name,
          invoiceDate: h.invoiceDate === null ? null : dayToIso(h.invoiceDate), total: out(h.total, h.currency ?? inv.currency), currency: h.currency, status: h.status
        } : null,
        matchedPayment: p ? { paymentIndex: p.index, invoiceNumber: p.number?.raw ?? null, paymentDate: p.paymentDate === null ? null : dayToIso(p.paymentDate), amount: p.amount === null ? null : out(p.amount, p.currency ?? inv.currency), currency: p.currency } : null,
        invoiceNumberRelation: c.relation,
        amountDifferencePercent: c.amountDiffPct,
        dateDifferenceDays: c.dateDiff,
        lineItemSimilarity: c.lineSim,
        samePoNumber: c.samePo,
        recurringAmountPattern: c.recurring,
        previouslyPaid: p !== null || paidNumbers(h),
        additionalMatches: others
      }
    };
  };
  return [dup, possible].filter((c): c is Candidate => c !== null).map(toAnomaly);
}

function explainPossible(c: Candidate): string {
  switch (c.reason) {
    case "invoice_number_reused_with_different_amount": return "The same supplier has already used this invoice number on an invoice with a different amount; the invoice number may have been reused.";
    case "same_number_and_amount_under_different_supplier_record": return "An invoice with the same number and amount exists under a different or unidentified supplier record; it may be the same invoice entered against another vendor record.";
    case "invoice_number_already_paid": return "A payment is already recorded against this invoice number.";
    case "invoice_number_variant_same_amount": return "A same-supplier invoice with the same amount and a slightly altered invoice number (e.g. suffix or typo) was found nearby in time.";
    default:
      if (c.reason.startsWith("resubmission_of_")) return "This invoice repeats the number and amount of an invoice that was previously cancelled, voided or rejected; confirm it is a legitimate resubmission.";
      return "A highly similar invoice from the same supplier (same amount, nearby date) was found in the supplied history.";
  }
}

export const sameCurrency = (a: string | null, b: string | null) => !a || !b || a === b;
