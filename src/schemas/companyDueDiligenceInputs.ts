import { z } from "zod";
import { isValidLei, normalizeCompanyName, normalizeCountry, normalizeDomain } from "../company-reputation/normalization.js";

const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const LEGAL_FORM_ONLY = /^(the\s+)?(ltd|limited|llc|l\.l\.c\.|inc|incorporated|corp|corporation|company|co|plc|gmbh|sa|ag|bv|nv|llp|lp|pty|srl|spa|sarl|wll|fze|fzco|est)\.?$/i;

export const DUE_DILIGENCE_PURPOSES = [
  "supplier_onboarding", "vendor_review", "procurement", "partnership", "investment_screening",
  "marketplace_onboarding", "customer_risk", "general_due_diligence"
] as const;

const checks = z.strictObject({
  registry: z.boolean().default(true), sanctions: z.boolean().default(true), adverseMedia: z.boolean().default(true),
  reputation: z.boolean().default(true), businessRisk: z.boolean().default(true)
});

export const companyDueDiligenceInput = z.strictObject({
  company: text(2, 200)
    .refine(v => /\p{L}|\d/u.test(v), "company must contain letters or digits")
    .refine(v => normalizeCompanyName(v).key.length > 0 && !LEGAL_FORM_ONLY.test(v), "company must contain more than a legal form")
    .describe("Company legal or trading name."),
  domain: text(3, 253)
    .refine(v => normalizeDomain(v) !== null && !/[\\/@:?]/.test(v), "domain must be a public hostname without credentials, a path or a port")
    .optional().describe("Public company domain, without credentials or a private/localhost host."),
  country: text(2, 60)
    .refine(v => normalizeCountry(v) !== null, "country must be an ISO 3166 code or recognizable country name")
    .optional(),
  registrationNumber: text(2, 64)
    .regex(/^[A-Za-z0-9][A-Za-z0-9 ./-]*$/, "registrationNumber contains unsupported characters")
    .optional(),
  purpose: z.enum(DUE_DILIGENCE_PURPOSES).default("general_due_diligence"),
  depth: z.enum(["quick", "standard", "enhanced"]).default("standard"),
  checks: checks.default({ registry: true, sanctions: true, adverseMedia: true, reputation: true, businessRisk: true }),
  lei: text(20, 24).refine(v => isValidLei(v.replace(/\s+/g, "")), "lei must be a valid LEI").optional()
}).describe("Strict company due diligence request. Unknown fields are rejected.");

export type CompanyDueDiligenceInput = z.infer<typeof companyDueDiligenceInput>;
