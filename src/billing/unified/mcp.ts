import type { Request, RequestHandler, Response } from "express";
import { publicError } from "../../utils/errors.js";
import { bearerBillingKey } from "./apiKeys.js";
import { subscriptionView, type BillingEngine } from "./engine.js";
import { enabledPaymentMethodIds, railAvailability, type RailDiscoveryConfig } from "./discovery.js";
import { requestHash, runBilledCall, validIdempotencyKey } from "./execution.js";
import { money } from "./money.js";
import { detectCredentials, selectPayment } from "./selection.js";
import { PAYMENT_METHOD_HEADER } from "./types.js";
import type { BillableCapability } from "./http.js";

/**
 * MCP + API-key billing: a remote MCP (Streamable HTTP) endpoint at /mcp/credits whose paid
 * `tools/call` requests are billed to the caller's Rafid account (subscription allowance, then
 * prepaid credits) through exactly the same execution.ts path the REST routes use.
 *
 * Mounted at its OWN path, like the MPP-over-MCP binding (/mcp/mpp): the existing free /mcp
 * endpoint's behavior is not changed in any way. `initialize`, `tools/list`, notifications and
 * the free `preview_capability` tool are delegated verbatim to the standard MCP handler.
 *
 * Authentication: `Authorization: Bearer raf_live_…` on the HTTP request (MCP clients set this as
 * a static header in their remote-server config). Missing/invalid keys fail at the HTTP layer
 * with 401, which is how MCP clients expect a remote server to signal auth problems.
 * Idempotency: `params._meta["com.rafidsystem/idempotency-key"]` or an Idempotency-Key header.
 * A paid result carries `_meta["com.rafidsystem/billing"]` ({ rail, amount, remainingBalance,
 * transactionId }); structuredContent stays exactly the tool's declared output schema.
 *
 * x402 / L402 are HTTP-header protocols and are not offered over MCP; MPP over MCP remains
 * available at /mcp/mpp. Naming one of them in X-Rafid-Payment-Method here is rejected rather
 * than silently charging the API key.
 */
export const mcpCreditsPath = "/mcp/credits";
export const BILLING_META_KEY = "com.rafidsystem/billing";
export const IDEMPOTENCY_META_KEY = "com.rafidsystem/idempotency-key";

interface JsonRpcBody { jsonrpc?: string; id?: string | number | null; method?: unknown; params?: { name?: unknown; arguments?: unknown; _meta?: Record<string, unknown> } }

const rpcError = (id: JsonRpcBody["id"], code: number, message: string, data?: unknown) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } });
const toolError = (id: JsonRpcBody["id"], payload: unknown, meta?: unknown) => ({ jsonrpc: "2.0", id: id ?? null, result: { isError: true, content: [{ type: "text", text: JSON.stringify(payload) }], ...(meta ? { _meta: meta } : {}) } });

