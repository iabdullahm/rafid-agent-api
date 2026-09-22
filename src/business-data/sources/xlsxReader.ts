import { readFileSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { inflateRawSync } from "node:zlib";

/**
 * Section 13: a minimal, dependency-free .xlsx (OOXML SpreadsheetML) reader — added because no
 * XLSX support existed anywhere in this codebase before the Cardify Oman Business Index workbook
 * import (see cardifyOmanBusinessIndexProvider.ts). Deliberately narrow, mirroring this project's
 * existing stance on parsers (src/domain/oman/importPipeline.ts hand-rolls its own CSV parser
 * rather than taking a dependency): a .xlsx file is just a ZIP archive of small, regular XML parts,
 * and the two things this project actually needs — "list of {header -> value} rows per named
 * sheet" — do not require a general-purpose spreadsheet engine (formulas, styles, charts, pivot
 * tables, etc. are never read). Adding a third-party XLSX library was considered and rejected: it
 * would need to be physically copied into the production Windows deployment's node_modules (this
 * project cannot run `npm install` against that deployment — see docs/business-admin.md's
 * deployment notes) for no better outcome than the ~250 lines below, which are exactly as
 * inspectable/auditable as the rest of this project's parsing code.
 *
 * Supports exactly what real-world generator tools (Excel, Google Sheets, openpyxl, ExcelJS)
 * produce for ordinary data workbooks: stored or DEFLATE-compressed ZIP entries, inline strings
 * (t="inlineStr"), shared strings (t="s", via xl/sharedStrings.xml, when present), plain numeric/
 * boolean cells, and (Section 13 forward-compatibility) numeric cells whose style points at a
 * built-in or custom date number format, converted to an ISO date. Formulas are read by their
 * cached result (t="str"/<v> or a plain numeric <v>), never evaluated. Anything else (styles,
 * comments, drawings, pivot tables, merged cells) is ignored — this is a reader, not a renderer.
 */

export const MAX_XLSX_FILE_BYTES = 25 * 1024 * 1024; // 25 MB — generous for a data workbook, still bounded
const MAX_UNCOMPRESSED_ENTRY_BYTES = 100 * 1024 * 1024; // guards against a hostile/corrupt zip bomb per entry

export type XlsxCellValue = string | number | boolean | null;
export type XlsxRow = Record<string, XlsxCellValue>;

export interface ParsedXlsxWorkbook {
  /** Every sheet's data rows (row 2 onward) as {header -> value} objects, keyed by sheet NAME
   *  exactly as it appears in the workbook (e.g. "Companies", "Tax Verification"). Row 1 of each
   *  sheet is always treated as the header row, mirroring loadImportRows' CSV convention. A column
   *  with a blank/undefined value in a given row is present in the object as `null`, never omitted
   *  — callers can rely on every row exposing every header key. */
  sheets: Readonly<Record<string, readonly XlsxRow[]>>;
  /** Sheet names in workbook-tab order, for callers that want to report "sheets found". */
  sheetNames: readonly string[];
}

// ---- ZIP (a small, focused subset: local/central-directory records, stored + DEFLATE only) -----

interface ZipEntry { name: string; compressionMethod: number; compressedData: Buffer; uncompressedSize: number }

function readZipEntries(buffer: Buffer): Map<string, ZipEntry> {
  // End Of Central Directory record: signature 0x06054b50, fixed 22-byte tail (ignoring a
  // zero-length comment, which is all any real .xlsx writer emits) — search from the end since
  // there is no anchor at a fixed offset from the start of the file.
  const EOCD_SIG = 0x06054b50;
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) { eocdOffset = i; break; }
  }
  if (eocdOffset < 0) throw new Error("Not a valid .xlsx file — no ZIP end-of-central-directory record found");

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);

  const entries = new Map<string, ZipEntry>();
  let pointer = centralDirOffset;
  const CENTRAL_SIG = 0x02014b50;
  for (let i = 0; i < entryCount; i++) {
    if (buffer.readUInt32LE(pointer) !== CENTRAL_SIG) throw new Error("Corrupt .xlsx file — malformed ZIP central directory entry");
    const compressionMethod = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const uncompressedSize = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const localHeaderOffset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString("utf8", pointer + 46, pointer + 46 + nameLength);
    pointer += 46 + nameLength + extraLength + commentLength;

    if (uncompressedSize > MAX_UNCOMPRESSED_ENTRY_BYTES) throw new Error(`ZIP entry "${name}" is implausibly large (${uncompressedSize} bytes) — refusing to read it`);

    // Local file header: signature, then a 26-byte fixed section, then name + extra, then data.
    const LOCAL_SIG = 0x04034b50;
    if (buffer.readUInt32LE(localHeaderOffset) !== LOCAL_SIG) throw new Error(`Corrupt .xlsx file — malformed ZIP local header for "${name}"`);
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressedData = buffer.subarray(dataStart, dataStart + compressedSize);

    entries.set(name.replace(/^\//, ""), { name, compressionMethod, compressedData, uncompressedSize });
  }
  return entries;
}

function inflateEntry(entry: ZipEntry): string {
  if (entry.compressionMethod === 0) return entry.compressedData.toString("utf8"); // stored, no compression
  if (entry.compressionMethod === 8) return inflateRawSync(entry.compressedData).toString("utf8"); // DEFLATE
  throw new Error(`Unsupported ZIP compression method ${entry.compressionMethod} for entry "${entry.name}" — only stored and DEFLATE .xlsx entries are supported`);
}

// ---- Minimal, targeted XML extraction (no general XML parser — see this file's doc comment) ----

/** Decodes the handful of XML entities/numeric character references SpreadsheetML actually emits
 *  in text content. Not a general XML/HTML entity decoder. */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&"); // last, so a literal "&amp;lt;" in source data isn't double-decoded
}

