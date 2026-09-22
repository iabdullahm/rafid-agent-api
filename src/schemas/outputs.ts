import { z } from "zod";
const n = z.number();
export const analysisOutput = z.strictObject({
  propertyValue: n, annualRent: n, grossAnnualIncome: n, grossYield: n, netYield: n,
  annualOperatingCost: n, annualNetIncome: n, effectiveAnnualRent: n,
  paybackYears: n.nullable(), grossYieldPct: n, netYieldPct: n, annualOperatingCosts: n,
  currency: z.literal("OMR"), note: z.string()
});
export const comparisonOutput = z.strictObject({
  properties: z.array(analysisOutput.extend({ name: z.string() })),
  sortedByNetYield: z.array(z.string())
});
export const maintenanceOutput = z.strictObject({
  estimatedAnnualMaintenance: n, monthlyReserve: n, maintenancePercentage: n, currency: z.literal("OMR"),
  assumptionsUsed: z.strictObject({ ageYears: n, units: n, annualRatePct: n, additionalUnitCost: n }),
  methodology: z.string()
});
