import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import { randomUUID } from "node:crypto";
import type { Config } from "../config/env.js";
import { apiKeyAuth } from "../middleware/auth.js";
import { ApiError, publicError } from "../utils/errors.js";
import { createLogger, type Logger } from "../utils/logging.js";
import { disabledBilling, prices, type BillingGate, type CapabilityName } from "../billing/catalog.js";
import { BillingService } from "../billing/service.js";
import { buildX402Gate, buildX402Info, buildX402Status, x402BasePath } from "../billing/x402.js";
import { capabilities } from "../domain/capabilities.js";
import { agentBasePath, buildAgentInfo, buildCapabilitiesRegistry, buildPricingInfo, buildToolCatalog, capabilitiesBasePath, pricingBasePath, toolsBasePath } from "./agent.js";
import { createPreviewRoutes, previewBasePath } from "./previewRoutes.js";
import { buildAgentCard, buildAgentManifest, buildAiPluginManifest } from "./manifest.js";
import { buildLlmsTxt } from "./llms-txt.js";
import { landingHtml } from "./landing.js";
import { buildOpenapi } from "./openapi.js";
import { swaggerContentSecurityPolicy, swaggerHtml } from "./swagger.js";
import { createRateLimiter, disabledRateLimiter } from "../middleware/rateLimit.js";
import { buildMcpStatus, createRemoteMcpHandler, mcpRemotePath, mcpStatusBasePath } from "../mcp/remote.js";
import type { CustomerStore, Principal } from "../db/store.js";
import type { PropertyMarketRepository } from "../domain/oman/marketRepository.js";
import type { PartnerRepository } from "../domain/oman/partners.js";
import { PostgresPropertyMarketRepository } from "../db/marketStore.js";
import { PostgresPartnerRepository } from "../db/partnerStore.js";
import { getMarketDataInternalApiKey, getPartnerFeedStaleDays, getOmanMarketDatabaseUrl } from "../domain/oman/config.js";
import type { PartnerIngestionAuditRepository } from "../domain/oman/partnerAudit.js";
import { PostgresPartnerIngestionAuditRepository } from "../db/partnerAuditStore.js";
import { createMarketDataRoutes } from "./marketDataRoutes.js";
import type { CompanyRepository } from "../business-data/sources/companyRepository.js";
import { PostgresCompanyRepository } from "../db/businessStore.js";
import { getOmanBusinessDatabaseUrl } from "../business-data/config.js";
import { createAdminRoutes } from "./adminRoutes.js";
import type { AnalyticsRepository, DataSource } from "../analytics/types.js";
import { MemoryAnalyticsRepository } from "../analytics/memoryRepository.js";
import { PostgresAnalyticsRepository } from "../db/analyticsStore.js";
import { getAnalyticsDatabaseUrl, getAnalyticsInternalApiKey } from "../analytics/config.js";
import { createAnalyticsRoutes } from "./analyticsRoutes.js";
import { classifyDataSource } from "../analytics/dataSource.js";
import { extractClientContext } from "../analytics/attribution.js";
import { recordDiscoveryHit, recordToolInvocation, recordX402Event, classifyX402Outcome, decodeX402SettlementHeader } from "../analytics/recorder.js";
import type { RevenueLedger } from "../revenue/types.js";
import { MemoryRevenueLedger } from "../revenue/memoryLedger.js";
import { PostgresRevenueLedger } from "../db/revenueStore.js";
import { getRevenueDatabaseUrl, getRevenueInternalApiKey } from "../revenue/config.js";
import { createRevenueRoutes } from "./revenueRoutes.js";
import { decodeX402SettlementMetadata, buildSettlementRecord, recordSettlement } from "../revenue/settlementCapture.js";
import { createDashboardRoutes } from "./dashboardRoutes.js";
import { buildL402Info, buildL402Status, createL402Gate, l402BasePath } from "../billing/l402/gate.js";
import { LndRestBackend, type LightningBackend } from "../billing/l402/lightning.js";
import { VoltagePaymentsBackend } from "../billing/l402/voltage.js";
import { PublicBtcUsdRateProvider, type BtcUsdRateProvider } from "../billing/l402/rates.js";
import { MemoryL402RedemptionStore, PostgresL402RedemptionStore, type L402RedemptionStore } from "../billing/l402/redemptions.js";
import { buildL402SettlementRecord } from "../billing/l402/settlement.js";
import { recordL402Event } from "../analytics/recorder.js";
import { createMppMcpHandler, mppMcpPath } from "../billing/mpp/mcp.js";
import { buildMppService, buildMppInfo, buildMppStatus, createMppDisabledRoutes, createMppRoutes, createMppSessionCreateLimiter, mppBasePath, type MppAuditSink, type MppProvider, type MppSessionRepository, type MppChargeRedemptionStore, type MppKv, type MppService } from "../billing/mpp/index.js";
/** The largest per-capability JSON body limit (bytes → body-parser string), for shared endpoints. */
function maxCapabilityBodyLimit(): string {
  const toBytes = (l: string) => { const m = /^(\d+(?:\.\d+)?)\s*(kb|mb)$/i.exec(l.trim()); return m ? Number(m[1]) * (m[2]!.toLowerCase() === "mb" ? 1024 * 1024 : 1024) : 32 * 1024; };
  const max = Math.max(32 * 1024, ...capabilities.map(c => (c.requestBodyLimit ? toBytes(c.requestBodyLimit) : 0)));
  return `${Math.round(max / 1024)}kb`;
}
function formatBytes(n: number): string { return n >= 1024 * 1024 ? `${Math.round(n / 1024 / 1024 * 10) / 10}mb` : `${Math.round(n / 1024)}kb`; }

