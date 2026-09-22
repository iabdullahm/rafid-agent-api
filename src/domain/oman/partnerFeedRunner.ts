import { randomUUID } from "node:crypto";
import type { HostResolver } from "./feedSecurity.js";
import { FeedUrlRejectedError } from "./feedSecurity.js";
import { FeedFetchError, type FeedFetchErrorKind } from "./safeFeedFetch.js";
import { fetchFeedWithRetry } from "./feedRetry.js";
import {
  resolveFeedAuthHeaders,
  type PartnerFeedCredentialRepository, type SecretProvider
} from "./partnerFeedCredentials.js";
import { isFeedDue, type PartnerRepository, type PropertyDataPartner } from "./partners.js";
import type { PartnerIngestionAuditRepository } from "./partnerAudit.js";
import type { PropertyMarketRepository } from "./marketRepository.js";
import { importMarketRecords, parseCsv, parseJsonRows } from "./importPipeline.js";

/**
 * Production Feed Runner (Section 2): `PartnerFeedRunner` is the single place a scheduled partner
 * feed is fetched, parsed and ingested. It deliberately owns NONE of the validation/upsert logic
 * itself — every accepted row still goes through the exact same `importMarketRecords()` the manual
 * HTTP ingestion endpoint (src/api/marketDataRoutes.ts) uses (Section 2: "Do not duplicate
 * ingestion logic"), and every network call goes through the SSRF-checked, size/timeout-bounded,
 * retrying `fetchFeedWithRetry()` (feedRetry.ts -> safeFeedFetch.ts -> feedSecurity.ts). This class
 * is the orchestration layer on top of those pieces: it decides WHICH partners are due
 * (`runDueFeeds`), resolves credentials just-in-time, maps failures to a safe error taxonomy, and
 * writes exactly one `PartnerIngestionAudit` row plus one `recordFeedAttempt()` call per attempt —
 * mirroring the "one row per attempt" discipline the manual ingestion route already established.
 */

export interface PartnerFeedLogEvent {
  partnerId: string;
  requestId: string;
  /** How many HTTP attempts this run ultimately made (1 unless a retryable failure occurred) —
   *  never per-byte or per-record detail, just the count. */
  attempt: number;
  status: string;
  httpStatus: number | null;
  durationMs: number;
  recordsReceived: number;
  recordsAccepted: number;
  recordsRejected: number;
}

/** Section 10: "emit safe structured logs ... No raw records. No tokens. No auth headers." The
 *  default implementation writes one JSON line per completed run to stdout — every field on
 *  `PartnerFeedLogEvent` is already safe by construction (it has no room for a header value, a
 *  token, or a record body), so there is nothing to redact here. */
export type PartnerFeedLogger = (event: PartnerFeedLogEvent) => void;
export const defaultPartnerFeedLogger: PartnerFeedLogger = event => {
  process.stdout.write(JSON.stringify(event) + "\n");
};

export interface PartnerFeedRunnerOptions {
  partnerRepository: PartnerRepository;
  marketRepository: PropertyMarketRepository;
  ingestionAuditRepository: PartnerIngestionAuditRepository;
  credentialRepository: PartnerFeedCredentialRepository;
  secretProvider: SecretProvider;
  /** Default 15s — generous enough for a real partner's feed endpoint, short enough that one slow
   *  partner can never meaningfully delay a scheduling pass over several partners. */
  timeoutMs?: number;
  /** Default 5 MB — deliberately well under importPipeline.ts's MAX_IMPORT_FILE_BYTES (10 MB), so
   *  a scheduled feed response is never the largest thing this process has ever had to parse. */
  maxResponseBytes?: number;
  maxAttempts?: number;
  hostAllowlist?: readonly string[];
  resolver?: HostResolver;
  fetchImpl?: typeof fetch;
  logger?: PartnerFeedLogger;
  now?: () => Date;
  /** Injectable retry backoff — tests supply a no-op so a 503-retry test doesn't actually wait
   *  seconds; production leaves this unset and gets fetchFeedWithRetry's real bounded backoff. */
  delay?: (attempt: number) => Promise<void>;
}

export interface PartnerFeedRunOutcome {
  partnerId: string;
  ok: boolean;
  httpStatus: number | null;
  recordsReceived: number;
  recordsAccepted: number;
  recordsRejected: number;
  recordsUpdated: number;
  durationMs: number;
  auditId: string | null;
  errorCode: string | null;
}

function defaultRetryDelay(attempt: number): Promise<void> {
  const ms = Math.min(200 * 2 ** (attempt - 1), 4000);
  return new Promise(resolve => setTimeout(resolve, ms));
}

