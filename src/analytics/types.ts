/**
 * Internal analytics layer (Section: "lightweight internal analytics for Rafid discovery, MCP
 * usage and x402 usage" — never a public capability, never registered in
 * src/domain/capabilities.ts, so it is structurally unreachable from /agent.json, the tool
 * catalog, MCP, discovery/OpenAPI output or the x402 route family, exactly like the Partner Data
 * Feed (marketDataRoutes.ts) and Business Admin (adminRoutes.ts) internal layers before it.
 *
 * One append-only event log (`rafid_analytics_events`) covers all four tracked domains —
 * discovery hits, MCP protocol calls, x402 payment funnel steps, and capability ("tool")
 * invocations — rather than four separate tables, because every domain shares the same shape
 * (when it happened, what kind of thing happened, which tool/path it concerned, whether it
 * succeeded, how long it took, who safely-attributably called it) and a single table keeps
 * aggregation queries simple. `category` + `eventType` together say what a row means; see the
 * literal values used at each call site (src/analytics/recorder.ts) for the full vocabulary.
 *
 * PRIVACY: an AnalyticsEvent must never carry a raw API key, wallet private key, payment
 * proof/signature, or authorization header value — see src/analytics/attribution.ts (client
 * identity is always a coarse one-way hash, never a raw IP) and src/analytics/recorder.ts (every
 * field here is either a known-safe operational value — a route path, a tool name, a status, a
 * duration — or has already been redacted/truncated before reaching this type). `txHash` is a
 * public on-chain transaction identifier, not a secret, and is the one thing the spec explicitly
 * asks to capture "if safely available".
 */

/** "l402" rows use the same funnel vocabulary as x402 (challenge / payment_failed /
 *  settlement_success) but a separate category, so the x402 funnel and every x402 aggregate stay
 *  exactly as they were. */
export type AnalyticsCategory = "discovery" | "mcp" | "x402" | "l402" | "tool" | "preview";

/** Discovery: always "hit" — which surface was hit is carried in `path`. */
export type DiscoveryEventType = "hit";

/** MCP: the three JSON-RPC methods this layer distinguishes, matching the spec's literal list
 *  (initialize, tools/list, tools/call) with underscores instead of slashes for a stable SQL/JS
 *  identifier — no other method name is ever recorded (see recorder.ts's mapMcpMethod()). */
export type McpEventType = "initialize" | "tools_list" | "tools_call";

/** x402: the five funnel steps the spec asks for. See recorder.ts's classifyX402Outcome() for
 *  how a response is mapped to one of these from the (necessarily black-box) @x402/express
 *  payment-gate middleware's observable behavior — status code plus the standard, spec-defined
 *  X-PAYMENT-RESPONSE/PAYMENT-RESPONSE settlement header. */
export type X402EventType = "challenge" | "payment_verified" | "payment_failed" | "settlement_success" | "settlement_failure";

/** Tool: always "invocation" — one row per capability call, across every access mode (REST
 *  X-API-Key, x402, remote MCP). */
export type ToolEventType = "invocation";

/** Free Preview funnel + preview→paid conversion events (see preview/analytics.ts). One row per
 *  step, across the whole discover -> preview -> evaluate -> pay -> execute flow:
 *   - preview_requested: a POST /api/v1/preview/:capability request was received.
 *   - preview_available / preview_limited / preview_unavailable / preview_invalid: the outcome of
 *     that request — mirrors CapabilityPreviewStatus ("available"/"limited") plus two request-level
 *     outcomes CapabilityPreviewStatus doesn't cover (capability has no preview implementation at
 *     all, or the input failed validation).
 *   - preview_rate_limited: the request was rejected by preview/rateLimit.ts before it ran at all.
 *   - preview_cache_hit / preview_cache_miss: whether preview/cache.ts served a cached response.
 *   - paid_capability_started: a paid execution of a capability began (any rail) — the "did they
 *     come back and pay" half of the funnel.
 *   - preview_converted: that paid execution's request fingerprint matched a preview seen within
 *     the conversion window (see preview/analytics.ts's PreviewConversionIndex) — the business
 *     metric the whole funnel exists to measure. */
