import type { Request } from "express";
import type { AnalyticsRepository, AnalyticsEvent, AnalyticsEventType, AnalyticsChannel, DataSource, FundingEventType, McpEventType, X402EventType } from "./types.js";
import { extractClientContext } from "./attribution.js";
import type { RequestClientContext } from "./context.js";

/** The exact discovery surfaces this layer tracks — the spec's literal list. Exported so app.ts
 *  can apply the same middleware to each without repeating the list, and so tests can assert
 *  every one of these actually gets wired up. */
export const DISCOVERY_PATHS = [
  "/agent.json",
  "/.well-known/agent.json",
  "/.well-known/ai-plugin.json",
  "/llms.txt",
  "/api/v1/capabilities",
  "/api/v1/tools",
  "/openapi.json",
  "/mcp"
] as const;

const emptyContext: RequestClientContext = { clientHash: null, userAgent: null, referer: null, clientName: null, source: null, utmMedium: null, campaign: null, utmContent: null, referrerHost: null, clientType: "unknown", trafficClass: "unknown" };

type JourneyEventFields = Partial<Pick<AnalyticsEvent, "paymentJourneyId" | "paymentAttemptId" | "parentRequestId" | "challengeRequestId" | "paidRetryRequestId" | "paymentStatus" | "paymentMode" | "isInternalTest" | "testMarkerHash" | "challengeIssuedAt" | "paymentAttemptedAt" | "paymentVerifiedAt" | "facilitatorVerifiedAt" | "chainSettledAt" | "settlementRecordedAt" | "paidRetryReceivedAt" | "executionStartedAt" | "executionCompletedAt" | "settlementObservationLagMs">>;

/** Every record*() below is intentionally fire-and-forget and never throws into its caller —
 *  analytics recording must never slow down, fail, or otherwise affect the real request it is
 *  observing (the same discipline billing/service.ts's recordUsage() call sites already follow
 *  throughout this codebase: `void billingService.recordUsage(...)`). A storage failure here is
 *  silently dropped, not surfaced — there is no user-facing consequence to losing one analytics
 *  row, and there is a real consequence to ever blocking or 500ing a real call because analytics
 *  storage hiccuped. */
function fireAndForget(repository: AnalyticsRepository, event: Parameters<AnalyticsRepository["record"]>[0]): void {
  try {
    void Promise.resolve(repository.record(event)).catch(() => {});
  } catch {
    /* a synchronous throw from a misbehaving repository must not propagate either */
  }
}

/** GET-only discovery surfaces (see DISCOVERY_PATHS) — always success:true/durationMs:null,
 *  since a plain discovery hit either reaches this middleware (200, by construction — these
 *  routes never 4xx/5xx for a GET with no body) or the request never got this far. */
export function recordDiscoveryHit(repository: AnalyticsRepository, req: Request, path: string, presentedCapabilities?: readonly string[]): void {
  const client = extractClientContext(req);
  fireAndForget(repository, {
    category: "discovery", eventType: "hit", path, toolName: null, channel: null, success: true, durationMs: null,
    amount: null, currency: null, txHash: null, dataSource: null,
    presentedCapabilities: presentedCapabilities ? [...presentedCapabilities] : null, ...client
  });
}

/** Records a surface impression only: the response contained these capabilities. It does not
 * claim that an agent read, selected, or understood each capability. */
export function recordDiscoverySurface(repository: AnalyticsRepository, req: Request, path: string, presentedCapabilities: readonly string[]): void {
  const client = extractClientContext(req);
  fireAndForget(repository, {
    category: "discovery", eventType: "surface_requested", path, toolName: null, channel: null, success: true, durationMs: null,
    amount: null, currency: null, txHash: null, dataSource: null, presentedCapabilities: [...presentedCapabilities], ...client
  });
}

/** Durable counterpart for HTTP discovery handlers. Vercel may freeze a function immediately
 * after the response is sent, so the discovery surfaces that feed the internal dashboard must
 * await their INSERT before returning the response. */
export async function recordDiscoverySurfaceAwaited(repository: AnalyticsRepository, req: Request, path: string, presentedCapabilities: readonly string[]): Promise<void> {
  const client = extractClientContext(req);
  try {
    await repository.record({
      category: "discovery", eventType: "surface_requested", path, toolName: null, channel: null, success: true, durationMs: null,
      amount: null, currency: null, txHash: null, dataSource: null, presentedCapabilities: [...presentedCapabilities], ...client
    });
  } catch {
    // Discovery must remain publicly available if analytics storage is temporarily unavailable.
  }
}