export function createApp(config: Config, options: { logger?: Logger; billing?: BillingGate; billingService?: BillingService; rateLimiter?: RequestHandler; store?: CustomerStore; marketRepository?: PropertyMarketRepository; partnerRepository?: PartnerRepository; ingestionAuditRepository?: PartnerIngestionAuditRepository; businessRepository?: CompanyRepository; analyticsRepository?: AnalyticsRepository; revenueLedger?: RevenueLedger; l402Backend?: LightningBackend; l402Rates?: BtcUsdRateProvider; l402Redemptions?: L402RedemptionStore; l402Now?: () => number; mppProvider?: MppProvider; mppSessions?: MppSessionRepository; mppRedemptions?: MppChargeRedemptionStore; mppKv?: MppKv; mppAudit?: MppAuditSink; mppNow?: () => Date } = {}) {
  if (config.authMode === "postgres" && !options.store) throw new Error("PostgreSQL customer store required");
  const store = config.authMode === "postgres" ? options.store : undefined;
  const app = express();
  const logger = options.logger ?? createLogger(config.logLevel);
  const billing = options.billing ?? disabledBilling;
  // Section D/E: usage tracking + centralized pricing/billing decisions. Defaults to an
  // in-memory, side-effect-free repository (safe for tests and for createApp() in general);
  // src/server.ts wires a ConsoleUsageRepository for real deployments so usage is visible in logs.
  const billingService = options.billingService ?? new BillingService();
  // Internal analytics layer (Section: discovery/MCP/x402/tool-usage tracking — see
  // src/api/analyticsRoutes.ts). Always constructed, unlike marketRepository/businessRepository
  // below: recording itself must always work (defaulting to an in-process
  // MemoryAnalyticsRepository, exactly like MemoryUsageRepository does for billing usage) even
  // when no database is configured — only the internal-key-gated read routes can ever surface
  // it, and they 503 on their own when unconfigured (requireInternalAuth).
  const analyticsDatabaseUrl = getAnalyticsDatabaseUrl();
  const analyticsRepository: AnalyticsRepository = options.analyticsRepository
    ?? (analyticsDatabaseUrl ? new PostgresAnalyticsRepository(analyticsDatabaseUrl) : new MemoryAnalyticsRepository());
  // Revenue ledger (Section: trustworthy x402 settlement accounting — see
  // src/api/revenueRoutes.ts, src/revenue/types.ts). Always constructed, same reasoning as
  // analyticsRepository above: recording must always work even with no database configured; only
  // the internal-key-gated read routes can ever surface it. Deliberately a SEPARATE store from
  // analyticsRepository — see revenue/types.ts's doc comment for why analytics is never the
  // accounting source of truth.
  const revenueDatabaseUrl = getRevenueDatabaseUrl();
  const revenueLedger: RevenueLedger = options.revenueLedger
    ?? (revenueDatabaseUrl ? new PostgresRevenueLedger(revenueDatabaseUrl) : new MemoryRevenueLedger());
  const openapiDoc = buildOpenapi(config);
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const start = performance.now();
    res.locals.startedAt = start;
    res.locals.requestId = randomUUID();
    res.setHeader("X-Request-ID", res.locals.requestId);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    // CORS: every route here is either public discovery/pricing data, or authorizes itself via
    // a header (X-API-Key, X-PAYMENT) rather than an ambient cookie/session, so a permissive
    // origin is safe — no credentialed browser state can be exfiltrated cross-origin this way.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    // MCP-Protocol-Version and Mcp-Session-Id are the Streamable HTTP transport's own headers
    // (see mcp/remote.ts); Last-Event-ID supports SSE resumption. Mcp-Session-Id is exposed so a
    // browser-based MCP client can read it back (this deployment runs stateless, so the header
    // is normally absent, but a client should not have to special-case that).
    // Authorization carries an L402 token (macaroon:preimage) — like X-PAYMENT, a per-request
    // credential, never an ambient cookie, so the permissive origin above stays safe.
    // Payment-Authorization / Idempotency-Key: MPP credentials (alternative header) and session
    // call idempotency keys — per-request values, never ambient browser state.
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-API-Key, X-PAYMENT, Authorization, Payment-Authorization, Idempotency-Key, MCP-Protocol-Version, Mcp-Session-Id, Last-Event-ID");
    // WWW-Authenticate carries the L402 challenge (macaroon + invoice); a browser client must be
    // able to read it back.
    res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id, WWW-Authenticate, X-L402-Error, PAYMENT-REQUIRED, X-PAYMENT-RESPONSE, Payment-Receipt, Idempotent-Replay");
    res.setHeader("Access-Control-Max-Age", "600");
    res.on("finish", () => {
      const durationMs = Math.round((performance.now() - start) * 100) / 100;
      // Only log matched route templates; paths and query strings may contain customer data.
      logger({ timestamp: new Date().toISOString(), requestId: res.locals.requestId,
        endpoint: req.route?.path ?? "unmatched", status: res.statusCode, durationMs });
      // Section D: record usage for capability ("tool") invocations only — set by the per-tool
      // route handlers below, on both the REST and x402 route families, for every outcome
      // (success, validation error, auth failure, rate limit) since res.on("finish") always
      // fires with the final status code. keyIdentifier is never the raw API key or a wallet
      // secret: it is either the existing redacted customerId, or an x402 channel/network tag.
      const toolName = res.locals.toolName as CapabilityName | undefined;
      if (toolName) {
        const channel = res.locals.channel as string | undefined;
        const accessMode = channel === "x402" || channel === "l402" || channel === "mpp" || channel === "mpp-session" ? channel : "api-key";
        const keyIdentifier = accessMode === "x402" ? `x402:${config.x402Network}`
          : accessMode === "l402" ? `l402:lightning:${config.l402Network}`
          : accessMode === "mpp" || accessMode === "mpp-session" ? `${accessMode}:${config.mpp.tempo.network}`
          : (res.locals.customerId as string | undefined) ?? "anonymous";
        void billingService.recordUsage({
          requestId: res.locals.requestId, keyIdentifier, toolName, accessMode, status: res.statusCode, durationMs,
          billableAmount: billingService.isBillable(toolName) ? billingService.getToolPrice(toolName) : 0, currency: "USD"
        });
        // Internal analytics (TOOL USAGE domain): one row per REST/x402 capability invocation —
        // remote MCP invocations are recorded separately (mcp/remote.ts), since they never reach
        // this Express middleware chain at all. `dataSource` is set by the capability handler
        // itself right after execute() (see below) — classifyDataSource() reads it straight off
        // the already-computed response, never a second execute() call.
        recordToolInvocation(analyticsRepository, {
          toolName, channel: accessMode === "api-key" ? "rest" : accessMode, success: res.statusCode < 400, durationMs,
          dataSource: (res.locals.dataSource as DataSource | undefined) ?? null,
          client: extractClientContext(req)
        });
      }
    });
    if (req.method === "OPTIONS") { res.status(204).end(); return; }
    next();
  });
  const send = (res: express.Response, data: unknown) => res.json({ success: true, data, meta: { requestId: res.locals.requestId } });
  // Section 5: per-process, IP-keyed rate limiting for public, unauthenticated agent traffic —
  // one independent limiter per route group (discovery, x402, remote MCP) so a burst against
  // one group never exhausts another's budget. See middleware/rateLimit.ts for what "reasonable
  // default" means here and its known limits on a multi-instance serverless deployment.
  const rateLimitOptions = { windowMs: config.rateLimitWindowMs, max: config.rateLimitMax };
  const discoveryLimiter = config.rateLimitEnabled ? createRateLimiter(rateLimitOptions) : disabledRateLimiter;
  const x402Limiter = config.rateLimitEnabled ? createRateLimiter(rateLimitOptions) : disabledRateLimiter;
  const mcpLimiter = config.rateLimitEnabled ? createRateLimiter(rateLimitOptions) : disabledRateLimiter;
  const l402Limiter = config.rateLimitEnabled ? createRateLimiter(rateLimitOptions) : disabledRateLimiter;
  const mppLimiter = config.rateLimitEnabled ? createRateLimiter(rateLimitOptions) : disabledRateLimiter;
  const ingestionLimiter = config.rateLimitEnabled ? createRateLimiter(rateLimitOptions) : disabledRateLimiter;
  // Free Preview (src/preview/): its own independent rate-limiter instance, exactly like every
  // other route group above — an unauthenticated preview burst can never exhaust another group's
  // budget (or vice versa).
  const previewLimiter = config.rateLimitEnabled ? createRateLimiter(rateLimitOptions) : disabledRateLimiter;
  // Vercel's Node runtime does not set Express's "trust proxy", so req.protocol stays "http"
  // behind TLS termination; read X-Forwarded-Proto directly instead so /agent.json and the
  // two /.well-known manifests always report the URL the caller actually reached us on.
  const getOrigin = (req: express.Request) => `${(req.header("x-forwarded-proto") ?? req.protocol).split(",")[0]}://${req.get("host")}`;
  const sendToolResult = (res: express.Response, data: unknown, toolName: CapabilityName) =>
    res.json({ success: true, data, meta: { requestId: res.locals.requestId, tool: toolName, price: prices[toolName], currency: "USD" } });
  const discoveryData = {
    name: "Rafid Agent API", version: "0.1.0", docs: "/docs",
    openapi: "/openapi.json", health: "/api/v1/health",
    agent: agentBasePath, pricing: pricingBasePath, tools: toolsBasePath,
    ...(config.x402Enabled ? { x402: x402BasePath } : {}),
    ...(config.l402Enabled ? { l402: l402BasePath } : {}),
    ...(config.mpp.enabled ? { mpp: mppBasePath } : {}),
    endpoints: capabilities.map(c => "/api/v1" + c.path)
  };
  // Section I: browsers get a landing page; machine/agent clients that ask for JSON (the
  // pre-existing behavior) keep getting the discovery payload unchanged.
  app.get("/", discoveryLimiter, (req, res) => {
    if (req.accepts(["html", "json"]) === "json") return send(res, discoveryData);
    res.type("html").send(landingHtml(config));
  });
  for (const path of ["/health", "/api/v1/health"]) app.get(path, (_req, res) => send(res, { ok: true }));
  // Internal analytics DISCOVERY tracking: exactly the 7 surfaces the spec names (see
  // analytics/recorder.ts's DISCOVERY_PATHS) — "/mcp" is recorded separately, inside
  // mcp/remote.ts's handler, since it lives on its own route family below. Deliberately NOT
  // added to every discovery-ish endpoint (e.g. /api/v1/agent, /api/v1/pricing, /.well-known/
  // ai-plugin.json, /api/v1/mcp/status) — only the ones actually named.
  app.get("/openapi.json", (req, res) => { recordDiscoveryHit(analyticsRepository, req, "/openapi.json"); res.json(openapiDoc); });
  app.get("/docs", (_req, res) => {
    res.setHeader("Content-Security-Policy", swaggerContentSecurityPolicy);
    res.type("html").send(swaggerHtml);
  });
  // Section A/B/C: public, unauthenticated agent-marketplace discovery. Always available
  // regardless of X402_ENABLED so an agent can learn how to pay before it decides to.
  app.get(agentBasePath, discoveryLimiter, (_req, res) => send(res, buildAgentInfo(config)));
  app.get(pricingBasePath, discoveryLimiter, (_req, res) => send(res, buildPricingInfo()));
  app.get(toolsBasePath, discoveryLimiter, (req, res) => { recordDiscoveryHit(analyticsRepository, req, toolsBasePath); send(res, buildToolCatalog()); });
  // Machine-first capability registry (Section 8/13): the same data /agent.json's `tools`
  // field carries, exposed on its own path so a caller that only wants tool metadata doesn't
  // have to fetch the full manifest.
  app.get(capabilitiesBasePath, discoveryLimiter, (req, res) => { recordDiscoveryHit(analyticsRepository, req, capabilitiesBasePath); send(res, buildCapabilitiesRegistry(config)); });
  // Top-level agent discovery manifests. Unauthenticated, GET-only, and — like every other
  // discovery endpoint here — read straight from the shared capability registry.
  app.get("/agent.json", discoveryLimiter, (req, res) => { recordDiscoveryHit(analyticsRepository, req, "/agent.json"); res.json(buildAgentManifest(config)); });
  app.get("/.well-known/ai-plugin.json", discoveryLimiter, (req, res) => res.json(buildAiPluginManifest(config, getOrigin(req))));
  app.get("/.well-known/agent.json", discoveryLimiter, (req, res) => { recordDiscoveryHit(analyticsRepository, req, "/.well-known/agent.json"); res.json(buildAgentCard(config, getOrigin(req))); });
  app.get("/llms.txt", discoveryLimiter, (req, res) => { recordDiscoveryHit(analyticsRepository, req, "/llms.txt"); res.type("text/plain").send(buildLlmsTxt(config)); });
  // GET /api/v1/mcp/status — always mounted (independent of MCP_REMOTE_ENABLED, like
  // /api/v1/x402/status is independent of X402_ENABLED), so a caller can check whether the
  // remote transport is live without guessing from a manifest.
  app.get(mcpStatusBasePath, discoveryLimiter, (_req, res) => send(res, buildMcpStatus(config)));
  // Section F: protocol/pricing information, separate from the payment-gated POST routes
  // further down. Always mounted (even when X402_ENABLED=false) — see buildX402Info(). Rate
  // limited as one group with the payment-gated POST routes below (same path prefix).
  app.use(x402BasePath, x402Limiter);
  app.get(x402BasePath, (_req, res) => send(res, buildX402Info(config, billingService)));
  // Section F hardening: a small, factual runtime status report — always mounted, GET-only,
  // and registered before the payment gate below so it is never mistaken for one of the
  // payment-gated POST routes it reports on. See buildX402Status()'s doc comment.
  app.get(x402BasePath + "/status", (_req, res) => send(res, buildX402Status(config)));
  // L402 (Lightning) info + status: always mounted, independent of L402_ENABLED, exactly like the
  // two x402 routes above. Only the payment-gated POST routes further down are conditional.
  app.use(l402BasePath, l402Limiter);
  app.get(l402BasePath, (_req, res) => send(res, buildL402Info(config, t => billingService.getToolPrice(t))));
  app.get(l402BasePath + "/status", (_req, res) => send(res, buildL402Status(config)));
  // MPP info + status: always mounted, independent of MPP_ENABLED, exactly like x402/L402 above.
  app.get(mppBasePath, mppLimiter, (_req, res) => send(res, buildMppInfo(config.mpp, t => billingService.getToolPrice(t))));
  // When the rail is enabled the status also reports provider reachability (cached eth_chainId
  // probe — never a payment) and database readiness.
  let mppServiceRef: MppService | null = null;
  app.get(mppBasePath + "/status", mppLimiter, async (_req, res, next) => {
    try { send(res, mppServiceRef ? { ...buildMppStatus(config.mpp), ...(await mppServiceRef.status()) } : buildMppStatus(config.mpp)); } catch (error) { next(error); }
  });
  const authenticate: RequestHandler = store ? async (req, res, next) => {
    try {
      const principal = await store.authenticate(req.header("x-api-key") ?? "");
      res.locals.principal = principal;
      res.locals.customerId = principal.customerId;
      next();
    } catch (error) { next(error instanceof ApiError ? error : new ApiError(503,"SERVICE_UNAVAILABLE","Customer storage unavailable")); }
  } : apiKeyAuth(config.apiKeys);
  const complete = async (res: express.Response, status: number) => {
    if (store && res.locals.admitted) {
      try { await store.complete(res.locals.principal as Principal,res.locals.requestId,status,performance.now()-res.locals.startedAt); }
      catch { throw new ApiError(503,"SERVICE_UNAVAILABLE","Usage storage unavailable"); }
    }
  };
  const parseJson = express.json({ limit: "32kb" });
  // Per-capability JSON body limits (AgentCapability.requestBodyLimit; default 32kb) — e.g.
  // document_facts_extract accepts a whole document's text. One parser per distinct limit.
  const jsonParsers = new Map<string, RequestHandler>();
  const parseJsonFor = (c: { requestBodyLimit?: string }): RequestHandler => {
    const limit = c.requestBodyLimit ?? "32kb";
    if (limit === "32kb") return parseJson;
    if (!jsonParsers.has(limit)) jsonParsers.set(limit, express.json({ limit }));
    return jsonParsers.get(limit)!;
  };
  const markTool = (toolName: CapabilityName): RequestHandler => (_req, res, next) => { res.locals.toolName = toolName; next(); };
  for (const c of capabilities) for (const prefix of ["/api/v1", "/v1"]) {
    app.post(prefix + c.path, markTool(c.name), authenticate, async (_req,res,next) => {
      if (!store) return next();
      try {
        res.locals.admitted = true;
        await store.admit(res.locals.principal,res.locals.requestId,c.name);
        next();
      } catch (error) { next(error instanceof ApiError ? error : new ApiError(503,"SERVICE_UNAVAILABLE","Usage storage unavailable")); }
    }, options.rateLimiter ?? ((_req, _res, next) => next()),
      (req, _res, next) => req.is("application/json") ? next() : next(new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Use application/json")),
      parseJsonFor(c), async (req, res) => {
        const input = c.input.parse(req.body);
        await billing.authorize({ capability: c.name, requestId: res.locals.requestId, customerId: res.locals.customerId });
        const data = await c.execute(input);
        // Analytics only (never changes the response) — read straight off the already-computed
        // result, picked up by the res.on("finish") tool-invocation recorder above.
        res.locals.dataSource = classifyDataSource(c.name, data);
        await complete(res,200);
        sendToolResult(res, data, c.name);
      });
  }
  // Free Preview (src/preview/): a separate, always-mounted, entirely unauthenticated and FREE
  // route family (POST /api/v1/preview/:capability and /v1/preview/:capability) — no API key, no
  // billing.authorize, no x402/L402/MPP gate, no store.admit/complete (see previewRoutes.ts's doc
  // comment). Mounted once, independent of X402_ENABLED/L402_ENABLED/MPP — a capability's preview
  // is available whenever that capability itself defines one, regardless of which paid rails are
  // turned on for this deployment.
  app.use(createPreviewRoutes({ limiter: previewLimiter }));
  // Pay-per-call via x402: a separate, unauthenticated route family. A valid on-chain
  // payment (X-PAYMENT header) is the sole authorization; no API key or customer account
  // is checked or metered here. Mounted only when X402_ENABLED=true; otherwise these
  // paths simply don't exist (404 via the catch-all below). This is real payment
  // enforcement — see src/billing/x402.ts's buildX402Gate() doc comment.
  if (config.x402Enabled) {
    // Internal analytics (X402 funnel): registered before the real payment gate so its
    // res.on("finish") listener is attached regardless of how the gate ultimately responds —
    // a 402 challenge, a verification failure, a settlement failure, or success. `toolName` is
    // resolved from the request path alone (never from res.locals, which the gate may prevent
    // from ever being set — see markTool() above for the REST equivalent, only reachable on
    // success). See recorder.ts's classifyX402Outcome() doc comment for the exact mapping from
    // (payment header presence, status code, settlement header) to one of the five funnel steps.
    const toolNameForX402Path = (path: string): CapabilityName | null => {
      const match = capabilities.find(c => path === x402BasePath + c.path);
      return match ? match.name : null;
    };
    app.use((req, res, next) => {
      const toolName = toolNameForX402Path(req.path);
      if (!toolName) { next(); return; }
      const hadPaymentHeader = Boolean(req.header("x-payment"));
      res.on("finish", () => {
        const settlementHeader = (res.getHeader("x-payment-response") ?? res.getHeader("payment-response")) as string | string[] | undefined;
        const settlement = decodeX402SettlementHeader(settlementHeader);
        const eventType = classifyX402Outcome({ hadPaymentHeader, status: res.statusCode, settlement });
        if (!eventType) return;
        const amount = billingService.getToolPrice(toolName);
        recordX402Event(analyticsRepository, req, { eventType, toolName, amount, currency: "USD", txHash: settlement?.transaction ?? null });
        // A settled payment implies verification already succeeded (buildX402Gate()'s doc
        // comment: settlement is never attempted on an unverified payment) — record both funnel
        // steps from the one observable success, rather than only the terminal one.
        if (eventType === "settlement_success") {
          recordX402Event(analyticsRepository, req, { eventType: "payment_verified", toolName, amount, currency: "USD", txHash: null });
        }
        // Revenue ledger (trustworthy accounting — see src/revenue/types.ts): only when a
        // settlement was actually observed (succeeded or failed), never for a bare 402 challenge
        // or a verification failure with no settlement attempt — see revenue/types.ts's
        // RevenueSettlementStatus doc comment for why. Decoded independently of the analytics
        // decode above (revenue/settlementCapture.ts's doc comment explains why) from the exact
        // same header, so this never changes what's sent back to the caller.
        if (eventType === "settlement_success" || eventType === "settlement_failure") {
          const decoded = decodeX402SettlementMetadata(settlementHeader);
          if (decoded) {
            recordSettlement(revenueLedger, buildSettlementRecord({
              settlement: decoded,
              requestId: typeof res.locals.requestId === "string" ? res.locals.requestId : randomUUID(),
              toolName, network: config.x402Network,
              facilitator: config.cdpConfigured ? "coinbase-cdp" : "public",
              payToAddress: config.x402WalletAddress,
              requirementAmountDecimal: amount, currency: "USDC"
            }));
          }
        }
      });
      next();
    });
    app.use(buildX402Gate(config, billingService));
    const parseJsonX402 = express.json({ limit: "32kb" });
    for (const c of capabilities) {
      app.post(x402BasePath + c.path,
        (_req, res, next) => { res.locals.toolName = c.name; res.locals.channel = "x402"; next(); },
        (req, _res, next) => req.is("application/json") ? next() : next(new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Use application/json")),
        c.requestBodyLimit ? parseJsonFor(c) : parseJsonX402, async (req, res) => {
          const input = c.input.parse(req.body);
          const data = await c.execute(input);
          res.locals.dataSource = classifyDataSource(c.name, data);
          sendToolResult(res, data, c.name);
        });
    }
  }
  // Pay-per-call via L402 (Lightning): a third route family, parallel to x402 and equally
  // unauthenticated — a paid L402 token (Authorization: L402 <macaroon>:<preimage>) is the sole
  // authorization. Mounted only when L402_ENABLED=true (404 otherwise). See billing/l402/gate.ts.
  if (config.l402Enabled) {
    const l402DatabaseUrl = process.env.L402_DATABASE_URL || config.databaseUrl;
    const l402Redemptions = options.l402Redemptions
      ?? (l402DatabaseUrl ? new PostgresL402RedemptionStore(l402DatabaseUrl) : new MemoryL402RedemptionStore());
    const l402Backend = options.l402Backend
      ?? (config.l402Backend === "voltage"
        ? new VoltagePaymentsBackend({
            apiUrl: config.voltageApiUrl, apiKey: config.voltageApiKey, organizationId: config.voltageOrganizationId,
            environmentId: config.voltageEnvironmentId, walletId: config.voltageWalletId
          })
        : new LndRestBackend({ restUrl: config.lndRestUrl, invoiceMacaroonHex: config.lndInvoiceMacaroon, tlsCert: config.lndTlsCert }));
    const l402Rates = options.l402Rates
      ?? new PublicBtcUsdRateProvider({ cacheMs: config.l402RateCacheMs, fallbackBtcUsd: config.l402BtcUsdFallback });
    // The receiving side, for the ledger's pay_to column: the node's host (public), never a credential.
    const l402PayTo = config.l402Backend === "voltage"
      ? `voltage:wallet:${config.voltageWalletId}`
      : `lnd:${(() => { try { return new URL(config.lndRestUrl).hostname; } catch { return "unknown"; } })()}`;
    const l402Gate = createL402Gate({
      config, backend: l402Backend, rates: l402Rates, redemptions: l402Redemptions, now: options.l402Now,
      priceUsd: t => billingService.getToolPrice(t),
      onChallenge: (req, tool) => recordL402Event(analyticsRepository, req, { eventType: "challenge", toolName: tool, amount: billingService.getToolPrice(tool), txHash: null }),
      onRejected: (req, tool) => recordL402Event(analyticsRepository, req, { eventType: "payment_failed", toolName: tool, amount: billingService.getToolPrice(tool), txHash: null }),
      onRedeemed: (req, res, ctx) => {
        recordL402Event(analyticsRepository, req, { eventType: "settlement_success", toolName: ctx.toolName, amount: ctx.priceUsd, txHash: ctx.paymentHashHex });
        recordSettlement(revenueLedger, buildL402SettlementRecord({
          ctx, network: config.l402Network, payTo: l402PayTo, facilitator: config.l402Backend,
          requestId: typeof res.locals.requestId === "string" ? res.locals.requestId : randomUUID()
        }));
      }
    });
    const parseJsonL402 = express.json({ limit: "32kb" });
    for (const c of capabilities) {
      app.post(l402BasePath + c.path,
        // Gate first, then mark: like x402, an unpaid 402 challenge is not a tool invocation and
        // must not be recorded as a (failed) call in usage/analytics.
        l402Gate(c.name),
        (_req, res, next) => { res.locals.toolName = c.name; res.locals.channel = "l402"; next(); },
        (req, _res, next) => req.is("application/json") ? next() : next(new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Use application/json")),
        c.requestBodyLimit ? parseJsonFor(c) : parseJsonL402, async (req, res) => {
          const input = c.input.parse(req.body);
          const data = await c.execute(input);
          res.locals.dataSource = classifyDataSource(c.name, data);
          sendToolResult(res, data, c.name);
        });
    }
  }
  // Pay-per-call and metered sessions via MPP (Machine Payments Protocol): a fourth route family
  // (after REST, x402 and L402), equally unauthenticated — an MPP credential (Authorization:
  // Payment …) is the sole authorization. Mounted only when MPP_ENABLED=true; otherwise every
  // /api/v1/mpp/* path (except info/status above) answers a clear 404 MPP_DISABLED. Tool
  // execution is the unchanged capability registry; see billing/mpp/ for the full design.
  if (config.mpp.enabled) {
    const mppService = buildMppService({
      config: config.mpp,
      databaseUrl: process.env.MPP_DATABASE_URL || config.databaseUrl,
      priceUsd: tool => billingService.getToolPrice(tool as CapabilityName),
      recordSettlement: input => recordSettlement(revenueLedger, input),
      audit: options.mppAudit ?? (entry => { if (config.logLevel !== "silent") process.stderr.write(`${JSON.stringify(entry)}\n`); }),
      x402: { facilitatorUrl: config.x402FacilitatorUrl, cdpConfigured: config.cdpConfigured, cdpApiKeyId: config.cdpApiKeyId, cdpApiKeySecret: config.cdpApiKeySecret },
      provider: options.mppProvider, sessions: options.mppSessions, redemptions: options.mppRedemptions, kv: options.mppKv, now: options.mppNow
    });
    mppServiceRef = mppService;
    app.use(createMppRoutes({
      service: mppService, limiter: mppLimiter, sessionCreateLimiter: config.rateLimitEnabled ? createMppSessionCreateLimiter(config.mpp) : disabledRateLimiter,
      bodyLimitFor: tool => capabilities.find(c => c.name === tool)?.requestBodyLimit
    }));
    // Optional MPP-over-MCP payment layer (MPP_MCP_ENABLED=true): the MPP MCP transport binding
    // on its own path, delegating everything but tools/call to the standard MCP handler, so the
    // free /mcp endpoint is untouched. See billing/mpp/mcp.ts.
    if (config.mpp.mcpEnabled && config.mcpRemoteEnabled) {
      app.post(mppMcpPath, mcpLimiter, express.json({ limit: maxCapabilityBodyLimit() }),
        createMppMcpHandler({ service: mppService, delegate: createRemoteMcpHandler(billingService, logger, analyticsRepository) }));
    }
  } else {
    app.use(createMppDisabledRoutes());
  }
  // Remote MCP (Section 1): a Streamable HTTP transport at /mcp, mounted only when
  // MCP_REMOTE_ENABLED=true; otherwise this path simply 404s via the catch-all below, exactly
  // like the x402 route family when X402_ENABLED=false. See mcp/remote.ts's doc comment for why
  // this reuses the same createMcpServer() factory as local stdio (src/mcp.ts).
  if (config.mcpRemoteEnabled) {
    app.use(mcpRemotePath, mcpLimiter);
    // Peek the JSON-RPC body once (Content-Type-gated, exactly like every other JSON POST route
    // in this app — see marketDataRoutes.ts's parseJsonBody) so createRemoteMcpHandler can pass
    // it straight through to the transport as parsedBody AND read its `method` for internal
    // analytics (initialize/tools_list — see mcp/remote.ts's doc comment). A GET/DELETE request
    // (session open/close under the Streamable HTTP transport) has no JSON body and passes
    // through untouched.
    // The MCP endpoint carries every tool's arguments, so it accepts the largest per-tool body limit.
    app.use(mcpRemotePath, express.json({ limit: maxCapabilityBodyLimit() }));
    app.all(mcpRemotePath, createRemoteMcpHandler(billingService, logger, analyticsRepository));
  }
  // Partner Data Feed layer (Section 3/4/9/11) — deliberately outside the `capabilities` registry
  // above, so it never appears in /agent.json, the tool catalog, remote MCP, or the x402 route
  // family (Section 15: infrastructure, not an agent capability). Mounted only when a market
  // database is actually configured — an injected marketRepository/partnerRepository (tests) or a
  // real OMAN_MARKET_DATABASE_URL/DATABASE_URL (production) lazily builds Postgres-backed
  // instances that share one connection pool, exactly like PostgresPartnerRepository's own doc
  // comment describes. Without either, these routes simply don't exist (404 via the catch-all
  // below) rather than 500ing on every request.
  const marketDatabaseUrl = getOmanMarketDatabaseUrl();
  const marketRepository = options.marketRepository ?? (marketDatabaseUrl ? new PostgresPropertyMarketRepository(marketDatabaseUrl) : undefined);
  const partnerRepository = options.partnerRepository ?? (marketRepository instanceof PostgresPropertyMarketRepository ? new PostgresPartnerRepository(marketRepository.pool) : undefined);
  const ingestionAuditRepository = options.ingestionAuditRepository ?? (marketRepository instanceof PostgresPropertyMarketRepository ? new PostgresPartnerIngestionAuditRepository(marketRepository.pool) : undefined);
  if (marketRepository && partnerRepository && ingestionAuditRepository) {
    app.use(createMarketDataRoutes({
      marketRepository, partnerRepository, ingestionAuditRepository,
      internalApiKey: getMarketDataInternalApiKey(),
      staleDays: getPartnerFeedStaleDays(),
      ingestionLimiter
    }));
  }
  // Oman Business Intelligence Admin & Data Operations Dashboard — internal-only, never touching
  // the `capabilities` array (so it is structurally unreachable from /agent.json, MCP, the tool
  // catalog, discovery or the x402 route family). Mounted only when both the admin login is
  // configured (ADMIN_USERNAME/ADMIN_PASSWORD_HASH/ADMIN_SESSION_SECRET) AND a real business
  // database is available — an injected businessRepository (tests) or OMAN_BUSINESS_DATABASE_URL/
  // DATABASE_URL (production), exactly like the Partner Data Feed routes above. Without either,
  // /admin and /api/admin/business/* simply don't exist (404 via the catch-all below) rather than
  // 500ing or silently having no auth.
  const businessDatabaseUrl = getOmanBusinessDatabaseUrl();
  const businessRepository = options.businessRepository ?? (businessDatabaseUrl ? new PostgresCompanyRepository(businessDatabaseUrl) : undefined);
  if (config.adminEnabled && businessRepository) {
    app.use(createAdminRoutes({ config, repository: businessRepository }));
  }
  // Internal Rafid Property Intelligence dashboard (/internal/dashboard — see dashboardRoutes.ts's
  // doc comment). Deliberately mounted on config.adminEnabled ALONE, unlike the business admin
  // dashboard immediately above: this dashboard reads only the analytics and revenue layers
  // (always constructed, regardless of database configuration), never businessRepository, so it
  // must not share that router's extra `&& businessRepository` condition. Reuses the exact same
  // session-cookie authentication as /admin/* (middleware/adminAuth.ts) — see that router's own
  // doc comment for why this is a separate login page rather than a shared one. Never registered
  // in the `capabilities` array; never reachable from /agent.json, MCP, the tool catalog,
  // discovery or the x402 route family; never a public dashboard.
  if (config.adminEnabled) {
    app.use(createDashboardRoutes({ config, analyticsRepository, revenueLedger, billingService }));
  }
  // Internal analytics API (discovery/MCP/x402/tool-usage — see analyticsRoutes.ts's doc
  // comment). Always mounted, unlike the Partner Data Feed/Admin routes above: recording itself
  // always happens regardless of database configuration, so these read routes always have
  // something to report; each one individually 503s until ANALYTICS_INTERNAL_API_KEY is set
  // (requireInternalAuth), rather than the whole router being conditionally absent. Never
  // registered in the `capabilities` array — structurally unreachable from /agent.json, MCP, the
  // tool catalog, discovery or the x402 route family, and never a public dashboard.
  app.use(createAnalyticsRoutes({ repository: analyticsRepository, internalApiKey: getAnalyticsInternalApiKey() }));
  // Internal revenue/settlement-ledger API (see revenueRoutes.ts's doc comment) — same
  // always-mounted, individually-503-until-configured discipline as analytics above, gated by
  // its own dedicated REVENUE_INTERNAL_API_KEY (revenue/config.ts). Never registered in the
  // `capabilities` array; never a public dashboard.
  app.use(createRevenueRoutes({ ledger: revenueLedger, analyticsRepository, billingService, internalApiKey: getRevenueInternalApiKey() }));
  app.use((_req, _res, next) => next(new ApiError(404, "NOT_FOUND", "Endpoint not found")));
  const errors: ErrorRequestHandler = async (error, _req, res, _next) => {
    const type = (error as { type?: string })?.type;
    const normalized = type === "entity.parse.failed" ? new ApiError(400, "INVALID_JSON", "Malformed JSON body")
      : type === "entity.too.large" ? new ApiError(413, "PAYLOAD_TOO_LARGE", `Request body exceeds ${formatBytes((error as { limit?: number }).limit ?? 32 * 1024)}`)
      : type === "charset.unsupported" || type === "encoding.unsupported" ? new ApiError(415, "UNSUPPORTED_MEDIA_TYPE", "Unsupported body encoding")
      : error;
    let result = publicError(normalized);
    try { await complete(res,result.status); } catch { result = publicError(new ApiError(503,"SERVICE_UNAVAILABLE","Usage storage unavailable")); }
    res.status(result.status).json({ success: false, error: result.error, meta: { requestId: res.locals.requestId } });
  };
  app.use(errors);
  return app;
}
