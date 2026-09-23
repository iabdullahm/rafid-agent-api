/**
 * Synthetic, fictional invoice scenarios (no real companies or accounts) covering each headline
 * behavior of invoice_anomaly_check. Used by the tests, the README and the registry example.
 * All use options.asOfDate so results are reproducible.
 */

const AS_OF = { asOfDate: "2026-09-23" };

export const BASE_INVOICE = {
  invoiceNumber: "INV-2026-1043",
  supplierName: "ABC Trading LLC",
  supplierId: "SUP-291",
  invoiceDate: "2026-09-20",
  dueDate: "2026-10-20",
  currency: "USD",
  subtotal: 9200,
  tax: 460,
  total: 9660,
  bankAccount: "US123456789",
  paymentTermsDays: 30,
  poNumber: "PO-2026-818",
  lineItems: [{ description: "Consulting services", quantity: 10, unitPrice: 920, taxRate: 5, total: 9200 }]
};

/** Three ordinary prior invoices from the same supplier (monthly, same account, net 30). */
export const NORMAL_HISTORY = [
  { invoiceId: "AP-7781", invoiceNumber: "INV-2026-0981", supplierName: "ABC Trading LLC", supplierId: "SUP-291", invoiceDate: "2026-06-18", currency: "USD", total: 9177, bankAccount: "US123456789", paymentTermsDays: 30, status: "paid" as const,
    lineItems: [{ description: "Consulting services", quantity: 9.5, unitPrice: 920, total: 8740 }] },
  { invoiceId: "AP-7902", invoiceNumber: "INV-2026-1002", supplierName: "ABC Trading LLC", supplierId: "SUP-291", invoiceDate: "2026-07-19", currency: "USD", total: 9901.5, bankAccount: "US123456789", paymentTermsDays: 30, status: "paid" as const,
    lineItems: [{ description: "Consulting services", quantity: 10.25, unitPrice: 920, total: 9430 }] },
  { invoiceId: "AP-8015", invoiceNumber: "INV-2026-1021", supplierName: "ABC Trading LLC", supplierId: "SUP-291", invoiceDate: "2026-08-20", currency: "USD", total: 8694, bankAccount: "US123456789", paymentTermsDays: 30, status: "paid" as const,
    lineItems: [{ description: "Consulting services", quantity: 9, unitPrice: 920, total: 8280 }] }
];

export const SCENARIOS = {
  /** Expected: no anomalies, low risk, continue. */
  clean: { invoice: BASE_INVOICE, historicalInvoices: NORMAL_HISTORY, options: AS_OF },

  /** Subtotal stated as 9,500 while the line items sum to 9,200. Expected: SUBTOTAL_MISMATCH. */
  arithmeticError: { invoice: { ...BASE_INVOICE, subtotal: 9500, total: 9960 }, options: AS_OF },

  /** The same supplier, invoice number and amount are already in history. Expected: DUPLICATE_INVOICE. */
  duplicate: {
    invoice: BASE_INVOICE,
    historicalInvoices: [...NORMAL_HISTORY, { invoiceId: "AP-8120", invoiceNumber: "INV-2026-1043", supplierName: "ABC Trading LLC", supplierId: "SUP-291", invoiceDate: "2026-09-20", currency: "USD", total: 9660, bankAccount: "US123456789", paymentTermsDays: 30, status: "approved" as const }],
    options: AS_OF
  },

  /** Same supplier and amount two days earlier, invoice number with a suffix added. Expected: POSSIBLE_DUPLICATE. */
  nearDuplicate: {
    invoice: { ...BASE_INVOICE, invoiceNumber: "INV-2026-1043-A" },
    historicalInvoices: [...NORMAL_HISTORY, { invoiceId: "AP-8117", invoiceNumber: "INV-2026-1043", supplierName: "ABC Trading LLC", supplierId: "SUP-291", invoiceDate: "2026-09-18", currency: "USD", total: 9660, bankAccount: "US123456789", paymentTermsDays: 30, status: "pending" as const,
      lineItems: [{ description: "Consulting services", quantity: 10, unitPrice: 920, total: 9200 }] }],
    options: AS_OF
  },

  /** Every prior invoice was paid to another account. Expected: BANK_ACCOUNT_CHANGED. */
  bankChange: {
    invoice: BASE_INVOICE,
    historicalInvoices: NORMAL_HISTORY.map(h => ({ ...h, bankAccount: "US987654321" })),
    options: AS_OF
  },

  /** PO of 12,000 with 5,000 already invoiced; this invoice is 9,660. Expected: PO_AMOUNT_EXCEEDED. */
  poExceeded: {
    invoice: BASE_INVOICE,
    purchaseOrder: { poNumber: "PO-2026-818", supplierId: "SUP-291", supplierName: "ABC Trading LLC", currency: "USD", totalAmount: 12000, invoicedToDate: 5000, issueDate: "2026-08-01", status: "open" as const,
      lineItems: [{ description: "Consulting services", quantity: 20, unitPrice: 920 }] },
    options: AS_OF
  },

  /** Three invoices in two days, each under the 10,000 approval threshold, together 11,592. Expected: SPLIT_INVOICE_PATTERN. */
  splitInvoice: {
    invoice: { ...BASE_INVOICE, invoiceNumber: "INV-2026-1045", subtotal: 4600, tax: 230, total: 4830, lineItems: [{ description: "Consulting services - phase 3", quantity: 5, unitPrice: 920, taxRate: 5, total: 4600 }] },
    historicalInvoices: [
      ...NORMAL_HISTORY,
      { invoiceId: "AP-8118", invoiceNumber: "INV-2026-1043", supplierName: "ABC Trading LLC", supplierId: "SUP-291", invoiceDate: "2026-09-19", currency: "USD", total: 3864, bankAccount: "US123456789", paymentTermsDays: 30, status: "approved" as const,
        lineItems: [{ description: "Consulting services - phase 1", quantity: 4, unitPrice: 920, total: 3680 }] },
      { invoiceId: "AP-8119", invoiceNumber: "INV-2026-1044", supplierName: "ABC Trading LLC", supplierId: "SUP-291", invoiceDate: "2026-09-20", currency: "USD", total: 2898, bankAccount: "US123456789", paymentTermsDays: 30, status: "approved" as const,
        lineItems: [{ description: "Consulting services - phase 2", quantity: 3, unitPrice: 920, total: 2760 }] }
    ],
    approvalContext: { approvalThreshold: 10000, currency: "USD" },
    options: AS_OF
  },

  /** Near-duplicate + changed bank account + invoice billed against another supplier's PO. Expected: critical, hold. */
  multiple: {
    invoice: { ...BASE_INVOICE, invoiceNumber: "INV-2026-1043-A" },
    historicalInvoices: [...NORMAL_HISTORY.map(h => ({ ...h, bankAccount: "US987654321" })),
      { invoiceId: "AP-8117", invoiceNumber: "INV-2026-1043", supplierName: "ABC Trading LLC", supplierId: "SUP-291", invoiceDate: "2026-09-18", currency: "USD", total: 9660, bankAccount: "US987654321", paymentTermsDays: 30, status: "pending" as const }],
    purchaseOrder: { poNumber: "PO-2026-818", supplierId: "SUP-455", supplierName: "Delta Office Supplies Ltd", currency: "USD", totalAmount: 20000, status: "open" as const },
    options: AS_OF
  }
};
