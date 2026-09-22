import { COMPANY_STATUSES, type CompanyStatus } from "../types.js";
import { normalizeCompanyName } from "../normalizers/companyName.js";
import { resolveGovernorateName, normalizeWilayatText } from "../normalizers/location.js";
import type { CompanyAwardInput, CompanyRecordInput, CompanyRepository, UpsertResult } from "./companyRepository.js";
import { sanitizeText, emptyToNull, parseObservedAt, parseOptionalPastDate, type RowError } from "./adapterUtils.js";
import type { ParsedXlsxWorkbook, XlsxRow } from "./xlsxReader.js";

/**
 * The Cardify Oman Business Index workbook adapter — a CANDIDATE/DISCOVERY dataset import, not a
 * government-verified one (see this file's extensive doc comments below and docs/business-admin.md's
 * "Cardify Oman Business Index import" section). Reuses the exact same repository write path every
 * other adapter uses (CompanyRepository.upsertCompanies/upsertAwards) — this is NOT a second
 * ingestion engine, just a new *shape* of raw input, matching this project's stated preferred design:
 *
 *   XLSX reader (xlsxReader.ts) -> this file's row shapes -> validation -> normalization
 *   -> identity resolution (companyRepository.ts's existing resolveCompanyId) -> repository writes
 *
 * No business rule lives in xlsxReader.ts; everything here about what a Cardify row MEANS lives in
 * this file, exactly like every other src/business-data/sources/*Provider.ts adapter.
 *
 * ============================================================================================
 * WHY THIS ADAPTER IS DELIBERATELY CONSERVATIVE (read before changing any default below)
 * ============================================================================================
 * The workbook is a directory/aggregator research pass (Cardify), not an authoritative registry,
 * tax authority or procurement system query. Every row this adapter produces is therefore:
 *   - sourceType "directory" (public_directory trust class, authority 0.50 — see sourceTrust.ts).
 *     NEVER "government"/"public_registry" (0-1.00), "tax_authority" (1.00) or
 *     "government_procurement" (0.95), even when the workbook mentions MoCIIP as Cardify's own
 *     stated upstream — Cardify's own re-publication of that data is still one hop removed from
 *     the primary source and carries directory-level trust, not registry-level trust.
 *   - verificationStatus explicitly forced to "reported" (matching both the task's explicit
 *     instruction and the workbook's own Sources sheet, which already states "reported" per row) —
 *     never "verified", regardless of what rowVerificationStatus() would otherwise derive from a
 *     0.50-authority source (it would derive "estimated", since 0.50 < the 0.60 "reported"
 *     threshold — see scoring/verification.ts). An explicit override here is deliberate, not a bug.
 *   - never given a registrationNumber, a company status, a registration date, or any tax/
 *     procurement fact THIS SPECIFIC WORKBOOK doesn't actually contain — a blank Excel cell always
 *     becomes `null`, never invented, inferred, or defaulted to something that looks more complete
 *     than the evidence actually is.
 * ============================================================================================
 */

export const DEFAULT_CARDIFY_SOURCE_NAME = "Cardify Oman Business Index";

// ---- Raw row shapes, exactly matching the workbook's own header row for each sheet -------------

export interface CardifyCompanyRow {
  company_id: unknown;
  company_name: unknown;
  company_name_ar?: unknown;
  company_name_en?: unknown;
  /** Deliberately NEVER trusted — see normalizeCardifyCompanyRow(); recomputed from company_name
   *  via normalizeCompanyName() instead. Present in the type only so an unexpected shape doesn't
   *  silently pass validation. */
  normalized_name?: unknown;
  cr_number?: unknown;
  legal_type?: unknown;
  company_status?: unknown;
  registration_date?: unknown;
  industry?: unknown;
  activities?: unknown;
  governorate?: unknown;
  wilayat?: unknown;
  area?: unknown;
  address?: unknown;
  website?: unknown;
  business_email?: unknown;
  business_phone?: unknown;
  vat_number?: unknown;
  last_verified_at?: unknown;
}

export interface CardifySourceRow {
  company_id: unknown;
  source_name?: unknown;
  source_url?: unknown;
  /** The workbook's OWN source_record_id — a page reference (e.g. "page-8") shared by dozens of
   *  companies. Never used as this adapter's actual sourceRecordId (see generateCardifySourceRecordId
   *  and this file's top doc comment / Section 1 of the import task) — preserved only as
   *  metadata.cardifyOriginalSourceRecordId for traceability. */
  source_record_id?: unknown;
  observed_at?: unknown;
  field_or_category?: unknown;
  notes?: unknown;
}

