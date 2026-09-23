import type { RegistryCandidateView, Resolution } from "../company-reputation/companyResolver.js";
import { ApiError } from "../utils/errors.js";
import { LIMITS } from "./config.js";
import type { BusinessRiskQuery, RoleRun } from "./types.js";

/**
 * Structured business_risk_score errors. Each is an ApiError, so every channel (REST, x402, L402,
 * MPP, MCP) renders it through the shared publicError() as { code, message, details } — and because
 * it is a non-2xx outcome, no paid settlement happens on x402/L402/MPP (the payment gates settle only
 * successful responses). INVALID_INPUT (400) comes from schema validation and INTERNAL_ERROR (500)
 * from the shared error handler.
 *
 *   AMBIGUOUS_ENTITY     409  several registry entities match and nothing supplied tells them apart
 *   ENTITY_NOT_FOUND     404  the jurisdiction's registry was checked and holds no such company, and
 *                             no other evidence of the business's existence was found
 *   PROVIDER_TIMEOUT     504  every identity source that was attempted timed out
 *   RATE_LIMITED         429  every identity source that was attempted rate-limited the request
 *   PROVIDER_UNAVAILABLE 503  every identity source that was attempted failed
 * INSUFFICIENT_DATA is a RESULT (status "insufficient_data"), used only when this deployment has no
 * evidence source configured for the company at all — see the output schema.
 */

export const BUSINESS_RISK_ERROR_CODES = ["INVALID_INPUT", "ENTITY_NOT_FOUND", "AMBIGUOUS_ENTITY", "INSUFFICIENT_DATA", "PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE", "RATE_LIMITED", "INTERNAL_ERROR"] as const;

function candidateView(c: RegistryCandidateView) {
  return {
    legalName: c.legalName, country: c.country, city: c.city, registrationNumber: c.registrationNumber, lei: c.lei,
    registrationStatus: c.status, incorporationDate: c.incorporationDate, registry: c.registryName, matchScore: c.score, matchedOn: c.matchedOn
  };
}

export function ambiguousEntityError(q: BusinessRiskQuery, resolution: Resolution): ApiError {
  const suggested = [
    ...(q.registrationNumber ? [] : ["registrationNumber"]), ...(q.lei ? [] : ["lei"]), ...(q.country ? [] : ["country"]),
    ...(q.city ? [] : ["city"]), ...(q.website ? [] : ["website"])
  ];
  return new ApiError(409, "AMBIGUOUS_ENTITY",
    `"${q.companyName}" matches ${resolution.candidates.length} different registered companies and the supplied identifiers do not distinguish them. No risk score was computed and no payment was taken; retry with one of the candidates' registration numbers.`,
    { status: "ambiguous_entity", candidates: resolution.candidates.slice(0, LIMITS.maxCandidatesInError).map(candidateView), suggestedIdentifiers: suggested });
}

export function entityNotFoundError(q: BusinessRiskQuery, registries: readonly string[]): ApiError {
  return new ApiError(404, "ENTITY_NOT_FOUND",
    `No company matching "${q.companyName}"${q.registrationNumber ? ` (registration number ${q.registrationNumber})` : ""}${q.country ? ` was found in ${q.country.name}` : " was found"}, and no other evidence that the business exists (reachable website or registered domain) was found. Check the spelling, country and registration number.`,
    { status: "entity_not_found", registriesChecked: [...registries], identifiersUsed: { companyName: q.companyName, country: q.country?.code ?? null, registrationNumber: q.registrationNumber, lei: q.lei, domain: q.domain } });
}

export function providerOutageError(attempted: readonly RoleRun[]): ApiError {
  const details = { status: "provider_failure", providers: attempted.map(r => ({ provider: r.providerName, status: r.status, reason: r.reason })) };
  const names = attempted.map(r => r.providerName).join(", ");
  if (attempted.every(r => r.status === "timeout")) return new ApiError(504, "PROVIDER_TIMEOUT", `The company identity sources timed out (${names}); the minimum identity check could not be performed. Retry shortly — no payment was taken.`, details);
  if (attempted.every(r => r.status === "rate_limited")) return new ApiError(429, "RATE_LIMITED", `The company identity sources are rate limiting requests (${names}). Retry shortly — no payment was taken.`, details);
  return new ApiError(503, "PROVIDER_UNAVAILABLE", `The company identity sources are unavailable (${names}); the minimum identity check could not be performed. Retry shortly — no payment was taken.`, details);
}
