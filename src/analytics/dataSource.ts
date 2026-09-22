import type { DataSource } from "./types.js";

/**
 * Classifies a capability's own response as backed by real (partner-fed/imported) data, the
 * honest demo/manual fallback, both, or (for tools with no such field) unknown — read straight
 * off fields each capability ALREADY publishes for exactly this reason, never inferred, guessed,
 * or computed from anything else. This mirrors the project's existing, established pattern of
 * never asserting a trust/verification level beyond what the data itself supports (see
 * business-data's `verificationStatus` discipline and analyze_oman_property's own
 * `demo_dataset_not_live_market_data` risk flag) — this function just makes that same signal
 * queryable in aggregate, for operator-facing analytics, rather than changing what any response
 * contains.
 *
 * - analyze_oman_property: `provenance: [{ sourceType, ... }]` (src/domain/oman/types.ts) —
 *   "manual_benchmark" is the demo/manual fallback; anything else (today: "partner_feed") is real.
 * - get_oman_company_profile / analyze_oman_company / due_diligence_oman_company:
 *   `dataCoverage: { realSources, demoSources }` (src/schemas/businessOutputs.ts) — a field
 *   purpose-built for exactly this question.
 * - search_oman_company: no provenance/coverage field in its output at all (strictObject with
 *   only `matches`/`totalMatches` — see businessOutputs.ts). The one honest signal available is
 *   each match's own `companyId`: demo fixtures are seeded with the literal "demo-co-*" ids (see
 *   business-data/sources/fixtures.ts), while every real (Cardify-imported or otherwise
 *   database-backed) company gets a generated UUID. This is a best-effort heuristic, not a
 *   published contract — if DemoCompanyProvider's id scheme ever changes, this must change with
 *   it (flagged in the doc comment rather than silently going stale).
 * - Every other capability (analyze_property, compare_properties, estimate_maintenance): returns
 *   null — these compute purely from caller-supplied numbers, so "data source" isn't a concept
 *   that applies to them.
 */
export function classifyDataSource(toolName: string, data: unknown): DataSource | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;

  if (toolName === "analyze_oman_property") {
    const provenance = record.provenance;
    if (!Array.isArray(provenance) || provenance.length === 0) return "unknown";
    let hasReal = false, hasDemo = false;
    for (const entry of provenance) {
      const sourceType = entry && typeof entry === "object" ? (entry as Record<string, unknown>).sourceType : undefined;
      if (sourceType === "manual_benchmark") hasDemo = true;
      else if (typeof sourceType === "string") hasReal = true;
    }
    return combine(hasReal, hasDemo);
  }

  if (toolName === "get_oman_company_profile" || toolName === "analyze_oman_company" || toolName === "due_diligence_oman_company") {
    const coverage = record.dataCoverage;
    if (!coverage || typeof coverage !== "object") return "unknown";
    const real = Number((coverage as Record<string, unknown>).realSources) || 0;
    const demo = Number((coverage as Record<string, unknown>).demoSources) || 0;
    if (real === 0 && demo === 0) return "unknown";
    return combine(real > 0, demo > 0);
  }

  if (toolName === "search_oman_company") {
    const matches = record.matches;
    if (!Array.isArray(matches) || matches.length === 0) return "unknown";
    let hasReal = false, hasDemo = false;
    for (const match of matches) {
      const companyId = match && typeof match === "object" ? (match as Record<string, unknown>).companyId : undefined;
      if (typeof companyId !== "string") continue;
      if (companyId.startsWith("demo-")) hasDemo = true;
      else hasReal = true;
    }
    return combine(hasReal, hasDemo);
  }

  return null;
}

function combine(hasReal: boolean, hasDemo: boolean): DataSource {
  if (hasReal && hasDemo) return "mixed";
  if (hasReal) return "partner_feed";
  if (hasDemo) return "demo_manual";
  return "unknown";
}
