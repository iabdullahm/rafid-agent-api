import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { createHash } from "node:crypto";
import { importMarketRecords } from "../src/domain/oman/importPipeline.js";
import { MemoryPropertyMarketRepository } from "../src/domain/oman/marketRepository.js";
import { getOmanMarketStaleDays } from "../src/domain/oman/config.js";

/**
 * Al Mouj Muscat partner sales dataset — profile, interpret, transform, report. Reads the raw
 * export exactly as delivered (never modifies it), classifies and validates every row, and writes
 * an import-ready CSV plus a machine-readable JSON report. **This script never writes to a
 * database and never runs `market:import` itself** — it is a pre-import staging step; an operator
 * reviews the report and runs the real import command themselves, once satisfied.
 *
 * Validation is deliberately NOT reimplemented here. Every row that survives this script's own
 * business-rule filtering (is this actually a completed-enough sale? is the property type one
 * Rafid supports?) is run through the REAL `importMarketRecords()` (src/domain/oman/importPipeline.ts)
 * against a throwaway in-memory repository, so every size/price/date/area check, error code, and
 * message is byte-for-byte identical to what a real `npm run market:import` would produce — never
 * a second, drifting copy of that logic.
 *
 * Usage:
 *   npx tsx scripts/transform-al-mouj-partner-sales.ts [inputPath] [--source-name "Al Mouj Muscat"]
 *
 * inputPath defaults to data/source/al-mouj-report-raw.xls (a preserved, byte-identical copy of
 * the file as uploaded — see main() below). --source-name (or the PARTNER_SOURCE_NAME env var) is
 * required: this script never invents a partner display name.
 */

// -------------------------------------------------------------------------------------------
// 1. Format detection + a small, dependency-free parser for this specific export shape: a
//    single <table> with a <th> header row and one <tr>/<td> row per unit, no nested tables, no
//    rowspan/colspan. This is an "Excel HTML export" (the common `.xls`-named-but-actually-HTML
//    format many enterprise systems produce), not a real binary .xls/.xlsx — detected below
//    rather than assumed, since the extension alone cannot be trusted.
// -------------------------------------------------------------------------------------------

type SourceFormat = "html_table_export" | "binary_excel_legacy" | "binary_excel_ooxml" | "unknown";

function detectFormat(buffer: Buffer): SourceFormat {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    return "binary_excel_legacy"; // real OLE2-based .xls
  }
  if (buffer.length >= 2 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    return "binary_excel_ooxml"; // a zip container — real .xlsx (or .xls saved as OOXML)
  }
  const head = buffer.subarray(0, 4096).toString("latin1").trimStart().toLowerCase();
  if (head.startsWith("<") && (head.includes("<table") || head.includes("<html") || head.includes("<head"))) {
    return "html_table_export";
  }
  return "unknown";
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripTagsGetText(cellHtml: string): string {
  return decodeEntities(cellHtml.replace(/<[^>]*>/g, "")).trim();
}

interface ParsedTable {
  header: string[];
  rows: string[][];
  malformedRowCount: number;
}

