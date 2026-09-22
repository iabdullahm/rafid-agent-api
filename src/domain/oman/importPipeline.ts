import { readFileSync, statSync } from "node:fs";
import { resolve as resolvePath, extname } from "node:path";
import { z } from "zod";
import { PROPERTY_TYPES, FURNISHED_STATUSES, SOURCE_TYPES, RENT_PERIODS, type PropertyType, type FurnishedStatus, type SourceType, type RentPeriod } from "./types.js";
import { resolveAreaName, normalize as normalizeAreaText } from "./locations.js";
import type { MarketRecordInput, PropertyMarketRepository, TransactionType, UpsertResult } from "./marketRepository.js";
import { computeDataQualityScore } from "./dataQualityScore.js";

/**
 * Phase 4/10: a safe, validating import pipeline for production Oman property market data,
 * reading CSV or JSON and writing through the same `PropertyMarketRepository` interface the
 * analysis service itself queries (PostgresPropertyMarketRepository in production,
 * MemoryPropertyMarketRepository in tests) — never a second, parallel write path.
 *
 * Every row is validated and normalized independently; a malformed row is recorded as an error
 * and skipped rather than aborting the whole file (Phase 4: "reject malformed records", not
 * "reject the whole import"). Nothing here executes, evaluates, or interprets imported content as
 * anything other than inert data — no eval, no dynamic require, no shell-out.
 */

/** Phase 10: hard caps so a malformed or hostile file cannot exhaust memory or overwhelm the
 *  database in one call. A real production feed is expected to import in batches well under
 *  these limits; a file that needs more should be split by the operator, not by raising these. */
export const MAX_IMPORT_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
export const MAX_IMPORT_ROWS = 20_000;

/** Production-readiness pass (Al Mouj partner feed, targeted change #1): plausible unit-size
 *  bounds, keyed by property type rather than one generic range. A single 10-3000 sqm band across
 *  every property type rejected legitimate ultra-luxury villas (some Al Mouj Zunairah units run
 *  3,000-10,000+ sqm of built-up area) while being far looser than warranted for an apartment. The
 *  bounds are centralized here — the single place import validation reads them from — rather than
 *  duplicated per caller, and are deliberately still finite in both directions per property type:
 *  widening the villa band must never become "accept anything," since an implausible value (a
 *  10 sqm "villa", a 50,000 sqm "apartment") is still a data-entry error, not a legitimate outlier.
 *  Adjust here, in one place, as real partner data justifies a different band. */
export const SIZE_BOUNDS_BY_PROPERTY_TYPE: Record<PropertyType, { min: number; max: number }> = {
  apartment: { min: 20, max: 1500 },
  townhouse: { min: 40, max: 2000 },
  villa: { min: 50, max: 10000 }
};
const MAX_TEXT_FIELD_LENGTH = 300;
const MAX_URL_LENGTH = 2000;
const MAX_METADATA_JSON_LENGTH = 4000;

/** Partner Operations layer (Section 6): a stable, partner-facing taxonomy for why a row was
 *  rejected — safe to show a partner in a dashboard/log without echoing their raw data back to
 *  them. Deliberately coarse-grained (one code per validated concept, not one per Zod issue) so it
 *  stays a small, documentable, backward-compatible surface as validation logic evolves. */
export const IMPORT_ERROR_CODES = [
  "INVALID_FORMAT", "INVALID_AREA", "INVALID_PROPERTY_TYPE", "INVALID_TRANSACTION_TYPE",
  "INVALID_SIZE", "INVALID_PRICE", "INVALID_BEDROOMS", "INVALID_BATHROOMS", "INVALID_RENT_PERIOD",
  "INVALID_FURNISHED", "INVALID_SOURCE_TYPE", "INVALID_SOURCE_NAME", "INVALID_URL", "INVALID_DATE",
  "INVALID_METADATA", "DUPLICATE_RECORD"
] as const;
export type ImportErrorCode = (typeof IMPORT_ERROR_CODES)[number];

/** Thrown by normalizeRow()'s per-field checks so each failure carries a stable `code` alongside
 *  its human-readable `message` — never thrown for a reason outside IMPORT_ERROR_CODES. */
class RowValidationError extends Error {
  constructor(readonly code: ImportErrorCode, message: string) { super(message); }
}

