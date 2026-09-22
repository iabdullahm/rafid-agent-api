import { z } from "zod";
import { PROPERTY_TYPES, FURNISHED_STATUSES } from "../domain/oman/types.js";

const money = z.number().min(0).max(1e9);

export const omanPropertyInput = z.strictObject({
  governorate: z.string().trim().min(1).max(60),
  wilayat: z.string().trim().min(1).max(60).optional(),
  area: z.string().trim().min(1).max(80),
  propertyType: z.enum(PROPERTY_TYPES),
  bedrooms: z.number().int().min(0).max(20).optional(),
  bathrooms: z.number().int().min(0).max(20).optional(),
  sizeSqm: z.number().min(10).max(5000),
  askingPriceOMR: money.min(1000, "Asking price must be at least 1000 OMR"),
  furnished: z.enum(FURNISHED_STATUSES).optional(),
  optionalAnnualServiceChargeOMR: money.optional(),
  optionalAnnualMaintenanceOMR: money.optional()
});
export type OmanPropertyInput = z.input<typeof omanPropertyInput>;
