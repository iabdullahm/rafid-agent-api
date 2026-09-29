import { z } from "zod";
import { normalizeDomain, normalizeWebsite } from "../../../src/company-reputation/normalization.js";
import { MAX_COMPANIES, MODES, type AmbiguousEntityResolution, type ActorInput, type CompanyInput, type Mode, type SafeError } from "./types.js";

const companySchema = z.object({
  name: z.string().trim().min(2).max(200).optional(),
  domain: z.string().trim().min(3).max(253).refine(v => normalizeDomain(v) !== null, "domain must be a public hostname").optional(),
  registrationNumber: z.string().trim().min(2).max(64).optional(),
  country: z.string().trim().min(2).max(60).optional(),
  city: z.string().trim().min(2).max(80).optional(),
  website: z.string().trim().min(4).max(300).refine(v => normalizeWebsite(v) !== null, "website must be a public http(s) URL").optional(),
  address: z.string().trim().min(3).max(300).optional()
}).strict().refine(v => Boolean(v.name || v.domain || v.registrationNumber), { message: "provide name, domain, or registrationNumber" })
  .refine(v => !v.domain || !v.website || normalizeDomain(v.domain) === normalizeWebsite(v.website)?.domain, { message: "domain and website must refer to the same host" });

export function parseInput(raw: unknown): { mode: Mode; companies: CompanyInput[] } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new z.ZodError([{ code: "custom", path: [], message: "input must be an object" }]);
  const value = raw as Record<string, unknown>;
  const mode = value.mode === undefined ? "company_reputation" : z.enum(MODES).parse(value.mode);
  const hasSingle = value.company !== undefined && value.company !== null;
  const batch = Array.isArray(value.companies) ? value.companies : [];
  if (hasSingle && batch.length > 0) throw new z.ZodError([{ code: "custom", path: [], message: "provide exactly one of company or companies" }]);
  if (!hasSingle && batch.length === 0) throw new z.ZodError([{ code: "custom", path: [], message: "provide a company or a non-empty companies array" }]);
  const rawCompanies = hasSingle ? [value.company] : batch;
  if (rawCompanies.length > MAX_COMPANIES) throw new z.ZodError([{ code: "custom", path: ["companies"], message: `companies cannot contain more than ${MAX_COMPANIES} items` }]);
  return { mode, companies: rawCompanies.map((item, index) => {
    try { return companySchema.parse(item) as CompanyInput; }
    catch (error) {
      if (error instanceof z.ZodError) throw new z.ZodError(error.issues.map(issue => ({ ...issue, path: [hasSingle ? "company" : "companies", ...(hasSingle ? [] : [index]), ...issue.path] })));
      throw error;
    }
  }) };
}

function ambiguousResolution(details: unknown): AmbiguousEntityResolution | undefined {
  if (!details || typeof details !== "object") return undefined;
  const value = details as Record<string, unknown>;
  if (value.status !== "ambiguous_entity" || !Array.isArray(value.candidates)) return undefined;
  const candidates = value.candidates.map(candidate => {
    if (!candidate || typeof candidate !== "object") return null;
    const c = candidate as Record<string, unknown>;
    const safe: Record<string, unknown> = {};
    if (typeof c.legalName === "string") safe.legalName = c.legalName;
    if (typeof c.registrationNumber === "string" || c.registrationNumber === null) safe.registrationNumber = c.registrationNumber;
    if (typeof c.country === "string" || c.country === null) safe.country = c.country;
    if (typeof c.city === "string" || c.city === null) safe.city = c.city;
    if (typeof c.registry === "string") safe.registry = c.registry;
    if (typeof c.registrationStatus === "string") safe.registrationStatus = c.registrationStatus;
    if (typeof c.incorporationDate === "string" || c.incorporationDate === null) safe.incorporationDate = c.incorporationDate;
    if (Array.isArray(c.matchedOn)) safe.matchedOn = c.matchedOn.filter((item): item is string => typeof item === "string");
    if (typeof c.matchScore === "number" && Number.isFinite(c.matchScore)) safe.matchConfidence = Math.max(0, Math.min(1, c.matchScore));
    return safe;
  }).filter((candidate): candidate is Record<string, unknown> => candidate !== null);
  const candidateCount = typeof value.candidateCount === "number" && Number.isInteger(value.candidateCount) ? value.candidateCount : candidates.length;
  return { status: "ambiguous", candidateCount, recommendedNextAction: "retry_with_registration_number", candidates };
}

export function safeError(error: unknown): SafeError {
  if (error instanceof z.ZodError) return { code: "INVALID_INPUT", message: error.issues.map(i => i.message).join("; ").slice(0, 500) };
  const e = error as { code?: unknown; message?: unknown };
  const allowed = new Set(["ENTITY_NOT_FOUND", "AMBIGUOUS_ENTITY", "PROVIDER_TIMEOUT", "PROVIDER_UNAVAILABLE", "RATE_LIMITED", "INVALID_INPUT", "BILLING_NOT_AVAILABLE", "SPENDING_LIMIT_REACHED"]);
  const code = typeof e?.code === "string" && allowed.has(e.code) ? e.code : "ANALYSIS_FAILED";
  if (code === "AMBIGUOUS_ENTITY") return { code, message: "Multiple registered entities match the supplied identifiers. Retry with a stable identifier such as registrationNumber.", resolution: ambiguousResolution((error as { details?: unknown })?.details) };
  return { code, message: typeof e?.message === "string" ? e.message.replace(/\b[A-Z]:\\[^\s]+/g, "[path]").slice(0, 500) : "The company analysis failed." };
}
