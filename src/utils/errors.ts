import { ZodError } from "zod";
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function publicError(error: unknown) {
  if (error instanceof ZodError) return { status: 400, error: {
    code: "INVALID_INPUT", message: "Input validation failed",
    details: error.issues.map(i => ({ path: i.path.join("."), message: i.code === "unrecognized_keys" ? "Unknown fields are not allowed" : i.message }))
  } };
  if (error instanceof ApiError) return { status: error.status, error: { code: error.code, message: error.message } };
  return { status: 500, error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" } };
}
