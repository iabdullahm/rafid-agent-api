import { PROPERTY_TYPES, RENT_PERIODS, FURNISHED_STATUSES } from "./types.js";
import { MAX_IMPORT_ROWS, MAX_IMPORT_FILE_BYTES, IMPORT_ERROR_CODES } from "./importPipeline.js";
import type { PropertyDataPartner } from "./partners.js";

/**
 * Partner Operations layer (Section 1): a pure, filesystem-free generator for a new partner's
 * onboarding package — mirrors how importPipeline.ts already separates pure validation/parsing
 * logic from marketImportCli.ts's file I/O. `src/admin.ts`'s `partner:package` command is the only
 * caller that ever writes these strings to disk (under `partner-packages/<partnerId>/`, which
 * .gitignore excludes so a generated package is never accidentally committed).
 *
 * Deliberately never includes the partner's real bearer token anywhere in the generated files —
 * every example uses a clearly-labeled placeholder (`<PARTNER_TOKEN>`). The real, one-time token
 * comes only from `partner:create`/`partner:rotate-token`'s own stdout, and must be delivered to
 * the partner through a separate, secure channel (see docs/FIRST_PARTNER_ONBOARDING.md).
 */

export interface PartnerOnboardingPackage {
  "README.md": string;
  "sample.csv": string;
  "sample.json": string;
  "schema.json": string;
  "curl-example.txt": string;
}

export interface PartnerPackageOptions {
  /** Base URL the onboarding docs/curl example should show. No environment variable backs this —
   *  it is a clearly-labeled placeholder by default, filled in by whoever runs `partner:package`
   *  for a real deployment, to avoid introducing a new required config value for something purely
   *  documentary. */
  baseUrl?: string;
}

const DEFAULT_BASE_URL = "https://<your-rafid-deployment-host>";
const TOKEN_PLACEHOLDER = "<PARTNER_TOKEN>";

const CSV_HEADER = "governorate,wilayat,area,propertyType,bedrooms,bathrooms,sizeSqm,transactionType,priceOMR,rentPeriod,furnished,sourceType,sourceName,sourceRecordId,sourceUrl,observedAt,metadata";

function sampleRows(partnerName: string) {
  return [
    { governorate: "Muscat", wilayat: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: 2, bathrooms: 2, sizeSqm: 135, transactionType: "rental", priceOMR: 820, rentPeriod: "monthly", furnished: "furnished", sourceType: "partner_feed", sourceName: partnerName, sourceRecordId: "SAMPLE-1001", sourceUrl: "https://example-partner.test/units/1001", observedAt: "2026-08-01", metadata: { floor: 6 } },
    { governorate: "Muscat", wilayat: "Bawshar", area: "Bausher", propertyType: "villa", bedrooms: 4, bathrooms: 4, sizeSqm: 350, transactionType: "sale", priceOMR: 210000, rentPeriod: null, furnished: "semi_furnished", sourceType: "partner_feed", sourceName: partnerName, sourceRecordId: "SAMPLE-1002", sourceUrl: "https://example-partner.test/units/1002", observedAt: "2026-08-02", metadata: {} }
  ];
}

function toCsvValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function buildSampleCsv(partnerName: string): string {
  const rows = sampleRows(partnerName);
  const lines = rows.map(r => CSV_HEADER.split(",").map(field => toCsvValue((r as Record<string, unknown>)[field])).join(","));
  return [CSV_HEADER, ...lines].join("\n") + "\n";
}

function buildSampleJson(partnerName: string): string {
  return JSON.stringify({ records: sampleRows(partnerName) }, null, 2) + "\n";
}

function buildSchemaJson(): string {
  return JSON.stringify({
    $comment: "Column/field reference for POST /api/v1/market-data/import — every field except metadata is required unless marked optional.",
    fields: {
      governorate: "string — e.g. \"Muscat\"",
      wilayat: "string, optional",
      area: "string — must resolve to a recognized Muscat area (see the README's area list / SUPPORTED_MUSCAT_AREAS)",
      propertyType: `one of: ${PROPERTY_TYPES.join(", ")}`,
      bedrooms: "integer 0-20, optional",
      bathrooms: "integer 0-20, optional",
      sizeSqm: "number, 10-3000",
      transactionType: "one of: rental, sale (aliases: rent/lease/\"for rent\", sell/\"for sale\"/resale accepted)",
      priceOMR: "number > 0; sale: 3,000-20,000,000; rental monthly-equivalent: 30-15,000",
      rentPeriod: `required when transactionType is rental, one of: ${RENT_PERIODS.join(", ")} (must be blank for sale)`,
      furnished: `optional, one of: ${FURNISHED_STATUSES.join(", ")}`,
      sourceType: "ignored for a partner submission — the server always overwrites this with your registered sourceType",
      sourceName: "ignored for a partner submission — the server always overwrites this with your registered partner name",
      sourceRecordId: "string, optional but strongly recommended — your own stable listing id; enables update-in-place instead of duplicate rows",
      sourceUrl: "string, optional — a valid URL",
      observedAt: "ISO date/timestamp — not in the future (beyond 1 day) and not before 2000-01-01",
      metadata: "object (JSON) or a JSON-encoded string in CSV — free-form, informational only, capped at 4000 characters"
    },
    limits: { maxRowsPerRequest: MAX_IMPORT_ROWS, maxRequestBodyBytes: MAX_IMPORT_FILE_BYTES },
    errorCodes: IMPORT_ERROR_CODES
  }, null, 2) + "\n";
}

