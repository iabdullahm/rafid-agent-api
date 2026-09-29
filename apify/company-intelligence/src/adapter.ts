import { businessRiskScore } from "../../../src/services/businessRiskScore.js";
import { companyReputationCheck } from "../../../src/services/companyReputationCheck.js";
import type { CompanyInput, Mode } from "./types.js";

function defined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

export function buildAnalysisInput(mode: Exclude<Mode, "company_basic">, company: CompanyInput): Record<string, unknown> {
  if (mode === "company_reputation") return defined({
    companyName: company.name ?? company.domain ?? company.registrationNumber,
    domain: company.domain,
    website: company.website,
    country: company.country,
    city: company.city,
    registrationNumber: company.registrationNumber
  });
  return defined({
    companyName: company.name ?? company.domain ?? company.registrationNumber,
    website: company.website ?? company.domain,
    country: company.country,
    city: company.city,
    registrationNumber: company.registrationNumber,
    address: company.address
  });
}

export async function analyze(mode: Mode, company: CompanyInput): Promise<unknown> {
  if (mode === "company_basic") return {
    identity: {
      name: company.name ?? null,
      normalizedName: company.name?.trim().replace(/\s+/g, " ") ?? null,
      domain: company.domain ?? null,
      website: company.website ?? null,
      country: company.country ?? null,
      city: company.city ?? null,
      registrationNumber: company.registrationNumber ?? null,
      address: company.address ?? null
    },
    confidence: 1,
    limitations: ["Basic mode returns only caller-supplied, normalized identity fields; it does not invent registry data or run paid risk scoring."]
  };
  const input = buildAnalysisInput(mode, company);
  if (mode === "company_reputation") return companyReputationCheck(input);
  return businessRiskScore(input);
}
