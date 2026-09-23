import type { Dec } from "./money.js";

export const ANOMALY_CODES = [
  "SUBTOTAL_MISMATCH", "TAX_MISMATCH", "TOTAL_MISMATCH", "LINE_TOTAL_MISMATCH",
  "DUPLICATE_INVOICE", "POSSIBLE_DUPLICATE",
  "UNUSUAL_AMOUNT", "SUPPLIER_PATTERN_DEVIATION", "UNUSUAL_CURRENCY", "UNUSUAL_PAYMENT_TERMS", "INVOICE_NUMBER_ANOMALY",
  "BANK_ACCOUNT_CHANGED", "UNKNOWN_BANK_ACCOUNT",
  "PO_MISMATCH", "PO_AMOUNT_EXCEEDED", "CONTRACT_LIMIT_EXCEEDED", "APPROVAL_THRESHOLD_EXCEEDED",
  "SPLIT_INVOICE_PATTERN",
  "DATE_ANOMALY", "DUE_DATE_ANOMALY",
  "DUPLICATE_LINE_ITEM",
  "MISSING_REQUIRED_FIELD"
] as const;
export type AnomalyCode = (typeof ANOMALY_CODES)[number];

export const SEVERITIES = ["info", "low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];
export const severityRank = (s: Severity) => SEVERITIES.indexOf(s);
export const maxSeverity = (list: readonly Severity[]): Severity =>
  list.reduce<Severity>((m, s) => (severityRank(s) > severityRank(m) ? s : m), "info");

export type RiskFamily = "arithmetic" | "duplicate" | "supplier_behavior" | "payment_details" | "po_contract" | "split" | "dates" | "line_items" | "data_quality";

export const CODE_FAMILY: Record<AnomalyCode, RiskFamily> = {
  SUBTOTAL_MISMATCH: "arithmetic", TAX_MISMATCH: "arithmetic", TOTAL_MISMATCH: "arithmetic", LINE_TOTAL_MISMATCH: "arithmetic",
  DUPLICATE_INVOICE: "duplicate", POSSIBLE_DUPLICATE: "duplicate",
  UNUSUAL_AMOUNT: "supplier_behavior", SUPPLIER_PATTERN_DEVIATION: "supplier_behavior", UNUSUAL_CURRENCY: "supplier_behavior",
  UNUSUAL_PAYMENT_TERMS: "supplier_behavior", INVOICE_NUMBER_ANOMALY: "supplier_behavior",
  BANK_ACCOUNT_CHANGED: "payment_details", UNKNOWN_BANK_ACCOUNT: "payment_details",
  PO_MISMATCH: "po_contract", PO_AMOUNT_EXCEEDED: "po_contract", CONTRACT_LIMIT_EXCEEDED: "po_contract", APPROVAL_THRESHOLD_EXCEEDED: "po_contract",
  SPLIT_INVOICE_PATTERN: "split",
  DATE_ANOMALY: "dates", DUE_DATE_ANOMALY: "dates",
  DUPLICATE_LINE_ITEM: "line_items",
  MISSING_REQUIRED_FIELD: "data_quality"
};

export interface Anomaly {
  code: AnomalyCode;
  severity: Severity;
  /** 0–1: how strongly the evidence supports the finding (not a probability of fraud). */
  confidence: number;
  /** The primary invoice field the finding concerns (dot path), or null when it spans the invoice. */
  field: string | null;
  explanation: string;
  evidence: Record<string, unknown>;
}

/** A sub-finding collected by a check before it is folded into one anomaly per code. */
export interface Issue {
  reason: string;
  severity: Severity;
  confidence: number;
  detail: Record<string, unknown>;
}

// ---- normalized model ------------------------------------------------------------------------

export interface NormLine {
  index: number;
  description: string | null;
  descriptionKey: string | null;
  tokens: ReadonlySet<string>;
  sku: string | null;
  quantity: Dec | null;
  unitPrice: Dec | null;
  discount: Dec | null;
  taxRate: number | null;
  total: Dec | null;
}

export interface InvoiceNumberInfo {
  raw: string;
  /** Upper-case alphanumerics only ("INV-2026/1043" → "INV20261043"). */
  compact: string;
  /** Digits only, leading zeros removed ("" when none). */
  digits: string;
  /** Character-class mask: letters → A, digits → 9, other characters kept ("AAA-9999-9999"). */
  shape: string;
  /** Everything before the trailing digit run, compacted ("INV2026"), and the trailing number. */
  prefix: string;
  trailing: bigint | null;
}

export interface SupplierRef {
  id: string | null;
  name: string | null;
  nameKey: string | null;
}

export interface NormInvoice {
  invoiceId: string | null;
  number: InvoiceNumberInfo | null;
  supplier: SupplierRef;
  invoiceDate: number | null;
  dueDate: number | null;
  currency: string | null;
  subtotal: Dec | null;
  discount: Dec | null;
  shipping: Dec | null;
  tax: Dec | null;
  taxRate: number | null;
  total: Dec;
  bankAccount: string | null;
  paymentTermsDays: number | null;
  poNumber: string | null;
  contractId: string | null;
  lines: NormLine[];
}

export type HistoryStatus = "paid" | "approved" | "pending" | "disputed" | "rejected" | "cancelled" | "void" | "unknown";

export interface NormHistorical {
  index: number;
  invoiceId: string | null;
  rawNumber: string | null;
  number: InvoiceNumberInfo | null;
  supplier: SupplierRef;
  invoiceDate: number | null;
  dueDate: number | null;
  currency: string | null;
  subtotal: Dec | null;
  total: Dec;
  bankAccount: string | null;
  paymentTermsDays: number | null;
  poNumber: string | null;
  status: HistoryStatus;
  lines: NormLine[];
  /** true for cancelled/void/rejected: used for duplicate matching only. */
  inactive: boolean;
}

export interface NormPayment {
  index: number;
  number: InvoiceNumberInfo | null;
  supplier: SupplierRef;
  paymentDate: number | null;
  amount: Dec | null;
  currency: string | null;
  bankAccount: string | null;
}

export interface NormProfileAccount { account: string; verified: boolean | null; addedDate: number | null }

export interface NormProfile {
  supplier: SupplierRef;
  aliases: string[];
  bankAccounts: NormProfileAccount[];
  currencies: string[];
  paymentTermsDays: number | null;
  status: string | null;
  createdDate: number | null;
}

export interface NormPoLine { index: number; description: string | null; tokens: ReadonlySet<string>; sku: string | null; quantity: Dec | null; unitPrice: Dec | null }

export interface NormPurchaseOrder {
  poNumber: string | null;
  supplier: SupplierRef;
  currency: string | null;
  totalAmount: Dec | null;
  invoicedToDate: Dec | null;
  remainingAmount: Dec | null;
  amountsIncludeTax: boolean;
  issueDate: number | null;
  status: string | null;
  lines: NormPoLine[];
}

export interface NormContract {
  contractId: string | null;
  supplier: SupplierRef;
  currency: string | null;
  maxAmount: Dec | null;
  maxInvoiceAmount: Dec | null;
  invoicedToDate: Dec | null;
  startDate: number | null;
  endDate: number | null;
  paymentTermsDays: number | null;
}

export interface NormApproval { threshold: Dec | null; currency: string | null; splitWindowDays: number }

export interface NormOptions {
  asOf: number;
  roundingTolerance: Dec | null;
  duplicateWindowDays: number;
  minHistory: number;
}

export interface NormalizedRequest {
  invoice: NormInvoice;
  history: NormHistorical[];
  payments: NormPayment[];
  profile: NormProfile | null;
  purchaseOrder: NormPurchaseOrder | null;
  contract: NormContract | null;
  approval: NormApproval | null;
  options: NormOptions;
  /** Context blocks actually present in the request. */
  supplied: { history: boolean; profile: boolean; purchaseOrder: boolean; contract: boolean; approval: boolean; payments: boolean };
}

/** Shared state between checks: which history records are this invoice's supplier, and which were
 *  matched as duplicates (so split/contract logic does not double count them). */
export interface AnalysisContext {
  req: NormalizedRequest;
  /** Same-supplier history (all statuses). */
  supplierHistory: NormHistorical[];
  /** Same-supplier, active (not cancelled/void/rejected) history. */
  activeSupplierHistory: NormHistorical[];
  /** Whether the invoice's supplier could be identified at all (id or name). */
  supplierKnown: boolean;
  duplicateMatchIndexes: Set<number>;
}
