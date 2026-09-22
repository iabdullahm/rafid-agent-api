import type { RevenueAmountSource, RevenueLedger, RevenueSettlementInput, RevenueSettlementStatus } from "./types.js";
import { buildSettlementDedupeKey } from "./idempotency.js";

/**
 * Decodes and builds a RevenueSettlementInput from the exact same x402 v2 settlement response
 * header (X-PAYMENT-RESPONSE / PAYMENT-RESPONSE) that analytics/recorder.ts's
 * decodeX402SettlementHeader() already reads for usage analytics. This module re-decodes the
 * header independently (a small, cheap base64+JSON parse) rather than importing analytics'
 * narrower decoder, so the revenue ledger's field set can grow without touching — or risking a
 * regression in — the already-shipped, already-tested analytics layer. Both decoders read the
 * exact same wire format; see @x402/core's settleResponseSchema (node_modules/@x402/core/dist/
 * esm/chunk-*.mjs) for the authoritative schema this mirrors:
 *   { success: boolean, errorReason?: string, errorMessage?: string, payer?: string,
 *     transaction: string, network: string, amount?: string, extensions?, extra? }
 *
 * IMPORTANT, VERIFIED LIMITATION (read before changing amount handling): this codebase's
 * configured payment scheme is @x402/evm's ExactEvmScheme, settling via EIP-3009
 * transferWithAuthorization (see billing/x402.ts). Every settle path that scheme actually uses
 * (node_modules/@x402/evm/dist/esm/exact/facilitator/index.mjs's settleEIP3009/
 * awaitEIP3009Settlement, both calling waitAndReturnSettleResponse()) never passes an `amount`
 * option into the settle response it builds — confirmed by reading that source directly, not
 * assumed. In practice `settlement.amount` is therefore almost always undefined for a real
 * settlement in this deployment today. The spec for this ledger says revenue must come from the
 * "actual settled amount," not simply capability.price — so when the SDK's own settlement
 * response DOES carry an amount (a future SDK version, or a different payment scheme), that
 * value is used and amountSource is "settlement_response". When it doesn't (today's normal
 * case), this falls back to the cryptographically-VERIFIED payment requirement amount for that
 * specific route — the dollar figure `billing.buildX402PaymentRequirement()` declared in the 402
 * challenge, which @x402/evm's own verify step (before settlement is ever attempted) confirms
 * the payer's signed authorization matches exactly, byte for byte, before any transfer is
 * broadcast. That is meaningfully different from "just re-reading capability.price after the
 * fact": it is the specific amount this specific payment was cryptographically checked against,
 * not a live lookup assumed to still apply — amountSource is "verified_requirement" so this can
 * never be mistaken for an SDK-echoed on-chain figure. See RevenueAmountSource's doc comment.
 */

const Base64EncodedRegex = /^[A-Za-z0-9+/]+={0,2}$/;

/** USDC's standard decimal precision, identical across every EVM chain this codebase or the
 *  x402 SDK's default asset table supports — see billing/x402.ts's buildX402Status() doc comment,
 *  which already established the same "USDC, never overridden" fact for the same reason. Used
 *  only to convert a known-good decimal dollar amount into the atomic-unit string a settlement
 *  row also carries; never used to invent an amount that isn't otherwise known. */
const USDC_DECIMALS = 6;

export interface DecodedSettlement {
  success: boolean;
  transaction: string | null;
  network: string | null;
  payer: string | null;
  /** Raw string from the settlement response, when present — see the module doc comment above
   *  for why this is usually absent for this deployment's configured payment scheme. */
  amount: string | null;
  errorReason: string | null;
  errorMessage: string | null;
}

/** Never throws: a malformed/missing header just means "no settlement info available" — the
 *  same discipline analytics/recorder.ts's decodeX402SettlementHeader() already documents. */
export function decodeX402SettlementMetadata(headerValue: string | string[] | undefined): DecodedSettlement | null {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!raw || !Base64EncodedRegex.test(raw)) return null;
  try {
    const decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as Record<string, unknown>;
    if (typeof decoded.success !== "boolean") return null;
    const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
    return {
      success: decoded.success,
      transaction: str(decoded.transaction),
      network: str(decoded.network),
      payer: str(decoded.payer),
      amount: str(decoded.amount),
      errorReason: str(decoded.errorReason),
      errorMessage: str(decoded.errorMessage)
    };
  } catch {
    return null;
  }
}

