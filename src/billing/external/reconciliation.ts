import type { LedgerEntry } from "../unified/types.js";
import type { ExternalPayment, ExternalPaymentProvider } from "./types.js";

/**
 * Pure, read-only cross-checks between rafid_external_payments (this layer's own record of what
 * it observed externally) and the pre-existing unified billing ledger's `credit_purchase` rows
 * (what actually moved a customer's balance — see engine.ts's fundExternalCredit() doc comment).
 * Same "fetch an already-window-filtered array, aggregate in plain JS, never mutate anything"
 * shape as revenue/aggregate.ts's buildReconciliation() and unified/reporting.ts — every consumer
 * of this function is GET-only; nothing here ever writes a record or auto-corrects an anomaly
 * (spec section 24: "Never auto-delete financial records").
 *
 * Two of the eight required checks (wrong_network / wrong_token) are NOT retrospective log scans:
 * this layer deliberately does not persist a row for every REJECTED on-chain verification attempt
 * (only confirmed payments and genuinely-reverted transactions get a durable record — see
 * service.ts's confirmUsdcTopup(), which returns a rejected attempt to the caller without writing
 * anything, so a customer fumbling a hash doesn't clutter the payments table). Here they instead
 * catch a DIFFERENT, real anomaly: a *confirmed* usdc_base row whose recorded network/asset
 * doesn't match this deployment's configured expectation — which should be structurally
 * impossible (verifyUsdcTransfer() already checked exactly this before the row was ever written),
 * so finding one here means the configuration changed after that row was confirmed, or a bug
 * bypassed the verifier. This is documented rather than silently narrowed, per this engagement's
 * standing rule of being explicit about a limitation instead of quietly working around it.
 */
export type ExternalPaymentsAnomalyKind =
  | "confirmed_payment_without_credit"
  | "credit_without_confirmed_payment"
  | "duplicate_provider_event"
  | "duplicate_transaction_hash"
  | "amount_mismatch"
  | "currency_mismatch"
  | "wrong_network"
  | "wrong_token";

export interface ExternalPaymentsAnomaly {
  kind: ExternalPaymentsAnomalyKind;
  provider: ExternalPaymentProvider | null;
  externalPaymentId: string | null;
  accountId: string | null;
  detail: string;
}

