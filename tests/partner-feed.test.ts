import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/api/app.js";
import { loadConfig } from "../src/config/env.js";
import { capabilities } from "../src/domain/capabilities.js";
import { readFileSync, rmSync } from "node:fs";
import { PostgresPropertyMarketRepository } from "../src/db/marketStore.js";
import { PostgresPartnerRepository } from "../src/db/partnerStore.js";
import { MemoryPropertyMarketRepository, type MarketRecordInput } from "../src/domain/oman/marketRepository.js";
import { MemoryPartnerRepository } from "../src/domain/oman/partners.js";
import { MemoryPartnerIngestionAuditRepository } from "../src/domain/oman/partnerAudit.js";
import { buildPartnerOnboardingPackage } from "../src/domain/oman/partnerPackage.js";
import {
  CompositeOmanPropertyDataProvider, DatabaseOmanPropertyDataProvider, ListingDataProvider, OfficialOmanDataProvider
} from "../src/domain/oman/dataProviders.js";
import { runOmanPropertyAnalysis } from "../src/services/omanProperty.js";
import { computeDataQualityScore } from "../src/domain/oman/dataQualityScore.js";

const key = "test-only-not-a-real-credential-12345";

function baseInput(overrides: Partial<MarketRecordInput> = {}): MarketRecordInput {
  return {
    governorate: "Muscat", wilayat: "Muscat", area: "Al Mouj", normalizedArea: "al mouj",
    propertyType: "apartment", bedrooms: 2, bathrooms: 2, sizeSqm: 130,
    transactionType: "rental", priceOMR: 750, rentPeriod: "monthly", furnished: "furnished",
    sourceType: "partner_feed", sourceName: "Gulf Realty Oman", sourceRecordId: null, sourceUrl: null,
    observedAt: new Date().toISOString(), metadata: {},
    ...overrides
  };
}

/** Starts a real HTTP server over createApp() with injected in-memory market/partner/ingestion-
 *  audit repositories — mirrors tests/http.test.ts's pattern exactly, so the partner ingestion
 *  routes are exercised as genuine HTTP requests, not by calling handler functions directly.
 *  MARKET_DATA_INTERNAL_API_KEY and PARTNER_FEED_STALE_DAYS are read from process.env at
 *  createApp() time (see src/api/app.ts/src/domain/oman/config.ts), so this helper sets/clears
 *  them per call. */
async function startApp(opts: { internalApiKey?: string; staleDays?: number } = {}) {
  if (opts.internalApiKey !== undefined) process.env.MARKET_DATA_INTERNAL_API_KEY = opts.internalApiKey;
  else delete process.env.MARKET_DATA_INTERNAL_API_KEY;
  if (opts.staleDays !== undefined) process.env.PARTNER_FEED_STALE_DAYS = String(opts.staleDays);
  else delete process.env.PARTNER_FEED_STALE_DAYS;

  const marketRepository = new MemoryPropertyMarketRepository();
  const partnerRepository = new MemoryPartnerRepository();
  const ingestionAuditRepository = new MemoryPartnerIngestionAuditRepository();
  const config = loadConfig({ RAFID_API_KEYS: key, LOG_LEVEL: "silent", RATE_LIMIT_ENABLED: "false" });
  const app = createApp(config, { marketRepository, partnerRepository, ingestionAuditRepository });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { server, base: `http://127.0.0.1:${address.port}`, marketRepository, partnerRepository, ingestionAuditRepository };
}

