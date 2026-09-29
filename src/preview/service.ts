import { capabilities } from "../domain/capabilities.js";
import { ApiError } from "../utils/errors.js";
import type { CapabilityPreviewResult, CapabilityPreviewFullResult } from "./types.js";
import { buildPaymentMethodDetails, type PaymentDiscoveryConfig } from "../billing/paymentMethods.js";

/**
 * Free Preview — generic engine. One implementation for every capability: looks the capability up
 * in the single registry (domain/capabilities.ts), and — if it defines a `preview` function —
 * calls it and attaches `fullResult` (price/currency/endpoint) read from THAT SAME registry entry,
 * never a second literal. This is the one place both the REST route (api/previewRoutes.ts) and the
 * MCP `preview_capability` tool (mcp/server.ts) go through, so they can never disagree.
 *
 * Deliberately does not call, import or reference `execute()`, `BillingService`, the x402/L402/MPP
 * gates, or any store's `admit`/`complete` — a preview is free and can never become billable by
 * accident. Input validation errors are NOT caught here: every capability's own `preview()`
 * function parses its input with the exact same Zod schema `execute()` uses, and a thrown
 * ZodError/ApiError is left to propagate to the caller's existing error-handling (api/app.ts's
 * error middleware for REST, mcp/server.ts's publicError() for MCP) — the same 400 INVALID_INPUT
 * shape as every paid route already produces, so a preview 400 and a paid-route 400 always agree.
 */

export function findCapability(capabilityName: string) {
  return capabilities.find(c => c.name === capabilityName);
}

/** True only when the named capability exists AND defines a `preview`. Used by discovery
 *  surfaces (api/agent.ts) to advertise `preview.available` — never guessed, never a second list. */
export function isPreviewSupported(capabilityName: string): boolean {
  return Boolean(findCapability(capabilityName)?.preview);
}

export interface PreviewRuntimeOptions {
  /** Payment-rail config (x402Enabled/l402Enabled/mpp) — when supplied, fullResult.paymentMethods
   *  is populated from the real, currently-enabled rails (billing/paymentMethods.ts). Omitted by
   *  callers that don't have a Config in scope (e.g. a unit test constructing this directly), in
   *  which case fullResult carries no paymentMethods field, exactly as before this option existed. */
  config?: PaymentDiscoveryConfig;
}

export async function runCapabilityPreview(capabilityName: string, rawInput: unknown, options: PreviewRuntimeOptions = {}): Promise<CapabilityPreviewResult> {
  const capability = findCapability(capabilityName);
  if (!capability) {
    throw new ApiError(404, "CAPABILITY_NOT_FOUND", `No such capability "${capabilityName}". See GET /api/v1/capabilities for the full list of tools.`);
  }
  const paymentMethods = options.config ? buildPaymentMethodDetails(options.config, capability) : [];
  const fullResult: CapabilityPreviewFullResult = {
    capability: capability.name,
    price: { amount: capability.price.toFixed(2), currency: capability.currency },
    endpoint: "/api/v1" + capability.path,
    ...(paymentMethods.length ? { paymentMethods } : {})
  };
  if (!capability.preview) {
    // A real, callable capability that simply has no free-preview implementation yet — distinct
    // from "capability doesn't exist" (404 above). Never an error: an agent following
    // discover → preview → evaluate → pay → execute should be able to try preview on anything the
    // registry lists and get an honest, structured answer either way.
    return { capability: capability.name, status: "unavailable", inputRecognized: false, preview: {}, fullResult };
  }
  const body = await capability.preview(rawInput);
  return { ...body, fullResult };
}