export type PreviewEventType =
  | "preview_requested" | "preview_available" | "preview_limited" | "preview_unavailable" | "preview_invalid"
  | "preview_rate_limited" | "preview_cache_hit" | "preview_cache_miss"
  | "paid_capability_started" | "preview_converted";

export type AnalyticsEventType = DiscoveryEventType | McpEventType | X402EventType | ToolEventType | PreviewEventType;

/** How much of a tool invocation's result was backed by real (partner-fed/imported) data versus
 *  the honest demo/manual fallback — see src/analytics/dataSource.ts's classifyDataSource(),
 *  which reads this straight off each capability's own already-published provenance fields
 *  (analyze_oman_property's `provenance`, the three business capabilities' `dataCoverage`) —
 *  never inferred or guessed. `null` for a tool with no such field (the three plain calculators,
 *  and search_oman_company where the company registry itself carries no coverage breakdown).
 *
 *  "live_provider" / "not_configured" are the Rafid Agent Intelligence capabilities' own
 *  vocabulary (research_company/find_companies/analyze_company_risk's `dataMode` field — see
 *  src/intelligence/types.ts) — deliberately distinct from "partner_feed"/"demo_manual" rather
 *  than reused, because a live web-search/LLM-backed result is not the same evidentiary class as
 *  Rafid's own licensed/imported Oman business data, and conflating the two would overstate what
 *  either honestly means. */
export type DataSource = "partner_feed" | "demo_manual" | "mixed" | "unknown" | "live_provider" | "not_configured";

/** How a "tool" category invocation reached this codebase — REST X-API-Key, x402 pay-per-call,
 *  or remote MCP. Added for the revenue ledger's reconciliation endpoint (src/revenue/aggregate.ts's
 *  buildReconciliation()), which needs to compare "successful x402 tool executions" against the
 *  settlement ledger without conflating an x402 call with a REST/MCP call to the same capability —
 *  see that function's doc comment. Null for discovery/mcp/x402-category rows, where "channel"
 *  isn't a meaningful concept (a discovery hit and an x402 funnel event aren't tool invocations at
 *  all). This is purely additive to an already-shipped table — PostgresAnalyticsRepository adds it
 *  via ALTER TABLE ... ADD COLUMN IF NOT EXISTS, so existing rows simply read back as null.
 *  "mpp" = an MPP charge call (one settled payment per call, like x402/L402); "mpp-session" = a
 *  metered call inside an MPP session (paid by the session's eventual channel settlement, so it
 *  is NOT one-settlement-per-call — see revenue/aggregate.ts's isPaidToolExecution()). */
export type AnalyticsChannel = "rest" | "x402" | "l402" | "mpp" | "mpp-session" | "mcp-remote";

