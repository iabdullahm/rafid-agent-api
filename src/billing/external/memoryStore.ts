import { randomUUID } from "node:crypto";
import { ExternalPaymentStoreError, type ExternalPaymentStore } from "./store.js";
import { MAX_QUERY_EXTERNAL_PAYMENTS, type ExternalPayment, type ExternalPaymentInput, type ExternalPaymentProvider, type ExternalPaymentStatus, type TopupIntent, type TopupIntentInput, type TopupIntentStatus } from "./types.js";

const clone = <T>(v: T): T => structuredClone(v);
export const newExternalId = (prefix: "extpay" | "topup") => `${prefix}_${randomUUID().replace(/-/g, "")}`;

/** In-process ExternalPaymentStore for development and tests — same "loses everything on
 *  restart" tradeoff as billing/unified/memoryStore.ts's MemoryBillingStore, for the same reason
 *  (never used in production; loadExternalPaymentsConfig() requires a database there). */
export class MemoryExternalPaymentStore implements ExternalPaymentStore {
  private topups = new Map<string, TopupIntent>();
  private payments = new Map<string, ExternalPayment>();
  private paymentOrder: string[] = [];

  async migrate(): Promise<void> {}
  async close(): Promise<void> {}

  async createTopupIntent(input: TopupIntentInput): Promise<TopupIntent> {
    const now = new Date().toISOString();
    const intent: TopupIntent = { ...input, createdAt: input.createdAt ?? now, updatedAt: input.updatedAt ?? now };
    this.topups.set(intent.id, intent);
    return clone(intent);
  }
  async getTopupIntent(id: string) { const t = this.topups.get(id); return t ? clone(t) : null; }
  async isAmountOpen(recipient: string, amountUsdcAtomic: number): Promise<boolean> {
    for (const t of this.topups.values()) if (t.status === "pending" && t.recipient === recipient && t.amountUsdcAtomic === amountUsdcAtomic) return true;
    return false;
  }
  async updateTopupIntent(id: string, patch: Partial<Pick<TopupIntent, "status" | "transactionHash" | "externalPaymentId" | "metadata">>) {
    const t = this.topups.get(id);
    if (!t) return null;
    Object.assign(t, patch, { updatedAt: new Date().toISOString() });
    return clone(t);
  }
  async expireStaleTopupIntents(now: Date): Promise<number> {
    let n = 0;
    for (const t of this.topups.values()) {
      if (t.status === "pending" && Date.parse(t.expiresAt) < now.getTime()) { t.status = "expired"; t.updatedAt = now.toISOString(); n++; }
    }
    return n;
  }
  async listTopupIntents(opts: { accountId?: string; status?: TopupIntentStatus; limit?: number }): Promise<TopupIntent[]> {
    let rows = [...this.topups.values()];
    if (opts.accountId) rows = rows.filter(t => t.accountId === opts.accountId);
    if (opts.status) rows = rows.filter(t => t.status === opts.status);
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return rows.slice(0, opts.limit ?? MAX_QUERY_EXTERNAL_PAYMENTS).map(clone);
  }

  async createExternalPayment(input: ExternalPaymentInput): Promise<ExternalPayment> {
    if (input.providerEventId && [...this.payments.values()].some(p => p.provider === input.provider && p.providerEventId === input.providerEventId)) {
      throw new ExternalPaymentStoreError("duplicate_event", "This provider event has already been recorded");
    }
    if (input.transactionHash && [...this.payments.values()].some(p => p.provider === input.provider && p.transactionHash === input.transactionHash)) {
      throw new ExternalPaymentStoreError("duplicate_transaction_hash", "This transaction hash has already been recorded");
    }
    const now = new Date().toISOString();
    const payment: ExternalPayment = { ...input, createdAt: input.createdAt ?? now, updatedAt: input.updatedAt ?? now };
    this.payments.set(payment.id, payment);
    this.paymentOrder.push(payment.id);
    return clone(payment);
  }
  async getExternalPayment(id: string) { const p = this.payments.get(id); return p ? clone(p) : null; }
  async findExternalPaymentByProviderPaymentId(provider: ExternalPaymentProvider, providerPaymentId: string) {
    const p = [...this.payments.values()].find(x => x.provider === provider && x.providerPaymentId === providerPaymentId);
    return p ? clone(p) : null;
  }
  async findExternalPaymentByEventId(provider: ExternalPaymentProvider, providerEventId: string) {
    const p = [...this.payments.values()].find(x => x.provider === provider && x.providerEventId === providerEventId);
    return p ? clone(p) : null;
  }
  async findExternalPaymentByTransactionHash(provider: ExternalPaymentProvider, transactionHash: string) {
    const p = [...this.payments.values()].find(x => x.provider === provider && x.transactionHash === transactionHash);
    return p ? clone(p) : null;
  }
  async updateExternalPayment(id: string, patch: Partial<Pick<ExternalPayment, "status" | "providerEventId" | "providerPaymentId" | "transactionHash" | "amountAtomic" | "confirmedAt" | "metadata">>) {
    const p = this.payments.get(id);
    if (!p) return null;
    if (patch.providerEventId && [...this.payments.values()].some(x => x.id !== id && x.provider === p.provider && x.providerEventId === patch.providerEventId)) {
      throw new ExternalPaymentStoreError("duplicate_event", "This provider event has already been recorded");
    }
    if (patch.transactionHash && [...this.payments.values()].some(x => x.id !== id && x.provider === p.provider && x.transactionHash === patch.transactionHash)) {
      throw new ExternalPaymentStoreError("duplicate_transaction_hash", "This transaction hash has already been recorded");
    }
    Object.assign(p, patch, { updatedAt: new Date().toISOString() });
    return clone(p);
  }
  async listExternalPayments(opts: { since: Date | null; accountId?: string; provider?: ExternalPaymentProvider; status?: ExternalPaymentStatus; limit?: number }): Promise<ExternalPayment[]> {
    const sinceMs = opts.since ? opts.since.getTime() : null;
    let rows = this.paymentOrder.map(id => this.payments.get(id)!);
    if (sinceMs !== null) rows = rows.filter(p => Date.parse(p.createdAt) >= sinceMs);
    if (opts.accountId) rows = rows.filter(p => p.accountId === opts.accountId);
    if (opts.provider) rows = rows.filter(p => p.provider === opts.provider);
    if (opts.status) rows = rows.filter(p => p.status === opts.status);
    return rows.slice(-(opts.limit ?? MAX_QUERY_EXTERNAL_PAYMENTS)).reverse().map(clone);
  }
}
