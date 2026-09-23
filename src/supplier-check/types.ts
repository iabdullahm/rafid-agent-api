/**
 * Shared vocabulary for oman_supplier_check — a paid procurement-screening capability that tells
 * a procurement agent whether an Oman supplier *appears* suitable to receive an RFQ. It is a
 * public-source SCREENING tool, never a legal KYC/AML verification or a vendor approval: every
 * union below deliberately uses soft, evidence-oriented wording ("identityConfirmed",
 * "appears_suitable", "potential_match") rather than certification wording ("verified",
 * "approved", "sanctioned").
 *
 * Kept in one file so the input/output schemas (src/schemas/supplierCheck*.ts), the providers,
 * the scoring model and the tests all agree on the same literal unions — the same "one file, one
 * vocabulary" discipline as src/business-data/types.ts and src/intelligence/types.ts.
 */

export const IDENTITY_MATCH_LEVELS = ["strong", "moderate", "weak", "unconfirmed"] as const;
export type IdentityMatchLevel = (typeof IDENTITY_MATCH_LEVELS)[number];

/** Generic per-check outcome. "unknown" always means "not enough evidence to say", never "bad". */
export const CHECK_STATUSES = ["pass", "partial", "fail", "unknown"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

/** Address check uses "conflict" instead of "fail" — an address disagreement is a consistency
 *  finding, not proof of anything. */
export const ADDRESS_STATUSES = ["pass", "partial", "conflict", "unknown"] as const;
export type AddressStatus = (typeof ADDRESS_STATUSES)[number];

/** Sanctions screening never has a "confirmed/sanctioned" state: automated name matching can at
 *  most produce a *potential* match that a human must verify at the source list. "not_checked"
 *  (no provider configured) and "unavailable" (provider down) are explicit so they are never
 *  confused with "clear". */
export const SANCTIONS_STATUSES = ["clear", "potential_match", "not_checked", "unavailable"] as const;
export type SanctionsStatus = (typeof SANCTIONS_STATUSES)[number];

export const PUBLIC_RISK_STATUSES = ["clear", "signal_detected", "not_checked", "unavailable"] as const;
export type PublicRiskStatus = (typeof PUBLIC_RISK_STATUSES)[number];

export const OVERALL_RISK_LEVELS = ["low", "medium", "high", "insufficient_data"] as const;
export type OverallRiskLevel = (typeof OVERALL_RISK_LEVELS)[number];

export const PROCUREMENT_SUITABILITY = ["appears_suitable", "review_recommended", "insufficient_information", "potential_risk"] as const;
export type ProcurementSuitability = (typeof PROCUREMENT_SUITABILITY)[number];

export const FLAG_SEVERITIES = ["low", "medium", "high"] as const;
export type FlagSeverity = (typeof FLAG_SEVERITIES)[number];

/** Machine-readable risk-flag codes. A flag always describes an observable data fact or an
 *  automated indicator — never an allegation of misconduct. */
export const SUPPLIER_RISK_FLAG_CODES = [
  "ACTIVITY_MISMATCH", "IDENTITY_NOT_CONFIRMED", "CR_NUMBER_CONFLICT", "COMPANY_NAME_MISMATCH",
  "REGISTRY_IDENTITY_CONFLICT", "SUPPLIER_STATUS_NOT_ACTIVE", "EMAIL_DOMAIN_MISMATCH", "FREE_EMAIL_PROVIDER",
  "WEBSITE_IDENTITY_CONFLICT", "WEBSITE_UNREACHABLE", "WEBSITE_NO_HTTPS", "PHONE_MISMATCH", "PHONE_NOT_OMAN",
  "ADDRESS_MISMATCH", "ADDRESS_OUTSIDE_OMAN", "POTENTIAL_SANCTIONS_MATCH", "PUBLIC_RISK_SIGNAL",
  "LOOKALIKE_DOMAIN", "DEMO_DATA_ONLY", "INSUFFICIENT_PUBLIC_DATA", "SOURCE_UNAVAILABLE"
] as const;
export type SupplierRiskFlagCode = (typeof SUPPLIER_RISK_FLAG_CODES)[number];

export interface SupplierRiskFlag {
  code: SupplierRiskFlagCode;
  severity: FlagSeverity;
  message: string;
}

/** Where a piece of evidence came from. Every factual finding in the output is traceable to one
 *  of these (spec: "Every factual finding must be traceable to a source or stored evidence"). */
export const EVIDENCE_SOURCE_TYPES = [
  "company_registry", "company_directory", "demo_dataset", "company_website", "sanctions_list",
  "public_web", "derived_consistency_check"
] as const;
export type EvidenceSourceType = (typeof EVIDENCE_SOURCE_TYPES)[number];

export interface EvidenceSource {
  type: EvidenceSourceType;
  name: string;
  url: string | null;
  /** When this evidence was actually obtained from the source (for cached evidence: when it was
   *  originally fetched, not when it was served from cache). */
  checkedAt: string;
  /** When the SOURCE itself last observed the fact (e.g. a registry row's observedAt), when known. */
  observedAt: string | null;
}

/**
 * The result of asking ONE provider for ONE piece of evidence. Providers never throw for an
 * ordinary outage — they return "unavailable" so the capability degrades to partial evidence
 * instead of failing the paid call (spec: "If an external data source is unavailable, return
 * partial evidence gracefully").
 *  - ok:              evidence obtained (possibly "found nothing" — that's still evidence).
 *  - not_configured:  this deployment has not enabled the provider; no call was attempted.
 *  - unavailable:     the provider was attempted and failed (timeout, 5xx, parse error).
 *  - not_applicable:  the input didn't supply what this provider needs (e.g. no website).
 */
export type ProviderStatus = "ok" | "not_configured" | "unavailable" | "not_applicable";

export interface ProviderResult<T> {
  status: ProviderStatus;
  evidence: T | null;
  sources: EvidenceSource[];
  /** Short, non-sensitive reason for a non-ok status — never a stack trace or credential. */
  reason: string | null;
}

/** Base shape for every supplier data provider (spec: "Create a provider interface such as
 *  SupplierDataProvider"). Concrete provider families below add their own query method; the
 *  capability aggregates evidence across all of them and never depends on any single one. */
export interface SupplierDataProvider {
  /** Stable id — also the evidence-cache namespace, so changing it invalidates its cache. */
  readonly id: string;
  readonly name: string;
  readonly kind: "company_registry" | "website" | "sanctions" | "public_web";
}

// ---------------------------------------------------------------------------------------------
// Normalized request
// ---------------------------------------------------------------------------------------------

export interface NormalizedPhone {
  input: string;
  /** E.164 form when the number parses as an Oman number (+968XXXXXXXX), else null. */
  e164: string | null;
  /** Digits-only national significant number, used for comparison across formats. */
  digits: string;
  isOman: boolean;
  lineType: "mobile" | "landline" | "unknown";
}

export interface NormalizedSupplierInput {
  companyName: string;
  /** Registry matching key (src/business-data/normalizers/companyName.ts — the SAME normalizer
   *  the Oman company registry uses, never a second one). */
  normalizedName: string;
  /** Additional matching keys derived from Arabic/English naming variants (e.g. an Arabic legal
   *  form or descriptor rendered to its English equivalent). Always includes normalizedName. */
  nameVariants: string[];
  /** "ar", "en" or "mixed" — which script the submitted name is written in. */
  nameScript: "ar" | "en" | "mixed";
  legalTypeGuess: string | null;
  crNumber: string | null;
  website: string | null;
  websiteDomain: string | null;
  email: string | null;
  emailDomain: string | null;
  freeEmailProvider: boolean;
  phone: NormalizedPhone | null;
  address: string | null;
  requiredProductOrService: string | null;
}
