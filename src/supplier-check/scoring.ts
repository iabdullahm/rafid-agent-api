import type { AddressStatus, CheckStatus, IdentityMatchLevel, OverallRiskLevel, ProcurementSuitability, PublicRiskStatus, SanctionsStatus, SupplierRiskFlag } from "./types.js";

/**
 * Transparent weighted risk model for oman_supplier_check.
 *
 * Two INDEPENDENT numbers are computed, deliberately kept apart:
 *
 *  • riskScore (0-100): how much ADVERSE evidence was found. Only positive evidence of a problem
 *    adds points; missing information adds none (spec: "Missing information should generally
 *    reduce confidence rather than automatically increase risk"; "A missing website alone should
 *    not produce high").
 *
 *  • confidence (0-1): how much of the screening could actually be evidenced — a weighted
 *    evidence-coverage ratio. Missing data lowers this, not the risk score.
 *
 * Every point contribution is returned as a `component` in the output (riskModel.components), so
 * an agent can see exactly why a supplier landed where it did.
 *
 * RISK POINTS (additive, capped at 100):
 *   Potential sanctions match — exact normalized name ........................... +60
 *   Potential sanctions match — fuzzy (score >= 0.88) ............................ +35
 *   CR number registered to a different company ................................. +35
 *   Matched company's registry CR differs from the supplied CR ................... +25
 *   Registry status inactive/suspended ........................................... +25
 *   Lookalike domain (possible impersonation) .................................... +25
 *   Public-web risk mention naming the supplier (per signal, max 2) .............. +20
 *   Activity mismatch (fail) ..................................................... +15
 *   Website identity conflict .................................................... +15
 *   Email domain mismatch ........................................................ +10
 *   Address conflict (different governorate) ..................................... +10
 *   Registry sources disagree on the company name ................................ +5
 *   Weak identity evidence (matched, but only weakly) ............................ +5
 *   Activity only partially evidenced ............................................ +5
 *   Phone mismatch ............................................................... +5
 *   Address outside Oman ......................................................... +5
 *   Website unreachable / non-HTTPS redirect ..................................... +3
 *   Phone not an Oman number ..................................................... +3
 *   Free email provider .......................................................... +2
 *   Unconfirmed identity, missing website/address/CR, sources not configured ..... 0 (confidence only)
 *
 * RISK LEVEL:  score >= 45 → high · score >= 20 → medium · otherwise low — UNLESS evidence
 *   coverage is too thin to support a "low"/"medium" call (confidence < 0.35 with identity not at
 *   least weakly matched, or confidence < 0.25), in which case → insufficient_data. Strong adverse
 *   evidence (score >= 45) is always reported as high even when coverage is thin: a potential
 *   sanctions match must never be hidden behind "insufficient data".
 *
 * CONFIDENCE (evidence coverage) weights — a check that doesn't apply (e.g. activity when no
 * requiredProductOrService was asked for) is removed from the denominator, never penalized:
 *   identity 0.35 × identity score · website 0.15 · activity 0.15 · contact 0.10 · address 0.10 ·
 *   sanctions 0.10 · public risk 0.05.
 */

export const RISK_THRESHOLDS = { high: 45, medium: 20 } as const;
export const INSUFFICIENT_CONFIDENCE = { withoutIdentity: 0.35, absolute: 0.25 } as const;

export const RISK_POINTS: Record<string, number> = {
  POTENTIAL_SANCTIONS_MATCH_EXACT: 60,
  POTENTIAL_SANCTIONS_MATCH_FUZZY: 35,
  CR_BELONGS_TO_OTHER_COMPANY: 35,
  CR_DIFFERS_FROM_REGISTRY: 25,
  SUPPLIER_STATUS_NOT_ACTIVE: 25,
  LOOKALIKE_DOMAIN: 25,
  PUBLIC_RISK_SIGNAL_EACH: 20,
  ACTIVITY_MISMATCH: 15,
  WEBSITE_IDENTITY_CONFLICT: 15,
  EMAIL_DOMAIN_MISMATCH: 10,
  ADDRESS_MISMATCH: 10,
  REGISTRY_IDENTITY_CONFLICT: 5,
  WEAK_IDENTITY: 5,
  ACTIVITY_PARTIAL: 5,
  PHONE_MISMATCH: 5,
  ADDRESS_OUTSIDE_OMAN: 5,
  WEBSITE_UNREACHABLE: 3,
  WEBSITE_NO_HTTPS: 3,
  PHONE_NOT_OMAN: 3,
  FREE_EMAIL_PROVIDER: 2
};

