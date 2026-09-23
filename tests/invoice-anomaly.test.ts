import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import http from "node:http";
import { ZodError } from "zod";
import { createApp } from "../src/api/app.js";
import { loadConfig } from "../src/config/env.js";
import { buildOpenapi } from "../src/api/openapi.js";
import { capabilities } from "../src/domain/capabilities.js";
import { prices } from "../src/billing/catalog.js";
import { BillingService } from "../src/billing/service.js";
import { MemoryUsageRepository } from "../src/billing/usage.js";
import { MAX_DISCOVERY_DECLARATION_CHARS, buildX402Info, discoveryDeclaration } from "../src/billing/x402.js";
import { classifyDataSource } from "../src/analytics/dataSource.js";
import { ApiError, publicError } from "../src/utils/errors.js";
import { AGENT_GROUPS } from "../src/api/dashboard/service.js";
import { invoiceAnomalyCheckInput } from "../src/schemas/invoiceAnomalyInputs.js";
import { invoiceAnomalyCheckOutput, type InvoiceAnomalyCheckOutput } from "../src/schemas/invoiceAnomalyOutputs.js";
import { runInvoiceAnomalyCheck, DISCLAIMER } from "../src/invoice-anomaly/service.js";
import { scoreAnomalies } from "../src/invoice-anomaly/scoring.js";
import { parseMoney, mul, toNumber } from "../src/invoice-anomaly/money.js";
import { invoiceNumberInfo, numberRelation, maskAccount } from "../src/invoice-anomaly/text.js";
import type { Anomaly, AnomalyCode, Severity } from "../src/invoice-anomaly/types.js";
import { BASE_INVOICE, NORMAL_HISTORY, SCENARIOS } from "../src/invoice-anomaly/examples/scenarios.js";
import { INVOICE_ANOMALY_EXAMPLE_INPUT, INVOICE_ANOMALY_EXAMPLE_OUTPUT } from "../src/domain/examples/invoiceAnomalyCheckExample.js";

/**
 * invoice_anomaly_check. Every invoice, supplier and account is synthetic. The engine is pure and
 * in-process; every request pins options.asOfDate (or injects `today`) so results are reproducible.
 * Assertions target anomaly codes and evidence, not just HTTP status.
 */

const key = "test-only-not-a-real-credential-12345";
const wallet = "0x1234567890123456789012345678901234567890";
const ENDPOINT = "/api/v1/finance/invoice-anomaly-check";
const cap = capabilities.find(c => c.name === "invoice_anomaly_check")!;
const AS_OF = { asOfDate: "2026-09-23" };

const run = (input: unknown) => runInvoiceAnomalyCheck(input);
const codes = (r: InvoiceAnomalyCheckOutput) => r.anomalies.map(a => a.code);
const find = (r: InvoiceAnomalyCheckOutput, code: AnomalyCode) => r.anomalies.find(a => a.code === code);
const issueReasons = (a: { evidence: Record<string, unknown> } | undefined) => ((a?.evidence.issues as { reason: string }[] | undefined) ?? []).map(i => i.reason);
const withInvoice = (patch: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ invoice: { ...BASE_INVOICE, ...patch }, options: AS_OF, ...extra });

async function rejects(p: Promise<unknown>, status: number, code: string, path?: string) {
  try { await p; } catch (e) {
    const rendered = publicError(e);
    assert.equal(rendered.status, status, `${code}: ${(e as Error).message}`);
    assert.equal(rendered.error.code, code);
    if (path) assert.equal((rendered.error as { details?: { path?: string } }).details?.path, path);
    return e;
  }
  assert.fail(`expected ${code}`);
}

async function withServer<T>(config: ReturnType<typeof loadConfig>, fn: (base: string) => Promise<T>): Promise<T> {
  const app = createApp(config, { logger: () => {} });
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally { server.closeAllConnections(); server.close(); }
}

// ---- core scenarios ---------------------------------------------------------------------------

test("clean valid invoice: no anomalies, low risk, continue, all arithmetic valid (standalone and with normal history)", async () => {
  for (const input of [{ invoice: BASE_INVOICE, options: AS_OF }, SCENARIOS.clean]) {
    const r = await run(input);
    assert.ok(invoiceAnomalyCheckOutput.safeParse(r).success);
    assert.deepEqual(codes(r), []);
    assert.equal(r.riskScore, 0);
    assert.equal(r.riskLevel, "low");
    assert.equal(r.decision, "continue");
    assert.deepEqual({ ...r.financialChecks, computed: undefined }, { subtotalValid: true, taxValid: true, totalValid: true, lineTotalsValid: true, computed: undefined });
    assert.equal(r.financialChecks.computed.expectedTotal, 9660);
    assert.ok(r.limitations.includes(DISCLAIMER));
  }
  assert.equal((await run({ invoice: BASE_INVOICE, options: AS_OF })).mode, "standalone");
  const ctx = await run(SCENARIOS.clean);
  assert.equal(ctx.mode, "context_aware");
  assert.equal(ctx.contextUsed.supplierHistoryMatched, 3);
});

test("empty optional context ({} / []) is accepted and treated as not supplied — no spurious anomalies", async () => {
  const r = await run({ invoice: BASE_INVOICE, historicalInvoices: [], supplierProfile: {}, purchaseOrder: {}, contract: {}, approvalContext: {}, paymentHistory: [], options: AS_OF });
  assert.deepEqual(codes(r), []);
  assert.equal(r.mode, "standalone");
  assert.equal(r.decision, "continue");
});

test("minimum valid request (invoice.total only) runs; missing business fields are reported, not fatal", async () => {
  const r = await run({ invoice: { total: 100 }, options: AS_OF });
  assert.deepEqual(codes(r), ["MISSING_REQUIRED_FIELD"]);
  const m = find(r, "MISSING_REQUIRED_FIELD")!;
  assert.deepEqual(m.evidence.missingFields, ["invoiceNumber", "supplierName|supplierId", "invoiceDate", "currency"]);
  assert.equal(m.severity, "medium");
  assert.deepEqual(r.dataCompleteness.missingRecommendedFields, ["dueDate|paymentTermsDays", "lineItems", "subtotal", "tax", "bankAccount"]);
  assert.equal(r.riskLevel, "low", "missing metadata alone never escalates beyond low");
  assert.deepEqual({ ...r.financialChecks, computed: undefined }, { subtotalValid: null, taxValid: null, totalValid: null, lineTotalsValid: null, computed: undefined });
  // Only one business field missing ⇒ low severity; recommended-only gaps ⇒ no anomaly at all.
  const one = await run(withInvoice({ invoiceNumber: undefined }));
  assert.equal(find(one, "MISSING_REQUIRED_FIELD")!.severity, "low");
  const rec = await run({ invoice: { invoiceNumber: "A-1", supplierName: "X Ltd", invoiceDate: "2026-09-01", currency: "EUR", total: 50 }, options: AS_OF });
  assert.deepEqual(codes(rec), []);
});

