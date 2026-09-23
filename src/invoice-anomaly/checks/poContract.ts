import { THRESHOLDS } from "../config.js";
import { abs, minorUnit, out, percentOf, sum, type Dec } from "../money.js";
import { jaccard, sameSupplier } from "../text.js";
import type { AnalysisContext, Anomaly, Issue } from "../types.js";
import { linesSum } from "./arithmetic.js";
import { fold, round2 } from "./common.js";

/** Net invoice amount (subtotal − discount), falling back to the line sum; null if unknown. */
function netAmount(ctx: AnalysisContext): Dec | null {
  const inv = ctx.req.invoice;
  const base = inv.subtotal ?? linesSum(inv);
  return base === null ? null : base - (inv.discount ?? 0n);
}

/**
 * Purchase-order, contract and approval-limit checks (only when that context is supplied).
 *  PO_MISMATCH            supplier / currency / PO reference / PO status / quantity above ordered /
 *                         unit price above PO price / lines not on the PO
 *  PO_AMOUNT_EXCEEDED     invoice amount above the remaining PO balance
 *  CONTRACT_LIMIT_EXCEEDED  cumulative invoicing above the contract cap, or a single invoice above
 *                         the contract's per-invoice maximum
 *  APPROVAL_THRESHOLD_EXCEEDED  (info) the invoice exceeds the single-invoice approval threshold —
 *                         routing information, not a risk signal; contributes no score
 */
