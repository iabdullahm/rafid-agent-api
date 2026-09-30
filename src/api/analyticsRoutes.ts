import express, { type Router } from "express";
import { requireInternalAuth } from "../middleware/partnerAuth.js";
import type { AnalyticsRepository } from "../analytics/types.js";
import { WINDOW_MS, summarize, summarizeCapabilityFunnel, summarizeSchemaFriction, summarizeDiscovery, summarizeTools, summarizeX402 } from "../analytics/aggregate.js";

/**
 * Internal analytics API — GET-only, internal-key-protected, never registered in
 * src/domain/capabilities.ts (structurally unreachable from /agent.json, the tool catalog, MCP,
 * discovery/OpenAPI output or the x402 route family — same pattern as marketDataRoutes.ts's
 * internal endpoints and adminRoutes.ts's dashboard). No public dashboard, no public exposure:
 * every route here requires X-Internal-Api-Key (requireInternalAuth, middleware/partnerAuth.ts)
 * and 503s outright when ANALYTICS_INTERNAL_API_KEY is unset, rather than existing unprotected.
 *
 * Always mounted (unlike marketDataRoutes/adminRoutes, which only mount when a database is
 * configured) — analytics recording itself always happens (api/app.ts constructs an
 * AnalyticsRepository unconditionally, defaulting to an in-memory one), so these read routes
 * always have *something* to report, even with no database configured; they simply 503 until an
 * internal key is set, exactly like the other internal-key-gated surfaces in this codebase.
 */

export interface AnalyticsRoutesOptions {
  repository: AnalyticsRepository;
  internalApiKey: string | null;
}

function send(res: express.Response, data: unknown) {
  res.json({ success: true, data, meta: { requestId: res.locals.requestId } });
}

const WIDEST_WINDOW_MS = WINDOW_MS.last30d;

export function createAnalyticsRoutes(options: AnalyticsRoutesOptions): Router {
  const router = express.Router();
  const internalAuth = requireInternalAuth(options.internalApiKey, "ANALYTICS_INTERNAL_API_KEY");

  async function fetchEvents() {
    return options.repository.queryEvents(new Date(Date.now() - WIDEST_WINDOW_MS));
  }

  function journeyDetails(events: Awaited<ReturnType<typeof fetchEvents>>) {
    const groups = new Map<string, typeof events>();
    for (const event of events) if (event.paymentJourneyId) (groups.get(event.paymentJourneyId) ?? groups.set(event.paymentJourneyId, []).get(event.paymentJourneyId)!).push(event);
    return [...groups.entries()].map(([paymentJourneyId, rows]) => {
      const ordered = rows.slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const first = ordered[0]!;
      const challenge = ordered.find(e => e.eventType === "challenge" || e.eventType === "payment_challenge");
      const settlement = ordered.find(e => e.eventType === "settlement_success" && e.txHash);
      const completed = ordered.find(e => e.eventType === "execution_completed" || (e.category === "tool" && e.eventType === "invocation" && e.success === true));
      const retry = ordered.find(e => e.eventType === "paid_retry_received");
      return {
        paymentJourneyId,
        capability: first.toolName,
        paymentRail: settlement?.paymentRail ?? retry?.paymentMode ?? first.paymentMode,
        trafficType: first.trafficType ?? first.trafficClass ?? "unknown",
        correlationStatus: "correlated",
        client: { normalized: first.normalizedClient ?? first.clientName ?? first.clientType ?? "unknown", confidence: first.attributionConfidence ?? "unknown" },
        challenge: { requestId: challenge?.challengeRequestId ?? challenge?.requestId ?? first.challengeRequestId ?? first.requestId, status: "payment_required", at: challenge?.challengeIssuedAt ?? challenge?.createdAt ?? first.createdAt },
        payment: settlement || retry ? { attemptId: settlement?.paymentAttemptId ?? retry?.paymentAttemptId ?? null, verifiedAt: settlement?.paymentVerifiedAt ?? null, transactionHash: settlement?.txHash ?? null } : null,
        settlement: settlement ? { status: "succeeded", chainSettledAt: settlement.chainSettledAt ?? null, recordedAt: settlement.settlementRecordedAt ?? settlement.createdAt ?? null } : null,
        retry: retry ? { requestId: retry.paidRetryRequestId ?? retry.requestId ?? null, at: retry.paidRetryReceivedAt ?? retry.createdAt ?? null } : null,
        execution: completed ? { status: completed.success === true ? "completed" : "unknown", completedAt: completed.executionCompletedAt ?? completed.createdAt ?? null } : null,
        events: ordered.map(e => ({ eventType: e.eventType, category: e.category, requestId: e.requestId ?? null, createdAt: e.createdAt }))
      };
    });
  }

  router.get("/api/v1/internal/analytics/summary", internalAuth, async (_req, res, next) => {
    try { send(res, summarize(await fetchEvents(), new Date())); } catch (error) { next(error); }
  });

  router.get("/api/v1/internal/analytics/discovery", internalAuth, async (_req, res, next) => {
    try { send(res, summarizeDiscovery(await fetchEvents(), new Date())); } catch (error) { next(error); }
  });

  router.get("/api/v1/internal/analytics/tools", internalAuth, async (_req, res, next) => {
    try { send(res, summarizeTools(await fetchEvents(), new Date())); } catch (error) { next(error); }
  });

  router.get("/api/v1/internal/analytics/x402", internalAuth, async (_req, res, next) => {
    try { send(res, summarizeX402(await fetchEvents(), new Date())); } catch (error) { next(error); }
  });

  router.get("/api/v1/internal/analytics/funnel", internalAuth, async (_req, res, next) => {
    try {
      const events = await fetchEvents();
      send(res, { rows: summarizeCapabilityFunnel(events), schemaFriction: summarizeSchemaFriction(events), presentedMeaning: "Surface response contained the capability; this does not prove an agent inspected or selected it.", selectionMeaning: "A capability endpoint, preview, MCP invocation or paid execution is a selection signal; surface presentation alone is not." });
    } catch (error) { next(error); }
  });

  router.get("/api/v1/internal/analytics/payment-journeys", internalAuth, async (req, res, next) => {
    try {
      const query = req.query;
      const journey = typeof query.paymentJourneyId === "string" ? query.paymentJourneyId : null;
      const capability = typeof query.capability === "string" ? query.capability : null;
      const transactionHash = typeof query.transactionHash === "string" ? query.transactionHash.toLowerCase() : null;
      const trafficType = typeof query.trafficType === "string" ? query.trafficType : null;
      const client = typeof query.client === "string" ? query.client : null;
      const paymentRail = typeof query.paymentRail === "string" ? query.paymentRail : null;
      const status = typeof query.status === "string" ? query.status : null;
      const rows = journeyDetails(await fetchEvents()).filter(item =>
        (!journey || item.paymentJourneyId === journey) &&
        (!capability || item.capability === capability) &&
        (!transactionHash || item.payment?.transactionHash?.toLowerCase() === transactionHash) &&
        (!trafficType || item.trafficType === trafficType) &&
        (!client || item.client.normalized === client) &&
        (!paymentRail || item.paymentRail === paymentRail) &&
        (!status || item.settlement?.status === status)
      );
      send(res, { journeys: rows, count: rows.length, note: "Only rows with an explicit paymentJourneyId are returned; legacy rows remain uncorrelated." });
    } catch (error) { next(error); }
  });

  return router;
}
