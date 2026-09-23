import type { RevenueSettlementInput } from "../../revenue/types.js";
import { buildSettlementDedupeKey } from "../../revenue/idempotency.js";
import type { SettledCharge, SettlementResult } from "./provider.js";
import { microsToUsd } from "./types.js";

/**
 * Revenue-ledger rows for the MPP rail. Same ledger, same source-of-truth rule as x402 and L402
 * (only "settlement_succeeded" counts as revenue; see revenue/aggregate.ts), and the same
 * never-blend discipline: MPP rows carry their own network ("tempo:<chainId>" or the EVM CAIP-2
 * id) so they're reported separately from x402's Base USDC and L402's BTC.
 *
 * Authorization, metering and settlement are recorded at different layers on purpose:
 *  - authorization (a verified credential / an opened channel) → audit log only, never revenue;
 *  - metering (a session call's voucher accepted + spend deducted) → mpp_usage_events only;
 *  - settlement (an on-chain transfer actually captured) → this ledger.
 *
 * So a session's revenue appears exactly once, when its channel is settled/closed on-chain, for
 * the amount actually captured — never per call, and never for a voucher that wasn't settled.
 */

/** Ledger `toolName` for session settlements. A session settlement pays for many calls across
 *  possibly many tools, so it is not attributable to one capability; revenue/aggregate.ts's
 *  reconciliation excludes this pseudo-tool from its per-tool execution comparison. */
export const MPP_SESSION_LEDGER_TOOL = "mpp_session";

export function buildMppChargeSettlementRecord(args: { settled: SettledCharge; tool: string; amountMicros: number; requestId: string; payer: string | null }): RevenueSettlementInput {
  const now = new Date().toISOString();
  return {
    requestId: args.requestId, toolName: args.tool, capabilityName: args.tool,
    amountAtomic: String(args.amountMicros),
    amountDecimal: microsToUsd(args.amountMicros),
    // The SDK verified the credential against this exact amount (route-bound request) before
    // settling; the receipt itself doesn't echo an amount.
    amountSource: "verified_requirement",
    currency: args.settled.asset, network: args.settled.network, asset: args.settled.asset,
    payerAddress: args.payer,
    payToAddress: args.settled.payTo,
    transactionHash: args.settled.reference || null,
    status: "settlement_succeeded",
    facilitator: `mpp:${args.settled.method}`,
    errorReason: null,
    paymentVerifiedAt: now,
    settledAt: args.settled.timestamp || now,
    dedupeKey: buildSettlementDedupeKey({ network: args.settled.network, transactionHash: args.settled.reference || null, requestId: args.requestId, toolName: args.tool })
  };
}

export function buildMppSessionSettlementRecord(args: { result: SettlementResult; sessionId: string; requestId: string }): RevenueSettlementInput | null {
  if (args.result.deltaMicros <= 0) return null;
  const now = new Date().toISOString();
  return {
    requestId: args.requestId, toolName: MPP_SESSION_LEDGER_TOOL, capabilityName: MPP_SESSION_LEDGER_TOOL,
    amountAtomic: String(args.result.deltaMicros),
    amountDecimal: microsToUsd(args.result.deltaMicros),
    // Read back from the channel's on-chain settled amount after the settle/close transaction.
    amountSource: "settlement_response",
    currency: args.result.asset, network: args.result.network, asset: args.result.asset,
    payerAddress: null,
    payToAddress: args.result.payTo,
    transactionHash: args.result.reference,
    status: "settlement_succeeded",
    facilitator: "mpp:tempo-session",
    errorReason: null,
    paymentVerifiedAt: now,
    settledAt: now,
    dedupeKey: buildSettlementDedupeKey({ network: args.result.network, transactionHash: args.result.reference, requestId: args.requestId, toolName: `${MPP_SESSION_LEDGER_TOOL}:${args.sessionId}` })
  };
}