export interface ImportRowError { row: number; code: ImportErrorCode; reason: string }
export interface ImportResult {
  totalRows: number;
  imported: number;
  updated: number;
  skipped: number;
  errors: ImportRowError[];
  /** Mean of every accepted record's dataQualityScore (Section 7), rounded to 2 decimals; null
   *  when nothing in this batch was accepted. */
  averageDataQualityScore: number | null;
  /** The latest observedAt among accepted records in this batch, or null when nothing was
   *  accepted — feeds PartnerRepository.recordImportStats()'s latestObservedAt (Section 8). */
  latestObservedAt: string | null;
}

/** Section 2/10: forces every accepted record in a batch to be attributed to a specific,
 *  already-authenticated (or operator-specified) partner — see importMarketRecords()'s doc
 *  comment for why this is NEVER derived from row data itself. */
export interface PartnerAttribution {
  partnerId: string;
  sourceType: SourceType;
  sourceName: string;
}

export interface ImportOptions {
  partner?: PartnerAttribution;
}

/** Strips control characters (a file cannot smuggle terminal escapes or nulls into stored text —
 *  Phase 10: "sanitize text") and caps length. Never used on numeric/date/enum fields, which are
 *  validated by type instead. */
function sanitizeText(value: string, maxLength = MAX_TEXT_FIELD_LENGTH): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, maxLength);
}

function emptyToNull(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

const RENT_PERIOD_ALIASES: Record<string, RentPeriod> = {
  monthly: "monthly", month: "monthly", "per month": "monthly", "/month": "monthly",
  annual: "annual", annually: "annual", yearly: "annual", year: "annual", "per year": "annual", "/year": "annual"
};
const FURNISHED_ALIASES: Record<string, FurnishedStatus> = {
  furnished: "furnished",
  "semi_furnished": "semi_furnished", "semi-furnished": "semi_furnished", "semi furnished": "semi_furnished", semi: "semi_furnished",
  unfurnished: "unfurnished", "not furnished": "unfurnished", "not-furnished": "unfurnished"
};
const TRANSACTION_TYPE_ALIASES: Record<string, TransactionType> = {
  rental: "rental", rent: "rental", lease: "rental", "for rent": "rental",
  sale: "sale", sell: "sale", "for sale": "sale", resale: "sale"
};

/** Raw row shape as it arrives from CSV (all strings) or a loosely-typed JSON file — validated,
 *  strict (Phase 10: "reject unknown fields"), and permissive only about *representation* (a
 *  number may arrive as "130" or 130), never about *vocabulary* (an unrecognized propertyType is
 *  a validation error, not silently coerced). */
const rawRowSchema = z.strictObject({
  governorate: z.union([z.string(), z.number()]),
  wilayat: z.union([z.string(), z.number()]).optional().nullable(),
  area: z.union([z.string(), z.number()]),
  propertyType: z.union([z.string(), z.number()]),
  bedrooms: z.union([z.string(), z.number()]).optional().nullable(),
  bathrooms: z.union([z.string(), z.number()]).optional().nullable(),
  sizeSqm: z.union([z.string(), z.number()]),
  transactionType: z.union([z.string(), z.number()]),
  priceOMR: z.union([z.string(), z.number()]),
  rentPeriod: z.union([z.string(), z.number()]).optional().nullable(),
  furnished: z.union([z.string(), z.number()]).optional().nullable(),
  sourceType: z.union([z.string(), z.number()]),
  sourceName: z.union([z.string(), z.number()]),
  sourceRecordId: z.union([z.string(), z.number()]).optional().nullable(),
  sourceUrl: z.union([z.string(), z.number()]).optional().nullable(),
  observedAt: z.union([z.string(), z.number()]),
  metadata: z.union([z.string(), z.record(z.string(), z.unknown())]).optional().nullable()
});

function toNumber(value: unknown, field: string, code: ImportErrorCode): number {
  const n = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(n)) throw new RowValidationError(code, `"${field}" is not a valid number`);
  return n;
}

