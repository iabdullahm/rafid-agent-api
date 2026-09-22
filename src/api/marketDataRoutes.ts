import express, { type Router, type RequestHandler } from "express";
import { ApiError } from "../utils/errors.js";
import { requireInternalAuth, requirePartnerAuth } from "../middleware/partnerAuth.js";
import { importMarketRecords, parseCsv, parseJsonRows, MAX_IMPORT_FILE_BYTES } from "../domain/oman/importPipeline.js";
import type { PropertyMarketRepository } from "../domain/oman/marketRepository.js";
import { computeFeedHealth, computeNextDueAt, type PartnerRepository, type PropertyDataPartner } from "../domain/oman/partners.js";
import type { PartnerIngestionAuditRepository } from "../domain/oman/partnerAudit.js";

/**
 * Partner Data Feed machine ingestion/administration routes (Section 3/4/8/9/11). Deliberately a
 * standalone Express Router, mounted directly by src/api/app.ts — NOT registered in
 * src/domain/capabilities.ts, so it is structurally unreachable from /agent.json, the tool
 * catalog, the remote MCP transport, or the x402 payment-gated route family (Section 15: "this is
 * infrastructure, not an agent capability"). None of these routes appear in discovery, pricing, or
 * tool-catalog output.
 *
 * Every route here answers with the same `{ success, data, meta }` / `{ success, error, meta }`
 * envelope the rest of the API uses, and errors are thrown as ApiError so they flow through
 * app.ts's existing shared error-handling middleware unchanged.
 */

export interface MarketDataRoutesOptions {
  marketRepository: PropertyMarketRepository;
  partnerRepository: PartnerRepository;
  /** Partner Operations layer (Section 3): the durable, per-request ingestion audit trail. Always
   *  required (unlike internalApiKey, which may be unset) — every ingestion attempt is recorded
   *  regardless of whether the internal monitoring endpoints are configured. */
  ingestionAuditRepository: PartnerIngestionAuditRepository;
  /** null when MARKET_DATA_INTERNAL_API_KEY is unset — the internal routes then always 503 rather
   *  than silently accepting no credential at all. */
  internalApiKey: string | null;
  /** A partner feed with no newer records than this many days old is reported `stale: true` by
   *  GET /api/v1/internal/market-data/partners (Section 5/11) — this never affects ingestion or
   *  analyze_oman_property, which are both entirely unaware of staleness at the partner level, and
   *  never marks any OTHER partner (or the market as a whole) stale. */
  staleDays: number;
  ingestionLimiter: RequestHandler;
}

function send(res: express.Response, data: unknown) {
  res.json({ success: true, data, meta: { requestId: res.locals.requestId } });
}

