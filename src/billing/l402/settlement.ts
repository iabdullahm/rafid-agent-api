import type { RevenueSettlementInput } from "../../revenue/types.js";
import { buildSettlementDedupeKey } from "../../revenue/idempotency.js";
import type { L402PaidContext } from "./gate.js";

/**
 * Revenue-ledger row for one redeemed L402 token. Same ledger and same source-of-truth rule as
 * x402 (only "settlement_succeeded" counts as revenue), kept apart by network/currency so the
 * existing never-blend-currencies discipline reports BTC separately from USDC:
 *
 *  - network: "lightning:<mainnet|testnet|...>"; currency/asset: "BTC"
 *  - amountAtomic: sats (string); amountDecimal: BTC (sats / 1e8)
 *  - amountSource "verified_requirement": the sats amount is the one signed into the macaroon at
 *    challenge time, and the preimage proves the invoice for exactly that amount was paid
 *  - transactionHash: the Lightning payment hash (public, unique per invoice) — never the preimage
 *  - facilitator: the Lightning backend that issued the invoice ("lnd" or "voltage")
 *  - dedupe key: tx:<network>:<payment hash>, so one token can never be counted twice
 */
export function buildL402SettlementRecord(args: { ctx: L402PaidContext; requestId: string; network: string; payTo: string; facilitator?: string }): RevenueSettlementInput {
  const now = new Date().toISOString();
  const network = `lightning:${args.network}`;
  return {
    requestId: args.requestId, toolName: args.ctx.toolName, capabilityName: args.ctx.toolName,
    amountAtomic: String(args.ctx.amountSats),
    amountDecimal: args.ctx.amountSats / 100_000_000,
    amountSource: "verified_requirement",
    currency: "BTC", network, asset: "BTC",
    payerAddress: null,
    payToAddress: args.payTo,
    transactionHash: args.ctx.paymentHashHex,
    status: "settlement_succeeded",
    facilitator: args.facilitator ?? "lnd",
    errorReason: null,
    paymentVerifiedAt: now,
    settledAt: now,
    dedupeKey: buildSettlementDedupeKey({ network, transactionHash: args.ctx.paymentHashHex, requestId: args.requestId, toolName: args.ctx.toolName })
  };
}
