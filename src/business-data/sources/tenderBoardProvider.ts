import type { CompanyAwardInput, CompanyRecordInput, CompanyRepository, UpsertResult } from "./companyRepository.js";
import { sanitizeText, emptyToNull, parseObservedAt, type RowError } from "./adapterUtils.js";
import { normalizeCompanyName } from "../normalizers/companyName.js";

/**
 * Phase 6: the Tender Board / Esnad source adapter.
 *
 * ACCESS MECHANISM (see the Source Feasibility Report): Oman's Tender Board (Esnad) publishes a
 * public, no-login dashboard showing aggregate tender/spend statistics, and mentions (unconfirmed
 * at research time) an "Open Data Graphical Report" section — but individual supplier registration
 * status and per-tender award detail sit behind a PKI-certificate-based login, which is a hard
 * authentication boundary this project's "Critical rule" forbids working around. No confirmed
 * public bulk-export API was found. Per the mandated fallback ordering, this source is implemented
 * as a MANUAL/ADMIN IMPORT ADAPTER: an authorized operator with legitimate Esnad access (e.g. the
 * supplier's own staff, or a party the supplier has authorized) exports or transcribes their
 * registration/award records and feeds them through the two importers below — never automated
 * PKI-login bypass, never scraping the authenticated portal.
 *
 * Two distinct row shapes, because they answer two distinct questions: a supplier SNAPSHOT (is this
 * company a registered government supplier, and what's its participation summary — merged onto
 * oman_companies like any other field) versus individual AWARD facts (which specific tenders it has
 * won — list-shaped, stored in oman_company_awards; see companyRepository.ts's doc comment on why
 * these are never conflated into one row shape).
 */

/** One company's procurement participation snapshot as of `observedAt`. */
export interface TenderBoardSupplierRawRecord {
  registrationNumber?: string | null;
  companyName: string;
  registeredSupplier: boolean;
  supplierCategory?: string | null;
  supplierClassification?: string | null;
  tendersParticipated?: number | null;
  lastTenderActivityAt?: string | null;
  observedAt: string;
  sourceUrl?: string | null;
}

/** One awarded/contracted tender fact. `registrationNumber` MUST resolve to an already-known
 *  company (via an earlier MOCIIP/supplier-snapshot import) — an award alone carries too little
 *  identity information (no governorate, no address) to safely start a new company identity, so an
 *  unresolvable award is honestly rejected as an error rather than guessed at. */
export interface TenderBoardAwardRawRecord {
  registrationNumber: string;
  tenderNumber: string;
  buyer?: string | null;
  title?: string | null;
  status?: string | null;
  awardValueOMR?: number | null;
  category?: string | null;
  observedAt: string;
}

export const DEFAULT_TENDER_BOARD_SOURCE_NAME = "Oman Tender Board / Esnad (manual export)";

export function normalizeTenderBoardSupplierRecord(raw: TenderBoardSupplierRawRecord, rowIndex: number, sourceName = DEFAULT_TENDER_BOARD_SOURCE_NAME): { record: CompanyRecordInput } | { error: RowError } {
  try {
    const companyNameRaw = sanitizeText(raw.companyName, 200);
    if (!companyNameRaw) throw new Error("companyName is required");
    const { normalized: normalizedName, legalTypeGuess } = normalizeCompanyName(companyNameRaw);
    if (typeof raw.registeredSupplier !== "boolean") throw new Error("registeredSupplier must be a boolean — a real, observed registration fact, never inferred");

    const observedAt = parseObservedAt(raw.observedAt, "observedAt");
    const registrationNumber = emptyToNull(raw.registrationNumber);
    const lastTenderActivityAt = emptyToNull(raw.lastTenderActivityAt) ? parseObservedAt(String(raw.lastTenderActivityAt), "lastTenderActivityAt") : null;
    const tendersParticipated = raw.tendersParticipated ?? null;
    if (tendersParticipated !== null && (!Number.isInteger(tendersParticipated) || tendersParticipated < 0)) throw new Error("tendersParticipated must be a non-negative integer");
    const sourceUrlRaw = emptyToNull(raw.sourceUrl);
    if (sourceUrlRaw) { try { new URL(sourceUrlRaw); } catch { throw new Error(`sourceUrl "${sourceUrlRaw}" is not a valid URL`); } }

    const record: CompanyRecordInput = {
      companyName: companyNameRaw, normalizedName,
      nameAr: null, nameEn: null, registrationNumber, legalType: legalTypeGuess,
      status: null, registrationDate: null, industry: null, activities: [],
      governorate: null, wilayat: null, area: null, address: null, website: null, email: null, phone: null,
      vatNumber: null, vatStatus: null, employeeRange: null, estimatedCompanySize: null,
      sourceType: "government_procurement", sourceName,
      sourceRecordId: registrationNumber ? `ESNAD-${registrationNumber}` : null,
      sourceUrl: sourceUrlRaw, observedAt, metadata: {},
      registeredSupplier: raw.registeredSupplier,
      supplierCategory: emptyToNull(raw.supplierCategory),
      supplierClassification: emptyToNull(raw.supplierClassification),
      governmentProcurementPresence: raw.registeredSupplier || (tendersParticipated ?? 0) > 0,
      tendersParticipated, awardedContractCount: null, lastTenderActivityAt
    };
    return { record };
  } catch (error) {
    return { error: { row: rowIndex, reason: error instanceof Error ? error.message : String(error) } };
  }
}

