# Website Business Analyzer — Company, Tech, SEO & Sales Intelligence

Turn a public company website into a stable, AI-ready business intelligence record. The Actor discovers commercially useful pages, extracts evidence-backed company and product signals, detects public contacts/social profiles/technology, evaluates SEO and conversion readiness, and returns deterministic scores and actionable opportunities.

## Why use it

- Research a prospect before sales outreach.
- Enrich a lead or CRM record from a domain.
- Compare competitor positioning, pricing signals, and conversion paths.
- Let an AI agent research a company without parsing raw HTML.
- Help agencies identify evidence-backed website improvement opportunities.

## Input

```json
{
  "websiteUrl": "https://example.com",
  "maxPages": 15,
  "maxDepth": 2,
  "includeBusinessAnalysis": true,
  "includeTechnology": true,
  "includeSEO": true,
  "includeSalesIntelligence": true,
  "includeContacts": true,
  "includeSocialProfiles": true,
  "includePricing": true,
  "includeOpportunities": true,
  "sameDomainOnly": true,
  "language": "auto"
}
```

`websiteUrl` is required. Pages are HTML-only, bounded by `maxPages` and `maxDepth`, and same-domain by default. Missing facts are `null`; inferred lists include short evidence snippets. Public contact details are extracted only from fetched page content.

## Output

The dataset contains one record with `schemaVersion: "1.0"`, `success`, `company`, `businessModel`, `products`, `services`, `pricing`, `contacts`, `socialProfiles`, `technology`, `seo`, `conversion`, `businessSignals`, deterministic `scores`, `opportunities`, `salesIntelligence`, crawl provenance, confidence, and timestamp. Failed runs return a predictable `{ success: false, error: { code, message } }` record.

Scores remain backward-compatible numeric fields under `scores`; diagnostics are available under `scores.scoreDiagnostics` as `{ score, measuredSignals, unknownSignals }`. SEO uses fixed deductions for missing title (20), meta description (15), canonical (10), structured data (15), H1 (10), viewport (10), robots (10), and sitemap (10), then caps the result at 95 when the maximum is based on incomplete evidence. Unknown signals are reported separately and do not silently become facts or perfect scores. Product/service/pricing extraction uses quality gates and returns fewer values when evidence is weak.

## API and local use

Run the Actor with the standard Apify API or Console. Locally, from the Actor directory:

```powershell
cd C:\Projects\rafid-agent-api\apify\website-business-analyzer
npm install
npm run build
npm test
node --import tsx src/entrypoint.ts
```

For an API client, create an Actor run with the JSON input above and read the default dataset items endpoint. No Apify token is stored in this repository.

Production deployment and regression test:

```powershell
apify push --wait-for-finish 120
@'
{
  "websiteUrl": "https://stripe.com",
  "maxPages": 10,
  "maxDepth": 1,
  "sameDomainOnly": true
}
'@ | Set-Content -Encoding utf8 .\stripe-input.json
apify call sKeS0btpvDZbecGx3 --input-file .\stripe-input.json --output-dataset
```

## Security and limitations

The Actor validates URLs and DNS results against loopback, private, link-local, reserved, and metadata-style address ranges; revalidates redirects; caps response size; limits redirects; canonicalizes links; and avoids browser JavaScript execution. It does not bypass authentication, crawl private areas, prove absence of a technology, perform a Lighthouse/Core Web Vitals audit, or guarantee legal/company registry facts. “No signal detected” is not proof that a capability does not exist. Respect website terms, robots guidance, privacy law, and applicable data-protection obligations before processing contact data.

## Monetization

The implementation is compatible with Apify pay-per-event/pay-per-result configuration. A recommended first Store configuration is one chargeable `website_analysis` event per completed analysis, with `page_analyzed` reserved for a future metered tier. Set price from observed median runtime and page budget; do not add application-level billing or charge failed analyses.

## FAQ

**Does it use AI?** No external model is required. Deterministic extraction keeps results reproducible and economical.

**Can it analyze JavaScript-only sites?** Only server-rendered HTML signals are available in V1.

**Can I crawl another domain?** `sameDomainOnly` defaults to true and should remain enabled for normal lead research.

**Are scores Google rankings?** No. They are bounded website-signal scores, not search-engine rankings.
