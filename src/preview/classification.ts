/**
 * Free Preview — cost classification.
 *
 * Every previewable capability's preview() implementation is already cheap by construction (see
 * preview/service.ts's doc comment: never a stubbed execute(), always a genuinely lightweight
 * check). This classification is a coarser, ABUSE-protection signal on top of that — how much it
 * would cost this deployment if the same free preview were hammered repeatedly with different
 * inputs (entity enumeration) — used to size a stricter, capability-specific request budget
 * (preview/rateLimit.ts) and to pick a cache TTL bucket (preview/cache.ts) without inventing a
 * separate config value per capability.
 *
 * "medium": the preview still does real work per call — resolving an entity identity and/or a
 * provider/comparable lookup (analyze_oman_property, oman_supplier_check,
 * company_reputation_check, business_risk_score, research_company) — but the work is bounded by a
 * small, structured input (a company name, a location). vehicle_value_estimate's preview never
 * queries a provider (it only normalizes the vehicle and checks provider coverage), but it shares
 * this tier so vehicle identities cannot be enumerated for free faster than company identities.
 *
 * "expensive": the preview's cost scales with caller-supplied CONTENT, not just identity —
 * document_facts_extract and invoice_anomaly_check accept a document/invoice payload (up to the
 * capability's own request body limit) that the preview must at least partially parse/normalize.
 * A caller could otherwise post a large, distinct "invoice" or "document" on every request to
 * force real parsing work with no cache reuse — these two get the tighter per-capability budget.
 */
export type PreviewCostTier = "lightweight" | "medium" | "expensive";

export const PREVIEW_COST_TIER: Readonly<Record<string, PreviewCostTier>> = Object.freeze({
  research_company: "medium",
  analyze_oman_property: "medium",
  oman_supplier_check: "medium",
  company_reputation_check: "medium",
  business_risk_score: "medium",
  vehicle_value_estimate: "medium",
  document_facts_extract: "expensive",
  invoice_anomaly_check: "expensive"
});

/** Unknown/uncatalogued capabilities default to "medium" — the middle-ground budget — rather than
 *  silently getting no extra protection at all. */
export function previewCostTier(capabilityName: string): PreviewCostTier {
  return PREVIEW_COST_TIER[capabilityName] ?? "medium";
}
