import type { InvoiceAnomalyCheckInput } from "../schemas/invoiceAnomalyInputs.js";
import { INVOICE_ANOMALY_LIMITS as L } from "./config.js";
import { invalidDate, invalidMonetaryValue, unsupportedCurrencyFormat } from "./errors.js";
import { parseMoney, type Dec } from "./money.js";
import { accountKey, collapse, descriptionKey, invoiceNumberInfo, parseDay, supplierRef, todayDay, tokens } from "./text.js";
import type { HistoryStatus, NormHistorical, NormLine, NormPoLine, NormalizedRequest } from "./types.js";

/**
 * Converts the validated input into the engine's normalized model: trimmed/collapsed strings,
 * normalized supplier keys, compacted invoice numbers, upper-case ISO currency codes, compacted bank
 * accounts, UTC day numbers for dates and BigInt decimals for every amount. Invalid values throw a
 * structured error naming the exact path (never echoing the value).
 */
export function normalizeRequest(input: InvoiceAnomalyCheckInput, now: () => number = todayDay): NormalizedRequest {
  const money = (v: number | string | undefined, path: string): Dec | null => {
    if (v === undefined) return null;
    const d = parseMoney(v);
    if (d === null) throw invalidMonetaryValue(path);
    return d;
  };
  const day = (v: string | undefined, path: string): number | null => {
    if (v === undefined) return null;
    const d = parseDay(v);
    if (d === null) throw invalidDate(path);
    return d;
  };
  const currency = (v: string | undefined, path: string): string | null => {
    if (v === undefined) return null;
    const c = collapse(v).toUpperCase();
    if (!/^[A-Z]{3}$/.test(c)) throw unsupportedCurrencyFormat(path);
    return c;
  };
  const str = (v: string | undefined) => (v === undefined ? null : collapse(v) || null);
  const acct = (v: string | undefined) => (v === undefined ? null : accountKey(v) || null);
  const refKey = (v: string | undefined) => (v === undefined ? null : collapse(v).toUpperCase().replace(/[^\p{L}\p{N}]/gu, "") || null);

  type LineIn = { description?: string; sku?: string; quantity?: number | string; unitPrice?: number | string; discount?: number | string; taxRate?: number; total?: number | string };
  const line = (l: LineIn, i: number, base: string): NormLine => {
    const key = descriptionKey(l.description);
    return {
      index: i, description: str(l.description), descriptionKey: key, tokens: tokens(key), sku: refKey(l.sku),
      quantity: money(l.quantity, `${base}.${i}.quantity`), unitPrice: money(l.unitPrice, `${base}.${i}.unitPrice`),
      discount: money(l.discount, `${base}.${i}.discount`), taxRate: l.taxRate ?? null, total: money(l.total, `${base}.${i}.total`)
    };
  };

  const inv = input.invoice;
  const invoice = {
    invoiceId: str(inv.invoiceId),
    number: invoiceNumberInfo(inv.invoiceNumber),
    supplier: supplierRef(inv.supplierId, inv.supplierName),
    invoiceDate: day(inv.invoiceDate, "invoice.invoiceDate"),
    dueDate: day(inv.dueDate, "invoice.dueDate"),
    currency: currency(inv.currency, "invoice.currency"),
    subtotal: money(inv.subtotal, "invoice.subtotal"),
    discount: money(inv.discount, "invoice.discount"),
    shipping: money(inv.shipping, "invoice.shipping"),
    tax: money(inv.tax, "invoice.tax"),
    taxRate: inv.taxRate ?? null,
    total: money(inv.total, "invoice.total")!,
    bankAccount: acct(inv.bankAccount),
    paymentTermsDays: inv.paymentTermsDays ?? null,
    poNumber: refKey(inv.poNumber),
    contractId: refKey(inv.contractId),
    lines: (inv.lineItems ?? []).map((l, i) => line(l, i, "invoice.lineItems"))
  };

  const INACTIVE: ReadonlySet<HistoryStatus> = new Set(["cancelled", "void", "rejected"]);
  const history: NormHistorical[] = (input.historicalInvoices ?? []).map((h, i) => {
    const base = `historicalInvoices.${i}`;
    const status = h.status ?? "unknown";
    return {
      index: i, invoiceId: str(h.invoiceId), rawNumber: h.invoiceNumber ? collapse(h.invoiceNumber) : null, number: invoiceNumberInfo(h.invoiceNumber),
      supplier: supplierRef(h.supplierId, h.supplierName),
      invoiceDate: day(h.invoiceDate, `${base}.invoiceDate`), dueDate: day(h.dueDate, `${base}.dueDate`),
      currency: currency(h.currency, `${base}.currency`),
      subtotal: money(h.subtotal, `${base}.subtotal`), total: money(h.total, `${base}.total`)!,
      bankAccount: acct(h.bankAccount), paymentTermsDays: h.paymentTermsDays ?? null, poNumber: refKey(h.poNumber),
      status, inactive: INACTIVE.has(status),
      lines: (h.lineItems ?? []).map((l, j) => line(l, j, `${base}.lineItems`))
    };
  });

  const payments = (input.paymentHistory ?? []).map((p, i) => ({
    index: i, number: invoiceNumberInfo(p.invoiceNumber), supplier: supplierRef(p.supplierId, p.supplierName),
    paymentDate: day(p.paymentDate, `paymentHistory.${i}.paymentDate`), amount: money(p.amount, `paymentHistory.${i}.amount`),
    currency: currency(p.currency, `paymentHistory.${i}.currency`), bankAccount: acct(p.bankAccount)
  }));

  // An empty context object ({}) carries no information and is treated as not supplied.
  const present = <T extends object>(o: T | undefined): T | undefined => (o && Object.values(o).some(v => v !== undefined && !(Array.isArray(v) && v.length === 0)) ? o : undefined);
  const sp = present(input.supplierProfile);
  const profile = sp ? {
    supplier: supplierRef(sp.supplierId, sp.supplierName),
    aliases: (sp.aliases ?? []).map(collapse),
    bankAccounts: (sp.bankAccounts ?? []).map((a, i) => typeof a === "string"
      ? { account: accountKey(a), verified: null, addedDate: null }
      : { account: accountKey(a.account), verified: a.verified ?? null, addedDate: day(a.addedDate, `supplierProfile.bankAccounts.${i}.addedDate`) })
      .filter(a => a.account),
    currencies: (sp.currencies ?? []).map((c, i) => currency(c, `supplierProfile.currencies.${i}`)!),
    paymentTermsDays: sp.paymentTermsDays ?? null,
    status: sp.status ?? null,
    createdDate: day(sp.createdDate, "supplierProfile.createdDate")
  } : null;

  const po = present(input.purchaseOrder);
  const purchaseOrder = po ? {
    poNumber: refKey(po.poNumber), supplier: supplierRef(po.supplierId, po.supplierName),
    currency: currency(po.currency, "purchaseOrder.currency"),
    totalAmount: money(po.totalAmount, "purchaseOrder.totalAmount"), invoicedToDate: money(po.invoicedToDate, "purchaseOrder.invoicedToDate"),
    remainingAmount: money(po.remainingAmount, "purchaseOrder.remainingAmount"), amountsIncludeTax: po.amountsIncludeTax ?? true,
    issueDate: day(po.issueDate, "purchaseOrder.issueDate"), status: po.status ?? null,
    lines: (po.lineItems ?? []).map((l, i): NormPoLine => {
      const key = descriptionKey(l.description);
      return {
        index: i, description: str(l.description), tokens: tokens(key), sku: refKey(l.sku),
        quantity: money(l.quantity, `purchaseOrder.lineItems.${i}.quantity`), unitPrice: money(l.unitPrice, `purchaseOrder.lineItems.${i}.unitPrice`)
      };
    })
  } : null;

  const c = present(input.contract);
  const contract = c ? {
    contractId: refKey(c.contractId), supplier: supplierRef(c.supplierId, c.supplierName), currency: currency(c.currency, "contract.currency"),
    maxAmount: money(c.maxAmount, "contract.maxAmount"), maxInvoiceAmount: money(c.maxInvoiceAmount, "contract.maxInvoiceAmount"),
    invoicedToDate: money(c.invoicedToDate, "contract.invoicedToDate"),
    startDate: day(c.startDate, "contract.startDate"), endDate: day(c.endDate, "contract.endDate"), paymentTermsDays: c.paymentTermsDays ?? null
  } : null;

  const a = present(input.approvalContext);
  const approval = a ? {
    threshold: money(a.approvalThreshold, "approvalContext.approvalThreshold"),
    currency: currency(a.currency, "approvalContext.currency"),
    splitWindowDays: a.splitWindowDays ?? L.defaultSplitWindowDays
  } : null;

  const o = input.options ?? {};
  return {
    invoice, history, payments, profile, purchaseOrder, contract, approval,
    options: {
      asOf: day(o.asOfDate, "options.asOfDate") ?? now(),
      roundingTolerance: money(o.roundingTolerance, "options.roundingTolerance"),
      duplicateWindowDays: o.duplicateWindowDays ?? L.defaultDuplicateWindowDays,
      minHistory: o.minHistoryForPatterns ?? L.defaultMinHistory
    },
    supplied: {
      history: history.length > 0, profile: profile !== null, purchaseOrder: purchaseOrder !== null,
      contract: contract !== null, approval: approval !== null, payments: payments.length > 0
    }
  };
}
