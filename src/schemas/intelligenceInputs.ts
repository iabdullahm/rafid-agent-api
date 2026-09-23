import { z } from "zod";

export const RESEARCH_DEPTHS = ["quick", "standard", "deep"] as const;
export const RESEARCH_FOCUS_AREAS = [
  "overview", "products", "leadership", "funding", "competitors", "technology", "recent_news", "market_position", "risks"
] as const;

export const researchCompanyInput = z.strictObject({
  company: z.string().trim().min(1).max(200),
  website: z.string().trim().min(1).max(300).optional(),
  country: z.string().trim().min(1).max(100).optional(),
  depth: z.enum(RESEARCH_DEPTHS).default("standard"),
  focusAreas: z.array(z.enum(RESEARCH_FOCUS_AREAS)).max(RESEARCH_FOCUS_AREAS.length).optional()
});
export type ResearchCompanyInput = z.infer<typeof researchCompanyInput>;

export const findCompaniesInput = z.strictObject({
  query: z.string().trim().min(1).max(200).optional(),
  industry: z.string().trim().min(1).max(120).optional(),
  country: z.string().trim().min(1).max(100).optional(),
  city: z.string().trim().min(1).max(100).optional(),
  employeeMin: z.number().int().min(0).max(10_000_000).optional(),
  employeeMax: z.number().int().min(0).max(10_000_000).optional(),
  keywords: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
  limit: z.number().int().min(1).max(100).default(20)
}).refine(
  v => Boolean(v.query || v.industry || v.country || v.city || (v.keywords && v.keywords.length > 0)),
  { message: "At least one of query, industry, country, city or keywords must be provided" }
).refine(
  v => v.employeeMin === undefined || v.employeeMax === undefined || v.employeeMin <= v.employeeMax,
  { message: "employeeMin must be less than or equal to employeeMax" }
);
export type FindCompaniesInput = z.infer<typeof findCompaniesInput>;

export const RISK_CHECK_TYPES = [
  "corporate_identity", "domain", "website", "sanctions", "adverse_news", "security_signals", "reputation", "legal_signals"
] as const;

export const analyzeCompanyRiskInput = z.strictObject({
  company: z.string().trim().min(1).max(200).optional(),
  website: z.string().trim().min(1).max(300).optional(),
  country: z.string().trim().min(1).max(100).optional(),
  checks: z.array(z.enum(RISK_CHECK_TYPES)).max(RISK_CHECK_TYPES.length).optional()
}).refine(v => Boolean(v.company || v.website), { message: "At least one of company or website must be provided" });
export type AnalyzeCompanyRiskInput = z.infer<typeof analyzeCompanyRiskInput>;
