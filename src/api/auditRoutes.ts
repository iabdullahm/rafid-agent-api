import express, { type Router } from "express";
import { requireInternalAuth } from "../middleware/partnerAuth.js";
import { ApiError } from "../utils/errors.js";
import type { RevenueLedger } from "../revenue/types.js";
import { REVENUE_PERIODS, type RevenuePeriod } from "../revenue/aggregate.js";
import type { AnalyticsRepository } from "../analytics/types.js";
import type { BillingEngine } from "../billing/unified/engine.js";
import type { CapabilityName } from "../billing/catalog.js";
import { buildRevenueConversionAudit } from "../audit/service.js";
import { AUDIT_CHANNELS, FINAL_STATUSES, REASON_CODES, type AuditChannel, type FinalStatus, type ReasonCode } from "../audit/types.js";

/**
 * GET /api/v1/internal/audit/revenue-conversion — internal-key-protected (spec section 24), GET-
 * only, never registered in src/domain/capabilities.ts, exactly like analyticsRoutes.ts/
 * revenueRoutes.ts's own "structurally unreachable from any public surface" discipline (see
 * revenueRoutes.ts's doc comment). 503s outright when AUDIT_INTERNAL_API_KEY is unset, rather than
 * existing unprotected — same convention as every other internal-only route family here.
 *
 * Always mounted (like revenueRoutes.ts, unlike marketDataRoutes/adminRoutes which only mount
 * when a database is configured): the audit computes on demand from whatever analytics/revenue/
 * billing data already exists, so it always has *something* to report; it simply 503s until an
 * internal key is set.
 */
export interface AuditRoutesOptions {
  analyticsRepository: AnalyticsRepository;
  revenueLedger: RevenueLedger;
  billingEngine: BillingEngine | null;
  priceUsd: (tool: CapabilityName) => number;
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

function parseOptionalEnum<T extends string>(raw: unknown, allowed: readonly T[], field: string): T | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !(allowed as readonly string[]).includes(raw)) {
    throw new ApiError(400, "INVALID_INPUT", `${field} must be one of: ${allowed.join(", ")}`);
  }
  return raw as T;
}

export function createAuditRoutes(options: AuditRoutesOptions): Router {
  const router = express.Router();
  const internalAuth = requireInternalAuth(options.internalApiKey);

  router.get("/api/v1/internal/audit/revenue-conversion", internalAuth, async (req, res, next) => {
    try {
      const period = parsePeriod(req.query.period);
      const tool = typeof req.query.tool === "string" ? req.query.tool : undefined;
      const channel = parseOptionalEnum<AuditChannel>(req.query.channel, AUDIT_CHANNELS, "channel");
      const finalStatus = parseOptionalEnum<FinalStatus>(req.query.status, FINAL_STATUSES, "status");
      const reasonCode = parseOptionalEnum<ReasonCode>(req.query.reason, REASON_CODES, "reason");

      const report = await buildRevenueConversionAudit({
        analyticsRepository: options.analyticsRepository, revenueLedger: options.revenueLedger,
        billingEngine: options.billingEngine, priceUsd: options.priceUsd
      }, period);

      // Filters apply only to the per-call `records` list (spec section 24) — toolAudit/funnel/
      // anomalies/diagnoses/recommendations always reflect the FULL period, exactly like
      // dashboardRoutes.ts's period filter never re-scopes the aggregate sections beneath it.
      let records = report.records;
      if (tool) records = records.filter(r => r.toolName === tool);
      if (channel) records = records.filter(r => r.channel === channel);
      if (finalStatus) records = records.filter(r => r.finalStatus === finalStatus);
      if (reasonCode) records = records.filter(r => r.reasonCode === reasonCode);

      send(res, {
        period, generatedAt: report.generatedAt, recordCount: report.recordCount,
        filters: { tool: tool ?? null, channel: channel ?? null, status: finalStatus ?? null, reason: reasonCode ?? null },
        records, toolAudit: report.toolAudit, funnel: report.funnel, anomalies: report.anomalies,
        diagnoses: report.diagnoses, recommendations: report.recommendations
      });
    } catch (error) { next(error); }
  });

  return router;
}