/** Maps a JSON-RPC method name (as sent to POST /mcp) to the McpEventType vocabulary this layer
 *  tracks. Returns null for any method outside the spec's literal list (e.g. "ping",
 *  "notifications/*") — those are simply not recorded, rather than forcing them into one of the
 *  three tracked buckets. */
export function mapMcpMethod(method: unknown): McpEventType | null {
  if (method === "initialize") return "initialize";
  if (method === "tools/list") return "tools_list";
  if (method === "tools/call") return "tools_call";
  return null;
}

/** One row per MCP protocol call. For "initialize"/"tools_list", called directly from the HTTP
 *  request handler (mcp/remote.ts) with real `req` access, so success is always true (a
 *  malformed JSON-RPC request never reaches the point where the method is known) and duration
 *  isn't measured (these are lightweight protocol calls, not the thing this layer's latency
 *  tracking cares about — that's tools_call and tool invocations, both measured). For
 *  "tools_call", called from mcp/server.ts's per-tool logger via the shared mcpClientContext
 *  (see context.ts's doc comment for why) — real success/duration, real client attribution. */
export function recordMcpEvent(
  repository: AnalyticsRepository,
  args: { eventType: McpEventType; toolName?: string | null; success?: boolean | null; durationMs?: number | null; client: RequestClientContext }
): void {
  fireAndForget(repository, {
    category: "mcp", eventType: args.eventType, path: "/mcp", toolName: args.toolName ?? null, channel: null,
    success: args.success ?? null, durationMs: args.durationMs ?? null,
    amount: null, currency: null, txHash: null, dataSource: null, ...args.client
  });
}

/** Called from mcp/server.ts's per-tool logger, outside any Express request handler, so there is
 *  no `req` to read client attribution from directly — reads it off mcpClientContext instead
 *  (falls back to an all-null context if somehow called outside that store, e.g. local stdio,
 *  which never populates it — see mcp/server.ts's doc comment). */
export function currentMcpClientContext(store: { getStore(): RequestClientContext | undefined }): RequestClientContext {
  return store.getStore() ?? emptyContext;
}

/** Classifies one x402-gated response into the funnel step it represents, from the only signals
 *  actually observable at this layer (this project never reimplements payment verification/
 *  settlement itself — @x402/express's paymentMiddleware, a third party, owns that entirely; see
 *  billing/x402.ts's buildX402Gate() doc comment):
 *
 *  - No X-PAYMENT request header at all → the caller never attempted payment; a 402 response
 *    here is the routine "here's what this costs" challenge every unpaid request gets.
 *  - X-PAYMENT present, response is 402 → the presented payment was rejected before settlement
 *    was even attempted (invalid/expired/insufficient) — "payment_failed", not a challenge (the
 *    caller already tried to pay).
 *  - X-PAYMENT present, a settlement response header (X-PAYMENT-RESPONSE / PAYMENT-RESPONSE) is
 *    present → settlement was attempted; its own `success` field (x402 v2's settleResponseSchema
 *    — see @x402/core) is authoritative: true → "settlement_success" (which also means
 *    verification succeeded — settlement is never attempted on an unverified payment, per
 *    buildX402Gate()'s doc comment), false → "settlement_failure".
 *  - X-PAYMENT present, no settlement header, non-2xx response → verification itself failed
 *    before settlement was ever attempted — "payment_failed".
 *  - X-PAYMENT present, 2xx response, no settlement header → treated as "payment_failed" is
 *    wrong (a 2xx with no header would be unusual for this always-gated route family) — this
 *    case is intentionally impossible for the routes this function is called on, but falls back
 *    to null (not recorded) rather than guessing, if it ever happens.
 */
export function classifyX402Outcome(args: {
  hadPaymentHeader: boolean;
  status: number;
  settlement: { success: boolean; transaction?: string } | null;
}): X402EventType | null {
  const { hadPaymentHeader, status, settlement } = args;
  if (!hadPaymentHeader) return status === 402 ? "challenge" : null;
  if (settlement) return settlement.success ? "settlement_success" : "settlement_failure";
  if (status === 402 || (status >= 400 && status < 600)) return "payment_failed";
  return null;
}

