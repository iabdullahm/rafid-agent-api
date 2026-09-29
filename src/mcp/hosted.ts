import { randomUUID } from "node:crypto";
import { ApiError } from "../utils/errors.js";
import type { McpServerOptions } from "./server.js";
import { BILLING_META_KEY } from "../billing/unified/mcp.js";

/**
 * MCP (stdio) + API credits — "hosted mode".
 *
 * The local stdio server (`npm run mcp`, src/mcp.ts) normally runs every capability in-process,
 * unmetered, with whatever data this machine has. When RAFID_API_KEY is set, it instead forwards
 * each tools/call to the hosted Rafid API (RAFID_API_URL, default https://api.rafidsystem.com) as
 * POST /api/v1/<tool-path> with `Authorization: Bearer <RAFID_API_KEY>` and a fresh
 * Idempotency-Key — so the call is charged to that key's account (subscription allowance, then
 * prepaid credits) exactly like a REST call, and the agent needs no crypto wallet. Tool names,
 * schemas and descriptions are identical; the billing result is attached to the tool result as
 * `_meta["com.rafidsystem/billing"]`. RAFID_PAYMENT_METHOD (auto | credits | subscription) may pin
 * the rail. An insufficient balance comes back as a tool error carrying the 402 details.
 */
export function createHostedExecutor(options: { apiKey: string; baseUrl?: string; paymentMethod?: string; fetchImpl?: typeof fetch; timeoutMs?: number }): NonNullable<McpServerOptions["execute"]> {
  const baseUrl = (options.baseUrl || "https://api.rafidsystem.com").replace(/\/+$/, "");
  const doFetch = options.fetchImpl ?? fetch;
  return async (capability, input) => {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}/api/v1${capability.path}`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
          "X-Rafid-Payment-Method": options.paymentMethod || "auto",
          "User-Agent": "rafid-agent-api-mcp-stdio/0.1.0"
        },
        body: JSON.stringify(input),
        signal: AbortSignal.timeout(options.timeoutMs ?? 60000)
      });
    } catch {
      throw new ApiError(503, "UPSTREAM_UNAVAILABLE", `Could not reach the Rafid API at ${baseUrl}`);
    }
    const body = await response.json().catch(() => null) as { success?: boolean; data?: unknown; meta?: { billing?: unknown }; error?: { code?: string; message?: string; details?: unknown }; [k: string]: unknown } | null;
    if (response.ok && body?.success) return { data: body.data, meta: body.meta?.billing ? { [BILLING_META_KEY]: body.meta.billing } : undefined };
    const { success: _s, error, meta: _m, ...rest } = body ?? {};
    throw new ApiError(response.status, error?.code ?? "UPSTREAM_ERROR", error?.message ?? `The Rafid API answered HTTP ${response.status}`, error?.details ?? (Object.keys(rest).length ? rest : undefined));
  };
}
