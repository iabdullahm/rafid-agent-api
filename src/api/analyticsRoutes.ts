import express, { type Router } from "express";
import { requireInternalAuth } from "../middleware/partnerAuth.js";
import type { AnalyticsRepository } from "../analytics/types.js";
import { WINDOW_MS, summarize, summarizeDiscovery, summarizeTools, summarizeX402 } from "../analytics/aggregate.js";

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
  const internalAuth = requireInternalAuth(options.internalApiKey);

  async function fetchEvents() {
    return options.repository.queryEvents(new Date(Date.now() - WIDEST_WINDOW_MS));
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

  return router;
}