function normalizeRow(raw: unknown, rowIndex: number): { record: MarketRecordInput } | { error: string; code: ImportErrorCode } {
  const parsed = rawRowSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return {
      code: "INVALID_FORMAT",
      error: `row ${rowIndex}: ${first ? `${first.path.join(".") || "(row)"} — ${first.message}` : "does not match the expected column shape (unknown or missing fields)"}`
    };
  }
  const row = parsed.data;
  try {
    const governorate = sanitizeText(String(row.governorate), 60);
    const areaRaw = sanitizeText(String(row.area), 80);
    const canonicalArea = resolveAreaName(areaRaw);
    if (!canonicalArea) throw new RowValidationError("INVALID_AREA", `area "${areaRaw}" is not a recognized Muscat area (see SUPPORTED_MUSCAT_AREAS) — not imported rather than guessed at`);

    const propertyTypeRaw = String(row.propertyType).trim().toLowerCase();
    if (!(PROPERTY_TYPES as readonly string[]).includes(propertyTypeRaw)) throw new RowValidationError("INVALID_PROPERTY_TYPE", `propertyType "${row.propertyType}" must be one of ${PROPERTY_TYPES.join(", ")}`);
    const propertyType = propertyTypeRaw as PropertyType;

    const transactionTypeRaw = String(row.transactionType).trim().toLowerCase();
    const transactionType = TRANSACTION_TYPE_ALIASES[transactionTypeRaw];
    if (!transactionType) throw new RowValidationError("INVALID_TRANSACTION_TYPE", `transactionType "${row.transactionType}" must be one of rental, sale (or a recognized alias)`);

    // Section 6: "reject impossible or suspicious values" — tightened, application-level bounds
    // (independent of the much wider database CHECK constraints in marketSchema.ts, which remain a
    // last-resort safety net, not the primary validation). A residential unit outside its
    // property-type's plausible size band (SIZE_BOUNDS_BY_PROPERTY_TYPE, above) in this MVP's
    // supported Muscat areas is treated as a data-entry error, not a legitimate outlier, and
    // rejected rather than imported and later silently skewing comparable selection. Bounds are
    // per-property-type (not one generic range) because a plausible apartment size and a plausible
    // villa size are on very different scales — see SIZE_BOUNDS_BY_PROPERTY_TYPE's doc comment.
    const sizeSqm = toNumber(row.sizeSqm, "sizeSqm", "INVALID_SIZE");
    const sizeBounds = SIZE_BOUNDS_BY_PROPERTY_TYPE[propertyType];
    if (sizeSqm < sizeBounds.min || sizeSqm > sizeBounds.max) throw new RowValidationError("INVALID_SIZE", `sizeSqm must be between ${sizeBounds.min} and ${sizeBounds.max} for propertyType "${propertyType}" (values outside this range are rejected as implausible)`);
    const priceOMR = toNumber(row.priceOMR, "priceOMR", "INVALID_PRICE");
    if (!(priceOMR > 0)) throw new RowValidationError("INVALID_PRICE", "priceOMR must be a positive number");

    const bedroomsRaw = emptyToNull(row.bedrooms);
    const bedrooms = bedroomsRaw === null ? null : toNumber(bedroomsRaw, "bedrooms", "INVALID_BEDROOMS");
    if (bedrooms !== null && (bedrooms < 0 || bedrooms > 20 || !Number.isInteger(bedrooms))) throw new RowValidationError("INVALID_BEDROOMS", "bedrooms must be a whole number between 0 and 20");
    const bathroomsRaw = emptyToNull(row.bathrooms);
    const bathrooms = bathroomsRaw === null ? null : toNumber(bathroomsRaw, "bathrooms", "INVALID_BATHROOMS");
    if (bathrooms !== null && (bathrooms < 0 || bathrooms > 20 || !Number.isInteger(bathrooms))) throw new RowValidationError("INVALID_BATHROOMS", "bathrooms must be a whole number between 0 and 20");

    let rentPeriod: RentPeriod | null = null;
    const rentPeriodRaw = emptyToNull(row.rentPeriod);
    if (transactionType === "rental") {
      if (!rentPeriodRaw) throw new RowValidationError("INVALID_RENT_PERIOD", "rentPeriod is required when transactionType is rental");
      const resolved = RENT_PERIOD_ALIASES[rentPeriodRaw.trim().toLowerCase()];
      if (!resolved) throw new RowValidationError("INVALID_RENT_PERIOD", `rentPeriod "${rentPeriodRaw}" must be one of ${RENT_PERIODS.join(", ")} (or a recognized alias)`);
      rentPeriod = resolved;
    } else if (rentPeriodRaw) {
      throw new RowValidationError("INVALID_RENT_PERIOD", "rentPeriod must be blank when transactionType is sale");
    }

    // Section 6 (continued): plausible-price bounds depend on transaction type — a sale price and
    // a rental price live on entirely different scales, and a rental quoted annually must be
    // converted to its monthly equivalent before the bound is meaningful.
    if (transactionType === "sale") {
      if (priceOMR < 3_000 || priceOMR > 20_000_000) throw new RowValidationError("INVALID_PRICE", "priceOMR for a sale must be between 3,000 and 20,000,000 OMR (values outside this range are rejected as implausible)");
    } else {
      const monthlyEquivalent = rentPeriod === "annual" ? priceOMR / 12 : priceOMR;
      if (monthlyEquivalent < 30 || monthlyEquivalent > 15_000) throw new RowValidationError("INVALID_PRICE", "priceOMR for a rental must have a plausible monthly-equivalent value between 30 and 15,000 OMR (annual rents are converted to monthly before this check)");
    }

    let furnished: FurnishedStatus | null = null;
    const furnishedRaw = emptyToNull(row.furnished);
    if (furnishedRaw) {
      const resolved = FURNISHED_ALIASES[furnishedRaw.trim().toLowerCase()];
      if (!resolved) throw new RowValidationError("INVALID_FURNISHED", `furnished "${furnishedRaw}" must be one of ${FURNISHED_STATUSES.join(", ")} (or a recognized alias), or blank`);
      furnished = resolved;
    }

    const sourceTypeRaw = String(row.sourceType).trim().toLowerCase();
    if (!(SOURCE_TYPES as readonly string[]).includes(sourceTypeRaw)) throw new RowValidationError("INVALID_SOURCE_TYPE", `sourceType "${row.sourceType}" must be one of ${SOURCE_TYPES.join(", ")}`);
    const sourceType = sourceTypeRaw as SourceType;

    const sourceName = sanitizeText(String(row.sourceName), 200);
    if (!sourceName) throw new RowValidationError("INVALID_SOURCE_NAME", "sourceName is required");
    const sourceRecordId = row.sourceRecordId === undefined || row.sourceRecordId === null ? null : sanitizeText(String(row.sourceRecordId), 200) || null;
    const sourceUrlRaw = emptyToNull(row.sourceUrl);
    const sourceUrl = sourceUrlRaw ? sanitizeText(sourceUrlRaw, MAX_URL_LENGTH) : null;
    if (sourceUrl) { try { new URL(sourceUrl); } catch { throw new RowValidationError("INVALID_URL", `sourceUrl "${sourceUrl}" is not a valid URL`); } }

    const observedAtMs = Date.parse(String(row.observedAt));
    if (!Number.isFinite(observedAtMs)) throw new RowValidationError("INVALID_DATE", `observedAt "${row.observedAt}" is not a valid date`);
    if (observedAtMs > Date.now() + 86_400_000) throw new RowValidationError("INVALID_DATE", "observedAt cannot be more than a day in the future");
    if (observedAtMs < Date.parse("2000-01-01T00:00:00Z")) throw new RowValidationError("INVALID_DATE", "observedAt cannot be before the year 2000 (values this old are rejected as a data-entry error, not a legitimate historical record)");
    const observedAt = new Date(observedAtMs).toISOString();

    let metadata: Record<string, unknown> = {};
    if (row.metadata !== undefined && row.metadata !== null && row.metadata !== "") {
      if (typeof row.metadata === "string") {
        const trimmed = row.metadata.trim();
        if (trimmed.length > MAX_METADATA_JSON_LENGTH) throw new RowValidationError("INVALID_METADATA", `metadata exceeds ${MAX_METADATA_JSON_LENGTH} characters`);
        try {
          const parsedMetadata = JSON.parse(trimmed);
          if (parsedMetadata && typeof parsedMetadata === "object" && !Array.isArray(parsedMetadata)) metadata = parsedMetadata as Record<string, unknown>;
          else throw new RowValidationError("INVALID_METADATA", "metadata JSON must be an object");
        } catch (e) { if (e instanceof RowValidationError) throw e; throw new RowValidationError("INVALID_METADATA", "metadata is not valid JSON"); }
      } else {
        if (JSON.stringify(row.metadata).length > MAX_METADATA_JSON_LENGTH) throw new RowValidationError("INVALID_METADATA", `metadata exceeds ${MAX_METADATA_JSON_LENGTH} characters`);
        metadata = row.metadata as Record<string, unknown>;
      }
    }

    const wilayatRaw = emptyToNull(row.wilayat);
    const record: MarketRecordInput = {
      governorate, wilayat: wilayatRaw ? sanitizeText(wilayatRaw, 60) : null,
      area: areaRaw, normalizedArea: normalizeAreaText(canonicalArea),
      propertyType, bedrooms, bathrooms, sizeSqm,
      transactionType, priceOMR, rentPeriod, furnished,
      sourceType, sourceName, sourceRecordId, sourceUrl, observedAt, metadata
    };
    return { record };
  } catch (error) {
    const code = error instanceof RowValidationError ? error.code : "INVALID_FORMAT";
    return { error: `row ${rowIndex}: ${error instanceof Error ? error.message : String(error)}`, code };
  }
}