/** Concatenates every <t>...</t> run inside one element's content (handles both a single <t> and
 *  Excel's rich-text run form <r><t>...</t></r><r><t>...</t></r>...). */
function extractRunText(xmlFragment: string): string {
  const matches = xmlFragment.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g);
  let out = "";
  for (const m of matches) out += decodeXmlEntities(m[1] ?? "");
  return out;
}

/** xl/sharedStrings.xml -> ordered array of strings, indexed exactly as SpreadsheetML's t="s" cell
 *  values reference them. Optional — a workbook with no repeated strings (or one that writes only
 *  inline strings, e.g. this project's own openpyxl-generated fixtures) has no such file. */
function parseSharedStrings(xml: string | undefined): readonly string[] {
  if (!xml) return [];
  const strings: string[] = [];
  for (const m of xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) strings.push(extractRunText(m[1] ?? ""));
  return strings;
}

/** xl/styles.xml -> the set of style indices (`s` cell attribute values) whose numFmtId denotes a
 *  date/time format — built-in ids 14-22 and 45-47 per the OOXML spec, plus any custom <numFmt>
 *  whose formatCode looks date-shaped (contains y/m/d/h without being a plain number format).
 *  Forward-compatible with a future workbook that stores real Excel date serials — this Cardify
 *  workbook does not (every date-like field is plain text; see cardifyOmanBusinessIndexProvider.ts). */
function parseDateStyleIndices(xml: string | undefined): ReadonlySet<number> {
  if (!xml) return new Set();
  const customDateFmtIds = new Set<number>();
  const numFmtsBlock = xml.match(/<numFmts[^>]*>([\s\S]*?)<\/numFmts>/)?.[1] ?? "";
  for (const m of numFmtsBlock.matchAll(/<numFmt\s+numFmtId="(\d+)"\s+formatCode="([^"]*)"/g)) {
    const code = decodeXmlEntities(m[2] ?? "").toLowerCase();
    if (/[ymdh]/.test(code) && !/^0[.0#,]*$/.test(code)) customDateFmtIds.add(Number(m[1]));
  }
  const cellXfsBlock = xml.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/)?.[1] ?? "";
  const dateStyleIndices = new Set<number>();
  let styleIndex = 0;
  for (const m of cellXfsBlock.matchAll(/<xf\b[^>]*numFmtId="(\d+)"[^>]*\/?>|<xf\b[^>]*\/>/g)) {
    const numFmtId = m[1] ? Number(m[1]) : 0;
    const isBuiltInDate = (numFmtId >= 14 && numFmtId <= 22) || (numFmtId >= 45 && numFmtId <= 47);
    if (isBuiltInDate || customDateFmtIds.has(numFmtId)) dateStyleIndices.add(styleIndex);
    styleIndex++;
  }
  return dateStyleIndices;
}

