import type { PublicRiskEvidence } from "../providers/publicRiskProvider.js";
import type { ProviderResult, PublicRiskStatus, SupplierRiskFlag } from "../types.js";
import { nameAppearsIn } from "./textMatch.js";

/**
 * Public-risk signals. Neutral by design (spec: "Do not infer guilt or misconduct from weak
 * evidence"): every signal is described as "potential public-risk signal detected" with its
 * source, and tiered as either an unverified public mention or an automated consistency
 * indicator — never as a finding.
 *
 * Two families:
 *  1. public_web_mention — a web search result whose title/snippet contains the supplier's
 *     distinctive name tokens AND a risk keyword (fraud, scam, warning, impersonation, ...). A
 *     result that doesn't name the supplier is ignored entirely.
 *  2. Derived indicators from this screening's own consistency checks: a lookalike domain
 *     (common in supplier impersonation), or a CR number registered to a different company
 *     (a cloned/contradictory-identity indicator).
 */

export interface PublicRiskSignal {
  type: "public_web_mention" | "possible_impersonation" | "contradictory_business_identity";
  description: string;
  evidenceTier: "public_allegation" | "automated_indicator";
  sourceUrl: string | null;
  sourceTitle: string | null;
}

export const RISK_KEYWORDS = [
  "fraud", "fraudulent", "scam", "fake", "impersonat", "phishing", "warning", "blacklist", "black list", "counterfeit",
  "fined", "penalty", "suspended", "unlicensed", "not licensed", "money laundering", "sanction",
  "احتيال", "نصب", "تحذير", "مزيف", "وهمية", "غرامة", "القائمة السوداء"
];

export interface PublicRiskAssessment {
  status: PublicRiskStatus;
  signals: PublicRiskSignal[];
  explanation: string;
  flags: SupplierRiskFlag[];
}

export function assessPublicRisk(
  names: readonly (string | null | undefined)[],
  result: ProviderResult<PublicRiskEvidence> | null,
  derived: { lookalikeDomain: string | null; crBelongsToOtherCompany: boolean }
): PublicRiskAssessment {
  const signals: PublicRiskSignal[] = [];
  for (const r of result?.status === "ok" ? result.evidence?.results ?? [] : []) {
    const text = `${r.title} ${r.snippet}`;
    const lower = text.toLowerCase();
    const keyword = RISK_KEYWORDS.find(k => lower.includes(k));
    if (!keyword || !nameAppearsIn(text, names)) continue;
    signals.push({
      type: "public_web_mention",
      description: `Potential public-risk signal detected: a public web result mentions the supplier's name together with the term "${keyword}". This is an unverified public-source mention, not a finding of misconduct — review the source.`,
      evidenceTier: "public_allegation", sourceUrl: r.url, sourceTitle: r.title
    });
    if (signals.length >= 5) break;
  }
  if (derived.lookalikeDomain) {
    signals.push({
      type: "possible_impersonation",
      description: `Potential public-risk signal detected: the domain "${derived.lookalikeDomain}" closely resembles, but differs from, the supplier's known domain — a pattern sometimes seen in supplier impersonation. Confirm contact details through an independently sourced channel.`,
      evidenceTier: "automated_indicator", sourceUrl: null, sourceTitle: null
    });
  }
  if (derived.crBelongsToOtherCompany) {
    signals.push({
      type: "contradictory_business_identity",
      description: "Potential public-risk signal detected: the supplied CR number is recorded for a different company in registry data (contradictory business identity). Request the commercial registration certificate.",
      evidenceTier: "automated_indicator", sourceUrl: null, sourceTitle: null
    });
  }

  const flags: SupplierRiskFlag[] = signals
    .filter(s => s.type === "public_web_mention")
    .slice(0, 1)
    .map(() => ({ code: "PUBLIC_RISK_SIGNAL" as const, severity: "medium" as const, message: "Potential public-risk signal detected in public web sources (unverified; see checks.publicRisk.signals)." }));

  let status: PublicRiskStatus;
  if (signals.length > 0) status = "signal_detected";
  else if (result?.status === "ok") status = "clear";
  else if (result?.status === "unavailable") status = "unavailable";
  else status = "not_checked";

  const explanation =
    status === "signal_detected" ? `${signals.length} potential public-risk signal(s) detected; each is an unverified indicator for human review.`
    : status === "clear" ? "No public-risk signal naming this supplier was found in the sources checked. Absence of results is not a clearance."
    : status === "unavailable" ? "The public-web source could not be reached; public-risk signals were not checked."
    : "Public-web risk screening is not enabled for this deployment; only internal consistency indicators were evaluated.";
  return { status, signals, explanation, flags };
}
