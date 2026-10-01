import { ZodError } from "zod";
export class ApiError extends Error {
  /** `details` (optional, additive): structured, caller-safe data an agent can act on — e.g. the
   *  candidate list behind business_risk_score's AMBIGUOUS_ENTITY. Never credentials or raw
   *  provider payloads. Omitted from the response body when undefined (every pre-existing error). */
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
export function publicError(error: unknown) {
  if (error instanceof ZodError) {
    const details = error.issues.map(i => ({ path: i.path.join("."), message: i.code === "unrecognized_keys" ? "Unknown fields are not allowed" : i.message }));
    const hasCompanyIdentifier = error.issues.some(i => ["company", "companyName", "domain", "registrationNumber"].includes(String(i.path[0])));
    return { status: 400, error: {
      code: "INVALID_INPUT",
      message: hasCompanyIdentifier ? "Provide at least one valid company identifier and retry; see details." : "Correct the fields in details and retry.",
      retryable: true,
      details
    } };
  }
  if (error instanceof ApiError) return { status: error.status, error: { code: error.code, message: error.message, ...(error.status === 400 || error.status === 409 ? { retryable: true } : {}), ...(error.details === undefined ? {} : { details: error.details }) } };
  return { status: 500, error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } };
}
