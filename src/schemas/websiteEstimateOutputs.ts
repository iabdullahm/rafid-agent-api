import { z } from "zod";

const moneyRange = z.strictObject({ min: z.number().nonnegative(), max: z.number().nonnegative(), currency: z.string() });
const effortRange = z.strictObject({ min: z.number().nonnegative(), max: z.number().nonnegative() });
export const websiteProjectEstimateOutput = z.strictObject({
  estimatedCost: moneyRange,
  estimatedTimelineDays: effortRange,
  estimatedHours: effortRange,
  complexity: z.enum(["low", "medium", "high", "very_high"]),
  breakdown: z.strictObject({
    uiUx: effortRange, frontend: effortRange, backend: effortRange, contentAndSeo: effortRange,
    testing: effortRange, deployment: effortRange, projectManagement: effortRange
  }),
  maintenance: z.strictObject({ available: z.boolean(), monthlyHours: effortRange, monthlyCost: moneyRange }),
  riskFlags: z.array(z.string()),
  assumptions: z.array(z.string()),
  confidenceScore: z.number().min(0).max(1),
  methodology: z.strictObject({ version: z.string(), hourlyRate: z.number().positive(), currency: z.string(), factors: z.array(z.string()) })
});
export type WebsiteProjectEstimateOutput = z.infer<typeof websiteProjectEstimateOutput>;
