import assert from "node:assert/strict";
import { test } from "node:test";
import { MemoryPropertyMarketRepository } from "../src/domain/oman/marketRepository.js";
import { MemoryPartnerRepository, type PropertyDataPartner } from "../src/domain/oman/partners.js";
import { MemoryPartnerIngestionAuditRepository } from "../src/domain/oman/partnerAudit.js";
import { MemoryPartnerFeedCredentialRepository, type SecretProvider } from "../src/domain/oman/partnerFeedCredentials.js";
import type { HostResolver } from "../src/domain/oman/feedSecurity.js";
import { PartnerFeedRunner, type PartnerFeedLogEvent } from "../src/domain/oman/partnerFeedRunner.js";

/**
 * Production Feed Runner (Section 11): every test here uses mock HTTP only — a fake `fetchImpl`
 * and a fake `HostResolver` are injected into `PartnerFeedRunner`, exactly like every other
 * network-touching module in this codebase (mirrors tests/ncsi*.test.ts's own `fetchImpl`
 * injection pattern). Nothing here opens a real socket, resolves real DNS, or waits on a real
 * timer (a no-op `delay` skips real backoff waits).
 */

const noopDelay = async () => {};

function fakeSecretProvider(secrets: Record<string, string>): SecretProvider {
  return { name: "fake", async getSecret(ref) { return secrets[ref] ?? null; } };
}

/** A resolver that answers by an explicit hostname -> address map, throwing for anything
 *  unlisted — every SSRF test states exactly which hostnames it expects to be resolved. */
function fakeResolver(map: Record<string, string>): HostResolver {
  return { async resolve(hostname) {
    const address = map[hostname];
    if (!address) throw new Error(`fakeResolver: no address configured for "${hostname}"`);
    return [address];
  } };
}

function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...extraHeaders } });
}

function hangingFetch(): typeof fetch {
  return (_input, init) => new Promise((_resolve, reject) => {
    const signal = init?.signal;
    signal?.addEventListener("abort", () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      reject(error);
    });
  });
}

function networkErrorFetch(message = "connect ECONNREFUSED"): typeof fetch {
  return () => Promise.reject(new Error(message));
}

/** One-fetchImpl-per-call-count wrapper so a test can assert exactly how many times the network
 *  layer was actually invoked (e.g. "401 must not retry", "3 attempts on 503, then give up"). */
function countingFetch(impl: typeof fetch): { fetchImpl: typeof fetch; calls: () => number } {
  let count = 0;
  const fetchImpl: typeof fetch = (input, init) => { count++; return impl(input, init); };
  return { fetchImpl, calls: () => count };
}

const validJsonRow = {
  governorate: "Muscat", wilayat: "Muscat", area: "Al Mouj", propertyType: "apartment",
  bedrooms: 2, bathrooms: 2, sizeSqm: 130, transactionType: "sale", priceOMR: 120000,
  furnished: "furnished", sourceType: "partner_feed", sourceName: "ignored-overwritten-by-attribution",
  sourceRecordId: "feed-row-1", observedAt: new Date().toISOString()
};

async function makePartner(
  partnerRepository: MemoryPartnerRepository,
  overrides: { feedUrl?: string | null; feedFormat?: "json" | "csv" | null; scheduleEnabled?: boolean; scheduleIntervalMinutes?: number | null } = {}
): Promise<PropertyDataPartner> {
  const partnerId = `partner-${Math.random().toString(36).slice(2, 10)}`;
  await partnerRepository.create({ partnerId, partnerName: "Test Partner", feedType: "http_feed", sourceType: "partner_feed" });
  return partnerRepository.setFeedConfig(partnerId, {
    feedUrl: overrides.feedUrl ?? "https://partner-feed.example.com/feed.json",
    feedFormat: overrides.feedFormat ?? "json",
    scheduleEnabled: overrides.scheduleEnabled ?? true,
    scheduleIntervalMinutes: overrides.scheduleIntervalMinutes ?? 60
  });
}

