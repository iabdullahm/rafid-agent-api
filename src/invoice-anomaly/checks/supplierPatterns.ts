import { ISO_4217, THRESHOLDS } from "../config.js";
import { abs, median, out, ratio } from "../money.js";
import { companyNameSimilarity } from "../../company-reputation/normalization.js";
import { dayToIso, isPlaceholderNumber } from "../text.js";
import type { AnalysisContext, Anomaly, Issue } from "../types.js";
import { fold, round2 } from "./common.js";
import { sameCurrency } from "./duplicates.js";

/** Sample-size-aware confidence for history-based baselines: 0.6 at the minimum sample, +0.03 per
 *  extra invoice, capped at 0.9. */
const baselineConfidence = (n: number, min: number) => Math.min(0.9, 0.6 + 0.03 * Math.max(0, n - min));

/** Invoice terms in days: stated paymentTermsDays, else dueDate − invoiceDate. */
export function termsOf(x: { paymentTermsDays: number | null; invoiceDate: number | null; dueDate: number | null }): number | null {
  if (x.paymentTermsDays !== null) return x.paymentTermsDays;
  if (x.invoiceDate !== null && x.dueDate !== null && x.dueDate >= x.invoiceDate) return x.dueDate - x.invoiceDate;
  return null;
}

/**
 * Supplier-behavior checks. History-based baselines are used only with ≥ options.minHistoryForPatterns
 * (default 3) same-supplier ACTIVE invoices, so one or two past invoices never define "normal".
 */
