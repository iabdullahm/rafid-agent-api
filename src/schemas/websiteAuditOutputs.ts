import { z } from "zod";

const issue = z.strictObject({ category: z.enum(["performance", "seo", "accessibility", "security", "ux", "technical"]), severity: z.enum(["critical", "high", "medium", "low", "info"]), issue: z.string(), evidence: z.string(), affectedUrl: z.string(), recommendedAction: z.string(), estimatedFixEffort: z.enum(["low", "medium", "high", "unknown"]) });
const page = z.strictObject({ url: z.string(), status: z.number().int().nullable(), title: z.string().nullable(), sizeBytes: z.number().int().nonnegative().nullable(), internalLinksFound: z.number().int().nonnegative(), issues: z.number().int().nonnegative() });
export const websiteAuditOutput = z.strictObject({
  overallScore: z.number().int().min(0).max(100),
  scores: z.strictObject({ performance: z.number().int().min(0).max(100), seo: z.number().int().min(0).max(100), accessibility: z.number().int().min(0).max(100), security: z.number().int().min(0).max(100), ux: z.number().int().min(0).max(100), technical: z.number().int().min(0).max(100) }),
  criticalIssues: z.array(issue), highPriorityIssues: z.array(issue), mediumPriorityIssues: z.array(issue), lowPriorityIssues: z.array(issue), quickWins: z.array(issue),
  seoIssues: z.array(issue), performanceIssues: z.array(issue), accessibilityIssues: z.array(issue), securityFindings: z.array(issue), technicalIssues: z.array(issue), uxIssues: z.array(issue),
  pagesAudited: z.array(page), estimatedFixHours: z.strictObject({ min: z.number().nonnegative(), max: z.number().nonnegative() }), confidenceScore: z.number().min(0).max(1), limitations: z.array(z.string())
});
export type WebsiteAuditOutput = z.infer<typeof websiteAuditOutput>;
