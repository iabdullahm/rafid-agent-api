import { z } from "zod";
import { COMPANY_SOURCE_TYPES, COMPANY_STATUSES, type CompanySourceType, type CompanyStatus } from "../types.js";
import { normalizeCompanyName } from "../normalizers/companyName.js";
import { resolveGovernorateName, normalizeWilayatText } from "../normalizers/location.js";
import type { CompanyRecordInput, CompanyRepository, UpsertResult } from "../sources/companyRepository.js";
// Reused, generic (not property-specific) parsing/safety utilities — one implementation, not a
// second copy: CSV/JSON parsing, file-size/row-count caps and text sanitization apply identically
// to any tabular import this project does. See src/domain/oman/importPipeline.ts's doc comment.
import { parseCsv, parseJsonRows, loadImportRows, MAX_IMPORT_FILE_BYTES, MAX_IMPORT_ROWS } from "../../domain/oman/importPipeline.js";

/**
 * Section 4/10/14: a safe, validating import pipeline for production Oman business data, reading
 * CSV or JSON and writing through the same CompanyRepository interface the search/profile/analyze
 * capabilities themselves query — never a second, parallel write path. Every row is validated and
 * normalized independently; a malformed row is recorded as an error and skipped rather than
 * aborting the whole file. Nothing here executes, evaluates, or interprets imported content as
 * anything other than inert data.
 */

export { parseCsv, parseJsonRows, loadImportRows, MAX_IMPORT_FILE_BYTES, MAX_IMPORT_ROWS };

const MAX_TEXT_FIELD_LENGTH = 300;
const MAX_URL_LENGTH = 2000;
const MAX_METADATA_JSON_LENGTH = 4000;

export interface ImportRowError { row: number; reason: string }
export interface ImportResult { totalRows: number; imported: number; updated: number; skipped: number; errors: ImportRowError[] }