export function checkPoContract(ctx: AnalysisContext): { anomalies: Anomaly[]; notes: string[] } {
  const { req } = ctx;
  const inv = req.invoice;
  const cur = inv.currency;
  const anomalies: Anomaly[] = [];
  const notes: string[] = [];
  const aliases = req.profile?.aliases ?? [];
  const tol = req.options.roundingTolerance !== null ? abs(req.options.roundingTolerance) : minorUnit(cur);
  const push = (a: Anomaly | null) => { if (a) anomalies.push(a); };

  const po = req.purchaseOrder;
  if (po) {
    const issues: Issue[] = [];
    if (po.poNumber && inv.poNumber && po.poNumber !== inv.poNumber)
      issues.push({ reason: "po_number_differs", severity: "medium", confidence: 0.9, detail: { invoicePoNumber: inv.poNumber, purchaseOrderNumber: po.poNumber } });
    if (po.poNumber && !inv.poNumber)
      issues.push({ reason: "invoice_missing_po_reference", severity: "low", confidence: 0.9, detail: { purchaseOrderNumber: po.poNumber } });
    if (sameSupplier(inv.supplier, po.supplier, aliases) === "different")
      issues.push({ reason: "supplier_differs_from_po", severity: "high", confidence: 0.9, detail: { invoiceSupplier: inv.supplier.name ?? inv.supplier.id, poSupplier: po.supplier.name ?? po.supplier.id } });
    if (po.currency && cur && po.currency !== cur)
      issues.push({ reason: "currency_differs_from_po", severity: "high", confidence: 0.95, detail: { invoiceCurrency: cur, poCurrency: po.currency } });
    if (po.status === "closed" || po.status === "cancelled")
      issues.push({ reason: `po_${po.status}`, severity: po.status === "cancelled" ? "high" : "medium", confidence: 0.95, detail: { poStatus: po.status } });

    // Line-level comparison (SKU first, else best description match).
    if (po.lines.length > 0 && inv.lines.length > 0) {
      const qtyIssues: Record<string, unknown>[] = [], priceIssues: Record<string, unknown>[] = [], unmatched: Record<string, unknown>[] = [];
      for (const l of inv.lines) {
        let match = l.sku ? po.lines.find(p => p.sku === l.sku) : undefined;
        if (!match && l.tokens.size > 0) {
          let bestScore = 0;
          for (const p of po.lines) { const s = jaccard(l.tokens, p.tokens); if (s > bestScore) { bestScore = s; match = p; } }
          if (bestScore < THRESHOLDS.poLineMatchSimilarity) match = undefined;
        }
        if (!match) { unmatched.push({ lineIndex: l.index, description: l.description }); continue; }
        if (l.quantity !== null && match.quantity !== null && l.quantity > match.quantity)
          qtyIssues.push({ lineIndex: l.index, description: l.description, invoicedQuantity: out(l.quantity, null, 4), orderedQuantity: out(match.quantity, null, 4), poLineIndex: match.index });
        if (l.unitPrice !== null && match.unitPrice !== null) {
          const allowed = match.unitPrice + percentOf(match.unitPrice, THRESHOLDS.poUnitPriceTolerancePct) + tol;
          if (l.unitPrice > allowed) priceIssues.push({ lineIndex: l.index, description: l.description, invoicedUnitPrice: out(l.unitPrice, cur, 2), poUnitPrice: out(match.unitPrice, cur, 2), poLineIndex: match.index });
        }
      }
      if (qtyIssues.length) issues.push({ reason: "quantity_exceeds_ordered", severity: "medium", confidence: 0.85, detail: { lines: qtyIssues.slice(0, 20), lineCount: qtyIssues.length } });
      if (priceIssues.length) issues.push({ reason: "unit_price_above_po", severity: "medium", confidence: 0.85, detail: { lines: priceIssues.slice(0, 20), lineCount: priceIssues.length } });
      if (unmatched.length) issues.push({ reason: "lines_not_on_po", severity: "low", confidence: 0.6, detail: { lines: unmatched.slice(0, 20), lineCount: unmatched.length } });
    }
    push(fold("PO_MISMATCH", "poNumber", issues, top => ({
      po_number_differs: "The invoice references a different purchase order than the one supplied.",
      invoice_missing_po_reference: "The invoice does not reference the purchase order it is being matched against.",
      supplier_differs_from_po: "The invoice supplier differs from the purchase order supplier.",
      currency_differs_from_po: "The invoice currency differs from the purchase order currency.",
      po_closed: "The purchase order is closed.",
      po_cancelled: "The purchase order is cancelled.",
      quantity_exceeds_ordered: "Invoiced quantities exceed the quantities ordered on the purchase order.",
      unit_price_above_po: "Invoiced unit prices are above the purchase order prices.",
      lines_not_on_po: "Some invoice lines could not be matched to purchase order lines."
    } as Record<string, string>)[top.reason] ?? "The invoice does not match the purchase order."));

    // Remaining PO balance.
    const amount = po.amountsIncludeTax ? inv.total : netAmount(ctx);
    const currencyOk = !po.currency || !cur || po.currency === cur;
    const remaining = po.remainingAmount ?? (po.totalAmount !== null ? po.totalAmount - (po.invoicedToDate ?? 0n) : null);
    if (amount !== null && remaining !== null && currencyOk) {
      if (amount > remaining + tol) {
        const reference = po.totalAmount ?? remaining;
        const excess = amount - remaining;
        const excessPct = reference > 0n ? round2(Number(excess) / Number(reference) * 100) : null;
        const high = remaining <= 0n || excessPct === null || excessPct > THRESHOLDS.limitExcessHighPct;
        const basis = po.remainingAmount !== null ? "remainingAmount" : po.invoicedToDate !== null ? "totalAmount_minus_invoicedToDate" : "totalAmount_only";
        push(fold("PO_AMOUNT_EXCEEDED", "total", [{
          reason: remaining <= 0n ? "po_fully_consumed" : "exceeds_remaining_po_balance", severity: high ? "high" : "medium", confidence: basis === "totalAmount_only" ? 0.85 : 0.95,
          detail: { invoiceAmount: out(amount, cur), amountBasis: po.amountsIncludeTax ? "total" : "net", remainingPoBalance: out(remaining, cur), poTotalAmount: po.totalAmount === null ? null : out(po.totalAmount, cur),
            excessAmount: out(excess, cur), excessPercentOfPo: excessPct, remainingBasis: basis, currency: cur }
        }], top => `The invoice amount exceeds the remaining purchase-order balance by ${top.detail.excessAmount} ${cur ?? ""}`.trim() + "."));
      }
    } else if (!currencyOk) notes.push("PO balance was not compared because the invoice and purchase order currencies differ.");
    else if (remaining === null) notes.push("PO balance was not checked: the purchase order has no totalAmount or remainingAmount.");
  }

  const c = req.contract;
  if (c) {
    const currencyOk = !c.currency || !cur || c.currency === cur;
    const issues: Issue[] = [];
    if (currencyOk && c.maxInvoiceAmount !== null && inv.total > c.maxInvoiceAmount + tol) {
      const excessPct = c.maxInvoiceAmount > 0n ? round2(Number(inv.total - c.maxInvoiceAmount) / Number(c.maxInvoiceAmount) * 100) : null;
      issues.push({ reason: "invoice_above_contract_per_invoice_maximum", severity: excessPct !== null && excessPct <= THRESHOLDS.limitExcessHighPct ? "medium" : "high", confidence: 0.95,
        detail: { invoiceTotal: out(inv.total, cur), maxInvoiceAmount: out(c.maxInvoiceAmount, cur), excessPercent: excessPct } });
    }
    if (currencyOk && c.maxAmount !== null) {
      let consumed: Dec, basis: string, confidence: number;
      if (c.invoicedToDate !== null) { consumed = c.invoicedToDate; basis = "caller_supplied_invoicedToDate"; confidence = 0.95; }
      else {
        const inPeriod = ctx.activeSupplierHistory.filter(h => !ctx.duplicateMatchIndexes.has(h.index)
          && (!h.currency || !cur || h.currency === cur)
          && (h.invoiceDate === null || ((c.startDate === null || h.invoiceDate >= c.startDate) && (c.endDate === null || h.invoiceDate <= c.endDate))));
        consumed = sum(inPeriod.map(h => h.total));
        basis = inPeriod.length > 0 ? `sum_of_${inPeriod.length}_supplied_historical_invoices` : "this_invoice_only";
        confidence = inPeriod.length > 0 ? 0.75 : 0.9;
      }
      const cumulative = consumed + inv.total;
      if (cumulative > c.maxAmount + tol) {
        const excess = cumulative - c.maxAmount;
        const excessPct = c.maxAmount > 0n ? round2(Number(excess) / Number(c.maxAmount) * 100) : null;
        issues.push({ reason: "cumulative_invoicing_exceeds_contract_cap", severity: excessPct !== null && excessPct <= THRESHOLDS.limitExcessHighPct ? "medium" : "high", confidence,
          detail: { contractCap: out(c.maxAmount, cur), invoicedBeforeThisInvoice: out(consumed, cur), invoiceTotal: out(inv.total, cur), cumulativeAmount: out(cumulative, cur), excessAmount: out(excess, cur), excessPercentOfCap: excessPct, consumedBasis: basis } });
      }
    }
    if (!currencyOk) notes.push("Contract limits were not compared because the invoice and contract currencies differ.");
    push(fold("CONTRACT_LIMIT_EXCEEDED", "total", issues, top => top.reason === "invoice_above_contract_per_invoice_maximum"
      ? "The invoice total exceeds the contract's maximum amount per invoice."
      : `Cumulative invoicing under the contract would exceed the contract cap by ${top.detail.excessAmount} ${cur ?? ""}`.trim() + "."));
  }

  const a = req.approval;
  if (a?.threshold != null) {
    const currencyOk = !a.currency || !cur || a.currency === cur;
    if (currencyOk && inv.total > a.threshold) {
      anomalies.push({ code: "APPROVAL_THRESHOLD_EXCEEDED", severity: "info", confidence: 1, field: "total",
        explanation: "The invoice total is above the single-invoice approval threshold; route it for the corresponding approval level.",
        evidence: { invoiceTotal: out(inv.total, cur), approvalThreshold: out(a.threshold, cur), currency: cur } });
    }
  }
  return { anomalies, notes };
}
