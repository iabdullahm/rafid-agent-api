import { z } from "zod";

export const websiteProjectTypes = ["landing_page", "corporate_website", "portfolio", "ecommerce", "marketplace", "booking_platform", "membership_website", "web_application", "custom_website"] as const;
export const websiteFeatures = ["contact_form", "cms", "blog", "seo", "analytics", "authentication", "payments", "booking", "search", "multilingual", "rtl", "migration", "content_entry", "custom_api", "crm", "chat", "admin_dashboard", "notifications", "testing", "deployment"] as const;
export const websiteEstimateCurrencies = ["USD", "OMR", "AED", "SAR", "GBP", "EUR"] as const;

const boundedString = (max: number) => z.string().trim().min(1).max(max);

export const websiteProjectEstimateInput = z.strictObject({
  projectType: z.enum(websiteProjectTypes),
  pages: z.number().int().min(1).max(500),
  languages: z.array(boundedString(20)).min(1).max(10),
  features: z.array(boundedString(40)).max(40).default([]),
  designComplexity: z.enum(["template", "standard", "custom", "highly_custom"]).default("standard"),
  integrations: z.array(boundedString(60)).max(20).default([]),
  ecommerce: z.boolean().default(false),
  deadlineDays: z.number().int().min(1).max(730).optional(),
  market: boundedString(60).default("global"),
  currency: boundedString(3).refine(v => (websiteEstimateCurrencies as readonly string[]).includes(v.toUpperCase()), "currency must be one of USD, OMR, AED, SAR, GBP or EUR").default("USD")
});

export type WebsiteProjectEstimateInput = z.infer<typeof websiteProjectEstimateInput>;
