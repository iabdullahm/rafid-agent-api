import { z } from "zod";
import { isValidLei, normalizeCompanyName, normalizeCountry, normalizeWebsite } from "../company-reputation/normalization.js";

/**
 * business_risk_score input. Only companyName is required; every other identifier materially
 * improves entity resolution (country above all — it is the main guard against attributing another
 * jurisdiction's same-name company to this one) but none is mandatory. Strict: unknown fields are
 * rejected and every identifier is validated rather than silently dropped.
 */
const text = (min: number, max: number) => z.string().trim().min(min).max(max);
/** A "name" that is only a legal form ("Ltd", "LLC", "The Company") identifies nothing. */
const LEGAL_FORM_ONLY = /^(the\s+)?(ltd|limited|llc|l\.l\.c\.|inc|incorporated|corp|corporation|company|co|plc|gmbh|sa|ag|bv|nv|llp|lp|pte|pty|srl|spa|sarl|saog|saoc|spc|wll|fze|fzco|est)\.?$/i;

export const businessRiskScoreInput = z.strictObject({
  companyName: text(2, 200).refine(v => /\p{L}|\d/u.test(v), "companyName must contain letters or digits")
    .refine(v => normalizeCompanyName(v).key.length > 0 && !LEGAL_FORM_ONLY.test(v.trim()), "companyName must contain more than a legal form")
    .describe("Company name as known to the caller (trading or legal name). Required."),
  country: text(2, 60).refine(v => normalizeCountry(v) !== null, "country must be an ISO 3166 alpha-2/alpha-3 code or a recognizable English country name")
    .optional().describe("Country of registration/operation — ISO 3166 alpha-2 (e.g. GB), alpha-3 or English name. Strongly recommended: prevents same-name companies in other countries from being confused."),
  registrationNumber: text(2, 64).regex(/^[A-Za-z0-9][A-Za-z0-9 ./-]*$/, "registrationNumber may contain letters, digits, spaces, '.', '/' and '-'")
    .optional().describe("Company registration number in its home registry (e.g. UK Companies House number, Oman CR number). The strongest disambiguator."),
  lei: text(20, 24).refine(v => isValidLei(v.replace(/\s+/g, "")), "lei must be a valid 20-character ISO 17442 Legal Entity Identifier")
    .optional().describe("Legal Entity Identifier (ISO 17442), if known — decisive for entity resolution."),
  website: text(4, 300).refine(v => normalizeWebsite(v) !== null, "website must be an http(s) URL or a hostname with a public domain")
    .optional().describe("Company website or domain, e.g. https://example.com (normalized to its https origin)."),
  address: text(3, 300).optional().describe("Street address as supplied by the company (checked against the registered address when the registry publishes one)."),
  city: text(2, 80).optional().describe("City of registration/headquarters (helps disambiguation)."),
  industry: text(2, 100).optional().describe("Claimed industry/business activity (checked for consistency with the company's public presence; never scored by itself)."),
  knownAliases: z.array(text(2, 200)).max(5).optional()
    .describe("Other names the company trades or traded under (max 5). Screened against sanctions/restricted-party lists and used to attribute media."),
  includeNews: z.boolean().optional().describe("Default true. false skips news, customer-review and regulator web searches (faster, cheaper; reputation coverage becomes 'none')."),
  includeDigitalSignals: z.boolean().optional().describe("Default true. false skips website, domain-registration and threat-feed checks (digital coverage becomes 'none').")
});

export type BusinessRiskScoreInput = z.infer<typeof businessRiskScoreInput>;
