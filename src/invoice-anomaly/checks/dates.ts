import { THRESHOLDS } from "../config.js";
import { dayToIso } from "../text.js";
import type { AnalysisContext, Anomaly, Issue } from "../types.js";
import { fold } from "./common.js";

/**
 * Date checks, relative to options.asOfDate (default: today, UTC).
 *  DATE_ANOMALY      invoice dated in the future (beyond 1 day, for time zones), older than 365
 *                    days, before the purchase order was issued, or outside the contract period
 *  DUE_DATE_ANOMALY  due date before the invoice date, due date inconsistent with the stated payment
 *                    terms (> 3 days apart), or terms longer than a year
 * Legitimate edge cases are not flagged: same-day due dates, due dates in the past (late invoices),
 * and invoices dated within a day of the as-of date.
 */
export function checkDates(ctx: AnalysisContext): Anomaly[] {
  const { req } = ctx;
  const inv = req.invoice;
  const asOf = req.options.asOf;
  const d = inv.invoiceDate;
  const issues: Issue[] = [];
  if (d !== null) {
    if (d - asOf > THRESHOLDS.futureInvoiceToleranceDays)
      issues.push({ reason: "invoice_date_in_future", severity: "medium", confidence: 0.95, detail: { invoiceDate: dayToIso(d), asOfDate: dayToIso(asOf), daysAhead: d - asOf } });
    if (asOf - d > THRESHOLDS.staleInvoiceDays)
      issues.push({ reason: "invoice_older_than_one_year", severity: "low", confidence: 0.8, detail: { invoiceDate: dayToIso(d), asOfDate: dayToIso(asOf), ageDays: asOf - d } });
    const po = req.purchaseOrder;
    if (po?.issueDate != null && d < po.issueDate)
      issues.push({ reason: "invoice_dated_before_po_issue_date", severity: "medium", confidence: 0.85, detail: { invoiceDate: dayToIso(d), poIssueDate: dayToIso(po.issueDate), daysBefore: po.issueDate - d } });
    const c = req.contract;
    if (c?.startDate != null && d < c.startDate)
      issues.push({ reason: "invoice_dated_before_contract_start", severity: "medium", confidence: 0.85, detail: { invoiceDate: dayToIso(d), contractStartDate: dayToIso(c.startDate) } });
    if (c?.endDate != null && d > c.endDate)
      issues.push({ reason: "invoice_dated_after_contract_end", severity: "medium", confidence: 0.85, detail: { invoiceDate: dayToIso(d), contractEndDate: dayToIso(c.endDate) } });
  }
  const anomalies: Anomaly[] = [];
  const dateAnomaly = fold("DATE_ANOMALY", "invoiceDate", issues, top => ({
    invoice_date_in_future: `The invoice is dated ${top.detail.daysAhead} day(s) after the as-of date.`,
    invoice_older_than_one_year: `The invoice is dated ${top.detail.ageDays} days before the as-of date.`,
    invoice_dated_before_po_issue_date: "The invoice is dated before the purchase order was issued.",
    invoice_dated_before_contract_start: "The invoice is dated before the contract start date.",
    invoice_dated_after_contract_end: "The invoice is dated after the contract end date."
  } as Record<string, string>)[top.reason]!);
  if (dateAnomaly) anomalies.push(dateAnomaly);

  const due: Issue[] = [];
  if (d !== null && inv.dueDate !== null) {
    const gap = inv.dueDate - d;
    if (gap < 0) due.push({ reason: "due_date_before_invoice_date", severity: "medium", confidence: 0.95, detail: { invoiceDate: dayToIso(d), dueDate: dayToIso(inv.dueDate), daysBefore: -gap } });
    else {
      if (inv.paymentTermsDays !== null && Math.abs(gap - inv.paymentTermsDays) > THRESHOLDS.dueTermsToleranceDays)
        due.push({ reason: "due_date_inconsistent_with_payment_terms", severity: "low", confidence: 0.85, detail: { invoiceDate: dayToIso(d), dueDate: dayToIso(inv.dueDate), daysBetween: gap, paymentTermsDays: inv.paymentTermsDays } });
      if (gap > THRESHOLDS.maxReasonableTermsDays)
        due.push({ reason: "due_date_more_than_one_year_after_invoice", severity: "low", confidence: 0.7, detail: { invoiceDate: dayToIso(d), dueDate: dayToIso(inv.dueDate), daysBetween: gap } });
    }
  } else if (d === null && inv.dueDate !== null && inv.dueDate - asOf > THRESHOLDS.maxReasonableTermsDays) {
    due.push({ reason: "due_date_more_than_one_year_ahead", severity: "low", confidence: 0.6, detail: { dueDate: dayToIso(inv.dueDate), asOfDate: dayToIso(asOf) } });
  }
  const dueAnomaly = fold("DUE_DATE_ANOMALY", "dueDate", due, top => ({
    due_date_before_invoice_date: "The due date is earlier than the invoice date.",
    due_date_inconsistent_with_payment_terms: `The due date is ${top.detail.daysBetween} day(s) after the invoice date, inconsistent with the stated ${top.detail.paymentTermsDays}-day payment terms.`,
    due_date_more_than_one_year_after_invoice: "The due date is more than a year after the invoice date.",
    due_date_more_than_one_year_ahead: "The due date is more than a year after the as-of date."
  } as Record<string, string>)[top.reason]!);
  if (dueAnomaly) anomalies.push(dueAnomaly);
  return anomalies;
}