test("decimal-safe arithmetic and rounding tolerance", async () => {
  // Exact decimal parsing: 0.1 + 0.2 == 0.3; strings and numbers equivalent.
  assert.equal(parseMoney(0.1)! + parseMoney(0.2)!, parseMoney("0.3"));
  assert.equal(parseMoney("1234.50"), parseMoney(1234.5));
  assert.equal(toNumber(mul(parseMoney(3)!, parseMoney("33.333")!), 3), 99.999);
  for (const bad of ["1,000", "$10", "1e5", "abc", "", "--1"]) assert.equal(parseMoney(bad), null, bad);
  assert.equal(parseMoney(Number.NaN), null);
  assert.equal(parseMoney(Infinity), null);
  // Float-noise inputs reconcile: 0.1 + 0.2 lines vs 0.3 subtotal.
  const floaty = await run({ invoice: { currency: "USD", subtotal: 0.3, tax: 0, total: 0.3, lineItems: [{ description: "a", quantity: 1, unitPrice: 0.1, total: 0.1 }, { description: "b", quantity: 1, unitPrice: 0.2, total: 0.2 }] }, options: AS_OF });
  assert.equal(floaty.financialChecks.subtotalValid, true);
  assert.equal(floaty.financialChecks.totalValid, true);
  // 3 × 33.333 = 99.999 stated as 100.00: within one minor unit.
  const rounded = await run({ invoice: { currency: "USD", subtotal: 100, taxRate: 5, tax: 5, total: 105, lineItems: [{ description: "Widgets", quantity: 3, unitPrice: "33.333", total: "100.00" }] }, options: AS_OF });
  assert.equal(rounded.financialChecks.lineTotalsValid, true);
  assert.deepEqual(codes(rounded).filter(c => c.endsWith("MISMATCH")), []);
  // Per-line tax rounding across many lines stays within ceil(N/2) + 1 minor units.
  const many = Array.from({ length: 7 }, (_, i) => ({ description: `Item ${i}`, quantity: 1, unitPrice: 0.99, taxRate: 7.5, total: 0.99 }));
  const perLine = await run({ invoice: { currency: "USD", subtotal: 6.93, tax: 0.52, total: 7.45, lineItems: many }, options: AS_OF });
  assert.equal(perLine.financialChecks.taxValid, true);
  // Just above tolerance ⇒ flagged (low materiality); a caller tolerance can widen it.
  const off = { currency: "USD", subtotal: 100, tax: 0, total: 100, lineItems: [{ description: "Widgets", quantity: 4, unitPrice: 25, total: 100.02 }] };
  const flagged = await run({ invoice: off, options: AS_OF });
  const line = find(flagged, "LINE_TOTAL_MISMATCH")!;
  assert.equal(line.severity, "low");
  assert.equal(flagged.financialChecks.lineTotalsValid, false);
  const widened = await run({ invoice: off, options: { ...AS_OF, roundingTolerance: 0.05 } });
  assert.equal(find(widened, "LINE_TOTAL_MISMATCH"), undefined);
  // 3-decimal and 0-decimal currencies use their own minor unit.
  const omr = await run({ invoice: { currency: "OMR", subtotal: "10.001", tax: 0, total: "10.001", lineItems: [{ description: "x", quantity: 1, unitPrice: "10.000", total: "10.000" }] }, options: AS_OF });
  assert.equal(omr.financialChecks.subtotalValid, true, "0.001 OMR is one minor unit");
  const omr2 = await run({ invoice: { currency: "OMR", subtotal: "10.003", tax: 0, total: "10.003", lineItems: [{ description: "x", quantity: 1, unitPrice: "10.000", total: "10.000" }] }, options: AS_OF });
  assert.equal(omr2.financialChecks.subtotalValid, false);
  const jpy = await run({ invoice: { currency: "JPY", subtotal: 1001, tax: 0, total: 1001, lineItems: [{ description: "x", quantity: 3, unitPrice: 333.33, total: 1000 }] }, options: AS_OF });
  assert.equal(jpy.financialChecks.lineTotalsValid, true);
  assert.equal(jpy.financialChecks.subtotalValid, true);
});

test("LINE_TOTAL_MISMATCH: incorrect quantity × unit price, with line-level evidence", async () => {
  const r = await run(withInvoice({ lineItems: [{ description: "Consulting services", quantity: 10, unitPrice: 900, taxRate: 5, total: 9200 }] }));
  const a = find(r, "LINE_TOTAL_MISMATCH")!;
  assert.ok(a);
  const issue = (a.evidence.issues as any[])[0];
  assert.equal(issue.lineIndex, 0);
  assert.equal(issue.expected, 9000);
  assert.equal(issue.stated, 9200);
  assert.equal(issue.difference, 200);
  assert.equal(a.severity, "medium");
  assert.equal(r.financialChecks.lineTotalsValid, false);
});

test("SUBTOTAL_MISMATCH, TAX_MISMATCH and TOTAL_MISMATCH each detected independently with expected vs stated evidence", async () => {
  const sub = await run(SCENARIOS.arithmeticError);
  assert.deepEqual(codes(sub), ["SUBTOTAL_MISMATCH"]);
  const s = (find(sub, "SUBTOTAL_MISMATCH")!.evidence.issues as any[])[0];
  assert.deepEqual([s.expected, s.stated, s.difference], [9200, 9500, 300]);
  assert.equal(sub.financialChecks.subtotalValid, false);
  assert.equal(sub.financialChecks.totalValid, true);
  assert.equal(sub.decision, "review");

  const tax = await run(withInvoice({ tax: 500, total: 9700 }));
  assert.deepEqual(codes(tax), ["TAX_MISMATCH"]);
  const t = (find(tax, "TAX_MISMATCH")!.evidence.issues as any[])[0];
  assert.deepEqual([t.expected, t.stated], [460, 500]);
  assert.equal(tax.financialChecks.taxValid, false);

  const invRate = await run({ invoice: { currency: "EUR", subtotal: 1000, taxRate: 20, tax: 180, total: 1180 }, options: AS_OF });
  assert.equal(find(invRate, "TAX_MISMATCH")!.evidence.issues instanceof Array, true);
  assert.equal(((find(invRate, "TAX_MISMATCH")!.evidence.issues as any[])[0]).expected, 200);

  const total = await run(withInvoice({ total: 9760 }));
  assert.deepEqual(codes(total), ["TOTAL_MISMATCH"]);
  const tt = (find(total, "TOTAL_MISMATCH")!.evidence.issues as any[])[0];
  assert.deepEqual([tt.expected, tt.stated, tt.difference], [9660, 9760, 100]);
  // Discount and shipping are part of the reconciliation.
  const ds = await run({ invoice: { currency: "USD", subtotal: 1000, discount: 100, shipping: 25, taxRate: 10, tax: 90, total: 1015 }, options: AS_OF });
  assert.equal(ds.financialChecks.totalValid, true);
  assert.equal(ds.financialChecks.taxValid, true);
});

test("DUPLICATE_INVOICE: same supplier + invoice number + amount, with the matched historical invoice returned", async () => {
  const r = await run(SCENARIOS.duplicate);
  const d = find(r, "DUPLICATE_INVOICE")!;
  assert.ok(d);
  assert.equal(d.severity, "high");
  assert.ok(d.confidence >= 0.95);
  assert.equal((d.evidence.matchedInvoice as any).invoiceId, "AP-8120");
  assert.equal(d.evidence.invoiceNumberRelation, "identical");
  assert.equal(d.evidence.amountDifferencePercent, 0);
  assert.equal(d.evidence.dateDifferenceDays, 0);
  assert.equal(find(r, "POSSIBLE_DUPLICATE"), undefined);
  assert.equal(r.decision, "review");
  // Formatting differences in the number do not hide the duplicate.
  const fmt = await run({ ...SCENARIOS.duplicate, invoice: { ...BASE_INVOICE, invoiceNumber: "inv 2026/1043" } });
  assert.ok(find(fmt, "DUPLICATE_INVOICE"));
  // Already paid (payment history only).
  const paid = await run({ invoice: BASE_INVOICE, paymentHistory: [{ invoiceNumber: "INV-2026-1043", supplierId: "SUP-291", paymentDate: "2026-09-21", amount: 9660, currency: "USD", bankAccount: "US123456789" }], options: AS_OF });
  const p = find(paid, "DUPLICATE_INVOICE")!;
  assert.equal(p.evidence.reason, "invoice_number_and_amount_already_paid");
  assert.equal(p.evidence.previouslyPaid, true);
});