export interface RiskComponent { factor: string; points: number; reason: string; }

export interface RiskInputs {
  identityLevel: IdentityMatchLevel;
  identityScore: number;
  identityMatched: boolean;
  crConflict: "cr_belongs_to_other_company" | "registry_cr_differs" | null;
  activityStatus: CheckStatus;
  activityRequested: boolean;
  websiteStatus: CheckStatus;
  websiteEvidenced: boolean;
  contactStatus: CheckStatus;
  addressStatus: AddressStatus;
  sanctionsStatus: SanctionsStatus;
  sanctionsMatchTypes: ("exact_normalized_name" | "fuzzy_name")[];
  publicRiskStatus: PublicRiskStatus;
  publicWebMentions: number;
  flags: readonly SupplierRiskFlag[];
}

export function riskComponents(i: RiskInputs): RiskComponent[] {
  const c: RiskComponent[] = [];
  const has = (code: SupplierRiskFlag["code"]) => i.flags.some(f => f.code === code);
  if (i.sanctionsMatchTypes.includes("exact_normalized_name")) c.push({ factor: "sanctions", points: RISK_POINTS.POTENTIAL_SANCTIONS_MATCH_EXACT!, reason: "Potential sanctions match on an identical normalized name (unconfirmed)." });
  else if (i.sanctionsMatchTypes.length > 0) c.push({ factor: "sanctions", points: RISK_POINTS.POTENTIAL_SANCTIONS_MATCH_FUZZY!, reason: "Potential fuzzy sanctions name match (unconfirmed)." });
  if (i.crConflict === "cr_belongs_to_other_company") c.push({ factor: "companyIdentity", points: RISK_POINTS.CR_BELONGS_TO_OTHER_COMPANY!, reason: "Supplied CR number is registered to a different company." });
  else if (i.crConflict === "registry_cr_differs") c.push({ factor: "companyIdentity", points: RISK_POINTS.CR_DIFFERS_FROM_REGISTRY!, reason: "Matched company's registry CR differs from the supplied CR." });
  if (has("SUPPLIER_STATUS_NOT_ACTIVE")) c.push({ factor: "companyIdentity", points: RISK_POINTS.SUPPLIER_STATUS_NOT_ACTIVE!, reason: "Registry status is not active." });
  if (has("REGISTRY_IDENTITY_CONFLICT")) c.push({ factor: "companyIdentity", points: RISK_POINTS.REGISTRY_IDENTITY_CONFLICT!, reason: "Registry sources disagree on the company name." });
  if (i.identityMatched && i.identityLevel === "weak" && !i.crConflict) c.push({ factor: "companyIdentity", points: RISK_POINTS.WEAK_IDENTITY!, reason: "Identity matched only weakly." });
  if (has("LOOKALIKE_DOMAIN")) c.push({ factor: "publicRisk", points: RISK_POINTS.LOOKALIKE_DOMAIN!, reason: "Lookalike domain indicator." });
  const mentions = Math.min(2, i.publicWebMentions);
  if (mentions > 0) c.push({ factor: "publicRisk", points: RISK_POINTS.PUBLIC_RISK_SIGNAL_EACH! * mentions, reason: `${mentions} public-web risk mention(s) naming the supplier (unverified).` });
  if (i.activityStatus === "fail") c.push({ factor: "businessActivity", points: RISK_POINTS.ACTIVITY_MISMATCH!, reason: "Business activity does not match the requested product/service." });
  else if (i.activityStatus === "partial") c.push({ factor: "businessActivity", points: RISK_POINTS.ACTIVITY_PARTIAL!, reason: "Business activity only partially evidenced." });
  if (has("WEBSITE_IDENTITY_CONFLICT")) c.push({ factor: "website", points: RISK_POINTS.WEBSITE_IDENTITY_CONFLICT!, reason: "Website does not correspond to the company identity." });
  if (has("WEBSITE_UNREACHABLE")) c.push({ factor: "website", points: RISK_POINTS.WEBSITE_UNREACHABLE!, reason: "Website unreachable or rejected." });
  if (has("WEBSITE_NO_HTTPS")) c.push({ factor: "website", points: RISK_POINTS.WEBSITE_NO_HTTPS!, reason: "Website redirected to non-HTTPS." });
  if (has("EMAIL_DOMAIN_MISMATCH")) c.push({ factor: "contactConsistency", points: RISK_POINTS.EMAIL_DOMAIN_MISMATCH!, reason: "Email domain does not match known domains." });
  if (has("PHONE_MISMATCH")) c.push({ factor: "contactConsistency", points: RISK_POINTS.PHONE_MISMATCH!, reason: "Phone not found in registry/website." });
  if (has("PHONE_NOT_OMAN")) c.push({ factor: "contactConsistency", points: RISK_POINTS.PHONE_NOT_OMAN!, reason: "Phone is not an Oman number." });
  if (has("FREE_EMAIL_PROVIDER")) c.push({ factor: "contactConsistency", points: RISK_POINTS.FREE_EMAIL_PROVIDER!, reason: "Free email provider (cannot corroborate a corporate domain)." });
  if (has("ADDRESS_MISMATCH")) c.push({ factor: "addressConsistency", points: RISK_POINTS.ADDRESS_MISMATCH!, reason: "Address points to a different governorate than registry data." });
  if (has("ADDRESS_OUTSIDE_OMAN")) c.push({ factor: "addressConsistency", points: RISK_POINTS.ADDRESS_OUTSIDE_OMAN!, reason: "Address appears to be outside Oman." });
  return c;
}

