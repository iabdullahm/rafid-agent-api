import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeProperty, compareProperties, estimateMaintenance } from "../src/calculators.js";
import { ZodError } from "zod";
const example = { propertyValue: 85000, annualRent: 7200, serviceCharge: 650, maintenanceCost: 400 };
test("analysis: exact example and compatibility fields", () => {
  const a = analyzeProperty(example);
  assert.equal(a.grossYield, 8.47); assert.equal(a.netYield, 7.24);
  assert.equal(a.annualOperatingCost, 1050); assert.equal(a.annualNetIncome, 6150);
  assert.equal(a.grossAnnualIncome, 7200);
  assert.deepEqual(analyzeProperty({ ...example, maintenanceCost: undefined, maintenance: 400 }), a);
});
for (const input of [
  { ...example, propertyValue: 0 }, { ...example, propertyValue: -1 },
  { ...example, annualRent: -1 }, { ...example, annualRent: Infinity },
  { ...example, propertyValue: NaN }, { ...example, propertyValue: 1e20 },
  { ...example, serviceCharge: -5 }, { ...example, maintenance: 100 },
  { ...example, unexpected: "private" }, { ...example, vacancyRatePct: 101 },
  { ...example, propertyValue: "85000" }
]) test("analysis rejects invalid input " + JSON.stringify(input), () => assert.throws(() => analyzeProperty(input), ZodError));
test("analysis: negative income, zero rent and vacancy", () => {
  const a = analyzeProperty({ propertyValue: 100000, annualRent: 1000, serviceCharge: 2000 });
  assert.equal(a.annualNetIncome, -1000); assert.equal(a.netYield, -1); assert.equal(a.paybackYears, null);
  assert.equal(analyzeProperty({ propertyValue: 100, annualRent: 0 }).paybackYears, null);
  const v = analyzeProperty({ propertyValue: 100000, annualRent: 10000, vacancyRatePct: 10, otherAnnualCosts: 1000 });
  assert.equal(v.grossYield, 10); assert.equal(v.effectiveAnnualRent, 9000); assert.equal(v.netYield, 8);
});
test("analysis: extreme positive income never serializes a non-finite payback", () => {
  const a = analyzeProperty({ propertyValue: 1e12, annualRent: 1e-320 });
  assert.equal(a.paybackYears, null);
  assert.equal(a.netYield, 0);
  assert.ok(!JSON.stringify(a).includes("Infinity"));
});
test("comparison: shared calculations, sorting, stable ties, no mutation", () => {
  const input = [{ name: "B", propertyValue: 100000, annualRent: 7000 }, { name: "A", ...example }, { name: "C", ...example }];
  const before = structuredClone(input);
  const c = compareProperties(input);
  assert.deepEqual(c.sortedByNetYield, ["A", "C", "B"]);
  assert.equal(c.properties[1].annualNetIncome, 6150);
  assert.deepEqual(input, before);
});
for (const properties of [[], [{}], "invalid", [{ name: "A", ...example }, { name: "B", ...example, annualRent: -1 }], [{ name: "A", ...example }, { name: " A ", ...example }]]) {
  test("comparison rejects malformed or duplicate properties " + JSON.stringify(properties), () => assert.throws(() => compareProperties(properties), ZodError));
}
test("maintenance: age boundaries and explicit assumptions", () => {
  for (const [ageYears, amount] of [[0,600],[5,900],[10,1300],[20,1800]]) {
    assert.equal(estimateMaintenance({ propertyValue: 100000, ageYears }).estimatedAnnualMaintenance, amount);
  }
  const m = estimateMaintenance({ propertyValue: 100000, ageYears: 12, units: 3, assumptions: { annualRatePct: 2, additionalUnitCost: 50 } });
  assert.equal(m.estimatedAnnualMaintenance, 2100); assert.equal(m.monthlyReserve, 175);
  assert.equal(m.maintenancePercentage, 2.1);
  assert.deepEqual(m.assumptionsUsed, { ageYears: 12, units: 3, annualRatePct: 2, additionalUnitCost: 50 });
});
for (const input of [{ propertyValue: 0 }, { propertyValue: -1 }, { propertyValue: 100, units: 0 }, { propertyValue: 100, ageYears: -1 }, { propertyValue: 100, propertyType: "unsupported" }, { propertyValue: 100, assumptions: { annualRatePct: -1 } }]) {
  test("maintenance rejects invalid inputs " + JSON.stringify(input), () => assert.throws(() => estimateMaintenance(input), ZodError));
}