export function buildExternalPaymentsReconciliation(args: {
  payments: readonly ExternalPayment[];
  /** BillingStore.listCreditPurchases()'s result for the same window — every `credit_purchase`
   *  ledger row, whatever account it belongs to. */
  creditPurchases: readonly LedgerEntry[];
  /** This deployment's configured USDC network/asset (ExternalPaymentsConfig.usdc.network / "USDC")
   *  — used only for the wrong_network/wrong_token structural check described above. */
  expectedUsdcNetwork: string;
  expectedUsdcAsset: string;
}): ExternalPaymentsAnomaly[] {
  const { payments, creditPurchases, expectedUsdcNetwork, expectedUsdcAsset } = args;
  const anomalies: ExternalPaymentsAnomaly[] = [];
  const confirmed = payments.filter(p => p.status === "confirmed");
  const ledgerByExternalId = new Map<string, LedgerEntry[]>();
  for (const entry of creditPurchases) {
    if (!entry.externalTransactionId) continue;
    const list = ledgerByExternalId.get(entry.externalTransactionId) ?? [];
    list.push(entry);
    ledgerByExternalId.set(entry.externalTransactionId, list);
  }
  const paymentById = new Map(payments.map(p => [p.id, p] as const));

  // confirmed_payment_without_credit: this layer believes a payment is confirmed, but the
  // unified-billing ledger has no matching credit_purchase row — the funding never actually
  // reached the customer's spendable balance.
  for (const payment of confirmed) {
    if (!ledgerByExternalId.has(payment.id)) {
      anomalies.push({ kind: "confirmed_payment_without_credit", provider: payment.provider, externalPaymentId: payment.id, accountId: payment.accountId, detail: `External payment ${payment.id} (${payment.provider}) is "confirmed" but no credit_purchase ledger row references it` });
    }
  }

  // credit_without_confirmed_payment: the ledger shows a credit_purchase funded from an
  // "external payment id" that either doesn't exist in this table, or exists but isn't
  // "confirmed" — a balance increase this layer cannot account for.
  for (const entry of creditPurchases) {
    const id = entry.externalTransactionId;
    if (!id) { anomalies.push({ kind: "credit_without_confirmed_payment", provider: null, externalPaymentId: null, accountId: entry.accountId, detail: `credit_purchase ledger entry ${entry.id} has no externalTransactionId — cannot be attributed to any external payment` }); continue; }
    const payment = paymentById.get(id);
    if (!payment || payment.status !== "confirmed") {
      anomalies.push({ kind: "credit_without_confirmed_payment", provider: payment?.provider ?? null, externalPaymentId: id, accountId: entry.accountId, detail: `credit_purchase ledger entry ${entry.id} references external payment ${id}, which is ${payment ? `status "${payment.status}"` : "not found"}` });
    }
  }

  // duplicate_provider_event / duplicate_transaction_hash: should be structurally impossible
  // given the store-level unique indexes (rafid_external_payments_provider_event_uniq /
  // _tx_hash_uniq — see schema.ts) — checked anyway as a defense-in-depth integrity signal,
  // mirroring revenue/aggregate.ts's identical defense-in-depth duplicate_transaction_hash check.
  const byEvent = new Map<string, ExternalPayment[]>();
  const byTxHash = new Map<string, ExternalPayment[]>();
  for (const p of payments) {
    if (p.providerEventId) { const k = `${p.provider}:${p.providerEventId}`; (byEvent.get(k) ?? byEvent.set(k, []).get(k)!).push(p); }
    if (p.transactionHash) { const k = `${p.provider}:${p.transactionHash}`; (byTxHash.get(k) ?? byTxHash.set(k, []).get(k)!).push(p); }
  }
  for (const [key, rows] of byEvent) if (rows.length > 1) anomalies.push({ kind: "duplicate_provider_event", provider: rows[0]!.provider, externalPaymentId: rows.map(r => r.id).join(","), accountId: null, detail: `${rows.length} external payment rows share provider event ${key} — the unique index should make this impossible` });
  for (const [key, rows] of byTxHash) if (rows.length > 1) anomalies.push({ kind: "duplicate_transaction_hash", provider: rows[0]!.provider, externalPaymentId: rows.map(r => r.id).join(","), accountId: null, detail: `${rows.length} external payment rows share transaction hash ${key} — the unique index should make this impossible` });

  // amount_mismatch: a confirmed payment's amountAtomic should exactly equal the amount its
  // credit_purchase ledger row actually credited (fundExternalCredit() is always called with
  // payment.amountAtomic — see service.ts — so any divergence means the ledger was touched by
  // something else, or the payment row was edited after crediting).
  for (const payment of confirmed) {
    const entries = ledgerByExternalId.get(payment.id);
    if (!entries?.length) continue; // already reported as confirmed_payment_without_credit above
    for (const entry of entries) {
      if (Math.abs(entry.amountMicros) !== payment.amountAtomic) {
        anomalies.push({ kind: "amount_mismatch", provider: payment.provider, externalPaymentId: payment.id, accountId: payment.accountId, detail: `External payment ${payment.id} confirmed for ${payment.amountAtomic} micro-USD, but ledger entry ${entry.id} credited ${Math.abs(entry.amountMicros)} micro-USD` });
      }
    }
  }

  // currency_mismatch: every ExternalPayment.currency is typed "USD" (see types.ts), so this
  // flags rows this layer itself already routed to manual review because Stripe reported a
  // non-USD checkout (handleStripeCheckoutCompleted's "unexpected payment_status/currency/amount"
  // branch) — surfaced here too so it shows up in one place alongside every other anomaly kind.
  for (const p of payments) {
    const reviewCurrency = p.metadata?.currency;
    if (p.status === "requires_review" && typeof reviewCurrency === "string" && reviewCurrency.toLowerCase() !== "usd") {
      anomalies.push({ kind: "currency_mismatch", provider: p.provider, externalPaymentId: p.id, accountId: p.accountId, detail: `External payment ${p.id} was flagged for review after a non-USD currency ("${reviewCurrency}") was observed` });
    }
  }

  // wrong_network / wrong_token: see this function's doc comment — a structural check on
  // already-confirmed USDC rows, not a scan of rejected verification attempts (those are never
  // persisted).
  for (const p of confirmed) {
    if (p.provider !== "usdc_base") continue;
    if (p.network !== expectedUsdcNetwork) anomalies.push({ kind: "wrong_network", provider: p.provider, externalPaymentId: p.id, accountId: p.accountId, detail: `Confirmed USDC payment ${p.id} recorded network "${p.network}", expected "${expectedUsdcNetwork}"` });
    if (p.asset !== expectedUsdcAsset) anomalies.push({ kind: "wrong_token", provider: p.provider, externalPaymentId: p.id, accountId: p.accountId, detail: `Confirmed USDC payment ${p.id} recorded asset "${p.asset}", expected "${expectedUsdcAsset}"` });
  }

  return anomalies;
}
