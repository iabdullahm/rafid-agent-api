import test from "node:test";
import assert from "node:assert/strict";
import { MemoryAnalyticsRepository } from "../src/analytics/memoryRepository.js";
import { MemoryRevenueLedger } from "../src/revenue/memoryLedger.js";
import { reconcileSettledX402 } from "../src/revenue/reconcileX402.js";
import type { SettlementChainVerifier } from "../src/revenue/chainVerifier.js";

const hash = "0x" + "ab".repeat(32);
const payer = "0x1111111111111111111111111111111111111111";
const merchant = "0x2222222222222222222222222222222222222222";

function verifier(status: "verified" | "mismatch" | "not_found" = "verified"): SettlementChainVerifier {
  return { verify: async () => ({
    status,
    checks: { transactionExists: status === "verified", networkMatches: status === "verified", amountMatches: status === "verified", recipientMatches: status === "verified", payerMatches: status === "verified" },
    detail: status === "verified" ? "verified" : "rejected"
  }) };
}

test("reconciliation verifies before inserting and is duplicate-safe", async () => {
  const ledger = new MemoryRevenueLedger();
  const analytics = new MemoryAnalyticsRepository();
  const input = { transactionHash: hash, requestId: "req-reconcile", payerAddress: payer, payToAddress: merchant, verifier: verifier(), ledger, analytics };
  const first = await reconcileSettledX402(input);
  assert.equal(first.status, "reconciled");
  assert.equal((await ledger.query({ since: null })).length, 1);
  assert.equal((await analytics.queryEvents(new Date(0))).length, 3);
  const second = await reconcileSettledX402(input);
  assert.equal(second.status, "duplicate");
  assert.equal((await ledger.query({ since: null })).length, 1);
  assert.equal((await analytics.queryEvents(new Date(0))).length, 3);
});

test("reconciliation rejects any failed or mismatched on-chain verification without writes", async () => {
  for (const status of ["mismatch", "not_found"] as const) {
    const ledger = new MemoryRevenueLedger();
    const analytics = new MemoryAnalyticsRepository();
    const result = await reconcileSettledX402({ transactionHash: hash, requestId: `req-${status}`, payerAddress: payer, payToAddress: merchant, verifier: verifier(status), ledger, analytics });
    assert.equal(result.status, "rejected");
    assert.equal((await ledger.query({ since: null })).length, 0);
    assert.equal((await analytics.queryEvents(new Date(0))).length, 0);
  }
});
