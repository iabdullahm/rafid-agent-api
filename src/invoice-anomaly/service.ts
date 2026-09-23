import { invoiceAnomalyCheckInput, type InvoiceAnomalyCheckInput } from "../schemas/invoiceAnomalyInputs.js";
import type { InvoiceAnomalyCheckOutput } from "../schemas/invoiceAnomalyOutputs.js";
import { ApiError } from "../utils/errors.js";
import { checkArithmetic } from "./checks/arithmetic.js";
import { checkDates } from "./checks/dates.js";
import { checkDuplicates } from "./checks/duplicates.js";
import { checkDuplicateLines } from "./checks/lineItems.js";
import { checkMissingData } from "./checks/missingData.js";
import { checkPaymentDetails } from "./checks/payment.js";
import { checkPoContract } from "./checks/poContract.js";
import { checkSplitInvoices } from "./checks/split.js";
import { checkSupplierPatterns } from "./checks/supplierPatterns.js";
import { analysisFailed } from "./errors.js";
import { out } from "./money.js";
import { normalizeRequest } from "./normalization.js";
import { scoreAnomalies } from "./scoring.js";
import { dayToIso, maskAccount, sameSupplier, supplierKnown, todayDay } from "./text.js";
import { ANOMALY_CODES, severityRank, type AnalysisContext, type Anomaly, type AnomalyCode } from "./types.js";

export interface InvoiceAnomalyDependencies {
  /** Current UTC day number (injectable for tests); used only when options.asOfDate is absent. */
  today?: () => number;
}

export const DISCLAIMER = "The capability identifies invoice anomalies and risk indicators. It does not independently establish fraud or replace accounting, audit, compliance, or payment-authorization controls.";

const ACTIONS: Partial<Record<AnomalyCode, string>> = {
  BANK_ACCOUNT_CHANGED: "Verify the payment details directly with the supplier using contact details already on file (not those on the invoice) before paying.",
  UNKNOWN_BANK_ACCOUNT: "Confirm the payment account with the supplier through an independent, known contact and record it before paying.",
  DUPLICATE_INVOICE: "Check whether the matched invoice has already been approved or paid; do not pay the same invoice twice.",
  POSSIBLE_DUPLICATE: "Compare this invoice with the matched invoice and supporting documents to rule out a duplicate before payment.",
  SPLIT_INVOICE_PATTERN: "Review the related invoices together against the approval threshold and confirm the correct approval level was applied.",
  PO_AMOUNT_EXCEEDED: "Obtain approval for the amount above the remaining purchase-order balance or request a corrected invoice.",
  CONTRACT_LIMIT_EXCEEDED: "Confirm a contract amendment or approval covers the amount above the contract limit.",
  PO_MISMATCH: "Resolve the purchase-order discrepancies (supplier, currency, reference, quantities or prices) before approval.",
  SUPPLIER_PATTERN_DEVIATION: "Confirm the supplier's status and identity in the supplier master before processing.",
  UNUSUAL_AMOUNT: "Verify the invoiced amount against the underlying order, delivery or contract.",
  UNUSUAL_CURRENCY: "Confirm the invoice currency with the supplier and the governing contract.",
  UNUSUAL_PAYMENT_TERMS: "Confirm the shortened payment terms are contractually agreed.",
  SUBTOTAL_MISMATCH: "Request a corrected invoice or confirm the correct amounts before payment.",
  TAX_MISMATCH: "Verify the tax calculation and rates before payment.",
  TOTAL_MISMATCH: "Request a corrected invoice or confirm the correct total before payment.",
  LINE_TOTAL_MISMATCH: "Verify the line quantities, unit prices and totals.",
  DUPLICATE_LINE_ITEM: "Confirm the repeated line items were delivered twice or have them removed.",
  DATE_ANOMALY: "Verify the invoice date against the supporting documents.",
  DUE_DATE_ANOMALY: "Confirm the due date and payment terms with the supplier.",
  INVOICE_NUMBER_ANOMALY: "Verify the invoice number with the supplier.",
  MISSING_REQUIRED_FIELD: "Obtain the missing invoice details before processing."
};

/**
 * invoice_anomaly_check's engine: validate → normalize → run deterministic checks → score →
 * explain. No network, no LLM, no persistence, no logging of the invoice body. Throws structured
 * ApiErrors (400) for invalid input and ANALYSIS_FAILED (500) for unexpected internal failures.
 */
export async function runInvoiceAnomalyCheck(rawInput: unknown, deps: InvoiceAnomalyDependencies = {}): Promise<InvoiceAnomalyCheckOutput> {
  const input: InvoiceAnomalyCheckInput = invoiceAnomalyCheckInput.parse(rawInput);
  try {
    return analyze(normalizeRequest(input, deps.today ?? todayDay));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw analysisFailed();
  }
}