export type CardifyTaxOutcome = "verified" | "not_registered" | "pending" | "could_not_verify" | "unknown";
const TAX_OUTCOMES_WITH_REAL_EVIDENCE: ReadonlySet<CardifyTaxOutcome> = new Set(["verified", "not_registered", "pending"]);

export interface CardifyTaxVerificationRow {
  company_id: unknown;
  cr_number?: unknown;
  vat_number?: unknown;
  tax_verification_status?: unknown;
  verified_at?: unknown;
  source_name?: unknown;
  source_url?: unknown;
}

export interface CardifyProcurementRow {
  company_id: unknown;
  registered_supplier?: unknown;
  supplier_category?: unknown;
  supplier_classification?: unknown;
  tenders_participated?: unknown;
  last_tender_activity?: unknown;
  observed_at?: unknown;
}

export interface CardifyAwardRow {
  company_id: unknown;
  tender_number: unknown;
  buyer?: unknown;
  title?: unknown;
  category?: unknown;
  award_value_omr?: unknown;
  award_date?: unknown;
  observed_at?: unknown;
}

const STATUS_ALIASES: Record<string, CompanyStatus> = {
  active: "active", operating: "active", operational: "active",
  inactive: "inactive", closed: "inactive", dissolved: "inactive", cancelled: "inactive", canceled: "inactive",
  suspended: "suspended", "on hold": "suspended",
  unknown: "unknown"
};

function str(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  return String(v);
}

/**
 * Section 1: the deterministic, stable, idempotency-safe per-company source identifier.
 *
 * The task's preferred rule is `cardify:<stable-company-key>`, "preferably derived from a
 * legitimate stable company-specific source identifier if one exists in the workbook" — and one
 * does: the Companies/Sources sheets' own `company_id` column (e.g. "OMBI-0001"), unique across
 * all 207 rows (verified during this import — see importCardifyWorkbook's duplicate-detection
 * pass) and shared as the join key between every sheet in the workbook. This is a cleaner,
 * more transparent key than a content hash (a hash of name+governorate+page would silently change
 * if Cardify ever corrects a governorate typo, breaking idempotency on re-import of a *corrected*
 * version of the same company) — so the hash-based fallback the task describes as acceptable is
 * used only when a row has no usable company_id at all (defensive; not expected in practice, since
 * a missing company_id already fails validation and the row is never imported — see
 * normalizeCardifyCompanyRow). The page-number reference the workbook itself used as
 * source_record_id ("page-8") is NEVER used as the identifier — see this file's top doc comment —
 * and is instead preserved verbatim in metadata.cardifyOriginalSourceRecordId.
 */
export function generateCardifySourceRecordId(companyId: string): string {
  return `cardify:${companyId.trim().toLowerCase()}`;
}

function generateCardifyTaxSourceRecordId(companyId: string): string {
  return `cardify-tax:${companyId.trim().toLowerCase()}`;
}

export interface NormalizeCardifyCompanyResult {
  record: CompanyRecordInput;
  companyId: string;
}

/**
 * Merges one Companies-sheet row with its matching Sources-sheet row (joined by company_id) into a
 * single CompanyRecordInput — see this file's top doc comment for why every trust/verification
 * default here is forced conservative rather than derived. `sheetRowNumber` is the workbook's own
 * row number (2-based — row 1 is the header) so a reported error points an operator at the exact
 * Excel row, not an internal array index.
 */
