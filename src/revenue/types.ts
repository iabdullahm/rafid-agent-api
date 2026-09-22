/**
 * Revenue ledger — the trustworthy accounting record of actual x402 settlements. Deliberately a
 * SEPARATE system from src/analytics/ (analytics/types.ts's own doc comment already says why:
 * analytics is a "lightweight," capped, plain-JS-aggregated usage layer, useful for traffic
 * shape but never the accounting source of truth). This table is append-only, durable by
 * default expectation (still degrades to an in-memory store with no database configured, exactly
 * like every other store in this codebase, but a deployment that cares about real accounting
 * must set REVENUE_DATABASE_URL/DATABASE_URL), and every row is written from data this codebase
 * actually observed on a real x402 settlement — nothing here is ever derived from
 * capability.price alone (see aggregate.ts's doc comment) or from tool-call analytics.
 *
 * PRIVACY/SECURITY: a RevenueSettlement must never carry a raw X-PAYMENT header value, a payment
 * proof/signature, a private key, or a facilitator secret — see revenue/settlementCapture.ts
 * (every field here is either a known-safe public value — a route/tool name, a public wallet
 * address, a public on-chain transaction hash, an amount, a status — or is explicitly left null
 * when the SDK doesn't provide it, never fabricated).
 */

/** The only statuses this ledger ever writes. "payment_verified" is part of the vocabulary for
 *  forward compatibility with a future asynchronous settlement flow (verify now, settle later) —
 *  the x402 SDK version this deployment uses observes verification and settlement together, in
 *  one synchronous HTTP response, so no code path emits "payment_verified" on its own today. See
 *  settlementCapture.ts's doc comment for the full explanation. */
export type RevenueSettlementStatus = "payment_verified" | "settlement_succeeded" | "settlement_failed";

/** Where amountAtomic/amountDecimal came from — always recorded, never silently blended, so a
 *  reconciliation reader can tell an SDK-echoed on-chain figure from a reconstructed one at a
 *  glance. See settlementCapture.ts's doc comment for exactly when each applies. */
export type RevenueAmountSource = "settlement_response" | "verified_requirement" | "unavailable";

export interface RevenueSettlement {
  requestId: string;
  /** A CapabilityName from the shared registry (src/domain/capabilities.ts). */
  toolName: string;
  /** Identical to toolName in this codebase today — this registry has no separate
   *  human-display-name concept distinct from a capability's registry `name`. Kept as its own
   *  field because the spec asked for both; documented here rather than silently deduplicated so
   *  a future registry change that does add a separate display name has an obvious place to put
   *  it without a schema change. */
  capabilityName: string;
  /** Raw token amount in the asset's smallest unit, as a decimal string (never a JS number —
   *  atomic token amounts can exceed Number.MAX_SAFE_INTEGER, and every x402/EVM library in this
   *  codebase already represents amounts as strings for the same reason). Null when
   *  amountSource is "unavailable". */
  amountAtomic: string | null;
  /** Human-readable amount in `currency` (e.g. 0.25 for $0.25). Null when amountSource is
   *  "unavailable". */
  amountDecimal: number | null;
  amountSource: RevenueAmountSource;
  /** Always "USDC" today — every network this deployment supports settles USDC by the x402 SDK's
   *  own default asset table (see billing/x402.ts's buildX402Status() doc comment, which already
   *  established this same fact for the same reason). Null only when amountSource is
   *  "unavailable" (no amount, no meaningful currency to attach to it). */
  currency: string | null;
  /** CAIP-2 network id (e.g. "eip155:8453"), always known — every settlement observed here came
   *  through a specific configured X402_NETWORK. */
  network: string;
  /** Token symbol, not a contract address — this codebase never overrides the SDK's default
   *  asset choice, exactly like buildX402Status()'s own `asset: "USDC"`. The literal on-chain
   *  token contract address is not captured (the settle response and payment requirement objects
   *  this codebase reads do not carry it); a future need for it would require a deeper SDK/
   *  facilitator integration than this ledger does today — see the final report's "remaining
   *  accounting limitations". */
  asset: string | null;
  /** The paying wallet address, straight from the settlement response's own `payer` field.
   *  That field is optional in @x402/core's settleResponseSchema — null, never fabricated, when
   *  the SDK doesn't return it. */
  payerAddress: string | null;
  /** This deployment's configured receiving wallet (X402_WALLET_ADDRESS) — always known, never
   *  per-row SDK data. */
  payToAddress: string;
  /** The public on-chain transaction hash, when the SDK's settlement response includes one
   *  (required by @x402/core's schema on success; often an empty string, normalized to null
   *  here, on a failure that never reached broadcast). Never a payment proof or signature. */
  transactionHash: string | null;
  status: RevenueSettlementStatus;
  /** "coinbase-cdp" | "public" — which facilitator processed this settlement, read from this
   *  deployment's own config (same value buildX402Info()/buildX402Status() already report). */
  facilitator: string;
  /** The SDK's own short, standardized error code (e.g. "insufficient_funds",
   *  "transfer_event_mismatch") for a settlement_failed row — never a stack trace, never a raw
   *  error message that might embed request internals. Null for a succeeded row. */
  errorReason: string | null;
  /** When payment was observed as verified — in this codebase's synchronous architecture, always
   *  the same instant as settledAt/createdAt (see the status doc comment above). ISO 8601. */
  paymentVerifiedAt: string;
  /** When settlement was confirmed — only set for status "settlement_succeeded"; null for
   *  "settlement_failed" (nothing actually settled) and for the currently-unused
   *  "payment_verified" status. ISO 8601. */
  settledAt: string | null;
  /** The idempotency key this row was deduplicated on — see revenue/idempotency.ts's doc
   *  comment for the exact strategy. Exposed on the type (not just internal to the store) so the
   *  reconciliation endpoint's duplicate_transaction_hash check can reason about it directly. */
  dedupeKey: string;
  createdAt: string;
}

