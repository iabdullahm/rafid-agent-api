/** Shared vocabulary for the Oman business-intelligence domain (search/profile/analyze/due
 *  diligence on companies operating in Oman). Kept in one file so the schemas
 *  (src/schemas/businessInputs.ts, src/schemas/businessOutputs.ts), the matching/scoring engines
 *  and the repository layer all agree on the same literal unions — no module redefines
 *  "government" | "company_website" | ... a second time. Mirrors the equivalent file for the
 *  Oman property domain (src/domain/oman/types.ts).
 */

/** How a company record (or one of its sourced facts) was obtained. "demo" is a distinct,
 *  explicit value (never conflated with "other") so demo/seed data can never be silently
 *  presented as a real source — see src/business-data/sources/fixtures.ts.
 *
 *  "tax_authority", "government_procurement" and "licensed_feed" were added for Phase 4-6's three
 *  production source adapters (Oman Business/MOCIIP uses "government"; Tax Oman uses
 *  "tax_authority"; Tender Board/Esnad uses "government_procurement") — purely additive, so every
 *  existing sourceType value, every existing fixture/test/schema CHECK constraint referencing
 *  them, keeps working unchanged. See src/business-data/scoring/sourceTrust.ts for the trust level
 *  assigned to each value — the one place trust is defined. */
export const COMPANY_SOURCE_TYPES = [
  "government", "public_registry", "tax_authority", "government_procurement",
  "company_website", "licensed_feed", "directory", "news", "demo", "other",
  // Admin & Data Operations Dashboard (Section 20): a company or fact an authorized operator
  // typed directly into the admin UI rather than importing from any of the sources above. The
  // lowest-trust source type in this system (see sourceTrust.ts) — never treated as government
  // verification. See docs/business-admin.md's "Manual company creation" section.
  "admin_manual"
] as const;
export type CompanySourceType = (typeof COMPANY_SOURCE_TYPES)[number];

/** Sources this MVP treats as an authoritative identity check (registration/status can be relied
 *  on more heavily) versus merely reported. Used by the confidence and verification logic —
 *  never by search ranking, which treats every candidate's textual fields uniformly. Mirrors
 *  src/business-data/scoring/sourceTrust.ts's HIGH_TRUST_SOURCE_TYPES (authority >= 0.90); new
 *  code should prefer that one since it is derived from the trust table rather than hand-listed,
 *  but this list stays in sync for the code written before sourceTrust.ts existed. */
export const AUTHORITATIVE_SOURCE_TYPES: readonly CompanySourceType[] = ["government", "public_registry", "tax_authority", "government_procurement"];

/** Phase 3: a row's (or a merged company's) verification status — distinct from, but related to,
 *  the numeric confidence score. "stale" and "conflicting" are states a row can enter after being
 *  ingested (its own facts didn't change, but time passed or another source disagreed), so this is
 *  computed at read time from sourceType + freshness + cross-source agreement
 *  (src/business-data/scoring/verification.ts), never stored as a frozen judgment that could
 *  silently go stale itself. */
