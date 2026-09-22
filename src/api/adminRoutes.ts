import express, { type Router } from "express";
import { randomUUID, createHash } from "node:crypto";
import type { Config } from "../config/env.js";
import { ApiError } from "../utils/errors.js";
import {
  requireAdminConfigured, requireAdminAuthApi, requireAdminAuthHtml, requireCsrf,
  setAdminSessionCookie, clearAdminSessionCookie, readAdminSession, verifyAdminPassword
} from "../middleware/adminAuth.js";
import { createRateLimiter, disabledRateLimiter } from "../middleware/rateLimit.js";
import type { CompanyRecordInput, CompanyRepository } from "../business-data/sources/companyRepository.js";
import { MemoryCompanyRepository } from "../business-data/sources/companyRepository.js";
import { PostgresCompanyRepository } from "../db/businessStore.js";
import { getOmanBusinessDataMode } from "../business-data/config.js";
import { normalizeCompanyName } from "../business-data/normalizers/companyName.js";
import { resolveGovernorateName } from "../business-data/normalizers/location.js";
import { normalizeTaxOmanRecord, DEFAULT_TAX_OMAN_SOURCE_NAME, type TaxOmanRawRecord } from "../business-data/sources/taxOmanProvider.js";
import { normalizeMociipRecord } from "../business-data/sources/omanBusinessProvider.js";
import { normalizeTenderBoardSupplierRecord } from "../business-data/sources/tenderBoardProvider.js";
import { runSourceImport, IMPORT_SOURCE_NAMES } from "../business-data/ingestion/importDispatch.js";
import { parseCsv, parseJsonRows, MAX_IMPORT_FILE_BYTES, MAX_IMPORT_ROWS } from "../business-data/ingestion/importPipeline.js";
import { COMPANY_STATUSES, type UnmatchedReason, type AdminRowFlag } from "../business-data/types.js";
import {
  buildCompanyViews, computeDashboardStats, computeSourceCoverage, filterCompanyViews, conflictQueue,
  staleQueue, reviewQueue, taxVerificationQueue, computeDataQuality, computeProcurementStats,
  computeCoverageBreakdowns, companyListToCsv, writeAudit, type CompanyListFilters
} from "../business-data/admin/adminService.js";
import { loginPageHtml } from "./admin/loginPage.js";
import { dashboardPageHtml } from "./admin/dashboardPage.js";
import { companiesListPageHtml, companyDetailPageHtml } from "./admin/companiesPages.js";
import { importsPageHtml } from "./admin/importsPage.js";
import { taxVerificationPageHtml, conflictsPageHtml, stalePageHtml, reviewPageHtml, unmatchedPageHtml } from "./admin/queuePages.js";
import { procurementPageHtml, awardsPageHtml } from "./admin/procurementPages.js";
import { dataQualityPageHtml } from "./admin/dataQualityPage.js";
import { sourcesPageHtml } from "./admin/sourcesPage.js";
import { systemPageHtml, type SystemStatus } from "./admin/systemPage.js";
import { auditPageHtml } from "./admin/auditPage.js";

/**
 * Oman Business Intelligence Admin & Data Operations Dashboard.
 *
 * A standalone Express Router — like src/api/marketDataRoutes.ts, deliberately NOT registered in
 * src/domain/capabilities.ts, so it is structurally unreachable from /agent.json, the tool
 * catalog, MCP, discovery/OpenAPI output or the x402 route family. Every route lives under
 * `/admin` (server-rendered HTML pages) or `/api/admin/business` (JSON), both gated by
 * requireAdminConfigured + session-cookie authentication — never the X-API-Key/x402 mechanism the
 * rest of this app uses. See docs/business-admin.md for the full operator guide.
 *
 * Layering (Section 32): route handlers here call adminService.ts (the read model) and
 * CompanyRepository (persistence) directly — no business logic is reimplemented, and imports are
 * dispatched through the exact same runSourceImport() the CLI uses.
 */

export interface AdminRoutesOptions {
  config: Config;
  repository: CompanyRepository;
}

function send(res: express.Response, data: unknown) {
  res.json({ success: true, data, meta: { requestId: res.locals.requestId } });
}

/** Every mutating admin action is triggered by either a plain HTML `<form>` post (which carries a
 *  hidden `redirectTo` field, so the operator lands back on the page they came from) or a fetch()
 *  call expecting JSON (no `redirectTo`) — this one helper serves both without duplicating each
 *  route's response logic. */
function respond(req: express.Request, res: express.Response, data: unknown, extraQuery = "") {
  const redirectTo = typeof req.body?.redirectTo === "string" && req.body.redirectTo.startsWith("/admin") ? req.body.redirectTo : null;
  if (redirectTo) { res.redirect(302, redirectTo + extraQuery); return; }
  send(res, data);
}