const importRequest = (base: string, token: string, body: unknown, contentType = "application/json") =>
  fetch(base + "/api/v1/market-data/import", {
    method: "POST", headers: { "X-Partner-Token": token, "Content-Type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });

// -------------------------------------------------------------------------------------------
// Section 15: this is infrastructure, never an agent capability.
// -------------------------------------------------------------------------------------------
test("Partner ingestion is never registered as an agent capability (absent from the capability registry, and so from /agent.json, the tool catalog, x402 and remote MCP)", () => {
  assert.ok(!capabilities.some(c => c.path.includes("market-data")), "market-data routes must not be capability-registry entries");
});

// -------------------------------------------------------------------------------------------
// Partner authentication
// -------------------------------------------------------------------------------------------
test("Partner authentication: a partner's token authenticates as that partner; unknown or disabled tokens never authenticate", async () => {
  const repo = new MemoryPartnerRepository();
  const { partner, token } = await repo.create({ partnerId: "gulf-realty-om", partnerName: "Gulf Realty Oman", feedType: "csv", sourceType: "partner_feed" });
  assert.equal(partner.partnerId, "gulf-realty-om");
  assert.ok(token.startsWith("rafid_partner_"));
  const authenticated = await repo.authenticate(token);
  assert.equal(authenticated?.partnerId, "gulf-realty-om");
  assert.equal(await repo.authenticate("rafid_partner_wrongwrongwrong"), null);
  await repo.setEnabled("gulf-realty-om", false);
  assert.equal(await repo.authenticate(token), null, "a disabled partner's token must stop authenticating");
});

test("POST /api/v1/market-data/import: unauthorized without a token, and with an invalid token", async t => {
  const { server, base, partnerRepository } = await startApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  await partnerRepository.create({ partnerId: "gulf-realty-om", partnerName: "Gulf Realty Oman", feedType: "csv", sourceType: "partner_feed" });
  const noToken = await fetch(base + "/api/v1/market-data/import", { method: "POST", headers: { "Content-Type": "text/csv" }, body: "a,b\n1,2\n" });
  assert.equal(noToken.status, 401);
  const badToken = await importRequest(base, "rafid_partner_totallybogus", [], "application/json");
  assert.equal(badToken.status, 401);
});

// -------------------------------------------------------------------------------------------
// CSV / JSON ingestion, forced server-side attribution
// -------------------------------------------------------------------------------------------
test("POST /api/v1/market-data/import: CSV ingestion validates rows and forcibly attributes them to the authenticated partner", async t => {
  const { server, base, partnerRepository, marketRepository } = await startApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { token } = await partnerRepository.create({ partnerId: "gulf-realty-om", partnerName: "Gulf Realty Oman", feedType: "csv", sourceType: "partner_feed" });
  const csv = [
    "governorate,area,propertyType,bedrooms,bathrooms,sizeSqm,transactionType,priceOMR,rentPeriod,furnished,sourceType,sourceName,sourceRecordId,observedAt",
    // sourceType/sourceName here deliberately claim a provenance the partner has no right to —
    // the server must overwrite both rather than trust them.
    `Muscat,Al Mouj,apartment,2,2,130,rental,780,monthly,furnished,official_statistics,Spoofed Source,GRO-1,${new Date().toISOString().slice(0, 10)}`
  ].join("\n");
  const response = await importRequest(base, token, csv, "text/csv");
  assert.equal(response.status, 200);
  const body = (await response.json()).data;
  assert.equal(body.imported, 1);
  assert.equal(body.rejections.length, 0);
  assert.ok(typeof body.averageDataQualityScore === "number" && body.averageDataQualityScore >= 0 && body.averageDataQualityScore <= 1);
  const stored = marketRepository.all()[0]!;
  assert.equal(stored.partnerId, "gulf-realty-om");
  assert.equal(stored.sourceType, "partner_feed", "server-side attribution must overwrite a spoofed sourceType");
  assert.equal(stored.sourceName, "Gulf Realty Oman", "server-side attribution must overwrite a spoofed sourceName");
});

test("POST /api/v1/market-data/import: JSON ingestion accepts both a bare array and a {records:[...]} wrapper", async t => {
  const { server, base, partnerRepository } = await startApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { token } = await partnerRepository.create({ partnerId: "gulf-realty-om", partnerName: "Gulf Realty Oman", feedType: "json", sourceType: "partner_feed" });
  const row = (id: string) => ({
    governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: 2, bathrooms: 2, sizeSqm: 130,
    transactionType: "sale", priceOMR: 120000, furnished: "furnished", sourceType: "partner_feed",
    sourceName: "Gulf Realty Oman", sourceRecordId: id, observedAt: new Date().toISOString()
  });
  const arrayResponse = await importRequest(base, token, [row("j1")]);
  assert.equal(arrayResponse.status, 200);
  assert.equal((await arrayResponse.json()).data.imported, 1);
  const wrappedResponse = await importRequest(base, token, { records: [row("j2")] });
  assert.equal(wrappedResponse.status, 200);
  assert.equal((await wrappedResponse.json()).data.imported, 1);
});

// -------------------------------------------------------------------------------------------
// Idempotent upsert / duplicate sourceRecordId
// -------------------------------------------------------------------------------------------
test("POST /api/v1/market-data/import: re-sending the same sourceRecordId updates rather than duplicates", async t => {
  const { server, base, partnerRepository, marketRepository } = await startApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { token } = await partnerRepository.create({ partnerId: "gulf-realty-om", partnerName: "Gulf Realty Oman", feedType: "json", sourceType: "partner_feed" });
  const row = (priceOMR: number) => ([{
    governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: 2, bathrooms: 2, sizeSqm: 130,
    transactionType: "sale", priceOMR, furnished: "furnished", sourceType: "partner_feed",
    sourceName: "Gulf Realty Oman", sourceRecordId: "dup-1", observedAt: new Date().toISOString()
  }]);
  const first = (await (await importRequest(base, token, row(120000))).json()).data;
  assert.equal(first.imported, 1); assert.equal(first.updated, 0);
  const second = (await (await importRequest(base, token, row(125000))).json()).data;
  assert.equal(second.imported, 0); assert.equal(second.updated, 1);
  assert.equal(marketRepository.all().length, 1);
  assert.equal(marketRepository.all()[0]!.priceOMR, 125000);
});

test("POST /api/v1/market-data/import: two rows sharing a sourceRecordId within the same batch are inserted then updated, never duplicated", async t => {
  const { server, base, partnerRepository, marketRepository } = await startApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { token } = await partnerRepository.create({ partnerId: "gulf-realty-om", partnerName: "Gulf Realty Oman", feedType: "json", sourceType: "partner_feed" });
  const rowWith = (priceOMR: number) => ({
    governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: 2, bathrooms: 2, sizeSqm: 130,
    transactionType: "sale", priceOMR, furnished: "furnished", sourceType: "partner_feed",
    sourceName: "Gulf Realty Oman", sourceRecordId: "dup-batch", observedAt: new Date().toISOString()
  });
  const response = (await (await importRequest(base, token, [rowWith(120000), rowWith(130000)])).json()).data;
  assert.equal(response.imported, 1);
  assert.equal(response.updated, 1);
  assert.equal(marketRepository.all().length, 1);
  assert.equal(marketRepository.all()[0]!.priceOMR, 130000);
});

// -------------------------------------------------------------------------------------------
// Invalid records
// -------------------------------------------------------------------------------------------
test("POST /api/v1/market-data/import: invalid rows are rejected individually with a row number; valid rows in the same batch still import", async t => {
  const { server, base, partnerRepository } = await startApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { token } = await partnerRepository.create({ partnerId: "gulf-realty-om", partnerName: "Gulf Realty Oman", feedType: "json", sourceType: "partner_feed" });
  const valid = {
    governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: 2, bathrooms: 2, sizeSqm: 130,
    transactionType: "sale", priceOMR: 120000, furnished: "furnished", sourceType: "partner_feed",
    sourceName: "Gulf Realty Oman", sourceRecordId: "ok-1", observedAt: new Date().toISOString()
  };
  const impossibleSize = { ...valid, sourceRecordId: "bad-1", sizeSqm: 9999 }; // rejected: implausible size
  const impossiblePrice = { ...valid, sourceRecordId: "bad-2", priceOMR: 1 }; // rejected: implausible sale price
  const response = (await (await importRequest(base, token, [valid, impossibleSize, impossiblePrice])).json()).data;
  assert.equal(response.imported, 1);
  assert.equal(response.rejected, 2);
  assert.equal(response.rejections.length, 2);
  assert.equal(response.rejections[0].row, 2);
  assert.equal(response.rejections[0].code, "INVALID_SIZE");
  assert.equal(response.rejections[1].row, 3);
  assert.equal(response.rejections[1].code, "INVALID_PRICE");
  // Section 6: "do not echo full raw rows back" — the rejection summary must never contain the
  // partner's original field values.
  assert.ok(!JSON.stringify(response.rejections).includes("9999"), "a rejection entry must not echo the raw rejected row back");
});

test("POST /api/v1/market-data/import: two identical rows (same sourceRecordId and otherwise byte-identical) within one batch reject the earlier as DUPLICATE_RECORD, importing only once", async t => {
  const { server, base, partnerRepository, marketRepository } = await startApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { token } = await partnerRepository.create({ partnerId: "gulf-realty-om", partnerName: "Gulf Realty Oman", feedType: "json", sourceType: "partner_feed" });
  const observedAt = new Date().toISOString();
  const row = {
    governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: 2, bathrooms: 2, sizeSqm: 130,
    transactionType: "sale", priceOMR: 120000, furnished: "furnished", sourceType: "partner_feed",
    sourceName: "Gulf Realty Oman", sourceRecordId: "exact-dup-1", observedAt
  };
  const response = (await (await importRequest(base, token, [row, { ...row }])).json()).data;
  assert.equal(response.imported, 1);
  assert.equal(response.updated, 0);
  assert.equal(response.rejected, 1);
  assert.equal(response.rejections[0].row, 1, "the EARLIER identical occurrence is the one rejected, keeping the later one");
  assert.equal(response.rejections[0].code, "DUPLICATE_RECORD");
  assert.equal(marketRepository.all().length, 1);
});

// -------------------------------------------------------------------------------------------
// Data-quality scoring (deterministic, non-LLM)
// -------------------------------------------------------------------------------------------
test("computeDataQualityScore: deterministic, bounded to [0,1], and rewards completeness/plausibility/freshness/source identity", () => {
  const complete = baseInput({ sourceUrl: "https://example-partner.test/1", metadata: { floor: 3 } });
  const sparse = baseInput({ bedrooms: null, bathrooms: null, furnished: null, sourceUrl: null, metadata: {}, sourceType: "listing_asking_price" });
  const scoreComplete = computeDataQualityScore(complete, { partnerId: "gulf-realty-om" });
  const scoreSparse = computeDataQualityScore(sparse, { partnerId: null });
  assert.ok(scoreComplete > scoreSparse, "a complete, partner-attributed record must score higher than a sparse, unattributed one");
  assert.ok(scoreComplete >= 0 && scoreComplete <= 1);
  assert.equal(scoreComplete, computeDataQualityScore(complete, { partnerId: "gulf-realty-om" }), "must be a pure, deterministic function of its inputs");

  const stale = baseInput({ observedAt: new Date(Date.now() - 800 * 86_400_000).toISOString() });
  const fresh = baseInput({ observedAt: new Date().toISOString() });
  assert.ok(computeDataQualityScore(fresh, { partnerId: "gulf-realty-om" }) > computeDataQualityScore(stale, { partnerId: "gulf-realty-om" }));

  const implausibleSize = baseInput({ sizeSqm: 2900 });
  const typicalSize = baseInput({ sizeSqm: 130 });
  assert.ok(computeDataQualityScore(typicalSize) > computeDataQualityScore(implausibleSize));
});

// -------------------------------------------------------------------------------------------
// Provenance: analyze_oman_property distinguishes partner-fed records
// -------------------------------------------------------------------------------------------
test("analyze_oman_property: partner-fed records surface with sourceType 'partner_feed' and sourceName = the partner's own name, without changing the public output shape", async t => {
  const { server, base, partnerRepository, marketRepository } = await startApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { token } = await partnerRepository.create({ partnerId: "gulf-realty-om", partnerName: "Gulf Realty Oman", feedType: "json", sourceType: "partner_feed" });
  const rows = Array.from({ length: 5 }, (_, i) => ({
    governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: 2, bathrooms: 2, sizeSqm: 128 + i,
    transactionType: "rental", priceOMR: 700 + i * 5, rentPeriod: "monthly", furnished: "furnished",
    sourceType: "listing_asking_price", sourceName: "ignored-by-the-server", sourceRecordId: `pv-${i}`, observedAt: new Date().toISOString()
  }));
  const importResponse = (await (await importRequest(base, token, rows)).json()).data;
  assert.equal(importResponse.imported, 5);

  const provider = new CompositeOmanPropertyDataProvider([new OfficialOmanDataProvider(), new ListingDataProvider(), new DatabaseOmanPropertyDataProvider(marketRepository)]);
  const result = await runOmanPropertyAnalysis(
    { governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: 2, sizeSqm: 130, askingPriceOMR: 118000 }, provider
  ) as any;
  assert.equal(result.insufficientMarketData, false);
  assert.equal(result.provenance.length, 1);
  assert.equal(result.provenance[0].sourceType, "partner_feed");
  assert.equal(result.provenance[0].sourceName, "Gulf Realty Oman");
  assert.deepEqual(result.dataQuality.sourceTypes, ["partner_feed"]);
  assert.equal(result.currency, "OMR", "the existing public analyze_oman_property output shape is unchanged");
});

// -------------------------------------------------------------------------------------------
// Partner feed health / staleness (Section 11) — never affects ingestion or analysis.
// -------------------------------------------------------------------------------------------
test("PartnerRepository.listWithStats: flags a partner stale once its latest accepted record exceeds staleDays, including a partner with no records at all", async () => {
  const repo = new MemoryPartnerRepository();
  await repo.create({ partnerId: "old-feed", partnerName: "Old Feed", feedType: "csv", sourceType: "partner_feed" });
  await repo.create({ partnerId: "fresh-feed", partnerName: "Fresh Feed", feedType: "csv", sourceType: "partner_feed" });
  await repo.create({ partnerId: "silent-feed", partnerName: "Silent Feed", feedType: "csv", sourceType: "partner_feed" });
  await repo.recordImportStats("old-feed", { received: 1, accepted: 1, rejected: 0, updated: 0, latestObservedAt: new Date(Date.now() - 90 * 86_400_000).toISOString() });
  await repo.recordImportStats("fresh-feed", { received: 1, accepted: 1, rejected: 0, updated: 0, latestObservedAt: new Date().toISOString() });

  const withStats = await repo.listWithStats(30);
  assert.equal(withStats.find(p => p.partnerId === "old-feed")!.stale, true);
  assert.equal(withStats.find(p => p.partnerId === "fresh-feed")!.stale, false);
  assert.equal(withStats.find(p => p.partnerId === "silent-feed")!.stale, true, "a partner that has never sent an accepted record is stale by definition");
});

// -------------------------------------------------------------------------------------------
// GET /api/v1/internal/market-data/status and .../partners
// -------------------------------------------------------------------------------------------
test("GET /api/v1/internal/market-data/status: fails closed (503) when MARKET_DATA_INTERNAL_API_KEY is not configured", async t => {
  const { server, base } = await startApp({ internalApiKey: undefined });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await fetch(base + "/api/v1/internal/market-data/status", { headers: { "X-Internal-Api-Key": "anything" } });
  assert.equal(response.status, 503);
});

test("GET /api/v1/internal/market-data/status: requires the internal key and reports the exact specified aggregate shape", async t => {
  const internalApiKey = "test-internal-secret-0123456789";
  const { server, base, partnerRepository, marketRepository } = await startApp({ internalApiKey });
  t.after(() => { server.closeAllConnections(); server.close(); });
  await partnerRepository.create({ partnerId: "gulf-realty-om", partnerName: "Gulf Realty Oman", feedType: "csv", sourceType: "partner_feed" });
  await marketRepository.upsertMarketRecords([
    baseInput({ sourceRecordId: "s1", transactionType: "rental" }),
    baseInput({ sourceRecordId: "s2", transactionType: "sale", rentPeriod: null, priceOMR: 120000 })
  ]);

  assert.equal((await fetch(base + "/api/v1/internal/market-data/status")).status, 401);
  assert.equal((await fetch(base + "/api/v1/internal/market-data/status", { headers: { "X-Internal-Api-Key": "wrong" } })).status, 401);

  const response = await fetch(base + "/api/v1/internal/market-data/status", { headers: { "X-Internal-Api-Key": internalApiKey } });
  assert.equal(response.status, 200);
  const body = (await response.json()).data;
  assert.deepEqual(Object.keys(body).sort(), ["areas", "latestDataDate", "partners", "records", "rentalRecords", "saleRecords", "sourceTypes"].sort());
  assert.equal(body.records, 2);
  assert.equal(body.rentalRecords, 1);
  assert.equal(body.saleRecords, 1);
  assert.equal(body.areas, 1);
  assert.equal(body.partners, 1);
  assert.ok(body.sourceTypes.includes("partner_feed"));
  assert.ok(body.latestDataDate);
});

test("GET /api/v1/internal/market-data/partners: reports the exact Section 4 shape (including windowed accepted counts and rejection rate) and stale flags, without exposing any partner token or digest", async t => {
  const internalApiKey = "test-internal-secret-0123456789";
  const { server, base, partnerRepository } = await startApp({ internalApiKey, staleDays: 10 });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { token } = await partnerRepository.create({ partnerId: "gulf-realty-om", partnerName: "Gulf Realty Oman", feedType: "csv", sourceType: "partner_feed" });
  await partnerRepository.recordImportStats("gulf-realty-om", { received: 1, accepted: 1, rejected: 0, updated: 0, latestObservedAt: new Date(Date.now() - 20 * 86_400_000).toISOString() });

  // Ingest through the real HTTP endpoint (rather than only recordImportStats above) so the
  // windowed recordsAcceptedLast24h/Last7d/rejectionRateLast7d figures — sourced from the
  // ingestion audit log, not from PartnerFeedStats — have something real to report.
  const validRow = {
    governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: 2, bathrooms: 2, sizeSqm: 130,
    transactionType: "sale", priceOMR: 120000, furnished: "furnished", sourceType: "partner_feed",
    sourceName: "Gulf Realty Oman", sourceRecordId: "health-1", observedAt: new Date().toISOString()
  };
  const badRow = { ...validRow, sourceRecordId: "health-2", sizeSqm: 9999 };
  await importRequest(base, token, [validRow, badRow]);

  const response = await fetch(base + "/api/v1/internal/market-data/partners", { headers: { "X-Internal-Api-Key": internalApiKey } });
  assert.equal(response.status, 200);
  const { partners } = (await response.json()).data;
  assert.equal(partners.length, 1);
  const partner = partners[0];
  assert.deepEqual(Object.keys(partner).sort(), [
    "enabled", "feedType", "latestIngestionAt", "latestObservationDate", "partnerId", "partnerName",
    "recordsAcceptedLast24h", "recordsAcceptedLast7d", "rejectionRateLast7d", "stale", "staleDays",
    // Production Feed Runner (Section 9): the scheduled-feed-run health fields, added alongside
    // (never replacing) every field the Partner Operations layer already reported above.
    "lastFeedAttemptAt", "lastFeedSuccessAt", "consecutiveFailures", "nextDueAt", "feedHealth"
  ].sort());
  assert.equal(partner.partnerId, "gulf-realty-om");
  assert.equal(partner.stale, false, "the freshly-ingested record above must keep the partner non-stale even though an earlier stats-only record was old");
  assert.equal(partner.staleDays, 10);
  assert.equal(partner.recordsAcceptedLast24h, 1, "only the ONE valid row from the HTTP ingestion above counts as accepted");
  assert.equal(partner.recordsAcceptedLast7d, 1);
  assert.equal(partner.rejectionRateLast7d, 50, "1 of 2 records submitted in the last 7 days was rejected -> 50%");
  assert.ok(partner.latestIngestionAt, "latestIngestionAt must be populated after a real ingestion attempt");
  assert.equal(partner.consecutiveFailures, 0, "a partner with no scheduled feed configured has never failed a scheduled run");
  assert.equal(partner.feedHealth, "healthy", "no consecutive failures and not stale -> healthy");
  assert.equal(partner.lastFeedAttemptAt, null, "this partner has no scheduled feed configured, so it has never been attempted");
  assert.equal(partner.lastFeedSuccessAt, null);
  assert.equal(partner.nextDueAt, null, "no schedule configured -> never due");
  const serialized = JSON.stringify(partners);
  assert.ok(!serialized.includes(token), "a partner's plaintext token must never be exposed by the internal partners endpoint");
  assert.ok(!("tokenDigest" in partner) && !("token" in partner));
});

test("GET /api/v1/internal/market-data/partners: a stale partner never marks any OTHER partner (or the whole market) stale", async t => {
  const internalApiKey = "test-internal-secret-0123456789";
  const { server, base, partnerRepository } = await startApp({ internalApiKey, staleDays: 5 });
  t.after(() => { server.closeAllConnections(); server.close(); });
  await partnerRepository.create({ partnerId: "old-feed", partnerName: "Old Feed", feedType: "csv", sourceType: "partner_feed" });
  await partnerRepository.create({ partnerId: "fresh-feed", partnerName: "Fresh Feed", feedType: "csv", sourceType: "partner_feed" });
  await partnerRepository.recordImportStats("old-feed", { received: 1, accepted: 1, rejected: 0, updated: 0, latestObservedAt: new Date(Date.now() - 90 * 86_400_000).toISOString() });
  await partnerRepository.recordImportStats("fresh-feed", { received: 1, accepted: 1, rejected: 0, updated: 0, latestObservedAt: new Date().toISOString() });

  const response = await fetch(base + "/api/v1/internal/market-data/partners", { headers: { "X-Internal-Api-Key": internalApiKey } });
  const { partners } = (await response.json()).data;
  assert.equal(partners.find((p: { partnerId: string }) => p.partnerId === "old-feed").stale, true);
  assert.equal(partners.find((p: { partnerId: string }) => p.partnerId === "fresh-feed").stale, false);
});

// -------------------------------------------------------------------------------------------
// Section 7: per-partner data-quality summary
// -------------------------------------------------------------------------------------------
test("GET /api/v1/internal/market-data/partners/:partnerId/quality: aggregates completeness and score buckets over a partner's own records only", async t => {
  const internalApiKey = "test-internal-secret-0123456789";
  const { server, base, partnerRepository } = await startApp({ internalApiKey });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { token } = await partnerRepository.create({ partnerId: "gulf-realty-om", partnerName: "Gulf Realty Oman", feedType: "json", sourceType: "partner_feed" });
  const complete = {
    governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: 2, bathrooms: 2, sizeSqm: 130,
    transactionType: "rental", priceOMR: 750, rentPeriod: "monthly", furnished: "furnished", sourceType: "partner_feed",
    sourceName: "Gulf Realty Oman", sourceRecordId: "q-1", sourceUrl: "https://example-partner.test/q-1", observedAt: new Date().toISOString(), metadata: { floor: 2 }
  };
  const sparse = {
    governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", sizeSqm: 130,
    transactionType: "rental", priceOMR: 750, rentPeriod: "monthly", sourceType: "partner_feed",
    sourceName: "Gulf Realty Oman", sourceRecordId: "q-2", observedAt: new Date().toISOString()
  };
  await importRequest(base, token, [complete, sparse]);

  const response = await fetch(`${base}/api/v1/internal/market-data/partners/gulf-realty-om/quality`, { headers: { "X-Internal-Api-Key": internalApiKey } });
  assert.equal(response.status, 200);
  const body = (await response.json()).data;
  assert.equal(body.partnerId, "gulf-realty-om");
  assert.equal(body.recordCount, 2);
  assert.ok(typeof body.averageDataQualityScore === "number");
  assert.equal(body.missingBedroomRate, 50, "exactly one of the two records is missing bedrooms");
  assert.equal(body.missingBathroomRate, 50);
  assert.equal(body.missingFurnishedRate, 50);
});

test("GET /api/v1/internal/market-data/partners/:partnerId/quality: 404s for an unknown partner", async t => {
  const internalApiKey = "test-internal-secret-0123456789";
  const { server, base } = await startApp({ internalApiKey });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await fetch(`${base}/api/v1/internal/market-data/partners/no-such-partner/quality`, { headers: { "X-Internal-Api-Key": internalApiKey } });
  assert.equal(response.status, 404);
});

// -------------------------------------------------------------------------------------------
// Section 3: ingestion audit log
// -------------------------------------------------------------------------------------------
test("Ingestion audit log: records exactly one row per attempt (success and failure), and never stores the partner token, raw payload, or record bodies", async t => {
  const { server, base, partnerRepository, ingestionAuditRepository } = await startApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { token } = await partnerRepository.create({ partnerId: "gulf-realty-om", partnerName: "Gulf Realty Oman", feedType: "json", sourceType: "partner_feed" });
  const validRow = {
    governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: 2, bathrooms: 2, sizeSqm: 130,
    transactionType: "sale", priceOMR: 120000, furnished: "furnished", sourceType: "partner_feed",
    sourceName: "Gulf Realty Oman", sourceRecordId: "audit-1", observedAt: new Date().toISOString()
  };
  await importRequest(base, token, [validRow]);
  // Valid JSON, but neither an array nor a {records:[...]} wrapper — reaches the route handler's
  // own body-shape check (a well-formed but structurally invalid request), unlike a body-parser-
  // level parse failure which never reaches the handler (and so is never audited as an attempt).
  await importRequest(base, token, {}, "application/json");

  const entries = ingestionAuditRepository.all();
  assert.equal(entries.length, 2, "one audit row per attempt, success or failure");
  const successEntry = entries.find(e => e.httpStatus === 200)!;
  assert.ok(successEntry, "the successful attempt must be recorded");
  assert.equal(successEntry.recordsReceived, 1);
  assert.equal(successEntry.recordsAccepted, 1);
  assert.equal(successEntry.errorCode, null);
  const failedEntry = entries.find(e => e.httpStatus !== 200)!;
  assert.ok(failedEntry, "the failed attempt must also be recorded");
  assert.ok(failedEntry.errorCode);

  const serialized = JSON.stringify(entries);
  assert.ok(!serialized.includes(token), "the audit log must never contain the partner's bearer token");
  assert.ok(!serialized.includes("Al Mouj"), "the audit log must never contain any submitted record field");
  assert.deepEqual(Object.keys(entries[0]!).sort(), [
    "durationMs", "errorCode", "httpStatus", "id", "partnerId", "receivedAt",
    "recordsAccepted", "recordsReceived", "recordsRejected", "recordsUpdated", "requestId"
  ].sort());
});

// -------------------------------------------------------------------------------------------
// Section 2: partner token rotation
// -------------------------------------------------------------------------------------------
test("PartnerRepository.rotateToken: the old token stops authenticating immediately and exactly one new token authenticates", async () => {
  const repo = new MemoryPartnerRepository();
  const { token: oldToken } = await repo.create({ partnerId: "gulf-realty-om", partnerName: "Gulf Realty Oman", feedType: "json", sourceType: "partner_feed" });
  assert.ok(await repo.authenticate(oldToken));

  const { token: newToken } = await repo.rotateToken("gulf-realty-om");
  assert.notEqual(newToken, oldToken);
  assert.equal(await repo.authenticate(oldToken), null, "the old token must stop authenticating immediately after rotation");
  const authenticated = await repo.authenticate(newToken);
  assert.equal(authenticated?.partnerId, "gulf-realty-om", "the new token must authenticate as the same partner");

  await assert.rejects(() => repo.rotateToken("no-such-partner"));
});

test("PartnerRepository.rotateToken: a rotated partner's token also stops accepting ingestion over HTTP, and the new token works", async t => {
  const { server, base, partnerRepository } = await startApp();
  t.after(() => { server.closeAllConnections(); server.close(); });
  const { token: oldToken } = await partnerRepository.create({ partnerId: "gulf-realty-om", partnerName: "Gulf Realty Oman", feedType: "json", sourceType: "partner_feed" });
  const { token: newToken } = await partnerRepository.rotateToken("gulf-realty-om");

  const row = {
    governorate: "Muscat", area: "Al Mouj", propertyType: "apartment", bedrooms: 2, bathrooms: 2, sizeSqm: 130,
    transactionType: "sale", priceOMR: 120000, furnished: "furnished", sourceType: "partner_feed",
    sourceName: "Gulf Realty Oman", sourceRecordId: "rot-1", observedAt: new Date().toISOString()
  };
  assert.equal((await importRequest(base, oldToken, [row])).status, 401, "the rotated-away old token must be rejected");
  assert.equal((await importRequest(base, newToken, [row])).status, 200, "the newly issued token must authenticate and ingest normally");
});

// -------------------------------------------------------------------------------------------
// Section 1: partner onboarding package generation
// -------------------------------------------------------------------------------------------
test("buildPartnerOnboardingPackage: never includes the partner's real token, and covers every required section", async () => {
  const repo = new MemoryPartnerRepository();
  const { partner, token } = await repo.create({ partnerId: "gulf-realty-om", partnerName: "Gulf Realty Oman", feedType: "json", sourceType: "partner_feed" });
  const pkg = buildPartnerOnboardingPackage(partner, { baseUrl: "https://example-rafid-deployment.test" });

  assert.deepEqual(Object.keys(pkg).sort(), ["README.md", "curl-example.txt", "sample.csv", "sample.json", "schema.json"].sort());
  const combined = Object.values(pkg).join("\n");
  assert.ok(!combined.includes(token), "the generated package must never contain the partner's real, plaintext token");

  const readme = pkg["README.md"];
  for (const mustMention of [
    "Endpoint", "X-Partner-Token", "CSV", "JSON", "Allowed property types", "Allowed transaction types",
    "rentPeriod", "observedAt", "Maximum batch size", "validation errors", "idempoten"
  ]) {
    assert.ok(readme.toLowerCase().includes(mustMention.toLowerCase()), `README.md must document "${mustMention}"`);
  }
  assert.ok(readme.includes("<PARTNER_TOKEN>"), "the README must use a clearly-labeled placeholder in place of a real token");

  const schema = JSON.parse(pkg["schema.json"]);
  assert.ok(Array.isArray(schema.errorCodes) && schema.errorCodes.includes("DUPLICATE_RECORD"));
  const sampleJson = JSON.parse(pkg["sample.json"]);
  assert.ok(Array.isArray(sampleJson.records) && sampleJson.records.length > 0);
});

test("admin.ts partner:package CLI: writes the onboarding package to disk under partner-packages/<partnerId>/ with no real token present", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const dbUrl = process.env.TEST_DATABASE_URL!;
  const repo = new PostgresPropertyMarketRepository(dbUrl);
  await repo.migrate();
  const partnerRepository = new PostgresPartnerRepository(repo.pool);
  const partnerId = `pg-pkg-partner-${randomUUID().slice(0, 8)}`;
  const { token } = await partnerRepository.create({ partnerId, partnerName: "PG Package Partner", feedType: "json", sourceType: "partner_feed" });
  try {
    const output = execFileSync(process.execPath, ["--import", "tsx", "src/admin.ts", "partner:package", partnerId], {
      env: { ...process.env, DATABASE_URL: dbUrl }, encoding: "utf8", windowsHide: true, cwd: process.cwd()
    });
    const result = JSON.parse(output);
    assert.equal(result.partnerId, partnerId);
    const readme = readFileSync(`${result.outputDirectory}/README.md`, "utf8");
    assert.ok(!readme.includes(token), "the on-disk README must never contain the partner's real token");
  } finally {
    rmSync(`partner-packages/${partnerId}`, { recursive: true, force: true });
    await repo.close();
  }
});

// -------------------------------------------------------------------------------------------
// PostgreSQL integration (dedicated test database required — same opt-in pattern as
// tests/market-data.test.ts's PostgreSQL integration test: skipped unless TEST_DATABASE_URL is
// set).
// -------------------------------------------------------------------------------------------
const dbUrl = process.env.TEST_DATABASE_URL;
test("PostgreSQL Partner Data Feed integration: migration v2, PostgresPartnerRepository, and the admin CLI's partner:create/list/enable/disable", { skip: !dbUrl }, async t => {
  const repo = new PostgresPropertyMarketRepository(dbUrl!);
  t.after(async () => { await repo.close(); });
  await repo.migrate();
  await repo.ready();
  const partnerRepository = new PostgresPartnerRepository(repo.pool);
  const partnerId = `pg-test-partner-${randomUUID().slice(0, 8)}`;

  await t.test("create issues a one-time token whose digest authenticates it; list/setEnabled/recordImportStats round-trip", async () => {
    const { partner, token } = await partnerRepository.create({ partnerId, partnerName: "PG Test Partner", feedType: "json", sourceType: "partner_feed" });
    assert.equal(partner.partnerId, partnerId);
    assert.ok((await partnerRepository.authenticate(token))?.partnerId === partnerId);
    assert.ok((await partnerRepository.list()).some(p => p.partnerId === partnerId));

    await partnerRepository.recordImportStats(partnerId, { received: 3, accepted: 2, rejected: 1, updated: 0, latestObservedAt: new Date().toISOString() });
    const [withStats] = (await partnerRepository.listWithStats(30)).filter(p => p.partnerId === partnerId);
    assert.equal(withStats!.recordsReceived, 3);
    assert.equal(withStats!.recordsAccepted, 2);
    assert.equal(withStats!.stale, false);

    await partnerRepository.setEnabled(partnerId, false);
    assert.equal(await partnerRepository.authenticate(token), null, "a disabled partner's token must stop authenticating");
    await partnerRepository.setEnabled(partnerId, true);
  });

  await t.test("rotateToken invalidates the old token immediately and the new one authenticates; getPartnerQualitySummary aggregates via SQL", async () => {
    const { partner, token: originalToken } = await partnerRepository.create({ partnerId: `${partnerId}-rot`, partnerName: "PG Rotate Partner", feedType: "json", sourceType: "partner_feed" });
    const { token: rotatedToken } = await partnerRepository.rotateToken(partner.partnerId);
    assert.equal(await partnerRepository.authenticate(originalToken), null);
    assert.equal((await partnerRepository.authenticate(rotatedToken))?.partnerId, partner.partnerId);

    await repo.upsertMarketRecords([{
      governorate: "Muscat", wilayat: "Muscat", area: "Al Mouj", normalizedArea: "al mouj", propertyType: "apartment",
      bedrooms: null, bathrooms: null, sizeSqm: 130, transactionType: "rental", priceOMR: 780, rentPeriod: "monthly",
      furnished: null, sourceType: "partner_feed", sourceName: "PG Rotate Partner", sourceRecordId: "q-1",
      sourceUrl: null, observedAt: new Date().toISOString(), metadata: {}, partnerId: partner.partnerId, dataQualityScore: 0.4
    }]);
    const quality = await repo.getPartnerQualitySummary(partner.partnerId);
    assert.equal(quality.recordCount, 1);
    assert.equal(quality.missingBedroomRate, 100);
    assert.equal(quality.percentageBelow50, 100);
  });

  await t.test("upsertMarketRecords persists partner_id and data_quality_score, visible via findRentalComparables", async () => {
    const marker = randomUUID();
    await repo.upsertMarketRecords([{
      governorate: "Muscat", wilayat: "Muscat", area: "Al Mouj", normalizedArea: "al mouj", propertyType: "apartment",
      bedrooms: 2, bathrooms: 2, sizeSqm: 130, transactionType: "rental", priceOMR: 780, rentPeriod: "monthly",
      furnished: "furnished", sourceType: "partner_feed", sourceName: `pg-partner-test-${marker}`, sourceRecordId: "1",
      sourceUrl: null, observedAt: new Date().toISOString(), metadata: {}, partnerId, dataQualityScore: 0.87
    }]);
    const rentals = await repo.findRentalComparables({ normalizedArea: "al mouj", propertyType: "apartment", transactionType: "rental", maxAgeDays: 30 });
    const stored = rentals.find(r => r.sourceName === `pg-partner-test-${marker}`);
    assert.ok(stored);
    assert.equal(stored!.partnerId, partnerId);
    assert.equal(stored!.dataQualityScore, 0.87);
    const status = await repo.getAggregateStatus();
    assert.ok(status.records >= 1 && status.sourceTypes.includes("partner_feed"));
  });

  await t.test("admin CLI: partner:create issues a token, partner:list/enable/disable round-trip against the live database", async () => {
    const cliPartnerId = `pg-cli-partner-${randomUUID().slice(0, 8)}`;
    const created = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "src/admin.ts", "partner:create", cliPartnerId, "CLI Test Partner", "csv", "partner_feed"], {
      env: { ...process.env, DATABASE_URL: dbUrl }, encoding: "utf8", windowsHide: true
    }));
    assert.equal(created.partner.partnerId, cliPartnerId);
    assert.ok(created.token.startsWith("rafid_partner_"));

    const listed = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "src/admin.ts", "partner:list"], {
      env: { ...process.env, DATABASE_URL: dbUrl }, encoding: "utf8", windowsHide: true
    }));
    assert.ok(listed.some((p: { partnerId: string }) => p.partnerId === cliPartnerId));

    execFileSync(process.execPath, ["--import", "tsx", "src/admin.ts", "partner:disable", cliPartnerId], { env: { ...process.env, DATABASE_URL: dbUrl }, encoding: "utf8", windowsHide: true });
    const disabled = await partnerRepository.findById(cliPartnerId);
    assert.equal(disabled?.enabled, false);
  });

  await t.test("npm-equivalent market:import CLI attributes a bulk import to an enabled partner by id, and refuses a disabled one", async () => {
    const bulkPartnerId = `pg-bulk-partner-${randomUUID().slice(0, 8)}`;
    await partnerRepository.create({ partnerId: bulkPartnerId, partnerName: "Bulk CLI Partner", feedType: "csv", sourceType: "partner_feed" });

    const output = execFileSync(process.execPath, ["--import", "tsx", "src/marketImportCli.ts", "data/example-partner-feed.csv", bulkPartnerId], {
      env: { ...process.env, DATABASE_URL: dbUrl }, encoding: "utf8", windowsHide: true
    });
    const result = JSON.parse(output);
    assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
    assert.ok(result.imported + result.updated >= 5);

    // `partnerId` (the outer describe's partner) was disabled by the earlier subtest — a bulk
    // import attributed to a disabled partner must fail loudly, never silently import unattributed.
    assert.throws(() => execFileSync(process.execPath, ["--import", "tsx", "src/marketImportCli.ts", "data/example-partner-feed.csv", partnerId], {
      env: { ...process.env, DATABASE_URL: dbUrl }, encoding: "utf8", windowsHide: true
    }), /Command failed/);
  });
});
