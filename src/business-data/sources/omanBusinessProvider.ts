import { COMPANY_STATUSES, type CompanyStatus } from "../types.js";
import { normalizeCompanyName } from "../normalizers/companyName.js";
import { resolveGovernorateName, normalizeWilayatText } from "../normalizers/location.js";
import type { CompanyRecordInput, CompanyRepository, UpsertResult } from "./companyRepository.js";
import { sanitizeText, emptyToNull, parseObservedAt, parseOptionalPastDate, type RowError } from "./adapterUtils.js";

/**
 * Phase 4: the Oman Business / MOCIIP source adapter.
 *
 * ACCESS MECHANISM (see docs/business-intelligence.md's "Production Oman Data Sources" section /
 * the Source Feasibility Report for the full research trail): business.gov.om (Invest Easy /
 * MOCIIP's public company-search portal) disallows automated fetching via its own robots.txt, and
 * exposes no confirmed public bulk-export API or open-data download — the Global Open Data Index
 * rates Oman's company register "not meaningfully open" (search-mask-only). Per this project's
 * strict access-mechanism ordering (official API > open-data download > documented public endpoint
 * > manual/admin import > licensed feed > carefully controlled extraction only if clearly
 * permitted), this source is implemented as a MANUAL/ADMIN IMPORT ADAPTER: an authorized operator
 * looks up or exports company records through the portal's own UI (or a future written data-sharing
 * agreement with MOCIIP) and feeds the resulting rows through `importMociipRecords` below — never
 * live scraping, never bypassing the portal's robots.txt or any access control. If MOCIIP ever
 * publishes an official API or open-data feed, only this file's row-fetching step would need to
 * change; the normalization/repository-write path below is already correct for that day.
 */

/** The raw shape one MOCIIP-sourced row is expected to arrive in (from a manual export/admin
 *  entry) — deliberately narrower and more literal than importPipeline.ts's generic CSV shape,
 *  matching the fields MOCIIP's own company-search result actually exposes. */
export interface MociipRawRecord {
  registrationNumber: string;
  companyNameEn?: string | null;
  companyNameAr?: string | null;
  legalForm?: string | null;
  status?: string | null;
  registrationDate?: string | null;
  governorate?: string | null;
  wilayat?: string | null;
  activity?: string | null;
  /** The portal's own per-record page URL, when the operator captured one — never fabricated. */
  sourceUrl?: string | null;
  /** When the operator looked this record up / exported it — required, never defaulted to "now"
   *  silently, so a stale manual export is never misrepresented as freshly observed. */
  observedAt: string;
}

const MOCIIP_STATUS_ALIASES: Record<string, CompanyStatus> = {
  active: "active", operating: "active", operational: "active", "commercially registered": "active",
  inactive: "inactive", closed: "inactive", cancelled: "inactive", canceled: "inactive", expired: "inactive",
  suspended: "suspended",
  unknown: "unknown"
};

export const DEFAULT_MOCIIP_SOURCE_NAME = "Oman Business / MOCIIP company register (manual lookup)";

export function normalizeMociipRecord(raw: MociipRawRecord, rowIndex: number, sourceName = DEFAULT_MOCIIP_SOURCE_NAME): { record: CompanyRecordInput } | { error: RowError } {
  try {
    const registrationNumber = sanitizeText(raw.registrationNumber, 60);
    if (!registrationNumber) throw new Error("registrationNumber is required");

    const nameSource = emptyToNull(raw.companyNameEn) ?? emptyToNull(raw.companyNameAr);
    if (!nameSource) throw new Error("companyNameEn or companyNameAr is required");
    const companyNameRaw = sanitizeText(nameSource, 200);
    const { normalized: normalizedName, legalTypeGuess } = normalizeCompanyName(companyNameRaw);

    let status: CompanyStatus | null = null;
    const statusRaw = emptyToNull(raw.status);
    if (statusRaw) {
      const resolved = MOCIIP_STATUS_ALIASES[statusRaw.trim().toLowerCase()];
      if (!resolved) throw new Error(`status "${statusRaw}" must be one of ${COMPANY_STATUSES.join(", ")} (or a recognized MOCIIP status alias)`);
      status = resolved;
    }

    let governorate: string | null = null;
    const governorateRaw = emptyToNull(raw.governorate);
    if (governorateRaw) {
      const resolved = resolveGovernorateName(governorateRaw);
      if (!resolved) throw new Error(`governorate "${governorateRaw}" is not a recognized Oman governorate`);
      governorate = resolved;
    }

    const observedAt = parseObservedAt(raw.observedAt, "observedAt");
    const registrationDate = parseOptionalPastDate(emptyToNull(raw.registrationDate), "registrationDate");
    const sourceUrlRaw = emptyToNull(raw.sourceUrl);
    if (sourceUrlRaw) { try { new URL(sourceUrlRaw); } catch { throw new Error(`sourceUrl "${sourceUrlRaw}" is not a valid URL`); } }

    const record: CompanyRecordInput = {
      companyName: companyNameRaw, normalizedName,
      nameAr: emptyToNull(raw.companyNameAr), nameEn: emptyToNull(raw.companyNameEn),
      registrationNumber, legalType: emptyToNull(raw.legalForm) ?? legalTypeGuess,
      status, registrationDate,
      industry: emptyToNull(raw.activity) ? sanitizeText(String(raw.activity), 120) : null,
      activities: [], governorate, wilayat: emptyToNull(raw.wilayat) ? normalizeWilayatText(String(raw.wilayat)) : null,
      area: null, address: null, website: null, email: null, phone: null,
      vatNumber: null, vatStatus: null, employeeRange: null, estimatedCompanySize: null,
      sourceType: "government", sourceName, sourceRecordId: registrationNumber, sourceUrl: sourceUrlRaw,
      observedAt, metadata: {}
    };
    return { record };
  } catch (error) {
    return { error: { row: rowIndex, reason: error instanceof Error ? error.message : String(error) } };
  }
}

export interface AdapterImportResult { totalRows: number; imported: number; updated: number; skipped: number; errors: RowError[] }

/** Validates, normalizes and upserts a batch of manually-obtained MOCIIP rows — never throws on a
 *  single bad row (collected in `errors` with its 1-based row number instead), mirroring
 *  importPipeline.ts's importCompanyRecords contract exactly. */
export async function importMociipRecords(rows: readonly MociipRawRecord[], repository: CompanyRepository, sourceName?: string): Promise<AdapterImportResult> {
  const errors: RowError[] = [];
  const validRecords: CompanyRecordInput[] = [];
  rows.forEach((row, index) => {
    const result = normalizeMociipRecord(row, index + 1, sourceName);
    if ("error" in result) errors.push(result.error);
    else validRecords.push(result.record);
  });
  const upsert: UpsertResult = validRecords.length > 0 ? await repository.upsertCompanies(validRecords) : { inserted: 0, updated: 0, skipped: 0 };
  return { totalRows: rows.length, imported: upsert.inserted, updated: upsert.updated, skipped: upsert.skipped, errors };
}
