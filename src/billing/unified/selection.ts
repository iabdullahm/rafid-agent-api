import { bearerBillingKey, looksLikeBillingKey } from "./apiKeys.js";
import { PAYMENT_METHOD_HINTS, type AccountRail, type PaymentMethodHint } from "./types.js";

/**
 * Deterministic payment-rail selection for one paid call — pure (no I/O), so the exact
 * priority order is testable in isolation and identical on REST and MCP.
 *
 * `X-Rafid-Payment-Method: auto` (default):
 *   1. valid Rafid API key → subscription allowance (if the account has one)
 *   2. valid Rafid API key → prepaid credit balance (after an exhausted allowance only when
 *      BILLING_SUBSCRIPTION_CREDIT_FALLBACK=true)
 *   3. explicit x402 credential (X-PAYMENT / PAYMENT-SIGNATURE)
 *   4. L402 credential (Authorization: L402 …), if L402 is enabled
 *   5. MPP credential (Authorization: Payment … / Payment-Authorization), if MPP charge is enabled
 *   6. legacy X-API-Key customer key → the pre-existing REST flow, unchanged
 *   7. otherwise → 402 payment_required with every enabled rail advertised
 *
 * An explicit hint (credits | subscription | x402 | l402 | mpp) selects exactly that rail and
 * nothing else: an API key is NEVER charged when another method was named, and an explicit
 * `credits`/`subscription` never falls through to a crypto rail.
 */
export interface RailAvailability {
  billing: boolean;
  apiCredits: boolean;
  subscription: boolean;
  x402: boolean;
  l402: boolean;
  mppCharge: boolean;
}

export type ExternalRail = "x402" | "l402" | "mpp";

export interface PresentedCredentials {
  billingKey?: string;
  legacyApiKey: boolean;
  x402: boolean;
  l402: boolean;
  mpp: boolean;
}

export type PaymentDecision =
  | { kind: "account"; apiKey: string; rails: AccountRail[]; subscriptionFallback: boolean; externalFallback: ExternalRail | null }
  | { kind: "external"; rail: ExternalRail }
  | { kind: "legacy" }
  | { kind: "payment_required" }
  | { kind: "error"; status: number; code: string; message: string };

export function detectCredentials(header: (name: string) => string | undefined): PresentedCredentials {
  const authorization = header("authorization");
  const billingKey = bearerBillingKey(authorization) ?? (looksLikeBillingKey(header("x-rafid-api-key") ?? "") ? header("x-rafid-api-key") : undefined);
  return {
    billingKey,
    legacyApiKey: Boolean(header("x-api-key")),
    x402: Boolean(header("x-payment") || header("payment-signature")),
    l402: Boolean(authorization && /^(L402|LSAT)\s/i.test(authorization)),
    mpp: Boolean((authorization && /^Payment\s/i.test(authorization)) || header("payment-authorization"))
  };
}

export function parseMethodHint(value: string | undefined): PaymentMethodHint | null {
  if (value === undefined || value.trim() === "") return "auto";
  const v = value.trim().toLowerCase();
  return (PAYMENT_METHOD_HINTS as readonly string[]).includes(v) ? v as PaymentMethodHint : null;
}

const unavailable = (method: string): PaymentDecision => ({ kind: "error", status: 400, code: "payment_method_unavailable", message: `Payment method "${method}" is not enabled on this deployment. See GET /api/v1/payment-methods.` });

export function selectPayment(methodHeader: string | undefined, creds: PresentedCredentials, avail: RailAvailability, subscriptionCreditFallback: boolean): PaymentDecision {
  const method = parseMethodHint(methodHeader);
  if (!method) return { kind: "error", status: 400, code: "invalid_payment_method", message: `X-Rafid-Payment-Method must be one of: ${PAYMENT_METHOD_HINTS.join(", ")}` };
  const external: Record<ExternalRail, boolean> = { x402: avail.x402, l402: avail.l402, mpp: avail.mppCharge };
  if (method === "x402" || method === "l402" || method === "mpp") {
    return external[method] ? { kind: "external", rail: method } : unavailable(method);
  }
  if (method === "credits" || method === "subscription") {
    const enabled = avail.billing && (method === "credits" ? avail.apiCredits : avail.subscription);
    if (!enabled) return unavailable(method);
    if (!creds.billingKey) return { kind: "error", status: 401, code: "api_key_required", message: "A Rafid API key is required for this payment method: send Authorization: Bearer raf_live_…" };
    return { kind: "account", apiKey: creds.billingKey, rails: [method === "credits" ? "api_credits" : "subscription"], subscriptionFallback: false, externalFallback: null };
  }
  // auto
  const presentedExternal: ExternalRail | null = creds.x402 && avail.x402 ? "x402" : creds.l402 && avail.l402 ? "l402" : creds.mpp && avail.mppCharge ? "mpp" : null;
  if (creds.billingKey && avail.billing) {
    const rails: AccountRail[] = [...(avail.subscription ? ["subscription" as const] : []), ...(avail.apiCredits ? ["api_credits" as const] : [])];
    return { kind: "account", apiKey: creds.billingKey, rails, subscriptionFallback: subscriptionCreditFallback, externalFallback: presentedExternal };
  }
  if (presentedExternal) return { kind: "external", rail: presentedExternal };
  if (creds.legacyApiKey) return { kind: "legacy" };
  return avail.billing ? { kind: "payment_required" } : { kind: "legacy" };
}
