import express, { type Router } from "express";
import { requireInternalAuth } from "../middleware/partnerAuth.js";
import { ApiError } from "../utils/errors.js";
import type { RevenueLedger } from "../revenue/types.js";
import { REVENUE_PERIODS, periodSince, summarizeRevenue, summarizeRevenueByTool, buildReconciliation, type RevenuePeriod } from "../revenue/aggregate.js";
import { DEFAULT_TRANSACTIONS_PAGE_SIZE, MAX_TRANSACTIONS_PAGE_SIZE } from "../revenue/types.js";
import type { AnalyticsRepository } from "../analytics/types.js";
import type { BillingService } from "../billing/service.js";
import { prices, type CapabilityName } from "../billing/catalog.js";

/**
 * Internal revenue/settlement-ledger API — GET-only, internal-key-protected, never registered in
 * src/domain/capabilities.ts (same structural-unreachability discipline as analyticsRoutes.ts:
 * unreachable from /agent.json, the tool catalog, MCP, discovery/OpenAPI output or the x402
 * route family). No public dashboard, no public exposure: every route requires
 * X-Internal-Api-Key against a DEDICATED REVENUE_INTERNAL_API_KEY (see revenue/config.ts's doc
 * comment for why this is not the same key as analytics), and 503s outright when that key is
 * unset, rather than existing unprotected.
 *
 * Always mounted (unlike marketDataRoutes/adminRoutes, which only mount when a database is
 * configured) — settlement recording itself always happens (api/app.ts constructs a
 * RevenueLedger unconditionally, defaulting to an in-memory one when no database is configured),
 * so these read routes always have *something* to report; they simply 503 until an internal key
 * is set.
 */

export interface RevenueRoutesOptions {
  ledger: RevenueLedger;
  analyticsRepository: AnalyticsRepository;
  billingService: BillingService;
  internalApiKey: string | null;
}

function send(res: express.Response, data: unknown) {
  res.json({ success: true, data, meta: { requestId: res.locals.requestId } });
}

function parsePeriod(raw: unknown): RevenuePeriod {
  const period = typeof raw === "string" ? raw : "24h";
  if (!REVENUE_PERIODS.includes(period as RevenuePeriod)) {
    throw new ApiError(400, "INVALID_INPUT", `period must be one of: ${REVENUE_PERIODS.join(", ")}`);
  }
  return period as RevenuePeriod;
}

function parsePageParam(raw: unknown, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new ApiError(400, "INVALID_INPUT", "limit/offset must be a non-negative integer");
  return Math.min(n || fallback, max);
}

export function createRevenueRoutes(options: RevenueRoutesOptions): Router {
  const router = express.Router();
  const internalAuth = requireInternalAuth(options.internalApiKey);
  const { ledger, analyticsRepository, billingService } = options;

  router.get("/api/v1/internal/revenue/summary", internalAuth, async (req, res, next) => {
    try {
      const period = parsePeriod(req.query.period);
      const settlements = await ledger.query({ since: periodSince(period, new Date()) });
      send(res, summarizeRevenue(settlements, period));
    } catch (error) { next(error); }
  });

  router.get("/api/v1/internal/revenue/tools", internalAuth, async (req, res, next) => {
    try {
      const period = parsePeriod(req.query.period);
      const settlements = await ledger.query({ since: periodSince(period, new Date()) });
      send(res, { period, tools: summarizeRevenueByTool(settlements) });
    } catch (error) { next(error); }
  });

  router.get("/api/v1/internal/revenue/transactions", internalAuth, async (req, res, next) => {
    try {
      const period = parsePeriod(req.query.period);
      const since = periodSince(period, new Date());
      const limit = parsePageParam(req.query.limit, DEFAULT_TRANSACTIONS_PAGE_SIZE, MAX_TRANSACTIONS_PAGE_SIZE);
      const offset = parsePageParam(req.query.offset, 0, Number.MAX_SAFE_INTEGER);
      const [rows, total] = await Promise.all([ledger.query({ since, limit, offset }), ledger.count(since)]);
      // Safe fields only (spec section 8) — never amountAtomic/payerAddress/asset/dedupeKey/
      // errorReason, and never anything from the original X-PAYMENT header itself.
      const transactions = rows.map(r => ({
        timestamp: r.createdAt, tool: r.toolName, amount: r.amountDecimal, currency: r.currency,
        network: r.network, transactionHash: r.transactionHash, status: r.status, requestId: r.requestId
      }));
      send(res, { period, pagination: { limit, offset, total, returned: transactions.length }, transactions });
    } catch (error) { next(error); }
  });

  router.get("/api/v1/internal/revenue/reconciliation", internalAuth, async (req, res, next) => {
    try {
      const period = parsePeriod(req.query.period);
      const since = periodSince(period, new Date());
      const [settlements, analyticsEvents] = await Promise.all([
        ledger.query({ since }),
        analyticsRepository.queryEvents(since ?? new Date(0))
      ]);
      // A: successful x402 tool executions, from analytics — see analytics/types.ts's `channel`
      // field doc comment for why this is the one analytics field reconciliation is allowed to
      // read (never revenue itself — see aggregate.ts's SOURCE_OF_TRUTH_RULE).
      const x402ToolExecutionCounts: Record<string, number> = {};
      for (const event of analyticsEvents) {
        if (event.category === "tool" && event.channel === "x402" && event.success === true && event.toolName) {
          x402ToolExecutionCounts[event.toolName] = (x402ToolExecutionCounts[event.toolName] ?? 0) + 1;
        }
      }
      const catalogPriceByTool: Record<string, number> = {};
      for (const name of Object.keys(prices)) catalogPriceByTool[name] = billingService.getToolPrice(name as CapabilityName);
      const anomalies = buildReconciliation({ settlements, x402ToolExecutionCounts, catalogPriceByTool });
      send(res, { period, anomalyCount: anomalies.length, anomalies });
    } catch (error) { next(error); }
  });

  return router;
}