/** Excel's date epoch is 1899-12-30 (its well-known off-by-two "1900 leap year bug" baked in) —
 *  the standard conversion every spreadsheet tool uses for a date serial number. */
function excelSerialToIsoDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000); // 25569 = days between 1899-12-30 and 1970-01-01
  return new Date(ms).toISOString().slice(0, 10);
}

const A1_COLUMN_REF = /^([A-Z]+)(\d+)$/;

/** "AF208" -> 0-based column index 31 (A=0, Z=25, AA=26, ...). */
function columnIndexFromRef(cellRef: string): number {
  const match = A1_COLUMN_REF.exec(cellRef);
  if (!match) return -1;
  const letters = match[1]!;
  let index = 0;
  for (let i = 0; i < letters.length; i++) index = index * 26 + (letters.charCodeAt(i) - 64);
  return index - 1;
}

interface ParsedCell { columnIndex: number; value: XlsxCellValue }

function parseCell(cellXml: string, sharedStrings: readonly string[], dateStyleIndices: ReadonlySet<number>): ParsedCell | null {
  const refMatch = cellXml.match(/\br="([A-Z]+\d+)"/);
  if (!refMatch) return null;
  const columnIndex = columnIndexFromRef(refMatch[1]!);
  if (columnIndex < 0) return null;

  const typeMatch = cellXml.match(/\bt="([a-zA-Z]+)"/);
  const type = typeMatch?.[1] ?? "n";

  if (type === "inlineStr") {
    const isBlock = cellXml.match(/<is>([\s\S]*?)<\/is>/)?.[1] ?? "";
    return { columnIndex, value: extractRunText(isBlock) };
  }
  const vMatch = cellXml.match(/<v>([\s\S]*?)<\/v>/);
  if (!vMatch) return { columnIndex, value: null }; // no value element at all — a genuinely blank cell

  const raw = decodeXmlEntities(vMatch[1] ?? "");
  if (type === "s") { const index = Number(raw); return { columnIndex, value: sharedStrings[index] ?? null }; }
  if (type === "str" || type === "e") return { columnIndex, value: raw }; // formula-result string, or an error literal — kept as text, never thrown
  if (type === "b") return { columnIndex, value: raw === "1" };

  // Default (t="n" or no t attribute at all): a plain number, unless its style marks it as a date.
  const numeric = Number(raw);
  if (!Number.isFinite(numeric)) return { columnIndex, value: raw };
  const styleMatch = cellXml.match(/\bs="(\d+)"/);
  if (styleMatch && dateStyleIndices.has(Number(styleMatch[1]))) return { columnIndex, value: excelSerialToIsoDate(numeric) };
  return { columnIndex, value: numeric };
}

function parseWorksheetRows(xml: string, sharedStrings: readonly string[], dateStyleIndices: ReadonlySet<number>): XlsxRow[] {
  const rowMatches = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)];
  if (rowMatches.length === 0) return [];

  const headerCells: ParsedCell[] = [];
  for (const cellXml of rowMatches[0]![1]!.matchAll(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)) {
    const parsed = parseCell(cellXml[0], sharedStrings, dateStyleIndices);
    if (parsed) headerCells.push(parsed);
  }
  const headerByColumn = new Map<number, string>();
  for (const cell of headerCells) if (cell.value !== null && cell.value !== "") headerByColumn.set(cell.columnIndex, String(cell.value).trim());
  if (headerByColumn.size === 0) return [];

  const rows: XlsxRow[] = [];
  for (const rowMatch of rowMatches.slice(1)) {
    const cellsByColumn = new Map<number, XlsxCellValue>();
    for (const cellXml of rowMatch[1]!.matchAll(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)) {
      const parsed = parseCell(cellXml[0], sharedStrings, dateStyleIndices);
      if (parsed) cellsByColumn.set(parsed.columnIndex, parsed.value);
    }
    const row: XlsxRow = {};
    let hasAnyValue = false;
    for (const [columnIndex, header] of headerByColumn) {
      const value = cellsByColumn.get(columnIndex) ?? null;
      row[header] = value;
      if (value !== null && value !== "") hasAnyValue = true;
    }
    if (hasAnyValue) rows.push(row); // a fully blank row (e.g. a trailing formatted-but-empty row) contributes nothing
  }
  return rows;
}

