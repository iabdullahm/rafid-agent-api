import type { Config } from "../config/env.js";
import { x402BasePath } from "./x402.js";
import { l402BasePath } from "./l402/gate.js";
import { mppBasePath } from "./mpp/routes.js";

/**
 * Same payment-rail config shape api/agent.ts's paymentMethodsFor() reads. Kept as its own type
 * here (rather than importing PaymentDiscoveryConfig from api/agent.ts) to avoid a circular
 * import: api/agent.ts already imports previewBasePath from api/previewRoutes.ts, which imports
 * runCapabilityPreview from preview/service.ts — if preview/service.ts imported back from
 * api/agent.ts that would close a cycle (agent.ts -> previewRoutes.ts -> service.ts -> agent.ts).
 * This module sits in the billing layer, below api/, so both api/agent.ts and preview/service.ts
 * can depend on it safely without depending on each other.
 */
export type PaymentDiscoveryConfig = Pick<Config, "x402Enabled"> & Partial<Pick<Config, "l402Enabled" | "mpp">>;

export type PaymentMethodId = "x402" | "l402" | "mpp-charge" | "mpp-session";

export interface PaymentMethodDetail {
  id: PaymentMethodId;
  enabled: true;
  /** Where to actually use this rail for this capability — built from the same exported base-path
   *  constant every paid route family for this rail is mounted under, so this can never drift from
   *  the real route. */
  endpoint: string;
}

/**
 * Real, config-derived payment methods for one capability — the single place that answers "which
 * payment rails can an agent actually use for this capability, right now, on this deployment".
 * Used to populate the Free Preview's `fullResult.paymentMethods` (see src/preview/service.ts) so
 * an agent can discover viable payment rails without a second hardcoded rail list, and without the
 * preview layer duplicating any endpoint-building logic of its own.
 *
 * Mirrors the exact enabled-check api/agent.ts's paymentMethodsFor() already uses (x402Enabled /
 * l402Enabled / mpp.enabled + mpp.modes) — the two live in different layers (billing vs. api) so
 * one can't simply import the other (see this module's doc comment above), but both read the same
 * three config flags, so they can never disagree about which rails are enabled.
 *
 * Deliberately returns only rails that are actually enabled on this deployment — a disabled rail
 * is never included, so nothing here ever "advertises" a rail the deployment can't actually
 * settle. Excludes the legacy X-API-Key REST rail (this app's own discovery already frames REST as
 * a "compatibility" transport, not a peer payment protocol — see api/agent.ts's buildAgentInfo())
 * and the not-yet-wired unified billing layer (prepaid API credits / subscriptions — see
 * src/billing/unified/, present on disk but not imported anywhere in this app as of this change,
 * so it is not "real configuration" yet within the meaning of this function).
 */
export function buildPaymentMethodDetails(config: PaymentDiscoveryConfig, capability: { name: string; path: string }): PaymentMethodDetail[] {
  const methods: PaymentMethodDetail[] = [];
  if (config.x402Enabled) methods.push({ id: "x402", enabled: true, endpoint: x402BasePath + capability.path });
  if (config.l402Enabled) methods.push({ id: "l402", enabled: true, endpoint: l402BasePath + capability.path });
  if (config.mpp?.enabled && config.mpp.modes.includes("charge")) methods.push({ id: "mpp-charge", enabled: true, endpoint: `${mppBasePath}/charge/${capability.name}` });
  if (config.mpp?.enabled && config.mpp.modes.includes("session")) methods.push({ id: "mpp-session", enabled: true, endpoint: `${mppBasePath}/sessions` });
  return methods;
}
