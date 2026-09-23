import { THRESHOLDS } from "../config.js";
import { abs, minorUnit, mul, out, pctDiff, percentOf, sum, type Dec } from "../money.js";
import type { Anomaly, Issue, NormInvoice, Severity } from "../types.js";
import { fold } from "./common.js";

export interface FinancialChecks {
  subtotalValid: boolean | null;
  taxValid: boolean | null;
  totalValid: boolean | null;
  lineTotalsValid: boolean | null;
  computed: { lineItemsSum: number | null; expectedTax: number | null; expectedTotal: number | null; tolerance: number };
}

/** Net amount of a line: its stated total, else quantity × unitPrice − discount. */
export function lineNet(l: NormInvoice["lines"][number]): Dec | null {
  if (l.total !== null) return l.total;
  if (l.quantity !== null && l.unitPrice !== null) return mul(l.quantity, l.unitPrice) - (l.discount ?? 0n);
  return null;
}

/** Sum of line net amounts, or null when there are no lines or any line has no determinable amount. */
export function linesSum(inv: NormInvoice): Dec | null {
  if (inv.lines.length === 0) return null;
  const nets = inv.lines.map(lineNet);
  return nets.some(n => n === null) ? null : sum(nets as Dec[]);
}

/**
 * Arithmetic consistency, all in decimal-safe BigInt arithmetic with explicit rounding tolerances:
 *   quantity × unitPrice − discount ≈ line total          (LINE_TOTAL_MISMATCH)
 *   Σ line totals ≈ subtotal                              (SUBTOTAL_MISMATCH)
 *   Σ line total × line rate  (or base × invoice rate) ≈ tax  (TAX_MISMATCH)
 *   subtotal − discount + tax + shipping ≈ total          (TOTAL_MISMATCH)
 * Tolerance: one minor unit per rounding step (a sum of N rounded lines may drift by ceil(N/2)
 * minor units), or options.roundingTolerance when supplied. Materiality is measured against the
 * invoice total: ≤ 0.5% → low, otherwise medium.
 */