/** Converts a known-good decimal dollar amount (this codebase's catalog prices are always
 *  2-decimal USD, e.g. 0.25) into a USDC atomic-unit string. Only ever called for amountSource
 *  "verified_requirement"/"settlement_response" — never invented for an amount that is otherwise
 *  unknown (see buildSettlementRecord() below, which leaves both fields null when neither source
 *  is available). */
function toAtomicUsdc(decimal: number): string {
  return Math.round(decimal * 10 ** USDC_DECIMALS).toString();
}

/**
 * Builds the ledger row for one completed x402-gated response, or returns null when this
 * response isn't a real settlement outcome the ledger should record at all — a routine 402
 * "here's what this costs" challenge (no payment attempted yet) or a verification failure with
 * no settlement ever attempted (see revenue/types.ts's RevenueSettlementStatus doc comment for
 * why "payment_verified" alone is not written here). Only called when
 * classifyX402Outcome()-equivalent logic (api/app.ts) has already determined a settlement
 * response header was present and decodable — see that call site.
 */
export function buildSettlementRecord(args: {
  settlement: DecodedSettlement;
  requestId: string;
  toolName: string;
  network: string;
  facilitator: string;
  payToAddress: string;
  requirementAmountDecimal: number;
  currency: string;
}): RevenueSettlementInput {
  const { settlement, requestId, toolName, network, facilitator, payToAddress, requirementAmountDecimal, currency } = args;
  const status: RevenueSettlementStatus = settlement.success ? "settlement_succeeded" : "settlement_failed";
  const now = new Date().toISOString();

  let amountDecimal: number | null;
  let amountAtomic: string | null;
  let amountSource: RevenueAmountSource;
  if (settlement.amount) {
    // The SDK itself echoed an atomic-unit amount — the strongest available signal, used as-is.
    amountAtomic = settlement.amount;
    amountDecimal = Number(settlement.amount) / 10 ** USDC_DECIMALS;
    amountSource = "settlement_response";
  } else if (status === "settlement_succeeded") {
    // Verified-and-settled, but the SDK didn't echo an amount (this deployment's normal case —
    // see the module doc comment). The verified requirement amount is the honest, documented
    // stand-in: settlement can only succeed for the exact amount verification already confirmed.
    amountDecimal = requirementAmountDecimal;
    amountAtomic = toAtomicUsdc(requirementAmountDecimal);
    amountSource = "verified_requirement";
  } else {
    // A failed settlement transferred nothing — there is no honest "actual settled amount" to
    // report, so this is left null rather than reporting the amount that was merely requested.
    amountDecimal = null;
    amountAtomic = null;
    amountSource = "unavailable";
  }

  const transactionHash = settlement.transaction;
  const dedupeKey = buildSettlementDedupeKey({ network: settlement.network ?? network, transactionHash, requestId, toolName });

  return {
    requestId, toolName, capabilityName: toolName,
    amountAtomic, amountDecimal, amountSource,
    currency: amountSource === "unavailable" ? null : currency,
    network: settlement.network ?? network,
    asset: amountSource === "unavailable" ? null : "USDC",
    payerAddress: settlement.payer,
    payToAddress,
    transactionHash,
    status,
    facilitator,
    errorReason: status === "settlement_failed" ? settlement.errorReason : null,
    paymentVerifiedAt: now,
    settledAt: status === "settlement_succeeded" ? now : null,
    dedupeKey
  };
}

/** Fire-and-forget from every call site — recording must never slow down or fail the real x402
 *  response it's observing (res.on("finish") has already sent that response by the time this
 *  runs regardless). Unlike analytics/recorder.ts's fireAndForget(), which silently swallows a
 *  storage hiccup because losing one usage-analytics row has no real consequence, a lost
 *  accounting row deserves visibility — so a failure here is logged to stderr (never thrown into
 *  the request path, and never containing a secret) rather than silently dropped. See
 *  revenue/types.ts's RevenueLedger.record() doc comment. */
export function recordSettlement(ledger: RevenueLedger, input: RevenueSettlementInput): void {
  try {
    void Promise.resolve(ledger.record(input)).catch(error => {
      process.stderr.write(`Revenue ledger write failed for request ${input.requestId} (${input.toolName}): ${error instanceof Error ? error.message : String(error)}\n`);
    });
  } catch (error) {
    process.stderr.write(`Revenue ledger write threw synchronously for request ${input.requestId} (${input.toolName}): ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
