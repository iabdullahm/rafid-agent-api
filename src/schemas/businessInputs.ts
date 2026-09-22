import { z } from "zod";
import { ANALYSIS_PURPOSES, DUE_DILIGENCE_TRANSACTION_TYPES } from "../business-data/types.js";

export const searchOmanCompanyInput = z.strictObject({
  query: z.string().trim().min(1).max(200),
  governorate: z.string().trim().min(1).max(60).optional(),
  wilayat: z.string().trim().min(1).max(60).optional(),
  industry: z.string().trim().min(1).max(120).optional(),
  limit: z.number().int().min(1).max(50).optional()
});

export const getOmanCompanyProfileInput = z.strictObject({
  companyId: z.string().trim().min(1).max(120)
});

export const analyzeOmanCompanyInput = z.strictObject({
  companyId: z.string().trim().min(1).max(120),
  purpose: z.enum(ANALYSIS_PURPOSES)
});

const transactionValue = z.number().min(0).max(1e9);
export const dueDiligenceOmanCompanyInput = z.strictObject({
  companyId: z.string().trim().min(1).max(120),
  transactionType: z.enum(DUE_DILIGENCE_TRANSACTION_TYPES),
  transactionValueOMR: transactionValue.optional()
});

export type SearchOmanCompanyInput = z.input<typeof searchOmanCompanyInput>;
export type GetOmanCompanyProfileInput = z.input<typeof getOmanCompanyProfileInput>;
export type AnalyzeOmanCompanyInput = z.input<typeof analyzeOmanCompanyInput>;
export type DueDiligenceOmanCompanyInput = z.input<typeof dueDiligenceOmanCompanyInput>;
