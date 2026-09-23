import type { Anomaly, NormInvoice } from "../types.js";

/**
 * Two tiers of missing data:
 *  - Required to EXECUTE: invoice.total only — enforced by the input schema (INVALID_INPUT).
 *  - Required for normal BUSINESS processing (invoiceNumber, supplier identity, invoiceDate,
 *    currency): each missing one is listed in one MISSING_REQUIRED_FIELD anomaly (low; medium when
 *    three or more are missing) — the analysis still runs on what is present.
 *  - Recommended (dueDate, lineItems, subtotal, tax, bankAccount): reported in dataCompleteness only,
 *    never as an anomaly.
 */
export function checkMissingData(inv: NormInvoice): { anomalies: Anomaly[]; completeness: { missingRequiredFields: string[]; missingRecommendedFields: string[] } } {
  const missingRequired = [
    ...(inv.number && inv.number.compact ? [] : ["invoiceNumber"]),
    ...(inv.supplier.id || inv.supplier.name ? [] : ["supplierName|supplierId"]),
    ...(inv.invoiceDate !== null ? [] : ["invoiceDate"]),
    ...(inv.currency ? [] : ["currency"])
  ];
  const missingRecommended = [
    ...(inv.dueDate !== null || inv.paymentTermsDays !== null ? [] : ["dueDate|paymentTermsDays"]),
    ...(inv.lines.length > 0 ? [] : ["lineItems"]),
    ...(inv.subtotal !== null ? [] : ["subtotal"]),
    ...(inv.tax !== null ? [] : ["tax"]),
    ...(inv.bankAccount ? [] : ["bankAccount"])
  ];
  const anomalies: Anomaly[] = missingRequired.length === 0 ? [] : [{
    code: "MISSING_REQUIRED_FIELD", severity: missingRequired.length >= 3 ? "medium" : "low", confidence: 1, field: missingRequired[0]!.split("|")[0]!,
    explanation: `The invoice is missing ${missingRequired.length} field(s) normally required to process it (${missingRequired.join(", ")}); checks that depend on them were skipped.`,
    evidence: { missingFields: missingRequired, missingRecommendedFields: missingRecommended }
  }];
  return { anomalies, completeness: { missingRequiredFields: missingRequired, missingRecommendedFields: missingRecommended } };
}
