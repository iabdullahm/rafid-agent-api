# Website capabilities

Rafid exposes two paid, agent-discoverable website tools. Both are registered in
`src/domain/capabilities.ts`, so REST, MCP, OpenAPI, manifests, pricing and the enabled
payment rails use the same contract.

## `website_project_estimate` — $0.25 per successful call

```bash
curl -X POST http://localhost:8787/api/v1/websites/project-estimate \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"projectType":"corporate_website","pages":12,"languages":["en","ar"],"features":["cms","seo","analytics"],"designComplexity":"custom","integrations":["crm"],"market":"Oman","currency":"OMR"}'
```

The result is deterministic and includes cost, hours, timeline, category breakdown,
maintenance range, assumptions, risk flags and a confidence score. Rates and weights are
documented in `src/website-estimate/service.ts`; this is not a fixed quotation.

Free preview: `POST /api/v1/preview/website_project_estimate`. It returns complexity,
broad cost/timeline bands and major cost-driver signals, but not the paid breakdown.

## `website_audit` — $0.75 per successful audit

```bash
curl -X POST http://localhost:8787/api/v1/websites/audit \
  -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","auditTypes":["performance","seo","accessibility","security","technical"],"maxPages":5}'
```

The audit performs bounded passive inspection of public HTTPS pages. It reports measurable
metadata, HTML, crawlability and security-header evidence; unavailable checks are disclosed.
It does not claim Lighthouse/Core Web Vitals, full WCAG compliance, penetration testing or a
human UX study. It never performs exploitation or credential testing.

The crawler reuses the existing DNS-rebinding-safe `safeFeedFetch` boundary: only HTTPS is
accepted, private/loopback/link-local/metadata destinations are rejected, redirects are
revalidated, and timeout, response-size, redirect and page limits apply.

Free preview: `POST /api/v1/preview/website_audit`. It confirms input recognition and the
available audit sections without fetching pages or returning findings.

## Agent chaining

An agent can call `website_audit`, convert its evidence-backed findings into requirements
(for example, pages, multilingual support, CMS, integrations and remediation scope), then
call `website_project_estimate`. The estimator accepts structured requirements directly and
does not depend on the crawler's internal implementation.

Both tools are also available through the canonical discovery endpoints (`/agent.json`,
`/.well-known/agent.json`, `/.well-known/ai-plugin.json`, `/llms.txt`,
`/api/v1/capabilities`, `/api/v1/tools`, and `/openapi.json`) and as MCP tools.
