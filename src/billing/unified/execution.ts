import { createHash } from "node:crypto";
import { billingResultView, type AuthorizeOutcome, type BillingEngine } from "./engine.js";
import type { AccountRail, ApiKeyRecord, BillingAccount, BillingAuthorization } from "./types.js";

/**
 * The one shared "authorize → execute → settle/refund" path for account-billed calls (API
 * credits and subscription allowance), used by both the REST dispatcher (http.ts) and the MCP
 * credits transport (mcp.ts), so charging semantics are identical on every protocol.
 *
 * Charging policy (documented in docs/billing.md):
 *  - Input is schema-validated BEFORE any reservation → invalid input is never charged.
 *  - The price is reserved atomically (ledger entry `pending`) before the capability runs.
 *  - The capability succeeds → the reservation is settled (`settled`) — the customer is charged.
 *  - The capability throws — for ANY reason (internal failure, upstream provider outage, or a
 *    capability-level "not found/unreadable" error) → the reservation is released: the ledger
 *    entry becomes `refunded` and a matching `refund` entry restores the balance/allowance.
 *    Customers only ever pay for a successful (2xx) result — the same rule the x402 gate
 *    applies (it settles only after a successful response).
 *  - A process crash between reserve and settle leaves a `pending` entry; `npm run billing --
 *    release-stale` (or POST /api/internal/billing/maintenance/release-stale) refunds it.
 */
export type BilledCallResult =
  | { kind: "success"; data: unknown; body: SuccessBody; authorization: BillingAuthorization }
  | { kind: "replay"; status: number; body: unknown }
  | { kind: "failed"; error: unknown; authorization: BillingAuthorization; refunded: boolean }
  | Exclude<AuthorizeOutcome, { kind: "authorized" } | { kind: "replay" }>;

export interface SuccessBody {
  success: true;
  data: unknown;
  meta: { requestId: string; tool: string; price: number; currency: "USD"; billing: ReturnType<typeof billingResultView> };
}

export async function runBilledCall(input: {
  engine: BillingEngine;
  tool: { name: string; execute: (input: unknown) => Promise<unknown> };
  priceUsd: number;
  toolInput: unknown;
  account: BillingAccount;
  key: ApiKeyRecord;
  rails: AccountRail[];
  subscriptionFallback: boolean;
  requestId: string;
  idempotency?: { key: string; requestHash: string };
}): Promise<BilledCallResult> {
  const outcome = await input.engine.authorize({
    toolName: input.tool.name, account: input.account, key: input.key, rails: input.rails,
    subscriptionFallback: input.subscriptionFallback, requestId: input.requestId, idempotency: input.idempotency
  });
  if (outcome.kind === "replay") return { kind: "replay", status: outcome.responseStatus, body: outcome.responseBody };
  if (outcome.kind !== "authorized") return outcome;
  const auth = outcome.authorization;
  const idem = input.idempotency ? { toolName: input.tool.name, key: input.idempotency.key } : undefined;
  let data: unknown;
  try {
    data = await input.tool.execute(input.toolInput);
  } catch (error) {
    let refunded = false;
    try { refunded = Boolean(await input.engine.release(auth, "capability_failed", idem)); } catch { /* left pending → released by release-stale */ }
    return { kind: "failed", error, authorization: auth, refunded };
  }
  const body: SuccessBody = {
    success: true, data,
    meta: { requestId: input.requestId, tool: input.tool.name, price: input.priceUsd, currency: "USD", billing: billingResultView(auth) }
  };
  try {
    await input.engine.settle(auth, idem ? { ...idem, responseStatus: 200, responseBody: body } : undefined);
  } catch {
    // The result was produced; a settlement write failure must not turn it into an error. The
    // entry stays `pending` and is released by release-stale — i.e. this failure mode resolves in
    // the customer's favor, never as a double charge.
  }
  return { kind: "success", data, body, authorization: auth };
}

/** Stable JSON (recursively sorted keys) — the canonical form hashed for idempotency. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().filter(k => obj[k] !== undefined).map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

export const requestHash = (tool: string, body: unknown) => createHash("sha256").update(tool + "\n" + stableStringify(body)).digest("hex");

/** Idempotency keys: 1–255 visible ASCII characters (Stripe-compatible). */
export function validIdempotencyKey(value: string | undefined): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{1,255}$/.test(value);
}
