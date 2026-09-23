import { getTavilyApiKey, getWebSearchProviderMode } from "../config.js";
import { NotConfiguredWebSearchProvider, TavilyWebSearchProvider, type WebSearchProvider } from "./provider.js";

/** Constructed fresh per call (not module-load-once like buildProvider() in
 *  services/omanBusiness.ts) because a requestId/capability name is needed per invocation for
 *  cost-attribution (Section "Upstream Cost Control": every provider call should be able to
 *  record provider/estimatedCostUSD/requestId/capability) — a Tavily client is a thin,
 *  stateless wrapper, so building one per request has no meaningful overhead. */
export function buildWebSearchProvider(context: { requestId: string | null; capability: string }): WebSearchProvider {
  const mode = getWebSearchProviderMode();
  if (mode === "none") return new NotConfiguredWebSearchProvider();
  const apiKey = getTavilyApiKey();
  if (!apiKey) return new NotConfiguredWebSearchProvider(); // misconfigured (mode set, key missing) — fail honest-empty, never throw mid-request.
  return new TavilyWebSearchProvider({ apiKey, requestId: context.requestId, capability: context.capability });
}

export function isWebSearchConfigured(): boolean {
  return getWebSearchProviderMode() !== "none" && Boolean(getTavilyApiKey());
}
