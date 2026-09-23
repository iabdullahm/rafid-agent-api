/**
 * The seam between Rafid's MPP business logic (service.ts: budgets, metering, idempotency,
 * persistence, tool execution) and a concrete Machine Payments Protocol implementation.
 *
 * Nothing outside billing/mpp/mppx.ts imports the SDK. A future adapter (MPP over Stripe
 * Shared Payment Tokens, a Solana method, a hosted MPP gateway) implements this interface and is
 * selected by MPP_PROVIDER, without touching routes, persistence or the capability registry.
 *
 * The lifecycle the interface models is the protocol's own — authorization, metering and
 * settlement stay separate operations:
 *
 *   charge:   createCharge (402 challenge) → verifyCharge (non-mutating) → [tool runs]
 *             → settleCharge (the payment is only consumed after the call succeeded)
 *   session:  createSession (402 open challenge) → verifySession (open credential: channel
 *             deposit = budget authorization) → per call: sessionCallChallenge →
 *             verifySessionCall (non-mutating) → [tool runs] → recordUsage (voucher accepted +
 *             spend metered, only on success)
 *             → closeSession / settleSession (on-chain settlement of exactly the metered spend)
 *
 * Every credential passed in is the raw `Authorization: Payment …` header value; every failure
 * is thrown as an MppPaymentFailure (never a raw SDK error, which could carry request details).
 */

export interface PublicChallenge {
  id: string;
  method: string;
  intent: string;
  realm: string;
  /** Decoded, public payment request (amount in raw token units, currency, recipient, …). */
  request: Record<string, unknown>;
  description: string | null;
  expires: string | null;
}

export interface PaymentChallenge {
  /** Response headers to send with the 402 — one WWW-Authenticate per offered method. */
  headers: Array<[string, string]>;
  challenges: PublicChallenge[];
  /** The SDK's RFC 9457 problem-details body. */
  problem: Record<string, unknown>;
  /** The SDK's own challenge objects (the exact wire form, incl. HMAC-bound opaque/meta) — used
   *  by the MCP binding, whose payment-required error carries challenges as JSON, not headers.
   *  Public data: identical to what WWW-Authenticate already carries. */
  wire: unknown[];
}

export interface ChargeTerms {
  tool: string;
  amountMicros: number;
  description: string;
  /** Binds the challenge (HMAC'd) to one tool, so a credential for a cheap tool can never be
   *  replayed against an expensive one. */
  scope: string;
  url: string;
}

export interface VerifiedCharge {
  challengeId: string;
  method: string;
  intent: string;
  /** Payer address/source when the credential discloses it (public), else null. */
  payer: string | null;
}

export interface SettledCharge {
  challengeId: string;
  method: string;
  /** Public settlement reference (on-chain tx hash). Never a signature. */
  reference: string;
  network: string;
  asset: string;
  payTo: string;
  /** Serialized MPP receipt for the Payment-Receipt response header. */
  receiptHeader: string;
  timestamp: string;
}

/** Parsed, NOT yet verified view of a presented credential — used only to route it (which
 *  pending session, which action). Every field is re-checked by the verify/accept calls. */
export interface CredentialPreview {
  challengeId: string;
  method: string;
  intent: string;
  scope: string | null;
  meta: Record<string, string>;
  action: string | null;
  channelId: string | null;
}

export interface ChannelState {
  channelId: string;
  depositMicros: number;
  /** Highest signed cumulative voucher accepted (authorization ceiling). */
  acceptedMicros: number;
  /** Metered spend recorded against the channel (only ever advanced by recordUsage). */
  spentMicros: number;
  settledMicros: number;
  finalized: boolean;
  closeRequested: boolean;
}

export interface SessionOpenTerms {
  scope: string;
  meta: Record<string, string>;
  suggestedDepositMicros: number;
  /** Per-unit amount advertised in the open challenge. The SDK requires a positive session
   *  amount (the payer's open credential carries a first voucher for it); Rafid uses the
   *  cheapest allowed tool's price. Opening only AUTHORIZES — nothing is metered until a tool
   *  call succeeds, and a payer close captures only metered spend. */
  unitAmountMicros: number;
  url: string;
  description: string;
}

export interface SessionCallTerms {
  channelId: string;
  amountMicros: number;
  /** Binds the voucher challenge to one Rafid session. */
  scope: string;
}

