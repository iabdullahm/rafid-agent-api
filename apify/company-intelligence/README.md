# Global Company Intelligence & Risk API

Turn a company name or domain into structured reputation and business-risk intelligence for AI agents, procurement systems, CRM workflows, and due-diligence automation.

## What it does

This Actor is a distribution adapter over Rafid's production capability engine. It returns structured evidence, signals, scores and confidence where the configured Rafid providers can supply them. It does not claim legal, KYC/AML, sanctions, credit or investment determinations.

## Modes and pricing

- `company_basic` — $0.03/company: caller-supplied normalized identity fields only.
- `company_reputation` — $0.15/company: evidence-first `company_reputation_check`.
- `business_risk` — $0.25/company: evidence-backed `business_risk_score`.

Actual Store pricing is controlled by Apify pricing configuration and Pay Per Event event definitions.

## Example input

```json
{"mode":"company_reputation","company":{"name":"Tesla, Inc.","domain":"tesla.com","country":"US"}}
```

Batch input uses `companies` instead of `company`, with at most 100 companies:

```json
{"mode":"business_risk","companies":[{"name":"Example Ltd","country":"GB"},{"name":"Example LLC","domain":"example.com"}]}
```

Each company produces one dataset item. Items contain `success`, `mode`, the input company, and either the full structured `result` or a safe machine-readable `error`. The run summary is stored under the default key-value store key `OUTPUT`.

## Ambiguous company matches

If multiple registered entities match a `business_risk` request, the Actor returns a structured `resolution` object containing the available candidate entities. It does not choose a candidate automatically, compute a risk score, or charge for the unresolved result. An agent or user can select the correct candidate and retry with its stable `registrationNumber`.

```json
{
  "success": false,
  "mode": "business_risk",
  "error": { "code": "AMBIGUOUS_ENTITY", "message": "Multiple registered entities match the supplied identifiers. Retry with a stable identifier such as registrationNumber." },
  "resolution": {
    "status": "ambiguous",
    "candidateCount": 2,
    "recommendedNextAction": "retry_with_registration_number",
    "candidates": [{ "legalName": "Example Trading Ltd", "registrationNumber": "09876543", "country": "GB" }]
  },
  "billing": { "charged": false, "event": "business-risk" }
}
```

## Use cases

Vendor screening, supplier onboarding, company research, sales intelligence, due diligence, business-risk screening, procurement agents, autonomous purchasing workflows, CRM enrichment and workflow automation.

## AI agents and API

The Actor accepts JSON and is callable through the standard Apify Actor API and integrations that can run Apify Actors. Results are suitable for downstream agent and automation workflows; the Actor does not require a user's Apify token during normal execution.

## Limitations

Coverage depends on configured Rafid providers, public information, jurisdiction and provider availability. Confidence is separate from risk or reputation: missing evidence is not a clean result. External outages and rate limits are returned as structured failures where the underlying capability treats them as execution errors.

## Important disclaimer

Results are informational signals. They must not be represented as definitive legal, credit, sanctions, compliance or investment determinations unless authoritative underlying data and an appropriate human review process support that use.

See [APIFY_DEPLOYMENT.md](../../APIFY_DEPLOYMENT.md) for deployment and Store configuration.
