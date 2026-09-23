import type { Config } from "../../config/env.js";
import { disabledBillingConfig, type BillingConfig } from "./config.js";
import { PAYMENT_METHOD_HINTS } from "./types.js";
import type { RailAvailability } from "./selection.js";

/** Rail config every payment-discovery builder reads. Everything but x402 is optional so older
 *  callers/tests that pass only the x402 fields keep compiling and keep their exact output. */
export type RailDiscoveryConfig = Pick<Config, "x402Enabled" | "x402Network"> & Partial<Pick<Config, "l402Enabled" | "l402Network" | "mpp" | "billing">>;

export const paymentMethodsPath = "/api/v1/payment-methods";

const billingOf = (c: RailDiscoveryConfig): BillingConfig => c.billing ?? disabledBillingConfig;

export function railAvailability(config: RailDiscoveryConfig): RailAvailability {
  const b = billingOf(config);
  return {
    billing: b.enabled,
    apiCredits: b.enabled && b.apiCreditsEnabled,
    subscription: b.enabled && b.subscriptionsEnabled,
    x402: config.x402Enabled,
    l402: Boolean(config.l402Enabled),
    mppCharge: Boolean(config.mpp?.enabled && config.mpp.modes.includes("charge"))
  };
}

/** Unified payment-method ids of every ENABLED rail, in advertising order. Disabled rails are
 *  never listed. (`mpp` here is the unified id; the per-capability registry keeps its existing,
 *  more specific `mpp-charge` / `mpp-session` ids for backward compatibility.) */
export function enabledPaymentMethodIds(config: RailDiscoveryConfig): string[] {
  const a = railAvailability(config);
  return [
    ...(a.x402 ? ["x402"] : []),
    ...(a.apiCredits ? ["api_credits"] : []),
    ...(a.subscription ? ["subscription"] : []),
    ...(a.l402 ? ["l402"] : []),
    ...(config.mpp?.enabled ? ["mpp"] : [])
  ];
}

/** Account-backed rails for the per-capability `paymentMethods` array (appended after the
 *  existing x402/l402/mpp-* ids, never replacing them). */
export function accountPaymentMethodIds(config: RailDiscoveryConfig): string[] {
  const a = railAvailability(config);
  return [...(a.apiCredits ? ["api_credits"] : []), ...(a.subscription ? ["subscription"] : [])];
}

/** GET /api/v1/payment-methods */
export function buildPaymentMethods(config: RailDiscoveryConfig) {
  const a = railAvailability(config);
  const b = billingOf(config);
  const methods: Record<string, unknown>[] = [];
  if (a.x402) methods.push({ id: "x402", enabled: true, type: "pay_per_call", currency: "USDC", asset: "USDC", network: config.x402Network, authentication: "none", credential: "X-PAYMENT (x402 v1) or PAYMENT-SIGNATURE (x402 v2) header", endpoints: { canonical: "POST /api/v1/<tool-path> with X-Rafid-Payment-Method: x402", dedicated: "POST /api/v1/x402/<tool-path>" }, info: "/api/v1/x402" });
  if (a.apiCredits) methods.push({ id: "api_credits", enabled: true, type: "prepaid", currency: "USD", authentication: "api_key", credential: "Authorization: Bearer raf_live_…", balance: "/api/v1/account/balance" });
  if (a.subscription) methods.push({ id: "subscription", enabled: true, type: "subscription", currency: "USD", authentication: "api_key", credential: "Authorization: Bearer raf_live_…", plans: Object.values(b.plans).map(p => ({ id: p.id, name: p.name, allowance: { type: p.allowance.type, monthlyIncluded: (p.allowance.monthlyIncludedMicros / 1_000_000).toFixed(2), currency: "USD" } })), creditFallback: b.subscriptionCreditFallback && a.apiCredits });
  if (a.l402) methods.push({ id: "l402", enabled: true, type: "pay_per_call", currency: "BTC", network: `lightning:${config.l402Network ?? "mainnet"}`, authentication: "none", credential: "Authorization: L402 <macaroon>:<preimage>", endpoints: { canonical: "POST /api/v1/<tool-path> with X-Rafid-Payment-Method: l402", dedicated: "POST /api/v1/l402/<tool-path>" }, info: "/api/v1/l402" });
  if (config.mpp?.enabled) methods.push({ id: "mpp", enabled: true, type: "pay_per_call", modes: [...config.mpp.modes], network: config.mpp.tempo.network, authentication: "none", credential: "Authorization: Payment <credential>", endpoints: { ...(a.mppCharge ? { canonical: "POST /api/v1/<tool-path> with X-Rafid-Payment-Method: mpp", charge: "POST /api/v1/mpp/charge/<tool>" } : {}), ...(config.mpp.modes.includes("session") ? { sessions: "POST /api/v1/mpp/sessions" } : {}) }, info: "/api/v1/mpp" });
  return {
    methods,
    selection: {
      header: "X-Rafid-Payment-Method",
      values: [...PAYMENT_METHOD_HINTS],
      default: "auto",
      autoPriority: ["subscription", "api_credits", "x402", "l402", "mpp"].filter(id => methods.some(m => m.id === id)),
      note: "auto charges a presented Rafid API key first (subscription allowance, then prepaid credits); naming any other method never charges the API key."
    },
    idempotency: { header: "Idempotency-Key", scope: "account + tool", appliesTo: ["api_credits", "subscription"] }
  };
}

/** The `paymentOptions` object of a generic 402 payment_required response. */
export function paymentOptionsObject(config: RailDiscoveryConfig) {
  const a = railAvailability(config);
  return {
    x402: a.x402 ? { enabled: true, network: config.x402Network, asset: "USDC", selectWith: "X-Rafid-Payment-Method: x402" } : { enabled: false },
    apiCredits: a.apiCredits ? { enabled: true, authentication: "api_key", header: "Authorization: Bearer raf_live_…" } : { enabled: false },
    subscription: a.subscription ? { enabled: true, authentication: "api_key", header: "Authorization: Bearer raf_live_…" } : { enabled: false },
    l402: a.l402 ? { enabled: true, network: `lightning:${config.l402Network ?? "mainnet"}`, selectWith: "X-Rafid-Payment-Method: l402" } : { enabled: false },
    mpp: a.mppCharge ? { enabled: true, network: config.mpp!.tempo.network, selectWith: "X-Rafid-Payment-Method: mpp" } : { enabled: false }
  };
}