test("POSSIBLE_DUPLICATE: same supplier, same amount, nearby date, slightly changed invoice number", async () => {
  const r = await run(SCENARIOS.nearDuplicate);
  const d = find(r, "POSSIBLE_DUPLICATE")!;
  assert.ok(d);
  assert.equal(find(r, "DUPLICATE_INVOICE"), undefined, "never confirmed without an identical number");
  assert.equal(d.severity, "high");
  assert.equal(d.evidence.invoiceNumberRelation, "variant");
  assert.equal(d.evidence.dateDifferenceDays, 2);
  assert.equal(d.evidence.amountDifferencePercent, 0);
  assert.equal((d.evidence.matchedInvoice as any).invoiceNumber, "INV-2026-1043");
  assert.ok((d.evidence.matchSignals as string[]).includes("invoice_number_variant"));
  // Same amount + nearby date + same line items (sequential number) ⇒ corroborated.
  const lines = await run({ ...SCENARIOS.nearDuplicate, invoice: { ...BASE_INVOICE, invoiceNumber: "INV-2026-1044" } });
  const l = find(lines, "POSSIBLE_DUPLICATE")!;
  assert.ok((l.evidence.matchSignals as string[]).includes("same_line_items"));
  assert.equal(l.evidence.invoiceNumberRelation, "sequential");
  // Reused number with a different amount.
  const reused = await run({ ...SCENARIOS.duplicate, invoice: { ...BASE_INVOICE, subtotal: 9300, tax: 465, total: 9765, lineItems: [{ description: "Consulting services", quantity: 10, unitPrice: 930, taxRate: 5, total: 9300 }] } });
  assert.equal(find(reused, "POSSIBLE_DUPLICATE")!.evidence.reason, "invoice_number_reused_with_different_amount");
  assert.equal(find(reused, "DUPLICATE_INVOICE"), undefined);
});

test("duplicate detection is false-positive resistant: recurring fees, sequential numbering, other suppliers, the same record", async () => {
  // Monthly subscription: same amount every month, sequential numbers, 30-day gaps.
  const monthly = [1, 2, 3, 4].map(m => ({ invoiceNumber: `SUB-${1000 + m}`, supplierId: "SUP-9", supplierName: "Cloud Host Ltd", invoiceDate: `2026-0${4 + m}-01`, currency: "USD", total: 499, status: "paid" as const, lineItems: [{ description: "Hosting plan", quantity: 1, unitPrice: 499, total: 499 }] }));
  const sub = await run({ invoice: { invoiceNumber: "SUB-1005", supplierId: "SUP-9", supplierName: "Cloud Host Ltd", invoiceDate: "2026-09-01", currency: "USD", subtotal: 499, tax: 0, total: 499, lineItems: [{ description: "Hosting plan", quantity: 1, unitPrice: 499, total: 499 }] }, historicalInvoices: monthly, options: AS_OF });
  assert.deepEqual(codes(sub).filter(c => c.includes("DUPLICATE")), []);
  // Weekly fixed-fee invoices 7 days apart with identical lines: recurring pattern ⇒ not a duplicate.
  const weekly = [1, 8, 15].map((d, i) => ({ invoiceNumber: `WK-${200 + i}`, supplierId: "SUP-7", invoiceDate: `2026-09-${String(d).padStart(2, "0")}`, currency: "USD", total: 1200, status: "paid" as const, lineItems: [{ description: "Weekly cleaning", quantity: 1, unitPrice: 1200, total: 1200 }] }));
  const wk = await run({ invoice: { invoiceNumber: "WK-203", supplierId: "SUP-7", invoiceDate: "2026-09-22", currency: "USD", subtotal: 1200, tax: 0, total: 1200, lineItems: [{ description: "Weekly cleaning", quantity: 1, unitPrice: 1200, total: 1200 }] }, historicalInvoices: weekly, options: AS_OF });
  assert.deepEqual(codes(wk).filter(c => c.includes("DUPLICATE")), []);
  // Same invoice number at a different supplier with a different amount.
  const other = await run({ invoice: BASE_INVOICE, historicalInvoices: [{ invoiceNumber: "INV-2026-1043", supplierId: "SUP-555", supplierName: "Other Co", invoiceDate: "2026-09-19", currency: "USD", total: 120 }], options: AS_OF });
  assert.deepEqual(codes(other), []);
  // Same supplier, same amount but 40 days apart with an unrelated number ⇒ nothing.
  const far = await run({ invoice: BASE_INVOICE, historicalInvoices: [{ invoiceNumber: "INV-2026-0900", supplierId: "SUP-291", invoiceDate: "2026-08-11", currency: "USD", total: 9660 }], options: AS_OF });
  assert.deepEqual(codes(far), []);
  // The very same record (same invoiceId) re-submitted for checking is not its own duplicate.
  const self = await run({ invoice: { ...BASE_INVOICE, invoiceId: "AP-8120" }, historicalInvoices: SCENARIOS.duplicate.historicalInvoices, options: AS_OF });
  assert.deepEqual(codes(self), []);
  // Same amount in a different currency is not a match.
  const cur = await run({ invoice: BASE_INVOICE, historicalInvoices: [{ invoiceNumber: "INV-2026-1043", supplierId: "SUP-291", invoiceDate: "2026-09-20", currency: "EUR", total: 9660 }], options: AS_OF });
  assert.equal(find(cur, "DUPLICATE_INVOICE"), undefined);
  // A cancelled invoice with the same number and amount ⇒ resubmission (medium), not a confirmed duplicate.
  const resub = await run({ invoice: BASE_INVOICE, historicalInvoices: [{ invoiceNumber: "INV-2026-1043", supplierId: "SUP-291", invoiceDate: "2026-09-10", currency: "USD", total: 9660, status: "cancelled" }], options: AS_OF });
  assert.equal(find(resub, "DUPLICATE_INVOICE"), undefined);
  assert.equal(find(resub, "POSSIBLE_DUPLICATE")!.evidence.reason, "resubmission_of_cancelled_invoice");
});

test("invoice-number relations are classified deterministically", () => {
  const n = (s: string) => invoiceNumberInfo(s);
  assert.equal(numberRelation(n("INV-1043"), n("inv 1043")), "identical");
  assert.equal(numberRelation(n("1043"), n("INV-001043")), "equivalent");
  assert.equal(numberRelation(n("INV-1043"), n("INV-1043A")), "variant");
  assert.equal(numberRelation(n("INV-1043"), n("INV-1044")), "sequential");
  assert.equal(numberRelation(n("ABX-77310"), n("ABX-77130")), "variant", "digit transposition beyond the sequential gap");
  assert.equal(numberRelation(n("AAA-1"), n("ZZZ-99999")), "different");
});

test("UNUSUAL_AMOUNT: materially above the supplier's history (robust median/MAD baseline)", async () => {
  const high = await run(withInvoice({ subtotal: 46000, tax: 2300, total: 48300, lineItems: [{ description: "Consulting services", quantity: 50, unitPrice: 920, taxRate: 5, total: 46000 }] }, { historicalInvoices: NORMAL_HISTORY }));
  const a = find(high, "UNUSUAL_AMOUNT")!;
  assert.equal(a.severity, "high");
  const e = (a.evidence.issues as any[])[0];
  assert.equal(e.historicalMedian, 9177);
  assert.equal(e.historicalMax, 9901.5);
  assert.equal(e.sampleSize, 3);
  assert.ok(e.ratioToMedian > 5);
  const medium = await run(withInvoice({ subtotal: 23000, tax: 1150, total: 24150, lineItems: [{ description: "Consulting services", quantity: 25, unitPrice: 920, taxRate: 5, total: 23000 }] }, { historicalInvoices: NORMAL_HISTORY }));
  assert.equal(find(medium, "UNUSUAL_AMOUNT")!.severity, "medium");
  // Slightly above the max is normal variation; too little history ⇒ no baseline (noted in limitations).
  const slight = await run(withInvoice({ subtotal: 9600, tax: 480, total: 10080, lineItems: [{ description: "Consulting services", quantity: 10, unitPrice: 960, taxRate: 5, total: 9600 }] }, { historicalInvoices: NORMAL_HISTORY }));
  assert.equal(find(slight, "UNUSUAL_AMOUNT"), undefined);
  const thin = await run(withInvoice({ subtotal: 46000, tax: 2300, total: 48300, lineItems: [] }, { historicalInvoices: NORMAL_HISTORY.slice(0, 2) }));
  assert.equal(find(thin, "UNUSUAL_AMOUNT"), undefined);
  assert.ok(thin.limitations.some(l => /need at least 3 prior invoices/.test(l)));
});

