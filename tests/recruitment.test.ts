import test from "node:test";
import assert from "node:assert/strict";
import { capabilities } from "../src/domain/capabilities.js";
import { extractCandidateProfile, cvJobMatch, candidateShortlistScore } from "../src/recruitment/service.js";
import { runCapabilityPreview } from "../src/preview/service.js";

const cv = "Senior Data Analyst\nExperience\nSenior Analyst at Example 2020-2024\nSkills\nPython, SQL, PowerBI\nاللغات\nالعربية والإنجليزية";

test("recruitment capabilities are present in the canonical registry with exact prices", () => {
  const names = ["cv_score", "cv_job_match", "cv_improve", "extract_candidate_profile", "generate_job_profile", "candidate_shortlist_score"];
  for (const name of names) assert.equal(capabilities.find(c => c.name === name)?.price, name === "cv_score" ? .2 : name === "cv_job_match" || name === "cv_improve" ? .25 : name === "candidate_shortlist_score" ? .1 : .1);
});

test("extracts mixed Arabic/English CVs and normalizes PowerBI", async () => {
  const result = await extractCandidateProfile({ cv_text: cv, language: "auto", target_schema_version: "1.0" });
  assert.ok(result.skills.some(s => s.name === "Microsoft Power BI"));
  assert.equal(result.experience.length, 1);
  assert.equal(result.candidate.name, null);
});

test("protected attributes do not affect professional matching", async () => {
  const base = { skills: [{ name: "Python" }], total_experience_years: 4 };
  const job = { required_skills: [{ skill: "Python" }], required_experience_years: 3 };
  const a = await candidateShortlistScore({ job_profile: job, candidates: [{ candidate_id: "a", candidate_profile: base }] });
  const b = await candidateShortlistScore({ job_profile: job, candidates: [{ candidate_id: "b", candidate_profile: { ...base, religion: "ignored", gender: "ignored", nationality: "ignored" } }] });
  assert.equal(a.candidates[0].match_score, b.candidates[0].match_score);
});

test("alias skill matching is deterministic and missing requirements remain visible", async () => {
  const result = await cvJobMatch({ candidate_profile: { skills: [{ name: "PowerBI" }], total_experience_years: 5 }, job_profile: { required_skills: [{ skill: "Microsoft Power BI" }, { skill: "Python" }], required_experience_years: 3 } });
  assert.equal(result.skill_match[0].status, "matched");
  assert.deepEqual(result.gaps, ["Python"]);
});

test("shortlist accepts 100 candidates and preview is limited", async () => {
  const candidates = Array.from({ length: 100 }, (_, i) => ({ candidate_id: `C-${i}`, candidate_profile: { skills: [{ name: "Python" }], total_experience_years: 2 } }));
  const result = await candidateShortlistScore({ job_profile: { required_skills: [{ skill: "Python" }] }, candidates, max_candidates: 100 });
  assert.equal(result.candidates.length, 100);
  const preview = await runCapabilityPreview("cv_score", { cv_text: cv });
  assert.equal(preview.status, "limited");
  assert.equal("score" in preview.preview, false);
});
