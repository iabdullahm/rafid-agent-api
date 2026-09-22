import assert from "node:assert/strict";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { parseXlsxWorkbook, type XlsxRow } from "../src/business-data/sources/xlsxReader.js";
import {
  generateCardifySourceRecordId, classifyCardifyTaxRow, detectCardifyDuplicates,
  importCardifyWorkbook, DEFAULT_CARDIFY_SOURCE_NAME,
  type CardifyCompanyRow, type CardifySourceRow, type CardifyTaxVerificationRow
} from "../src/business-data/sources/cardifyOmanBusinessIndexProvider.js";
import { MemoryCompanyRepository, type CompanyRecordInput } from "../src/business-data/sources/companyRepository.js";
import { buildCompanyViews } from "../src/business-data/admin/adminService.js";
import type { ParsedXlsxWorkbook } from "../src/business-data/sources/xlsxReader.js";

// ---------------------------------------------------------------------------------------------
// A tiny, self-contained .xlsx BUILDER for these tests — the mirror image of xlsxReader.ts's
// parser, using only STORED (uncompressed) ZIP entries so it needs no compression library beyond
// what xlsxReader.ts itself already exercises via inflateEntry's DEFLATE branch (tested separately
// below with a real deflated entry). Keeps the test suite fixture-file-free (no binary workbook
// checked into the repo — the real uploaded workbook contains real company names, which does not
// belong in the git history) while still exercising the real ZIP + SpreadsheetML parsing path, not
// a mocked one.
// ---------------------------------------------------------------------------------------------

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function columnLetter(index: number): string {
  let n = index + 1, s = "";
  while (n > 0) { const rem = (n - 1) % 26; s = String.fromCharCode(65 + rem) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function buildSheetXml(headers: readonly string[], rows: readonly (readonly (string | number | null)[])[]): string {
  const headerRow = `<row r="1">${headers.map((h, i) => `<c r="${columnLetter(i)}1" t="inlineStr"><is><t>${xmlEscape(h)}</t></is></c>`).join("")}</row>`;
  const dataRows = rows.map((row, rIdx) => {
    const cells = row.map((value, cIdx) => {
      const ref = `${columnLetter(cIdx)}${rIdx + 2}`;
      if (value === null || value === "") return `<c r="${ref}"/>`;
      if (typeof value === "number") return `<c r="${ref}"><v>${value}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
    }).join("");
    return `<row r="${rIdx + 2}">${cells}</row>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${headerRow}${dataRows}</sheetData></worksheet>`;
}

interface TestSheet { name: string; headers: readonly string[]; rows: readonly (readonly (string | number | null)[])[] }

/** Builds a minimal, valid .xlsx as an in-memory Buffer from {name, headers, rows}[] — every sheet
 *  a STORED (compressionMethod 0) ZIP entry, except the first, written DEFLATEd, so the suite
 *  exercises xlsxReader.ts's inflateEntry DEFLATE branch at least once. */
function buildTestXlsx(sheets: readonly TestSheet[]): Buffer {
  const workbookXml = `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheets>${
    sheets.map((s, i) => `<sheet xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" name="${xmlEscape(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")
  }</sheets></workbook>`;
  const relsXml = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
    sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet${i + 1}.xml"/>`).join("")
  }</Relationships>`;

  const entries: { name: string; content: Buffer; deflate: boolean }[] = [
    { name: "xl/workbook.xml", content: Buffer.from(workbookXml, "utf8"), deflate: true },
    { name: "xl/_rels/workbook.xml.rels", content: Buffer.from(relsXml, "utf8"), deflate: false },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, content: Buffer.from(buildSheetXml(s.headers, s.rows), "utf8"), deflate: false }))
  ];

  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const data = entry.deflate ? deflateRawSync(entry.content) : entry.content;
    const method = entry.deflate ? 8 : 0;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0, 6); // flags
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10); // mod time
    localHeader.writeUInt16LE(0, 12); // mod date
    localHeader.writeUInt32LE(0, 14); // crc32 (unchecked by our reader)
    localHeader.writeUInt32LE(data.length, 18); // compressed size
    localHeader.writeUInt32LE(entry.content.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra length
    localParts.push(localHeader, nameBuf, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed
    centralHeader.writeUInt16LE(0, 8); // flags
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12); // mod time
    centralHeader.writeUInt16LE(0, 14); // mod date
    centralHeader.writeUInt32LE(0, 16); // crc32
    centralHeader.writeUInt32LE(data.length, 20); // compressed size
    centralHeader.writeUInt32LE(entry.content.length, 24); // uncompressed size
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra length
    centralHeader.writeUInt16LE(0, 32); // comment length
    centralHeader.writeUInt16LE(0, 34); // disk number
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE(0, 38); // external attrs
    centralHeader.writeUInt32LE(offset, 42); // local header offset
    centralParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + data.length;
  }

  const localSection = Buffer.concat(localParts);
  const centralSection = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSection.length, 12);
  eocd.writeUInt32LE(localSection.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localSection, centralSection, eocd]);
}

// ---------------------------------------------------------------------------------------------
// A small, realistic 3-company Cardify-shaped workbook used across most tests below.
// ---------------------------------------------------------------------------------------------

const COMPANY_HEADERS = [
  "company_id", "company_name", "company_name_ar", "company_name_en", "normalized_name", "cr_number",
  "legal_type", "company_status", "registration_date", "industry", "activities", "governorate",
  "wilayat", "area", "address", "website", "business_email", "business_phone", "vat_number",
  "tax_verification_status", "registered_supplier", "supplier_category", "supplier_classification",
  "tenders_participated", "award_count", "known_government_buyers", "latest_award_date",
  "latest_tender_activity", "verification_status", "confidence", "last_verified_at", "notes"
];
const SOURCE_HEADERS = ["company_id", "company_name", "field_or_category", "source_name", "source_type", "source_url", "source_record_id", "observed_at", "verification_status", "source_authority", "notes"];
const TAX_HEADERS = ["company_id", "company_name", "cr_number", "vat_number", "tax_verification_status", "verified_at", "source_name", "source_url", "notes"];
const PROCUREMENT_HEADERS = ["company_id", "company_name", "registered_supplier", "supplier_category", "supplier_classification", "tenders_participated", "known_government_buyers", "last_tender_activity", "source_name", "source_url", "observed_at"];
const AWARD_HEADERS = ["company_id", "company_name", "tender_number", "buyer", "title", "category", "award_value_omr", "award_date", "source_name", "source_url", "observed_at"];

function sampleWorkbook(overrides: { companies?: readonly (readonly (string | number | null)[])[]; sources?: readonly (readonly (string | number | null)[])[]; tax?: readonly (readonly (string | number | null)[])[]; procurement?: readonly (readonly (string | number | null)[])[]; awards?: readonly (readonly (string | number | null)[])[] } = {}): ParsedXlsxWorkbook {
  const companies = overrides.companies ?? [
    // company_id, company_name, name_ar, name_en, normalized_name(bogus), cr, legal_type, status, reg_date, industry, activities, governorate, wilayat, area, address, website, email, phone, vat, tax_status, reg_supplier, cat, class, tenders, awards, buyers, latest_award, latest_tender, verification_status, confidence, last_verified_at, notes
    ["OMBI-0001", "AL NOOR TRADING (L.L.C.)", "النور للتجارة", "AL NOOR TRADING (L.L.C.)", "BOGUS NAME", null, "LLC", null, null, "Trading", null, "Muscat", null, null, null, null, null, null, null, "unknown", null, null, null, null, null, null, null, null, "reported", 0.55, "2026-09-21", "note"],
    ["OMBI-0002", "SALALAH FISHERIES CO SAOC", "مصائد صلالة", "SALALAH FISHERIES CO SAOC", "BOGUS", null, "SAOC", null, null, "Food & Beverage", null, "Dhofar", null, null, null, null, null, null, null, "unknown", null, null, null, null, null, null, null, null, "reported", 0.55, "2026-09-21", "note"],
    ["OMBI-0003", "WUSTA MINERALS SPC", "معادن الوسطى", "WUSTA MINERALS SPC", "BOGUS", null, "SPC", null, null, "Mining", null, "Al Wusta", null, null, null, null, null, null, null, "unknown", null, null, null, null, null, null, null, null, "reported", 0.55, "2026-09-21", "note"]
  ];
  const sources = overrides.sources ?? [
    ["OMBI-0001", "AL NOOR TRADING (L.L.C.)", "identity; governorate", "Cardify Oman Business Index", "public_directory", "https://cardify.om/companies?page=3", "page-3", "2026-09-21", "reported", 0.5, "note"],
    ["OMBI-0002", "SALALAH FISHERIES CO SAOC", "identity; governorate", "Cardify Oman Business Index", "public_directory", "https://cardify.om/companies?page=3", "page-3", "2026-09-21", "reported", 0.5, "note"],
    ["OMBI-0003", "WUSTA MINERALS SPC", "identity; governorate", "Cardify Oman Business Index", "public_directory", "https://cardify.om/companies?page=4", "page-4", "2026-09-21", "reported", 0.5, "note"]
  ];
  const tax = overrides.tax ?? [
    ["OMBI-0001", "AL NOOR TRADING (L.L.C.)", null, null, "could_not_verify", null, null, null, "no identifier"],
    ["OMBI-0002", "SALALAH FISHERIES CO SAOC", null, null, "could_not_verify", null, null, null, "no identifier"],
    ["OMBI-0003", "WUSTA MINERALS SPC", null, null, "could_not_verify", null, null, null, "no identifier"]
  ];
  const procurement = overrides.procurement ?? [];
  const awards = overrides.awards ?? [];

  const sheets: Record<string, XlsxRow[]> = {
    Companies: companies.map(r => Object.fromEntries(COMPANY_HEADERS.map((h, i) => [h, r[i] ?? null]))),
    Sources: sources.map(r => Object.fromEntries(SOURCE_HEADERS.map((h, i) => [h, r[i] ?? null]))),
    "Tax Verification": tax.map(r => Object.fromEntries(TAX_HEADERS.map((h, i) => [h, r[i] ?? null]))),
    Procurement: procurement.map(r => Object.fromEntries(PROCUREMENT_HEADERS.map((h, i) => [h, r[i] ?? null]))),
    Awards: awards.map(r => Object.fromEntries(AWARD_HEADERS.map((h, i) => [h, r[i] ?? null]))),
    "Review Queue": [],
    "Data Quality": []
  };
  return { sheets, sheetNames: Object.keys(sheets) };
}

// ---------------------------------------------------------------------------------------------
// xlsx parsing
// ---------------------------------------------------------------------------------------------

test("xlsx parsing: a hand-built workbook round-trips through parseXlsxWorkbook with correct sheet names, row counts and cell values (including a DEFLATEd part)", () => {
  const buffer = buildTestXlsx([
    { name: "Sheet A", headers: ["id", "name", "score"], rows: [["1", "Alpha", 3.5], ["2", "Beta", null]] }
  ]);
  const wb = parseXlsxWorkbook(buffer);
  assert.deepEqual(wb.sheetNames, ["Sheet A"]);
  assert.equal(wb.sheets["Sheet A"]?.length, 2);
  assert.equal(wb.sheets["Sheet A"]?.[0]?.id, "1");
  assert.equal(wb.sheets["Sheet A"]?.[0]?.name, "Alpha");
  assert.equal(wb.sheets["Sheet A"]?.[0]?.score, 3.5);
  assert.equal(wb.sheets["Sheet A"]?.[1]?.score, null);
});

test("xlsx parsing: the full Cardify-shaped sample workbook parses into every expected sheet", () => {
  const wb = sampleWorkbook();
  assert.deepEqual([...wb.sheetNames].sort(), ["Awards", "Companies", "Data Quality", "Procurement", "Review Queue", "Sources", "Tax Verification"].sort());
  assert.equal(wb.sheets["Companies"]?.length, 3);
  assert.equal(wb.sheets["Sources"]?.length, 3);
});

// ---------------------------------------------------------------------------------------------
// blank -> null handling
// ---------------------------------------------------------------------------------------------

test("blank -> null: an accepted Cardify company row never has 'N/A'/'unknown'/'-' style placeholders — blank Excel cells become null", async () => {
  const wb = sampleWorkbook();
  const repo = new MemoryCompanyRepository();
  const result = await importCardifyWorkbook(wb, repo, true);
  const record = result.sampleRecords[0]!;
  for (const field of ["registrationNumber", "status", "registrationDate", "wilayat", "area", "address", "website", "email", "phone", "vatNumber"] as const) {
    assert.equal(record[field], null, `${field} should be null, got ${JSON.stringify(record[field])}`);
  }
  assert.deepEqual(record.activities, []);
});

// ---------------------------------------------------------------------------------------------
// source_record_id repair + determinism
// ---------------------------------------------------------------------------------------------

test("source_record_id repair: never the workbook's own page-level id — a distinct, deterministic id per company, with the original page reference preserved in metadata", async () => {
  const wb = sampleWorkbook();
  const repo = new MemoryCompanyRepository();
  const result = await importCardifyWorkbook(wb, repo, true);
  const ids = result.sampleRecords.map(r => r.sourceRecordId);
  assert.equal(new Set(ids).size, ids.length, "every generated sourceRecordId must be unique");
  for (const record of result.sampleRecords) {
    assert.ok(!/^page-\d+$/.test(record.sourceRecordId ?? ""), "sourceRecordId must never be the raw page reference");
    assert.match(record.sourceRecordId ?? "", /^cardify:/);
  }
  const first = result.sampleRecords.find(r => r.metadata.cardifyCompanyId === "OMBI-0001")!;
  assert.equal(first.metadata.cardifyOriginalSourceRecordId, "page-3");
  assert.equal(first.metadata.cardifySourcePage, 3);
});

test("deterministic source_record_id: the exact same id is generated for the exact same company_id, every time", () => {
  assert.equal(generateCardifySourceRecordId("OMBI-0001"), generateCardifySourceRecordId("OMBI-0001"));
  assert.equal(generateCardifySourceRecordId("OMBI-0001"), "cardify:ombi-0001");
  assert.notEqual(generateCardifySourceRecordId("OMBI-0001"), generateCardifySourceRecordId("OMBI-0002"));
});

test("duplicate company_id refuses the whole import rather than silently colliding source_record_ids", async () => {
  const wb = sampleWorkbook({
    companies: [
      ["OMBI-0001", "AL NOOR TRADING LLC", null, null, null, null, "LLC", null, null, "Trading", null, "Muscat", null, null, null, null, null, null, null, "unknown", null, null, null, null, null, null, null, null, "reported", 0.55, "2026-09-21", null],
      ["OMBI-0001", "A DIFFERENT COMPANY LLC", null, null, null, null, "LLC", null, null, "Trading", null, "Muscat", null, null, null, null, null, null, null, "unknown", null, null, null, null, null, null, null, null, "reported", 0.55, "2026-09-21", null]
    ],
    sources: [
      ["OMBI-0001", "AL NOOR TRADING LLC", "identity", "Cardify Oman Business Index", "public_directory", null, "page-1", "2026-09-21", "reported", 0.5, null],
      ["OMBI-0001", "A DIFFERENT COMPANY LLC", "identity", "Cardify Oman Business Index", "public_directory", null, "page-1", "2026-09-21", "reported", 0.5, null]
    ],
    tax: []
  });
  const repo = new MemoryCompanyRepository();
  await assert.rejects(() => importCardifyWorkbook(wb, repo, true), /duplicate company_id/i);
});

// ---------------------------------------------------------------------------------------------
// re-import idempotency
// ---------------------------------------------------------------------------------------------

test("re-import idempotency: importing the exact same workbook twice creates zero duplicate companies or source rows", async () => {
  const wb = sampleWorkbook();
  const repo = new MemoryCompanyRepository();

  const first = await importCardifyWorkbook(wb, repo, false);
  assert.equal(first.sourceEvidenceInserted, 3);
  assert.equal(first.sourceEvidenceUpdated, 0);
  assert.equal(first.newCompanies, 3, "first import: all 3 companies are newly created");
  assert.equal(first.matchedExistingCompanies, 0, "first import: nothing pre-existed to match");

  const second = await importCardifyWorkbook(wb, repo, false);
  assert.equal(second.sourceEvidenceInserted, 0, "second run must insert nothing new");
  assert.equal(second.sourceEvidenceUpdated, 3, "second run updates the same 3 existing rows in place");
  // Regression test: an earlier version of the newCompanies/matchedExistingCompanies accounting
  // excluded a candidate sharing the record's own sourceRecordId from counting as a match, which
  // made it blind to "this exact row was already imported" and reported newCompanies=3 again on
  // every re-run — even though the database itself was already correctly idempotent (proven by
  // sourceEvidenceInserted/Updated and the row/company counts below). The counters must reflect
  // the real identity-resolution outcome: a re-import of an already-imported row resolves onto an
  // EXISTING company, so it is "matched", not "new".
  assert.equal(second.newCompanies, 0, "second run: zero new companies — every row resolves to an existing company");
  assert.equal(second.matchedExistingCompanies, 3, "second run: all 3 rows matched their existing company");

  const allRows = await repo.adminListAllRows();
  const cardifyRows = allRows.filter(r => r.sourceName === DEFAULT_CARDIFY_SOURCE_NAME);
  assert.equal(cardifyRows.length, 3, "still exactly 3 rows — no duplicates created by the second import");
  assert.equal(new Set(cardifyRows.map(r => r.companyId)).size, 3, "still exactly 3 distinct companies");
});

// ---------------------------------------------------------------------------------------------
// normalized_name recalculation
// ---------------------------------------------------------------------------------------------

test("normalized_name recalculation: the workbook's own normalized_name column is never trusted — recomputed from company_name via the production normalizer", async () => {
  const wb = sampleWorkbook(); // every sample company row's normalized_name column is the literal string "BOGUS NAME"/"BOGUS"
  const repo = new MemoryCompanyRepository();
  const result = await importCardifyWorkbook(wb, repo, true);
  for (const record of result.sampleRecords) {
    assert.notEqual(record.normalizedName, "BOGUS NAME");
    assert.notEqual(record.normalizedName, "BOGUS");
  }
  const alNoor = result.sampleRecords.find(r => r.companyName.startsWith("AL NOOR"))!;
  assert.equal(alNoor.normalizedName, "AL NOOR TRADING"); // trailing "(L.L.C.)" canonicalized to LLC then stripped
});

// ---------------------------------------------------------------------------------------------
// public-directory source classification + reported verification status
// ---------------------------------------------------------------------------------------------

test("public-directory source classification: every Cardify row is sourceType \"directory\" (public_directory trust class) — never government/tax_authority/government_procurement/company_website", async () => {
  const wb = sampleWorkbook();
  const repo = new MemoryCompanyRepository();
  const result = await importCardifyWorkbook(wb, repo, true);
  for (const record of result.sampleRecords) assert.equal(record.sourceType, "directory");
});

test("reported verification status: explicitly \"reported\" on every row, even though the derived default for a 0.50-authority source would be \"estimated\"", async () => {
  const wb = sampleWorkbook();
  const repo = new MemoryCompanyRepository();
  const result = await importCardifyWorkbook(wb, repo, true);
  for (const record of result.sampleRecords) assert.equal(record.verificationStatus, "reported");
});

test("Cardify companies are never marked government-verified after import: confidence stays modest, verificationStatus stays reported, real evidence present, no demo sources", async () => {
  const wb = sampleWorkbook();
  const repo = new MemoryCompanyRepository();
  await importCardifyWorkbook(wb, repo, false);
  const rows = await repo.adminListAllRows();
  const awards = await repo.adminListAllAwards();
  const views = buildCompanyViews(rows, awards);
  assert.equal(views.length, 3);
  for (const v of views) {
    assert.equal(v.verificationStatus, "reported");
    assert.equal(v.isDemoOnly, false);
    assert.ok(v.isReal);
    assert.ok(v.confidence < 0.60, `confidence should stay modest, got ${v.confidence}`);
    assert.equal(v.registrationNumber, null);
  }
});

// ---------------------------------------------------------------------------------------------
// could_not_verify tax handling
// ---------------------------------------------------------------------------------------------

test("classifyCardifyTaxRow: could_not_verify is never imported as evidence — it is a non-outcome, not \"not_registered\"", () => {
  const row: CardifyTaxVerificationRow = { company_id: "OMBI-0001", tax_verification_status: "could_not_verify" };
  const classified = classifyCardifyTaxRow(row);
  assert.equal(classified.include, false);
});

test("classifyCardifyTaxRow: a real outcome with no linking identifier is still not imported", () => {
  const row: CardifyTaxVerificationRow = { company_id: "OMBI-0001", tax_verification_status: "not_registered" };
  const classified = classifyCardifyTaxRow(row);
  assert.equal(classified.include, false);
});

test("classifyCardifyTaxRow: a real outcome WITH a linking identifier is accepted", () => {
  const row: CardifyTaxVerificationRow = { company_id: "OMBI-0001", tax_verification_status: "verified", vat_number: "OM123456" };
  const classified = classifyCardifyTaxRow(row);
  assert.equal(classified.include, true);
  if (classified.include) assert.equal(classified.outcome, "verified");
});

test("could_not_verify tax handling end-to-end: all-could_not_verify Tax Verification rows are ignored, none written, no negative tax risk flag created", async () => {
  const wb = sampleWorkbook(); // every tax row is could_not_verify with no identifiers
  const repo = new MemoryCompanyRepository();
  const result = await importCardifyWorkbook(wb, repo, false);
  assert.equal(result.taxRowsAccepted, 0);
  assert.equal(result.taxRowsIgnored, 3);
  const rows = await repo.adminListAllRows();
  assert.equal(rows.filter(r => r.sourceName.includes("Tax Verification")).length, 0, "no tax-evidence source row should have been written");
  for (const r of rows) assert.equal(r.taxVerificationStatus, undefined, "the identity row itself must not carry a tax status from a could_not_verify row");
});

test("could_not_verify tax handling: a real, linkable outcome DOES get written as its own conservative (directory-trust) evidence row", async () => {
  const wb = sampleWorkbook({
    tax: [
      ["OMBI-0001", "AL NOOR TRADING (L.L.C.)", null, "OM123456", "verified", "2026-09-20", "Cardify Oman Business Index", "https://cardify.om/tax/1", null],
      ["OMBI-0002", "SALALAH FISHERIES CO SAOC", null, null, "could_not_verify", null, null, null, null],
      ["OMBI-0003", "WUSTA MINERALS SPC", null, null, "could_not_verify", null, null, null, null]
    ]
  });
  const repo = new MemoryCompanyRepository();
  const result = await importCardifyWorkbook(wb, repo, false);
  assert.equal(result.taxRowsAccepted, 1);
  assert.equal(result.taxRowsIgnored, 2);
  const rows = await repo.adminListAllRows();
  const taxRow = rows.find(r => r.sourceName.includes("Tax Verification"));
  assert.ok(taxRow, "the real tax outcome should have been written as its own evidence row");
  assert.equal(taxRow!.sourceType, "directory", "never tax_authority — Cardify's own research pass is not an authenticated Tax Oman lookup");
  assert.equal(taxRow!.taxVerificationStatus, "verified");
  assert.equal(taxRow!.vatNumber, "OM123456");
});

// ---------------------------------------------------------------------------------------------
// empty procurement / awards sheets
// ---------------------------------------------------------------------------------------------

test("empty procurement sheet: zero rows accepted or ignored, no procurement fields written, no failure", async () => {
  const wb = sampleWorkbook({ procurement: [] });
  const repo = new MemoryCompanyRepository();
  const result = await importCardifyWorkbook(wb, repo, false);
  assert.equal(result.procurementTotalRows, 0);
  assert.equal(result.procurementRowsAccepted, 0);
  assert.equal(result.procurementRowsIgnored, 0);
  const rows = await repo.adminListAllRows();
  for (const r of rows) assert.equal(r.registeredSupplier, null, "missing procurement data must stay null/unknown, never false");
});

test("empty awards sheet: zero award rows accepted, nothing manufactured, no failure", async () => {
  const wb = sampleWorkbook({ awards: [] });
  const repo = new MemoryCompanyRepository();
  const result = await importCardifyWorkbook(wb, repo, false);
  assert.equal(result.awardTotalRows, 0);
  assert.equal(result.awardRowsAccepted, 0);
  const awards = await repo.adminListAllAwards();
  assert.equal(awards.length, 0);
});

test("non-empty procurement sheet merges onto the same per-company evidence row (never manufactures a false where the value is genuinely unknown)", async () => {
  const wb = sampleWorkbook({
    procurement: [
      ["OMBI-0001", "AL NOOR TRADING (L.L.C.)", "true", "Trading", "Category B", 4, null, "2026-08-01", "Cardify Oman Business Index", null, "2026-09-21"]
    ]
  });
  const repo = new MemoryCompanyRepository();
  const result = await importCardifyWorkbook(wb, repo, false);
  assert.equal(result.procurementRowsAccepted, 1);
  const rows = await repo.adminListAllRows();
  const al = rows.find(r => r.metadata.cardifyCompanyId === "OMBI-0001")!;
  assert.equal(al.registeredSupplier, true);
  assert.equal(al.tendersParticipated, 4);
  const others = rows.filter(r => r.metadata.cardifyCompanyId !== "OMBI-0001");
  for (const r of others) assert.equal(r.registeredSupplier, null);
});

// ---------------------------------------------------------------------------------------------
// strong source outranks Cardify
// ---------------------------------------------------------------------------------------------

test("strong source outranks Cardify: a government-registry row's fields win the merge over a same-company Cardify row, even imported after it", async () => {
  const repo = new MemoryCompanyRepository();

  // A prior, authoritative MOCIIP row for the same company (name+governorate identity match —
  // Cardify never supplies a registrationNumber, so this is the only identity signal available).
  // companyName matches the Cardify row's EXACT text on purpose: merge.ts's own identity-conflict
  // check (distinctNames, case-insensitive but not punctuation-insensitive) is a real, separate
  // behavior this test isn't about — a genuinely different spelling across sources correctly
  // surfaces as hasConflict/"conflicting" rather than being silently merged, which is exercised by
  // this project's existing merge tests, not duplicated here.
  const govRecord: CompanyRecordInput = {
    companyName: "AL NOOR TRADING (L.L.C.)", normalizedName: "AL NOOR TRADING", nameAr: null, nameEn: null,
    registrationNumber: "1010999999", legalType: "LLC", status: "active", registrationDate: "2015-01-01",
    industry: "Trading", activities: [], governorate: "Muscat", wilayat: "Muscat", area: null, address: "Ghala",
    website: null, email: null, phone: null, vatNumber: null, vatStatus: null, employeeRange: null, estimatedCompanySize: null,
    sourceType: "government", sourceName: "Oman Business / MOCIIP company register (manual lookup)",
    // Recent enough to stay within government's 30-day freshness threshold (freshnessPolicy.ts) —
    // a STALE government row would rank below Cardify's "reported" in mergedVerificationStatus, and
    // this test is specifically about a FRESH authoritative source outranking Cardify.
    sourceRecordId: "1010999999", sourceUrl: null, observedAt: new Date(Date.now() - 5 * 86_400_000).toISOString(), metadata: {}
  };
  await repo.upsertCompanies([govRecord]);

  const wb = sampleWorkbook({
    companies: [
      ["OMBI-0001", "AL NOOR TRADING (L.L.C.)", null, null, null, null, "LLC", null, null, "Trading", null, "Muscat", null, null, null, null, null, null, null, "unknown", null, null, null, null, null, null, null, null, "reported", 0.55, "2026-09-21", null]
    ],
    sources: [
      ["OMBI-0001", "AL NOOR TRADING (L.L.C.)", "identity", "Cardify Oman Business Index", "public_directory", null, "page-3", "2026-09-21", "reported", 0.5, null]
    ],
    tax: []
  });
  await importCardifyWorkbook(wb, repo, false);

  const rows = await repo.adminListAllRows();
  const awards = await repo.adminListAllAwards();
  const views = buildCompanyViews(rows, awards);
  const merged = views.find(v => v.registrationNumber === "1010999999");
  assert.ok(merged, "the two rows should have resolved to the same company identity");
  assert.equal(merged!.sourceCount, 2, "both the government row and the Cardify row contributed");
  assert.equal(merged!.status, "active", "the government row's status must win, never overwritten by Cardify's null");
  assert.equal(merged!.industry, "Trading");
  assert.equal(merged!.verificationStatus, "verified", "one fresh, authoritative (government) contributing row is enough to call the merged company verified, even with a weaker Cardify row also attached");
});

// ---------------------------------------------------------------------------------------------
// duplicate detection helper
// ---------------------------------------------------------------------------------------------

test("detectCardifyDuplicates: flags duplicate company_id, duplicate normalized-name+governorate, and same-name-different-id, independently", () => {
  const report = detectCardifyDuplicates([
    { companyId: "A", companyName: "Foo LLC", normalizedName: "FOO", governorate: "Muscat" },
    { companyId: "A", companyName: "Foo LLC", normalizedName: "FOO", governorate: "Muscat" }, // duplicate company_id
    { companyId: "B", companyName: "Bar LLC", normalizedName: "BAR", governorate: "Dhofar" },
    { companyId: "C", companyName: "Bar LLC", normalizedName: "BAR", governorate: "Muscat" } // same name, different id
  ]);
  assert.deepEqual(report.duplicateCompanyIds, ["A"]);
  assert.equal(report.sameNameDifferentIds.length, 1);
  assert.deepEqual([...report.sameNameDifferentIds[0]!.companyIds].sort(), ["B", "C"]);
});

test("detectCardifyDuplicates: two different company_ids sharing (normalizedName, governorate) are flagged, not silently merged without disclosure", () => {
  const report = detectCardifyDuplicates([
    { companyId: "X", companyName: "Same Name LLC", normalizedName: "SAME NAME", governorate: "Muscat" },
    { companyId: "Y", companyName: "Same Name LLC", normalizedName: "SAME NAME", governorate: "Muscat" }
  ]);
  assert.equal(report.duplicateCompanyIds.length, 0);
  assert.equal(report.duplicateNormalizedNameLocation.length, 1);
  assert.deepEqual([...report.duplicateNormalizedNameLocation[0]!.companyIds].sort(), ["X", "Y"]);
});

// ---------------------------------------------------------------------------------------------
// validation errors
// ---------------------------------------------------------------------------------------------

test("a row with an unrecognized governorate is rejected (not imported rather than guessed at) and does not abort the rest of the batch", async () => {
  const wb = sampleWorkbook({
    companies: [
      ["OMBI-0001", "GOOD CO LLC", null, null, null, null, "LLC", null, null, "Trading", null, "Muscat", null, null, null, null, null, null, null, "unknown", null, null, null, null, null, null, null, null, "reported", 0.55, "2026-09-21", null],
      ["OMBI-0002", "BAD GOV CO LLC", null, null, null, null, "LLC", null, null, "Trading", null, "Nowhereistan", null, null, null, null, null, null, null, "unknown", null, null, null, null, null, null, null, null, "reported", 0.55, "2026-09-21", null]
    ],
    sources: [
      ["OMBI-0001", "GOOD CO LLC", "identity", "Cardify Oman Business Index", "public_directory", null, "page-1", "2026-09-21", "reported", 0.5, null],
      ["OMBI-0002", "BAD GOV CO LLC", "identity", "Cardify Oman Business Index", "public_directory", null, "page-1", "2026-09-21", "reported", 0.5, null]
    ],
    tax: []
  });
  const repo = new MemoryCompanyRepository();
  const result = await importCardifyWorkbook(wb, repo, true);
  assert.equal(result.validRows, 1);
  assert.equal(result.invalidRows, 1);
  assert.match(result.errors[0]!.reason, /governorate/i);
});

test("a row missing company_name is rejected as a validation error", async () => {
  const wb = sampleWorkbook({
    companies: [["OMBI-0001", "", null, null, null, null, "LLC", null, null, "Trading", null, "Muscat", null, null, null, null, null, null, null, "unknown", null, null, null, null, null, null, null, null, "reported", 0.55, "2026-09-21", null]],
    sources: [["OMBI-0001", "", "identity", "Cardify Oman Business Index", "public_directory", null, "page-1", "2026-09-21", "reported", 0.5, null]],
    tax: []
  });
  const repo = new MemoryCompanyRepository();
  const result = await importCardifyWorkbook(wb, repo, true);
  assert.equal(result.validRows, 0);
  assert.equal(result.invalidRows, 1);
  assert.match(result.errors[0]!.reason, /company_name/i);
});
