import test from "node:test";
import assert from "node:assert/strict";
import { capabilities } from "../src/domain/capabilities.js";
import { executeBookCapability } from "../src/book-business/service.js";

test("book registry exposes all 25 requested business tools", () => {
  const names: readonly string[] = capabilities.filter(c => c.category === "book_business").map(c => c.name as string);
  assert.equal(names.length, 25);
  assert.ok(names.includes("startup_readiness_score"));
  assert.ok(names.includes("oman_business_plan_generator"));
  assert.ok(names.includes("oman_small_business_guide"));
});

test("startup readiness preserves the book's 15-question boundaries", async () => {
  const ready = await executeBookCapability("startup_readiness_score", { answers: Array(15).fill(true) }) as { result: { score: number; classification: string } };
  const low = await executeBookCapability("startup_readiness_score", { answers: Array(15).fill(false) }) as { result: { score: number; classification: string } };
  assert.deepEqual(ready.result, { ...ready.result, score: 30, classification: "ready" });
  assert.equal(low.result.score, 0);
  assert.equal(low.result.classification, "needs_preparation");
});

test("OMR break-even uses exact baisa arithmetic and operational rounding", async () => {
  const result = await executeBookCapability("break_even_calculator", { sellingPriceOMR: 4.5, variableCostPerUnitOMR: 2, monthlyFixedCostsOMR: 23, targetProfitOMR: 150 }) as { result: { contributionMarginOMR: number; breakEvenUnits: { mathematical: number; operational: number }; targetProfitUnits: { mathematical: number; operational: number } } };
  assert.equal(result.result.contributionMarginOMR, 2.5);
  assert.equal(result.result.breakEvenUnits.mathematical, 9.2);
  assert.equal(result.result.breakEvenUnits.operational, 10);
  assert.equal(result.result.targetProfitUnits.operational, 70);
});

test("startup cost uses reserve and runway without floating point drift", async () => {
  const result = await executeBookCapability("startup_cost_estimate", { setupCostsOMR: 225, monthlyFixedCostsOMR: 23, initialInventoryOMR: 120, reservePercent: 10, runwayMonths: 3 }) as { result: { totalRequiredCapitalOMR: number; reserveOMR: number } };
  assert.equal(result.result.reserveOMR, 41.4);
  assert.equal(result.result.totalRequiredCapitalOMR, 455.4);
});

test("idea validation distinguishes missing payment evidence from live demand", async () => {
  const result = await executeBookCapability("business_idea_validate", { idea: "Mobile car wash", problem: "Busy owners lack time", customer: "Car owners", solution: "On-site washing", paymentEvidence: [] }) as { result: { paymentEvidenceStatus: string; liveMarketEvidence: string; validationGaps: string[] } };
  assert.equal(result.result.paymentEvidenceStatus, "not_provided");
  assert.equal(result.result.liveMarketEvidence, "not_checked");
  assert.ok(result.result.validationGaps.includes("payment_evidence"));
});