export type RevenueSettlementInput = Omit<RevenueSettlement, "createdAt"> & { createdAt?: string };

export interface RevenueLedger {
  /** Idempotent: a row whose dedupeKey already exists is silently skipped, never double-counted
   *  — see idempotency.ts. Fire-and-forget from every call site (the same discipline
   *  analytics/recorder.ts's fireAndForget() already documents for the same reason: recording
   *  must never slow down or fail the real HTTP response it's observing), but — unlike
   *  analytics, which is genuinely best-effort/inconsequential — a failed write here is logged to
   *  stderr rather than silently swallowed, since losing an accounting row deserves visibility
   *  even though it still must never throw into the request path. */
  record(input: RevenueSettlementInput): void | Promise<void>;
  /** Every row with createdAt >= since (or every row ever, when since is null — the "all" period
   *  — see aggregate.ts), newest first. Unlike analytics/types.ts's queryEvents(), this is NOT
   *  capped the same way: revenue volume (paid, settled transactions only) is orders of magnitude
   *  lower than raw usage/analytics events for any realistic deployment of this API, so
   *  correctness (never silently under-counting real money) is prioritized over the same
   *  "lightweight" tradeoff analytics makes. MAX_QUERY_SETTLEMENTS below is a generous safety
   *  cap against a genuinely pathological query, not an expected operating limit. */
  query(args: { since: Date | null; limit?: number; offset?: number }): Promise<RevenueSettlement[]>;
  /** Total row count matching `since`, independent of limit/offset — for pagination metadata on
   *  GET /api/v1/internal/revenue/transactions. */
  count(since: Date | null): Promise<number>;
}

/** Safety cap against a pathological unbounded query — not an expected operating limit. A
 *  deployment settling anywhere near this many real payments in one query window has
 *  outgrown this "lightweight ledger + plain JS aggregation" design and needs SQL-side
 *  aggregation instead; see the final report's limitations section. */
export const MAX_QUERY_SETTLEMENTS = 500_000;

/** Default page size for GET /api/v1/internal/revenue/transactions when the caller doesn't
 *  specify one, and the hard cap on how large a page can be requested. */
export const DEFAULT_TRANSACTIONS_PAGE_SIZE = 50;
export const MAX_TRANSACTIONS_PAGE_SIZE = 500;