export function normalizeCardifyCompanyRow(
  companyRow: CardifyCompanyRow,
  sourceRow: CardifySourceRow | null,
  sheetRowNumber: number,
  sourceName = DEFAULT_CARDIFY_SOURCE_NAME
): { result: NormalizeCardifyCompanyResult } | { error: RowError } {
  try {
    const companyId = sanitizeText(str(companyRow.company_id) ?? "", 40);
    if (!companyId) throw new Error("company_id is required");

    const companyNameRaw = sanitizeText(str(companyRow.company_name) ?? "", 200);
    if (!companyNameRaw) throw new Error("company_name is required");
    // Section 2: normalized_name is NEVER trusted from the workbook — recomputed here with the
    // same production normalizer every other ingestion path uses, so this record's matching key
    // can never silently diverge from MOCIIP/manual/admin-entered companies sharing the same name.
    const { normalized: normalizedName, legalTypeGuess } = normalizeCompanyName(companyNameRaw);

    let status: CompanyStatus | null = null;
    const statusRaw = emptyToNull(str(companyRow.company_status));
    if (statusRaw) {
      // Section 7: present-but-unrecognized is a validation error (never guessed at); ABSENT is
      // left null — never defaulted to "active" just because the company appears in a directory.
      const resolved = STATUS_ALIASES[statusRaw.trim().toLowerCase()];
      if (!resolved) throw new Error(`company_status "${statusRaw}" must be one of ${COMPANY_STATUSES.join(", ")} (or a recognized alias)`);
      status = resolved;
    }

    let governorate: string | null = null;
    const governorateRaw = emptyToNull(str(companyRow.governorate));
    if (governorateRaw) {
      const resolved = resolveGovernorateName(governorateRaw);
      if (!resolved) throw new Error(`governorate "${governorateRaw}" is not a recognized Oman governorate — not imported rather than guessed at`);
      governorate = resolved;
    }
    const wilayatRaw = emptyToNull(str(companyRow.wilayat));

    // Section 6: cr_number is NEVER invented or inferred — null in, null out.
    const registrationNumber = emptyToNull(str(companyRow.cr_number));
    const registrationDate = parseOptionalPastDate(emptyToNull(str(companyRow.registration_date)), "registration_date");

    const websiteRaw = emptyToNull(str(companyRow.website));
    if (websiteRaw) { try { new URL(websiteRaw); } catch { throw new Error(`website "${websiteRaw}" is not a valid URL`); } }
    const emailRaw = emptyToNull(str(companyRow.business_email));
    if (emailRaw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) throw new Error(`business_email "${emailRaw}" is not a valid email address`);

    let activities: string[] = [];
    const activitiesRaw = companyRow.activities;
    if (activitiesRaw !== undefined && activitiesRaw !== null && activitiesRaw !== "") {
      const list = Array.isArray(activitiesRaw) ? activitiesRaw : String(activitiesRaw).split(",");
      activities = list.map(a => sanitizeText(String(a), 120)).filter(Boolean).slice(0, 20);
    }

    // Section 5: preserve the Sources sheet's provenance fields; repair its source_record_id
    // (Section 1) rather than trust the workbook's page-level value. When a Companies row has no
    // matching Sources row at all (not expected for this workbook — every one of the 207 rows has
    // exactly one — but handled defensively for a future, less-clean export), fall back to the
    // Companies sheet's own last_verified_at as the observation date; a row with neither is a hard
    // validation error, since observedAt is never silently defaulted to "now" (adapterUtils.ts's
    // documented convention every adapter in this codebase follows).
    const sourceUrlRaw = emptyToNull(str(sourceRow?.source_url));
    if (sourceUrlRaw) { try { new URL(sourceUrlRaw); } catch { throw new Error(`Sources.source_url "${sourceUrlRaw}" is not a valid URL`); } }
    const observedAtRaw = emptyToNull(str(sourceRow?.observed_at)) ?? emptyToNull(str(companyRow.last_verified_at));
    if (!observedAtRaw) throw new Error("no observed_at available for this company (checked Sources.observed_at and Companies.last_verified_at)");
    const observedAt = parseObservedAt(observedAtRaw, "observed_at");

    const originalSourceRecordId = emptyToNull(str(sourceRow?.source_record_id));
    const sourcePageMatch = originalSourceRecordId ? /^page-(\d+)$/i.exec(originalSourceRecordId) : null;

    const metadata: Record<string, unknown> = { cardifyCompanyId: companyId };
    if (originalSourceRecordId) metadata.cardifyOriginalSourceRecordId = originalSourceRecordId;
    if (sourcePageMatch) metadata.cardifySourcePage = Number(sourcePageMatch[1]);
    const fieldOrCategory = emptyToNull(str(sourceRow?.field_or_category));
    if (fieldOrCategory) metadata.cardifyFieldsBacked = sanitizeText(fieldOrCategory, 300);
    const sourceNotes = emptyToNull(str(sourceRow?.notes));
    if (sourceNotes) metadata.cardifySourceNotes = sanitizeText(sourceNotes, 500);

    const record: CompanyRecordInput = {
      companyName: companyNameRaw, normalizedName,
      nameAr: emptyToNull(str(companyRow.company_name_ar)), nameEn: emptyToNull(str(companyRow.company_name_en)),
      registrationNumber, legalType: emptyToNull(str(companyRow.legal_type)) ?? legalTypeGuess,
      status, registrationDate,
      industry: emptyToNull(str(companyRow.industry)) ? sanitizeText(str(companyRow.industry)!, 120) : null,
      activities, governorate, wilayat: wilayatRaw ? normalizeWilayatText(wilayatRaw) : null,
      area: emptyToNull(str(companyRow.area)) ? sanitizeText(str(companyRow.area)!, 80) : null,
      address: emptyToNull(str(companyRow.address)) ? sanitizeText(str(companyRow.address)!, 300) : null,
      website: websiteRaw, email: emailRaw, phone: emptyToNull(str(companyRow.business_phone)) ? sanitizeText(str(companyRow.business_phone)!, 40) : null,
      vatNumber: emptyToNull(str(companyRow.vat_number)), vatStatus: null,
      employeeRange: null, estimatedCompanySize: null,
      // Section 9: explicit null (never undefined, never false) — "missing procurement data means
      // unknown/null, not false". Overwritten below when a matching Procurement sheet row exists.
      registeredSupplier: null, supplierCategory: null, supplierClassification: null,
      governmentProcurementPresence: null, tendersParticipated: null, awardedContractCount: null, lastTenderActivityAt: null,
      // Section 3/4: conservative, centralized, never hardcoded per-row — see this file's top doc
      // comment for why "directory" (not government/tax_authority/government_procurement) and an
      // explicit "reported" (not the derived "estimated") are both deliberate.
      sourceType: "directory", sourceName,
      sourceRecordId: generateCardifySourceRecordId(companyId),
      sourceUrl: sourceUrlRaw, observedAt, metadata,
      verificationStatus: "reported"
    };
    return { result: { record, companyId } };
  } catch (error) {
    return { error: { row: sheetRowNumber, reason: error instanceof Error ? error.message : String(error) } };
  }
}