function buildCurlExample(baseUrl: string): string {
  return [
    "# JSON ingestion",
    `curl -X POST "${baseUrl}/api/v1/market-data/import" \\`,
    `  -H "X-Partner-Token: ${TOKEN_PLACEHOLDER}" \\`,
    "  -H \"Content-Type: application/json\" \\",
    "  --data-binary @sample.json",
    "",
    "# CSV ingestion",
    `curl -X POST "${baseUrl}/api/v1/market-data/import" \\`,
    `  -H "X-Partner-Token: ${TOKEN_PLACEHOLDER}" \\`,
    "  -H \"Content-Type: text/csv\" \\",
    "  --data-binary @sample.csv",
    ""
  ].join("\n");
}

function buildReadme(partner: PropertyDataPartner, baseUrl: string): string {
  return `# Rafid Agent API — Partner Onboarding: ${partner.partnerName}

Partner id: \`${partner.partnerId}\`
Feed type: \`${partner.feedType}\`
Registered source type: \`${partner.sourceType}\`

This package explains how to submit property market data to Rafid. It contains no real
credential — your bearer token is issued separately (once, by the Rafid operator) and must
never be committed to source control or pasted anywhere public.

## Endpoint

\`POST ${baseUrl}/api/v1/market-data/import\`

## Required header

\`X-Partner-Token: ${TOKEN_PLACEHOLDER}\`

Every request must carry your partner bearer token in this header. A missing, unknown, revoked
or disabled-partner token is rejected with HTTP 401. Never send this token as a URL query
parameter, and never share it outside your own systems and the Rafid operator.

## Body format

Send either:

- \`Content-Type: text/csv\` — a CSV file with a header row exactly matching \`schema.json\`'s
  field list (see \`sample.csv\`).
- \`Content-Type: application/json\` — either a bare JSON array of record objects, or an object
  \`{"records": [...]}\` (see \`sample.json\`).

## Field meanings

See \`schema.json\` for the complete field-by-field reference (types, required/optional, valid
ranges and enums).

## Allowed property types

${PROPERTY_TYPES.map(t => `- \`${t}\``).join("\n")}

## Allowed transaction types

- \`rental\` (aliases accepted: rent, lease, "for rent")
- \`sale\` (aliases accepted: sell, "for sale", resale)

## rentPeriod rules

- Required, one of \`${RENT_PERIODS.join("`, `")}\`, when \`transactionType\` is \`rental\`.
- Must be left blank when \`transactionType\` is \`sale\`.
- An annual rent is converted to its monthly equivalent internally for plausibility checks
  (30–15,000 OMR/month); you should still submit the actual annual figure with
  \`rentPeriod: "annual"\` rather than pre-converting it yourself.

## observedAt rules

- An ISO date or timestamp (e.g. \`"2026-08-01"\` or \`"2026-08-01T12:00:00Z"\`).
- Cannot be more than 1 day in the future.
- Cannot be before the year 2000.
- This is when the listing/transaction was observed, not when you're submitting it — submit the
  real observation date so freshness/staleness reporting stays accurate.

## Attribution — what you do NOT need to send

\`sourceType\` and \`sourceName\` in your submitted rows are always ignored and overwritten by the
server with your registered partner identity. This is intentional: it means you can never
accidentally (or deliberately) claim a provenance you haven't earned, and you don't need to get
these two fields "right" — any value you send in them is discarded.

## Maximum batch size

- At most **${MAX_IMPORT_ROWS.toLocaleString()} rows** per request.
- At most **${(MAX_IMPORT_FILE_BYTES / (1024 * 1024)).toFixed(0)} MB** request body.

Split a larger export into multiple requests rather than requesting a higher limit.

## Common validation errors

Every response includes a per-row \`rejections\` array: \`{"row": <n>, "code": "<CODE>", "message": "<safe summary>"}\`.
Your original row data is never echoed back. Common codes:

${IMPORT_ERROR_CODES.map(c => `- \`${c}\``).join("\n")}

A row rejected for one of these reasons is simply skipped — every other valid row in the same
request is still imported.

## Retry / idempotency behavior

- Set \`sourceRecordId\` to your own stable listing/record id whenever you have one. Re-submitting
  the same \`sourceRecordId\` later (a full re-export, a scheduled refresh) **updates** that
  existing record in place rather than creating a duplicate — safe to retry or re-run on a
  schedule.
- A record with no \`sourceRecordId\` is always inserted as new; re-sending it will create another
  row. Only omit \`sourceRecordId\` for data you genuinely have no stable id for.
- If the exact same row (same \`sourceRecordId\` and otherwise byte-identical) appears twice in
  one request, the earlier occurrence is rejected as \`DUPLICATE_RECORD\` rather than written
  twice.
- A network failure or timeout before you receive a response is always safe to retry: re-sending
  the identical request either creates the same records again correctly keyed by
  \`sourceRecordId\` (no duplication) or, for records with no \`sourceRecordId\`, may insert them
  again — so a stable \`sourceRecordId\` is strongly recommended for any feed you intend to retry.

## Example requests

See \`curl-example.txt\`.
`;
}

/** The only entry point this module exposes — a pure function of the partner record and options,
 *  never touching the filesystem itself. */
export function buildPartnerOnboardingPackage(partner: PropertyDataPartner, options: PartnerPackageOptions = {}): PartnerOnboardingPackage {
  const baseUrl = options.baseUrl?.trim() || DEFAULT_BASE_URL;
  return {
    "README.md": buildReadme(partner, baseUrl),
    "sample.csv": buildSampleCsv(partner.partnerName),
    "sample.json": buildSampleJson(partner.partnerName),
    "schema.json": buildSchemaJson(),
    "curl-example.txt": buildCurlExample(baseUrl)
  };
}