function sanitizeText(value: string, maxLength = MAX_TEXT_FIELD_LENGTH): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, maxLength);
}
function emptyToNull(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

const STATUS_ALIASES: Record<string, CompanyStatus> = {
  active: "active", operating: "active", operational: "active",
  inactive: "inactive", closed: "inactive", dissolved: "inactive", cancelled: "inactive", canceled: "inactive",
  suspended: "suspended", "on hold": "suspended",
  unknown: "unknown"
};

const rawRowSchema = z.strictObject({
  companyName: z.union([z.string(), z.number()]),
  nameAr: z.union([z.string(), z.number()]).optional().nullable(),
  nameEn: z.union([z.string(), z.number()]).optional().nullable(),
  registrationNumber: z.union([z.string(), z.number()]).optional().nullable(),
  legalType: z.union([z.string(), z.number()]).optional().nullable(),
  status: z.union([z.string(), z.number()]).optional().nullable(),
  registrationDate: z.union([z.string(), z.number()]).optional().nullable(),
  industry: z.union([z.string(), z.number()]).optional().nullable(),
  activities: z.union([z.string(), z.array(z.string())]).optional().nullable(),
  governorate: z.union([z.string(), z.number()]).optional().nullable(),
  wilayat: z.union([z.string(), z.number()]).optional().nullable(),
  area: z.union([z.string(), z.number()]).optional().nullable(),
  address: z.union([z.string(), z.number()]).optional().nullable(),
  website: z.union([z.string(), z.number()]).optional().nullable(),
  email: z.union([z.string(), z.number()]).optional().nullable(),
  phone: z.union([z.string(), z.number()]).optional().nullable(),
  vatNumber: z.union([z.string(), z.number()]).optional().nullable(),
  vatStatus: z.union([z.string(), z.number()]).optional().nullable(),
  employeeRange: z.union([z.string(), z.number()]).optional().nullable(),
  estimatedCompanySize: z.union([z.string(), z.number()]).optional().nullable(),
  sourceType: z.union([z.string(), z.number()]),
  sourceName: z.union([z.string(), z.number()]),
  sourceRecordId: z.union([z.string(), z.number()]).optional().nullable(),
  sourceUrl: z.union([z.string(), z.number()]).optional().nullable(),
  observedAt: z.union([z.string(), z.number()]),
  metadata: z.union([z.string(), z.record(z.string(), z.unknown())]).optional().nullable()
});

function normalizeRow(raw: unknown, rowIndex: number): { record: CompanyRecordInput } | { error: string } {
  const parsed = rawRowSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return { error: `row ${rowIndex}: ${first ? `${first.path.join(".") || "(row)"} — ${first.message}` : "does not match the expected column shape (unknown or missing fields)"}` };
  }
  const row = parsed.data;
  try {
    const companyNameRaw = sanitizeText(String(row.companyName), 200);
    if (!companyNameRaw) throw new Error("companyName is required");
    const { normalized: normalizedName, legalTypeGuess } = normalizeCompanyName(companyNameRaw);

    const sourceTypeRaw = String(row.sourceType).trim().toLowerCase();
    if (!(COMPANY_SOURCE_TYPES as readonly string[]).includes(sourceTypeRaw)) throw new Error(`sourceType "${row.sourceType}" must be one of ${COMPANY_SOURCE_TYPES.join(", ")}`);
    const sourceType = sourceTypeRaw as CompanySourceType;
    if (sourceType === "demo") throw new Error('sourceType "demo" cannot be imported through this pipeline — reserved for the built-in curated dataset');

    const sourceName = sanitizeText(String(row.sourceName), 200);
    if (!sourceName) throw new Error("sourceName is required");
    const sourceRecordId = row.sourceRecordId === undefined || row.sourceRecordId === null ? null : sanitizeText(String(row.sourceRecordId), 200) || null;
    const sourceUrlRaw = emptyToNull(row.sourceUrl);
    const sourceUrl = sourceUrlRaw ? sanitizeText(sourceUrlRaw, MAX_URL_LENGTH) : null;
    if (sourceUrl) { try { new URL(sourceUrl); } catch { throw new Error(`sourceUrl "${sourceUrl}" is not a valid URL`); } }

    const observedAtMs = Date.parse(String(row.observedAt));
    if (!Number.isFinite(observedAtMs)) throw new Error(`observedAt "${row.observedAt}" is not a valid date`);
    if (observedAtMs > Date.now() + 86_400_000) throw new Error("observedAt cannot be more than a day in the future");
    const observedAt = new Date(observedAtMs).toISOString();

    let status: CompanyStatus | null = null;
    const statusRaw = emptyToNull(row.status);
    if (statusRaw) {
      const resolved = STATUS_ALIASES[statusRaw.trim().toLowerCase()];
      if (!resolved) throw new Error(`status "${statusRaw}" must be one of ${COMPANY_STATUSES.join(", ")} (or a recognized alias)`);
      status = resolved;
    }

    let governorate: string | null = null;
    const governorateRaw = emptyToNull(row.governorate);
    if (governorateRaw) {
      const resolved = resolveGovernorateName(governorateRaw);
      if (!resolved) throw new Error(`governorate "${governorateRaw}" is not a recognized Oman governorate — not imported rather than guessed at`);
      governorate = resolved;
    }
    const wilayatRaw = emptyToNull(row.wilayat);

    const registrationDateRaw = emptyToNull(row.registrationDate);
    let registrationDate: string | null = null;
    if (registrationDateRaw) {
      const ms = Date.parse(registrationDateRaw);
      if (!Number.isFinite(ms)) throw new Error(`registrationDate "${registrationDateRaw}" is not a valid date`);
      if (ms > Date.now()) throw new Error("registrationDate cannot be in the future");
      registrationDate = new Date(ms).toISOString().slice(0, 10);
    }

    const emailRaw = emptyToNull(row.email);
    if (emailRaw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) throw new Error(`email "${emailRaw}" is not a valid email address`);
    const websiteRaw = emptyToNull(row.website);
    if (websiteRaw) { try { new URL(websiteRaw); } catch { throw new Error(`website "${websiteRaw}" is not a valid URL`); } }

    let activities: string[] = [];
    if (row.activities !== undefined && row.activities !== null) {
      const list = Array.isArray(row.activities) ? row.activities : String(row.activities).split(",");
      activities = list.map(a => sanitizeText(String(a), 120)).filter(Boolean).slice(0, 20);
    }

    let metadata: Record<string, unknown> = {};
    if (row.metadata !== undefined && row.metadata !== null && row.metadata !== "") {
      if (typeof row.metadata === "string") {
        const trimmed = row.metadata.trim();
        if (trimmed.length > MAX_METADATA_JSON_LENGTH) throw new Error(`metadata exceeds ${MAX_METADATA_JSON_LENGTH} characters`);
        try {
          const parsedMetadata = JSON.parse(trimmed);
          if (parsedMetadata && typeof parsedMetadata === "object" && !Array.isArray(parsedMetadata)) metadata = parsedMetadata as Record<string, unknown>;
          else throw new Error("metadata JSON must be an object");
        } catch { throw new Error("metadata is not valid JSON"); }
      } else {
        if (JSON.stringify(row.metadata).length > MAX_METADATA_JSON_LENGTH) throw new Error(`metadata exceeds ${MAX_METADATA_JSON_LENGTH} characters`);
        metadata = row.metadata as Record<string, unknown>;
      }
    }

    const record: CompanyRecordInput = {
      companyName: companyNameRaw, normalizedName,
      nameAr: emptyToNull(row.nameAr), nameEn: emptyToNull(row.nameEn),
      registrationNumber: emptyToNull(row.registrationNumber),
      legalType: emptyToNull(row.legalType) ?? legalTypeGuess,
      status, registrationDate,
      industry: emptyToNull(row.industry) ? sanitizeText(String(row.industry), 120) : null,
      activities, governorate, wilayat: wilayatRaw ? normalizeWilayatText(wilayatRaw) : null,
      area: emptyToNull(row.area) ? sanitizeText(String(row.area), 80) : null,
      address: emptyToNull(row.address) ? sanitizeText(String(row.address), 300) : null,
      website: websiteRaw, email: emailRaw, phone: emptyToNull(row.phone) ? sanitizeText(String(row.phone), 40) : null,
      vatNumber: emptyToNull(row.vatNumber), vatStatus: emptyToNull(row.vatStatus),
      employeeRange: emptyToNull(row.employeeRange), estimatedCompanySize: emptyToNull(row.estimatedCompanySize),
      sourceType, sourceName, sourceRecordId, sourceUrl, observedAt, metadata
    };
    return { record };
  } catch (error) {
    return { error: `row ${rowIndex}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Validates, normalizes and upserts a batch of raw rows (already parsed from CSV or JSON) through
 * the given repository. Never throws on a bad row — every failure is collected in `errors` with
 * its 1-based row number, and the import proceeds with whatever rows did validate.
 */
export async function importCompanyRecords(rows: readonly unknown[], repository: CompanyRepository): Promise<ImportResult> {
  if (rows.length > MAX_IMPORT_ROWS) throw new Error(`Import batch exceeds the maximum of ${MAX_IMPORT_ROWS} rows (got ${rows.length}); split the file and import in batches`);
  const errors: ImportRowError[] = [];
  const validRecords: CompanyRecordInput[] = [];
  rows.forEach((row, index) => {
    const result = normalizeRow(row, index + 1);
    if ("error" in result) errors.push({ row: index + 1, reason: result.error });
    else validRecords.push(result.record);
  });
  const upsert: UpsertResult = validRecords.length > 0 ? await repository.upsertCompanies(validRecords) : { inserted: 0, updated: 0, skipped: 0 };
  return { totalRows: rows.length, imported: upsert.inserted, updated: upsert.updated, skipped: upsert.skipped, errors };
}