interface Harness {
  runner: PartnerFeedRunner;
  partnerRepository: MemoryPartnerRepository;
  marketRepository: MemoryPropertyMarketRepository;
  ingestionAuditRepository: MemoryPartnerIngestionAuditRepository;
  credentialRepository: MemoryPartnerFeedCredentialRepository;
  logEvents: PartnerFeedLogEvent[];
}

function buildHarness(overrides: {
  fetchImpl?: typeof fetch;
  resolver?: HostResolver;
  secretProvider?: SecretProvider;
  maxResponseBytes?: number;
  timeoutMs?: number;
  maxAttempts?: number;
} = {}): Harness {
  const partnerRepository = new MemoryPartnerRepository();
  const marketRepository = new MemoryPropertyMarketRepository();
  const ingestionAuditRepository = new MemoryPartnerIngestionAuditRepository();
  const credentialRepository = new MemoryPartnerFeedCredentialRepository();
  const logEvents: PartnerFeedLogEvent[] = [];
  const runner = new PartnerFeedRunner({
    partnerRepository, marketRepository, ingestionAuditRepository, credentialRepository,
    secretProvider: overrides.secretProvider ?? fakeSecretProvider({}),
    fetchImpl: overrides.fetchImpl,
    resolver: overrides.resolver ?? fakeResolver({ "partner-feed.example.com": "93.184.216.34" }),
    maxResponseBytes: overrides.maxResponseBytes,
    timeoutMs: overrides.timeoutMs ?? 200,
    maxAttempts: overrides.maxAttempts ?? 3,
    delay: noopDelay,
    logger: event => logEvents.push(event)
  });
  return { runner, partnerRepository, marketRepository, ingestionAuditRepository, credentialRepository, logEvents };
}

// -------------------------------------------------------------------------------------------
// Successful runs
// -------------------------------------------------------------------------------------------

test("PartnerFeedRunner: a successful JSON feed is fetched, parsed, ingested through the real importMarketRecords(), and audited", async () => {
  const { fetchImpl } = countingFetch(async () => jsonResponse(200, [validJsonRow]));
  const h = buildHarness({ fetchImpl });
  const partner = await makePartner(h.partnerRepository);

  const outcome = await h.runner.runPartnerFeed(partner.partnerId);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.httpStatus, 200);
  assert.equal(outcome.recordsReceived, 1);
  assert.equal(outcome.recordsAccepted, 1);
  assert.equal(outcome.recordsRejected, 0);
  assert.ok(outcome.auditId);
  assert.equal(outcome.errorCode, null);

  const status = await h.marketRepository.getAggregateStatus();
  assert.equal(status.records, 1);

  const updated = await h.partnerRepository.findById(partner.partnerId);
  assert.ok(updated?.lastSuccessfulRunAt);
  assert.equal(updated?.consecutiveFailures, 0);
});

test("PartnerFeedRunner: a successful CSV feed is fetched, parsed and ingested identically to JSON", async () => {
  const csvBody = "governorate,area,propertyType,bedrooms,bathrooms,sizeSqm,transactionType,priceOMR,furnished,sourceType,sourceName,sourceRecordId,observedAt\n" +
    `Muscat,Al Mouj,apartment,2,2,130,sale,120000,furnished,partner_feed,ignored,feed-row-1,${new Date().toISOString()}\n`;
  const { fetchImpl } = countingFetch(async () => new Response(csvBody, { status: 200, headers: { "content-type": "text/csv" } }));
  const h = buildHarness({ fetchImpl });
  const partner = await makePartner(h.partnerRepository, { feedFormat: "csv" });

  const outcome = await h.runner.runPartnerFeed(partner.partnerId);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.recordsAccepted, 1);
  assert.equal((await h.marketRepository.getAggregateStatus()).records, 1);
});

// -------------------------------------------------------------------------------------------
// Transport failures
// -------------------------------------------------------------------------------------------

