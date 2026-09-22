import assert from "node:assert/strict";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { createApp } from "../src/api/app.js";
import { loadConfig } from "../src/config/env.js";
import { MemoryPropertyMarketRepository } from "../src/domain/oman/marketRepository.js";
import { MemoryPartnerRepository } from "../src/domain/oman/partners.js";
import { MemoryPartnerIngestionAuditRepository } from "../src/domain/oman/partnerAudit.js";
import {
  CompositeOmanPropertyDataProvider, DatabaseOmanPropertyDataProvider, ListingDataProvider, OfficialOmanDataProvider
} from "../src/domain/oman/dataProviders.js";
import { runOmanPropertyAnalysis } from "../src/services/omanProperty.js";

/**
 * Section 9: an end-to-end, self-contained rehearsal of onboarding and operating the FIRST real
 * Oman property-data partner — run with `npm run test:partner-e2e`. Uses only in-memory
 * repositories and a real HTTP server bound to an ephemeral port; requires NO production secrets,
 * NO database, and NO network access, so it can run in CI or on a fresh checkout with nothing more
 * than `npm install`. It intentionally exercises the same route stack (src/api/app.ts) that
 * production traffic goes through — not handler functions called directly — mirroring
 * tests/partner-feed.test.ts's own pattern.
 *
 * Steps (exactly Section 9's list): create a temporary partner -> issue a token -> ingest the
 * sample JSON feed -> ingest the identical payload again (idempotency) -> query internal partner
 * status -> run analyze_oman_property and check provenance -> disable the partner -> verify
 * further ingestion is rejected.
 */

function log(step: string, detail: unknown) {
  process.stdout.write(`[partner-e2e] ${step}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}\n`);
}

