import { runBusinessRiskScore } from "../business-risk/service.js";

/** business_risk_score's registry entry point (src/domain/capabilities.ts) — runs against the
 *  default, env-configured providers, the shared evidence cache and the assessment store
 *  (src/business-risk/service.ts). */
export async function businessRiskScore(input: unknown) {
  return runBusinessRiskScore(input);
}
