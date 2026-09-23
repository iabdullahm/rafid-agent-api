import { THRESHOLDS } from "../config.js";
import { dayToIso, maskAccount, sameSupplier } from "../text.js";
import type { AnalysisContext, Anomaly, Severity } from "../types.js";

/**
 * Payment-detail checks — weighted heavily because a changed payee account is the typical
 * signature of invoice-redirection (business e-mail compromise) fraud. Accounts are compared in
 * compacted form and only ever reported masked (****1234).
 *
 * Known accounts for the supplier = verified/unspecified supplier-profile accounts + accounts on the
 * supplier's historical invoices + accounts on the supplier's recorded payments.
 *  - BANK_ACCOUNT_CHANGED: the invoice account is not among the known accounts (high); or it is on
 *    the profile but was added within the last 30 days and never used before (medium).
 *  - UNKNOWN_BANK_ACCOUNT: a supplier profile was supplied but holds no (verified) account and no
 *    history/payment used this account, or the account is on file only as unverified.
 *  Either is escalated to critical when the same account appears on another supplier's invoices or
 *  payments. Standalone requests (no supplier context) are not flagged — there is nothing to compare.
 */
export function checkPaymentDetails(ctx: AnalysisContext): { anomalies: Anomaly[]; notes: string[] } {
  const { req } = ctx;
  const inv = req.invoice;
  const notes: string[] = [];
  if (!inv.bankAccount) {
    if (req.supplied.profile || ctx.supplierHistory.length > 0) notes.push("The invoice carries no bank account, so payment details could not be compared with supplier records.");
    return { anomalies: [], notes };
  }
  const account = inv.bankAccount;
  const aliases = req.profile?.aliases ?? [];
  const profileAccounts = req.profile?.bankAccounts ?? [];
  const historyAccounts = ctx.supplierHistory.filter(h => h.bankAccount).map(h => ({ account: h.bankAccount!, date: h.invoiceDate }));
  const supplierPayments = req.payments.filter(p => p.bankAccount && sameSupplier(inv.supplier, p.supplier, aliases) === "same");
  const paymentAccounts = supplierPayments.map(p => ({ account: p.bankAccount!, date: p.paymentDate }));
  const usedAccounts = [...historyAccounts, ...paymentAccounts];
  const trusted = new Set([...profileAccounts.filter(a => a.verified !== false).map(a => a.account), ...usedAccounts.map(a => a.account)]);
  const unverifiedOnly = profileAccounts.some(a => a.account === account && a.verified === false) && !trusted.has(account);
  const knownMasked = [...new Set([...profileAccounts.map(a => a.account), ...usedAccounts.map(a => a.account)])].sort().map(maskAccount);

  // The same account on OTHER suppliers' records.
  const otherSupplierRecords = [
    ...req.history.filter(h => h.bankAccount === account && !ctx.supplierHistory.includes(h) && sameSupplier(inv.supplier, h.supplier, aliases) === "different"),
    ...req.payments.filter(p => p.bankAccount === account && sameSupplier(inv.supplier, p.supplier, aliases) === "different")
  ];
  const otherSupplierNames = [...new Set(otherSupplierRecords.map(r => r.supplier.name ?? r.supplier.id ?? "unidentified"))].sort();
  const shared = otherSupplierRecords.length > 0;
  const contextExists = req.supplied.profile || ctx.supplierHistory.length > 0 || supplierPayments.length > 0;
  if (!contextExists && !shared) {
    notes.push("Payment details were not verified: no supplier profile, supplier history or payment history was supplied for this supplier.");
    return { anomalies: [], notes };
  }

  const lastUsed = usedAccounts.filter(a => a.date !== null).sort((a, b) => b.date! - a.date!)[0] ?? null;
  const base = {
    invoiceAccountMasked: maskAccount(account),
    knownAccountsMasked: knownMasked,
    knownAccountCount: knownMasked.length,
    lastUsedAccountMasked: lastUsed ? maskAccount(lastUsed.account) : null,
    lastUsedDate: lastUsed?.date != null ? dayToIso(lastUsed.date) : null,
    sources: { supplierProfileAccounts: profileAccounts.length, historicalInvoicesWithAccount: historyAccounts.length, paymentsWithAccount: paymentAccounts.length },
    accountSeenForOtherSuppliers: shared,
    otherSuppliers: otherSupplierNames
  };
  const escalate = (s: Severity): Severity => (shared ? "critical" : s);
  const sharedNote = shared ? " The same account also appears on another supplier's records." : "";

  if (trusted.has(account)) {
    const profileEntry = profileAccounts.find(a => a.account === account);
    const neverUsed = !usedAccounts.some(a => a.account === account);
    if (profileEntry?.addedDate != null && inv.invoiceDate !== null && neverUsed
      && inv.invoiceDate - profileEntry.addedDate >= 0 && inv.invoiceDate - profileEntry.addedDate <= THRESHOLDS.recentAccountChangeDays) {
      return { notes, anomalies: [{
        code: "BANK_ACCOUNT_CHANGED", severity: escalate("medium"), confidence: 0.7, field: "bankAccount",
        explanation: `The payment account was added to the supplier record ${inv.invoiceDate - profileEntry.addedDate} day(s) before this invoice and has not been paid to before; recent payment-detail changes require verification.${sharedNote}`,
        evidence: { reason: "recently_added_account_first_use", accountAddedDate: dayToIso(profileEntry.addedDate), ...base }
      }] };
    }
    if (shared) {
      return { notes, anomalies: [{
        code: "BANK_ACCOUNT_CHANGED", severity: "high", confidence: 0.75, field: "bankAccount",
        explanation: "The payment account matches this supplier's records but also appears on another supplier's records; shared payee accounts require verification.",
        evidence: { reason: "account_shared_with_other_supplier", ...base }
      }] };
    }
    return { anomalies: [], notes };
  }

  if (trusted.size > 0) {
    const sourcesCount = (profileAccounts.length > 0 ? 1 : 0) + (usedAccounts.length > 0 ? 1 : 0);
    return { notes, anomalies: [{
      code: "BANK_ACCOUNT_CHANGED", severity: escalate("high"), confidence: sourcesCount >= 2 || usedAccounts.length >= 2 ? 0.9 : 0.8, field: "bankAccount",
      explanation: `The payment account on the invoice differs from the ${knownMasked.length} account(s) previously recorded for this supplier; payment details should be verified with the supplier through a known contact before payment.${sharedNote}`,
      evidence: { reason: "account_differs_from_supplier_records", ...base }
    }] };
  }

  // No account on record anywhere. Only a supplier master record (profile) without the account — or
  // an account seen on another supplier's records — is a finding; history that simply does not carry
  // account fields is a data gap, not an anomaly.
  if (!req.supplied.profile && !shared) {
    notes.push("Payment details were not verified: the supplied history and payments for this supplier carry no bank account to compare with.");
    return { anomalies: [], notes };
  }
  return { notes, anomalies: [{
    code: "UNKNOWN_BANK_ACCOUNT", severity: escalate("high"), confidence: unverifiedOnly ? 0.75 : 0.7, field: "bankAccount",
    explanation: (unverifiedOnly
      ? "The payment account is on the supplier record only as unverified."
      : "No payment account is on record for this supplier, so the account on the invoice cannot be verified against previous records.") + sharedNote,
    evidence: { reason: unverifiedOnly ? "account_on_file_unverified" : "no_account_on_record", ...base }
  }] };
}
