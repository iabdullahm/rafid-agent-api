import { ZodError } from "zod";
export class ApiError extends Error {
  /** `details` (optional, additive): structured, caller-safe data an agent can act on — e.g. the
   *  candidate list behind business_risk_score's AMBIGUOUS_ENTITY. Never credentials or raw
   *  provider payloads. Omitted from the response body when undefined (every pre-existing error). */
  constructor(public status: number, public code: string, message: string, public details?: unknown) { super(message); }
}
export function publicError(error: unknown) {
  if (error instanceof ZodError) return { status: 400, error: {
    code: "INVALID_INPUT", message: "Input validation failed",
    details: error.issues.map(i => ({ path: i.path.join("."), message: i.code === "unrecognized_keys" ? "Unknown fields are not allowed" : i.message }))
  } };
  if (error instanceof ApiError) return { status: error.status, error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } };
  return { status: 500, error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } };
}
