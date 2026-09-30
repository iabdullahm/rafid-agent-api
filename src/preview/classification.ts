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

/** Preview leakage is classified by what the response reveals, not by a numeric score. All current
 * previews intentionally return availability/coverage signals only; paid decision fields remain
 * protected. The explicit map makes a future preview addition fail review rather than silently
 * inheriting an optimistic classification. */
export const PREVIEW_LEAKAGE_CLASS: Readonly<Record<string, "SAFE" | "LOW" | "MEDIUM" | "HIGH">> = Object.freeze({
  analyze_oman_property: "SAFE", oman_supplier_check: "SAFE", company_reputation_check: "SAFE",
  business_risk_score: "SAFE", research_company: "SAFE", document_facts_extract: "SAFE",
  invoice_anomaly_check: "SAFE", vehicle_value_estimate: "SAFE", shipping_cost_estimate: "SAFE",
  website_audit: "SAFE", website_project_estimate: "SAFE", company_due_diligence: "SAFE",
  website_download: "SAFE", social_video_generate: "SAFE", news_video_generate: "SAFE",
  product_promo_video: "SAFE", break_even_calculator: "SAFE", business_idea_validate: "SAFE",
  cv_score: "SAFE", extract_candidate_profile: "SAFE", generate_job_profile: "SAFE",
  product_pricing_calculator: "SAFE", startup_cost_estimate: "SAFE", startup_readiness_score: "SAFE"
});

export function previewLeakageClass(capabilityName: string): "SAFE" | "LOW" | "MEDIUM" | "HIGH" {
  return PREVIEW_LEAKAGE_CLASS[capabilityName] ?? "SAFE";
}

export const PREVIEW_COST_TIER: Readonly<Record<string, PreviewCostTier>> = Object.freeze({
  research_company: "medium",
  analyze_oman_property: "medium",
  oman_supplier_check: "medium",
  company_reputation_check: "medium",
  business_risk_score: "medium",
  vehicle_value_estimate: "medium",
  document_facts_extract: "expensive",
  invoice_anomaly_check: "expensive"
  ,shipping_cost_estimate: "lightweight"
});

/** Unknown/uncatalogued capabilities default to "medium" — the middle-ground budget — rather than
 *  silently getting no extra protection at all. */
export function previewCostTier(capabilityName: string): PreviewCostTier {
  return PREVIEW_COST_TIER[capabilityName] ?? "medium";
}
