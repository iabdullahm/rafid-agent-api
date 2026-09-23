import type { Request, RequestHandler, Response } from "express";
import { Credential, Mcp, Receipt } from "mppx";
import { classifyDataSource } from "../../analytics/dataSource.js";
import type { CapabilityName } from "../catalog.js";
import { requestIdOf } from "./middleware.js";
import type { MppResult, MppService } from "./service.js";

/**
 * Optional MPP-over-MCP payment layer (MPP_MCP_ENABLED=true, default false), implementing the
 * Machine Payments Protocol's own MCP transport binding (the one the official mppx SDK's
 * McpClient speaks): a paid `tools/call` without a credential fails with JSON-RPC error
 * -32042 whose `data.challenges` are the MPP challenges; the client retries the same call with
 * `params._meta["org.paymentauth/credential"]`; a paid result carries
 * `_meta["org.paymentauth/receipt"]`.
 *
 * Separation of concerns stays intact:
 *   MCP  = tool discovery and invocation (the existing, unchanged /mcp server and registry)
 *   MPP  = payment authorization and metering (billing/mpp/service.ts — the same code path the
 *          HTTP routes use, so charge/session semantics are identical on both transports)
 *
 * It is mounted at its OWN path (/mcp/mpp) so the free /mcp endpoint's behavior never changes.
 * `initialize`, `tools/list` and everything else are delegated verbatim to the standard MCP
 * handler (same tools, same schemas); only `tools/call` is payment-gated here.
 *
 * Session mode over MCP: a client that holds a Rafid MPP session (opened over HTTP — see
 * README) passes `_meta["com.rafidsystem/mpp-session"] = { sessionId, idempotencyKey }`; the call
 * is then metered against that session exactly like POST /api/v1/mpp/sessions/{id}/tools/{tool},
 * with its voucher credential in the same org.paymentauth/credential slot.
 */
export const mppMcpPath = "/mcp/mpp";
export const RAFID_SESSION_META_KEY = "com.rafidsystem/mpp-session";

interface JsonRpcBody { jsonrpc?: string; id?: string | number | null; method?: unknown; params?: { name?: unknown; arguments?: unknown; _meta?: Record<string, unknown> } }

function credentialHeader(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string") return /^Payment\s/i.test(value) ? value : `Payment ${value}`;
  try { return Credential.serialize(value as Credential.Credential); } catch { return "Payment invalid"; }
}

function receiptObject(result: MppResult, challengeId: string | null): unknown {
  const header = result.headers.find(([k]) => k.toLowerCase() === "payment-receipt")?.[1];
  if (!header) return undefined;
  try { return { ...Receipt.deserialize(header), ...(challengeId ? { challengeId } : {}) }; }
  catch {
    try { return { ...JSON.parse(Buffer.from(header, "base64url").toString("utf8")), ...(challengeId ? { challengeId } : {}) }; }
    catch { return undefined; }
  }
}

export function toJsonRpc(result: MppResult, id: JsonRpcBody["id"], challengeId: string | null) {
  if (result.status >= 200 && result.status < 300) {
    const data = result.body.data;
    return {
      jsonrpc: "2.0", id,
      result: {
        content: [{ type: "text", text: JSON.stringify(data) }],
        structuredContent: data,
        _meta: {
          [Mcp.receiptMetaKey]: receiptObject(result, challengeId),
          "com.rafidsystem/mpp": { ...(result.body.payment ? { payment: result.body.payment } : {}), ...(result.body.usage ? { usage: result.body.usage } : {}) }
        }
      }
    };
  }
  if (result.status === 402 && result.challengeWire?.length) {
    const code = (result.body.error as { code?: string } | undefined)?.code;
    return {
      jsonrpc: "2.0", id,
      error: {
        code: code && code !== "MPP_PAYMENT_REQUIRED" ? Mcp.paymentVerificationFailedCode : Mcp.paymentRequiredCode,
        message: (result.body.error as { message?: string } | undefined)?.message ?? "Payment Required",
        data: { httpStatus: 402, challenges: result.challengeWire, problem: result.body.problem, rafid: { code, ...(result.body.usage ? { usage: result.body.usage } : {}) } }
      }
    };
  }
  // Tool/validation/budget errors are tool results (isError), like the free MCP server's.
  return { jsonrpc: "2.0", id, result: { isError: true, content: [{ type: "text", text: JSON.stringify({ success: false, error: result.body.error, ...(result.body.required !== undefined ? { required: result.body.required, remaining: result.body.remaining } : {}) }) }] } };
}

export function createMppMcpHandler(deps: { service: MppService; delegate: RequestHandler }): RequestHandler {
  return async (req: Request, res: Response, next) => {
    const body = req.body as JsonRpcBody | undefined;
    if (req.method !== "POST" || !body || Array.isArray(body) || body.method !== "tools/call") { deps.delegate(req, res, next); return; }
    try {
      const params = body.params ?? {};
      const tool = typeof params.name === "string" ? params.name : "";
      const meta = params._meta ?? {};
      const credentialValue = meta[Mcp.credentialMetaKey];
      const authorization = credentialHeader(credentialValue);
      const challengeId = credentialValue && typeof credentialValue === "object" ? String((credentialValue as { challenge?: { id?: unknown } }).challenge?.id ?? "") || null : null;
      const session = meta[RAFID_SESSION_META_KEY] as { sessionId?: unknown; idempotencyKey?: unknown } | undefined;
      const url = `https://${deps.service.config.realm}${mppMcpPath}`;
      const common = { body: params.arguments ?? {}, authorization, url, requestId: requestIdOf(res) };
      const result = session && typeof session.sessionId === "string"
        ? await deps.service.callTool({ ...common, sessionId: session.sessionId, tool, idempotencyKey: typeof session.idempotencyKey === "string" ? session.idempotencyKey : undefined })
        : await deps.service.charge({ ...common, tool });
      if (result.executed) {
        res.locals.toolName = result.executed.tool;
        res.locals.channel = result.executed.channel;
        if (result.executed.success && result.executed.data !== undefined) res.locals.dataSource = classifyDataSource(result.executed.tool as CapabilityName, result.executed.data);
      }
      res.status(200).json(toJsonRpc(result, body.id ?? null, challengeId));
    } catch (error) { next(error); }
  };
}
