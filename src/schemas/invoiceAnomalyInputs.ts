import { z } from "zod";
import { INVOICE_ANOMALY_LIMITS as L } from "../invoice-anomaly/config.js";

/**
 * invoice_anomaly_check input. Only `invoice.total` is required to execute: a single invoice alone
 * (standalone mode) is a valid, useful request. Every context block (historicalInvoices,
 * supplierProfile, purchaseOrder, contract, approvalContext, paymentHistory) is optional and turns
 * on additional checks (context-aware mode). Strict: unknown fields are rejected.
 *
 * Money, dates and currency codes are accepted loosely here (number or decimal string / any short
 * string) and validated by the service's normalization step, so a bad value comes back as a
 * specific, machine-readable error (INVALID_MONETARY_VALUE / INVALID_DATE /
 * UNSUPPORTED_CURRENCY_FORMAT, each with the offending path) rather than a generic schema error.
 */
const text = (max: number) => z.string().trim().min(1).max(max);
// Conventions (kept out of the per-field descriptions so the schema stays compact for agents and
// x402 discovery headers): amounts/quantities are JSON numbers or plain decimal strings ("9200.50",
// no thousands separators or symbols) handled with decimal-safe arithmetic; dates are ISO 8601
// (YYYY-MM-DD or a date-time, whose UTC date is used); currencies are ISO 4217 codes
// (case-insensitive); bank accounts are compared after removing spaces/dashes/dots and are only
// ever returned masked (last 4 characters).
const decimal = z.union([z.number(), z.string().trim().min(1).max(40)]);
const money = decimal;
const quantity = decimal;
const date = text(40);
const currency = text(10);
const account = text(80);
const rate = z.number().min(0).max(100).describe("Tax rate in percent (e.g. 5 for 5%).");
const termsDays = z.number().int().min(0).max(3650).describe("Payment terms in days (e.g. 30 for net 30).");

const invoiceLine = z.strictObject({
  description: text(500).optional(),
  sku: text(100).optional().describe("Item/SKU code, used to match purchase-order lines."),
  quantity: quantity.optional(),
  unitPrice: money.optional(),
  discount: money.optional().describe("Line discount amount (subtracted from quantity × unitPrice)."),
  taxRate: rate.optional(),
  total: money.optional().describe("Line total EXCLUDING tax (quantity × unitPrice − discount).")
});

export const invoiceAnomalyInvoice = z.strictObject({
  invoiceId: text(100).optional().describe("Your system's internal record id for this invoice. A historical invoice with the same invoiceId is treated as this same record and excluded from duplicate matching."),
  invoiceNumber: text(100).optional(),
  supplierName: text(200).optional(),
  supplierId: text(100).optional().describe("Your vendor/supplier master id. Preferred over the name for matching history."),
  invoiceDate: date.optional(),
  dueDate: date.optional(),
  currency: currency.optional(),
  subtotal: money.optional().describe("Sum of line totals, before invoice-level discount, tax and shipping."),
  discount: money.optional().describe("Invoice-level discount amount."),
  shipping: money.optional().describe("Shipping / other charges added to the total."),
  tax: money.optional().describe("Total tax amount."),
  taxRate: rate.optional().describe("Invoice-level tax rate, used when lines carry no taxRate."),
  total: money.describe("Invoice total payable (subtotal − discount + tax + shipping). Required."),
  bankAccount: account.optional(),
  paymentTermsDays: termsDays.optional(),
  poNumber: text(100).optional(),
  contractId: text(100).optional(),
  lineItems: z.array(invoiceLine).max(L.maxLineItems).optional()
});

const historicalInvoice = z.strictObject({
  invoiceId: text(100).optional(),
  invoiceNumber: text(100).optional(),
  supplierName: text(200).optional(),
  supplierId: text(100).optional(),
  invoiceDate: date.optional(),
  dueDate: date.optional(),
  currency: currency.optional(),
  subtotal: money.optional(),
  total: money,
  bankAccount: account.optional(),
  paymentTermsDays: termsDays.optional(),
  poNumber: text(100).optional(),
  status: z.enum(["paid", "approved", "pending", "disputed", "rejected", "cancelled", "void", "unknown"]).optional()
    .describe("Processing status. cancelled / void / rejected invoices are still used for duplicate matching (resubmissions) but excluded from behavior baselines, contract consumption and split detection."),
  lineItems: z.array(z.strictObject({
    description: text(500).optional(), sku: text(100).optional(), quantity: quantity.optional(), unitPrice: money.optional(), total: money.optional()
  })).max(L.maxHistoricalLineItems).optional()
});

const profileAccount = z.union([account, z.strictObject({
  account,
  verified: z.boolean().optional().describe("false = on file but not yet verified (e.g. by call-back)."),
  addedDate: date.optional().describe("When the account was added/changed in the supplier master.")
})]);