test("PartnerFeedRunner: an HTTP timeout is reported as a failed run with errorCode TIMEOUT, never thrown", async () => {
  const h = buildHarness({ fetchImpl: hangingFetch(), timeoutMs: 30 });
  const partner = await makePartner(h.partnerRepository);
  const outcome = await h.runner.runPartnerFeed(partner.partnerId);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.errorCode, "TIMEOUT");
  assert.equal(outcome.httpStatus, null);
});

test("PartnerFeedRunner: HTTP 503 is retried up to maxAttempts with bounded backoff, succeeding once the server recovers", async () => {
  let call = 0;
  const { fetchImpl, calls } = countingFetch(async () => {
    call++;
    return call < 3 ? new Response("service unavailable", { status: 503 }) : jsonResponse(200, [validJsonRow]);
  });
  const h = buildHarness({ fetchImpl, maxAttempts: 3 });
  const partner = await makePartner(h.partnerRepository);
  const outcome = await h.runner.runPartnerFeed(partner.partnerId);
  assert.equal(calls(), 3, "must have retried twice before succeeding on the 3rd attempt");
  assert.equal(outcome.ok, true);
});

test("PartnerFeedRunner: HTTP 503 that never recovers is retried exactly maxAttempts times, then reported as a failure", async () => {
  const { fetchImpl, calls } = countingFetch(async () => new Response("still down", { status: 503 }));
  const h = buildHarness({ fetchImpl, maxAttempts: 3 });
  const partner = await makePartner(h.partnerRepository);
  const outcome = await h.runner.runPartnerFeed(partner.partnerId);
  assert.equal(calls(), 3, "exactly 3 attempts (Section 4: Maximum 3 attempts) — never more");
  assert.equal(outcome.ok, false);
  assert.equal(outcome.errorCode, "HTTP_503");
});

test("PartnerFeedRunner: HTTP 401 is never retried — exactly one attempt, immediate failure", async () => {
  const { fetchImpl, calls } = countingFetch(async () => new Response("unauthorized", { status: 401 }));
  const h = buildHarness({ fetchImpl, maxAttempts: 3 });
  const partner = await makePartner(h.partnerRepository);
  const outcome = await h.runner.runPartnerFeed(partner.partnerId);
  assert.equal(calls(), 1, "a 401 must never be retried (Section 4: Do NOT retry 401)");
  assert.equal(outcome.ok, false);
  assert.equal(outcome.errorCode, "HTTP_401");
});

test("PartnerFeedRunner: an oversized response is rejected without ever being fully buffered", async () => {
  const bigBody = JSON.stringify([validJsonRow, validJsonRow, validJsonRow, validJsonRow, validJsonRow]);
  assert.ok(bigBody.length > 100);
  const { fetchImpl } = countingFetch(async () => jsonResponse(200, [validJsonRow, validJsonRow, validJsonRow, validJsonRow, validJsonRow]));
  const h = buildHarness({ fetchImpl, maxResponseBytes: 100 });
  const partner = await makePartner(h.partnerRepository);
  const outcome = await h.runner.runPartnerFeed(partner.partnerId);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.errorCode, "TOO_LARGE");
});

test("PartnerFeedRunner: an unexpected content type for the partner's configured feed format is rejected before parsing", async () => {
  const { fetchImpl } = countingFetch(async () => new Response(JSON.stringify([validJsonRow]), { status: 200, headers: { "content-type": "text/html" } }));
  const h = buildHarness({ fetchImpl });
  const partner = await makePartner(h.partnerRepository, { feedFormat: "json" });
  const outcome = await h.runner.runPartnerFeed(partner.partnerId);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.errorCode, "UNEXPECTED_CONTENT_TYPE");
});

