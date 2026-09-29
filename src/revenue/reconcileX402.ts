import { buildSettlementDedupeKey } from "./idempotency.js";
import type { AnalyticsRepository } from "../analytics/types.js";
import type { RevenueLedger, RevenueSettlement } from "./types.js";
import type { SettlementChainVerifier } from "./chainVerifier.js";

export const BASE_MAINNET = "eip155:8453";
export const BASE_MAINNET_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bDa02913";

export interface ReconcileX402Input {
  transactionHash: string;
  requestId: string;
  payerAddress: string;
  payToAddress: string;
  verifier: SettlementChainVerifier;
  ledger: RevenueLedger;
  analytics: AnalyticsRepository;
}

export type ReconcileX402Result =
  | { status: "reconciled"; row: RevenueSettlement }
  | { status: "duplicate"; row: RevenueSettlement }
  | { status: "rejected"; reason: string };

/** Imports one already-settled x402 transaction only after the injected verifier independently
 * proves the Base receipt, USDC contract, amount, merchant and payer. The transaction hash is the
 * idempotency boundary; a second reconciliation never creates another revenue row. */
export async function reconcileSettledX402(input: ReconcileX402Input): Promise<ReconcileX402Result> {
  const existing = (await input.ledger.query({ since: null })).find(row =>
    row.transactionHash?.toLowerCase() === input.transactionHash.toLowerCase()
  );
  if (existing) return { status: "duplicate", row: existing };

  const now = new Date().toISOString();
  const candidate: RevenueSettlement = {
    requestId: input.requestId,
    toolName: "analyze_property",
    capabilityName: "analyze_property",
    amountAtomic: "10000",
    amountDecimal: 0.01,
    amountSource: "settlement_response",
    currency: "USDC",
    network: BASE_MAINNET,
    asset: "USDC",
    payerAddress: input.payerAddress,
    payToAddress: input.payToAddress,
    transactionHash: input.transactionHash,
    status: "settlement_succeeded",
    facilitator: "coinbase-cdp",
    errorReason: null,
    paymentVerifiedAt: now,
    settledAt: now,
    dedupeKey: buildSettlementDedupeKey({ network: BASE_MAINNET, transactionHash: input.transactionHash, requestId: input.requestId, toolName: "analyze_property" }),
    createdAt: now
  };

  const verification = await input.verifier.verify(candidate);
  if (verification.status !== "verified") {
    return { status: "rejected", reason: verification.detail };
  }

  const row: RevenueSettlement = {
    ...candidate,
    reconciliationSource: "onchain",
    reconciledAt: now,
    auditMetadata: {
      source: "onchain",
      tokenContract: BASE_MAINNET_USDC,
      verificationStatus: verification.status,
      checks: JSON.stringify(verification.checks)
    }
  };
  await input.ledger.record(row);

  const common = {
    category: "x402" as const, path: null, toolName: "analyze_property", channel: null,
    success: true, durationMs: null, amount: 0.01, currency: "USD", txHash: input.transactionHash,
    dataSource: null, clientHash: null, userAgent: null, referer: null, clientName: null,
    requestId: input.requestId, paymentRail: "x402"
  };
  await input.analytics.record({ ...common, eventType: "settlement_success" });
  await input.analytics.record({ ...common, eventType: "payment_verified", txHash: null });
  const existingExecution = (await input.analytics.queryEvents(new Date(0))).some(event =>
    event.requestId === input.requestId && event.category === "tool" && event.eventType === "invocation" && event.success === true
  );
  if (!existingExecution) {
    await input.analytics.record({ ...common, category: "tool", eventType: "invocation", channel: "x402", txHash: null });
  }
  return { status: "reconciled", row };
}
