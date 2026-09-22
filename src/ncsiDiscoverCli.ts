/**
 * `npm run ncsi:discover` — queries NCSI's live catalog-listing endpoint
 * (GET {NCSI_API_BASE_URL}/catalog/datasets) and prints candidate real-estate-relevant datasets,
 * so an operator can find and verify a real dataset id + field names before setting
 * NCSI_REAL_ESTATE_DATASET_ID / NCSI_FIELD_MAP_JSON (see src/domain/oman/config.ts).
 *
 * This is a discovery aid only — it never writes configuration itself (Section 1 of this
 * feature's spec: "Do not hardcode dataset IDs until they have been verified against the live
 * catalog"). Nothing here is used by analyze_oman_property at runtime.
 *
 * As of this integration's development, NCSI's live catalog endpoint returned HTTP 500 for every
 * request attempted (see ncsiClient.ts's header for the full discovery log) — this CLI reports
 * that honestly if it happens again rather than pretending to have found datasets.
 */
import { getNcsiApiBaseUrl, getNcsiRequestTimeoutMs } from "./domain/oman/config.js";
import { NcsiClient, type NcsiDatasetSummary } from "./services/ncsi/ncsiClient.js";

const REAL_ESTATE_KEYWORDS = [
  "real estate", "realestate", "property", "properties", "housing", "house", "land", "mortgage",
  "sale contract", "sales contract", "traded value", "price index", "rent", "rental", "cadastre",
  "عقار", "عقاري", "إسكان", "اسكان", "رهن", "عقود بيع"
];

function isRealEstateRelevant(d: NcsiDatasetSummary): boolean {
  const haystack = `${d.title ?? ""} ${d.description ?? ""} ${d.datasetId ?? ""}`.toLowerCase();
  return REAL_ESTATE_KEYWORDS.some(k => haystack.includes(k.toLowerCase()));
}

async function main() {
  const baseUrl = getNcsiApiBaseUrl();
  const client = new NcsiClient({ baseUrl, timeoutMs: getNcsiRequestTimeoutMs() });
  console.log(`Querying NCSI catalog at ${baseUrl}/catalog/datasets ...`);

  let page;
  try {
    page = await client.listDatasets({ limit: 100, offset: 0 });
  } catch (err) {
    console.error("NCSI catalog query failed:", err instanceof Error ? err.message : err);
    console.error(
      "\nThis endpoint returned HTTP 500 for every request made during this integration's " +
      "development (including a request for a deliberately nonexistent dataset id, which a " +
      "healthy API would 404 on instead) — the live NCSI catalog-listing backend may be " +
      "temporarily unavailable. Retry later, or contact NCSI directly for a verified dataset id " +
      "and field list, then set NCSI_REAL_ESTATE_DATASET_ID and NCSI_FIELD_MAP_JSON without " +
      "waiting on this discovery tool."
    );
    process.exitCode = 1;
    return;
  }

  console.log(`Retrieved ${page.datasets.length} dataset(s) at ${page.retrievedAt}.\n`);
  if (page.datasets.length === 0) {
    console.log("No datasets returned. The catalog response shape may differ from what this client expects — inspect the raw response:");
    console.log(JSON.stringify(page.raw, null, 2).slice(0, 4000));
    return;
  }

  const candidates = page.datasets.filter(isRealEstateRelevant);
  console.log(`${candidates.length} candidate real-estate-relevant dataset(s) of ${page.datasets.length} total:\n`);
  for (const d of candidates.length > 0 ? candidates : page.datasets) {
    console.log(`- id: ${d.datasetId ?? "(unknown — inspect raw)"}`);
    console.log(`  title: ${d.title ?? "(none)"}`);
    if (d.description) console.log(`  description: ${d.description}`);
    console.log("");
  }
  if (candidates.length === 0) {
    console.log(
      "None of the returned datasets matched real-estate keywords by title/description — listing " +
      "the full catalog above instead. Inspect each entry's `raw` field (re-run with more " +
      "verbose logging, or query GET /catalog/datasets/{id} for one that looks promising) before " +
      "configuring NCSI_REAL_ESTATE_DATASET_ID."
    );
  }
}

main().catch(err => {
  console.error("Unexpected error:", err);
  process.exitCode = 1;
});
