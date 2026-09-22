import { propertySchema, compareSchema, maintenanceSchema } from "../schemas/inputs.js";
import { round, yieldPercent, maintenanceDefaults } from "../domain/financial.js";
export function analyzeProperty(input: unknown) {
  const p = propertySchema.parse(input);
  const effectiveRent = p.annualRent * (1 - (p.vacancyRatePct ?? 0) / 100);
  const costs = (p.serviceCharge ?? 0) + (p.maintenanceCost ?? p.maintenance ?? 0) + (p.otherAnnualCosts ?? 0);
  const netIncome = effectiveRent - costs;
  const grossYield = round(yieldPercent(p.annualRent, p.propertyValue));
  const netYield = round(yieldPercent(netIncome, p.propertyValue));
  const payback = netIncome > 0 ? p.propertyValue / netIncome : Infinity;
  return {
    propertyValue: p.propertyValue, annualRent: p.annualRent, grossAnnualIncome: p.annualRent,
    grossYield, netYield, annualOperatingCost: round(costs), annualNetIncome: round(netIncome),
    effectiveAnnualRent: round(effectiveRent),
    paybackYears: Number.isFinite(payback * 100) ? round(payback) : null,
    grossYieldPct: grossYield, netYieldPct: netYield, annualOperatingCosts: round(costs),
    currency: "OMR",
    note: "Calculations only; excludes financing, taxes, transaction fees and capital appreciation."
  };
}
export function compareProperties(input: unknown) {
  const { properties } = compareSchema.parse({ properties: input });
  const results = properties.map(({ name, ...p }) => ({ name, ...analyzeProperty(p) }));
  return {
    properties: results,
    sortedByNetYield: [...results].sort((a, b) => b.netYield - a.netYield).map(p => p.name)
  };
}
export function estimateMaintenance(input: unknown) {
  const p = maintenanceSchema.parse(input);
  const ageYears = p.ageYears ?? 0;
  const units = p.units ?? 1;
  const annualRatePct = p.assumptions?.annualRatePct ?? maintenanceDefaults.ageBands.find(b => ageYears < b.belowYears)!.annualRatePct;
  const additionalUnitCost = p.assumptions?.additionalUnitCost ?? maintenanceDefaults.additionalUnitCost;
  const estimate = p.propertyValue * annualRatePct / 100 + (units - 1) * additionalUnitCost;
  return {
    estimatedAnnualMaintenance: round(estimate), monthlyReserve: round(estimate / 12),
    maintenancePercentage: round(yieldPercent(estimate, p.propertyValue)), currency: "OMR",
    assumptionsUsed: { ageYears, units, annualRatePct, additionalUnitCost },
    methodology: "Annual reserve = propertyValue * annualRatePct / 100 + (units - 1) * additionalUnitCost. Uncalibrated heuristic; excludes property type and area."
  };
}