export const VERIFICATION_STATUSES = ["verified", "reported", "estimated", "inferred", "stale", "conflicting", "unknown"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

export const COMPANY_STATUSES = ["active", "inactive", "suspended", "unknown"] as const;
export type CompanyStatus = (typeof COMPANY_STATUSES)[number];

export const ANALYSIS_PURPOSES = ["general", "supplier", "customer", "partner", "investor"] as const;
export type AnalysisPurpose = (typeof ANALYSIS_PURPOSES)[number];

export const DUE_DILIGENCE_TRANSACTION_TYPES = ["supplier_contract", "partnership", "investment", "customer_credit", "other"] as const;
export type DueDiligenceTransactionType = (typeof DUE_DILIGENCE_TRANSACTION_TYPES)[number];

/** Section 6: how a fact was established, distinct from the numeric confidence score. Applied at
 *  the source-type level (see confidence.ts's labelForSourceType) rather than invented per field —
 *  deterministic and traceable to the sourceType that backed the fact. */
export const CONFIDENCE_LABELS = ["verified", "reported", "estimated", "inferred", "unknown"] as const;
export type ConfidenceLabel = (typeof CONFIDENCE_LABELS)[number];

export const RISK_SEVERITIES = ["low", "medium", "high"] as const;
export type RiskSeverity = (typeof RISK_SEVERITIES)[number];

export const IMPORTANCE_LEVELS = ["low", "medium", "high"] as const;
export type ImportanceLevel = (typeof IMPORTANCE_LEVELS)[number];

/** One structured risk finding — shared verbatim between analyze_oman_company's top-level
 *  `riskFlags` and due_diligence_oman_company's `riskAssessment.riskFlags`, since both are
 *  produced by the exact same deterministic risk engine (src/business-data/scoring/risk.ts). */
export interface CompanyRiskFlag {
  code: string;
  severity: RiskSeverity;
  message: string;
}

/** Section 5: the source-provenance object every important fact must be traceable to. Matches
 *  the task's literal "Source object format" (camelCase, ISO observedAt, a `fields` list naming
 *  which output fields that source backed). `sourceAuthority` and `verificationStatus` are Phase
 *  2/3 additions — every source record must expose sourceType/sourceName/sourceAuthority, and be
 *  explainable as verified/reported/estimated/inferred/stale/conflicting/unknown. */
export interface CompanyProvenanceEntry {
  sourceName: string;
  sourceType: CompanySourceType;
  sourceAuthority: number;
  sourceUrl: string | null;
  sourceRecordId: string | null;
  observedAt: string;
  verificationStatus: VerificationStatus;
  fields: readonly string[];
}

/** Phase 8: field-level evidence — for one important field, its winning value plus exactly which
 *  source backed it and how trustworthy/fresh that source is. A richer, per-field view than
 *  CompanyProvenanceEntry (which groups by contributing row); computed at read time from the same
 *  row data, never a separately-persisted table that could drift out of sync with it. */
export interface CompanyFieldEvidence {
  field: string;
  value: unknown;
  sourceName: string;
  sourceType: CompanySourceType;
  sourceAuthority: number;
  observedAt: string;
  verificationStatus: VerificationStatus;
}

/** Phase 6: one government-procurement award/contract fact for a company — list-shaped (a company
 *  can have zero or many), so it is its own record rather than a flat field on the company row.
 *  Never fabricated: only populated from an actual Tender Board/Esnad-sourced award record. */
export interface CompanyAwardRecord {
  id: string;
  companyId: string;
  tenderNumber: string;
  buyer: string | null;
  title: string | null;
  status: string | null;
  awardValueOMR: number | null;
  category: string | null;
  sourceName: string;
  observedAt: string;
}

/** Phase 15: how much of a company's response is backed by real vs. demo evidence — lets a caller
 *  tell at a glance whether a result reflects real Oman company data or only the illustrative
 *  demo dataset, without having to inspect every provenance entry's sourceType itself. */
export interface DataCoverage {
  realSources: number;
  demoSources: number;
  latestVerifiedAt: string | null;
}

/** Section 14: the normalized internal record shape a source adapter produces, exactly as given
 *  in the task ("interface OmanCompanySourceRecord"). Every ingestion path (fixtures, CSV/JSON
 *  import, a future licensed feed) converges on this shape before it reaches the repository —
 *  see src/business-data/ingestion/importPipeline.ts. */
export interface OmanCompanySourceRecord {
  companyName: string;
  registrationNumber?: string;
  legalType?: string;
  status?: string;
  industry?: string;
  governorate?: string;
  wilayat?: string;
  area?: string;
  address?: string;
  website?: string;
  email?: string;
  phone?: string;
  vatNumber?: string;
  vatStatus?: string;
  employeeRange?: string;
  activities?: readonly string[];
  sourceName: string;
  sourceType: CompanySourceType;
  sourceRecordId?: string;
  sourceUrl?: string;
  observedAt: Date;
  metadata?: Record<string, unknown>;
}

/** Days since an ISO date/timestamp, floored at 0 — same convention as
 *  src/domain/oman/types.ts's daysSince, reused here rather than redefined so "how old is this
 *  fact" is computed identically across both domains. */
export function daysSince(iso: string): number {
  return Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 86_400_000));
}