/**
 * Validates, normalizes and upserts a batch of raw rows (already parsed from CSV or JSON — see
 * parseCsv/parseJson below) through the given repository. Never throws on a bad row — every
 * failure is collected in `errors` with its 1-based row number, and the import proceeds with
 * whatever rows did validate (Phase 4: reject malformed records, not the whole file). Throws only
 * for a structural problem with the whole batch (too many rows).
 *
 * `options.partner`, when supplied, forcibly overwrites every accepted record's
 * partnerId/sourceType/sourceName with the given attribution — this is the ONLY way a record ever
 * gets attributed to a partner. A partner's own submitted CSV/JSON never carries a partnerId column
 * at all (see rawRowSchema above), so a partner can never spoof another partner's identity or
 * claim a provenance (e.g. "official_statistics") its feed hasn't earned; attribution always comes
 * from server-side authenticated context (the ingestion HTTP endpoint, src/api/marketDataRoutes.ts)
 * or an explicit operator-supplied CLI argument (src/marketImportCli.ts) for a bulk import run on a
 * partner's behalf — never from the row data itself.
 *
 * Also computes each accepted record's deterministic data-quality score (Section 7,
 * dataQualityScore.ts) after attribution is applied, since source identity (an authenticated
 * partner vs. an unattributed row) is itself one of the score's inputs.
 */