async function main() {
  const internalApiKey = "partner-e2e-internal-key-not-a-real-secret";
  process.env.MARKET_DATA_INTERNAL_API_KEY = internalApiKey;
  // data/example-partner-feed.json carries fixed, illustrative observedAt dates rather than
  // "today" — staleness is deliberately computed from each record's own observedAt (Section 5),
  // not from ingestion recency, so a huge threshold here means this rehearsal exercises the
  // staleness FIELD without asserting a specific policy outcome for this particular fixture data.
  process.env.PARTNER_FEED_STALE_DAYS = "36500";

  const marketRepository = new MemoryPropertyMarketRepository();
  const partnerRepository = new MemoryPartnerRepository();
  const ingestionAuditRepository = new MemoryPartnerIngestionAuditRepository();
  const config = loadConfig({ RAFID_API_KEYS: "partner-e2e-test-api-key-not-a-real-secret", LOG_LEVEL: "silent", RATE_LIMIT_ENABLED: "false" });
  const app = createApp(config, { marketRepository, partnerRepository, ingestionAuditRepository });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string", "server must bind to a real port");
  const base = `http://127.0.0.1:${address.port}`;

  try {
    // 1. Create a temporary partner.
    const partnerId = `e2e-partner-${Date.now().toString(36)}`;
    const { token } = await partnerRepository.create({
      partnerId, partnerName: "Partner E2E Rehearsal Co.", feedType: "json", sourceType: "partner_feed"
    });
    log("created partner", { partnerId });
    assert.ok(token.startsWith("rafid_partner_"), "issued token must have the expected prefix");

    // 2. (token already issued above — Section 9 lists this as its own step; nothing further to do.)

    // 3. Ingest the sample JSON feed.
    const samplePath = resolvePath(process.cwd(), "data/example-partner-feed.json");
    const samplePayload = JSON.parse(readFileSync(samplePath, "utf8"));
    const ingest = () => fetch(`${base}/api/v1/market-data/import`, {
      method: "POST", headers: { "X-Partner-Token": token, "Content-Type": "application/json" }, body: JSON.stringify(samplePayload)
    });
    const first = await ingest();
    assert.equal(first.status, 200, "first ingestion must succeed");
    const firstBody = (await first.json()).data;
    log("first ingestion", { imported: firstBody.imported, updated: firstBody.updated, rejected: firstBody.rejected });
    assert.equal(firstBody.rejected, 0, `first ingestion must have zero rejections, got ${JSON.stringify(firstBody.rejections)}`);
    assert.ok(firstBody.imported > 0, "first ingestion must import at least one record");
    assert.equal(firstBody.updated, 0, "first ingestion of brand-new records must not report any updates");

    // 4. Ingest the identical payload again — verify idempotent update, no duplication.
    const second = await ingest();
    assert.equal(second.status, 200, "second (repeat) ingestion must succeed");
    const secondBody = (await second.json()).data;
    log("second (repeat) ingestion", { imported: secondBody.imported, updated: secondBody.updated, rejected: secondBody.rejected });
    assert.equal(secondBody.imported, 0, "re-sending the identical batch must not create new records");
    assert.equal(secondBody.updated, firstBody.imported, "re-sending the identical batch must update every previously-imported record, not duplicate it");
    assert.equal(marketRepository.all().length, firstBody.imported, "record count must be unchanged after re-sending the identical batch");

    // 5. Query internal partner status.
    const statusResponse = await fetch(`${base}/api/v1/internal/market-data/partners`, { headers: { "X-Internal-Api-Key": internalApiKey } });
    assert.equal(statusResponse.status, 200, "internal partner status must be reachable with the internal API key");
    const { partners } = (await statusResponse.json()).data;
    const health = partners.find((p: { partnerId: string }) => p.partnerId === partnerId);
    assert.ok(health, "the temporary partner must appear in the internal partner health listing");
    log("internal partner health", health);
    assert.equal(health.enabled, true);
    assert.equal(health.stale, false, "a partner that just ingested fresh data must not be reported stale");
    assert.ok(health.recordsAcceptedLast24h >= firstBody.imported, "recordsAcceptedLast24h must reflect today's ingestion");
    assert.ok(!("token" in health) && !("tokenDigest" in health), "the health endpoint must never expose a token or digest");

    const qualityResponse = await fetch(`${base}/api/v1/internal/market-data/partners/${partnerId}/quality`, { headers: { "X-Internal-Api-Key": internalApiKey } });
    assert.equal(qualityResponse.status, 200, "internal partner quality summary must be reachable");
    const quality = (await qualityResponse.json()).data;
    log("internal partner quality summary", quality);
    assert.equal(quality.recordCount, firstBody.imported);

    // 6. Run analyze_oman_property and verify provenance includes partner_feed.
    const provider = new CompositeOmanPropertyDataProvider([
      new OfficialOmanDataProvider(), new ListingDataProvider(), new DatabaseOmanPropertyDataProvider(marketRepository)
    ]);
    const analysis = await runOmanPropertyAnalysis(
      { governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: 2, sizeSqm: 130, askingPriceOMR: 118000 },
      provider
    ) as { provenance: { sourceType: string; sourceName: string }[]; dataQuality?: { sourceTypes: string[] } };
    log("analyze_oman_property provenance", analysis.provenance);
    assert.ok(analysis.provenance.some(p => p.sourceType === "partner_feed"), "analyze_oman_property's provenance must include partner_feed once the partner has contributed data");
    assert.ok(analysis.provenance.some(p => p.sourceName === "Partner E2E Rehearsal Co."), "provenance sourceName must be the partner's own registered name");

    // 7. Disable the partner.
    await partnerRepository.setEnabled(partnerId, false);
    log("disabled partner", { partnerId });

    // 8. Verify further ingestion is rejected.
    const rejected = await ingest();
    assert.equal(rejected.status, 401, "ingestion from a disabled partner's token must be rejected with 401");
    log("post-disable ingestion attempt", { status: rejected.status });

    process.stdout.write("[partner-e2e] PASS — all steps completed successfully\n");
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

main().catch(error => {
  process.stderr.write(`[partner-e2e] FAIL — ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