export interface AnalyticsEvent {
  category: AnalyticsCategory;
  eventType: AnalyticsEventType;
  /** Discovery only — one of the exact surfaces this layer tracks (see recorder.ts's
   *  DISCOVERY_PATHS). Never a full URL, never a query string. */
  path: string | null;
  /** mcp tools_call and tool invocations only — a CapabilityName from the shared registry. */
  toolName: string | null;
  /** Tool invocations only — see AnalyticsChannel's doc comment. */
  channel: AnalyticsChannel | null;
  /** Whether the underlying call succeeded — an HTTP 2xx / a non-isError MCP result / a
   *  settled==true payment, depending on category. Null where success/failure isn't a concept
   *  for this row (a discovery hit, an mcp initialize/tools_list call). */
  success: boolean | null;
  durationMs: number | null;
  /** x402 only — the tool's catalog price (billing/catalog.ts), never the raw on-chain payment
   *  amount in the payment token's atomic units, so this is always directly comparable to the
   *  rest of this API's USD-denominated pricing. */
  amount: number | null;
  currency: string | null;
  /** x402 settlement rows only — the public on-chain transaction hash from the x402 settlement
   *  response header, when present. Never a payment proof, signature, or the raw X-PAYMENT
   *  header itself. */
  txHash: string | null;
  /** Tool invocations only (and only for the four capabilities that publish a provenance/
   *  coverage field — see dataSource.ts). */
  dataSource: DataSource | null;
  /** Coarse, one-way client identity (sha256 of IP+User-Agent, truncated) — never a raw IP. */
  clientHash: string | null;
  /** Truncated to attribution.ts's MAX_ATTRIBUTION_FIELD_LENGTH; never assumed trustworthy
   *  (any caller can send any User-Agent), used only for coarse operator-facing grouping. */
  userAgent: string | null;
  /** Origin + path only — query string and fragment are stripped before this ever reaches the
   *  type (see attribution.ts's sanitizeReferer()), since a referring page's query string can
   *  carry the caller's own secrets. */
  referer: string | null;
  /** From X-Client-Name, falling back to X-Agent-Name — an unauthenticated, self-reported
   *  caller identity (never verified, never trusted for authorization decisions). */
  clientName: string | null;
  /** Preview category only (see PreviewEventType) — a one-way SHA-256/HMAC digest of capability +
   *  normalized input (preview/fingerprint.ts). NEVER raw input: this is the one field that joins
   *  a preview_requested row to a later paid_capability_started/preview_converted row for the same
   *  logical request, and it must never be reversible to what the caller actually sent. Optional
   *  (unlike the pre-existing fields above) so every call site that predates this field keeps
   *  compiling unchanged; absent/undefined means "not applicable to this event", same as null. */
  requestFingerprint?: string | null;
  /** paid_capability_started / preview_converted only — the actual payment rail the paid call
   *  settled on (x402/l402/mpp-charge/mpp-session/api-key), read from the billing flow itself
   *  (res.locals.channel in api/app.ts), never from a client-supplied header. */
  paymentRail?: string | null;
  /** paid_capability_started only — whether this paid call's request fingerprint had a qualifying
   *  preview within the conversion window at the moment it started. null/absent for every other
   *  event type. */
  previewSeen?: boolean | null;
  /** preview_converted only — milliseconds between the qualifying preview and this paid execution. */
  conversionLatencyMs?: number | null;
  createdAt: string;
}

/** What a caller passes to record() — createdAt defaults to "now" at the repository, so callers
 *  never need to compute it themselves (and can't accidentally backdate a row). */
export type AnalyticsEventInput = Omit<AnalyticsEvent, "createdAt"> & { createdAt?: string };

export interface AnalyticsRepository {
  /** Fire-and-forget from every call site (see recorder.ts) — analytics recording must never
   *  slow down or fail the real request it's observing. Implementations should not throw for an
   *  ordinary storage hiccup; callers wrap every call in .catch(() => {}) as a second layer of
   *  defense regardless. */
  record(event: AnalyticsEventInput): void | Promise<void>;
  /** Every event with createdAt >= since, newest first. This is a "lightweight" layer by design
   *  (see the spec) — aggregation (src/analytics/aggregate.ts) runs in plain JS over this array
   *  rather than in SQL, so a query result is capped (implementations should cap around
   *  MAX_QUERY_EVENTS) rather than ever returning an unbounded result set. A capped result under-
   *  counts rather than OOMing or timing out — see aggregate.ts's doc comment on what that means
   *  for very high-traffic windows. */
  queryEvents(since: Date): Promise<AnalyticsEvent[]>;
}

/** Shared cap between MemoryAnalyticsRepository and PostgresAnalyticsRepository so both
 *  implementations behave identically at the boundary a test can actually exercise. */
export const MAX_QUERY_EVENTS = 200_000;