/** Section 8: tax_verification_status classification — "could_not_verify" (this workbook's value
 *  for all 207 rows) is a NON-outcome (the check was attempted and inconclusive, per the workbook's
 *  own notes), never treated as evidence of anything, and never imported. Only a real, informative
 *  outcome ("verified" | "not_registered" | "pending") with at least one linking identifier
 *  (cr_number or vat_number) is imported — as a second, distinct, still directory-trust-level
 *  source row (never sourceType "tax_authority" — see this file's top doc comment: Cardify's own
 *  research pass is not an authenticated Tax Oman lookup, however its outcome reads). */
export function classifyCardifyTaxRow(row: CardifyTaxVerificationRow): { include: true; outcome: CardifyTaxOutcome } | { include: false; reason: string } {
  const rawStatus = (emptyToNull(str(row.tax_verification_status)) ?? "unknown").trim().toLowerCase() as CardifyTaxOutcome;
  if (!TAX_OUTCOMES_WITH_REAL_EVIDENCE.has(rawStatus)) return { include: false, reason: `tax_verification_status "${rawStatus}" carries no determinable outcome — not imported` };
  const hasIdentifier = Boolean(emptyToNull(str(row.cr_number)) ?? emptyToNull(str(row.vat_number)));
  if (!hasIdentifier) return { include: false, reason: "no cr_number or vat_number to link this tax fact to — not imported" };
  return { include: true, outcome: rawStatus };
}

function normalizeCardifyTaxRow(
  row: CardifyTaxVerificationRow, companyId: string, sheetRowNumber: number, sourceNamePrefix: string
): { record: Partial<CompanyRecordInput> } | { error: RowError } {
  try {
    const classification = classifyCardifyTaxRow(row);
    if (!classification.include) throw new Error(classification.reason);
    const verifiedAtRaw = emptyToNull(str(row.verified_at));
    const taxVerifiedAt = verifiedAtRaw ? parseObservedAt(verifiedAtRaw, "verified_at") : null;
    return {
      record: {
        registrationNumber: emptyToNull(str(row.cr_number)),
        vatNumber: emptyToNull(str(row.vat_number)),
        taxVerificationStatus: classification.outcome,
        taxVerifiedAt,
        sourceType: "directory",
        sourceName: `${sourceNamePrefix} — Tax Verification research`,
        sourceRecordId: generateCardifyTaxSourceRecordId(companyId),
        sourceUrl: emptyToNull(str(row.source_url)),
        observedAt: taxVerifiedAt ?? new Date().toISOString(),
        verificationStatus: "reported"
      }
    };
  } catch (error) {
    return { error: { row: sheetRowNumber, reason: error instanceof Error ? error.message : String(error) } };
  }
}

// ---- Duplicate / identity pre-flight (Section 11/16) --------------------------------------------