test("SUPPLIER_PATTERN_DEVIATION: blocked supplier, profile mismatch, new supplier record, frequency spike", async () => {
  const blocked = await run({ invoice: BASE_INVOICE, supplierProfile: { supplierId: "SUP-291", supplierName: "ABC Trading LLC", status: "blocked", bankAccounts: ["US123456789"] }, options: AS_OF });
  const b = find(blocked, "SUPPLIER_PATTERN_DEVIATION")!;
  assert.equal(b.severity, "high");
  assert.deepEqual(issueReasons(b), ["supplier_blocked"]);
  const renamed = await run({ invoice: { ...BASE_INVOICE, supplierId: undefined, supplierName: "Zenith Global Imports" }, supplierProfile: { supplierName: "ABC Trading LLC", bankAccounts: ["US123456789"] }, options: AS_OF });
  assert.ok(issueReasons(find(renamed, "SUPPLIER_PATTERN_DEVIATION")).includes("supplier_name_differs_from_profile"));
  const fresh = await run({ invoice: BASE_INVOICE, supplierProfile: { supplierId: "SUP-291", createdDate: "2026-09-10", bankAccounts: ["US123456789"] }, options: AS_OF });
  assert.ok(issueReasons(find(fresh, "SUPPLIER_PATTERN_DEVIATION")).includes("recently_created_supplier_record"));
  // Roughly one invoice a month for a year, then 4 in the last 30 days.
  const monthly = Array.from({ length: 10 }, (_, i) => ({ invoiceNumber: `INV-2025-${100 + i}`, supplierId: "SUP-291", invoiceDate: `2025-${String(i + 1).padStart(2, "0")}-15`, currency: "USD", total: 9000 + i * 100 }));
  const burst = ["2026-09-01", "2026-09-08", "2026-09-15"].map((d, i) => ({ invoiceNumber: `INV-2026-${900 + i}`, supplierId: "SUP-291", invoiceDate: d, currency: "USD", total: 9100 + i * 37 }));
  const spike = await run({ invoice: BASE_INVOICE, historicalInvoices: [...monthly, ...burst], options: AS_OF });
  const s = find(spike, "SUPPLIER_PATTERN_DEVIATION")!;
  assert.deepEqual(issueReasons(s), ["invoice_frequency_increase"]);
  assert.equal((s.evidence.issues as any[])[0].invoicesLast30Days, 4);
});

test("UNUSUAL_CURRENCY: new currency for the supplier, outside the profile, differs from the contract, not ISO 4217", async () => {
  const eur = await run(withInvoice({ currency: "EUR" }, { historicalInvoices: NORMAL_HISTORY }));
  const c = find(eur, "UNUSUAL_CURRENCY")!;
  assert.deepEqual(issueReasons(c), ["new_currency_for_supplier"]);
  assert.deepEqual((c.evidence.issues as any[])[0].historicalCurrencies, ["USD"]);
  const prof = await run(withInvoice({ currency: "GBP" }, { supplierProfile: { supplierId: "SUP-291", currencies: ["usd"], bankAccounts: ["US123456789"] } }));
  assert.ok(issueReasons(find(prof, "UNUSUAL_CURRENCY")).includes("currency_not_in_supplier_profile"));
  const contract = await run(withInvoice({ currency: "AED" }, { contract: { contractId: "C-1", supplierId: "SUP-291", currency: "USD" } }));
  assert.ok(issueReasons(find(contract, "UNUSUAL_CURRENCY")).includes("differs_from_contract_currency"));
  const bogus = await run(withInvoice({ currency: "XYZ" }));
  assert.deepEqual(issueReasons(find(bogus, "UNUSUAL_CURRENCY")), ["not_an_active_iso_4217_code"]);
  assert.equal(find(bogus, "UNUSUAL_CURRENCY")!.severity, "low");
});

test("UNUSUAL_PAYMENT_TERMS: materially shorter than contract / profile / history", async () => {
  const r = await run(withInvoice({ paymentTermsDays: 7, dueDate: "2026-09-27" }, { historicalInvoices: NORMAL_HISTORY }));
  const t = find(r, "UNUSUAL_PAYMENT_TERMS")!;
  const e = (t.evidence.issues as any[])[0];
  assert.deepEqual([e.invoiceTermsDays, e.expectedTermsDays], [7, 30]);
  assert.match(e.expectedSource, /^supplier_history_median_of_3$/);
  const c = await run(withInvoice({ paymentTermsDays: 15, dueDate: "2026-10-05" }, { contract: { supplierId: "SUP-291", paymentTermsDays: 45 } }));
  assert.equal((find(c, "UNUSUAL_PAYMENT_TERMS")!.evidence.issues as any[])[0].expectedSource, "contract");
  const ok = await run(withInvoice({ paymentTermsDays: 25, dueDate: "2026-10-15" }, { historicalInvoices: NORMAL_HISTORY }));
  assert.equal(find(ok, "UNUSUAL_PAYMENT_TERMS"), undefined, "a few days shorter is not material");
});

test("BANK_ACCOUNT_CHANGED: account differs from supplier records — high weight, masked evidence", async () => {
  const r = await run(SCENARIOS.bankChange);
  const b = find(r, "BANK_ACCOUNT_CHANGED")!;
  assert.equal(b.severity, "high");
  assert.ok(b.confidence >= 0.8);
  assert.equal(b.evidence.invoiceAccountMasked, "****6789");
  assert.deepEqual(b.evidence.knownAccountsMasked, ["****4321"]);
  assert.equal(r.riskLevel, "high");
  assert.equal(r.decision, "review");
  // Formatting differences are not a change.
  const same = await run({ ...SCENARIOS.clean, invoice: { ...BASE_INVOICE, bankAccount: "us-1234 56789" } });
  assert.equal(find(same, "BANK_ACCOUNT_CHANGED"), undefined);
  // Profile account added days before the invoice and never paid before ⇒ recent change (medium).
  const recent = await run({ invoice: BASE_INVOICE, historicalInvoices: NORMAL_HISTORY.map(h => ({ ...h, bankAccount: undefined })), supplierProfile: { supplierId: "SUP-291", bankAccounts: [{ account: "US123456789", verified: true, addedDate: "2026-09-15" }] }, options: AS_OF });
  const rc = find(recent, "BANK_ACCOUNT_CHANGED")!;
  assert.equal(rc.evidence.reason, "recently_added_account_first_use");
  assert.equal(rc.severity, "medium");
  // Account also used by another supplier ⇒ critical.
  const shared = await run({ ...SCENARIOS.bankChange, historicalInvoices: [...SCENARIOS.bankChange.historicalInvoices, { invoiceNumber: "Z-1", supplierId: "SUP-777", supplierName: "Other Vendor Ltd", invoiceDate: "2026-09-01", currency: "USD", total: 10, bankAccount: "US123456789" }] });
  const sh = find(shared, "BANK_ACCOUNT_CHANGED")!;
  assert.equal(sh.severity, "critical");
  assert.equal(sh.evidence.accountSeenForOtherSuppliers, true);
});

test("UNKNOWN_BANK_ACCOUNT: supplier context exists but no account on record (or only unverified); standalone is never flagged", async () => {
  const r = await run({ invoice: BASE_INVOICE, supplierProfile: { supplierId: "SUP-291", supplierName: "ABC Trading LLC" }, options: AS_OF });
  const u = find(r, "UNKNOWN_BANK_ACCOUNT")!;
  assert.equal(u.evidence.reason, "no_account_on_record");
  assert.equal(u.severity, "high");
  assert.equal(r.decision, "review");
  const unverified = await run({ invoice: BASE_INVOICE, supplierProfile: { supplierId: "SUP-291", bankAccounts: [{ account: "US123456789", verified: false }] }, options: AS_OF });
  assert.equal(find(unverified, "UNKNOWN_BANK_ACCOUNT")!.evidence.reason, "account_on_file_unverified");
  const standalone = await run({ invoice: BASE_INVOICE, options: AS_OF });
  assert.equal(find(standalone, "UNKNOWN_BANK_ACCOUNT"), undefined);
  assert.equal(find(standalone, "BANK_ACCOUNT_CHANGED"), undefined);
  // History without account fields is a data gap (limitation), not an anomaly.
  const gap = await run({ invoice: BASE_INVOICE, historicalInvoices: NORMAL_HISTORY.map(h => ({ ...h, bankAccount: undefined })), options: AS_OF });
  assert.deepEqual(codes(gap), []);
  assert.ok(gap.limitations.some(l => /carry no bank account/.test(l)));
});