function stringParam(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function boolParam(v: unknown): boolean | undefined {
  return v === "true" ? true : v === "false" ? false : undefined;
}

function parseCompanyFilters(query: express.Request["query"]): CompanyListFilters {
  return {
    q: stringParam(query.q), source: stringParam(query.source) as CompanyListFilters["source"],
    verificationStatus: stringParam(query.verificationStatus) as CompanyListFilters["verificationStatus"],
    taxStatus: stringParam(query.taxStatus) as CompanyListFilters["taxStatus"],
    supplierStatus: stringParam(query.supplierStatus) as CompanyListFilters["supplierStatus"],
    status: stringParam(query.status) as CompanyListFilters["status"],
    governorate: stringParam(query.governorate), industry: stringParam(query.industry),
    freshness: stringParam(query.freshness) as CompanyListFilters["freshness"],
    hasConflicts: boolParam(query.hasConflicts), hasAwards: boolParam(query.hasAwards),
    realOrDemo: stringParam(query.realOrDemo) as CompanyListFilters["realOrDemo"],
    page: query.page ? Number(query.page) : 1, pageSize: query.pageSize ? Number(query.pageSize) : 50,
    sortBy: stringParam(query.sortBy) as CompanyListFilters["sortBy"], sortDir: stringParam(query.sortDir) as CompanyListFilters["sortDir"]
  };
}

function queryToParams(query: express.Request["query"]): URLSearchParams {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (typeof v === "string" && v) params.set(k, v);
  return params;
}

function extractRegistrationNumber(row: unknown): string | null {
  if (!row || typeof row !== "object") return null;
  const v = (row as Record<string, unknown>).registrationNumber;
  return typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null;
}

function sourceTypeForImportSource(source: string): "government" | "tax_authority" | "government_procurement" | "other" {
  if (source === "mociip") return "government";
  if (source === "tax-oman") return "tax_authority";
  if (source === "tender-board-suppliers" || source === "tender-board-awards") return "government_procurement";
  return "other";
}

function classifyUnmatchedReason(reason: string): UnmatchedReason {
  const r = reason.toLowerCase();
  if (r.includes("no known company has registrationnumber")) return "insufficient_award_identity_data";
  if (r.includes("registrationnumber") && r.includes("required")) return "missing_registration_number";
  if (r.includes("ambiguous")) return "ambiguous_name_match";
  if (r.includes("multiple")) return "multiple_exact_candidates";
  return "validation_error";
}

function sampleNormalize(source: string, row: unknown): unknown {
  try {
    if (source === "mociip") { const r = normalizeMociipRecord(row as never, 1); return "record" in r ? r.record : { error: r.error.reason }; }
    if (source === "tax-oman") { const r = normalizeTaxOmanRecord(row as never, 1); return "record" in r ? r.record : { error: r.error.reason }; }
    if (source === "tender-board-suppliers") { const r = normalizeTenderBoardSupplierRecord(row as never, 1); return "record" in r ? r.record : { error: r.error.reason }; }
  } catch { /* best-effort sample only */ }
  return null;
}

function parseImportFile(fileName: string, content: string): unknown[] {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".csv")) return parseCsv(content);
  if (lower.endsWith(".json")) return parseJsonRows(content);
  throw new ApiError(400, "UNSUPPORTED_FILE_TYPE", 'Only ".csv" and ".json" files are supported');
}

function previewTokenFor(source: string, content: string): string {
  return createHash("sha256").update(`${source}::${content}`).digest("hex");
}

/** Section 2: the whole operator workflow — including opening the dashboard or running the very
 *  first import against a brand new database — must work entirely through this UI, without
 *  SQL/CLI/DB tools. Mirrors businessImportCli.ts's own "migrate automatically if it hasn't been
 *  applied yet" behavior (against the independent rafid_business_migrations ledger, never the
 *  customer/billing or property-market ledgers) rather than requiring an operator to run the CLI
 *  once before the dashboard becomes usable. Memoized per process — an idempotent migration is
 *  cheap once applied, but there is no reason to re-check the ledger on every single request; a
 *  MemoryCompanyRepository (tests, local dev without Postgres) has no schema to migrate at all. */
const migratedByRepository = new WeakMap<CompanyRepository, Promise<void>>();
function ensureBusinessSchemaMigrated(repository: CompanyRepository): Promise<void> {
  if (!(repository instanceof PostgresCompanyRepository)) return Promise.resolve();
  let promise = migratedByRepository.get(repository);
  if (!promise) {
    promise = repository.migrate().catch(error => { migratedByRepository.delete(repository); throw error; });
    migratedByRepository.set(repository, promise);
  }
  return promise;
}