export interface CardifyDuplicateReport {
  /** Same company_id appearing on more than one Companies row — a hard error (Section 16): it
   *  would make two different rows generate the SAME sourceRecordId, which upsertCompanies would
   *  then silently treat as one row being updated by the other. Import is refused when non-empty. */
  duplicateCompanyIds: readonly string[];
  /** Different company_id, but the same (normalizedName, governorate) — not a source-key
   *  collision (each keeps its own unique sourceRecordId), but companyRepository's existing
   *  deterministic identity resolution (see companyRepository.ts's doc comment) WILL resolve both
   *  rows to the same companyId. Reported so an operator can see it happened, never silently. */
  duplicateNormalizedNameLocation: readonly { normalizedName: string; governorate: string; companyIds: readonly string[] }[];
  /** Exact same company_name under different company_id — informational only (two real companies
   *  can legitimately share a name); surfaced for operator awareness, never blocked. */
  sameNameDifferentIds: readonly { companyName: string; companyIds: readonly string[] }[];
}

export function detectCardifyDuplicates(rows: readonly { companyId: string; companyName: string; normalizedName: string; governorate: string | null }[]): CardifyDuplicateReport {
  const byCompanyId = new Map<string, string[]>();
  const byNameLocation = new Map<string, { normalizedName: string; governorate: string; companyIds: string[] }>();
  const byName = new Map<string, string[]>();
  for (const r of rows) {
    byCompanyId.set(r.companyId, [...(byCompanyId.get(r.companyId) ?? []), r.companyId]);
    if (r.governorate) {
      const key = `${r.normalizedName}::${r.governorate}`;
      const existing = byNameLocation.get(key) ?? { normalizedName: r.normalizedName, governorate: r.governorate, companyIds: [] };
      existing.companyIds.push(r.companyId);
      byNameLocation.set(key, existing);
    }
    byName.set(r.companyName, [...(byName.get(r.companyName) ?? []), r.companyId]);
  }
  return {
    duplicateCompanyIds: [...byCompanyId.entries()].filter(([, ids]) => ids.length > 1).map(([id]) => id),
    duplicateNormalizedNameLocation: [...byNameLocation.values()].filter(v => v.companyIds.length > 1),
    sameNameDifferentIds: [...byName.entries()].filter(([, ids]) => new Set(ids).size > 1).map(([companyName, companyIds]) => ({ companyName, companyIds }))
  };
}

// ---- Orchestration -------------------------------------------------------------------------------

export interface CardifyImportOptions {
  sourceName?: string;
  /** Section 26: when true, records rejected by validation are also persisted via
   *  repository.recordUnmatched() (Section 19) — set only on a real, non-dry-run execution,
   *  mirroring companyRepository.ts's own doc comment on recordUnmatched. */
  recordUnmatched?: boolean;
}

export interface CardifyImportResult {
  sheetsFound: readonly string[];
  totalCompanyRows: number;
  validRows: number;
  invalidRows: number;
  newCompanies: number;
  matchedExistingCompanies: number;
  sourceEvidenceInserted: number;
  sourceEvidenceUpdated: number;
  generatedSourceRecordIds: number;
  duplicates: CardifyDuplicateReport;
  taxTotalRows: number;
  taxRowsAccepted: number;
  taxRowsIgnored: number;
  procurementTotalRows: number;
  procurementRowsAccepted: number;
  procurementRowsIgnored: number;
  awardTotalRows: number;
  awardRowsAccepted: number;
  awardRowsIgnored: number;
  reviewQueueRowsSkipped: number;
  dataQualityRowsSkipped: number;
  /** Section 21: companies with an enrichment gap worth an operator's attention (missing CR,
   *  missing status, missing website, unknown tax, unknown procurement, low confidence, or a
   *  single contributing source) — purely informational, never treated as import failures. */
  rowsRequiringReview: number;
  errors: readonly RowError[];
  /** First 10 (or fewer) successfully normalized records, for a dry-run/report preview. */
  sampleRecords: readonly CompanyRecordInput[];
}

function asRows<T>(sheet: readonly XlsxRow[] | undefined): T[] {
  return (sheet ?? []) as unknown as T[];
}

/**
 * The single entry point every caller (businessImportCli.ts's `--source=cardify` branch; a future
 * Admin Import Center xlsx upload, should one be added) should use. Never writes anything when
 * `dryRun` is true — mirrors runSourceImport/importCompanyRecords' contract exactly, just for a
 * whole multi-sheet workbook instead of one flat row array (see this file's top doc comment for why
 * that required a bespoke orchestrator rather than fitting importDispatch.ts's one-shape-per-source
 * switch statement).
 */
