import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max);
const language = z.string().trim().min(1).max(20).default("auto");

export const candidateProfileInput = z.unknown();

export const extractCandidateProfileInput = z.strictObject({
  cv_text: text(200_000).optional(),
  document_url: z.string().url().max(2_000).optional(),
  language,
  target_schema_version: z.string().trim().min(1).max(20).default("1.0")
}).refine(v => Boolean(v.cv_text || v.document_url), { message: "cv_text or document_url is required" });

export const generateJobProfileInput = z.strictObject({
  job_description: text(100_000),
  job_title: z.string().trim().max(300).optional(),
  language
});

const profileOrText = z.unknown().optional();
export const cvScoreInput = z.strictObject({ cv_text: z.string().trim().max(200_000).optional(), candidate_profile: profileOrText, target_role: z.string().trim().max(300).nullable().optional() })
  .refine(v => Boolean(v.cv_text || v.candidate_profile), { message: "cv_text or candidate_profile is required" });
export const cvJobMatchInput = z.strictObject({ cv_text: z.string().trim().max(200_000).optional(), job_description: z.string().trim().max(100_000).optional(), candidate_profile: profileOrText, job_profile: z.unknown().optional() })
  .refine(v => Boolean(v.cv_text || v.candidate_profile), { message: "cv_text or candidate_profile is required" })
  .refine(v => Boolean(v.job_description || v.job_profile), { message: "job_description or job_profile is required" });
export const cvImproveInput = z.strictObject({ cv_text: z.string().trim().max(200_000).optional(), target_job_description: z.string().trim().max(100_000).nullable().optional(), candidate_profile: profileOrText, mode: z.enum(["recommendations", "rewrite_summary", "rewrite_experience", "ats_optimization", "full_improvement_plan"]).default("recommendations") })
  .refine(v => Boolean(v.cv_text || v.candidate_profile), { message: "cv_text or candidate_profile is required" });

export const shortlistCandidate = z.strictObject({ candidate_id: text(100), candidate_profile: z.record(z.string(), z.unknown()) });
export const candidateShortlistScoreInput = z.strictObject({ job_profile: z.record(z.string(), z.unknown()), candidates: z.array(shortlistCandidate).min(1).max(100), max_candidates: z.number().int().min(1).max(100).default(100) });