test("PartnerFeedRunner: a malformed body that fails to parse is reported as PARSE_ERROR", async () => {
  const { fetchImpl } = countingFetch(async () => new Response("{not valid json", { status: 200, headers: { "content-type": "application/json" } }));
  const h = buildHarness({ fetchImpl });
  const partner = await makePartner(h.partnerRepository);
  const outcome = await h.runner.runPartnerFeed(partner.partnerId);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.errorCode, "PARSE_ERROR");
});

// -------------------------------------------------------------------------------------------
// SSRF protection (Section 3/11)
// -------------------------------------------------------------------------------------------

test("PartnerFeedRunner: a feed URL pointing at localhost is rejected before any network call is made", async () => {
  const { fetchImpl, calls } = countingFetch(async () => jsonResponse(200, [validJsonRow]));
  const h = buildHarness({ fetchImpl });
  const partner = await makePartner(h.partnerRepository, { feedUrl: "https://localhost/feed.json" });
  const outcome = await h.runner.runPartnerFeed(partner.partnerId);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.errorCode, "SSRF_REJECTED");
  assert.equal(calls(), 0, "must never reach the network for a blocked hostname");
});

test("PartnerFeedRunner: a feed hostname that resolves to a private IP address is rejected before any network call is made", async () => {
  const { fetchImpl, calls } = countingFetch(async () => jsonResponse(200, [validJsonRow]));
  const h = buildHarness({
    fetchImpl,
    resolver: fakeResolver({ "internal-feed.example.com": "10.1.2.3" })
  });
  const partner = await makePartner(h.partnerRepository, { feedUrl: "https://internal-feed.example.com/feed.json" });
  const outcome = await h.runner.runPartnerFeed(partner.partnerId);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.errorCode, "SSRF_REJECTED");
  assert.equal(calls(), 0, "must never reach the network once DNS resolution reveals a private IP");
});

test("PartnerFeedRunner: a redirect to a blocked host is never followed — the redirect target is re-validated and rejected", async () => {
  const { fetchImpl, calls } = countingFetch(async () => new Response(null, { status: 302, headers: { location: "https://localhost/evil" } }));
  const h = buildHarness({ fetchImpl });
  const partner = await makePartner(h.partnerRepository);
  const outcome = await h.runner.runPartnerFeed(partner.partnerId);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.errorCode, "SSRF_REJECTED");
  assert.equal(calls(), 1, "the initial (safe) host is fetched once, but the redirect target is never followed");
});

// -------------------------------------------------------------------------------------------
// Section 7: partner isolation
// -------------------------------------------------------------------------------------------

test("PartnerFeedRunner.runDueFeeds(): one partner's failure never stops another partner's feed from running", async () => {
  const partnerRepository = new MemoryPartnerRepository();
  const marketRepository = new MemoryPropertyMarketRepository();
  const ingestionAuditRepository = new MemoryPartnerIngestionAuditRepository();
  const credentialRepository = new MemoryPartnerFeedCredentialRepository();

  const failing = await makePartner(partnerRepository, { feedUrl: "https://failing-feed.example.com/feed.json" });
  const healthy = await makePartner(partnerRepository, { feedUrl: "https://partner-feed.example.com/feed.json" });

  const fetchImpl: typeof fetch = async input => {
    const url = String(input);
    if (url.includes("failing-feed")) throw new Error("connect ECONNREFUSED");
    return jsonResponse(200, [validJsonRow]);
  };
  const runner = new PartnerFeedRunner({
    partnerRepository, marketRepository, ingestionAuditRepository, credentialRepository,
    secretProvider: fakeSecretProvider({}), fetchImpl,
    resolver: fakeResolver({ "failing-feed.example.com": "93.184.216.1", "partner-feed.example.com": "93.184.216.34" }),
    delay: noopDelay, maxAttempts: 1
  });

  const summary = await runner.runDueFeeds();
  assert.equal(summary.attempted, 2);
  assert.equal(summary.successful, 1);
  assert.equal(summary.failed, 1);
  const failingResult = summary.results.find(r => r.partnerId === failing.partnerId);
  const healthyResult = summary.results.find(r => r.partnerId === healthy.partnerId);
  assert.equal(failingResult?.ok, false);
  assert.equal(healthyResult?.ok, true);
});

