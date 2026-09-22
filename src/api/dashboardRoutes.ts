import express, { type RequestHandler, type Router } from "express";
import type { Config } from "../config/env.js";
import { ApiError } from "../utils/errors.js";
import {
  requireAdminConfigured, requireAdminAuthApi,
  setAdminSessionCookie, clearAdminSessionCookie, readAdminSession, verifyAdminPassword
} from "../middleware/adminAuth.js";
import { createRateLimiter, disabledRateLimiter } from "../middleware/rateLimit.js";
import type { AnalyticsRepository } from "../analytics/types.js";
import type { RevenueLedger } from "../revenue/types.js";
import type { BillingService } from "../billing/service.js";
import { DASHBOARD_PERIODS, buildDashboardData, type DashboardPeriod } from "./dashboard/service.js";
import { dashboardLoginPageHtml } from "./dashboard/loginPage.js";
import { dashboardPageHtml } from "./dashboard/page.js";

/**
 * Internal Rafid Property Intelligence dashboard — GET-mostly (plus login/logout), session-
 * cookie-protected, never registered in src/domain/capabilities.ts (same structural-
 * unreachability discipline as analyticsRoutes.ts/revenueRoutes.ts: unreachable from /agent.json,
 * the tool catalog, MCP, discovery/OpenAPI output or the x402 route family — spec section 10).
 *
 * SECURITY (spec section 10): every route here requires the exact same authentication as
 * /admin/business/* — a signed `rafid_admin_session` cookie (middleware/adminAuth.ts), checked
 * against ADMIN_USERNAME/ADMIN_PASSWORD_HASH/ADMIN_SESSION_SECRET. This dashboard has its own
 * /internal/dashboard/login page (see dashboard/loginPage.ts's doc comment for why it isn't a
 * reuse of /admin/login's page) but the exact same underlying mechanism, so a session established
 * at either login page is valid at both. Mounted whenever config.adminEnabled is true —
 * deliberately NOT also gated on a business-intelligence database being configured (unlike
 * createAdminRoutes in adminRoutes.ts): this dashboard depends only on the analytics and revenue
 * layers, which (like createAnalyticsRoutes/createRevenueRoutes) are always constructed.
 *
 * REVENUE_INTERNAL_API_KEY / ANALYTICS_INTERNAL_API_KEY are never read, referenced or required by
 * this router at all — the JSON route below (/internal/dashboard/data) calls the in-process
 * analyticsRepository/revenueLedger/billingService directly (the exact instances createApp()
 * already constructed), never the internal-key-gated HTTP routes in analyticsRoutes.ts/
 * revenueRoutes.ts. No internal API key, secret, or credential of any kind is ever sent to the
 * browser — see dashboard/page.ts's embedded JSON, which is exactly the same DashboardData this
 * JSON route returns.
 */

export interface DashboardRoutesOptions {
  config: Config;
  analyticsRepository: AnalyticsRepository;
  revenueLedger: RevenueLedger;
  billingService: BillingService;
}

function send(res: express.Response, data: unknown) {
  res.json({ success: true, data, meta: { requestId: res.locals.requestId } });
}

function parsePeriod(raw: unknown): DashboardPeriod {
  const period = typeof raw === "string" ? raw : "24h";
  if (!DASHBOARD_PERIODS.includes(period as DashboardPeriod)) {
    throw new ApiError(400, "INVALID_INPUT", `period must be one of: ${DASHBOARD_PERIODS.join(", ")}`);
  }
  return period as DashboardPeriod;
}

function stringParam(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function createDashboardRoutes(options: DashboardRoutesOptions): Router {
  const { config, analyticsRepository, revenueLedger, billingService } = options;
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: "16kb" }));

  const configured = requireAdminConfigured(config);
  // NOT middleware/adminAuth.ts's requireAdminAuthHtml(): that function's unauthenticated redirect
  // is hard-coded to "/admin/login" (the business admin dashboard's login page), which only exists
  // when a business-intelligence database is configured (see app.ts's `config.adminEnabled &&
  // businessRepository` mount condition) — exactly the dependency this router deliberately does
  // NOT have. Session verification itself (readAdminSession) is fully reused; only the redirect
  // target differs, so it stays a tiny local middleware rather than a shared-function change.
  const htmlAuth: RequestHandler = (req, res, next) => {
    const session = readAdminSession(req, config);
    if (!session) {
      const returnTo = encodeURIComponent(req.originalUrl);
      res.redirect(302, `/internal/dashboard/login?returnTo=${returnTo}`);
      return;
    }
    res.locals.adminUser = session.u;
    res.locals.adminCsrf = session.csrf;
    next();
  };
  const apiAuth = requireAdminAuthApi(config);
  const loginLimiter = config.rateLimitEnabled
    ? createRateLimiter({ windowMs: config.adminLoginRateLimitWindowMs, max: config.adminLoginRateLimitMax })
    : disabledRateLimiter;

  // ============================================================================================
  // Authentication — same session-cookie mechanism as /admin/*, its own login page (spec section
  // 10's "reuse existing internal authentication architecture where possible": the architecture,
  // not necessarily the exact same HTML page — see loginPage.ts).
  // ============================================================================================

  router.get("/internal/dashboard/login", configured, (req, res) => {
    if (readAdminSession(req, config)) { res.redirect(302, "/internal/dashboard"); return; }
    res.type("html").send(dashboardLoginPageHtml({ returnTo: stringParam(req.query.returnTo) }));
  });

  router.post("/internal/dashboard/login", configured, loginLimiter, (req, res) => {
    const username = String(req.body?.username ?? "").trim();
    const password = String(req.body?.password ?? "");
    const returnToRaw = String(req.body?.returnTo ?? "");
    const returnTo = returnToRaw.startsWith("/internal/dashboard") ? returnToRaw : "/internal/dashboard";
    const valid = username.length > 0 && username === config.adminUsername && verifyAdminPassword(password, config.adminPasswordHash);
    if (!valid) {
      console.error(JSON.stringify({ event: "dashboard_login_failed", username: username || "(unknown)", at: new Date().toISOString() }));
      res.status(401).type("html").send(dashboardLoginPageHtml({ error: "Invalid username or password.", returnTo: returnToRaw }));
      return;
    }
    setAdminSessionCookie(res, config, username);
    res.redirect(302, returnTo);
  });

  router.post("/internal/dashboard/logout", configured, htmlAuth, (_req, res) => {
    clearAdminSessionCookie(res);
    res.redirect(302, "/internal/dashboard/login");
  });

  // ============================================================================================
  // Dashboard page + BFF JSON data route (spec sections 1, 11)
  // ============================================================================================

  router.get("/internal/dashboard", configured, htmlAuth, async (req, res, next) => {
    try {
      const period = parsePeriod(req.query.period);
      const initialData = await buildDashboardData({ config, analyticsRepository, revenueLedger, billingService }, period);
      res.type("html").send(dashboardPageHtml({ adminUser: res.locals.adminUser, csrfToken: res.locals.adminCsrf, initialData }));
    } catch (error) { next(error); }
  });

  router.get("/internal/dashboard/data", configured, apiAuth, async (req, res, next) => {
    try {
      const period = parsePeriod(req.query.period);
      const data = await buildDashboardData({ config, analyticsRepository, revenueLedger, billingService }, period);
      send(res, data);
    } catch (error) { next(error); }
  });

  return router;
}
