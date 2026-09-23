import { previewCompanyReputationCheck, runCompanyReputationCheck } from "../company-reputation/service.js";

/** company_reputation_check's registry entry point (src/domain/capabilities.ts) — runs against the
 *  default, env-configured providers and evidence cache (src/company-reputation/service.ts). */
export async function companyReputationCheck(input: unknown) {
  return runCompanyReputationCheck(input);
}

/** company_reputation_check's Free Preview entry point (src/domain/capabilities.ts) — see
 *  previewCompanyReputationCheck's own doc comment in src/company-reputation/service.ts. */
export async function previewCompanyReputationCheckCapability(input: unknown) {
  return previewCompanyReputationCheck(input);
}