export function computeConfidence(i: RiskInputs): number {
  const parts: [number, number][] = []; // [weight, achieved 0-1]
  parts.push([0.35, i.identityScore]);
  parts.push([0.15, i.websiteEvidenced ? 1 : 0]);
  if (i.activityRequested) parts.push([0.15, i.activityStatus === "unknown" ? 0 : 1]);
  parts.push([0.10, i.contactStatus === "unknown" ? 0 : 1]);
  parts.push([0.10, i.addressStatus === "unknown" ? 0 : 1]);
  parts.push([0.10, i.sanctionsStatus === "clear" || i.sanctionsStatus === "potential_match" ? 1 : 0]);
  parts.push([0.05, i.publicRiskStatus === "clear" || i.publicRiskStatus === "signal_detected" ? 1 : 0]);
  const total = parts.reduce((s, [w]) => s + w, 0);
  const achieved = parts.reduce((s, [w, a]) => s + w * a, 0);
  return Math.round((achieved / total) * 100) / 100;
}

export function classifyRisk(score: number, confidence: number, identityLevel: IdentityMatchLevel): OverallRiskLevel {
  if (score >= RISK_THRESHOLDS.high) return "high";
  const thin = confidence < INSUFFICIENT_CONFIDENCE.absolute || (identityLevel === "unconfirmed" && confidence < INSUFFICIENT_CONFIDENCE.withoutIdentity);
  if (thin) return "insufficient_data";
  if (score >= RISK_THRESHOLDS.medium) return "medium";
  return "low";
}

export function procurementSuitability(risk: OverallRiskLevel, identityConfirmed: boolean, activityStatus: CheckStatus): ProcurementSuitability {
  if (risk === "high") return "potential_risk";
  if (risk === "insufficient_data") return "insufficient_information";
  if (risk === "medium") return "review_recommended";
  return identityConfirmed && activityStatus !== "fail" ? "appears_suitable" : "review_recommended";
}

export function scoreSupplier(i: RiskInputs) {
  const components = riskComponents(i);
  const score = Math.min(100, components.reduce((s, c) => s + c.points, 0));
  const confidence = computeConfidence(i);
  const risk = classifyRisk(score, confidence, i.identityLevel);
  return { score, confidence, risk, components };
}
