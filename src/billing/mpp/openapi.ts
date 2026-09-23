import { z } from "zod";
import { capabilities } from "../../domain/capabilities.js";
import type { MppConfig } from "./config.js";
import { describeMppConfig } from "./config.js";
import { mppBasePath } from "./routes.js";
import { sessionCreateSchema } from "./service.js";

/**
 * OpenAPI path items for the MPP rail, merged into the main document by api/openapi.ts. The
 * info/status routes are always documented (they're always mounted); the payment routes only
 * when MPP_ENABLED=true (they 404 MPP_DISABLED otherwise) — the same rule x402/L402 follow.
 * Examples are realistic shapes of what service.ts actually returns.
 */

const json = (schema: unknown, examples?: Record<string, { summary: string; value: unknown }>) => ({
  "application/json": { schema, ...(examples ? { examples } : {}) }
});
const err = (code: string, message: string, extra: Record<string, unknown> = {}) => ({ success: false, error: { code, message }, ...extra, meta: { requestId: "example-request" } });
const errorSchema = {
  type: "object", required: ["success", "error", "meta"],
  properties: { success: { const: false }, error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" } } }, meta: { type: "object" } }
};
const paymentRequiredSchema = {
  type: "object", required: ["success", "error", "protocol", "mode", "currency", "paymentRequired", "challenges"],
  properties: {
    success: { const: false }, error: { type: "object" }, protocol: { const: "mpp" }, mode: { enum: ["charge", "session"] },
    tool: { type: "string" }, sessionId: { type: "string" }, amount: { type: "number" }, currency: { const: "USD" }, paymentRequired: { const: true },
    challenges: { type: "array", items: { type: "object", required: ["id", "method", "intent", "realm", "request"], properties: {
      id: { type: "string" }, method: { type: "string" }, intent: { type: "string" }, realm: { type: "string" }, request: { type: "object" }, description: { type: ["string", "null"] }, expires: { type: ["string", "null"] }
    } } },
    problem: { type: "object", description: "RFC 9457 problem details from the MPP SDK." }
  }
};
const sessionSchema = {
  type: "object", required: ["sessionId", "status", "currency", "maxBudget", "spent", "remaining", "calls", "allowedTools"],
  properties: {
    sessionId: { type: "string", pattern: "^mpp_[0-9a-f]{32}$" }, status: { enum: ["pending", "active", "exhausted", "closed", "expired", "failed"] },
    currency: { const: "USD" }, maxBudget: { type: "number" }, requestedMaxBudget: { type: "number" }, spent: { type: "number" }, remaining: { type: "number" }, reserved: { type: "number" },
    calls: { type: "integer" }, allowedTools: { type: "array", items: { type: "string" } },
    usageByTool: { type: "object", additionalProperties: { type: "object", properties: { calls: { type: "integer" }, spent: { type: "number" } } } },
    payment: { type: "object" }, settlement: { type: "object", properties: { status: { enum: ["not_started", "pending_payer_close", "settled", "nothing_to_settle", "failed"] }, reference: { type: ["string", "null"] }, settled: { type: "number" } } },
    createdAt: { type: "string" }, updatedAt: { type: "string" }, expiresAt: { type: "string" }, closedAt: { type: ["string", "null"] }
  }
};
const EXAMPLE_ID = "mpp_4f1c2b9a7e6d5c3b2a1908f7e6d5c4b3";
const CHANNEL = "0x" + "7a".repeat(32);
const sessionExample = (over: Record<string, unknown> = {}) => ({
  sessionId: EXAMPLE_ID, status: "active", currency: "USD", maxBudget: 20, requestedMaxBudget: 20, spent: 4.25, remaining: 15.75, reserved: 0, calls: 11,
  allowedTools: ["oman_supplier_check", "analyze_oman_property"],
  usageByTool: { oman_supplier_check: { calls: 7, spent: 3.5 }, analyze_oman_property: { calls: 3, spent: 0.75 } },
  payment: { protocol: "mpp", intent: "session", provider: "mppx", method: "tempo/session", channelId: CHANNEL, authorizationReference: "0x" + "9c".repeat(32) },
  settlement: { status: "not_started", reference: null, settled: 0 },
  createdAt: "2026-09-23T08:00:00.000Z", updatedAt: "2026-09-23T08:14:03.000Z", expiresAt: "2026-09-23T09:00:00.000Z", closedAt: null, ...over
});
const challengeExample = (intent: "charge" | "session", amountRaw: string) => ({
  id: "LsvdgagfjpqvkdEns8CSaHpXwe6s_jxJh94DDlRCO2k", method: "tempo", intent, realm: "api.rafidsystem.com",
  request: intent === "charge"
    ? { amount: amountRaw, currency: "0x20C000000000000000000000b9537d11c60E8b50", recipient: "0x742d35Cc6634c0532925a3b844bC9e7595F8fE00", methodDetails: { chainId: 4217 } }
    : { amount: amountRaw, currency: "0x20C000000000000000000000b9537d11c60E8b50", recipient: "0x742d35Cc6634c0532925a3b844bC9e7595F8fE00", unitType: "request", methodDetails: { chainId: 4217, escrowContract: "0x33b901018174DDabE4841042ab76ba85D4e24f25", sessionProtocol: "v2" } },
  description: intent === "charge" ? "Rafid analyze_oman_property (1 call)" : "Rafid oman_supplier_check (1 call, session " + EXAMPLE_ID + ")",
  expires: "2026-09-23T08:05:00.000Z"
});
const problem = { type: "https://paymentauth.org/problems/payment-required", title: "Payment Required", status: 402 };
const header402 = { "WWW-Authenticate": { description: "One `Payment` challenge per offered method (IETF draft-ryan-httpauth-payment).", schema: { type: "string" } } };
const receiptHeader = { "Payment-Receipt": { description: "Serialized MPP receipt for the settled/metered payment.", schema: { type: "string" } } };
const idParam = { name: "sessionId", in: "path", required: true, schema: { type: "string", pattern: "^mpp_[0-9a-f]{32}$" } };
const toolParam = { name: "tool", in: "path", required: true, schema: { type: "string", enum: capabilities.map(c => c.name) } };
const authParam = { name: "Authorization", in: "header", required: false, description: "`Payment <credential>` — the MPP credential answering a previously issued challenge. Omit to receive a 402 challenge.", schema: { type: "string" } };

export function buildMppOpenapiPaths(config: MppConfig | undefined): Record<string, unknown> {
  const paths: Record<string, unknown> = {};
  paths[mppBasePath] = { get: { operationId: "mpp_info", tags: ["MPP"], summary: "MPP (Machine Payments Protocol) terms and per-tool pricing", security: [], responses: { "200": { description: "MPP terms (always available, even when MPP is disabled)" } } } };
  paths[mppBasePath + "/status"] = { get: { operationId: "mpp_status", tags: ["MPP"], summary: "MPP runtime status (secret-free)", security: [], responses: { "200": { description: "Status" } } } };
  if (!config?.enabled) return paths;
  const d = describeMppConfig(config);
  const tools = capabilities.map(c => c.name);

  if (config.modes.includes("charge")) {
    paths[mppBasePath + "/charge/{tool}"] = { post: {
      operationId: "mpp_charge", tags: ["MPP"],
      summary: "Call one paid tool with a one-time MPP payment",
      description: `One-time Machine Payments Protocol payment for exactly one successful call (methods: ${config.chargeMethods.map(m => m + "/charge").join(", ")}). The price is the tool's registry price (GET /api/v1/capabilities); the client never supplies an amount. Flow: invalid input → 400 (no challenge, no payment). No credential → 402 with WWW-Authenticate: Payment challenges. Valid credential → verified (non-mutating), the tool runs, and only then is the payment settled; the response carries Payment-Receipt. A credential is single-use; a failed call does not consume it.`,
      security: [], parameters: [toolParam, authParam],
      requestBody: { required: true, description: "The tool's own strict JSON input (same schema as POST /api/v1/<tool-path>).", content: json({ type: "object" }, {
        analyze_oman_property: { summary: "analyze_oman_property input", value: capabilities.find(c => c.name === "analyze_oman_property")?.example }
      }) },
      responses: {
        "200": { description: "Tool result (settled)", headers: receiptHeader, content: json({ type: "object", required: ["success", "data", "payment", "meta"] }, {
          ok: { summary: "Paid call", value: { success: true, data: { "…": "normal tool output" }, payment: { protocol: "mpp", mode: "charge", method: "tempo", network: "tempo:4217", amount: 0.25, currency: "USD", asset: "USDC", reference: "0x" + "3e".repeat(32) }, meta: { requestId: "example-request", tool: "analyze_oman_property", price: 0.25, currency: "USD" } } }
        }) },
        "400": { description: "Invalid tool input — rejected before any payment step", content: json(errorSchema, { invalid: { summary: "Invalid input", value: { success: false, error: { code: "INVALID_INPUT", message: "Input validation failed", details: [{ path: "sizeSqm", message: "Too small: expected number to be >0" }] }, meta: { requestId: "example-request" } } } }) },
        "402": { description: "Payment required, invalid payment, replayed credential, or settlement failure (a fresh challenge is attached)", headers: header402, content: json(paymentRequiredSchema, {
          unpaid: { summary: "No credential", value: { success: false, error: { code: "MPP_PAYMENT_REQUIRED", message: "Payment required: …" }, protocol: "mpp", mode: "charge", tool: "analyze_oman_property", amount: 0.25, currency: "USD", paymentRequired: true, challenges: [challengeExample("charge", "250000")], problem, meta: { requestId: "example-request" } } },
          invalid: { summary: "Invalid payment", value: { ...err("MPP_INVALID_PAYMENT", "The payment credential was rejected (verification-failed); a fresh challenge is attached."), protocol: "mpp", mode: "charge", tool: "analyze_oman_property", amount: 0.25, currency: "USD", paymentRequired: true, challenges: [challengeExample("charge", "250000")] } },
          replayed: { summary: "Replayed credential", value: { ...err("MPP_PAYMENT_REPLAYED", "This payment credential was already used; a fresh challenge is attached."), protocol: "mpp", mode: "charge", tool: "analyze_oman_property", amount: 0.25, currency: "USD", paymentRequired: true, challenges: [challengeExample("charge", "250000")] } }
        }) },
        "404": { description: "Unsupported tool", content: json(errorSchema, { unsupported: { summary: "Unknown tool", value: err("MPP_UNSUPPORTED_TOOL", "Unknown or unpriced tool \"do_everything\". See GET /api/v1/capabilities.") } }) },
        "503": { description: "Payment provider or storage unavailable (nothing charged)", content: json(errorSchema) }
      }
    } };
  }

  if (config.modes.includes("session")) {
    paths[mppBasePath + "/sessions"] = { post: {
      operationId: "mpp_create_session", tags: ["MPP"],
      summary: "Open a budgeted MPP session (reusable authorization + metered usage)",
      description: `Creates an MPP session (method tempo/session on ${d.session?.network}). First call without a credential: a pending session is created and a 402 challenge asks the payer to open a TIP-1034 payment channel whose deposit is the budget. Retry the same body with the channel-open credential (Authorization: Payment …): the channel is opened and the session becomes active. The budget and allowed tools are bound into the challenge; a different body is refused (MPP_TERMS_MISMATCH). Budget limits: ${config.minSessionBudgetUsd}–${config.maxSessionBudgetUsd} USD; TTL ${config.sessionTtlSeconds}s.`,
      security: [], parameters: [authParam],
      requestBody: { required: true, content: json(z.toJSONSchema(sessionCreateSchema), { create: { summary: "$20 session", value: { maxBudget: 20, currency: "USD", allowedTools: ["oman_supplier_check", "analyze_oman_property"] } } }) },
      responses: {
        "201": { description: "Session active", headers: receiptHeader, content: json({ type: "object", properties: { success: { const: true }, data: sessionSchema } }, { active: { summary: "Opened", value: { success: true, data: sessionExample({ spent: 0, remaining: 20, calls: 0, usageByTool: {} }), meta: { requestId: "example-request" } } } }) },
        "402": { description: "Open-channel challenge (pending session)", headers: header402, content: json(paymentRequiredSchema, { pending: { summary: "Pending session", value: { success: false, error: { code: "MPP_PAYMENT_REQUIRED", message: "Payment required: …" }, protocol: "mpp", mode: "session", sessionId: EXAMPLE_ID, status: "pending", maxBudget: 20, allowedTools: ["oman_supplier_check", "analyze_oman_property"], currency: "USD", paymentRequired: true, challenges: [challengeExample("session", "0")], problem, meta: { requestId: "example-request" } } } }) },
        "400": { description: "Invalid body, budget out of range, or unsupported tool", content: json(errorSchema) },
        "409": { description: "Terms mismatch or channel already bound", content: json(errorSchema, { mismatch: { summary: "Terms changed", value: err("MPP_TERMS_MISMATCH", "The session terms in this request differ from the terms the payment challenge was issued for.") } }) }
      }
    } };
    paths[mppBasePath + "/sessions/{sessionId}"] = { get: {
      operationId: "mpp_get_session", tags: ["MPP"], summary: "Session status and metering", security: [], parameters: [idParam],
      responses: {
        "200": { description: "Session", content: json({ type: "object", properties: { success: { const: true }, data: sessionSchema } }, { active: { summary: "Active session", value: { success: true, data: sessionExample(), meta: { requestId: "example-request" } } } }) },
        "404": { description: "Invalid session", content: json(errorSchema, { missing: { summary: "Unknown id", value: err("MPP_SESSION_NOT_FOUND", "No MPP session exists with this id.") } }) }
      }
    } };
    paths[mppBasePath + "/sessions/{sessionId}/tools/{tool}"] = { post: {
      operationId: "mpp_session_call_tool", tags: ["MPP"], summary: "Call a paid tool under an MPP session (metered)",
      description: "Per call: session exists → active and not expired → tool allowed → price from the capability registry → Idempotency-Key → tool input validated → budget reserved atomically (a call that would exceed maxBudget fails before execution) → voucher credential verified (non-mutating) → tool executes → only on success the voucher is accepted and the price metered against the channel → spent/remaining/calls/per-tool usage updated. Retrying with the same Idempotency-Key returns the stored result and charges nothing.",
      security: [], parameters: [idParam, toolParam, authParam, { name: "Idempotency-Key", in: "header", required: config.requireIdempotency, schema: { type: "string", maxLength: 255 } }],
      requestBody: { required: true, description: "The tool's own strict JSON input.", content: json({ type: "object" }) },
      responses: {
        "200": { description: "Tool result + usage metadata (or an idempotent replay)", headers: receiptHeader, content: json({ type: "object", required: ["success", "data", "usage", "meta"] }, {
          ok: { summary: "Metered call", value: { success: true, data: { "…": "normal tool output" }, usage: { sessionId: EXAMPLE_ID, tool: "oman_supplier_check", charge: 0.5, spent: 4.25, remaining: 15.75, calls: 11, status: "active" }, meta: { requestId: "example-request", tool: "oman_supplier_check", price: 0.5, currency: "USD" } } },
          replay: { summary: "Idempotent replay (not charged)", value: { success: true, data: { "…": "stored tool output" }, usage: { sessionId: EXAMPLE_ID, tool: "oman_supplier_check", charge: 0, originalCharge: 0.5, spent: 4.25, remaining: 15.75, calls: 11, idempotentReplay: true }, meta: { requestId: "example-request", tool: "oman_supplier_check", price: 0.5, currency: "USD" } } }
        }) },
        "400": { description: "Invalid input or missing Idempotency-Key", content: json(errorSchema, { key: { summary: "Missing key", value: err("MPP_IDEMPOTENCY_KEY_REQUIRED", "Session calls require an Idempotency-Key header …") } }) },
        "402": { description: "Voucher required/invalid, insufficient session budget, or exhausted session", headers: header402, content: json({ oneOf: [paymentRequiredSchema, errorSchema] }, {
          voucher: { summary: "Voucher required", value: { success: false, error: { code: "MPP_PAYMENT_REQUIRED", message: "Payment required: …" }, protocol: "mpp", mode: "session", sessionId: EXAMPLE_ID, tool: "oman_supplier_check", amount: 0.5, remaining: 15.75, currency: "USD", paymentRequired: true, challenges: [challengeExample("session", "500000")], problem, meta: { requestId: "example-request" } } },
          budget: { summary: "Insufficient session budget", value: err("MPP_SESSION_BUDGET_EXCEEDED", "This call's price exceeds the session's remaining budget; the tool was not executed.", { required: 0.5, remaining: 0.25, currency: "USD" }) },
          exhausted: { summary: "Exhausted session", value: err("MPP_SESSION_EXHAUSTED", "This MPP session's budget is exhausted.", { sessionId: EXAMPLE_ID, remaining: 0.25, currency: "USD" }) }
        }) },
        "403": { description: "Tool not allowed in this session", content: json(errorSchema, { notAllowed: { summary: "Not allowed", value: err("MPP_TOOL_NOT_ALLOWED", "Tool \"due_diligence_oman_company\" is not in this session's allowedTools.", { tool: "due_diligence_oman_company", allowedTools: ["oman_supplier_check"] }) } }) },
        "404": { description: "Invalid session or unsupported tool", content: json(errorSchema, { missing: { summary: "Invalid session", value: err("MPP_SESSION_NOT_FOUND", "No MPP session exists with this id.") } }) },
        "409": { description: "Closed session, idempotent request still in progress", content: json(errorSchema, { closed: { summary: "Closed", value: err("MPP_SESSION_CLOSED", "This MPP session is closed.") }, inProgress: { summary: "In progress", value: err("MPP_IDEMPOTENCY_IN_PROGRESS", "A call with this Idempotency-Key is still executing; retry after it completes.") } }) },
        "410": { description: "Expired session", content: json(errorSchema, { expired: { summary: "Expired", value: err("MPP_SESSION_EXPIRED", "This MPP session has expired; close it to settle, then open a new one.") } }) },
        "422": { description: "Idempotency conflict (same key, different tool/input)", content: json(errorSchema, { conflict: { summary: "Conflict", value: err("MPP_IDEMPOTENCY_CONFLICT", "This Idempotency-Key was already used in this session for a different tool or input.") } }) }
      }
    } };
    paths[mppBasePath + "/sessions/{sessionId}/close"] = { post: {
      operationId: "mpp_close_session", tags: ["MPP"], summary: "Close a session: stop calls, finalize metering, settle",
      description: "Idempotent. Stops further calls, finalizes metering and settles on-chain: with the payer's channel `close` credential the channel closes capturing exactly the metered spend (the rest of the deposit is refunded); without it the server settles when the signed voucher equals the metered spend, otherwise settlement.status is `pending_payer_close`. Returns final usage.",
      security: [], parameters: [idParam, authParam],
      responses: {
        "200": { description: "Final usage", content: json({ type: "object", properties: { success: { const: true }, data: sessionSchema } }, { closed: { summary: "Closed + settled", value: { success: true, data: sessionExample({ status: "closed", closedAt: "2026-09-23T08:30:00.000Z", settlement: { status: "settled", reference: "0x" + "5d".repeat(32), settled: 4.25 } }), meta: { requestId: "example-request" } } } }) },
        "404": { description: "Invalid session", content: json(errorSchema) },
        "409": { description: "A call is still executing (retry), or the session was never opened", content: json(errorSchema) }
      }
    } };
  }
  void tools;
  return paths;
}
