import { runResearchCompany } from "../intelligence/companyResearch/provider.js";
import { runFindCompanies } from "../intelligence/companyDiscovery/provider.js";
import { runAnalyzeCompanyRisk } from "../intelligence/risk/provider.js";

/**
 * The Phase 1 "Rafid Agent Intelligence" capabilities' real entry points
 * (src/domain/capabilities.ts) — mirrors services/omanBusiness.ts's own
 * "thin wrapper, module-level default options" pattern exactly. No requestId is threaded through
 * here (AgentCapability["execute"] is `(input: unknown) => Promise<unknown>` with no second
 * argument — see domain/capabilities.ts) so cost-attribution records for calls made this way carry
 * requestId: null; that's expected and harmless (see intelligence/costEstimator.ts, which never
 * requires a requestId to aggregate correctly).
 */
export async function researchCompany(input: unknown) { return runResearchCompany(input); }
export async function findCompanies(input: unknown) { return runFindCompanies(input); }
export async function analyzeCompanyRisk(input: unknown) { return runAnalyzeCompanyRisk(input); }