export function checkArithmetic(inv: NormInvoice, override: Dec | null): { anomalies: Anomaly[]; financialChecks: FinancialChecks; notes: string[] } {
  const cur = inv.currency;
  const minor = minorUnit(cur);
  const steps = (n: number) => minor * BigInt(Math.max(1, Math.ceil(n * THRESHOLDS.perLineRoundingMinorUnits)));
  const tol = (n: number) => (override !== null ? abs(override) : steps(n));
  const notes: string[] = [];
  const anomalies: Anomaly[] = [];
  const severityFor = (diff: Dec): Severity => {
    const pct = pctDiff(diff, 0n, inv.total);
    return pct !== null && pct <= THRESHOLDS.arithmeticMediumPct ? "low" : "medium";
  };
  const detail = (expected: Dec, stated: Dec, tolerance: Dec) => ({
    expected: out(expected, cur), stated: out(stated, cur), difference: out(stated - expected, cur),
    differencePercentOfTotal: pctDiff(stated, expected, inv.total), tolerance: out(tolerance, cur, 2), currency: cur
  });

  // Lines: quantity × unitPrice − discount vs stated line total.
  let lineChecks = 0;
  const lineIssues: Issue[] = [];
  for (const l of inv.lines) {
    if (l.total === null || l.quantity === null || l.unitPrice === null) continue;
    lineChecks++;
    const expected = mul(l.quantity, l.unitPrice) - (l.discount ?? 0n);
    const t = tol(1);
    if (abs(l.total - expected) > t) {
      lineIssues.push({ reason: "quantity_times_unit_price_differs_from_line_total", severity: severityFor(l.total - expected), confidence: 0.95,
        detail: { lineIndex: l.index, description: l.description, quantity: Number(out(l.quantity, null, 4)), unitPrice: out(l.unitPrice, cur, 2), ...detail(expected, l.total, t) } });
    }
  }
  const lineTotalsValid = lineChecks === 0 ? null : lineIssues.length === 0;
  const lineAnomaly = fold("LINE_TOTAL_MISMATCH", "lineItems", lineIssues,
    (_top, all) => `${all.length} line item(s) have a line total that does not equal quantity × unit price − discount beyond rounding tolerance.`,
    { mismatchedLineCount: lineIssues.length, linesChecked: lineChecks });
  if (lineAnomaly) anomalies.push(lineAnomaly);

  // Subtotal.
  const lineSum = linesSum(inv);
  let subtotalValid: boolean | null = null;
  if (inv.subtotal !== null && lineSum !== null) {
    const t = tol(inv.lines.length);
    subtotalValid = abs(inv.subtotal - lineSum) <= t;
    if (!subtotalValid) {
      anomalies.push(fold("SUBTOTAL_MISMATCH", "subtotal", [{ reason: "subtotal_differs_from_sum_of_line_items", severity: severityFor(inv.subtotal - lineSum), confidence: 0.95, detail: { ...detail(lineSum, inv.subtotal, t), lineCount: inv.lines.length } }],
        top => `The stated subtotal differs from the sum of the ${inv.lines.length} line item(s) by ${top.detail.difference} ${cur ?? ""}`.trim() + ".")!);
    }
  }

  // Tax.
  const base = inv.subtotal ?? lineSum;
  let expectedTax: Dec | null = null;
  const linesWithRate = inv.lines.filter(l => l.taxRate !== null).length;
  if (linesWithRate > 0) {
    if (inv.discount !== null && inv.discount !== 0n) {
      notes.push("Tax was not recomputed: line-level tax rates combined with an invoice-level discount make the tax base ambiguous.");
    } else if (lineSum !== null) {
      expectedTax = sum(inv.lines.map(l => percentOf(lineNet(l)!, l.taxRate ?? inv.taxRate ?? 0)));
    }
  } else if (inv.taxRate !== null && base !== null) {
    expectedTax = percentOf(base - (inv.discount ?? 0n), inv.taxRate);
  }
  let taxValid: boolean | null = null;
  if (inv.tax !== null && expectedTax !== null) {
    const t = override !== null ? abs(override) : minor + steps(Math.max(1, linesWithRate));
    taxValid = abs(inv.tax - expectedTax) <= t;
    if (!taxValid) {
      anomalies.push(fold("TAX_MISMATCH", "tax", [{ reason: linesWithRate > 0 ? "tax_differs_from_line_tax_rates" : "tax_differs_from_invoice_tax_rate", severity: severityFor(inv.tax - expectedTax), confidence: 0.9,
        detail: { ...detail(expectedTax, inv.tax, t), taxRatesUsed: linesWithRate > 0 ? [...new Set(inv.lines.map(l => l.taxRate ?? inv.taxRate ?? 0))] : [inv.taxRate] } }],
        top => `The stated tax differs from the tax implied by the stated rate(s) by ${top.detail.difference} ${cur ?? ""}`.trim() + ".")!);
    }
  } else if (inv.tax !== null && expectedTax === null && linesWithRate === 0 && inv.taxRate === null) {
    notes.push("Tax amount could not be recomputed because no tax rate was supplied (invoice.taxRate or lineItems[].taxRate).");
  }

  // Total.
  let totalValid: boolean | null = null;
  let expectedTotal: Dec | null = null;
  if (base !== null) {
    const taxForTotal = inv.tax ?? expectedTax;
    const withoutTax = base - (inv.discount ?? 0n) + (inv.shipping ?? 0n);
    const t = tol(1);
    if (taxForTotal !== null) {
      expectedTotal = withoutTax + taxForTotal;
      totalValid = abs(inv.total - expectedTotal) <= t;
    } else if (abs(inv.total - withoutTax) <= t) {
      expectedTotal = withoutTax; totalValid = true;
    } else {
      notes.push("The total could not be reconciled because the tax amount is not stated; the difference between total and subtotal is assumed to be tax.");
    }
    if (totalValid === false && expectedTotal !== null) {
      anomalies.push(fold("TOTAL_MISMATCH", "total", [{ reason: "total_differs_from_subtotal_plus_tax", severity: severityFor(inv.total - expectedTotal), confidence: 0.9,
        detail: { ...detail(expectedTotal, inv.total, t), components: { subtotal: out(base, cur), discount: inv.discount === null ? null : out(inv.discount, cur), tax: out(taxForTotal!, cur), shipping: inv.shipping === null ? null : out(inv.shipping, cur) }, subtotalSource: inv.subtotal !== null ? "stated" : "sum_of_line_items", taxSource: inv.tax !== null ? "stated" : "computed_from_rates" } }],
        top => `The stated total differs from subtotal − discount + tax + shipping by ${top.detail.difference} ${cur ?? ""}`.trim() + ".")!);
    }
  }

  return {
    anomalies,
    financialChecks: {
      subtotalValid, taxValid, totalValid, lineTotalsValid,
      computed: {
        lineItemsSum: lineSum === null ? null : out(lineSum, cur),
        expectedTax: expectedTax === null ? null : out(expectedTax, cur),
        expectedTotal: expectedTotal === null ? null : out(expectedTotal, cur),
        tolerance: out(override !== null ? abs(override) : minor, cur, 2)
      }
    },
    notes
  };
}