/** Parses an in-memory .xlsx file (already read into a Buffer) into {sheetName -> rows}. Pure
 *  parsing, no filesystem access — see loadXlsxWorkbook below for the file-safety-checked entry
 *  point real callers should use. */
export function parseXlsxWorkbook(buffer: Buffer): ParsedXlsxWorkbook {
  const zip = readZipEntries(buffer);
  const workbookXml = zip.get("xl/workbook.xml");
  if (!workbookXml) throw new Error("Not a valid .xlsx file — missing xl/workbook.xml");
  const relsEntry = zip.get("xl/_rels/workbook.xml.rels");
  const workbookXmlText = inflateEntry(workbookXml);
  const relsXmlText = relsEntry ? inflateEntry(relsEntry) : "";

  const relTargetById = new Map<string, string>();
  for (const m of relsXmlText.matchAll(/<Relationship\b[^>]*\/>/g)) {
    const idMatch = m[0].match(/\bId="([^"]+)"/);
    const targetMatch = m[0].match(/\bTarget="([^"]+)"/);
    if (idMatch && targetMatch) {
      // Relationship targets in xl/_rels/workbook.xml.rels are either absolute within the zip
      // ("/xl/worksheets/sheet1.xml") or relative to the xl/ directory ("worksheets/sheet1.xml") —
      // normalize both to the zip-entry-name form ("xl/worksheets/sheet1.xml") used as this Map's keys.
      let target = targetMatch[1]!.replace(/^\//, "");
      if (!target.startsWith("xl/")) target = `xl/${target}`;
      relTargetById.set(idMatch[1]!, target);
    }
  }

  const sharedStringsEntry = zip.get("xl/sharedStrings.xml");
  const sharedStrings = parseSharedStrings(sharedStringsEntry ? inflateEntry(sharedStringsEntry) : undefined);
  const stylesEntry = zip.get("xl/styles.xml");
  const dateStyleIndices = parseDateStyleIndices(stylesEntry ? inflateEntry(stylesEntry) : undefined);

  const sheets: Record<string, XlsxRow[]> = {};
  const sheetNames: string[] = [];
  for (const m of workbookXmlText.matchAll(/<sheet\b[^>]*\/>/g)) {
    const nameMatch = m[0].match(/\bname="([^"]*)"/);
    const ridMatch = m[0].match(/\br:id="([^"]+)"/);
    if (!nameMatch || !ridMatch) continue;
    const sheetName = decodeXmlEntities(nameMatch[1]!);
    const target = relTargetById.get(ridMatch[1]!);
    if (!target) continue;
    const sheetEntry = zip.get(target);
    if (!sheetEntry) continue;
    sheets[sheetName] = parseWorksheetRows(inflateEntry(sheetEntry), sharedStrings, dateStyleIndices);
    sheetNames.push(sheetName);
  }

  return { sheets, sheetNames };
}

/** File-safety-checked entry point (mirrors loadImportRows in src/domain/oman/importPipeline.ts):
 *  resolves the path, verifies it is a real, appropriately-sized regular file, reads it whole, and
 *  parses it. Never reads a directory, a symlink target outside expectations, or an oversized file. */
export function loadXlsxWorkbook(filePath: string): ParsedXlsxWorkbook {
  const absolute = resolvePath(filePath);
  const stat = statSync(absolute); // throws ENOENT for a missing/unreadable path — never swallowed
  if (!stat.isFile()) throw new Error(`${absolute} is not a regular file`);
  if (stat.size > MAX_XLSX_FILE_BYTES) throw new Error(`${absolute} is ${stat.size} bytes, exceeding the ${MAX_XLSX_FILE_BYTES}-byte .xlsx import limit`);
  const buffer = readFileSync(absolute);
  return parseXlsxWorkbook(buffer);
}