// -------------------------------------------------------------------------------------------
// Idempotency (Section 8: existing upsert rules remain unchanged)
// -------------------------------------------------------------------------------------------

test("PartnerFeedRunner: re-fetching the same feed content twice is idempotent — the second run updates, never duplicates", async () => {
  const { fetchImpl } = countingFetch(async () => jsonResponse(200, [validJsonRow]));
  const h = buildHarness({ fetchImpl });
  const partner = await makePartner(h.partnerRepository);

  const first = await h.runner.runPartnerFeed(partner.partnerId);
  const second = await h.runner.runPartnerFeed(partner.partnerId);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.recordsUpdated, 1, "the second run's identical sourceRecordId must be treated as an update, not a new insert");
  assert.equal((await h.marketRepository.getAggregateStatus()).records, 1, "no duplicate record was created");
});

// -------------------------------------------------------------------------------------------
// Audit log (Section 3/6)
// -------------------------------------------------------------------------------------------

test("PartnerFeedRunner: exactly one audit row is written per attempt, with only safe fields and no secret", async () => {
  const h = buildHarness({ fetchImpl: countingFetch(async () => new Response("unauthorized", { status: 401 })).fetchImpl, maxAttempts: 1 });
  const partner = await makePartner(h.partnerRepository);
  await h.runner.runPartnerFeed(partner.partnerId);

  const entries = (h.ingestionAuditRepository as MemoryPartnerIngestionAuditRepository).all();
  assert.equal(entries.length, 1);
  const entry = entries[0]!;
  assert.equal(entry.partnerId, partner.partnerId);
  assert.equal(entry.httpStatus, 401);
  assert.equal(entry.errorCode, "HTTP_401");
  assert.deepEqual(Object.keys(entry).sort(), [
    "durationMs", "errorCode", "httpStatus", "id", "partnerId", "receivedAt",
    "recordsAccepted", "recordsRejected", "recordsReceived", "recordsUpdated", "requestId"
  ].sort());
});

// -------------------------------------------------------------------------------------------
// Section 9: feed health transitions
// -------------------------------------------------------------------------------------------

test("PartnerFeedRunner: consecutiveFailures increments on each failed run and resets to 0 on the next success", async () => {
  const h = buildHarness({ fetchImpl: networkErrorFetch(), maxAttempts: 1 });
  const partner = await makePartner(h.partnerRepository);

  await h.runner.runPartnerFeed(partner.partnerId);
  await h.runner.runPartnerFeed(partner.partnerId);
  let updated = await h.partnerRepository.findById(partner.partnerId);
  assert.equal(updated?.consecutiveFailures, 2);

  await h.runner.runPartnerFeed(partner.partnerId);
  updated = await h.partnerRepository.findById(partner.partnerId);
  assert.equal(updated?.consecutiveFailures, 3, "3 consecutive failures -> computeFeedHealth() reports degraded");

  // Now let the feed succeed — consecutiveFailures must reset, not merely decrement. Reuses the
  // SAME repositories as `h` (so the transition is observed on the same partner state) with a
  // fresh runner wired to a succeeding fetchImpl.
  const successRunner = new PartnerFeedRunner({
    partnerRepository: h.partnerRepository, marketRepository: h.marketRepository,
    ingestionAuditRepository: h.ingestionAuditRepository, credentialRepository: h.credentialRepository,
    secretProvider: fakeSecretProvider({}), fetchImpl: countingFetch(async () => jsonResponse(200, [validJsonRow])).fetchImpl,
    resolver: fakeResolver({ "partner-feed.example.com": "93.184.216.34" }), delay: noopDelay
  });
  await successRunner.runPartnerFeed(partner.partnerId);
  updated = await h.partnerRepository.findById(partner.partnerId);
  assert.equal(updated?.consecutiveFailures, 0, "a successful run must reset consecutiveFailures to 0, not just decrement it");
  assert.ok(updated?.lastSuccessfulRunAt);
});

