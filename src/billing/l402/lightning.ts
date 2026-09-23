import { request as httpsRequest } from "node:https";

/**
 * Lightning backend for L402 — the one thing that has to talk to a real node: creating an invoice
 * for a 402 challenge. Verifying a presented token never touches the node (the preimage is the
 * proof of payment — see gate.ts), so a node hiccup can only ever affect new challenges, never a
 * customer who has already paid.
 */
export interface LightningInvoice {
  /** BOLT11 payment request the client pays. */
  paymentRequest: string;
  /** 32-byte payment hash (sha256 of the preimage the payer receives on settlement). */
  paymentHash: Buffer;
}

export interface LightningBackend {
  readonly name: string;
  createInvoice(args: { amountSats: number; memo: string; expirySeconds: number }): Promise<LightningInvoice>;
}

export class LightningBackendError extends Error {}

type Requester = (args: { url: URL; body: string; headers: Record<string, string>; ca?: string; timeoutMs: number }) => Promise<{ status: number; body: string }>;

/** node:https (rather than global fetch) so a self-signed LND TLS certificate can be pinned via
 *  `ca` — the default for a self-hosted node. A hosted node (e.g. Voltage) has a publicly-trusted
 *  certificate and needs no LND_TLS_CERT at all. */
const defaultRequester: Requester = ({ url, body, headers, ca, timeoutMs }) => new Promise((resolve, reject) => {
  const req = httpsRequest(url, { method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(body).toString() }, ...(ca ? { ca } : {}), timeout: timeoutMs }, res => {
    const chunks: Buffer[] = [];
    let size = 0;
    res.on("data", (c: Buffer) => { size += c.length; if (size > 64 * 1024) { req.destroy(new Error("LND response too large")); return; } chunks.push(c); });
    res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
  });
  req.on("timeout", () => req.destroy(new Error("LND request timed out")));
  req.on("error", reject);
  req.end(body);
});

/**
 * LND's REST API (`POST /v1/invoices`), authenticated with an invoice-only macaroon — the
 * least-privileged LND credential that can create invoices: it cannot spend funds, open channels
 * or read wallet balances, so a leaked LND_INVOICE_MACAROON can't move money out of the node.
 */
export class LndRestBackend implements LightningBackend {
  readonly name = "lnd";
  private readonly ca: string | undefined;

  constructor(private readonly opts: { restUrl: string; invoiceMacaroonHex: string; tlsCert?: string; timeoutMs?: number; requester?: Requester }) {
    // LND_TLS_CERT may be the raw PEM or base64 of the PEM (easier to paste into an env var).
    const cert = opts.tlsCert?.trim();
    this.ca = !cert ? undefined : cert.includes("BEGIN CERTIFICATE") ? cert : Buffer.from(cert, "base64").toString("utf8");
  }

  async createInvoice(args: { amountSats: number; memo: string; expirySeconds: number }): Promise<LightningInvoice> {
    const url = new URL("/v1/invoices", this.opts.restUrl);
    const requester = this.opts.requester ?? defaultRequester;
    let response: { status: number; body: string };
    try {
      response = await requester({
        url, ca: this.ca, timeoutMs: this.opts.timeoutMs ?? 8000,
        headers: { "Content-Type": "application/json", "Grpc-Metadata-macaroon": this.opts.invoiceMacaroonHex },
        // LND's REST gateway encodes int64 fields as strings.
        body: JSON.stringify({ value: String(args.amountSats), memo: args.memo.slice(0, 256), expiry: String(args.expirySeconds) })
      });
    } catch {
      // Never surface the underlying error message — it can include the node's host/port.
      throw new LightningBackendError("Lightning node unreachable");
    }
    if (response.status < 200 || response.status >= 300) throw new LightningBackendError(`Lightning node rejected invoice creation (HTTP ${response.status})`);
    let parsed: { r_hash?: unknown; payment_request?: unknown };
    try { parsed = JSON.parse(response.body); } catch { throw new LightningBackendError("Lightning node returned malformed JSON"); }
    const paymentRequest = typeof parsed.payment_request === "string" ? parsed.payment_request : "";
    const paymentHash = typeof parsed.r_hash === "string" ? Buffer.from(parsed.r_hash, "base64") : Buffer.alloc(0);
    if (!/^ln[a-z0-9]+$/i.test(paymentRequest) || paymentHash.length !== 32) throw new LightningBackendError("Lightning node returned an invalid invoice");
    return { paymentRequest, paymentHash };
  }
}