function analyze(req: ReturnType<typeof normalizeRequest>): InvoiceAnomalyCheckOutput {
  const inv = req.invoice;
  const aliases = req.profile?.aliases ?? [];
  const known = supplierKnown(inv.supplier) || Boolean(req.profile && supplierKnown(req.profile.supplier));
  // When the invoice names no supplier but a profile was supplied for it, the profile identifies it.
  const invSupplier = supplierKnown(inv.supplier) ? inv.supplier : req.profile?.supplier ?? inv.supplier;
  const supplierHistory = known ? req.history.filter(h => !(inv.invoiceId && h.invoiceId === inv.invoiceId) && sameSupplier(invSupplier, h.supplier, aliases) === "same") : [];
  const ctx: AnalysisContext = {
    req: invSupplier === inv.supplier ? req : { ...req, invoice: { ...inv, supplier: invSupplier } },
    supplierHistory, activeSupplierHistory: supplierHistory.filter(h => !h.inactive), supplierKnown: known, duplicateMatchIndexes: new Set()
  };

  const notes: string[] = [];
  const arithmetic = checkArithmetic(inv, req.options.roundingTolerance);
  notes.push(...arithmetic.notes);
  const missing = checkMissingData(inv);
  const duplicates = checkDuplicates(ctx);            // before split/contract: marks matched records
  const supplier = checkSupplierPatterns(ctx);
  const payment = checkPaymentDetails(ctx);
  const poContract = checkPoContract(ctx);
  const split = checkSplitInvoices(ctx);
  const lines = checkDuplicateLines(inv);
  const dates = checkDates(ctx);
  for (const r of [supplier, payment, poContract, split, lines]) notes.push(...r.notes);

  const order = (a: Anomaly, b: Anomaly) => severityRank(b.severity) - severityRank(a.severity) || b.confidence - a.confidence || ANOMALY_CODES.indexOf(a.code) - ANOMALY_CODES.indexOf(b.code);
  const anomalies = [...arithmetic.anomalies, ...duplicates, ...supplier.anomalies, ...payment.anomalies, ...poContract.anomalies, ...split.anomalies, ...lines.anomalies, ...dates, ...missing.anomalies].sort(order);
  const { riskScore, riskLevel, decision, breakdown } = scoreAnomalies(anomalies);

  const contextAware = Object.values(req.supplied).some(Boolean);
  const limitations = [
    DISCLAIMER,
    "The decision field is advisory only; it is not an approval or rejection of the payment.",
    "Findings are limited to the data supplied in the request; no accounting system, bank or third-party source is consulted.",
    ...(contextAware ? [] : ["Standalone mode: only checks that can be determined from the invoice itself were run. Supply historicalInvoices, supplierProfile, purchaseOrder, contract, approvalContext or paymentHistory for duplicate, supplier-behavior, payment-detail, PO/contract and split checks."]),
    ...(contextAware && !known ? ["The invoice supplier could not be identified (no supplierId or supplierName), so supplier-specific history checks were skipped."] : []),
    ...notes
  ];

  const topActions = [...new Set(anomalies.filter(a => a.severity !== "info").map(a => ACTIONS[a.code]).filter((s): s is string => Boolean(s)))].slice(0, 3);
  const recommendedAction = topActions.length === 0
    ? "No anomalies requiring review were detected; proceed under normal payment controls."
    : topActions.join(" ");
  const scored = anomalies.filter(a => a.severity !== "info");
  const codes = [...new Set(scored.map(a => a.code))];
  const summary = scored.length === 0
    ? `No invoice anomalies were detected (${contextAware ? "context-aware" : "standalone"} mode); risk ${riskLevel} (${riskScore}/100).`
    : `${scored.length} anomal${scored.length === 1 ? "y" : "ies"} detected (${codes.join(", ")}); risk ${riskLevel} (${riskScore}/100). Advisory decision: ${decision}${decision === "continue" ? "" : " — the invoice requires human review before payment"}.`;

  const asOfIso = dayToIso(req.options.asOf);
  return {
    riskScore, riskLevel, decision,
    anomalyCount: anomalies.length,
    anomalies,
    financialChecks: arithmetic.financialChecks,
    recommendedAction,
    summary,
    mode: contextAware ? "context_aware" : "standalone",
    contextUsed: {
      historicalInvoices: req.history.length, supplierHistoryMatched: supplierHistory.length, paymentHistory: req.payments.length,
      supplierProfile: req.supplied.profile, purchaseOrder: req.supplied.purchaseOrder, contract: req.supplied.contract, approvalContext: req.supplied.approval
    },
    invoiceSummary: {
      invoiceNumber: inv.number?.raw ?? null, supplierName: inv.supplier.name, supplierId: inv.supplier.id,
      invoiceDate: inv.invoiceDate === null ? null : dayToIso(inv.invoiceDate), dueDate: inv.dueDate === null ? null : dayToIso(inv.dueDate),
      currency: inv.currency, total: out(inv.total, inv.currency), lineItemCount: inv.lines.length, bankAccountMasked: maskAccount(inv.bankAccount)
    },
    dataCompleteness: missing.completeness,
    scoring: breakdown,
    limitations,
    asOfDate: asOfIso,
    checkedAt: `${asOfIso}T00:00:00.000Z`
  };
}
