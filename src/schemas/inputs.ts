import { z } from "zod";
const money = z.number().min(0).max(1e12);
const value = money.min(0.01, "Property value must be at least 0.01");
export const propertySchema = z.strictObject({
  propertyValue: value, annualRent: money,
  serviceCharge: money.optional(), maintenanceCost: money.optional(),
  maintenance: money.optional().describe("Legacy alias for maintenanceCost; supply only one"),
  vacancyRatePct: z.number().min(0).max(100).optional(), otherAnnualCosts: money.optional()
}).refine(x => x.maintenance === undefined || x.maintenanceCost === undefined, {
  message: "Supply maintenanceCost or maintenance, not both", path: ["maintenanceCost"]
});
export const compareSchema = z.strictObject({
  properties: z.array(propertySchema.safeExtend({ name: z.string().trim().min(1).max(120) })).min(2).max(20)
}).refine(x => new Set(x.properties.map(p => p.name)).size === x.properties.length, {
  message: "Property names must be unique", path: ["properties"]
});
export const maintenanceSchema = z.strictObject({
  propertyValue: value, ageYears: z.number().min(0).max(200).optional(),
  units: z.number().int().min(1).max(10000).optional(),
  annualRent: money.optional().describe("Legacy input; unused in this value-based estimate"),
  assumptions: z.strictObject({
    annualRatePct: z.number().min(0).max(100).optional(), additionalUnitCost: money.optional()
  }).optional()
});
export type PropertyInput = z.input<typeof propertySchema>;
export type CompareProperty = z.input<typeof compareSchema>["properties"][number];
