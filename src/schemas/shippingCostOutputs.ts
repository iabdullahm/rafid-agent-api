import { z } from "zod";

const moneyRange = z.strictObject({ min: z.number().nonnegative(), max: z.number().nonnegative(), currency: z.string() });
const transit = z.strictObject({ min: z.number().int().nonnegative(), max: z.number().int().nonnegative() });
const breakdown = z.strictObject({ baseFreight: z.number().nonnegative(), fuelSurcharge: z.number().nonnegative(), handling: z.number().nonnegative(), remoteAreaSurcharge: z.number().nonnegative(), oversizeSurcharge: z.number().nonnegative(), estimatedOtherFees: z.number().nonnegative() });
const risk = z.strictObject({ code: z.string(), severity: z.enum(["low", "medium", "high"]), message: z.string() });
const option = z.strictObject({ shippingMode: z.enum(["courier", "air", "sea", "road", "postal"]), serviceLevel: z.enum(["economy", "standard", "express"]), estimatedCost: moneyRange, estimatedTransitDays: transit, rateSource: z.enum(["live_carrier", "internal_estimate", "heuristic_estimate"]), provider: z.string().nullable() });

export const shippingCostEstimateOutput = z.strictObject({
  estimatedCost: moneyRange,
  recommendedEstimate: z.number().nonnegative(),
  actualWeightKg: z.number().positive(),
  volumetricWeightKg: z.number().nonnegative(),
  chargeableWeightKg: z.number().positive(),
  shippingMode: z.enum(["courier", "air", "sea", "road", "postal"]),
  serviceLevel: z.enum(["economy", "standard", "express"]),
  estimatedTransitDays: transit,
  costBreakdown: breakdown,
  rateSource: z.enum(["live_carrier", "internal_estimate", "heuristic_estimate"]),
  provider: z.string().nullable(),
  dutiesAndTaxes: z.strictObject({ included: z.literal(false), estimatedAmount: z.null(), note: z.string() }),
  confidence: z.strictObject({ level: z.enum(["high", "medium", "low"]), reason: z.string() }),
  assumptions: z.array(z.string()),
  riskFlags: z.array(risk),
  options: z.array(option),
  recommendedOptionReason: z.enum(["lowest_estimated_cost", "shortest_transit", "balanced_cost_and_time"]).nullable(),
  generatedAt: z.string().datetime()
});

export type ShippingEstimateOutput = z.infer<typeof shippingCostEstimateOutput>;
