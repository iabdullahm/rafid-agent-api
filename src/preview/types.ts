/**
 * Free Preview layer — shared contract.
 *
 * A preview answers "do you have useful information for this request?", never "here is the
 * useful information." Every capability that implements `preview` on its AgentCapability entry
 * (domain/capabilities.ts) returns a `CapabilityPreviewBody` from a cheap, capability-specific
 * check (never by running the full paid `execute()` and hiding fields — see each capability's
 * own preview function for what it actually does instead); the generic engine
 * (src/preview/service.ts) then attaches `fullResult` from the SAME registry entry `execute()`
 * is billed from, so pricing can never drift between the paid route and the preview.
 */

/** "available": input recognized and enough is configured/found that the paid call is likely to
 *  return real content. "limited": input recognized, but this deployment has little/no source
 *  configured for it (the paid call will mostly return honest not_configured/empty results too —
 *  never hidden, per every capability's own documented behavior). "unavailable": this capability
 *  has no preview implementation at all (a genuinely different case from "limited" — the capability
 *  is real and callable, there is simply nothing to preview yet). "invalid_input": the input failed
 *  the capability's own Zod schema — the same validation the paid route runs, so a preview 400 and
 *  a paid-route 400 always agree. */
export type CapabilityPreviewStatus = "available" | "limited" | "unavailable" | "invalid_input";

/** Objective, non-prescriptive coverage signals an agent can weigh for itself. Every field is
 *  optional: a capability includes only the signals it can honestly compute cheaply. Nothing here
 *  is ever a finding, a score, or a recommendation to purchase — see each capability's own preview
 *  function for the specific line between "coverage signal" (safe) and "paid finding" (withheld). */
export interface CapabilityPreviewSignals {
  entity?: string;
  entityType?: string;
  sourcesFound?: number;
  freshestSourceDate?: string;
  coverageScore?: number;
  dataCoverage?: "low" | "medium" | "high";
  /** Real, schema-derived top-level section names the PAID result will include for this
   *  capability — always the same list regardless of this call's input, so it can never leak
   *  per-request findings. See each preview function's own comment for how its list was chosen. */
  availableSections?: string[];
  /** Additional capability-specific objective counts/booleans that don't fit a named field above
   *  (e.g. how many provider categories are configured for this deployment). Never a business
   *  finding, a probability of anything but data availability, or free-text summarizing content. */
  signals?: Record<string, string | number | boolean>;
}

/** What a capability's own `preview(input)` function returns — everything EXCEPT `fullResult`,
 *  which the generic engine (runCapabilityPreview) always attaches itself from the capability
 *  registry, so no preview implementation can ever state a stale or duplicated price. */
export interface CapabilityPreviewBody {
  capability: string;
  status: CapabilityPreviewStatus;
  inputRecognized: boolean;
  preview: CapabilityPreviewSignals;
}

export interface CapabilityPreviewFullResult {
  capability: string;
  price: { amount: string; currency: string };
  paymentMethods?: string[];
  endpoint?: string;
}

/** The complete response of POST /api/v1/preview/:capability and the `preview_capability` MCP
 *  tool. */
export interface CapabilityPreviewResult extends CapabilityPreviewBody {
  fullResult: CapabilityPreviewFullResult;
}