const supplierProfile = z.strictObject({
  supplierId: text(100).optional(),
  supplierName: text(200).optional(),
  aliases: z.array(text(200)).max(10).optional(),
  bankAccounts: z.array(profileAccount).max(20).optional().describe("Payment accounts on file for this supplier."),
  currencies: z.array(currency).max(10).optional().describe("Currencies this supplier normally invoices in."),
  paymentTermsDays: termsDays.optional().describe("Agreed standard payment terms."),
  status: z.enum(["active", "inactive", "blocked", "suspended", "pending_verification"]).optional(),
  createdDate: date.optional().describe("When the supplier record was created."),
  country: text(60).optional()
});

const purchaseOrder = z.strictObject({
  poNumber: text(100).optional(),
  supplierId: text(100).optional(),
  supplierName: text(200).optional(),
  currency: currency.optional(),
  totalAmount: money.optional(),
  invoicedToDate: money.optional().describe("Amount already invoiced against this PO (excluding this invoice)."),
  remainingAmount: money.optional().describe("Remaining PO balance before this invoice; takes precedence over totalAmount − invoicedToDate."),
  amountsIncludeTax: z.boolean().optional().describe("Default true: PO amounts are compared with the invoice total. false: compared with the invoice net amount (subtotal − discount)."),
  issueDate: date.optional(),
  status: z.enum(["open", "partially_invoiced", "closed", "cancelled"]).optional(),
  lineItems: z.array(z.strictObject({
    description: text(500).optional(), sku: text(100).optional(), quantity: quantity.optional(), unitPrice: money.optional()
  })).max(L.maxLineItems).optional()
});

const contract = z.strictObject({
  contractId: text(100).optional(),
  supplierId: text(100).optional(),
  supplierName: text(200).optional(),
  currency: currency.optional(),
  maxAmount: money.optional().describe("Contract value cap."),
  maxInvoiceAmount: money.optional().describe("Maximum amount allowed on a single invoice."),
  invoicedToDate: money.optional().describe("Amount already invoiced under the contract (excluding this invoice). When omitted, supplied historicalInvoices for the supplier inside the contract period are summed instead."),
  startDate: date.optional(),
  endDate: date.optional(),
  paymentTermsDays: termsDays.optional()
});

const approvalContext = z.strictObject({
  approvalThreshold: money.optional().describe("Single-invoice amount above which additional approval is required. Enables split-invoice detection."),
  currency: currency.optional().describe("Currency of approvalThreshold (default: the invoice currency)."),
  splitWindowDays: z.number().int().min(1).max(90).optional().describe(`Window for grouping same-supplier invoices in split detection (default ${L.defaultSplitWindowDays}).`)
});

const payment = z.strictObject({
  invoiceNumber: text(100).optional(),
  supplierId: text(100).optional(),
  supplierName: text(200).optional(),
  paymentDate: date.optional(),
  amount: money.optional(),
  currency: currency.optional(),
  bankAccount: account.optional()
});

export const invoiceAnomalyCheckInput = z.strictObject({
  invoice: invoiceAnomalyInvoice.describe("The invoice to check. Only `total` is required. Amounts: number or plain decimal string (\"9200.50\"); dates: ISO 8601; currency: ISO 4217 code; bankAccount is never echoed unmasked."),
  historicalInvoices: z.array(historicalInvoice).max(L.maxHistoricalInvoices).optional()
    .describe(`Previously received invoices (any supplier; up to ${L.maxHistoricalInvoices}). Enables duplicate, supplier-behavior, payment-detail and split checks.`),
  supplierProfile: supplierProfile.optional().describe("Supplier master data for the invoice's supplier."),
  purchaseOrder: purchaseOrder.optional().describe("The purchase order the invoice is billed against."),
  contract: contract.optional().describe("The governing contract."),
  approvalContext: approvalContext.optional(),
  paymentHistory: z.array(payment).max(L.maxPayments).optional().describe("Past payments (any supplier). Used for known payment accounts and already-paid detection."),
  options: z.strictObject({
    asOfDate: date.optional().describe("Reference date for date checks (default: today, UTC). Supplying it makes the output fully reproducible."),
    roundingTolerance: money.optional().describe("Absolute arithmetic tolerance in currency units, replacing the default of one minor unit per rounding step."),
    duplicateWindowDays: z.number().int().min(1).max(365).optional().describe(`Maximum date gap for near-duplicate matching (default ${L.defaultDuplicateWindowDays}).`),
    minHistoryForPatterns: z.number().int().min(2).max(50).optional().describe(`Minimum same-supplier invoices required before supplier-behavior baselines are used (default ${L.defaultMinHistory}).`)
  }).optional()
});

export type InvoiceAnomalyCheckInput = z.infer<typeof invoiceAnomalyCheckInput>;