test("sensitive payment data is masked everywhere in the output", async () => {
  const shortAcct = await run({ invoice: { ...BASE_INVOICE, bankAccount: "12345" }, supplierProfile: { supplierId: "SUP-291" }, options: AS_OF });
  for (const r of [await run(SCENARIOS.bankChange), await run(SCENARIOS.multiple), shortAcct]) {
    const json = JSON.stringify(r);
    for (const raw of ["US123456789", "123456789", "US987654321", "987654321", "12345\""]) assert.ok(!json.includes(raw), `raw account ${raw} leaked`);
  }
  assert.equal((await run(SCENARIOS.bankChange)).invoiceSummary.bankAccountMasked, "****6789");
  assert.equal(maskAccount("12345"), "****");
  assert.equal(maskAccount("GB29NWBK60161331926819"), "****6819");
});

test("PO match: an invoice that agrees with its purchase order raises no PO anomalies", async () => {
  const r = await run({ invoice: BASE_INVOICE, purchaseOrder: { poNumber: "PO 2026 818", supplierId: "SUP-291", currency: "USD", totalAmount: 20000, invoicedToDate: 0, issueDate: "2026-09-01", status: "open", lineItems: [{ description: "Consulting services", quantity: 10, unitPrice: 920 }] }, options: AS_OF });
  assert.deepEqual(codes(r), []);
});

test("PO_AMOUNT_EXCEEDED and PO_MISMATCH (reference, supplier, currency, quantity, price, status)", async () => {
  const r = await run(SCENARIOS.poExceeded);
  const p = find(r, "PO_AMOUNT_EXCEEDED")!;
  const e = (p.evidence.issues as any[])[0];
  assert.deepEqual([e.remainingPoBalance, e.invoiceAmount, e.excessAmount], [7000, 9660, 2660]);
  assert.equal(e.excessPercentOfPo, 22.17);
  assert.equal(p.severity, "high");
  // Net comparison when PO amounts exclude tax.
  const net = await run({ ...SCENARIOS.poExceeded, purchaseOrder: { ...SCENARIOS.poExceeded.purchaseOrder, totalAmount: 14250, invoicedToDate: 5000, amountsIncludeTax: false } });
  assert.equal(find(net, "PO_AMOUNT_EXCEEDED"), undefined, "9,200 net fits the 9,250 remaining");
  const mismatch = await run({ invoice: { ...BASE_INVOICE, lineItems: [{ description: "Consulting services", quantity: 10, unitPrice: 920, taxRate: 5, total: 9200 }] }, purchaseOrder: { poNumber: "PO-2026-999", supplierId: "SUP-555", currency: "EUR", totalAmount: 50000, status: "closed", lineItems: [{ description: "Consulting services", quantity: 8, unitPrice: 900 }] }, options: AS_OF });
  const m = find(mismatch, "PO_MISMATCH")!;
  assert.equal(m.severity, "high");
  const reasons = issueReasons(m);
  for (const r2 of ["po_number_differs", "supplier_differs_from_po", "currency_differs_from_po", "po_closed", "quantity_exceeds_ordered", "unit_price_above_po"]) assert.ok(reasons.includes(r2), r2);
  assert.equal(find(mismatch, "PO_AMOUNT_EXCEEDED"), undefined, "amounts in different currencies are never compared");
  assert.ok(mismatch.limitations.some(l => /currencies differ/.test(l)));
});

test("CONTRACT_LIMIT_EXCEEDED: cumulative cap (caller-supplied or derived from history) and per-invoice maximum", async () => {
  const caller = await run({ invoice: BASE_INVOICE, contract: { contractId: "C-9", supplierId: "SUP-291", currency: "USD", maxAmount: 50000, invoicedToDate: 45000 }, options: AS_OF });
  const c = find(caller, "CONTRACT_LIMIT_EXCEEDED")!;
  const e = (c.evidence.issues as any[])[0];
  assert.deepEqual([e.contractCap, e.cumulativeAmount, e.excessAmount, e.consumedBasis], [50000, 54660, 4660, "caller_supplied_invoicedToDate"]);
  const derived = await run({ invoice: BASE_INVOICE, historicalInvoices: NORMAL_HISTORY, contract: { supplierId: "SUP-291", maxAmount: 30000, startDate: "2026-01-01", endDate: "2026-12-31" }, options: AS_OF });
  const d = (find(derived, "CONTRACT_LIMIT_EXCEEDED")!.evidence.issues as any[])[0];
  assert.equal(d.invoicedBeforeThisInvoice, 27772.5);
  assert.equal(d.consumedBasis, "sum_of_3_supplied_historical_invoices");
  const per = await run({ invoice: BASE_INVOICE, contract: { supplierId: "SUP-291", maxInvoiceAmount: 5000 }, options: AS_OF });
  assert.deepEqual(issueReasons(find(per, "CONTRACT_LIMIT_EXCEEDED")), ["invoice_above_contract_per_invoice_maximum"]);
  const within = await run({ invoice: BASE_INVOICE, contract: { supplierId: "SUP-291", maxAmount: 100000, invoicedToDate: 1000 }, options: AS_OF });
  assert.equal(find(within, "CONTRACT_LIMIT_EXCEEDED"), undefined);
});

test("SPLIT_INVOICE_PATTERN: invoices individually under the approval threshold that together exceed it", async () => {
  const r = await run(SCENARIOS.splitInvoice);
  const s = find(r, "SPLIT_INVOICE_PATTERN")!;
  assert.ok(s);
  assert.equal(s.evidence.pattern, "split_group_below_threshold");
  assert.equal(s.evidence.combinedAmount, 11592);
  assert.equal(s.evidence.invoiceCount, 3);
  assert.equal(s.evidence.approvalThreshold, 10000);
  assert.ok((s.evidence.signals as string[]).includes("similar_line_items"));
  assert.match(s.explanation, /not by itself evidence of wrongdoing/);
  assert.equal(find(r, "POSSIBLE_DUPLICATE"), undefined, "different amounts are not duplicates");
  // Repeated just-below-threshold amounts over a longer window.
  const repeated = await run({
    invoice: { invoiceNumber: "Q-40", supplierId: "S-1", invoiceDate: "2026-09-20", currency: "USD", total: 9850 },
    historicalInvoices: [{ invoiceNumber: "Q-31", supplierId: "S-1", invoiceDate: "2026-08-02", currency: "USD", total: 9700 }, { invoiceNumber: "Q-35", supplierId: "S-1", invoiceDate: "2026-08-30", currency: "USD", total: 9920 }],
    approvalContext: { approvalThreshold: 10000 }, options: AS_OF
  });
  assert.equal(find(repeated, "SPLIT_INVOICE_PATTERN")!.evidence.pattern, "repeated_just_below_threshold");
  // Without a threshold, or when the invoice itself is above it, no split finding.
  assert.equal(find(await run({ ...SCENARIOS.splitInvoice, approvalContext: undefined }), "SPLIT_INVOICE_PATTERN"), undefined);
  const above = await run({ ...SCENARIOS.splitInvoice, approvalContext: { approvalThreshold: 4000 } });
  assert.equal(find(above, "SPLIT_INVOICE_PATTERN"), undefined);
  assert.equal(find(above, "APPROVAL_THRESHOLD_EXCEEDED")!.severity, "info");
});

test("DUPLICATE_LINE_ITEM: exact and near repeats on one invoice; same description at another price is fine", async () => {
  const r = await run({ invoice: { currency: "USD", subtotal: 300, tax: 0, total: 300, lineItems: [
    { description: "Site visit", quantity: 1, unitPrice: 100, total: 100 }, { description: "Site  visit.", quantity: 1, unitPrice: 100, total: 100 }, { description: "Site visit", quantity: 1, unitPrice: 100, total: 100 }
  ] }, options: AS_OF });
  const d = find(r, "DUPLICATE_LINE_ITEM")!;
  assert.equal(d.severity, "medium");
  assert.equal(d.evidence.repeatedLineCount, 2);
  const priced = await run({ invoice: { currency: "USD", subtotal: 250, tax: 0, total: 250, lineItems: [{ description: "Site visit", quantity: 1, unitPrice: 100, total: 100 }, { description: "Site visit", quantity: 1, unitPrice: 150, total: 150 }] }, options: AS_OF });
  assert.equal(find(priced, "DUPLICATE_LINE_ITEM"), undefined);
});