export async function importCardifyWorkbook(
  workbook: ParsedXlsxWorkbook,
  repository: CompanyRepository,
  dryRun: boolean,
  options: CardifyImportOptions = {}
): Promise<CardifyImportResult> {
  const sourceName = options.sourceName ?? DEFAULT_CARDIFY_SOURCE_NAME;
  const companyRows = asRows<CardifyCompanyRow>(workbook.sheets["Companies"]);
  const sourceRows = asRows<CardifySourceRow>(workbook.sheets["Sources"]);
  const taxRows = asRows<CardifyTaxVerificationRow>(workbook.sheets["Tax Verification"]);
  const procurementRows = asRows<CardifyProcurementRow>(workbook.sheets["Procurement"]);
  const awardRows = asRows<CardifyAwardRow>(workbook.sheets["Awards"]);
  const reviewQueueRows = asRows<Record<string, unknown>>(workbook.sheets["Review Queue"]);
  const dataQualityRows = asRows<Record<string, unknown>>(workbook.sheets["Data Quality"]);

  const sourceRowByCompanyId = new Map<string, CardifySourceRow>();
  for (const row of sourceRows) { const id = str(row.company_id); if (id) sourceRowByCompanyId.set(id.trim(), row); }
  const taxRowByCompanyId = new Map<string, CardifyTaxVerificationRow>();
  for (const row of taxRows) { const id = str(row.company_id); if (id) taxRowByCompanyId.set(id.trim(), row); }
  const procurementRowByCompanyId = new Map<string, CardifyProcurementRow>();
  for (const row of procurementRows) { const id = str(row.company_id); if (id) procurementRowByCompanyId.set(id.trim(), row); }

  // Section 11/16: duplicate/identity pre-flight BEFORE any normalization is trusted. A duplicate
  // company_id refuses the entire import (both dry-run and real) — see CardifyDuplicateReport's
  // doc comment for why this specific case cannot be reduced to a per-row skip.
  const identityRows = companyRows
    .map(row => str(row.company_id))
    .filter((id): id is string => Boolean(id))
    .map(id => {
      const row = companyRows.find(r => str(r.company_id) === id)!;
      const companyName = sanitizeText(str(row.company_name) ?? "", 200);
      const { normalized } = normalizeCompanyName(companyName);
      const governorate = emptyToNull(str(row.governorate));
      return { companyId: id, companyName, normalizedName: normalized, governorate: governorate ? resolveGovernorateName(governorate) : null };
    });
  const duplicates = detectCardifyDuplicates(identityRows);
  if (duplicates.duplicateCompanyIds.length > 0) {
    throw new Error(
      `Cardify import refused: duplicate company_id value(s) found in the Companies sheet — ${duplicates.duplicateCompanyIds.join(", ")}. ` +
      `Each would generate a colliding (sourceName, sourceRecordId) pair; fix the workbook and re-run.`
    );
  }

  const errors: RowError[] = [];
  const validRecords: { record: CompanyRecordInput; companyId: string }[] = [];
  companyRows.forEach((row, index) => {
    const sheetRowNumber = index + 2; // +1 for 0-based index, +1 for the header row
    const sourceRow = sourceRowByCompanyId.get(str(row.company_id)?.trim() ?? "") ?? null;
    const normalized = normalizeCardifyCompanyRow(row, sourceRow, sheetRowNumber, sourceName);
    if ("error" in normalized) { errors.push(normalized.error); return; }
    validRecords.push(normalized.result);
  });

  // Section 8: fold in any tax-evidence rows that clear classifyCardifyTaxRow's bar, as a SECOND
  // source row per company (never mutating the identity row above) — see normalizeCardifyTaxRow.
  let taxRowsAccepted = 0, taxRowsIgnored = 0;
  const taxRecords: CompanyRecordInput[] = [];
  for (const [companyId, row] of taxRowByCompanyId) {
    if (!identityRows.some(r => r.companyId === companyId)) continue; // orphaned tax row with no matching company — nothing to attach it to
    const baseRecord = validRecords.find(v => v.companyId === companyId)?.record;
    if (!baseRecord) continue; // that company's own row failed validation — do not import tax evidence for a company we didn't import
    const sheetRowNumber = taxRows.findIndex(r => str(r.company_id)?.trim() === companyId) + 2;
    const normalized = normalizeCardifyTaxRow(row, companyId, sheetRowNumber, sourceName);
    if ("error" in normalized) { taxRowsIgnored++; continue; }
    taxRowsAccepted++;
    taxRecords.push({
      ...baseRecord,
      ...normalized.record,
      // Fields the tax row itself doesn't speak to are left as the identity row's own (never
      // silently nulled) — but registrationNumber/vatNumber ARE allowed to be more specific here.
      metadata: { ...baseRecord.metadata, cardifyTaxEvidence: true }
    } as CompanyRecordInput);
  }
  // Every tax row that wasn't accepted counts as ignored — whether because its status carried no
  // determinable outcome, it had no linking identifier, or it belonged to a company that itself
  // failed validation (see the loop above).
  taxRowsIgnored = taxRows.length - taxRowsAccepted;

  // Section 9/12: Procurement rows merge onto the SAME per-company evidence row (same
  // sourceRecordId) — it's the same Cardify observation, just spread across sheets for
  // readability. Empty sheet -> no-op, exactly as instructed ("If empty, do nothing").
  let procurementRowsAccepted = 0;
  for (const record of validRecords) {
    const procRow = procurementRowByCompanyId.get(record.companyId);
    if (!procRow) continue;
    const registeredSupplier = procRow.registered_supplier === undefined || procRow.registered_supplier === null || procRow.registered_supplier === ""
      ? null : Boolean(procRow.registered_supplier === true || String(procRow.registered_supplier).trim().toLowerCase() === "true");
    const tendersParticipatedRaw = emptyToNull(str(procRow.tenders_participated));
    const tendersParticipated = tendersParticipatedRaw ? Number(tendersParticipatedRaw) : null;
    record.record.registeredSupplier = registeredSupplier;
    record.record.supplierCategory = emptyToNull(str(procRow.supplier_category));
    record.record.supplierClassification = emptyToNull(str(procRow.supplier_classification));
    record.record.tendersParticipated = tendersParticipated !== null && Number.isFinite(tendersParticipated) ? tendersParticipated : null;
    record.record.governmentProcurementPresence = registeredSupplier === true || (tendersParticipated ?? 0) > 0 ? true : registeredSupplier === false ? null : null;
    const lastActivityRaw = emptyToNull(str(procRow.last_tender_activity));
    record.record.lastTenderActivityAt = lastActivityRaw ? parseObservedAt(lastActivityRaw, "last_tender_activity") : null;
    procurementRowsAccepted++;
  }
  const procurementRowsIgnored = procurementRows.length - procurementRowsAccepted;

  const allRecords = [...validRecords.map(v => v.record), ...taxRecords];
  const generatedSourceRecordIds = validRecords.length + taxRecords.length;

  // Section 15/16: uniqueness pre-flight on the exact (sourceName, sourceRecordId) pairs this
  // batch is about to write — belt-and-suspenders on top of the company_id duplicate check above,
  // since the tax-evidence pass generates its own id namespace.
  const keySeen = new Set<string>();
  for (const record of allRecords) {
    const key = `${record.sourceName}::${record.sourceRecordId}`;
    if (keySeen.has(key)) throw new Error(`Cardify import refused: duplicate (sourceName, sourceRecordId) pair "${key}" would be written twice in the same batch.`);
    keySeen.add(key);
  }

  // Section 15/17: "new companies" vs "matched existing companies" — approximated by checking,
  // for each accepted record, whether the REPOSITORY (dry-run: an isolated scratch repository per
  // businessImportCli.ts's existing --dry-run convention; real run: the actual target repository)
  // already has a row that companyRepository.ts's own resolveCompanyId() would resolve this record
  // onto: a registrationNumber match first (never populated by this source today, but checked for
  // parity with resolveCompanyId's real priority order), else a normalizedName+governorate match.
  // This deliberately does NOT exclude a candidate sharing this record's own sourceRecordId: an
  // idempotent re-import of a row already written by an earlier run is exactly a "resolved to an
  // existing company" outcome, not a "new company" one — Section 17's idempotency test expects the
  // second identical import of the same workbook to report 0 new companies / all matched, and an
  // earlier version of this loop excluded same-sourceRecordId candidates, which made it blind to
  // exactly that case and always reported "new companies" again on every re-run even though the
  // database-level identity resolution was already correctly idempotent (upsertCompanies dedupes on
  // (sourceName, sourceRecordId) regardless of this counter). Still an approximation, same as this
  // project's other dry-run previews (see docs/business-admin.md's disclosed Import Center
  // limitation) — the repository's own resolveCompanyId is the actual authority at write time.
  let newCompanies = 0, matchedExistingCompanies = 0;
  for (const record of validRecords) {
    const r = record.record;
    let matched = false;
    if (r.registrationNumber) {
      const byReg = await repository.searchCandidates({ query: r.registrationNumber, candidateLimit: 5 });
      matched = byReg.some(c => c.registrationNumber === r.registrationNumber);
    }
    if (!matched && r.governorate) {
      const byNameLocation = await repository.searchCandidates({ query: r.normalizedName, governorate: r.governorate, candidateLimit: 5 });
      matched = byNameLocation.some(c => c.normalizedName === r.normalizedName && c.governorate === r.governorate);
    }
    if (matched) matchedExistingCompanies++; else newCompanies++;
  }

  let sourceEvidenceInserted = 0, sourceEvidenceUpdated = 0;
  if (!dryRun && allRecords.length > 0) {
    const upsert: UpsertResult = await repository.upsertCompanies(allRecords);
    sourceEvidenceInserted = upsert.inserted;
    sourceEvidenceUpdated = upsert.updated;
    if (options.recordUnmatched && errors.length > 0) {
      await repository.recordUnmatched(errors.map(e => ({
        sourceType: "directory", sourceName,
        rawPayload: { row: e.row, reason: e.reason },
        reason: "validation_error", reasonDetail: e.reason
      })));
    }
  } else if (dryRun) {
    // Dry run: exercise the exact same upsertCompanies contract against an isolated in-memory
    // repository so the reported inserted/updated counts reflect the real write path's behavior —
    // never write anything to the caller's actual `repository`.
    const { MemoryCompanyRepository } = await import("./companyRepository.js");
    const scratch = new MemoryCompanyRepository();
    const upsert = allRecords.length > 0 ? await scratch.upsertCompanies(allRecords) : { inserted: 0, updated: 0, skipped: 0 };
    sourceEvidenceInserted = upsert.inserted;
    sourceEvidenceUpdated = upsert.updated;
  }

  // Section 9/12: Awards — list-shaped, so they only make sense AFTER the identity rows above have
  // an actual companyId (which only exists post-upsert). Resolved back to a companyId via the
  // cardifyCompanyId tag this adapter always stamps into metadata (Section 1's join key), never by
  // guessing from name text. Empty sheet -> no-op, exactly as instructed ("do not manufacture award
  // rows"). Never run during a dry run (upsertAwards has no dry-run mode of its own).
  let awardRowsAccepted = 0;
  if (!dryRun) {
    for (const awardRow of awardRows) {
      const companyId = str(awardRow.company_id)?.trim();
      const tenderNumber = sanitizeText(str(awardRow.tender_number) ?? "", 100);
      if (!companyId || !tenderNumber) continue;
      const record = validRecords.find(v => v.companyId === companyId);
      if (!record) continue;
      const candidates = await repository.searchCandidates({ query: record.record.normalizedName, governorate: record.record.governorate ?? undefined, candidateLimit: 20 });
      const resolved = candidates.find(c => (c.metadata as Record<string, unknown> | undefined)?.cardifyCompanyId === companyId);
      if (!resolved) continue;
      const observedAtRaw = emptyToNull(str(awardRow.observed_at)) ?? emptyToNull(str(awardRow.award_date));
      if (!observedAtRaw) continue;
      const award: CompanyAwardInput = {
        companyId: resolved.companyId, tenderNumber,
        buyer: emptyToNull(str(awardRow.buyer)), title: emptyToNull(str(awardRow.title)),
        status: null, category: emptyToNull(str(awardRow.category)),
        awardValueOMR: (() => { const v = emptyToNull(str(awardRow.award_value_omr)); return v ? Number(v) : null; })(),
        sourceName: `${sourceName} — Awards`, observedAt: parseObservedAt(observedAtRaw, "observed_at")
      };
      await repository.upsertAwards(resolved.companyId, [award]);
      awardRowsAccepted++;
    }
  }
  const awardRowsIgnored = awardRows.length - awardRowsAccepted;

  // Section 21: enrichment gaps — informational, never a failure. A row counts once even if it has
  // several gaps.
  const rowsRequiringReview = validRecords.filter(v => {
    const r = v.record;
    return !r.registrationNumber || !r.status || !r.website || r.taxVerificationStatus === undefined || r.registeredSupplier === undefined || r.registeredSupplier === null;
  }).length;

  return {
    sheetsFound: workbook.sheetNames,
    totalCompanyRows: companyRows.length,
    validRows: validRecords.length,
    invalidRows: errors.length,
    newCompanies, matchedExistingCompanies,
    sourceEvidenceInserted, sourceEvidenceUpdated,
    generatedSourceRecordIds,
    duplicates,
    taxTotalRows: taxRows.length, taxRowsAccepted, taxRowsIgnored,
    procurementTotalRows: procurementRows.length, procurementRowsAccepted, procurementRowsIgnored,
    awardTotalRows: awardRows.length, awardRowsAccepted, awardRowsIgnored,
    reviewQueueRowsSkipped: reviewQueueRows.length,
    dataQualityRowsSkipped: dataQualityRows.length,
    rowsRequiringReview,
    errors,
    sampleRecords: validRecords.slice(0, 10).map(v => v.record)
  };
}
