import { z } from "zod";

export const websiteAuditTypes = ["performance", "seo", "accessibility", "security", "ux", "technical"] as const;
export const websiteAuditInput = z.strictObject({
  url: z.string().trim().url().refine(v => v.startsWith("https://"), "url must use https://"),
  auditTypes: z.array(z.enum(websiteAuditTypes)).min(1).max(6).default([...websiteAuditTypes]),
  maxPages: z.number().int().min(1).max(25).default(10)
});
export type WebsiteAuditInput = z.infer<typeof websiteAuditInput>;
