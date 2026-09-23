import { randomUUID } from "node:crypto";
import { LightningBackendError, type LightningBackend, type LightningInvoice } from "./lightning.js";
import { decodeBolt11 } from "./bolt11.js";

/**
 * Voltage Payments API backend (https://docs.voltageapi.com/receiving) — a hosted Lightning
 * wallet, no node/channels/liquidity to run. Creating an invoice is asynchronous:
 *
 *   POST {base}/organizations/{org}/environments/{env}/payments   → 202, empty body
 *   GET  {base}/organizations/{org}/environments/{env}/payments/{id}
 *        → status "generating" … then "receiving" with data.payment_request (BOLT11)
 *
 * The payment hash is only listed in `receipts` after payment, so it's read from the BOLT11
 * itself (decodeBolt11, checksum-verified), and the invoice's encoded amount is cross-checked
 * against what we asked for — a mismatch is refused rather than issued to a customer. Payment
 * verification stays the same as with LND: the preimage the payer receives is the proof.
 */
type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) =>
  Promise<{ status: number; ok: boolean; text(): Promise<string> }>;

export interface VoltageOptions {
  apiUrl: string;
  apiKey: string;
  organizationId: string;
  environmentId: string;
  walletId: string;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Total time to wait for the invoice to be generated. */
  maxWaitMs?: number;
  pollIntervalMs?: number;
}

export class VoltagePaymentsBackend implements LightningBackend {
  readonly name = "voltage";
  constructor(private readonly opts: VoltageOptions) {}

  private url(suffix: string): string {
    return `${this.opts.apiUrl.replace(/\/+$/, "")}/organizations/${encodeURIComponent(this.opts.organizationId)}/environments/${encodeURIComponent(this.opts.environmentId)}/payments${suffix}`;
  }

  private async call(method: string, url: string, body?: unknown): Promise<{ status: number; text: string }> {
    const fetchImpl = this.opts.fetchImpl ?? (fetch as unknown as FetchLike);
    try {
      const res = await fetchImpl(url, {
        method, signal: AbortSignal.timeout(8000),
        headers: { "x-api-key": this.opts.apiKey, "Content-Type": "application/json", Accept: "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
      return { status: res.status, text: await res.text() };
    } catch {
      throw new LightningBackendError("Lightning provider unreachable");
    }
  }

  async createInvoice(args: { amountSats: number; memo: string; expirySeconds: number }): Promise<LightningInvoice> {
    const id = randomUUID();
    const amountMsat = args.amountSats * 1000;
    const created = await this.call("POST", this.url(""), {
      id, wallet_id: this.opts.walletId, payment_kind: "bolt11", currency: "btc",
      amount: { currency: "btc", amount: amountMsat, unit: "msats" },
      description: args.memo.slice(0, 256),
      expiration: Math.min(Math.max(args.expirySeconds, 60), 86400)
    });
    if (created.status < 200 || created.status >= 300) throw new LightningBackendError(`Lightning provider rejected invoice creation (HTTP ${created.status})`);

    const sleep = this.opts.sleep ?? (ms => new Promise<void>(r => setTimeout(r, ms)));
    const deadline = Date.now() + (this.opts.maxWaitMs ?? 12_000);
    const interval = this.opts.pollIntervalMs ?? 500;
    for (;;) {
      const got = await this.call("GET", this.url(`/${id}`));
      if (got.status >= 200 && got.status < 300) {
        let payment: { status?: unknown; data?: { payment_request?: unknown } };
        try { payment = JSON.parse(got.text); } catch { throw new LightningBackendError("Lightning provider returned malformed JSON"); }
        if (payment.status === "failed" || payment.status === "expired") throw new LightningBackendError(`Lightning provider could not generate the invoice (${String(payment.status)})`);
        const paymentRequest = typeof payment.data?.payment_request === "string" ? payment.data.payment_request : "";
        if (paymentRequest) {
          const decoded = decodeBolt11(paymentRequest);
          if (!decoded) throw new LightningBackendError("Lightning provider returned an invalid invoice");
          if (decoded.amountMsat !== BigInt(amountMsat)) throw new LightningBackendError("Lightning provider returned an invoice for the wrong amount");
          return { paymentRequest, paymentHash: decoded.paymentHash };
        }
      } else if (got.status !== 404) {
        // 404 right after the 202 just means "not visible yet"; anything else is a real error.
        throw new LightningBackendError(`Lightning provider error while generating the invoice (HTTP ${got.status})`);
      }
      if (Date.now() + interval > deadline) throw new LightningBackendError("Lightning provider did not generate the invoice in time");
      await sleep(interval);
    }
  }
}