function feedFetchErrorCode(kind: FeedFetchErrorKind): string {
  switch (kind) {
    case "timeout": return "TIMEOUT";
    case "network": return "NETWORK_ERROR";
    case "too_large": return "TOO_LARGE";
    case "too_many_redirects": return "TOO_MANY_REDIRECTS";
    case "bad_redirect": return "BAD_REDIRECT";
    default: return "FETCH_ERROR";
  }
}

/** Lenient by design: only rejects when a Content-Type header IS present and clearly doesn't match
 *  the partner's configured feed format — a partner's server that omits or mislabels the header
 *  entirely (common with lightly-configured static file hosts) is not punished for it, since the
 *  parser itself (parseJsonRows/parseCsv) is the real, authoritative check on the body's shape. */
function contentTypeMatches(contentType: string | null, feedFormat: "json" | "csv"): boolean {
  if (!contentType) return true;
  const ct = contentType.toLowerCase();
  if (feedFormat === "json") return ct.includes("json");
  return ct.includes("csv") || ct.includes("text/plain") || ct.includes("application/octet-stream");
}

export class PartnerFeedRunner {
  constructor(private readonly options: PartnerFeedRunnerOptions) {}

  /**
   * Runs one scheduled feed attempt for a single partner. Throws a plain `Error` — no audit row,
   * no `recordFeedAttempt()` call — only for the three conditions that mean this call itself is
   * misconfigured (partner not found / disabled / no feed configured): `runDueFeeds()`'s own
   * selection filter (`enabled && isFeedDue()`, which already requires `feedUrl`) makes these
   * structurally unreachable during a real scheduled pass, so they can only happen via a direct,
   * mistaken CLI invocation — exactly the kind of loud, immediate failure an operator should see,
   * not a quiet audit-log entry. Every failure AFTER these guard checks (credential resolution,
   * SSRF rejection, network/timeout, non-2xx HTTP, content-type mismatch, parse error) IS a real
   * feed-run attempt: it gets its own audit row, a `recordFeedAttempt(false)` call, and a log line.
   */
  async runPartnerFeed(partnerId: string): Promise<PartnerFeedRunOutcome> {
    const { partnerRepository, credentialRepository, secretProvider } = this.options;
    const now = (this.options.now ?? (() => new Date()))();
    const requestId = randomUUID();
    const receivedAt = now.toISOString();
    const startedAt = performance.now();
    const logger = this.options.logger ?? defaultPartnerFeedLogger;

    const partner = await partnerRepository.findById(partnerId);
    if (!partner) throw new Error(`Partner "${partnerId}" not found`);
    if (!partner.enabled) throw new Error(`Partner "${partnerId}" is disabled`);
    if (!partner.feedUrl || !partner.feedFormat) throw new Error(`Partner "${partnerId}" has no feed configured (set feedUrl/feedFormat with "partner:set-feed" first)`);
    const feedUrl = partner.feedUrl;
    const feedFormat = partner.feedFormat;

    const recordFailure = async (errorCode: string, httpStatus: number | null, recordsReceived = 0): Promise<PartnerFeedRunOutcome> => {
      const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;
      const auditId = await this.options.ingestionAuditRepository.record({
        partnerId, requestId, receivedAt,
        recordsReceived, recordsAccepted: 0, recordsRejected: 0, recordsUpdated: 0,
        httpStatus: httpStatus ?? 0, durationMs, errorCode
      }).catch(() => null);
      await partnerRepository.recordFeedAttempt(partnerId, { success: false, at: receivedAt }).catch(() => {});
      logger({
        partnerId, requestId, attempt: attemptsUsed, status: errorCode, httpStatus,
        durationMs, recordsReceived, recordsAccepted: 0, recordsRejected: 0
      });
      return {
        partnerId, ok: false, httpStatus, recordsReceived, recordsAccepted: 0, recordsRejected: 0,
        recordsUpdated: 0, durationMs, auditId, errorCode
      };
    };

    let attemptsUsed = 1;

    // Section 1/8: credentials are resolved to actual header VALUES only here, held only in this
    // local variable, used once, and never logged, stored, or returned.
    let headers: Record<string, string>;
    try {
      const credential = await credentialRepository.getCredential(partnerId);
      headers = await resolveFeedAuthHeaders(credential, secretProvider);
    } catch {
      return recordFailure("CREDENTIAL_ERROR", null);
    }

    const maxAttempts = this.options.maxAttempts ?? 3;
    let fetchResult;
    try {
      fetchResult = await fetchFeedWithRetry(feedUrl, {
        timeoutMs: this.options.timeoutMs ?? 15_000,
        maxResponseBytes: this.options.maxResponseBytes ?? 5_000_000,
        maxAttempts,
        allowlist: this.options.hostAllowlist,
        resolver: this.options.resolver,
        fetchImpl: this.options.fetchImpl,
        headers,
        delay: async attempt => {
          attemptsUsed = attempt + 1;
          await (this.options.delay ?? defaultRetryDelay)(attempt);
        }
      });
    } catch (error) {
      if (error instanceof FeedUrlRejectedError) return recordFailure("SSRF_REJECTED", null);
      if (error instanceof FeedFetchError) return recordFailure(feedFetchErrorCode(error.kind), null);
      return recordFailure("FETCH_ERROR", null);
    }

    if (fetchResult.status < 200 || fetchResult.status >= 300) {
      return recordFailure(`HTTP_${fetchResult.status}`, fetchResult.status);
    }
    if (!contentTypeMatches(fetchResult.contentType, feedFormat)) {
      return recordFailure("UNEXPECTED_CONTENT_TYPE", fetchResult.status);
    }

    let rows: readonly unknown[];
    try {
      rows = feedFormat === "json" ? parseJsonRows(fetchResult.body) : parseCsv(fetchResult.body);
    } catch {
      return recordFailure("PARSE_ERROR", fetchResult.status);
    }

    // Section 2: the EXISTING ingestion service, never duplicated — attribution is forced from the
    // authenticated partner record itself, exactly like the manual HTTP ingestion route, never from
    // anything in the fetched feed body.
    const result = await importMarketRecords(rows, this.options.marketRepository, {
      partner: { partnerId: partner.partnerId, sourceType: partner.sourceType, sourceName: partner.partnerName }
    });

    const recordsAccepted = result.imported + result.updated;
    const durationMs = Math.round((performance.now() - startedAt) * 100) / 100;

    await partnerRepository.recordImportStats(partnerId, {
      received: result.totalRows, accepted: recordsAccepted, rejected: result.errors.length,
      updated: result.updated, latestObservedAt: result.latestObservedAt
    }).catch(() => {});

    const auditId = await this.options.ingestionAuditRepository.record({
      partnerId, requestId, receivedAt,
      recordsReceived: result.totalRows, recordsAccepted, recordsRejected: result.errors.length,
      recordsUpdated: result.updated, httpStatus: fetchResult.status, durationMs, errorCode: null
    }).catch(() => null);

    await partnerRepository.recordFeedAttempt(partnerId, { success: true, at: receivedAt }).catch(() => {});

    logger({
      partnerId, requestId, attempt: attemptsUsed, status: "success", httpStatus: fetchResult.status,
      durationMs, recordsReceived: result.totalRows, recordsAccepted, recordsRejected: result.errors.length
    });

    return {
      partnerId, ok: true, httpStatus: fetchResult.status, recordsReceived: result.totalRows,
      recordsAccepted, recordsRejected: result.errors.length, recordsUpdated: result.updated,
      durationMs, auditId, errorCode: null
    };
  }

