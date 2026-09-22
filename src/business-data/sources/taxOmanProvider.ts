import type { CompanyRecordInput, CompanyRepository, UpsertResult } from "./companyRepository.js";
import { sanitizeText, emptyToNull, parseObservedAt, type RowError } from "./adapterUtils.js";
import { normalizeCompanyName } from "../normalizers/companyName.js";

/**
 * Phase 5: the Tax Oman source adapter.
 *
 * ACCESS MECHANISM (see the Source Feasibility Report): Tax Oman's public-facing VATIN
 * verification tool (tms.taxoman.gov.om) disallows automated fetching via robots.txt AND requires
 * solving a CAPTCHA on every lookup — both are explicit, deliberate access controls this project's
 * "Critical rule" forbids bypassing. No official bulk API or open-data export was found. Per the
 * mandated fallback ordering, this source is implemented as a MANUAL/ADMIN IMPORT ADAPTER: an
 * authorized operator performs individual, human-driven VATIN lookups (solving the CAPTCHA
 * themselves, exactly as a person using the portal normally would) and records the outcome, which
 * is then fed through `importTaxOmanRecords` below — never automated CAPTCHA-solving, never a
 * scripted bulk query against the portal.
 *
 * taxVerificationStatus is always a real, human-observed OUTCOME of that lookup
 * ("verified" | "not_registered" | "pending" | "unknown") — never inferred from a company merely
 * existing in another source, and never defaulted to "verified".
 */

export type TaxVerificationOutcome = "verified" | "not_registered" | "pending" | "unknown";
const TAX_VERIFICATION_OUTCOMES: readonly TaxVerificationOutcome[] = ["verified", "not_registered", "pending", "unknown"];

/** The raw shape one Tax Oman-sourced row is expected to arrive in. `registrationNumber` links
 *  this tax-verification fact to the company record another source (typically MOCIIP) already
 *  established — a tax-only row with no registrationNumber can still be imported (it will start its
 *  own company identity per companyRepository.ts's normal resolution rules), but linking by
 *  registration number is strongly preferred so tax facts merge onto the right company. */
export interface TaxOmanRawRecord {
  registrationNumber?: string | null;
  companyName: string;
  vatNumber?: string | null;
  taxVerificationStatus: TaxVerificationOutcome;
  /** When the operator performed the lookup — required (see this file's doc comment). */
  observedAt: string;
  sourceUrl?: string | null;
}

export const DEFAULT_TAX_OMAN_SOURCE_NAME = "Tax Oman VATIN verification (manual lookup)";

export function normalizeTaxOmanRecord(raw: TaxOmanRawRecord, rowIndex: number, sourceName = DEFAULT_TAX_OMAN_SOURCE_NAME): { record: CompanyRecordInput } | { error: RowError } {
  try {
    const companyNameRaw = sanitizeText(raw.companyName, 200);
    if (!companyNameRaw) throw new Error("companyName is required");
    const { normalized: normalizedName, legalTypeGuess } = normalizeCompanyName(companyNameRaw);

    const outcome = raw.taxVerificationStatus;
    if (!TAX_VERIFICATION_OUTCOMES.includes(outcome)) {
      throw new Error(`taxVerificationStatus "${String(outcome)}" must be one of ${TAX_VERIFICATION_OUTCOMES.join(", ")} — a real, observed lookup outcome, never inferred`);
    }

    const observedAt = parseObservedAt(raw.observedAt, "observedAt");
    const registrationNumber = emptyToNull(raw.registrationNumber);
    const vatNumber = emptyToNull(raw.vatNumber);
    const sourceUrlRaw = emptyToNull(raw.sourceUrl);
    if (sourceUrlRaw) { try { new URL(sourceUrlRaw); } catch { throw new Error(`sourceUrl "${sourceUrlRaw}" is not a valid URL`); } }

    const record: CompanyRecordInput = {
      companyName: companyNameRaw, normalizedName,
      nameAr: null, nameEn: null,
      registrationNumber, legalType: legalTypeGuess,
      status: null, registrationDate: null, industry: null, activities: [],
      governorate: null, wilayat: null, area: null, address: null, website: null, email: null, phone: null,
      vatNumber, vatStatus: outcome === "verified" ? "registered" : outcome === "not_registered" ? "not_registered" : null,
      employeeRange: null, estimatedCompanySize: null,
      sourceType: "tax_authority", sourceName,
      // A per-lookup dedup key: (registrationNumber or normalizedName) + vatNumber, when both are
      // known, so re-importing the same company's tax status updates the same row rather than
      // duplicating it — a plain per-row UUID would never dedupe on re-verification.
      sourceRecordId: registrationNumber ? `TAXOMAN-${registrationNumber}` : vatNumber ? `TAXOMAN-VAT-${vatNumber}` : null,
      sourceUrl: sourceUrlRaw, observedAt, metadata: {},
      taxVerificationStatus: outcome, taxVerifiedAt: observedAt,
      // Every field this adapter doesn't itself observe defaults to null/undefined and is simply
      // not part of this row's provenance — matching/merge.ts never lets an absent field here
      // overwrite a value another source already contributed.
      verificationStatus: outcome === "verified" ? "verified" : outcome === "not_registered" ? "verified" : "unknown",
      lastVerifiedAt: observedAt
    };
    return { record };
  } catch (error) {
    return { error: { row: rowIndex, reason: error instanceof Error ? error.message : String(error) } };
  }
}

export interface AdapterImportResult { totalRows: number; imported: number; updated: number; skipped: number; errors: RowError[] }

export async function importTaxOmanRecords(rows: readonly TaxOmanRawRecord[], repository: CompanyRepository, sourceName?: string): Promise<AdapterImportResult> {
  const errors: RowError[] = [];
  const validRecords: CompanyRecordInput[] = [];
  rows.forEach((row, index) => {
    const result = normalizeTaxOmanRecord(row, index + 1, sourceName);
    if ("error" in result) errors.push(result.error);
    else validRecords.push(result.record);
  });
  const upsert: UpsertResult = validRecords.length > 0 ? await repository.upsertCompanies(validRecords) : { inserted: 0, updated: 0, skipped: 0 };
  return { totalRows: rows.length, imported: upsert.inserted, updated: upsert.updated, skipped: upsert.skipped, errors };
}