test("DUE_DATE_ANOMALY and DATE_ANOMALY: impossible chronology flagged, legitimate edge cases not", async () => {
  const before = await run(withInvoice({ dueDate: "2026-09-10", paymentTermsDays: undefined }));
  assert.deepEqual(issueReasons(find(before, "DUE_DATE_ANOMALY")), ["due_date_before_invoice_date"]);
  const terms = await run(withInvoice({ dueDate: "2026-11-30", paymentTermsDays: 30 }));
  assert.deepEqual(issueReasons(find(terms, "DUE_DATE_ANOMALY")), ["due_date_inconsistent_with_payment_terms"]);
  const future = await run(withInvoice({ invoiceDate: "2026-10-15", dueDate: "2026-11-14" }));
  assert.equal((find(future, "DATE_ANOMALY")!.evidence.issues as any[])[0].daysAhead, 22);
  const poDate = await run(withInvoice({}, { purchaseOrder: { poNumber: "PO-2026-818", supplierId: "SUP-291", issueDate: "2026-09-22" } }));
  assert.ok(issueReasons(find(poDate, "DATE_ANOMALY")).includes("invoice_dated_before_po_issue_date"));
  const outside = await run(withInvoice({}, { contract: { supplierId: "SUP-291", startDate: "2025-01-01", endDate: "2025-12-31" } }));
  assert.ok(issueReasons(find(outside, "DATE_ANOMALY")).includes("invoice_dated_after_contract_end"));
  // Edge cases: due on the invoice date, tomorrow's date (time zones), past due date, ±3 days of terms.
  for (const patch of [{ dueDate: "2026-09-20", paymentTermsDays: 0 }, { invoiceDate: "2026-09-24", dueDate: "2026-10-24" }, { invoiceDate: "2026-06-01", dueDate: "2026-07-01" }, { dueDate: "2026-10-22" }]) {
    const r = await run(withInvoice(patch));
    assert.deepEqual(codes(r).filter(c => c.includes("DATE")), [], JSON.stringify(patch));
  }
  // Default as-of date is today (injectable), and output carries it.
  const r = await runInvoiceAnomalyCheck({ invoice: { ...BASE_INVOICE, invoiceDate: "2026-09-20" } }, { today: () => Math.floor(Date.UTC(2026, 8, 1) / 86_400_000) });
  assert.equal(r.asOfDate, "2026-09-01");
  assert.equal(r.checkedAt, "2026-09-01T00:00:00.000Z");
  assert.ok(find(r, "DATE_ANOMALY"));
});

test("INVOICE_NUMBER_ANOMALY: placeholder numbers, format deviations and out-of-sequence numbers", async () => {
  const placeholder = await run(withInvoice({ invoiceNumber: "N/A" }));
  assert.deepEqual(issueReasons(find(placeholder, "INVOICE_NUMBER_ANOMALY")), ["placeholder_or_non_identifying_invoice_number"]);
  const format = await run(withInvoice({ invoiceNumber: "10431" }, { historicalInvoices: NORMAL_HISTORY }));
  const f = find(format, "INVOICE_NUMBER_ANOMALY")!;
  assert.equal((f.evidence.issues as any[])[0].establishedFormat, "AAA-9999-9999");
  const seq = await run(withInvoice({ invoiceNumber: "INV-2026-0501" }, { historicalInvoices: NORMAL_HISTORY }));
  assert.ok(issueReasons(find(seq, "INVOICE_NUMBER_ANOMALY")).includes("number_lower_than_all_prior_invoices_despite_later_date"));
  const normal = await run(SCENARIOS.clean);
  assert.equal(find(normal, "INVOICE_NUMBER_ANOMALY"), undefined);
});

test("multiple correlated anomalies (duplicate + changed bank details + PO mismatch) escalate to critical / hold", async () => {
  const r = await run(SCENARIOS.multiple);
  for (const c of ["POSSIBLE_DUPLICATE", "BANK_ACCOUNT_CHANGED", "PO_MISMATCH"] as const) assert.ok(find(r, c), c);
  assert.equal(r.riskLevel, "critical");
  assert.equal(r.decision, "hold");
  assert.ok(r.scoring.escalationBonus > 0);
  assert.ok(r.scoring.escalationReasons.some(x => /payment-detail anomaly combined/.test(x)));
  assert.match(r.recommendedAction, /Verify the payment details/);
});

test("invalid input: schema errors and value errors are structured, name the path and never echo values", async () => {
  await rejects(run({}), 400, "INVALID_INPUT");
  await rejects(run({ invoice: { invoiceNumber: "A" } }), 400, "INVALID_INPUT");
  await rejects(run({ invoice: { total: 1, bogus: true } }), 400, "INVALID_INPUT");
  await rejects(run({ invoice: { total: 1 }, extra: 1 }), 400, "INVALID_INPUT");
  await rejects(run({ invoice: { total: "1,000.00" } }), 400, "INVALID_MONETARY_VALUE", "invoice.total");
  await rejects(run({ invoice: { total: 10, lineItems: [{ quantity: "two" }] } }), 400, "INVALID_MONETARY_VALUE", "invoice.lineItems.0.quantity");
  await rejects(run({ invoice: { total: 10, invoiceDate: "2026-02-30" } }), 400, "INVALID_DATE", "invoice.invoiceDate");
  await rejects(run({ invoice: { total: 10, invoiceDate: "20/09/2026" } }), 400, "INVALID_DATE", "invoice.invoiceDate");
  await rejects(run({ invoice: { total: 10 }, historicalInvoices: [{ total: 5, invoiceDate: "yesterday" }] }), 400, "INVALID_DATE", "historicalInvoices.0.invoiceDate");
  await rejects(run({ invoice: { total: 10, currency: "US Dollars" } }), 400, "UNSUPPORTED_CURRENCY_FORMAT", "invoice.currency");
  await rejects(run({ invoice: { total: 10, currency: "$" } }), 400, "UNSUPPORTED_CURRENCY_FORMAT");
  const e = await rejects(run({ invoice: { total: 10, bankAccount: "GB29NWBK60161331926819", invoiceDate: "bad" } }), 400, "INVALID_DATE");
  assert.ok(!JSON.stringify(publicError(e)).includes("GB29NWBK"));
  assert.ok((await rejects(run({ invoice: {} }), 400, "INVALID_INPUT")) instanceof ZodError);
  assert.ok((await rejects(run({ invoice: { total: "x" } }), 400, "INVALID_MONETARY_VALUE")) instanceof ApiError);
  // Case-insensitive currency and ISO date-times are accepted.
  const ok = await run({ invoice: { total: 10, currency: " usd ", invoiceDate: "2026-09-20T23:30:00Z" }, options: AS_OF });
  assert.equal(ok.invoiceSummary.currency, "USD");
  assert.equal(ok.invoiceSummary.invoiceDate, "2026-09-20");
});