  /**
   * Section 5/7: one scheduling pass — identify every enabled, due partner, run each one's feed,
   * and return a safe summary. A single partner's failure (however it fails) is caught here and
   * turned into a failed outcome for THAT partner only; it can never abort the loop or affect any
   * other partner's run (Section 7: "one partner failure must not stop another partner feed").
   */
  async runDueFeeds(): Promise<{ attempted: number; successful: number; failed: number; results: PartnerFeedRunOutcome[] }> {
    const now = (this.options.now ?? (() => new Date()))();
    const partners = await this.options.partnerRepository.list();
    const due = partners.filter((p: PropertyDataPartner) => p.enabled && isFeedDue(p, now));

    const results: PartnerFeedRunOutcome[] = [];
    for (const partner of due) {
      try {
        results.push(await this.runPartnerFeed(partner.partnerId));
      } catch (error) {
        results.push({
          partnerId: partner.partnerId, ok: false, httpStatus: null, recordsReceived: 0,
          recordsAccepted: 0, recordsRejected: 0, recordsUpdated: 0, durationMs: 0, auditId: null,
          errorCode: error instanceof Error ? `RUNNER_ERROR: ${error.message}` : "RUNNER_ERROR"
        });
      }
    }

    return {
      attempted: due.length,
      successful: results.filter(r => r.ok).length,
      failed: results.filter(r => !r.ok).length,
      results
    };
  }
}
