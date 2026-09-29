import { PostgresAnalyticsRepository } from "./db/analyticsStore.js";
import { PostgresRevenueLedger } from "./db/revenueStore.js";
import { getAnalyticsDatabaseUrl } from "./analytics/config.js";
import { getRevenueDatabaseUrl } from "./revenue/config.js";
import { createSettlementChainVerifier, getChainVerifierConfig } from "./revenue/chainVerifier.js";
import { reconcileSettledX402, BASE_MAINNET_USDC } from "./revenue/reconcileX402.js";

const transactionHash = process.argv[2];
const requestId = process.argv[3];
const payerAddress = process.argv[4];
const expectedMerchant = process.env.X402_WALLET_ADDRESS?.trim();
const revenueDatabaseUrl = getRevenueDatabaseUrl();
const analyticsDatabaseUrl = getAnalyticsDatabaseUrl();

if (!transactionHash || !requestId || !payerAddress || !expectedMerchant) {
  throw new Error("Usage: reconcile-x402 <transactionHash> <requestId> <payerAddress> (X402_WALLET_ADDRESS must be configured)");
}
if (!/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) throw new Error("transactionHash must be a 32-byte hex hash");
if (!/^0x[0-9a-fA-F]{40}$/.test(payerAddress) || !/^0x[0-9a-fA-F]{40}$/.test(expectedMerchant)) throw new Error("payer and merchant must be EVM addresses");
if (!revenueDatabaseUrl || !analyticsDatabaseUrl) throw new Error("A durable revenue and analytics PostgreSQL database is required");

const chainConfig = getChainVerifierConfig({
  ...process.env,
  CHAIN_RPC_URL: process.env.CHAIN_RPC_URL || "https://mainnet.base.org",
  CHAIN_USDC_CONTRACT_EIP155_8453: BASE_MAINNET_USDC
});
const ledger = new PostgresRevenueLedger(revenueDatabaseUrl);
const analytics = new PostgresAnalyticsRepository(analyticsDatabaseUrl);
try {
  const result = await reconcileSettledX402({
    transactionHash, requestId, payerAddress, payToAddress: expectedMerchant,
    verifier: createSettlementChainVerifier(chainConfig), ledger, analytics
  });
  console.log(JSON.stringify({
    status: result.status,
    transactionHash,
    requestId,
    ...(result.status === "rejected" ? { reason: result.reason } : {
      paymentRecord: result.row.reconciliationSource === "onchain",
      revenueAmount: result.row.amountDecimal,
      dedupeKey: result.row.dedupeKey
    })
  }));
} finally {
  await Promise.all([ledger.close(), analytics.close()]);
}