export async function importMarketRecords(rows: readonly unknown[], repository: PropertyMarketRepository, options: ImportOptions = {}): Promise<ImportResult> {
  if (rows.length > MAX_IMPORT_ROWS) throw new Error(`Import batch exceeds the maximum of ${MAX_IMPORT_ROWS} rows (got ${rows.length}); split the file and import in batches`);
  const errors: ImportRowError[] = [];
  const validated: { row: number; record: MarketRecordInput }[] = [];
  rows.forEach((row, index) => {
    const result = normalizeRow(row, index + 1);
    if ("error" in result) errors.push({ row: index + 1, code: result.code, reason: result.error });
    else validated.push({ row: index + 1, record: result.record });
  });

  const attributedList: { row: number; record: MarketRecordInput }[] = validated.map(({ row, record }) => ({
    row,
    record: options.partner
      ? { ...record, partnerId: options.partner.partnerId, sourceType: options.partner.sourceType, sourceName: options.partner.sourceName }
      : record
  }));

  // Section 6: DUPLICATE_RECORD — a row that is byte-for-byte identical (same (sourceName,
  // sourceRecordId) key AND every other field) to a LATER row in the same batch is redundant and
  // rejected outright, rather than written once and then immediately overwritten by its own
  // twin. Deliberately narrower than "shares a sourceRecordId": two rows sharing a sourceRecordId
  // but differing in content (e.g. a corrected price) remain a legitimate same-batch update, not
  // a duplicate — upsertMarketRecords()'s existing, tested "last one in a batch wins" semantics
  // for that case are completely unchanged.
  const byKey = new Map<string, { row: number; json: string }[]>();
  for (const entry of attributedList) {
    const key = entry.record.sourceRecordId ? `${entry.record.sourceName}::${entry.record.sourceRecordId}` : null;
    if (!key) continue;
    const list = byKey.get(key) ?? [];
    list.push({ row: entry.row, json: JSON.stringify(entry.record) });
    byKey.set(key, list);
  }
  const duplicateRows = new Set<number>();
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      if (group.slice(i + 1).some(g => g.json === group[i]!.json)) duplicateRows.add(group[i]!.row);
    }
  }
  for (const entry of attributedList) {
    if (duplicateRows.has(entry.row)) {
      errors.push({ row: entry.row, code: "DUPLICATE_RECORD", reason: `row ${entry.row}: duplicate of a later, identical row in this batch (same sourceRecordId and identical content) — not imported` });
    }
  }
  errors.sort((a, b) => a.row - b.row);

  const attributed: MarketRecordInput[] = attributedList
    .filter(entry => !duplicateRows.has(entry.row))
    .map(({ record }) => ({ ...record, dataQualityScore: computeDataQualityScore(record, { partnerId: record.partnerId ?? null }) }));

  const upsert: UpsertResult = attributed.length > 0 ? await repository.upsertMarketRecords(attributed) : { inserted: 0, updated: 0, skipped: 0 };
  const averageDataQualityScore = attributed.length > 0
    ? Math.round((attributed.reduce((sum, r) => sum + (r.dataQualityScore ?? 0), 0) / attributed.length) * 100) / 100
    : null;
  const latestObservedAt = attributed.length > 0
    ? attributed.reduce((latest, r) => (r.observedAt > latest ? r.observedAt : latest), attributed[0]!.observedAt)
    : null;
  return { totalRows: rows.length, imported: upsert.inserted, updated: upsert.updated, skipped: upsert.skipped, errors, averageDataQualityScore, latestObservedAt };
}