export interface OpenedSession {
  channelId: string;
  /** Channel-open transaction reference (public tx hash) when the receipt carries one. */
  reference: string | null;
  depositMicros: number;
  receiptHeader: string;
}

export interface SettlementResult {
  reference: string;
  /** Serialized receipt the SDK returned (the payer's client validates it on close). */
  receiptHeader?: string;
  /** True when the channel itself was closed/finalized (payer close), false for a settle. */
  finalized?: boolean;
  /** Cumulative amount captured on-chain for this channel after this operation. */
  settledMicros: number;
  /** Amount newly captured by this operation. */
  deltaMicros: number;
  network: string;
  asset: string;
  payTo: string;
}

export class MppPaymentFailure extends Error {
  constructor(
    /** "payment_required" → issue a fresh challenge; "invalid" → rejected credential;
     *  "replayed" → credential already consumed; "insufficient" → channel lacks voucher headroom;
     *  "closed" → channel finalized/closing; "unavailable" → provider/network outage. */
    readonly kind: "payment_required" | "invalid" | "replayed" | "insufficient" | "closed" | "unavailable",
    /** Short, safe reason (the SDK's problem `type`/title), never request internals. */
    readonly reason: string
  ) {
    super(reason);
    this.name = "MppPaymentFailure";
  }
}

export interface MppProvider {
  readonly name: string;
  // ---- charge ----------------------------------------------------------------------------
  createCharge(terms: ChargeTerms): Promise<PaymentChallenge>;
  /** Non-mutating: validates signature, amount, recipient, scope, expiry and HMAC binding. */
  verifyCharge(authorization: string, terms: ChargeTerms): Promise<VerifiedCharge>;
  /** Mutating: broadcasts/settles the payment. Called only after the tool call succeeded. */
  settleCharge(authorization: string, terms: ChargeTerms): Promise<SettledCharge>;
  // ---- session ---------------------------------------------------------------------------
  previewCredential(authorization: string): CredentialPreview | null;
  /** 402 challenge asking the payer to open a payment channel (deposit = budget). */
  createSession(terms: SessionOpenTerms): Promise<PaymentChallenge>;
  /** Accepts an `open` credential: broadcasts the channel-open transaction, persists channel
   *  state. Returns the opened channel. */
  verifySession(authorization: string, terms: SessionOpenTerms): Promise<OpenedSession>;
  /** 402 challenge asking for a voucher that covers one more call on an existing channel. */
  sessionCallChallenge(args: SessionCallTerms & { url: string; description: string }): Promise<PaymentChallenge>;
  /** Non-mutating: checks the voucher credential (signature by the channel's authorized signer,
   *  channel id, challenge HMAC/scope/expiry, deposit ceiling) before the tool runs. */
  verifySessionCall(authorization: string, args: SessionCallTerms): Promise<void>;
  /** Metering, only after the tool call succeeded: accepts the voucher (authorization) and
   *  atomically deducts `amountMicros` from the channel. Fails without charging when the
   *  voucher doesn't cover spent + amount. */
  recordUsage(authorization: string, args: SessionCallTerms): Promise<{ channel: ChannelState; receiptHeader: string }>;
  getChannel(channelId: string): Promise<ChannelState | null>;
  /** Server-initiated settlement; only ever submitted when the accepted voucher equals the
   *  metered spend, so it can never capture more than was actually delivered. Null when there
   *  is nothing (safe) to settle. */
  settleSession(channelId: string): Promise<SettlementResult | null>;
  /** Accepts the payer's `close` credential: closes the channel on-chain, capturing exactly the
   *  metered spend and refunding the rest of the deposit. */
  closeSession(authorization: string, args: { channelId: string; scope: string }): Promise<SettlementResult>;
  /** Reads the channel's authoritative on-chain state (deposit/settled). No transaction. */
  readOnChainChannel(channelId: string): Promise<{ depositMicros: number; settledMicros: number; closeRequested: boolean } | null>;
  /** Cheap reachability check of the payment network (e.g. eth_chainId). Never a payment. */
  probe(timeoutMs?: number): Promise<{ reachable: boolean; chainId: number | null; reason: string | null }>;
  /** Optional listener for settlements the SDK confirms (see MppxProvider.onSettlement). */
  onSettlement?: ((event: { channelId: string; reference: string; settledMicros: number; deltaMicros: number; trigger: string }) => void) | undefined;
}