/** Decodes the x402 v2 settlement header (X-PAYMENT-RESPONSE, or PAYMENT-RESPONSE — @x402/core
 *  emits the header name as X-PAYMENT-RESPONSE in this deployment's version; both are checked
 *  since the protocol allows either, per @x402/core's own getPaymentSettleResponse()). Base64 of
 *  a JSON object matching settleResponseSchema: { success, transaction, network, amount?,
 *  errorReason?, ... } — see @x402/core/dist chunk for the schema this mirrors. Never throws:
 *  malformed/missing headers just mean "no settlement info available", the same as a payment
 *  that never reached settlement. */
export function decodeX402SettlementHeader(headerValue: string | string[] | undefined): { success: boolean; transaction?: string } | null {
  const raw = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  if (!raw) return null;
  try {
    const decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as Record<string, unknown>;
    if (typeof decoded.success !== "boolean") return null;
    const transaction = typeof decoded.transaction === "string" && decoded.transaction.length > 0 ? decoded.transaction : undefined;
    return { success: decoded.success, transaction };
  } catch {
    return null;
  }
}

/** Explicit map from funnel step to success/failure/neutral — deliberately not string-matching
 *  on the event name, so this can never silently misclassify a future renamed event type. */
const X402_SUCCESS_BY_EVENT_TYPE: Record<X402EventType, boolean | null> = {
  challenge: null,
  payment_challenge: null,
  payment_verified: true,
  payment_failed: false,
  settlement_success: true,
  settlement_failure: false,
  paid_retry_received: true
};

export function recordX402Event(
  repository: AnalyticsRepository,
  req: Request,
  args: { eventType: X402EventType; toolName: string | null; amount: number | null; currency: string | null; txHash: string | null; requestId?: string | null; paymentGuidanceVersion?: string | null; paymentDocsUrl?: string | null; challengeParseable?: boolean | null; client?: RequestClientContext; journey?: JourneyEventFields }
): void {
  const client = args.client ?? extractClientContext(req);
  fireAndForget(repository, {
    category: "x402", eventType: args.eventType, path: null, toolName: args.toolName, channel: null,
    success: X402_SUCCESS_BY_EVENT_TYPE[args.eventType],
    durationMs: null, amount: args.amount, currency: args.currency, txHash: args.txHash, dataSource: null,
    requestId: args.requestId ?? null, paymentGuidanceVersion: args.paymentGuidanceVersion ?? null,
    paymentDocsUrl: args.paymentDocsUrl ?? null, challengeParseable: args.challengeParseable ?? null, ...client, ...args.journey
  });
}

/** Awaitable x402 event writer for paid requests. The normal observer remains best-effort for
 * challenges and failures, but successful paid calls write before the HTTP response is sent so
 * a serverless runtime cannot freeze before the durable analytics insert finishes. */
export async function recordX402EventAwaited(
  repository: AnalyticsRepository,
  req: Request,
  args: { eventType: X402EventType; toolName: string | null; amount: number | null; currency: string | null; txHash: string | null; requestId?: string | null; paymentGuidanceVersion?: string | null; paymentDocsUrl?: string | null; challengeParseable?: boolean | null; client?: RequestClientContext; journey?: JourneyEventFields }
): Promise<void> {
  const client = args.client ?? extractClientContext(req);
  await repository.record({
    category: "x402", eventType: args.eventType, path: null, toolName: args.toolName, channel: null,
    success: X402_SUCCESS_BY_EVENT_TYPE[args.eventType], durationMs: null, amount: args.amount,
    currency: args.currency, txHash: args.txHash, dataSource: null, requestId: args.requestId ?? null,
    paymentGuidanceVersion: args.paymentGuidanceVersion ?? null, paymentDocsUrl: args.paymentDocsUrl ?? null,
    challengeParseable: args.challengeParseable ?? null, ...client, ...args.journey
  });
}

/** L402 funnel events (see billing/l402/gate.ts): "challenge" per 402 issued, "payment_failed"
 *  per rejected token, "settlement_success" per redeemed token. amount is the USD catalog price
 *  (same convention as x402 rows); txHash is the public Lightning payment hash, never the
 *  preimage. */