export interface AdapterImportResult { totalRows: number; imported: number; updated: number; skipped: number; errors: RowError[] }

export async function importTenderBoardSupplierRecords(rows: readonly TenderBoardSupplierRawRecord[], repository: CompanyRepository, sourceName?: string): Promise<AdapterImportResult> {
  const errors: RowError[] = [];
  const validRecords: CompanyRecordInput[] = [];
  rows.forEach((row, index) => {
    const result = normalizeTenderBoardSupplierRecord(row, index + 1, sourceName);
    if ("error" in result) errors.push(result.error);
    else validRecords.push(result.record);
  });
  const upsert: UpsertResult = validRecords.length > 0 ? await repository.upsertCompanies(validRecords) : { inserted: 0, updated: 0, skipped: 0 };
  return { totalRows: rows.length, imported: upsert.inserted, updated: upsert.updated, skipped: upsert.skipped, errors };
}

/** Resolves an award row's registrationNumber to an existing companyId via the repository's own
 *  exact-registration-number search — never fuzzy, never a new identity started from an award
 *  alone. Returns null (not a throw) when no match is found so the caller can report it as a
 *  per-row error rather than aborting the whole batch. */
async function resolveCompanyIdByRegistrationNumber(registrationNumber: string, repository: CompanyRepository): Promise<string | null> {
  const candidates = await repository.searchCandidates({ query: registrationNumber, candidateLimit: 10 });
  const match = candidates.find(c => c.registrationNumber === registrationNumber);
  return match?.companyId ?? null;
}

/** Validates, resolves and upserts award/contract facts. Each row's companyId is resolved fresh
 *  per row (never batched/cached across rows) so a company imported earlier in the same run is
 *  still found correctly. `upsertAwards` itself dedupes on (companyId, sourceName, tenderNumber) —
 *  see companyRepository.ts — so re-importing the same award updates it in place. */
export async function importTenderBoardAwardRecords(rows: readonly TenderBoardAwardRawRecord[], repository: CompanyRepository, sourceName = DEFAULT_TENDER_BOARD_SOURCE_NAME): Promise<AdapterImportResult> {
  const errors: RowError[] = [];
  let imported = 0;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const rowIndex = i + 1;
    try {
      const registrationNumber = sanitizeText(String(row.registrationNumber ?? ""), 60);
      if (!registrationNumber) throw new Error("registrationNumber is required to link an award to a known company");
      const tenderNumber = sanitizeText(String(row.tenderNumber ?? ""), 100);
      if (!tenderNumber) throw new Error("tenderNumber is required");
      const observedAt = parseObservedAt(row.observedAt, "observedAt");
      const awardValueOMR = row.awardValueOMR ?? null;
      if (awardValueOMR !== null && (!Number.isFinite(awardValueOMR) || awardValueOMR < 0)) throw new Error("awardValueOMR must be a non-negative number");

      const companyId = await resolveCompanyIdByRegistrationNumber(registrationNumber, repository);
      if (!companyId) throw new Error(`no known company has registrationNumber "${registrationNumber}" — import that company's MOCIIP/supplier record first`);

      const award: CompanyAwardInput = {
        companyId, tenderNumber, buyer: emptyToNull(row.buyer), title: emptyToNull(row.title),
        status: emptyToNull(row.status), awardValueOMR, category: emptyToNull(row.category),
        sourceName, observedAt
      };
      await repository.upsertAwards(companyId, [award]);
      imported++;
    } catch (error) {
      errors.push({ row: rowIndex, reason: error instanceof Error ? error.message : String(error) });
    }
  }
  return { totalRows: rows.length, imported, updated: 0, skipped: 0, errors };
}
