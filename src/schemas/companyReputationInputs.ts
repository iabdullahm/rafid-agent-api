import { z } from "zod";
import { isValidLei, normalizeCountry, normalizeDomain, normalizeWebsite, registrableDomain } from "../company-reputation/normalization.js";

/**
 * company_reputation_check input. Only companyName is required; country is strongly recommended
 * (it is the main guard against attributing another jurisdiction's same-name company to this one).
 * Strict: unknown fields are rejected, identifiers are validated, and contradictory identifiers
 * (a website and a domain that disagree) are rejected rather than silently picking one.
 */
const text = (min: number, max: number) => z.string().trim().min(min).max(max);

export const companyReputationCheckInput = z.strictObject({
  companyName: text(2, 200).refine(v => /\p{L}|\d/u.test(v), "companyName must contain letters or digits")
    .describe("Company name as known to the caller (trading or legal name)."),
  country: text(2, 60).refine(v => normalizeCountry(v) !== null, "country must be an ISO 3166 alpha-2 code or a recognizable English country name")
    .optional().describe("Country of registration/operation — ISO alpha-2 (e.g. GB), alpha-3 or English name. Strongly recommended to avoid same-name confusion."),
  website: text(4, 300).refine(v => normalizeWebsite(v) !== null, "website must be an http(s) URL or hostname with a public domain")
    .optional().describe("Company website, e.g. https://example.com."),
  domain: text(3, 253).refine(v => normalizeDomain(v) !== null, "domain must be a public hostname such as example.com")
    .optional().describe("Company domain if no website URL is known, e.g. example.com."),
  registrationNumber: text(2, 64).regex(/^[A-Za-z0-9][A-Za-z0-9 ./-]*$/, "registrationNumber may contain letters, digits, spaces, '.', '/' and '-'")
    .optional().describe("Company registration number in its home registry (e.g. UK Companies House number)."),
  lei: text(20, 24).refine(v => isValidLei(v.replace(/\s+/g, "")), "lei must be a valid 20-character ISO 17442 Legal Entity Identifier")
    .optional().describe("Legal Entity Identifier (ISO 17442), if known."),
  legalName: text(2, 200).optional().describe("Full registered legal name, if different from companyName."),
  city: text(2, 80).optional().describe("City of registration/headquarters (helps disambiguation)."),
  industry: text(2, 100).optional().describe("Industry/sector (context only; not used to score).")
}).refine(v => {
  if (!v.website || !v.domain) return true;
  const w = normalizeWebsite(v.website), d = normalizeDomain(v.domain);
  return Boolean(w && d && registrableDomain(w.domain) === registrableDomain(d));
}, { message: "website and domain refer to different domains; supply one or make them consistent", path: ["domain"] });

export type CompanyReputationCheckInput = z.infer<typeof companyReputationCheckInput>;
