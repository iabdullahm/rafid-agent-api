import { searchOmanCompany } from "../../../services/omanBusiness.js";
import type { IntelligenceSource } from "../../types.js";
import type { CheckOutcome } from "./liveChecks.js";

/**
 * Corporate identity check — reuses the EXISTING search_oman_company capability's own service
 * function directly (never a second lookup implementation, never a duplicated matching
 * algorithm). This is real, always-safe, always-deterministic-by-default reuse: with no Oman
 * business database configured, it queries the same curated demo dataset search_oman_company
 * itself falls back to (see business-data/config.ts's "manual" default) — no live network call,
 * so it never breaks the generic capability tests' determinism the way a genuinely new external
 * lookup would.
 *
 * Scope is honestly narrow: this is an OMAN company registry cross-check only. A company outside
 * Oman (or one this deployment's Oman data doesn't cover) correctly reports "no match" rather
 * than a false negative being presented as "not incorporated anywhere".
 */
export async function runCorporateIdentityCheck(companyName: string | null, now: () => Date = () => new Date()): Promise<CheckOutcome> {
  if (!companyName) return { status: "not_applicable", summary: "No company name was provided.", findings: [], evidence: [], sources: [] };
  const observedAt = now().toISOString();
  try {
    const result = (await searchOmanCompany({ query: companyName })) as { matches: Array<{ companyName: string; companyId: string; status: string | null; confidence: number }> };
    const best = result.matches.find(m => m.confidence >= 0.6);
    if (!best) {
      return {
        status: "performed",
        summary: "No confident match was found in Rafid's Oman company registry data.",
        findings: ["This check only covers Oman-registered companies known to Rafid; a company outside Oman, or one not yet covered, will correctly show no match here."],
        evidence: [{ description: "No Oman registry match above the confidence threshold.", source: null, tier: "missing_information" }],
        sources: []
      };
    }
    const source: IntelligenceSource = { url: null, title: `Rafid Oman company registry match: ${best.companyName}`, publisher: "Rafid Oman business-data registry", sourceType: "rafid_oman_registry", observedAt };
    // A "demo-*" companyId means this deployment has no real Oman database configured for this
    // match (see analytics/dataSource.ts's identical heuristic for search_oman_company) — an
    // illustrative fixture, not real registry evidence, so it must never be tiered as confirmed.
    const isDemo = best.companyId.startsWith("demo-");
    return {
      status: "performed",
      summary: `A matching Oman registry record was found (status: ${best.status ?? "unknown"}).${isDemo ? " Note: this deployment has no production Oman business database configured, so this match is from Rafid's illustrative demo dataset, not a real registry record." : ""}`,
      findings: [`Matched "${best.companyName}" in Rafid's Oman company registry data (match confidence ${best.confidence.toFixed(2)}, status: ${best.status ?? "unknown"})${isDemo ? " — demo dataset, not a real registry record" : ""}.`],
      evidence: [{ description: `Oman registry identity match (confidence ${best.confidence.toFixed(2)}).`, source: null, tier: isDemo ? "automated_indicator" : "confirmed_evidence" }],
      sources: [source]
    };
  } catch {
    return { status: "unavailable", summary: "The Oman company registry lookup failed.", findings: [], evidence: [], sources: [] };
  }
}
