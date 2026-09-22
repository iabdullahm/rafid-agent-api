export const round = (value: number) => Math.round(value * 100) / 100;
export const yieldPercent = (income: number, propertyValue: number) => income / propertyValue * 100;
// Existing MVP heuristic, not calibrated market data. Rates are percentages.
export const maintenanceDefaults = {
  ageBands: [
    { belowYears: 5, annualRatePct: 0.6 },
    { belowYears: 10, annualRatePct: 0.9 },
    { belowYears: 20, annualRatePct: 1.3 },
    { belowYears: Infinity, annualRatePct: 1.8 }
  ], additionalUnitCost: 35
} as const;
