// Live NCSI smoke test — gated behind NCSI_LIVE_TEST, exactly like tests/customers.test.ts and
// tests/market-data.test.ts gate their PostgreSQL integration tests behind TEST_DATABASE_URL.
// `npm test` picks this file up (it matches tests/*.test.ts) but every test in it self-skips
// unless NCSI_LIVE_TEST is set, so normal test execution never depends on live NCSI availability
// (Section 11 of this feature's spec) — run it explicitly with `npm run test:ncsi-live` (with
// NCSI_LIVE_TEST=1, and ideally NCSI_REAL_ESTATE_DATASET_ID/NCSI_FIELD_MAP_JSON, in your .env).
import { test } from "node:test";
import assert from "node:assert/strict";
import { getNcsiApiBaseUrl, getNcsiFieldMap, getNcsiRealEstateDatasetId, getNcsiRequestTimeoutMs } from "../src/domain/oman/config.js";
import { NcsiClient } from "../src/services/ncsi/ncsiClient.js";
import { OfficialOmanDataProvider } from "../src/domain/oman/dataProviders.js";

const live = !!process.env.NCSI_LIVE_TEST;

test("NCSI live: catalog listing endpoint is reachable and returns a parseable response", { skip: !live }, async () => {
  const client = new NcsiClient({ baseUrl: getNcsiApiBaseUrl(), timeoutMs: getNcsiRequestTimeoutMs() });
  const page = await client.listDatasets({ limit: 10, offset: 0 });
  console.log(`NCSI catalog returned ${page.datasets.length} dataset(s) at ${page.retrievedAt}`);
  assert.ok(Array.isArray(page.datasets));
});

test("NCSI live: configured real-estate dataset (if any) resolves an official market context for Muscat", { skip: !live }, async () => {
  const datasetId = getNcsiRealEstateDatasetId();
  const fieldMap = getNcsiFieldMap();
  if (!datasetId || !fieldMap) {
    console.log("NCSI_REAL_ESTATE_DATASET_ID / NCSI_FIELD_MAP_JSON not configured — skipping the configured-dataset assertion (this is not a failure of the live connection itself).");
    return;
  }
  const client = new NcsiClient({ baseUrl: getNcsiApiBaseUrl(), timeoutMs: getNcsiRequestTimeoutMs() });
  const provider = new OfficialOmanDataProvider({ client, datasetId, fieldMap });
  const context = await provider.getMarketContext("Muscat");
  console.log(JSON.stringify(context, null, 2));
  assert.equal(context.sourceType, "official_statistics");
});
