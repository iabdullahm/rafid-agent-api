# Recruitment Intelligence

Rafid exposes six global, machine-readable recruitment capabilities. They are decision-support tools for AI agents, ATS platforms and HR systems; they never make a hire, reject or interview decision.

## Recommended workflow

```text
CV -> extract_candidate_profile -> cv_score
JOB DESCRIPTION -> generate_job_profile
CANDIDATE + JOB -> cv_job_match
MULTIPLE CANDIDATES -> candidate_shortlist_score
CV NEEDS IMPROVEMENT -> cv_improve
```

For machine-to-machine processing, an agent can extract 50 CVs, generate one job profile, call `candidate_shortlist_score` with the normalized profiles, inspect matched and missing evidence, and hand the result to a human recruiter.

All six tools are global and available through the same REST, MCP and payment rails as the other registry capabilities:

| Tool | REST path | Price | Free preview |
|---|---|---:|---|
| `extract_candidate_profile` | `/api/v1/recruitment/extract-candidate-profile` | $0.10 | Yes, limited |
| `generate_job_profile` | `/api/v1/recruitment/generate-job-profile` | $0.10 | No |
| `cv_score` | `/api/v1/recruitment/cv-score` | $0.20 | Yes, limited |
| `cv_job_match` | `/api/v1/recruitment/cv-job-match` | $0.25 | No |
| `cv_improve` | `/api/v1/recruitment/cv-improve` | $0.25 | No |
| `candidate_shortlist_score` | `/api/v1/recruitment/candidate-shortlist-score` | $0.10 per candidate, subject to the normal per-call price | No |

The implementation uses normalized skill aliases, structured evidence, deterministic weighted scoring, explicit gaps and confidence. It does not invent missing experience, achievements, dates, technologies, certifications or metrics. Protected characteristics—including race, ethnicity, religion, nationality, sex/gender, sexual orientation, pregnancy, marital status, age, disability, medical information, political beliefs, union status, photographs and names as demographic proxies—are ignored and are not scoring features.

Example REST call:

```bash
curl -X POST https://api.example.com/api/v1/recruitment/cv-job-match \
  -H "Content-Type: application/json" -H "X-API-Key: $RAFID_API_KEY" \
  -d '{"cv_text":"Data Analyst\nSkills\nPython, SQL","job_description":"Required: Python and SQL; 2 years experience."}'
```

Example MCP calls use the exact tool names above, with the same JSON inputs. Agents should discover current schemas and enabled payment methods from `/api/v1/capabilities`, `/agent.json`, and the MCP `tools/list` response before calling.