export function recordL402Event(
  repository: AnalyticsRepository,
  req: Request,
  args: { eventType: Extract<X402EventType, "challenge" | "payment_failed" | "settlement_success">; toolName: string; amount: number | null; txHash: string | null; requestId?: string | null; client?: RequestClientContext; journey?: JourneyEventFields }
): void {
  const client = args.client ?? extractClientContext(req);
  fireAndForget(repository, {
    category: "l402", eventType: args.eventType, path: null, toolName: args.toolName, channel: null,
    success: X402_SUCCESS_BY_EVENT_TYPE[args.eventType],
    durationMs: null, amount: args.amount, currency: args.amount === null ? null : "USD", txHash: args.txHash, dataSource: null,
    requestId: args.requestId ?? null, ...client, ...args.journey
  });
}

/** One row per capability invocation, across every access mode (REST X-API-Key, x402, remote
 *  MCP) — the "TOOL USAGE" domain (analyze_oman_property calls, partner_feed vs. demo/manual
 *  fallback usage, success rate, p50/p95 latency). `client` is a full RequestClientContext for
 *  REST/x402 (real `req` access) or mcpClientContext's current value for MCP (see
 *  currentMcpClientContext()'s doc comment). */
/** src/billing/external/service.ts's own analytics events (Stripe/USDC top-up funnel — see
 *  types.ts's FundingEventType doc comment) adapted onto AnalyticsRepository. Called from
 *  src/api/app.ts's `onEvent` wiring, not from inside billing/external/ itself — that module
 *  stays free of an analytics-package dependency, exactly like billing/mpp/index.ts's `audit`
 *  callback keeps that module free of a logging dependency. No RequestClientContext is attached:
 *  a funding event may originate from a server-to-server Stripe webhook with no real end-user
 *  request to attribute it to, so every client field is honestly null rather than guessed. */
export function recordFundingEvent(repository: AnalyticsRepository, args: { eventType: FundingEventType; provider: "stripe" | "usdc_base"; success: boolean; amountUSD: number | null }): void {
  fireAndForget(repository, {
    category: "funding", eventType: args.eventType, path: null, toolName: null, channel: null,
    success: args.success, durationMs: null, amount: args.amountUSD, currency: args.amountUSD === null ? null : "USD",
    txHash: null, dataSource: null, provider: args.provider,
    clientHash: null, userAgent: null, referer: null, clientName: null
  });
}

export function recordToolInvocation(
  repository: AnalyticsRepository,
  args: { toolName: string; channel: AnalyticsChannel; success: boolean; durationMs: number; dataSource: DataSource | null; client: RequestClientContext; requestId?: string | null; validationErrorCode?: string | null; validationFailureKind?: "missing_required_field" | "invalid_enum" | "ambiguous_entity" | "other" | null; journey?: JourneyEventFields; eventType?: "invocation" | "execution_started" | "execution_completed" }
): void {
  fireAndForget(repository, {
    category: "tool", eventType: (args.eventType ?? "invocation") as AnalyticsEventType, path: null, toolName: args.toolName, channel: args.channel,
    success: args.success, durationMs: args.durationMs, amount: null, currency: null, txHash: null,
    dataSource: args.dataSource, requestId: args.requestId ?? null, validationErrorCode: args.validationErrorCode ?? null, validationFailureKind: args.validationFailureKind ?? null, ...args.client, ...args.journey
  });
}

/** Durable counterpart used by the paid x402 handler after the capability has completed. */
export async function recordToolInvocationAwaited(
  repository: AnalyticsRepository,
  args: { toolName: string; channel: AnalyticsChannel; success: boolean; durationMs: number; dataSource: DataSource | null; client: RequestClientContext; requestId?: string | null; validationErrorCode?: string | null; validationFailureKind?: "missing_required_field" | "invalid_enum" | "ambiguous_entity" | "other" | null; journey?: JourneyEventFields; eventType?: "invocation" | "execution_started" | "execution_completed" }
): Promise<void> {
  await repository.record({
    category: "tool", eventType: (args.eventType ?? "invocation") as AnalyticsEventType, path: null, toolName: args.toolName,
    channel: args.channel, success: args.success, durationMs: args.durationMs, amount: null, currency: null,
    txHash: null, dataSource: args.dataSource, requestId: args.requestId ?? null, validationErrorCode: args.validationErrorCode ?? null, validationFailureKind: args.validationFailureKind ?? null, ...args.client, ...args.journey
  });
}
