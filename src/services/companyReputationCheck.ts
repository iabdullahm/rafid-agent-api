import { runCompanyReputationCheck } from "../company-reputation/service.js";

/** company_reputation_check's registry entry point (src/domain/capabilities.ts) — runs against the
 *  default, env-configured providers and evidence cache (src/company-reputation/service.ts). */
export async function companyReputationCheck(input: unknown) {
  return runCompanyReputationCheck(input);
}
