import { DOCUMENT_FACTS_LIMITS as L } from "../config.js";
import { documentTooLarge, unreadableDocument, unsupportedFormat } from "../errors.js";
import { listZipEntries, readZipText, ZipFormatError } from "./zip.js";
import { decodeEntities } from "./xml.js";

export interface ExtractedPages { pages: string[] | null; text: string; pageCount: number | null; warnings: string[]; macrosPresent?: boolean }

/** True when the ZIP is an OOXML word-processing document. */
export function zipKind(buf: Buffer): "docx" | "xlsx" | "pptx" | "odf" | "zip" {
  try {
    const entries = listZipEntries(buf);
    if (entries.has("word/document.xml")) return "docx";
    if ([...entries.keys()].some(n => n.startsWith("xl/"))) return "xlsx";
    if ([...entries.keys()].some(n => n.startsWith("ppt/"))) return "pptx";
    if (entries.has("content.xml") && entries.has("mimetype")) return "odf";
  } catch { /* not a readable zip */ }
  return "zip";
}

/**
 * DOCX → text. Reads word/document.xml only (body paragraphs and tables); headers/footers/comments
 * are ignored. Page numbers are reported ONLY when Word recorded its own rendered pagination
 * (<w:lastRenderedPageBreak/>); explicit page breaks alone are not a reliable page count, so
 * without rendered breaks evidence carries sections, not pages. Embedded macros (vbaProject.bin)
 * are detected and reported — never executed. External relationships (linked images/templates)
 * are never fetched.
 */
export function extractDocx(buf: Buffer): ExtractedPages {
  let entries;
  try { entries = listZipEntries(buf); } catch (e) { throw unreadableDocument(`the DOCX archive is corrupt (${e instanceof Error ? e.message : "invalid ZIP"}).`); }
  const main = entries.get("word/document.xml");
  if (!main) throw unsupportedFormat("zip", "The archive is not a Word (DOCX) document.");
  const warnings: string[] = [];
  const macrosPresent = [...entries.keys()].some(n => /vbaProject\.bin$|vbaData\.xml$/i.test(n));
  if (macrosPresent) warnings.push("The document contains embedded macros (VBA). They were not executed; only the document text was read.");

  // App-reported page count (docProps/app.xml) — enforce the page limit before parsing the body.
  let appPages: number | null = null;
  const app = entries.get("docProps/app.xml");
  if (app) {
    try { const m = /<Pages>(\d+)<\/Pages>/.exec(readZipText(buf, app, 1_000_000)); if (m) appPages = Number(m[1]); } catch { /* optional */ }
  }
  if (appPages !== null && appPages > L.maxPages) throw documentTooLarge("pages", appPages);

  let xml: string;
  try { xml = readZipText(buf, main); }
  catch (e) {
    if (e instanceof ZipFormatError && /too large/.test(e.message)) throw documentTooLarge("bytes", main.uncompressedSize);
    throw unreadableDocument("the DOCX body could not be decompressed.");
  }
  if (/<w:altChunk\b/.test(xml)) warnings.push("The document embeds alternative-format content (altChunk) that was not read.");

  const PAGE = "\u0000PAGE\u0000";
  const hasRenderedBreaks = /<w:lastRenderedPageBreak\/>/.test(xml);
  let body = xml
    .replace(/<w:del\b[\s\S]*?<\/w:del>/g, "") // tracked deletions are not document text
    .replace(/<w:instrText\b[\s\S]*?<\/w:instrText>/g, "") // field codes
    .replace(/<w:lastRenderedPageBreak\/>/g, hasRenderedBreaks ? PAGE : "")
    .replace(/<w:br\b[^>]*w:type="page"[^>]*\/>/g, "\n")
    .replace(/<w:(?:br|cr)\b[^>]*\/>/g, "\n")
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<\/w:tc>/g, "\t")
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<\/w:p>/g, "\n");
  body = body.replace(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g, (_, t: string) => `\u0001${t}\u0002`);
  // Keep only text runs and structural whitespace.
  let text = "";
  const re = /\u0001([\s\S]*?)\u0002|(\n|\t|\u0000PAGE\u0000)/g;
  for (const m of body.matchAll(re)) text += m[1] !== undefined ? decodeEntities(m[1]) : m[2]!;
  text = text.replace(/\t+\n/g, "\n");

  if (hasRenderedBreaks) {
    const pages = text.split(PAGE).map(p => p.replace(/^\n+|\n+$/g, ""));
    while (pages.length > 1 && !pages[pages.length - 1]!.trim()) pages.pop();
    if (pages.length > L.maxPages) throw documentTooLarge("pages", pages.length);
    return { pages, text: pages.join("\n\n"), pageCount: appPages ?? pages.length, warnings, macrosPresent };
  }
  return { pages: null, text, pageCount: appPages, warnings, macrosPresent };
}