/** A minimal, dependency-free RFC4180-ish CSV parser: handles quoted fields (including embedded
 *  commas, newlines and escaped `""` quotes) and a header row that names each column. Good enough
 *  for the structured, machine-generated exports this pipeline targets — not a general-purpose
 *  spreadsheet importer. The first row is always treated as the header. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = "", row: string[] = [], inQuotes = false;
  const pushField = () => { row.push(field); field = ""; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false; }
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") pushField();
    else if (c === "\r") { /* ignore; \r\n handled by the \n branch */ }
    else if (c === "\n") pushRow();
    else field += c;
  }
  if (field.length > 0 || row.length > 0) pushRow();
  const nonEmptyRows = rows.filter(r => !(r.length === 1 && r[0] === ""));
  if (nonEmptyRows.length === 0) return [];
  const header = nonEmptyRows[0]!.map(h => h.trim());
  return nonEmptyRows.slice(1).map(cols => Object.fromEntries(header.map((h, i) => [h, (cols[i] ?? "").trim()])));
}

/** JSON import expects either a bare array of row objects, or `{ records: [...] }`. */
export function parseJsonRows(text: string): unknown[] {
  const parsed = JSON.parse(text);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { records?: unknown }).records)) return (parsed as { records: unknown[] }).records;
  throw new Error("JSON import file must be a top-level array of records, or an object with a top-level \"records\" array");
}

/**
 * Phase 10 (safe file paths / size limits): resolves `filePath` to an absolute path, checks it is
 * a real, appropriately-sized regular file before reading it whole, and dispatches to the CSV or
 * JSON parser by extension. Used by the CLI (src/marketImportCli.ts) and available to any other
 * programmatic caller — the file-safety checks live here exactly once, not duplicated per caller.
 */
export function loadImportRows(filePath: string): unknown[] {
  const absolute = resolvePath(filePath);
  const stat = statSync(absolute); // throws ENOENT for a missing/unreadable path — never swallowed
  if (!stat.isFile()) throw new Error(`${absolute} is not a regular file`);
  if (stat.size > MAX_IMPORT_FILE_BYTES) throw new Error(`${absolute} is ${stat.size} bytes, exceeding the ${MAX_IMPORT_FILE_BYTES}-byte import limit`);
  const ext = extname(absolute).toLowerCase();
  const text = readFileSync(absolute, "utf8");
  if (ext === ".csv") return parseCsv(text);
  if (ext === ".json") return parseJsonRows(text);
  throw new Error(`Unsupported import file extension "${ext}" — expected .csv or .json`);
}