export function checkSupplierPatterns(ctx: AnalysisContext): { anomalies: Anomaly[]; notes: string[] } {
  const { req } = ctx;
  const inv = req.invoice;
  const min = req.options.minHistory;
  const hist = ctx.activeSupplierHistory;
  const anomalies: Anomaly[] = [];
  const notes: string[] = [];
  const push = (a: Anomaly | null) => { if (a) anomalies.push(a); };

  if (req.supplied.history && ctx.supplierKnown && hist.length < min) {
    notes.push(`Supplier-behavior baselines (amount, currency, terms, invoice-number format, frequency) need at least ${min} prior invoices from this supplier; ${hist.length} were supplied.`);
  }

  // ---- UNUSUAL_AMOUNT ----------------------------------------------------------------------
  const sameCur = hist.filter(h => sameCurrency(inv.currency, h.currency));
  if (sameCur.length >= min) {
    const amounts = sameCur.map(h => h.total);
    const med = median(amounts);
    const mad = median(amounts.map(a => abs(a - med)));
    const max = amounts.reduce((m, a) => (a > m ? a : m));
    const minA = amounts.reduce((m, a) => (a < m ? a : m));
    const r = ratio(inv.total, med);
    const z = mad === 0n ? null : (Number(inv.total - med) / (1.4826 * Number(mad)));
    if (r !== null && inv.total > max && r >= THRESHOLDS.unusualAmountRatioMedium && (z === null || z >= THRESHOLDS.unusualAmountRobustZ)) {
      const high = r >= THRESHOLDS.unusualAmountRatioHigh;
      push(fold("UNUSUAL_AMOUNT", "total", [{
        reason: "amount_materially_above_supplier_history", severity: high ? "high" : "medium", confidence: baselineConfidence(sameCur.length, min),
        detail: {
          invoiceTotal: out(inv.total, inv.currency), historicalMedian: out(med, inv.currency), historicalMin: out(minA, inv.currency), historicalMax: out(max, inv.currency),
          ratioToMedian: round2(r), robustZScore: z === null ? null : round2(z), sampleSize: sameCur.length, currency: inv.currency
        }
      }], top => `The invoice total is ${top.detail.ratioToMedian}× this supplier's median invoice amount and above every one of the ${sameCur.length} prior invoices supplied.`));
    }
  }

  // ---- UNUSUAL_CURRENCY --------------------------------------------------------------------
  const curIssues: Issue[] = [];
  if (inv.currency) {
    if (!ISO_4217.has(inv.currency)) curIssues.push({ reason: "not_an_active_iso_4217_code", severity: "low", confidence: 0.9, detail: { currency: inv.currency } });
    if (req.profile && req.profile.currencies.length > 0 && !req.profile.currencies.includes(inv.currency))
      curIssues.push({ reason: "currency_not_in_supplier_profile", severity: "medium", confidence: 0.85, detail: { currency: inv.currency, profileCurrencies: req.profile.currencies } });
    const histCurrencies = [...new Set(hist.map(h => h.currency).filter((c): c is string => c !== null))].sort();
    const withCurrency = hist.filter(h => h.currency !== null).length;
    if (withCurrency >= min && !histCurrencies.includes(inv.currency))
      curIssues.push({ reason: "new_currency_for_supplier", severity: "medium", confidence: baselineConfidence(withCurrency, min), detail: { currency: inv.currency, historicalCurrencies: histCurrencies, sampleSize: withCurrency } });
    if (req.contract?.currency && req.contract.currency !== inv.currency)
      curIssues.push({ reason: "differs_from_contract_currency", severity: "medium", confidence: 0.9, detail: { currency: inv.currency, contractCurrency: req.contract.currency } });
  }
  push(fold("UNUSUAL_CURRENCY", "currency", curIssues, top => top.reason === "not_an_active_iso_4217_code"
    ? `${inv.currency} is well-formed but not an active ISO 4217 currency code.`
    : `The invoice currency ${inv.currency} differs from the currency this supplier normally uses or is contracted in.`));

  // ---- UNUSUAL_PAYMENT_TERMS ---------------------------------------------------------------
  const terms = termsOf(inv);
  if (terms !== null) {
    let expected: number | null = null, source = "";
    if (req.contract?.paymentTermsDays != null) { expected = req.contract.paymentTermsDays; source = "contract"; }
    else if (req.profile?.paymentTermsDays != null) { expected = req.profile.paymentTermsDays; source = "supplier_profile"; }
    else {
      const past = hist.map(termsOf).filter((t): t is number => t !== null);
      if (past.length >= min) { expected = medianNum(past); source = `supplier_history_median_of_${past.length}`; }
    }
    if (expected !== null && terms < expected && expected - terms >= THRESHOLDS.paymentTermsShorterMinDays && terms <= expected * THRESHOLDS.paymentTermsShorterRatio) {
      push(fold("UNUSUAL_PAYMENT_TERMS", inv.paymentTermsDays !== null ? "paymentTermsDays" : "dueDate", [{
        reason: "payment_terms_materially_shorter", severity: "medium", confidence: source.startsWith("supplier_history") ? 0.75 : 0.85,
        detail: { invoiceTermsDays: terms, expectedTermsDays: expected, expectedSource: source, termsSource: inv.paymentTermsDays !== null ? "paymentTermsDays" : "dueDate_minus_invoiceDate" }
      }], top => `Payment terms of ${terms} day(s) are materially shorter than the expected ${expected} day(s) (${String(top.detail.expectedSource).replace(/_/g, " ")}).`));
    }
  }

  // ---- INVOICE_NUMBER_ANOMALY --------------------------------------------------------------
  const numIssues: Issue[] = [];
  if (inv.number) {
    if (isPlaceholderNumber(inv.number)) numIssues.push({ reason: "placeholder_or_non_identifying_invoice_number", severity: "low", confidence: 0.9, detail: { invoiceNumber: inv.number.raw } });
    const numbered = ctx.supplierHistory.filter(h => h.number && h.number.compact);
    if (numbered.length >= min) {
      const shapes = new Map<string, number>();
      for (const h of numbered) shapes.set(h.number!.shape, (shapes.get(h.number!.shape) ?? 0) + 1);
      const [dominant, count] = [...shapes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
      const share = count / numbered.length;
      if (share >= THRESHOLDS.numberFormatDominance && inv.number.shape !== dominant) {
        numIssues.push({ reason: "format_deviates_from_supplier_pattern", severity: "low", confidence: round2(Math.min(0.85, 0.5 + share * 0.35)),
          detail: { invoiceNumber: inv.number.raw, invoiceNumberFormat: inv.number.shape, establishedFormat: dominant, establishedFormatShare: round2(share), sampleSize: numbered.length } });
      }
      // Out of sequence: same prefix family, later date, but a lower number than every prior one.
      const family = numbered.filter(h => h.number!.prefix === inv.number!.prefix && h.number!.trailing !== null);
      if (inv.number.trailing !== null && family.length >= min && inv.invoiceDate !== null) {
        const lowest = family.reduce((m, h) => (h.number!.trailing! < m ? h.number!.trailing! : m), family[0]!.number!.trailing!);
        const latestDate = Math.max(...family.map(h => h.invoiceDate ?? -Infinity));
        if (inv.number.trailing < lowest && inv.invoiceDate > latestDate) {
          numIssues.push({ reason: "number_lower_than_all_prior_invoices_despite_later_date", severity: "low", confidence: 0.6,
            detail: { invoiceNumber: inv.number.raw, lowestPriorNumber: lowest.toString(), latestPriorInvoiceDate: dayToIso(latestDate), sampleSize: family.length } });
        }
      }
    }
  }
  push(fold("INVOICE_NUMBER_ANOMALY", "invoiceNumber", numIssues, top =>
    top.reason === "placeholder_or_non_identifying_invoice_number" ? "The invoice number is a placeholder or does not identify the invoice."
      : top.reason === "format_deviates_from_supplier_pattern" ? `The invoice-number format ${top.detail.invoiceNumberFormat} deviates from this supplier's established format ${top.detail.establishedFormat}.`
        : "The invoice number is lower than all of this supplier's earlier invoice numbers although the invoice is dated later."));

  // ---- SUPPLIER_PATTERN_DEVIATION ----------------------------------------------------------
  const devIssues: Issue[] = [];
  const p = req.profile;
  if (p) {
    if (p.status === "blocked" || p.status === "suspended")
      devIssues.push({ reason: `supplier_${p.status}`, severity: "high", confidence: 0.95, detail: { supplierStatus: p.status } });
    else if (p.status === "inactive" || p.status === "pending_verification")
      devIssues.push({ reason: `supplier_${p.status}`, severity: "medium", confidence: 0.9, detail: { supplierStatus: p.status } });
    if (p.supplier.id && inv.supplier.id && p.supplier.id !== inv.supplier.id)
      devIssues.push({ reason: "supplier_id_differs_from_profile", severity: "medium", confidence: 0.9, detail: { invoiceSupplierId: inv.supplier.id, profileSupplierId: p.supplier.id } });
    else if (p.supplier.name && inv.supplier.name) {
      const sim = Math.max(companyNameSimilarity(inv.supplier.name, p.supplier.name), ...p.aliases.map(a => companyNameSimilarity(inv.supplier.name!, a)));
      if (sim < 0.8) devIssues.push({ reason: "supplier_name_differs_from_profile", severity: "medium", confidence: round2(0.9 - sim * 0.3), detail: { invoiceSupplierName: inv.supplier.name, profileSupplierName: p.supplier.name, nameSimilarity: round2(sim) } });
    }
    if (p.createdDate !== null && inv.invoiceDate !== null && inv.invoiceDate - p.createdDate >= 0 && inv.invoiceDate - p.createdDate <= THRESHOLDS.newSupplierDays)
      devIssues.push({ reason: "recently_created_supplier_record", severity: "low", confidence: 0.8, detail: { supplierCreatedDate: dayToIso(p.createdDate), daysBeforeInvoice: inv.invoiceDate - p.createdDate } });
  }
  if (req.contract && (req.contract.supplier.id || req.contract.supplier.name) && ctx.supplierKnown) {
    const m = sameSupplierRef(ctx, req.contract.supplier);
    if (m === "different") devIssues.push({ reason: "contract_supplier_differs_from_invoice_supplier", severity: "medium", confidence: 0.85, detail: { contractSupplierId: req.contract.supplier.id, contractSupplierName: req.contract.supplier.name } });
  }
  // Frequency spike.
  if (inv.invoiceDate !== null) {
    const dated = hist.filter(h => h.invoiceDate !== null && h.invoiceDate <= inv.invoiceDate!);
    const recentStart = inv.invoiceDate - THRESHOLDS.frequencyRecentDays;
    const prior = dated.filter(h => h.invoiceDate! < recentStart);
    const recent = dated.filter(h => h.invoiceDate! >= recentStart).length + 1;
    if (prior.length >= min) {
      const span = recentStart - Math.min(...prior.map(h => h.invoiceDate!));
      if (span >= THRESHOLDS.frequencyMinBaselineDays) {
        const perMonth = prior.length / (span / 30);
        if (recent >= THRESHOLDS.frequencyMinRecent && recent >= THRESHOLDS.frequencyMultiple * perMonth)
          devIssues.push({ reason: "invoice_frequency_increase", severity: "medium", confidence: 0.6, detail: { invoicesLast30Days: recent, baselinePerMonth: round2(perMonth), baselineSampleSize: prior.length, baselineDays: span } });
      }
    }
  }
  push(fold("SUPPLIER_PATTERN_DEVIATION", "supplierName", devIssues, top => ({
    supplier_blocked: "The supplier is marked blocked in the supplied supplier profile.",
    supplier_suspended: "The supplier is marked suspended in the supplied supplier profile.",
    supplier_inactive: "The supplier is marked inactive in the supplied supplier profile.",
    supplier_pending_verification: "The supplier record is still pending verification.",
    supplier_id_differs_from_profile: "The invoice's supplier id differs from the supplied supplier profile.",
    supplier_name_differs_from_profile: "The supplier name on the invoice differs from the supplied supplier profile and its aliases.",
    recently_created_supplier_record: "The supplier record was created shortly before this invoice.",
    contract_supplier_differs_from_invoice_supplier: "The supplied contract belongs to a different supplier than the invoice.",
    invoice_frequency_increase: `This supplier's invoice frequency increased sharply: ${top.detail.invoicesLast30Days} invoices in the last 30 days vs about ${top.detail.baselinePerMonth} per month before.`
  } as Record<string, string>)[top.reason] ?? "The invoice deviates from this supplier's established pattern."));

  return { anomalies, notes };
}

function sameSupplierRef(ctx: AnalysisContext, other: { id: string | null; name: string | null; nameKey: string | null }): "same" | "different" | "unknown" {
  const inv = ctx.req.invoice.supplier;
  if (inv.id && other.id) return inv.id === other.id ? "same" : "different";
  if (!inv.name || !other.name) return "unknown";
  return Math.max(companyNameSimilarity(inv.name, other.name), ...(ctx.req.profile?.aliases ?? []).map(a => companyNameSimilarity(a, other.name!))) >= THRESHOLDS.supplierNameMatch ? "same" : "different";
}
export { sameSupplierRef };

function medianNum(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