/** Whole years between an ISO date and now, floored at 0 — used for registrationAgeYears /
 *  yearsActive. Calendar-aware (not a flat /365 division) so a company registered 11 months ago
 *  correctly reports 0 years, not 1. */
export function yearsSince(iso: string): number {
  const start = new Date(iso);
  const now = new Date();
  let years = now.getUTCFullYear() - start.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - start.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < start.getUTCDate())) years--;
  return Math.max(0, years);
}

/**
 * Admin & Data Operations Dashboard (Sections 14/15/19): a conservative, manual disposition an
 * operator can attach to one source ROW (never silently inferred) — how the Conflict Review Queue,
 * Stale Records Queue and Verification Work Queue remember that a human already looked at
 * something, without ever deleting or mutating the underlying evidence it was computed from.
 *  - "reviewed": operator looked at it; nothing further needed. Drops it out of its queue.
 *  - "kept_separate": operator confirmed two similarly-named/addressed rows are genuinely
 *    different companies (used after splitting them via CompanyRepository.relinkRow).
 *  - "confirmed_same": operator confirmed an identity/address disagreement is a real fact about
 *    one company (e.g. it legitimately trades under two names), not a matching error.
 *  - "rejected": operator flagged this specific source ROW as incorrect — excluded from
 *    mergeCompanyRows onward (src/business-data/admin/adminService.ts), but never deleted.
 *  - "needs_verification": explicitly still open; keeps it in its queue with that label.
 */
export const ADMIN_ROW_FLAGS = ["reviewed", "kept_separate", "confirmed_same", "rejected", "needs_verification"] as const;
export type AdminRowFlag = (typeof ADMIN_ROW_FLAGS)[number];

/** Section 19: why an imported row could not be safely resolved to a company at all (so it was
 *  never written to oman_companies) — shown verbatim in the Unmatched Records queue. */
export const UNMATCHED_REASONS = [
  "missing_registration_number", "ambiguous_name_match", "multiple_exact_candidates",
  "insufficient_award_identity_data", "validation_error"
] as const;
export type UnmatchedReason = (typeof UNMATCHED_REASONS)[number];

export const UNMATCHED_STATUSES = ["unresolved", "linked", "created", "rejected"] as const;
export type UnmatchedStatus = (typeof UNMATCHED_STATUSES)[number];

/** One import row that could not be safely auto-linked to a company, persisted (Section 19) so an
 *  operator can revisit it later from /admin/business/unmatched — never silently discarded after
 *  the import response is shown once. `rawPayload` is the row exactly as submitted (already
 *  sanitized/length-capped by the adapter that rejected it), so an operator can inspect and, if
 *  they choose, correct and resubmit it themselves. */
export interface UnmatchedRecordInput {
  sourceType: CompanySourceType;
  sourceName: string;
  rawPayload: Record<string, unknown>;
  reason: UnmatchedReason;
  reasonDetail: string;
}
export interface UnmatchedRecord extends UnmatchedRecordInput {
  id: string;
  status: UnmatchedStatus;
  linkedCompanyId: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  note: string | null;
}

/** One entry in the admin operation audit trail (Section 29) — every admin mutation writes one of
 *  these. Never carries a password, cookie, access token or full uploaded-file body — only a
 *  small, structured `metadata` summary (row counts, ids, labels). */
export interface AuditLogEntryInput {
  adminUser: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  metadata: Record<string, unknown>;
}
export interface AuditLogEntry extends AuditLogEntryInput {
  id: string;
  occurredAt: string;
}