export function createMarketDataRoutes(options: MarketDataRoutesOptions): Router {
  const router = express.Router();
  const partnerAuth = requirePartnerAuth(options.partnerRepository);
  const internalAuth = requireInternalAuth(options.internalApiKey);
  // A csv/plain-text body is parsed as text; a JSON body is parsed as JSON. Only one of the two
  // middlewares actually parses on any given request — each checks the Content-Type itself (via
  // express's own `type` option) and calls next() untouched when it doesn't match, exactly like
  // app.ts's own parseJson does for the capability routes. Both share the same byte cap the CLI/
  // file-based import path already enforces (importPipeline.ts's MAX_IMPORT_FILE_BYTES) so an
  // HTTP submission can never exceed what a file-based import could.
  const parseCsvBody = express.text({ type: ["text/csv", "text/plain"], limit: MAX_IMPORT_FILE_BYTES });
  const parseJsonBody = express.json({ type: ["application/json"], limit: MAX_IMPORT_FILE_BYTES });

  // Section 4: the machine ingestion endpoint — never public, gated by a dedicated per-partner
  // bearer token (X-Partner-Token), never the normal customer X-API-Key.
  router.post(
    "/api/v1/market-data/import",
    options.ingestionLimiter,
    partnerAuth,
    parseCsvBody,
    parseJsonBody,
    async (req, res, next) => {
      // Section 3: exactly one audit row per attempt that reaches this point (i.e. past partner
      // auth) — success or failure. `partner` is always set here (requirePartnerAuth already ran),
      // so every code path below, including the catch, has what it needs to record.
      const startedAt = performance.now();
      const partner = res.locals.partner as PropertyDataPartner;
      const receivedAt = new Date().toISOString();
      const requestId = String(res.locals.requestId ?? "");
      const recordAttempt = (httpStatus: number, errorCode: string | null, counts: { received: number; accepted: number; rejected: number; updated: number }) => {
        // Best-effort: an audit-log write failure must never mask (or replace) the real response
        // already being sent to the partner.
        options.ingestionAuditRepository.record({
          partnerId: partner.partnerId, requestId, receivedAt,
          recordsReceived: counts.received, recordsAccepted: counts.accepted, recordsRejected: counts.rejected, recordsUpdated: counts.updated,
          httpStatus, durationMs: Math.round((performance.now() - startedAt) * 100) / 100, errorCode
        }).catch(() => {});
      };
      try {
        let rows: unknown[];
        if (typeof req.body === "string") {
          if (req.body.trim().length === 0) throw new ApiError(400, "INVALID_INPUT", "Request body is empty");
          rows = parseCsv(req.body);
        } else if (Array.isArray(req.body)) {
          rows = req.body;
        } else if (req.body && typeof req.body === "object" && Array.isArray((req.body as { records?: unknown }).records)) {
          rows = parseJsonRows(JSON.stringify(req.body));
        } else {
          throw new ApiError(400, "INVALID_INPUT",
            "Request body must be CSV text (Content-Type: text/csv) or a JSON array or {\"records\":[...]} object (Content-Type: application/json)");
        }

        const result = await importMarketRecords(rows, options.marketRepository, {
          // Section 2/10: attribution is taken entirely from the AUTHENTICATED partner, never from
          // anything in the request body — see importPipeline.ts's doc comment.
          partner: { partnerId: partner.partnerId, sourceType: partner.sourceType, sourceName: partner.partnerName }
        });

        await options.partnerRepository.recordImportStats(partner.partnerId, {
          received: result.totalRows,
          accepted: result.imported + result.updated,
          rejected: result.errors.length,
          updated: result.updated,
          latestObservedAt: result.latestObservedAt
        });

        recordAttempt(200, null, { received: result.totalRows, accepted: result.imported + result.updated, rejected: result.errors.length, updated: result.updated });

        // Section 6: a safe per-row rejection summary — {row, code, message} — never the
        // partner's original raw row data.
        send(res, {
          partnerId: partner.partnerId,
          totalRows: result.totalRows,
          imported: result.imported,
          updated: result.updated,
          skipped: result.skipped,
          rejected: result.errors.length,
          averageDataQualityScore: result.averageDataQualityScore,
          rejections: result.errors.map(e => ({ row: e.row, code: e.code, message: e.reason }))
        });
      } catch (error) {
        const normalized = error instanceof ApiError || error instanceof Error ? error : new ApiError(400, "INVALID_INPUT", "Malformed import request");
        const httpStatus = normalized instanceof ApiError ? normalized.status : 500;
        const errorCode = normalized instanceof ApiError ? normalized.code : "INTERNAL_ERROR";
        recordAttempt(httpStatus, errorCode, { received: 0, accepted: 0, rejected: 0, updated: 0 });
        next(normalized);
      }
    }
  );

  // Section 9: safe, cross-partner aggregate figures — exact shape the spec requires. Never
  // includes a partner token, digest, or any other partner secret (PropertyDataPartner/
  // PartnerRepository.list() never carry one — see partners.ts's doc comment).
  router.get("/api/v1/internal/market-data/status", internalAuth, async (_req, res, next) => {
    try {
      const [status, partners] = await Promise.all([
        options.marketRepository.getAggregateStatus(),
        options.partnerRepository.list()
      ]);
      send(res, {
        records: status.records,
        rentalRecords: status.rentalRecords,
        saleRecords: status.saleRecords,
        areas: status.areas,
        partners: partners.length,
        latestDataDate: status.latestDataDate,
        sourceTypes: status.sourceTypes
      });
    } catch (error) { next(error); }
  });

  // Section 4/11: per-partner health — kept as its own endpoint precisely so adding it never
  // changes the exact shape mandated for /status above. Exact shape per spec: partnerId,
  // partnerName, enabled, feedType, latestIngestionAt, latestObservationDate,
  // recordsAcceptedLast24h, recordsAcceptedLast7d, rejectionRateLast7d, stale, staleDays. Never
  // exposes a token, digest, contact detail, or license reference.
  router.get("/api/v1/internal/market-data/partners", internalAuth, async (_req, res, next) => {
    try {
      const [partners, allPartners] = await Promise.all([
        options.partnerRepository.listWithStats(options.staleDays),
        options.partnerRepository.list()
      ]);
      const now = Date.now();
      const since24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
      const since7d = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
      const byId = new Map(allPartners.map(p => [p.partnerId, p]));
      const health = await Promise.all(partners.map(async p => {
        const base = byId.get(p.partnerId)!;
        const [latestIngestionAt, last24h, last7d] = await Promise.all([
          options.ingestionAuditRepository.latestIngestionAt(p.partnerId),
          options.ingestionAuditRepository.statsSince(p.partnerId, since24h),
          options.ingestionAuditRepository.statsSince(p.partnerId, since7d)
        ]);
        const rejectionRateLast7d = last7d.recordsReceived > 0
          ? Math.round((last7d.recordsRejected / last7d.recordsReceived) * 10000) / 100
          : 0;
        return {
          partnerId: base.partnerId,
          partnerName: base.partnerName,
          enabled: base.enabled,
          feedType: base.feedType,
          latestIngestionAt,
          latestObservationDate: p.latestObservationDate,
          recordsAcceptedLast24h: last24h.recordsAccepted,
          recordsAcceptedLast7d: last7d.recordsAccepted,
          rejectionRateLast7d,
          // Section 5: each partner's staleness is computed purely from its own feed — never from
          // any other partner's activity, and never rolled up into a market-wide flag.
          stale: p.stale,
          staleDays: options.staleDays,
          // Production Feed Runner (Section 9): the scheduled-feed-run counterpart to the manual
          // ingestion figures above — computed via the SAME pure helpers (partners.ts) the
          // scheduling pass itself uses, so "is this partner due" and "what does the health
          // endpoint report" can never disagree. Never affects market analysis availability
          // globally (Section 9) — this is read-only reporting over fields already on the partner.
          lastFeedAttemptAt: base.lastAttemptAt,
          lastFeedSuccessAt: base.lastSuccessfulRunAt,
          consecutiveFailures: base.consecutiveFailures,
          nextDueAt: computeNextDueAt(base),
          feedHealth: computeFeedHealth({ consecutiveFailures: base.consecutiveFailures, stale: p.stale })
        };
      }));
      send(res, { partners: health });
    } catch (error) { next(error); }
  });

  // Section 7: per-partner aggregate data-quality summary — internal-only, never a public
  // capability. Deliberately a separate route (not folded into /partners above) so the common,
  // cheap health call never has to pay for a data-quality aggregation it didn't ask for.
  router.get("/api/v1/internal/market-data/partners/:partnerId/quality", internalAuth, async (req, res, next) => {
    try {
      const partner = await options.partnerRepository.findById(String(req.params.partnerId));
      if (!partner) throw new ApiError(404, "NOT_FOUND", "Partner not found");
      const summary = await options.marketRepository.getPartnerQualitySummary(partner.partnerId);
      send(res, { partnerId: partner.partnerId, ...summary });
    } catch (error) { next(error); }
  });

  return router;
}