export function createAdminRoutes(options: AdminRoutesOptions): Router {
  const { config, repository } = options;
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: "64kb" }));
  router.use(express.json({ limit: "12mb" })); // generous: import preview/execute carry up to MAX_IMPORT_FILE_BYTES of file text
  router.use((_req, _res, next) => { ensureBusinessSchemaMigrated(repository).then(() => next(), next); });

  const configured = requireAdminConfigured(config);
  const htmlAuth = requireAdminAuthHtml(config);
  const apiAuth = requireAdminAuthApi(config);
  const loginLimiter = config.rateLimitEnabled
    ? createRateLimiter({ windowMs: config.adminLoginRateLimitWindowMs, max: config.adminLoginRateLimitMax })
    : disabledRateLimiter;

  async function loadState() {
    const [allRows, allAwards, syncRuns] = await Promise.all([
      repository.adminListAllRows(), repository.adminListAllAwards(), repository.findAllSyncRuns(500)
    ]);
    return { allRows, allAwards, syncRuns, views: buildCompanyViews(allRows, allAwards) };
  }

  async function buildSystemStatus(): Promise<SystemStatus> {
    let databaseConnected = true;
    let businessMigrationsCurrent = true;
    try { await repository.adminListAllRows(1); } catch { databaseConnected = false; }
    if (databaseConnected && repository instanceof PostgresCompanyRepository) {
      try { await repository.ready(); } catch { businessMigrationsCurrent = false; }
    }
    const syncRuns = databaseConnected ? await repository.findAllSyncRuns(1) : [];
    const demoDataEnabled = databaseConnected ? (await repository.adminListAllRows()).some(r => r.sourceType === "demo") : false;
    return {
      databaseConnected, businessMigrationsCurrent, adminAuthEnabled: config.adminEnabled,
      businessProviderMode: getOmanBusinessDataMode(), demoDataEnabled,
      latestSyncStatus: syncRuns[0]?.status ?? "none", nodeEnv: config.nodeEnv, rateLimitEnabled: config.rateLimitEnabled
    };
  }

  // ============================================================================================
  // Authentication (Section 3)
  // ============================================================================================

  router.get("/admin/login", configured, (req, res) => {
    if (readAdminSession(req, config)) { res.redirect(302, "/admin/business/dashboard"); return; }
    res.type("html").send(loginPageHtml({ returnTo: stringParam(req.query.returnTo) }));
  });

  router.post("/admin/login", configured, loginLimiter, async (req, res) => {
    const username = String(req.body?.username ?? "").trim();
    const password = String(req.body?.password ?? "");
    const returnToRaw = String(req.body?.returnTo ?? "");
    const returnTo = returnToRaw.startsWith("/admin") ? returnToRaw : "/admin/business/dashboard";
    const valid = username.length > 0 && username === config.adminUsername && verifyAdminPassword(password, config.adminPasswordHash);
    if (!valid) {
      await writeAudit(repository, username || "(unknown)", "login_failed", null, null, {});
      res.status(401).type("html").send(loginPageHtml({ error: "Invalid username or password.", returnTo: returnToRaw }));
      return;
    }
    setAdminSessionCookie(res, config, username);
    await writeAudit(repository, username, "login_succeeded", null, null, {});
    res.redirect(302, returnTo);
  });

  router.post("/admin/logout", configured, htmlAuth, async (_req, res) => {
    const adminUser = res.locals.adminUser as string;
    clearAdminSessionCookie(res);
    await writeAudit(repository, adminUser, "logout", null, null, {});
    res.redirect(302, "/admin/login");
  });

  router.get("/admin", configured, htmlAuth, (_req, res) => res.redirect(302, "/admin/business/dashboard"));

  // ============================================================================================
  // HTML pages (Sections 4/6/7/8/12/14/15/16/17/18/19/23/26/27/29)
  // ============================================================================================

  router.get("/admin/business/dashboard", configured, htmlAuth, async (_req, res, next) => {
    try {
      const { views, allRows, allAwards, syncRuns } = await loadState();
      const stats = computeDashboardStats(views, syncRuns);
      const sources = computeSourceCoverage(allRows, allAwards, syncRuns);
      res.type("html").send(dashboardPageHtml({ adminUser: res.locals.adminUser, csrfToken: res.locals.adminCsrf, stats, sources }));
    } catch (error) { next(error); }
  });

  router.get("/admin/business/companies", configured, htmlAuth, async (req, res, next) => {
    try {
      const { views } = await loadState();
      const filters = parseCompanyFilters(req.query);
      const result = filterCompanyViews(views, filters);
      res.type("html").send(companiesListPageHtml({ adminUser: res.locals.adminUser, csrfToken: res.locals.adminCsrf, filters, result, queryString: queryToParams(req.query) }));
    } catch (error) { next(error); }
  });

  router.get("/admin/business/companies/:companyId", configured, htmlAuth, async (req, res, next) => {
    try {
      const { views } = await loadState();
      const view = views.find(v => v.companyId === req.params.companyId);
      if (!view) throw new ApiError(404, "COMPANY_NOT_FOUND", "No company found with that id");
      res.type("html").send(companyDetailPageHtml({
        adminUser: res.locals.adminUser, csrfToken: res.locals.adminCsrf, view,
        recalcMessage: req.query.recalculated ? "Intelligence recalculated from current evidence." : undefined
      }));
    } catch (error) { next(error); }
  });

  router.get("/admin/business/imports", configured, htmlAuth, async (_req, res, next) => {
    try {
      const runs = await repository.findAllSyncRuns(200);
      res.type("html").send(importsPageHtml({ adminUser: res.locals.adminUser, csrfToken: res.locals.adminCsrf, runs: [...runs] }));
    } catch (error) { next(error); }
  });

  router.get("/admin/business/tax-verification", configured, htmlAuth, async (_req, res, next) => {
    try {
      const { views } = await loadState();
      res.type("html").send(taxVerificationPageHtml({ adminUser: res.locals.adminUser, csrfToken: res.locals.adminCsrf, rows: taxVerificationQueue(views) }));
    } catch (error) { next(error); }
  });

  router.get("/admin/business/conflicts", configured, htmlAuth, async (_req, res, next) => {
    try {
      const { views } = await loadState();
      res.type("html").send(conflictsPageHtml({ adminUser: res.locals.adminUser, csrfToken: res.locals.adminCsrf, rows: conflictQueue(views) }));
    } catch (error) { next(error); }
  });

  router.get("/admin/business/stale", configured, htmlAuth, async (_req, res, next) => {
    try {
      const { allRows } = await loadState();
      res.type("html").send(stalePageHtml({ adminUser: res.locals.adminUser, csrfToken: res.locals.adminCsrf, groups: staleQueue(allRows) as { sourceType: string; rows: typeof allRows[number][] }[] }));
    } catch (error) { next(error); }
  });

  router.get("/admin/business/review", configured, htmlAuth, async (_req, res, next) => {
    try {
      const { views } = await loadState();
      res.type("html").send(reviewPageHtml({ adminUser: res.locals.adminUser, csrfToken: res.locals.adminCsrf, items: reviewQueue(views) }));
    } catch (error) { next(error); }
  });

  router.get("/admin/business/unmatched", configured, htmlAuth, async (_req, res, next) => {
    try {
      const records = await repository.listUnmatched("unresolved", 500);
      res.type("html").send(unmatchedPageHtml({ adminUser: res.locals.adminUser, csrfToken: res.locals.adminCsrf, records: [...records] }));
    } catch (error) { next(error); }
  });

  router.get("/admin/business/procurement", configured, htmlAuth, async (_req, res, next) => {
    try {
      const { views, allAwards, allRows, syncRuns } = await loadState();
      res.type("html").send(procurementPageHtml({ adminUser: res.locals.adminUser, csrfToken: res.locals.adminCsrf, stats: computeProcurementStats(views, allAwards, allRows, syncRuns) }));
    } catch (error) { next(error); }
  });

  router.get("/admin/business/awards", configured, htmlAuth, async (req, res, next) => {
    try {
      let awards = [...(await repository.adminListAllAwards())];
      const buyer = stringParam(req.query.buyer);
      const category = stringParam(req.query.category);
      if (buyer) awards = awards.filter(a => a.buyer?.toLowerCase().includes(buyer.toLowerCase()));
      if (category) awards = awards.filter(a => a.category?.toLowerCase().includes(category.toLowerCase()));
      res.type("html").send(awardsPageHtml({ adminUser: res.locals.adminUser, csrfToken: res.locals.adminCsrf, awards: awards.slice(0, 500), filters: { buyer, category } }));
    } catch (error) { next(error); }
  });

  router.get("/admin/business/data-quality", configured, htmlAuth, async (_req, res, next) => {
    try {
      const { views } = await loadState();
      const unresolvedUnmatched = (await repository.listUnmatched("unresolved", 5000)).length;
      res.type("html").send(dataQualityPageHtml({
        adminUser: res.locals.adminUser, csrfToken: res.locals.adminCsrf,
        stats: computeDataQuality(views, unresolvedUnmatched), coverage: computeCoverageBreakdowns(views)
      }));
    } catch (error) { next(error); }
  });

  router.get("/admin/business/sources", configured, htmlAuth, async (_req, res, next) => {
    try {
      const { allRows, allAwards, syncRuns } = await loadState();
      res.type("html").send(sourcesPageHtml({ adminUser: res.locals.adminUser, csrfToken: res.locals.adminCsrf, sources: computeSourceCoverage(allRows, allAwards, syncRuns) }));
    } catch (error) { next(error); }
  });

  router.get("/admin/system", configured, htmlAuth, async (_req, res, next) => {
    try {
      res.type("html").send(systemPageHtml({ adminUser: res.locals.adminUser, csrfToken: res.locals.adminCsrf, status: await buildSystemStatus() }));
    } catch (error) { next(error); }
  });

  router.get("/admin/business/audit", configured, htmlAuth, async (_req, res, next) => {
    try {
      const entries = await repository.listAuditLog({ limit: 200 });
      res.type("html").send(auditPageHtml({ adminUser: res.locals.adminUser, csrfToken: res.locals.adminCsrf, entries: [...entries] }));
    } catch (error) { next(error); }
  });

  // ============================================================================================
  // JSON API (Section 33) — /api/admin/business/*, never exposed to MCP/discovery/OpenAPI/agent
  // capabilities (structurally: this router is never passed to src/domain/capabilities.ts).
  // ============================================================================================

  router.get("/api/admin/business/dashboard", configured, apiAuth, async (_req, res, next) => {
    try {
      const { views, allRows, allAwards, syncRuns } = await loadState();
      send(res, { stats: computeDashboardStats(views, syncRuns), sources: computeSourceCoverage(allRows, allAwards, syncRuns) });
    } catch (error) { next(error); }
  });

  router.get("/api/admin/business/companies", configured, apiAuth, async (req, res, next) => {
    try {
      const { views } = await loadState();
      send(res, filterCompanyViews(views, parseCompanyFilters(req.query)));
    } catch (error) { next(error); }
  });

  router.get("/api/admin/business/companies/export.csv", configured, apiAuth, async (req, res, next) => {
    try {
      const { views } = await loadState();
      const filters = { ...parseCompanyFilters(req.query), page: 1, pageSize: 20_000 };
      const result = filterCompanyViews(views, filters);
      await writeAudit(repository, res.locals.adminUser, "company_list_exported", null, null, { count: result.rows.length });
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="companies.csv"');
      res.send(companyListToCsv(result.rows));
    } catch (error) { next(error); }
  });

  router.get("/api/admin/business/companies/:companyId", configured, apiAuth, async (req, res, next) => {
    try {
      const { views } = await loadState();
      const view = views.find(v => v.companyId === req.params.companyId);
      if (!view) throw new ApiError(404, "COMPANY_NOT_FOUND", "No company found with that id");
      send(res, view);
    } catch (error) { next(error); }
  });

  router.post("/api/admin/business/companies/:companyId/recalculate", configured, apiAuth, requireCsrf, async (req, res, next) => {
    try {
      const { views } = await loadState();
      const view = views.find(v => v.companyId === req.params.companyId);
      if (!view) throw new ApiError(404, "COMPANY_NOT_FOUND", "No company found with that id");
      await writeAudit(repository, res.locals.adminUser, "recalculate_company", "company", view.companyId, { riskLevel: view.riskLevel, confidence: view.confidence });
      respond(req, res, { companyId: view.companyId, confidence: view.confidence, riskLevel: view.riskLevel, verificationStatus: view.verificationStatus }, "?recalculated=1");
    } catch (error) { next(error); }
  });

  router.post("/api/admin/business/recalculate-bulk", configured, apiAuth, requireCsrf, async (req, res, next) => {
    try {
      const { views } = await loadState();
      const scope = String(req.body?.scope ?? "all");
      const selected = scope === "stale" ? views.filter(v => v.freshness === "stale") : scope === "conflicts" ? views.filter(v => v.hasConflict) : views;
      const distribution = { high: 0, medium: 0, low: 0 };
      for (const v of selected) distribution[v.riskLevel]++;
      await writeAudit(repository, res.locals.adminUser, "bulk_recalculate", null, null, { scope, count: selected.length, distribution });
      respond(req, res, { count: selected.length, distribution });
    } catch (error) { next(error); }
  });

  router.post("/api/admin/business/companies/manual", configured, apiAuth, requireCsrf, async (req, res, next) => {
    try {
      const companyName = String(req.body?.companyName ?? "").trim();
      if (!companyName) throw new ApiError(400, "INVALID_INPUT", "companyName is required");
      const { normalized, legalTypeGuess } = normalizeCompanyName(companyName);
      const registrationNumberRaw = stringParam(req.body?.registrationNumber);
      const governorateRaw = stringParam(req.body?.governorate);
      const governorate = governorateRaw ? resolveGovernorateName(governorateRaw) : null;
      const adminUser = res.locals.adminUser as string;
      const record: CompanyRecordInput = {
        companyName, normalizedName: normalized, nameAr: null, nameEn: null,
        registrationNumber: registrationNumberRaw ?? null, legalType: legalTypeGuess,
        status: null, registrationDate: null, industry: stringParam(req.body?.industry) ?? null, activities: [],
        governorate, wilayat: null, area: null, address: null, website: null, email: null, phone: null,
        vatNumber: null, vatStatus: null, employeeRange: null, estimatedCompanySize: null,
        sourceType: "admin_manual", sourceName: `Admin manual entry (${adminUser})`, sourceRecordId: null, sourceUrl: null,
        observedAt: new Date().toISOString(), metadata: stringParam(req.body?.note) ? { note: req.body.note } : {},
        verificationStatus: "reported", lastVerifiedAt: null
      };
      const newCompanyId = randomUUID();
      const created = await repository.attachSourceRecord(newCompanyId, record);
      await writeAudit(repository, adminUser, "manual_company_created", "company", created.companyId, { companyName });
      respond(req, res, { companyId: created.companyId });
    } catch (error) { next(error); }
  });

  router.post("/api/admin/business/evidence", configured, apiAuth, requireCsrf, async (req, res, next) => {
    try {
      const companyId = String(req.body?.companyId ?? "");
      const field = String(req.body?.field ?? "");
      const value = String(req.body?.value ?? "").trim();
      const sourceName = String(req.body?.sourceName ?? "").trim();
      const ALLOWED_FIELDS = new Set(["status", "industry", "governorate", "wilayat", "address", "website", "email", "phone", "employeeRange", "legalType"]);
      if (!companyId || !ALLOWED_FIELDS.has(field) || !value || !sourceName) throw new ApiError(400, "INVALID_INPUT", "companyId, a supported field, value and sourceName are required");
      const observedAtRaw = stringParam(req.body?.observedAt);
      const observedAtMs = observedAtRaw ? Date.parse(observedAtRaw) : Date.now();
      if (!Number.isFinite(observedAtMs) || observedAtMs > Date.now() + 86_400_000) throw new ApiError(400, "INVALID_INPUT", "observedAt must be a valid date, not in the future");
      if (field === "status" && !(COMPANY_STATUSES as readonly string[]).includes(value)) throw new ApiError(400, "INVALID_INPUT", `status must be one of ${COMPANY_STATUSES.join(", ")}`);
      const existing = await repository.findByCompanyId(companyId);
      if (existing.length === 0) throw new ApiError(404, "COMPANY_NOT_FOUND", "No company found with that id");
      const rep = existing[0]!;
      const note = stringParam(req.body?.note);
      const record: CompanyRecordInput = {
        companyName: rep.companyName, normalizedName: rep.normalizedName, nameAr: null, nameEn: null,
        registrationNumber: null, legalType: field === "legalType" ? value : null, status: field === "status" ? (value as CompanyRecordInput["status"]) : null,
        registrationDate: null, industry: field === "industry" ? value : null, activities: [],
        governorate: field === "governorate" ? (resolveGovernorateName(value) ?? value) : null, wilayat: field === "wilayat" ? value : null,
        area: null, address: field === "address" ? value : null, website: field === "website" ? value : null,
        email: field === "email" ? value : null, phone: field === "phone" ? value : null,
        vatNumber: null, vatStatus: null, employeeRange: field === "employeeRange" ? value : null, estimatedCompanySize: null,
        sourceType: "admin_manual", sourceName, sourceRecordId: stringParam(req.body?.sourceRecordId) ?? null, sourceUrl: null,
        observedAt: new Date(observedAtMs).toISOString(), metadata: note ? { note } : {},
        verificationStatus: "reported", lastVerifiedAt: null
      };
      await repository.attachSourceRecord(companyId, record);
      await writeAudit(repository, res.locals.adminUser, "manual_evidence_added", "company", companyId, { field, sourceName });
      respond(req, res, { companyId, field });
    } catch (error) { next(error); }
  });

  // ---- Import Center (Sections 8/9/10/11/30) ----------------------------------------------------

  router.post("/api/admin/business/imports/preview", configured, apiAuth, async (req, res, next) => {
    try {
      const source = String(req.body?.source ?? "");
      const fileName = String(req.body?.fileName ?? "");
      const content = req.body?.content;
      if (!(IMPORT_SOURCE_NAMES as readonly string[]).includes(source)) throw new ApiError(400, "INVALID_SOURCE", `source must be one of ${IMPORT_SOURCE_NAMES.join(", ")}`);
      if (typeof content !== "string" || content.length === 0) throw new ApiError(400, "INVALID_INPUT", "content is required");
      if (Buffer.byteLength(content, "utf8") > MAX_IMPORT_FILE_BYTES) throw new ApiError(413, "PAYLOAD_TOO_LARGE", `File exceeds the ${MAX_IMPORT_FILE_BYTES}-byte import limit`);
      const rows = parseImportFile(fileName, content);
      if (rows.length > MAX_IMPORT_ROWS) throw new ApiError(400, "TOO_MANY_ROWS", `Import batch exceeds the maximum of ${MAX_IMPORT_ROWS} rows`);

      // Seed a scratch repository with any real companies sharing a registration number in this
      // batch, so preview can report accurate matched-vs-new/duplicate counts (Section 10) rather
      // than always reporting everything as "new" against an empty scratch copy.
      const scratch = new MemoryCompanyRepository();
      const regNumbers = new Set(rows.map(extractRegistrationNumber).filter((v): v is string => Boolean(v)));
      if (regNumbers.size > 0) {
        const existing = (await repository.adminListAllRows()).filter(r => r.registrationNumber && regNumbers.has(r.registrationNumber));
        for (const r of existing) await scratch.attachSourceRecord(r.companyId, r);
      }
      const before = new Set((await scratch.adminListAllRows()).map(r => r.companyId));
      const result = await runSourceImport(source, rows, scratch);
      const afterRows = await scratch.adminListAllRows();
      const afterCompanyIds = new Set(afterRows.map(r => r.companyId));
      const newCompanies = Math.max(0, afterCompanyIds.size - before.size);
      const matchedCompanies = Math.max(0, result.imported - newCompanies);
      const previewViews = buildCompanyViews(afterRows, []);
      const identityConflicts = previewViews.filter(v => v.hasConflict).length;

      const warnings: string[] = [
        "Preview validates and normalizes rows in isolation against a scratch copy seeded only with companies sharing a registration number in this file — it does not reflect the full live dataset."
      ];
      if (regNumbers.size === 0) warnings.push("No registration numbers were found in this file — preview cannot detect matches against existing companies for rows without one.");
      if (source === "tender-board-awards") warnings.push("Award rows can only resolve if a company with a matching registration number already exists in the live dataset — import MOCIIP/supplier data for these companies first if awards fail to resolve on real execution.");

      const sample = rows.slice(0, 5).map(row => ({ input: row, normalized: sampleNormalize(source, row) }));

      send(res, {
        source, fileName, totalRows: result.totalRows, validRows: result.totalRows - result.errors.length, invalidRows: result.errors.length,
        newCompanies, matchedCompanies, recordsToUpdate: result.updated, duplicatesSkipped: result.skipped, identityConflicts,
        warnings, sample, rejected: result.errors, previewToken: previewTokenFor(source, content)
      });
    } catch (error) { next(error); }
  });

  router.post("/api/admin/business/imports/execute", configured, apiAuth, requireCsrf, async (req, res, next) => {
    const source = String(req.body?.source ?? "");
    const fileName = String(req.body?.fileName ?? "");
    const content = req.body?.content;
    const adminUser = res.locals.adminUser as string;
    let runId: string | null = null;
    try {
      if (!(IMPORT_SOURCE_NAMES as readonly string[]).includes(source)) throw new ApiError(400, "INVALID_SOURCE", `source must be one of ${IMPORT_SOURCE_NAMES.join(", ")}`);
      if (typeof content !== "string" || content.length === 0) throw new ApiError(400, "INVALID_INPUT", "content is required");
      if (Buffer.byteLength(content, "utf8") > MAX_IMPORT_FILE_BYTES) throw new ApiError(413, "PAYLOAD_TOO_LARGE", `File exceeds the ${MAX_IMPORT_FILE_BYTES}-byte import limit`);
      const expectedToken = previewTokenFor(source, content);
      if (req.body?.previewToken !== expectedToken) {
        throw new ApiError(409, "PREVIEW_REQUIRED", "This file has not been previewed (or has changed since preview) — run Preview again before executing.");
      }
      const rows = parseImportFile(fileName, content);
      if (rows.length > MAX_IMPORT_ROWS) throw new ApiError(400, "TOO_MANY_ROWS", `Import batch exceeds the maximum of ${MAX_IMPORT_ROWS} rows`);

      runId = await repository.startSyncRun(source);
      const result = await runSourceImport(source, rows, repository);
      await repository.finishSyncRun(runId, {
        status: "succeeded", recordsSeen: result.totalRows, recordsInserted: result.imported,
        recordsUpdated: result.updated, recordsSkipped: result.skipped,
        errorMessage: result.errors.length > 0 ? `${result.errors.length} row(s) had errors` : null
      });

      if (result.errors.length > 0) {
        await repository.recordUnmatched(result.errors.map(e => ({
          sourceType: sourceTypeForImportSource(source), sourceName: `Admin import (${source})`,
          rawPayload: (rows[e.row - 1] as Record<string, unknown>) ?? {}, reason: classifyUnmatchedReason(e.reason), reasonDetail: e.reason
        })));
      }

      await writeAudit(repository, adminUser, "import_executed", "sync_run", runId, {
        source, fileName, totalRows: result.totalRows, imported: result.imported, updated: result.updated, skipped: result.skipped, errorCount: result.errors.length
      });
      respond(req, res, { runId, ...result });
    } catch (error) {
      if (runId) {
        const message = error instanceof Error ? error.message : String(error);
        await repository.finishSyncRun(runId, { status: "failed", recordsSeen: 0, recordsInserted: 0, recordsUpdated: 0, recordsSkipped: 0, errorMessage: message }).catch(() => {});
        await writeAudit(repository, adminUser, "import_failed", "sync_run", runId, { source, fileName });
      }
      next(error);
    }
  });

  router.get("/api/admin/business/imports", configured, apiAuth, async (_req, res, next) => {
    try { send(res, await repository.findAllSyncRuns(200)); } catch (error) { next(error); }
  });

  // ---- Conflicts (Section 14) -------------------------------------------------------------------

  router.get("/api/admin/business/conflicts", configured, apiAuth, async (_req, res, next) => {
    try { const { views } = await loadState(); send(res, conflictQueue(views)); } catch (error) { next(error); }
  });

  router.post("/api/admin/business/conflicts/:companyId/resolve", configured, apiAuth, requireCsrf, async (req, res, next) => {
    try {
      const action = String(req.body?.action ?? "");
      const rowId = stringParam(req.body?.rowId) ?? null;
      const note = stringParam(req.body?.note) ?? null;
      const { views } = await loadState();
      const view = views.find(v => v.companyId === req.params.companyId);
      if (!view) throw new ApiError(404, "COMPANY_NOT_FOUND", "No company found with that id");
      const adminUser = res.locals.adminUser as string;

      if (action === "kept_separate") {
        if (!rowId) throw new ApiError(400, "INVALID_INPUT", "Select a row to split out for \"Keep separate\"");
        const row = await repository.findRowById(rowId);
        if (!row || row.companyId !== view.companyId) throw new ApiError(400, "INVALID_INPUT", "That row does not belong to this company");
        const newCompanyId = randomUUID();
        await repository.relinkRow(rowId, newCompanyId);
        await repository.setAdminRowFlag(rowId, "kept_separate", note);
      } else if (action === "rejected") {
        if (!rowId) throw new ApiError(400, "INVALID_INPUT", "Select a row to flag as incorrect");
        const row = await repository.findRowById(rowId);
        if (!row || row.companyId !== view.companyId) throw new ApiError(400, "INVALID_INPUT", "That row does not belong to this company");
        await repository.setAdminRowFlag(rowId, "rejected", note);
      } else if (action === "reviewed" || action === "confirmed_same" || action === "needs_verification") {
        for (const r of view.activeRows) await repository.setAdminRowFlag(r.id, action as AdminRowFlag, note);
      } else {
        throw new ApiError(400, "INVALID_INPUT", 'action must be one of "reviewed", "confirmed_same", "kept_separate", "rejected", "needs_verification"');
      }
      await writeAudit(repository, adminUser, "conflict_resolved", "company", view.companyId, { action, rowId });
      respond(req, res, { companyId: view.companyId, action });
    } catch (error) { next(error); }
  });

  router.post("/api/admin/business/companies/:companyId/flag", configured, apiAuth, requireCsrf, async (req, res, next) => {
    try {
      const rowId = String(req.body?.rowId ?? "");
      const flag = String(req.body?.flag ?? "");
      if (!rowId) throw new ApiError(400, "INVALID_INPUT", "rowId is required");
      const row = await repository.findRowById(rowId);
      if (!row || row.companyId !== req.params.companyId) throw new ApiError(400, "INVALID_INPUT", "That row does not belong to this company");
      await repository.setAdminRowFlag(rowId, (flag || null) as AdminRowFlag | null, stringParam(req.body?.note) ?? null);
      await writeAudit(repository, res.locals.adminUser, "row_flag_set", "row", rowId, { flag, companyId: req.params.companyId });
      respond(req, res, { rowId, flag });
    } catch (error) { next(error); }
  });

  // ---- Stale / Review (Sections 15/16) -----------------------------------------------------------

  router.get("/api/admin/business/stale", configured, apiAuth, async (_req, res, next) => {
    try { const { allRows } = await loadState(); send(res, staleQueue(allRows)); } catch (error) { next(error); }
  });

  router.get("/api/admin/business/review", configured, apiAuth, async (_req, res, next) => {
    try { const { views } = await loadState(); send(res, reviewQueue(views)); } catch (error) { next(error); }
  });

  // ---- Tax Oman manual verification (Section 12/13) -----------------------------------------------

  const TAX_OUTCOMES = new Set(["verified", "not_registered", "pending", "unknown"]);

  router.get("/api/admin/business/tax-verification", configured, apiAuth, async (_req, res, next) => {
    try { const { views } = await loadState(); send(res, taxVerificationQueue(views)); } catch (error) { next(error); }
  });

  router.post("/api/admin/business/tax-verification/:companyId", configured, apiAuth, requireCsrf, async (req, res, next) => {
    try {
      const outcome = String(req.body?.outcome ?? "");
      if (!TAX_OUTCOMES.has(outcome)) throw new ApiError(400, "INVALID_INPUT", `outcome must be one of ${[...TAX_OUTCOMES].join(", ")}`);
      const observedAtRaw = stringParam(req.body?.observedAt) ?? new Date().toISOString();
      const rows = await repository.findByCompanyId(String(req.params.companyId));
      if (rows.length === 0) throw new ApiError(404, "COMPANY_NOT_FOUND", "No company found with that id");
      const rep = rows[0]!;
      // Section 12: this action MUST use the existing Tax Oman ingestion/normalization path, never
      // a hand-rolled record — normalizeTaxOmanRecord is the exact function taxOmanProvider.ts's
      // batch importer calls per row.
      const raw: TaxOmanRawRecord = {
        registrationNumber: rep.registrationNumber ?? undefined, companyName: rep.companyName,
        vatNumber: stringParam(req.body?.vatNumber), taxVerificationStatus: outcome as TaxOmanRawRecord["taxVerificationStatus"],
        observedAt: observedAtRaw
      };
      const normalized = normalizeTaxOmanRecord(raw, 1, DEFAULT_TAX_OMAN_SOURCE_NAME);
      if ("error" in normalized) throw new ApiError(400, "INVALID_INPUT", normalized.error.reason);
      const note = stringParam(req.body?.note);
      if (note) normalized.record.metadata = { ...normalized.record.metadata, note };
      await repository.attachSourceRecord(String(req.params.companyId), normalized.record);
      await writeAudit(repository, res.locals.adminUser, "tax_verification_recorded", "company", String(req.params.companyId), { outcome });
      respond(req, res, { companyId: String(req.params.companyId), outcome });
    } catch (error) { next(error); }
  });

  // ---- Unmatched records (Section 19) ------------------------------------------------------------

  router.get("/api/admin/business/unmatched", configured, apiAuth, async (req, res, next) => {
    try {
      const status = stringParam(req.query.status) as Parameters<CompanyRepository["listUnmatched"]>[0];
      send(res, await repository.listUnmatched(status, 500));
    } catch (error) { next(error); }
  });

  router.post("/api/admin/business/unmatched/:id/resolve", configured, apiAuth, requireCsrf, async (req, res, next) => {
    try {
      const status = String(req.body?.status ?? "");
      if (!["linked", "rejected", "created"].includes(status)) throw new ApiError(400, "INVALID_INPUT", 'status must be one of "linked", "rejected", "created"');
      const linkedCompanyId = stringParam(req.body?.linkedCompanyId) ?? null;
      if (status === "linked" && !linkedCompanyId) throw new ApiError(400, "INVALID_INPUT", "linkedCompanyId is required to link an unmatched record");
      if (linkedCompanyId) {
        const rows = await repository.findByCompanyId(linkedCompanyId);
        if (rows.length === 0) throw new ApiError(400, "INVALID_INPUT", "No company found with the given linkedCompanyId");
      }
      await repository.resolveUnmatched(String(req.params.id), {
        status: status as "linked" | "rejected" | "created", linkedCompanyId,
        note: stringParam(req.body?.note) ?? null, resolvedBy: res.locals.adminUser
      });
      await writeAudit(repository, res.locals.adminUser, "unmatched_resolved", "unmatched_record", String(req.params.id), { status, linkedCompanyId });
      respond(req, res, { id: String(req.params.id), status });
    } catch (error) { next(error); }
  });

  // ---- Procurement / Awards (Sections 17/18) -----------------------------------------------------

  router.get("/api/admin/business/procurement", configured, apiAuth, async (_req, res, next) => {
    try {
      const { views, allAwards, allRows, syncRuns } = await loadState();
      send(res, computeProcurementStats(views, allAwards, allRows, syncRuns));
    } catch (error) { next(error); }
  });

  router.get("/api/admin/business/awards", configured, apiAuth, async (req, res, next) => {
    try {
      let awards = [...(await repository.adminListAllAwards())];
      const buyer = stringParam(req.query.buyer);
      const category = stringParam(req.query.category);
      if (buyer) awards = awards.filter(a => a.buyer?.toLowerCase().includes(buyer.toLowerCase()));
      if (category) awards = awards.filter(a => a.category?.toLowerCase().includes(category.toLowerCase()));
      send(res, awards.slice(0, 500));
    } catch (error) { next(error); }
  });

  // ---- Data quality / sources / system / audit (Sections 23/26/27/29) -----------------------------

  router.get("/api/admin/business/data-quality", configured, apiAuth, async (_req, res, next) => {
    try {
      const { views } = await loadState();
      const unresolvedUnmatched = (await repository.listUnmatched("unresolved", 5000)).length;
      send(res, { stats: computeDataQuality(views, unresolvedUnmatched), coverage: computeCoverageBreakdowns(views) });
    } catch (error) { next(error); }
  });

  router.get("/api/admin/business/sources", configured, apiAuth, async (_req, res, next) => {
    try {
      const { allRows, allAwards, syncRuns } = await loadState();
      send(res, computeSourceCoverage(allRows, allAwards, syncRuns));
    } catch (error) { next(error); }
  });

  router.get("/api/admin/business/system", configured, apiAuth, async (_req, res, next) => {
    try { send(res, await buildSystemStatus()); } catch (error) { next(error); }
  });

  router.get("/api/admin/business/audit", configured, apiAuth, async (req, res, next) => {
    try {
      const limit = req.query.limit ? Number(req.query.limit) : 200;
      send(res, await repository.listAuditLog({ limit, action: stringParam(req.query.action), entityType: stringParam(req.query.entityType) }));
    } catch (error) { next(error); }
  });

  return router;
}