test("risk scoring: transparent components, severity caps, band boundaries and decision mapping", () => {
  const a = (code: AnomalyCode, severity: Severity, confidence = 1): Anomaly => ({ code, severity, confidence, field: null, explanation: "", evidence: {} });
  assert.deepEqual(scoreAnomalies([]).riskScore, 0);
  // Many trivial warnings cannot make a critical (or even medium) result.
  const lows = scoreAnomalies(Array.from({ length: 12 }, () => a("DATE_ANOMALY", "low")));
  assert.equal(lows.riskScore, 10);
  assert.equal(lows.riskLevel, "low");
  assert.equal(lows.decision, "continue");
  // Many mediums across families stay at most "high" without a high anomaly.
  const mediums = scoreAnomalies((["SUBTOTAL_MISMATCH", "UNUSUAL_CURRENCY", "PO_MISMATCH", "DUE_DATE_ANOMALY", "DUPLICATE_LINE_ITEM", "SPLIT_INVOICE_PATTERN"] as AnomalyCode[]).map(c => a(c, "medium")));
  assert.equal(mediums.riskScore, 64);
  assert.equal(mediums.riskLevel, "high");
  assert.equal(mediums.breakdown.cappedBySeverity, true);
  // Band edges.
  const level = (s: number) => scoreAnomalies([a("UNUSUAL_AMOUNT", "high", s / 35)]);
  assert.equal(level(14).riskLevel, "low");
  assert.equal(level(15).riskLevel, "medium");
  assert.equal(level(39).riskLevel, "medium");
  assert.equal(level(40).riskLevel, "high");
  assert.equal(scoreAnomalies([a("BANK_ACCOUNT_CHANGED", "critical"), a("DUPLICATE_INVOICE", "high")]).riskLevel, "critical");
  assert.equal(scoreAnomalies([a("BANK_ACCOUNT_CHANGED", "critical"), a("DUPLICATE_INVOICE", "high")]).decision, "hold");
  assert.equal(scoreAnomalies([a("DUPLICATE_INVOICE", "high", 0.98)]).riskLevel, "high");
  assert.equal(scoreAnomalies([a("DUPLICATE_INVOICE", "high", 0.98)]).decision, "review");
  // Info anomalies never score; components explain every point.
  const info = scoreAnomalies([a("APPROVAL_THRESHOLD_EXCEEDED", "info")]);
  assert.equal(info.riskScore, 0);
  const b = scoreAnomalies([a("BANK_ACCOUNT_CHANGED", "high", 0.9)]).breakdown;
  assert.deepEqual(b.components[0], { code: "BANK_ACCOUNT_CHANGED", severity: "high", confidence: 0.9, basePoints: 55, points: 49.5 });
  assert.equal(b.model, "iac-1.0.0");
  // Every engine output's score equals its own breakdown.
  return (async () => {
    for (const s of Object.values(SCENARIOS)) {
      const r = await run(s);
      if (!r.scoring.cappedBySeverity) assert.equal(r.riskScore, Math.min(100, Math.round(r.scoring.rawScore)));
      assert.equal(r.anomalyCount, r.anomalies.length);
      assert.equal(r.scoring.components.length, r.anomalies.length);
    }
  })();
});

test("deterministic: identical input ⇒ identical output, repeatedly and regardless of history order for the verdict", async () => {
  for (const s of Object.values(SCENARIOS)) {
    const first = await run(s);
    for (let i = 0; i < 3; i++) assert.deepEqual(await run(structuredClone(s)), first);
  }
  const s = SCENARIOS.multiple;
  const reversed = await run({ ...s, historicalInvoices: [...s.historicalInvoices].reverse() });
  const original = await run(s);
  assert.deepEqual([reversed.riskScore, codes(reversed)], [original.riskScore, codes(original)]);
});

test("explanations use risk-indicator language, never accusations", async () => {
  for (const s of Object.values(SCENARIOS)) {
    const r = await run(s);
    const text = [r.summary, r.recommendedAction, ...r.anomalies.map(a => a.explanation)].join(" ");
    assert.ok(!/fraudulent|committed fraud|criminal|is fraud\b/i.test(text), text);
  }
});

test("performance: one invoice with 500 lines against 1,000 historical invoices and 1,000 payments completes quickly", async () => {
  const history = Array.from({ length: 1000 }, (_, i) => ({
    invoiceNumber: `INV-${10000 + i}`, supplierId: `SUP-${i % 20}`, invoiceDate: `2026-${String((i % 8) + 1).padStart(2, "0")}-${String((i % 27) + 1).padStart(2, "0")}`,
    currency: "USD", total: 1000 + (i % 97) * 13.5, bankAccount: `ACCT${i % 20}`, lineItems: Array.from({ length: 20 }, (_, j) => ({ description: `Part ${j} batch ${i % 5}`, quantity: 1, unitPrice: 10, total: 10 }))
  }));
  const payments = Array.from({ length: 1000 }, (_, i) => ({ invoiceNumber: `INV-${10000 + i}`, supplierId: `SUP-${i % 20}`, paymentDate: "2026-09-01", amount: 1000, currency: "USD", bankAccount: `ACCT${i % 20}` }));
  const lines = Array.from({ length: 500 }, (_, j) => ({ description: `Component ${j} spec rev ${j % 7}`, quantity: 2, unitPrice: 5.25, taxRate: 5, total: 10.5 }));
  const input = { invoice: { invoiceNumber: "INV-20000", supplierId: "SUP-3", invoiceDate: "2026-09-20", currency: "USD", subtotal: 5250, tax: 262.5, total: 5512.5, bankAccount: "ACCT3", lineItems: lines }, historicalInvoices: history, paymentHistory: payments, approvalContext: { approvalThreshold: 10000 }, options: AS_OF };
  const started = performance.now();
  const r = await run(input);
  const ms = performance.now() - started;
  assert.ok(invoiceAnomalyCheckOutput.safeParse(r).success);
  assert.ok(ms < 3000, `took ${Math.round(ms)} ms`);
});

// ---- integration --------------------------------------------------------------------------------

test("registry + discovery: every surface lists invoice_anomaly_check with price, schemas, whenToUse and examples; MCP uses the same engine", async () => {
  assert.ok(cap);
  assert.equal(cap.path, "/finance/invoice-anomaly-check");
  assert.equal(cap.category, "finance_risk");
  assert.equal(cap.description.startsWith("Detect duplicate, inconsistent, unusual or potentially fraudulent invoices before payment using arithmetic, supplier-history, purchase-order and payment-detail checks."), true);
  assert.equal(cap.whenToUse, "Use before approving, paying, booking, reconciling or auditing an invoice, especially when an agent needs to determine whether the invoice requires human review.");
  assert.equal(cap.idempotent, true);
  assert.equal(cap.sideEffects, false);
  assert.equal(capabilities.filter(c => c.name === "invoice_anomaly_check").length, 1);
  assert.ok(!/\bOman\b/.test(cap.description + cap.whenToUse), "global capability");
  assert.equal(AGENT_GROUPS.filter(g => g.toolNames.includes("invoice_anomaly_check")).length, 1);
  await withServer(loadConfig({ RAFID_API_KEYS: key, X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet, MCP_REMOTE_ENABLED: "true" }), async base => {
    for (const path of ["/agent.json", "/.well-known/agent.json", "/llms.txt", "/api/v1/capabilities", "/api/v1/pricing", "/api/v1/tools", "/api/v1/agent", "/openapi.json", "/api/v1/x402"]) {
      const text = await (await fetch(base + path)).text();
      assert.ok(text.includes("invoice_anomaly_check") || text.includes("finance/invoice-anomaly-check"), path);
    }
    assert.match(await (await fetch(base + "/llms.txt")).text(), /invoice_anomaly_check[\s\S]*\$0\.25/);
    const caps = await (await fetch(base + "/api/v1/capabilities")).json() as any;
    const entry = caps.data.find((x: any) => x.name === "invoice_anomaly_check");
    assert.equal(entry.price, 0.25);
    assert.equal(entry.currency, "USD");
    assert.equal(entry.category, "finance_risk");
    assert.equal(entry.whenToUse, cap.whenToUse);
    assert.ok(entry.sampleQueries.length >= 5);
    const agent = await (await fetch(base + "/agent.json")).json() as any;
    const tool = (agent.tools ?? agent.data?.tools).find((t: any) => t.name === "invoice_anomaly_check");
    assert.equal(tool.x402Endpoint, "/api/v1/x402/finance/invoice-anomaly-check");
    const rpc = async (id: number, method: string, params: unknown) => (await (await fetch(base + "/mcp", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
    })).json()) as any;
    const listed = await rpc(1, "tools/list", {});
    const mcpTool = listed.result.tools.find((t: any) => t.name === "invoice_anomaly_check");
    assert.ok(mcpTool);
    assert.equal(mcpTool.inputSchema.additionalProperties, false);
    assert.deepEqual(mcpTool.inputSchema.required, ["invoice"]);
    assert.ok(mcpTool.outputSchema.properties.riskScore && mcpTool.outputSchema.properties.anomalies);
    const called = await rpc(2, "tools/call", { name: "invoice_anomaly_check", arguments: SCENARIOS.duplicate });
    assert.ok(!called.result.isError, JSON.stringify(called).slice(0, 300));
    assert.deepEqual(called.result.structuredContent, await run(SCENARIOS.duplicate), "MCP and the engine produce the same result");
    const bad = await rpc(3, "tools/call", { name: "invoice_anomaly_check", arguments: { invoice: { total: 1, invoiceDate: "nope" } } });
    assert.ok(bad.result?.isError || bad.error);
    assert.ok(!JSON.stringify(bad).includes("at runInvoiceAnomalyCheck"), "no stack traces");
  });
});