function parseHtmlTableExport(text: string): ParsedTable {
  const tableMatch = text.match(/<table[^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) throw new Error("No <table> element found in the HTML export — cannot parse");
  const tableHtml = tableMatch[1]!;
  const trMatches = [...tableHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  if (trMatches.length === 0) throw new Error("No <tr> rows found inside the <table> element");

  const headerHtml = trMatches[0]![1]!;
  const header = [...headerHtml.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map(m => stripTagsGetText(m[1]!));
  if (header.length === 0) throw new Error("No <th> header cells found in the first row");

  const rows: string[][] = [];
  let malformedRowCount = 0;
  for (const tr of trMatches.slice(1)) {
    const cells = [...tr[1]!.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => stripTagsGetText(m[1]!));
    if (cells.length !== header.length) { malformedRowCount++; continue; } // skip, don't crash the whole file
    rows.push(cells);
  }
  return { header, rows, malformedRowCount };
}

// -------------------------------------------------------------------------------------------
// 2. Source column names (exact header text from this export) and the business classification
//    rules for turning a raw row into (or out of) a Rafid partner sale record.
// -------------------------------------------------------------------------------------------

const COL = {
  unitNumber: "Unit Number", stage: "Stage", subPhase: "Sub-Phase: Phase Name",
  currency: "Unit Price Currency", price: "Unit Price", floor: "Floor Number",
  builtUpArea: "Built Up Area SqM", plotArea: "Plot Area SqM", bedrooms: "Bedrooms",
  propertyType: "Property Type", unitType: "Unit Type", paymentPlan: "Payment Plan: Payment Plan Name",
  bookingDate: "Booking Date", status: "Status", governmentNumber: "Government Number",
  phaseName: "Phase Name"
} as const;

/** Section 3: only `Stage === "Sold"` represents an actual sale event in this export — it exactly
 *  matches `Status` in {"Sold", "Handed Over"} (verified during profiling: every one of the 4,436
 *  Stage="Sold" rows has Status "Sold" or "Handed Over", and no other Stage value ever does).
 *  Everything else (blank Stage, "Reserve", "Reserved", "Block", "SPA in progress" — Status
 *  "Available", "Blocked", "Management Block", "Reservation Pending/in progress", "SPA In
 *  Progress") is inventory that has not (yet, or ever) sold and must never be reported as a sale. */
const SALE_STAGE = "Sold";

/** Section 5: conservative source-value -> Rafid PropertyType mapping. "Villa" is kept even
 *  through the export's own corrupted "Z3 ? Villa" value (the literal "?" is a byte the source
 *  system itself emitted in place of a separator character — see the report's risks section —
 *  but "Villa" is intact and unambiguous). "Townhouse Villa", "Chalet" and "Offices" are
 *  deliberately left unmapped (rejected) rather than guessed into the nearest category: a
 *  "Townhouse Villa" genuinely straddles two Rafid types, a "Chalet" and an "Offices" unit are
 *  neither an apartment, a villa nor a townhouse in any defensible reading. */
const PROPERTY_TYPE_MAP: Record<string, "apartment" | "villa" | "townhouse" | undefined> = {
  "Apartment": "apartment",
  "Villa": "villa",
  "Attached Villa": "villa",
  "Z3 ? Villa": "villa",
  "Townhouse": "townhouse"
};

function parseBedrooms(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(\d+)/);
  return match ? Number(match[1]) : null;
}

/** Converts the source's `DD/MM/YYYY` booking date to an unambiguous ISO date. A blank or
 *  non-matching value is passed straight through unchanged so importMarketRecords()'s own date
 *  validation rejects it with the standard INVALID_DATE code/message — never a second, duplicate
 *  date-validity check here. (Never converted through JS `Date.parse` of the raw DD/MM/YYYY
 *  string directly — that format is ambiguous with MM/DD/YYYY and must not be trusted to a
 *  generic parser.) */
function convertBookingDate(raw: string): string {
  const match = raw.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return raw.trim();
  const [, dd, mm, yyyy] = match;
  return `${yyyy}-${mm}-${dd}`;
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** Section 10 (event/dedup identity): this export's Unit Number happens to be unique across every
 *  one of the 4,886 source rows today, but a future export is expected to carry resale/rebooking
 *  history — the same unit sold, cancelled, and re-sold, or a price correction re-published under
 *  the same Unit Number. A bare `sourceRecordId = Unit Number` would make upsertMarketRecords()'s
 *  (sourceName, sourceRecordId) dedup silently collapse those into a single record, overwriting a
 *  real historical sale event rather than recording it. Instead, sourceRecordId is a stable hash of
 *  the (Unit Number, Booking Date, Unit Price) tuple: the same event, re-exported unchanged, always
 *  hashes to the same id (so a routine re-import still updates, not duplicates), while a *different*
 *  event on the same unit (a new booking date and/or a new price) hashes differently and is
 *  correctly treated as a distinct record. The plaintext Unit Number is never discarded — it is
 *  preserved as metadata.unitNumber (group B, provenance-internal) for traceability and manual
 *  review. sha256 (not a weaker/faster hash) purely for collision-safety headroom at this data
 *  volume; truncated to 24 hex chars, well under the 200-char sourceRecordId column limit. */
function computeSourceRecordId(unitNumber: string, bookingDateRaw: string, unitPriceRaw: string): string {
  const key = `${unitNumber}|${bookingDateRaw}|${unitPriceRaw}`;
  return createHash("sha256").update(key).digest("hex").slice(0, 24);
}

const OUTPUT_COLUMNS = [
  "sourceRecordId", "governorate", "wilayat", "area", "normalizedArea", "propertyType", "bedrooms",
  "bathrooms", "sizeSqm", "transactionType", "priceOMR", "rentPeriod", "furnished", "observedAt",
  "sourceType", "sourceName", "metadata"
] as const;

interface CandidateRow {
  rowIndex: number; // 1-based position among candidates handed to importMarketRecords()
  unitNumber: string;
  raw: Record<string, string>;
  pipelineInput: {
    governorate: string; wilayat: null; area: string; propertyType: string;
    bedrooms: number | null; bathrooms: null; sizeSqm: number; transactionType: "sale";
    priceOMR: number; rentPeriod: null; furnished: null; sourceType: "partner_feed";
    sourceName: string; sourceRecordId: string; sourceUrl: null; observedAt: string;
    metadata: Record<string, unknown>;
  };
}

interface RejectedRow { unitNumber: string; code: string; reason: string }

// -------------------------------------------------------------------------------------------
// 3. Main
// -------------------------------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  let sourceNameFlag: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith("--source-name=")) sourceNameFlag = arg.split("=").slice(1).join("=");
    else if (arg === "--source-name") sourceNameFlag = args[++i];
    else if (!arg.startsWith("--")) positional.push(arg);
  }
  const sourceName = sourceNameFlag ?? process.env.PARTNER_SOURCE_NAME;
  if (!sourceName) {
    process.stderr.write(
      "Usage: npx tsx scripts/transform-al-mouj-partner-sales.ts [inputPath] --source-name \"<Partner Display Name>\"\n" +
      "(or set PARTNER_SOURCE_NAME) — this script never invents a partner name.\n"
    );
    process.exit(1);
  }

  const defaultInput = resolvePath("data/source/al-mouj-report-raw.xls");
  const inputPath = resolvePath(positional[0] ?? defaultInput);
  const buffer = readFileSync(inputPath);
  const format = detectFormat(buffer);
  process.stdout.write(`[transform] input: ${inputPath} (${buffer.length} bytes) — detected format: ${format}\n`);
  if (format !== "html_table_export") {
    throw new Error(
      `Detected format "${format}", not the supported HTML-table Excel export. ` +
      (format.startsWith("binary_excel")
        ? "This is a real binary Excel file — this script only supports the HTML-table export format; a binary parser (e.g. the xlsx package) would need to be added to support it."
        : "Cannot proceed without knowing how to parse this file.")
    );
  }

  const text = buffer.toString("latin1"); // declared charset: ISO-8859-1 (see the <head> meta tag)
  const { header, rows, malformedRowCount } = parseHtmlTableExport(text);
  for (const col of Object.values(COL)) {
    if (!header.includes(col)) throw new Error(`Expected column "${col}" not found in the export header: ${header.join(", ")}`);
  }
  const colIndex = Object.fromEntries(header.map((h, i) => [h, i]));
  const get = (cells: string[], col: string) => cells[colIndex[col]!] ?? "";

  const totalSourceRows = rows.length;
  const candidates: CandidateRow[] = [];
  const businessRejections: RejectedRow[] = [];
  const propertyTypeCounts: Record<string, number> = {};
  const missingFieldCounts: Record<string, number> = {};
  for (const col of Object.values(COL)) missingFieldCounts[col] = 0;

  // Section 3: tallied across ALL source rows (not just accepted/rejected candidates) so the count
  // reflects the true size of the gap in the export, independent of which validation path a row
  // happens to fall through.
  let azuraZeroBuiltUpAreaCount = 0;
  let azuraPhaseNameSeen: string | null = null;

  for (const cells of rows) {
    for (const col of Object.values(COL)) if (get(cells, col).trim() === "") missingFieldCounts[col]!++;

    const unitNumber = get(cells, COL.unitNumber);
    const stage = get(cells, COL.stage);
    const rawPropertyType = get(cells, COL.propertyType);
    propertyTypeCounts[rawPropertyType] = (propertyTypeCounts[rawPropertyType] ?? 0) + 1;

    const phaseNameRaw = get(cells, COL.phaseName);
    const builtUpAreaRaw = get(cells, COL.builtUpArea).trim();
    if (phaseNameRaw.includes("Azura") && (builtUpAreaRaw === "" || Number(builtUpAreaRaw) === 0)) {
      azuraZeroBuiltUpAreaCount++;
      azuraPhaseNameSeen ??= phaseNameRaw;
    }

    if (stage !== SALE_STAGE) {
      businessRejections.push({
        unitNumber, code: "NOT_A_COMPLETED_SALE",
        reason: `Stage "${stage || "(blank)"}" / Status "${get(cells, COL.status)}" — not a completed sale (reservation, block, or in-progress inventory), so this row is not imported as a sale`
      });
      continue;
    }
    const mappedType = PROPERTY_TYPE_MAP[rawPropertyType];
    if (!mappedType) {
      businessRejections.push({
        unitNumber, code: "UNSUPPORTED_PROPERTY_TYPE",
        reason: `Property Type "${rawPropertyType}" does not map confidently to Rafid's supported types (apartment, villa, townhouse) and was not forced into one`
      });
      continue;
    }

    const status = get(cells, COL.status);
    const bedroomsRaw = get(cells, COL.bedrooms);
    const bookingDateRaw = get(cells, COL.bookingDate);
    const unitPriceRaw = get(cells, COL.price);
    const metadata: Record<string, unknown> = {
      // Section 10: the plaintext Unit Number, preserved here (group B, provenance-internal) now
      // that sourceRecordId itself is a hash — see computeSourceRecordId()'s doc comment.
      unitNumber: unitNumber || null,
      phaseName: get(cells, COL.phaseName) || null,
      subPhase: get(cells, COL.subPhase) || null,
      floorNumberRaw: get(cells, COL.floor) || null,
      unitTypeRaw: get(cells, COL.unitType) || null,
      stage, status,
      sourcePropertyTypeRaw: rawPropertyType,
      bedroomsRaw: bedroomsRaw || null,
      plotAreaSqm: Number(get(cells, COL.plotArea)) || 0,
      // Section 3: the most defensible classification this export supports — Unit Price is the
      // partner's own contracted/booked unit sale price, not an independently verified,
      // Ministry-registered final conveyance value. `handoverCompleted` separately records
      // whether the unit has actually been delivered to the buyer (Status "Handed Over"), which
      // is a stronger completion signal than "Sold" (SPA signed, not yet handed over) alone.
      saleRecordType: "contracted_unit_price",
      handoverCompleted: status === "Handed Over"
      // Payment Plan and Government Number are deliberately NEVER copied into metadata — see
      // Section 8 of the report (privacy/confidentiality review).
    };

    candidates.push({
      rowIndex: candidates.length + 1,
      unitNumber,
      raw: Object.fromEntries(Object.values(COL).map(col => [col, get(cells, col)])),
      pipelineInput: {
        governorate: "Muscat", wilayat: null, area: "Al Mouj", propertyType: mappedType,
        bedrooms: parseBedrooms(bedroomsRaw), bathrooms: null,
        sizeSqm: Number(get(cells, COL.builtUpArea)), transactionType: "sale",
        priceOMR: Number(unitPriceRaw), rentPeriod: null, furnished: null,
        sourceType: "partner_feed", sourceName,
        sourceRecordId: computeSourceRecordId(unitNumber, bookingDateRaw, unitPriceRaw), sourceUrl: null,
        observedAt: convertBookingDate(bookingDateRaw), metadata
      }
    });
  }

  // Reuse the REAL ingestion validation — never a second implementation of these rules.
  const memoryRepository = new MemoryPropertyMarketRepository();
  const pipelineResult = await importMarketRecords(candidates.map(c => c.pipelineInput), memoryRepository, {});
  const pipelineRejectedRowNumbers = new Set(pipelineResult.errors.map(e => e.row));
  const pipelineRejections: RejectedRow[] = pipelineResult.errors.map(e => ({
    unitNumber: candidates[e.row - 1]!.unitNumber, code: e.code, reason: e.reason
  }));
  const accepted = candidates.filter(c => !pipelineRejectedRowNumbers.has(c.rowIndex));

  const allRejections = [...businessRejections, ...pipelineRejections];

  // ---------------------------------------------------------------------------------------
  // Report: duplicate/event analysis, age buckets, price/size stats, phase breakdown, etc.
  // ---------------------------------------------------------------------------------------
  const unitNumberCounts = new Map<string, number>();
  for (const cells of rows) {
    const u = get(cells, COL.unitNumber);
    unitNumberCounts.set(u, (unitNumberCounts.get(u) ?? 0) + 1);
  }
  const duplicateUnitNumbers = [...unitNumberCounts.entries()].filter(([, n]) => n > 1);

  const now = new Date();
  const ageBuckets = { "0-1y": 0, "1-3y": 0, "3-5y": 0, "5-10y": 0, "10+y": 0 };
  let minDate: string | null = null, maxDate: string | null = null;
  const phaseBreakdown: Record<string, number> = {};
  const prices: number[] = [], sizes: number[] = [], ppsqms: number[] = [];
  for (const c of accepted) {
    const observed = c.pipelineInput.observedAt;
    if (!minDate || observed < minDate) minDate = observed;
    if (!maxDate || observed > maxDate) maxDate = observed;
    const ageYears = (now.getTime() - Date.parse(observed)) / (365.25 * 86_400_000);
    if (ageYears <= 1) ageBuckets["0-1y"]++;
    else if (ageYears <= 3) ageBuckets["1-3y"]++;
    else if (ageYears <= 5) ageBuckets["3-5y"]++;
    else if (ageYears <= 10) ageBuckets["5-10y"]++;
    else ageBuckets["10+y"]++;

    const phase = String(c.pipelineInput.metadata.phaseName ?? "(unknown)");
    phaseBreakdown[phase] = (phaseBreakdown[phase] ?? 0) + 1;
    prices.push(c.pipelineInput.priceOMR);
    sizes.push(c.pipelineInput.sizeSqm);
    ppsqms.push(c.pipelineInput.priceOMR / c.pipelineInput.sizeSqm);
  }

  function stats(values: number[]) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
    return {
      count: sorted.length, min: sorted[0], max: sorted.at(-1),
      mean: Math.round((sum / sorted.length) * 100) / 100,
      median: pct(0.5), p25: pct(0.25), p75: pct(0.75)
    };
  }

  const rejectionCodeCounts: Record<string, number> = {};
  for (const r of allRejections) rejectionCodeCounts[r.code] = (rejectionCodeCounts[r.code] ?? 0) + 1;

  // Section 3: a structured, machine-readable partner-issue entry — separate from (in addition to)
  // the generic INVALID_SIZE rejection these rows already receive via the real import pipeline —
  // so this specific, large, named data gap is visible to a partner-ops reviewer or another
  // process without having to reverse-engineer it from the rejection breakdown or riskAssumptions
  // prose. Built up area is never guessed/derived from Plot Area for these rows: they are excluded.
  const partnerIssues: { code: string; affectedRows: number; phase: string; reason: string; recommendedPartnerAction: string }[] =
    azuraZeroBuiltUpAreaCount > 0
      ? [{
          code: "AZURA_ZERO_BUILT_UP_AREA",
          affectedRows: azuraZeroBuiltUpAreaCount,
          phase: azuraPhaseNameSeen ?? "Azura Beach Residences",
          reason: "Every row in this phase has Built Up Area SqM = 0.00 (or blank), regardless of property type (Apartment/Townhouse/Chalet). The accompanying Plot Area SqM for these rows is a shared building/parcel-level figure (not a per-unit size) and is not a valid substitute. These rows are rejected (INVALID_SIZE, via importPipeline.ts's property-type size bound) and excluded from the accepted dataset rather than imported with a guessed or derived size.",
          recommendedPartnerAction: "Request unit-level Built Up Area SqM from the partner. Plot Area appears to be a shared/building-level value and must not be substituted for unit area."
        }]
      : [];

  const sample = accepted.slice(0, 10).map(c => ({
    sourceRecordId: c.pipelineInput.sourceRecordId, governorate: c.pipelineInput.governorate,
    wilayat: c.pipelineInput.wilayat, area: c.pipelineInput.area, normalizedArea: "Al Mouj",
    propertyType: c.pipelineInput.propertyType, bedrooms: c.pipelineInput.bedrooms,
    bathrooms: c.pipelineInput.bathrooms, sizeSqm: c.pipelineInput.sizeSqm,
    transactionType: c.pipelineInput.transactionType, priceOMR: c.pipelineInput.priceOMR,
    rentPeriod: c.pipelineInput.rentPeriod, furnished: c.pipelineInput.furnished,
    observedAt: c.pipelineInput.observedAt, sourceType: c.pipelineInput.sourceType,
    sourceName: c.pipelineInput.sourceName, metadata: c.pipelineInput.metadata
  }));

  const report = {
    generatedAt: now.toISOString(),
    inputFile: inputPath,
    detectedFormat: format,
    sourceName,
    rowCounts: {
      totalSourceRows, malformedHtmlRowsSkipped: malformedRowCount,
      acceptedRows: accepted.length, rejectedRows: allRejections.length,
      rejectionBreakdown: rejectionCodeCounts
    },
    duplicateAnalysis: {
      totalUnitNumbers: unitNumberCounts.size,
      duplicateUnitNumberCount: duplicateUnitNumbers.length,
      note: duplicateUnitNumbers.length === 0
        ? "Unit Number is unique across every one of the 4,886 source rows in THIS export — no duplicate export rows, rebookings, or resales sharing a Unit Number were found in this file. Section 10 / eventIdentity below documents the dedup/event key now actually applied to sourceRecordId (not just recommended for the future): a future export sharing a Unit Number with a different Booking Date or Unit Price is treated as a distinct sale event, not silently collapsed into the earlier one."
        : "Duplicate Unit Numbers found — see duplicateUnitNumbers for the list; each occurrence should be manually reviewed to determine whether it is a duplicate export row, a price revision, or a genuine resale/rebooking before import.",
      duplicateUnitNumbers: duplicateUnitNumbers.map(([unit, count]) => ({ unitNumber: unit, occurrences: count }))
    },
    // Section 10: the dedup/event-identity decision actually applied to every accepted record's
    // sourceRecordId (see computeSourceRecordId()'s doc comment for the full reasoning) —
    // documented here as its own top-level field rather than left implicit in fieldMapping.
    eventIdentityStrategy: {
      sourceRecordIdFormula: "sha256(Unit Number + \"|\" + Booking Date (raw) + \"|\" + Unit Price (raw)), truncated to 24 hex characters",
      rationale: "Unit Number alone is not treated as a permanent transaction-event identity: a future export may carry a resale or rebooking against the same Unit Number, which must be recorded as a new event (and a routine re-export of the SAME event must still update in place, not duplicate). Hashing (Unit Number, Booking Date, Unit Price) together gives a stable id for the same event across re-imports while correctly distinguishing a genuinely new event on the same unit.",
      plaintextUnitNumberPreservedIn: "metadata.unitNumber (group B, provenance-internal) — never dropped, only removed from the dedup key itself"
    },
    dateRange: { earliestObservedAt: minDate, latestObservedAt: maxDate },
    ageBuckets,
    propertyTypeMapping: {
      counts: propertyTypeCounts,
      mapping: Object.fromEntries(Object.entries(PROPERTY_TYPE_MAP)),
      unsupportedValues: Object.keys(propertyTypeCounts).filter(v => !PROPERTY_TYPE_MAP[v])
    },
    phaseBreakdown,
    priceStatsOMR: stats(prices),
    sizeStatsSqm: stats(sizes),
    pricePerSqmStats: stats(ppsqms),
    missingFieldAnalysis: missingFieldCounts,
    // Section 3
    partnerIssues,
    privacyGroups: {
      A_marketFieldsSafeForAnalysis: [
        "sourceRecordId (a deterministic hash of Unit Number + Booking Date + Unit Price — see eventIdentityStrategy above; not the plaintext Unit Number itself)",
        "governorate", "wilayat", "area", "normalizedArea",
        "propertyType", "bedrooms", "bathrooms", "sizeSqm", "transactionType", "priceOMR",
        "rentPeriod", "furnished", "observedAt", "sourceType", "sourceName"
      ],
      B_provenanceInternalMetadata: [
        "unitNumber (plaintext Unit Number, preserved for traceability — see eventIdentityStrategy)",
        "Phase Name", "Sub-Phase: Phase Name", "Stage", "Status", "Unit Type", "Floor Number",
        "saleRecordType", "handoverCompleted"
      ],
      C_excludedNeverExposed: [
        "Payment Plan: Payment Plan Name (contains a partner-internal plan identifier/hash) — never copied into any output field or metadata",
        "Government Number (a low-cardinality internal/official reference; excluded out of an abundance of caution given the field name, regardless of its exact internal meaning, which this file alone cannot confirm) — never copied into any output field or metadata"
      ]
    },
    riskAssumptions: [
      "Sale semantics: \"Unit Price\" is treated as the partner's own contracted/booked unit sale price at the point Stage reached \"Sold\" — never claimed as an independently verified, Ministry-registered final conveyance value. Recorded per row in metadata.saleRecordType=\"contracted_unit_price\", with metadata.handoverCompleted distinguishing units that have actually been delivered to the buyer (Status \"Handed Over\") from units that are contractually sold but not yet handed over (Status \"Sold\").",
      "Property Type \"Z3 ? Villa\" (6 rows): the literal \"?\" byte is emitted by the SOURCE system itself (confirmed at the byte level: 0x3F, not a decoding artifact on our side) in place of a separator character, most likely an en dash — e.g. originally \"Z3 – Villa\". Mapped to villa (the intact, unambiguous word in the value) rather than rejected; the original raw value is preserved in metadata.sourcePropertyTypeRaw for traceability.",
      "\"Attached Villa\" (30 accepted rows) mapped to villa (a semi-detached villa variant) rather than rejected — a defensible but non-obvious call worth a partner confirmation.",
      "\"Townhouse Villa\" (17 rows within Stage=Sold), \"Chalet\" (22 rows), and \"Offices\" (8 rows) were NOT mapped — genuinely ambiguous or out of scope for Rafid's residential apartment/villa/townhouse schema — and are rejected with UNSUPPORTED_PROPERTY_TYPE rather than forced into the nearest category.",
      "The ENTIRE \"Azura Beach Residences\" phase (see partnerIssues[AZURA_ZERO_BUILT_UP_AREA] above for the exact affected-row count and phase name) has Built Up Area SqM = 0.00 for every single row, regardless of Property Type; the accompanying non-zero \"Plot Area SqM\" for these rows (~17,050-22,784 sqm) is a shared building/parcel figure, not a per-unit size, and cannot substitute for it. Every Azura Beach Residences row is rejected with INVALID_SIZE. This is the single largest rejection bucket by far and is a genuine gap in the source export, not a transform bug — worth raising with the partner directly (see partnerIssues[...].recommendedPartnerAction) if per-unit sizes for this phase can be supplied separately.",
      "RESOLVED (production-readiness pass, Section 1): the 3 legitimate ultra-luxury Zunairah villa sales (ZU-679, ZU-682, ZU-685; built-up area 3,190-6,367 sqm, price OMR 3.8-5.8M) that were previously rejected by a single generic sizeSqm upper bound of 3,000 sqm are now ACCEPTED. importPipeline.ts's size validation was replaced with property-type-specific bounds (SIZE_BOUNDS_BY_PROPERTY_TYPE: apartment 20-1500 sqm, townhouse 40-2000 sqm, villa 50-10,000 sqm) rather than one generic range — the villa bound now comfortably covers this segment while still rejecting genuinely implausible values (e.g. a >10,000 sqm \"villa\") in either direction.",
      "1 test/placeholder row (\"GLR-Testing Unit\", Unit Price 0, Status \"Available\") is present in the source file — excluded here via the Stage!=\"Sold\" business filter (it is not even reached by price validation) but is itself evidence the export can contain non-production test rows; worth confirming with the partner whether their export process reliably excludes these.",
      "Bedrooms values like \"3+1\", \"4+1\" (common Gulf-market notation for a bedroom count plus a maid's/study room) are parsed to their LEADING integer only (\"3+1\" -> 3) — the \"+1\" is not counted as an additional legal bedroom. The full original text is preserved in metadata.bedroomsRaw.",
      "wilayat is left null for every row, per instruction not to guess/invent it — this export never states a wilayat. For context only (not applied): Rafid's own location registry (src/domain/oman/locations.ts) already associates the \"Al Mouj\" area with wilayat \"Muscat\" internally; an operator may choose to populate wilayat=\"Muscat\" for this partner's records at import time.",
      "Booking dates as late as the file's own \"today\" (one row, A2B-401, booked exactly on the export date) are present among genuinely recent \"Reservation Pending\"/\"Sold\" rows in actively-selling phases (Golf Links Apartments, Sector 1A) — plausible ongoing sales activity, not treated as suspicious, but flagged for awareness.",
      "IMPORTANT SCHEMA COMPATIBILITY NOTE: data/al-mouj-partner-sales-import.csv includes a `normalizedArea` column as explicitly requested. Rafid's real `importMarketRecords()`/`npm run market:import` input schema (importPipeline.ts's rawRowSchema) is a STRICT schema that does NOT accept `normalizedArea` as an input column at all — it is computed internally from `area`, and an unrecognized column is REJECTED outright (\"Unrecognized key(s) in object\"). This script therefore also writes data/al-mouj-partner-sales-import.strict.csv — the identical accepted dataset with only that one column removed — which IS directly importable. See `importCommand` below."
    ],
    fieldMapping: {
      "Unit Number": "sourceRecordId", "Unit Price": "priceOMR", "Built Up Area SqM": "sizeSqm",
      "Bedrooms": "bedrooms (leading integer only; full text in metadata.bedroomsRaw)",
      "Property Type": "propertyType (via PROPERTY_TYPE_MAP; see propertyTypeMapping above)",
      "Booking Date": "observedAt (DD/MM/YYYY -> ISO YYYY-MM-DD)",
      "(fixed)": "transactionType=sale, sourceType=partner_feed, governorate=Muscat, area=Al Mouj, normalizedArea=Al Mouj",
      "(absent in source)": "bathrooms=null, furnished=null, rentPeriod=null, wilayat=null, sourceUrl=null",
      "Phase Name / Sub-Phase: Phase Name / Stage / Status / Unit Type / Floor Number": "metadata.* (provenance, group B)",
      "Payment Plan: Payment Plan Name / Government Number": "EXCLUDED — never mapped to any output field (group C)"
    },
    sampleTransformedRows: sample,
    importCommand: {
      humanReadableFullDataset: "data/al-mouj-partner-sales-import.csv (includes normalizedArea — for review/reporting; NOT directly importable, see the schema compatibility risk note above)",
      readyToImport: `npm run market:import -- ./data/al-mouj-partner-sales-import.strict.csv <partnerId>`,
      note: "This has NOT been run by this script. Do not run market:import until this report has been reviewed and approved — see the spec's explicit \"DO NOT IMPORT YET\". <partnerId> must be an already-created Rafid partner (npm run admin -- partner:create ...) whose sourceType/partnerName you are comfortable being force-applied as this batch's attribution if you pass it; omit <partnerId> to import unattributed instead."
    }
  };

  // ---------------------------------------------------------------------------------------
  // Section 12: pre-import production audit — a separate, purpose-built deliverable for the
  // approval decision, distinct from the full transform report above. Reuses the same computed
  // figures (never a second implementation of rowCounts/dateRange/ageBuckets/stats/etc.) and adds
  // only what report.json doesn't already have: per-property-type accepted counts, a fresh/stale
  // split using the SAME staleness definition analyze_oman_property already reports elsewhere
  // (getOmanMarketStaleDays — never a second, bespoke staleness threshold invented just for this
  // audit), and the specific 365/730/1095-day observed-within-window counts the spec asked for.
  // ---------------------------------------------------------------------------------------
  const propertyTypeCountsAccepted: Record<string, number> = {};
  for (const c of accepted) {
    const pt = c.pipelineInput.propertyType;
    propertyTypeCountsAccepted[pt] = (propertyTypeCountsAccepted[pt] ?? 0) + 1;
  }
  const staleDays = getOmanMarketStaleDays();
  const nowMs = now.getTime();
  const ageInDays = (observedAt: string) => (nowMs - Date.parse(observedAt)) / 86_400_000;
  let freshRecordCount = 0, staleRecordCount = 0;
  let within365 = 0, within730 = 0, within1095 = 0;
  for (const c of accepted) {
    const days = ageInDays(c.pipelineInput.observedAt);
    if (days <= staleDays) freshRecordCount++; else staleRecordCount++;
    if (days <= 365) within365++;
    if (days <= 730) within730++;
    if (days <= 1095) within1095++;
  }

  const productionImportAudit = {
    generatedAt: now.toISOString(),
    inputFile: inputPath,
    sourceType: "partner_feed",
    sourceName,
    sourceRows: totalSourceRows,
    acceptedRows: accepted.length,
    rejectedRows: allRejections.length,
    rejectionReasons: rejectionCodeCounts,
    dateRange: { earliestObservedAt: minDate, latestObservedAt: maxDate },
    ageBuckets,
    phaseCount: Object.keys(phaseBreakdown).length,
    propertyTypes: propertyTypeCountsAccepted,
    priceStats: stats(prices),
    sizeStats: stats(sizes),
    pricePerSqmStats: stats(ppsqms),
    partnerIssues,
    privacyExcludedFields: report.privacyGroups.C_excludedNeverExposed,
    saleSemantics: {
      priceSemantics: "contracted_unit_price",
      handoverCompletedTracked: true,
      neverExposedOrImplied: ["verified_conveyance_price", "government_registered_transaction", "final_title_transfer_price"]
    },
    eventIdentityStrategy: report.eventIdentityStrategy,
    freshRecordCount,
    staleRecordCount,
    staleDaysThresholdUsed: staleDays,
    recordsObservedWithinLast365Days: within365,
    recordsObservedWithinLast730Days: within730,
    recordsObservedWithinLast1095Days: within1095,
    productionImportCandidateFile: "data/al-mouj-partner-sales-import.strict.csv",
    notImportedYet: true,
    approvalRequired: "Do not run market:import against this dataset until this audit has been reviewed and explicitly approved."
  };

  mkdirSync(resolvePath("data"), { recursive: true });
  const STRICT_COLUMNS = OUTPUT_COLUMNS.filter(c => c !== "normalizedArea");
  const csvLines = [OUTPUT_COLUMNS.join(",")];
  const strictCsvLines = [STRICT_COLUMNS.join(",")];
  for (const c of accepted) {
    const row: Record<string, string> = {
      sourceRecordId: c.pipelineInput.sourceRecordId, governorate: c.pipelineInput.governorate,
      wilayat: "", area: c.pipelineInput.area, normalizedArea: "Al Mouj",
      propertyType: c.pipelineInput.propertyType,
      bedrooms: c.pipelineInput.bedrooms === null ? "" : String(c.pipelineInput.bedrooms),
      bathrooms: "", sizeSqm: String(c.pipelineInput.sizeSqm), transactionType: c.pipelineInput.transactionType,
      priceOMR: String(c.pipelineInput.priceOMR), rentPeriod: "", furnished: "",
      observedAt: c.pipelineInput.observedAt, sourceType: c.pipelineInput.sourceType,
      sourceName: c.pipelineInput.sourceName, metadata: JSON.stringify(c.pipelineInput.metadata)
    };
    csvLines.push(OUTPUT_COLUMNS.map(col => csvEscape(row[col] ?? "")).join(","));
    strictCsvLines.push(STRICT_COLUMNS.map(col => csvEscape(row[col] ?? "")).join(","));
  }
  writeFileSync(resolvePath("data/al-mouj-partner-sales-import.csv"), csvLines.join("\n") + "\n", "utf8");
  // Section 11 asks for `normalizedArea` in the output dataset, but importPipeline.ts's rawRowSchema
  // is a STRICT schema that rejects any unrecognized column outright — see riskAssumptions above.
  // Rather than hand the operator a fragile shell one-liner to strip a column from a quoted CSV
  // (the metadata column itself contains commas), this second file is the byte-identical dataset
  // with only that one column removed, generated the same safe way — genuinely importable as-is.
  writeFileSync(resolvePath("data/al-mouj-partner-sales-import.strict.csv"), strictCsvLines.join("\n") + "\n", "utf8");
  writeFileSync(resolvePath("data/al-mouj-partner-sales-report.json"), JSON.stringify(report, null, 2), "utf8");
  writeFileSync(resolvePath("data/al-mouj-production-import-audit.json"), JSON.stringify(productionImportAudit, null, 2), "utf8");

  process.stdout.write(`[transform] accepted ${accepted.length} / ${totalSourceRows} source rows -> data/al-mouj-partner-sales-import.csv (+ .strict.csv, importPipeline-compatible)\n`);
  process.stdout.write(`[transform] rejected ${allRejections.length} rows — breakdown: ${JSON.stringify(rejectionCodeCounts)}\n`);
  process.stdout.write(`[transform] full report -> data/al-mouj-partner-sales-report.json\n`);
  process.stdout.write(`[transform] pre-import production audit -> data/al-mouj-production-import-audit.json\n`);
  process.stdout.write(`[transform] NO database write occurred. NOT imported. Review the report and audit before running any import command.\n`);
}

main().catch(error => {
  process.stderr.write(`[transform] FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