// -------------------------------------------------------------------------------------------
// Secret redaction (Section 8/10)
// -------------------------------------------------------------------------------------------

test("PartnerFeedRunner: a resolved feed credential secret never appears in logs, the audit trail, or the returned outcome", async () => {
  const secretValue = "super-secret-token-should-never-leak-XyZ123";
  let capturedAuthHeader: string | null = null;
  const { fetchImpl } = countingFetch(async (_input, init) => {
    capturedAuthHeader = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
    return jsonResponse(200, [validJsonRow]);
  });
  const h = buildHarness({ fetchImpl, secretProvider: fakeSecretProvider({ RAFID_TEST_PARTNER_TOKEN: secretValue }) });
  const partner = await makePartner(h.partnerRepository);
  await h.credentialRepository.setCredential(partner.partnerId, { authType: "bearer", secretRef: "RAFID_TEST_PARTNER_TOKEN" });

  const outcome = await h.runner.runPartnerFeed(partner.partnerId);

  assert.equal(capturedAuthHeader, `Bearer ${secretValue}`, "sanity check: the secret WAS actually sent to the partner's feed endpoint");
  assert.ok(outcome.ok);
  assert.ok(!JSON.stringify(outcome).includes(secretValue), "the returned outcome must never contain the secret");
  assert.ok(!JSON.stringify(h.logEvents).includes(secretValue), "no logged event may contain the secret");
  assert.ok(!JSON.stringify((h.ingestionAuditRepository as MemoryPartnerIngestionAuditRepository).all()).includes(secretValue), "no audit row may contain the secret");
});

test("PartnerFeedRunner: a misconfigured credential (missing secret) is a safe, reportable failure, never a leaked or thrown raw error", async () => {
  const { fetchImpl, calls } = countingFetch(async () => jsonResponse(200, [validJsonRow]));
  const h = buildHarness({ fetchImpl, secretProvider: fakeSecretProvider({}) });
  const partner = await makePartner(h.partnerRepository);
  await h.credentialRepository.setCredential(partner.partnerId, { authType: "bearer", secretRef: "RAFID_TEST_PARTNER_TOKEN_UNSET" });

  const outcome = await h.runner.runPartnerFeed(partner.partnerId);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.errorCode, "CREDENTIAL_ERROR");
  assert.equal(calls(), 0, "the feed must never be fetched when its credential cannot be resolved");
});

// -------------------------------------------------------------------------------------------
// Operator-misconfiguration guard checks (thrown, not recorded as a feed-run attempt — see
// partnerFeedRunner.ts's doc comment for why these three are structurally unreachable from a
// real scheduled pass and are treated as loud operator errors instead).
// -------------------------------------------------------------------------------------------

test("PartnerFeedRunner: running a feed for an unknown, disabled, or unconfigured partner throws rather than recording a silent audit failure", async () => {
  const h = buildHarness();
  await assert.rejects(() => h.runner.runPartnerFeed("does-not-exist"), /not found/);

  const disabled = await makePartner(h.partnerRepository);
  await h.partnerRepository.setEnabled(disabled.partnerId, false);
  await assert.rejects(() => h.runner.runPartnerFeed(disabled.partnerId), /disabled/);

  const unconfiguredId = "unconfigured-partner";
  await h.partnerRepository.create({ partnerId: unconfiguredId, partnerName: "No Feed Yet", feedType: "http_feed", sourceType: "partner_feed" });
  await assert.rejects(() => h.runner.runPartnerFeed(unconfiguredId), /no feed configured/);

  assert.equal((h.ingestionAuditRepository as MemoryPartnerIngestionAuditRepository).all().length, 0, "none of these three guard failures should ever write an audit row");
});