test("pricing: $0.25 in the catalog, BillingService, x402 requirement and GET /api/v1/x402; zero upstream cost", async () => {
  assert.equal(cap.price, 0.25);
  assert.equal(prices.invoice_anomaly_check, 0.25);
  const billing = new BillingService(new MemoryUsageRepository());
  assert.equal(billing.getToolPrice("invoice_anomaly_check"), 0.25);
  assert.equal(billing.buildX402PaymentRequirement("invoice_anomaly_check", "eip155:8453", wallet).price, "$0.25");
  const info = buildX402Info(loadConfig({ RAFID_API_KEYS: key, X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet }), billing);
  const tool = info.tools.find(t => t.name === "invoice_anomaly_check")!;
  assert.equal(tool.price, 0.25);
  assert.equal(tool.endpoint, "/api/v1/x402/finance/invoice-anomaly-check");
  const { ESTIMATED_UPSTREAM_COST_USD } = await import("../src/intelligence/costEstimator.js");
  assert.deepEqual([ESTIMATED_UPSTREAM_COST_USD.invoice_anomaly_check!.providerCostUSD, ESTIMATED_UPSTREAM_COST_USD.invoice_anomaly_check!.llmCostUSD], [0, 0]);
  assert.equal(classifyDataSource("invoice_anomaly_check", INVOICE_ANOMALY_EXAMPLE_OUTPUT), null);
});

test("OpenAPI: REST + x402 operations, Finance tag, strict schema, static example output, structured error examples; never executes the engine", () => {
  const original = cap.execute;
  let called = false;
  (cap as any).execute = () => { called = true; return original(cap.example); };
  try {
    const doc = buildOpenapi(loadConfig({ RAFID_API_KEYS: key, X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet })) as { paths: Record<string, any>; tags: any[] };
    const op = doc.paths[ENDPOINT].post;
    assert.equal(op.operationId, "invoice_anomaly_check");
    assert.deepEqual(op.tags, ["Finance"]);
    const schema = op.requestBody.content["application/json"].schema;
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(Object.keys(schema.properties).sort(), ["approvalContext", "contract", "historicalInvoices", "invoice", "options", "paymentHistory", "purchaseOrder", "supplierProfile"]);
    assert.deepEqual(op.requestBody.content["application/json"].examples.default.value, cap.example);
    assert.deepEqual(op.responses["200"].content["application/json"].examples.default.value.data, INVOICE_ANOMALY_EXAMPLE_OUTPUT);
    assert.equal(op.responses["400"].content["application/json"].examples.default.value.error.code, "INVALID_DATE");
    assert.equal(op.responses["500"].content["application/json"].examples.default.value.error.code, "ANALYSIS_FAILED");
    assert.equal(doc.paths["/api/v1/x402" + cap.path].post.operationId, "invoice_anomaly_check_x402");
    assert.ok(doc.tags.find((t: any) => t.name === "Finance").description.includes("invoice_anomaly_check"));
    assert.equal(called, false);
  } finally { (cap as any).execute = original; }
});

test("x402: an unpaid request gets 402 at $0.25 (250000 USDC atomic units); the engine never runs; an API key does not bypass payment", async () => {
  const facilitator = http.createServer((_req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:84532" }], extensions: ["bazaar"], signers: {} })); });
  facilitator.listen(0, "127.0.0.1");
  await once(facilitator, "listening");
  const original = cap.execute;
  let executed = false;
  (cap as any).execute = async (input: unknown) => { executed = true; return original(input); };
  try {
    const config = { ...loadConfig({ RAFID_API_KEYS: key, X402_ENABLED: "true", X402_WALLET_ADDRESS: wallet }), x402FacilitatorUrl: `http://127.0.0.1:${(facilitator.address() as any).port}` };
    await withServer(config, async base => {
      const res = await fetch(base + "/api/v1/x402" + cap.path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cap.example) });
      assert.equal(res.status, 402);
      const header = res.headers.get("payment-required")!;
      assert.ok(header.length < 16_000);
      const required = JSON.parse(Buffer.from(header, "base64").toString());
      assert.equal(required.accepts[0].amount, "250000");
      assert.equal(required.accepts[0].payTo, wallet);
      assert.ok(String(required.resource.url).endsWith("/api/v1/x402/finance/invoice-anomaly-check"));
      const withKey = await fetch(base + "/api/v1/x402" + cap.path, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": key }, body: JSON.stringify(cap.example) });
      assert.equal(withKey.status, 402);
    });
    assert.equal(executed, false);
  } finally { (cap as any).execute = original; facilitator.close(); }
  assert.ok(JSON.stringify(discoveryDeclaration(cap)).length <= MAX_DISCOVERY_DECLARATION_CHARS);
});

test("REST (API key): success envelope with tool/price meta, 1 MB body for large histories, structured errors with requestId, no stack traces", async () => {
  await withServer(loadConfig({ RAFID_API_KEYS: key }), async base => {
    const post = (body: unknown) => fetch(base + ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": key }, body: typeof body === "string" ? body : JSON.stringify(body) });
    const ok = await post(SCENARIOS.bankChange);
    assert.equal(ok.status, 200);
    const body = await ok.json() as any;
    assert.equal(body.meta.tool, "invoice_anomaly_check");
    assert.equal(body.meta.price, 0.25);
    assert.equal(body.meta.currency, "USD");
    assert.ok(body.data.anomalies.some((a: any) => a.code === "BANK_ACCOUNT_CHANGED"));
    // > 32 KB request (400 historical invoices) is accepted on this route.
    const history = Array.from({ length: 400 }, (_, i) => ({ invoiceNumber: `INV-2025-${1000 + i}`, supplierId: `SUP-${i % 9}`, invoiceDate: "2026-03-01", currency: "USD", total: 100 + i, bankAccount: "XX00000000" }));
    const bigBody = JSON.stringify({ invoice: BASE_INVOICE, historicalInvoices: history, options: AS_OF });
    assert.ok(bigBody.length > 32 * 1024);
    assert.equal((await post(bigBody)).status, 200);
    const bad = await post({ invoice: { total: 10, invoiceDate: "2026-13-01" } });
    assert.equal(bad.status, 400);
    const b = await bad.json() as any;
    assert.equal(b.error.code, "INVALID_DATE");
    assert.equal(b.error.details.path, "invoice.invoiceDate");
    assert.ok(b.meta.requestId);
    const schemaBad = await post({ invoice: { total: 10 }, unknown: true });
    assert.equal(((await schemaBad.json()) as any).error.code, "INVALID_INPUT");
    const malformed = await post("{\"invoice\": ");
    assert.equal(malformed.status, 400);
    assert.equal(((await malformed.json()) as any).error.code, "INVALID_JSON");
    const noKey = await fetch(base + ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(SCENARIOS.clean) });
    assert.equal(noKey.status, 401);
  });
});

test("example input/output: the static example validates and IS the real engine output (regenerate with scripts/generateInvoiceAnomalyExample.ts)", async () => {
  assert.deepEqual(cap.example, INVOICE_ANOMALY_EXAMPLE_INPUT);
  assert.ok(invoiceAnomalyCheckInput.safeParse(cap.example).success);
  assert.ok(invoiceAnomalyCheckOutput.safeParse(cap.exampleOutput).success);
  assert.deepEqual(await cap.execute(cap.example), INVOICE_ANOMALY_EXAMPLE_OUTPUT);
  assert.equal(INVOICE_ANOMALY_EXAMPLE_OUTPUT.decision, "hold");
});