export function createCreditsMcpHandler(deps: {
  engine: BillingEngine;
  config: RailDiscoveryConfig;
  capabilities: readonly BillableCapability[];
  priceUsd: (tool: string) => number;
  delegate: RequestHandler;
  onToolCall?: (event: { toolName: string; status: number; durationMs: number; data?: unknown }, req: Request) => void;
}): RequestHandler {
  const availability = railAvailability(deps.config);
  const fallback = deps.config.billing?.subscriptionCreditFallback ?? true;
  return async (req: Request, res: Response, next) => {
    const body = req.body as JsonRpcBody | undefined;
    const key = bearerBillingKey(req.header("authorization"));
    if (!key) {
      res.setHeader("WWW-Authenticate", `Bearer realm="rafid"`);
      res.status(401).json(rpcError(body?.id, -32001, "A Rafid API key is required on this endpoint: Authorization: Bearer raf_live_…  (the free /mcp endpoint needs no key)"));
      return;
    }
    try {
      const auth = await deps.engine.authenticate(key);
      if (!auth.ok) {
        if (auth.status === 401) res.setHeader("WWW-Authenticate", `Bearer realm="rafid", error="invalid_token"`);
        res.status(auth.status).json(rpcError(body?.id, -32001, auth.message, { code: auth.code }));
        return;
      }
      const c = req.method === "POST" && body && !Array.isArray(body) && body.method === "tools/call" && typeof body.params?.name === "string"
        ? deps.capabilities.find(x => x.name === body.params!.name) : undefined;
      if (!c) { deps.delegate(req, res, next); return; }
      const id = body!.id ?? null;
      const decision = selectPayment(req.header(PAYMENT_METHOD_HEADER), { ...detectCredentials(name => req.header(name)), x402: false, l402: false, mpp: false, billingKey: key }, { ...availability, x402: false, l402: false, mppCharge: false }, fallback);
      if (decision.kind !== "account") {
        res.status(200).json(toolError(id, { success: false, error: { code: "payment_method_unavailable", message: "Only API-key billing (auto | credits | subscription) is available on /mcp/credits. Use /mcp/mpp for MPP, or the HTTP routes for x402/L402." }, paymentOptions: enabledPaymentMethodIds(deps.config) }));
        return;
      }
      const parsed = c.input.safeParse(body!.params!.arguments ?? {});
      if (!parsed.success) {
        const err = publicError(parsed.error);
        res.status(200).json(toolError(id, { success: false, error: err.error }));
        return;
      }
      const metaKey = body!.params!._meta?.[IDEMPOTENCY_META_KEY];
      const idemKey = typeof metaKey === "string" ? metaKey : req.header("idempotency-key");
      if (idemKey !== undefined && !validIdempotencyKey(idemKey)) { res.status(200).json(toolError(id, { success: false, error: { code: "invalid_idempotency_key", message: "Idempotency key must be 1-255 visible ASCII characters" } })); return; }
      const requestId = typeof res.locals.requestId === "string" ? res.locals.requestId : "unknown";
      const start = performance.now();
      const result = await runBilledCall({
        engine: deps.engine, tool: c, priceUsd: deps.priceUsd(c.name), toolInput: parsed.data, account: auth.account, key: auth.key,
        rails: decision.rails, subscriptionFallback: decision.subscriptionFallback, requestId,
        idempotency: idemKey ? { key: idemKey, requestHash: requestHash(c.name, body!.params!.arguments ?? {}) } : undefined
      });
      const durationMs = Math.round(performance.now() - start);
      const ok = (resultBody: any, replay: boolean) => ({ jsonrpc: "2.0", id, result: {
        content: [{ type: "text", text: JSON.stringify(resultBody.data) }], structuredContent: resultBody.data,
        _meta: { [BILLING_META_KEY]: { ...(resultBody.meta?.billing ?? {}), ...(replay ? { idempotentReplay: true } : {}) } }
      } });
      switch (result.kind) {
        case "success":
          deps.onToolCall?.({ toolName: c.name, status: 200, durationMs, data: result.data }, req);
          res.status(200).json(ok(result.body, false)); return;
        case "replay":
          if (result.status >= 200 && result.status < 300) { res.status(200).json(ok(result.body, true)); return; }
          res.status(200).json(toolError(id, result.body)); return;
        case "failed": {
          const err = publicError(result.error);
          deps.onToolCall?.({ toolName: c.name, status: err.status, durationMs }, req);
          res.status(200).json(toolError(id, { success: false, error: err.error }, { [BILLING_META_KEY]: { rail: result.authorization.rail, amount: "0.00", currency: "USD", refunded: result.refunded } }));
          return;
        }
        case "idempotency_conflict":
          res.status(200).json(toolError(id, { success: false, error: { code: "idempotency_conflict", message: "This idempotency key was already used for this tool with different arguments." } })); return;
        case "idempotency_in_progress":
          res.status(200).json(toolError(id, { success: false, error: { code: "idempotency_in_progress", message: "A call with this idempotency key is still being processed." } })); return;
        case "insufficient":
          res.status(200).json(toolError(id, {
            success: false, error: { code: result.reason, message: result.reason === "insufficient_credits" ? `The account balance does not cover ${c.name}.` : result.reason === "no_active_subscription" ? "This account has no active subscription." : "The subscription allowance for this billing period is exhausted." },
            tool: c.name, price: money(result.priceMicros), balance: money(result.balanceMicros),
            ...(result.subscription ? { subscription: subscriptionView(result.subscription) } : {}),
            paymentOptions: enabledPaymentMethodIds(deps.config)
          }));
          return;
      }
    } catch (error) { next(error); }
  };
}
