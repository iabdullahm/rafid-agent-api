import { DOCUMENT_FACTS_LIMITS as L, getDocumentFactsAllowedHosts } from "./config.js";
import {
  documentTimeout, documentTooLarge, emptyDocument, fetchFailed, invalidUrl, unreadableDocument, unsupportedFormat, withTimeout
} from "./errors.js";
import { FeedFetchError, safeFeedFetch } from "../domain/oman/safeFeedFetch.js";
import { FeedUrlRejectedError, type HostResolver } from "../domain/oman/feedSecurity.js";
import { extractDocx, zipKind, type ExtractedPages } from "./formats/docx.js";
import { htmlToText } from "./formats/html.js";
import { extractPdf } from "./formats/pdf.js";

/**
 * Turns a documentUrl or supplied text into pages of plain text, or a structured error. The URL is
 * fetched once, SSRF-protected (https only, no private/loopback/link-local targets, validated
 * redirects — the shared domain/oman/safeFeedFetch.ts), size- and time-bounded, with no cookies or
 * credentials. Nothing in the document is executed and no URL found INSIDE the document is ever
 * fetched.
 */

export type DocumentFormat = "pdf" | "docx" | "html" | "text" | "markdown" | "csv";

export interface LoadedDocument extends ExtractedPages {
  format: DocumentFormat;
  source: { kind: "url" | "text"; url: string | null; contentType: string | null; byteLength: number | null };
  hiddenHtmlElementsRemoved?: number;
}

export interface LoaderDependencies {
  fetchImpl?: typeof fetch;
  resolver?: HostResolver;
  /** Tests only: permit http:// to a local fixture server. Never read from the environment. */
  allowInsecureHttp?: boolean;
}

// ---- Supplied text -------------------------------------------------------------------------------

export function loadFromText(text: string): LoadedDocument {
  if (!text.trim()) throw emptyDocument();
  if (text.length > L.maxTextChars) throw documentTooLarge("characters", text.length);
  // Form feeds (\f) are the conventional page separator (pdftotext and most extractors emit them).
  const hasPages = text.includes("\f");
  let pages: string[] | null = null;
  if (hasPages) {
    pages = text.split("\f").map(p => p.replace(/^\n+|\s+$/g, ""));
    while (pages.length > 1 && !pages[pages.length - 1]!.trim()) pages.pop();
    if (pages.length > L.maxPages) throw documentTooLarge("pages", pages.length);
  }
  const looksHtml = /^\s*(?:<!doctype html|<html[\s>])/i.test(text);
  if (looksHtml) {
    const h = htmlToText(text);
    return { pages: null, text: h.text, pageCount: null, warnings: htmlWarnings(h), format: "html", source: { kind: "text", url: null, contentType: null, byteLength: null }, hiddenHtmlElementsRemoved: h.removedHiddenElements };
  }
  const format: DocumentFormat = /^\s*#{1,6}\s|\n#{1,6}\s/.test(text) ? "markdown" : "text";
  return { pages, text: pages ? pages.join("\n\n") : text, pageCount: pages ? pages.length : null, warnings: [], format, source: { kind: "text", url: null, contentType: null, byteLength: null } };
}

function htmlWarnings(h: { removedHiddenElements: number; removedScripts: number }): string[] {
  const w: string[] = [];
  if (h.removedScripts) w.push(`${h.removedScripts} script block(s) were removed from the HTML and not executed.`);
  if (h.removedHiddenElements) w.push(`${h.removedHiddenElements} element(s) hidden from human readers were removed from the HTML before extraction.`);
  return w;
}

// ---- URL ---------------------------------------------------------------------------------------

export function validateDocumentUrl(raw: string, deps: LoaderDependencies = {}): URL {
  if (raw.length > L.maxUrlLength) throw invalidUrl(`the URL is longer than ${L.maxUrlLength} characters.`);
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw invalidUrl("it is not a valid absolute URL."); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && deps.allowInsecureHttp)) throw invalidUrl(`only https:// URLs are accepted (got ${url.protocol.replace(":", "")}).`);
  if (url.username || url.password) throw invalidUrl("URLs with embedded credentials are not accepted.");
  return url;
}

const ACCEPT = "application/pdf, application/vnd.openxmlformats-officedocument.wordprocessingml.document, text/plain;q=0.9, text/markdown;q=0.9, text/csv;q=0.9, text/html;q=0.8, */*;q=0.1";

export async function loadFromUrl(raw: string, deps: LoaderDependencies = {}): Promise<LoadedDocument> {
  const url = validateDocumentUrl(raw, deps);
  const allowlist = getDocumentFactsAllowedHosts();
  let res;
  try {
    res = await safeFeedFetch(url.toString(), {
      timeoutMs: L.fetchTimeoutMs, maxResponseBytes: L.maxDownloadBytes, maxRedirects: 3, returnBytes: true,
      headers: { Accept: ACCEPT, "User-Agent": "RafidAgentAPI-DocumentFacts/1.0 (+https://api.rafidsystem.com/llms.txt)" },
      fetchImpl: deps.fetchImpl, allowInsecureHttp: deps.allowInsecureHttp, allowlist,
      resolver: deps.resolver
    });
  } catch (e) {
    if (e instanceof FeedUrlRejectedError) {
      if (e.reason === "unsupported_scheme" || e.reason === "invalid_url") throw invalidUrl(e.message);
      if (e.reason === "not_in_allowlist") throw invalidUrl("the host is not in this deployment's document host allowlist.");
      throw invalidUrl("the URL points to a private, loopback, link-local or otherwise internal address.");
    }
    if (e instanceof FeedFetchError) {
      if (e.kind === "too_large") throw documentTooLarge("bytes", null);
      if (e.kind === "timeout") throw documentTimeout("download");
      if (e.kind === "too_many_redirects" || e.kind === "bad_redirect") throw fetchFailed(e.message, null);
      throw fetchFailed("the host could not be reached.", null);
    }
    if (e instanceof Error && /ENOTFOUND|EAI_AGAIN|getaddrinfo/.test(e.message)) throw fetchFailed("the host name could not be resolved.", null);
    throw fetchFailed("the download failed.", null);
  }
  if (res.status < 200 || res.status >= 300) throw fetchFailed(`the server answered HTTP ${res.status}.`, res.status);
  const bytes = res.bytes ?? Buffer.from(res.body, "utf8");
  if (bytes.length === 0) throw unreadableDocument("the downloaded document is empty.");
  const source = { kind: "url" as const, url: res.finalUrl, contentType: res.contentType, byteLength: bytes.length };
  const loaded = await withTimeout(parseBytes(bytes, res.contentType, url.pathname), L.parseTimeoutMs, () => documentTimeout("parse"));
  return { ...loaded, source };
}

// ---- Format detection and parsing ------------------------------------------------------------------

export function sniffFormat(bytes: Buffer, contentType: string | null, path: string): DocumentFormat | { unsupported: string; hint?: string } {
  const head = bytes.subarray(0, 16);
  const ascii = head.toString("latin1");
  if (ascii.startsWith("%PDF-") || bytes.subarray(0, 1024).includes("%PDF-")) return "pdf";
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    const kind = zipKind(bytes);
    if (kind === "docx") return "docx";
    return { unsupported: kind, hint: kind === "xlsx" ? "Spreadsheets are not supported; export the sheet as CSV text." : kind === "pptx" ? "Presentations are not supported; export as PDF." : undefined };
  }
  if (head[0] === 0xd0 && head[1] === 0xcf && head[2] === 0x11 && head[3] === 0xe0) return { unsupported: "legacy Microsoft Office binary (.doc/.xls/.ppt)", hint: "Save it as PDF or DOCX." };
  if (head[0] === 0x89 && ascii.slice(1, 4) === "PNG" || head[0] === 0xff && head[1] === 0xd8 || ascii.startsWith("GIF8") || ascii.startsWith("II*\u0000") || ascii.startsWith("MM\u0000*") || ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP" || ascii.slice(4, 12).includes("ftypheic")) {
    return { unsupported: "image", hint: "Image documents need OCR, which this version does not perform; supply the text instead." };
  }
  if (ascii.startsWith("{\\rtf")) return { unsupported: "rtf", hint: "Save it as PDF, DOCX or plain text." };
  if (ascii.startsWith("PK") || ascii.startsWith("\u001f\u008b") || ascii.startsWith("7z") || ascii.startsWith("Rar!")) return { unsupported: "archive" };
  // Text-like: reject binary content.
  const sample = bytes.subarray(0, 8192);
  let binary = 0;
  for (const b of sample) if (b === 0 || (b < 9) || (b > 13 && b < 32 && b !== 27)) binary++;
  const utf16 = sample[0] === 0xff && sample[1] === 0xfe || sample[0] === 0xfe && sample[1] === 0xff;
  if (!utf16 && binary > sample.length * 0.01) return { unsupported: contentType?.split(";")[0]?.trim() || "binary" };
  const ct = (contentType ?? "").toLowerCase();
  const lowerPath = path.toLowerCase();
  const textHead = bytes.subarray(0, 2048).toString("utf8").trimStart().toLowerCase();
  if (ct.includes("html") || ct.includes("xhtml") || /\.x?html?$/.test(lowerPath) || textHead.startsWith("<!doctype html") || textHead.startsWith("<html")) return "html";
  if (ct.includes("csv") || lowerPath.endsWith(".csv")) return "csv";
  if (ct.includes("markdown") || /\.(md|markdown)$/.test(lowerPath)) return "markdown";
  if (!ct || ct.startsWith("text/") || ct.includes("octet-stream") || ct.includes("json") || ct.includes("xml")) return "text";
  return { unsupported: ct.split(";")[0]!.trim() };
}

function decodeText(bytes: Buffer, contentType: string | null): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  const charset = /charset\s*=\s*"?([\w.-]+)/i.exec(contentType ?? "")?.[1];
  try { return new TextDecoder(charset ?? "utf-8").decode(bytes); } catch { return new TextDecoder("utf-8").decode(bytes); }
}

export async function parseBytes(bytes: Buffer, contentType: string | null, path = ""): Promise<Omit<LoadedDocument, "source">> {
  const format = sniffFormat(bytes, contentType, path);
  if (typeof format !== "string") throw unsupportedFormat(format.unsupported, format.hint);
  if (format === "pdf") return { ...(await extractPdf(bytes)), format };
  if (format === "docx") return { ...extractDocx(bytes), format };
  const decoded = decodeText(bytes, contentType);
  if (format === "html") {
    const h = htmlToText(decoded);
    if (h.text.length > L.maxTextChars) throw documentTooLarge("characters", h.text.length);
    return { pages: null, text: h.text, pageCount: null, warnings: htmlWarnings(h), format, hiddenHtmlElementsRemoved: h.removedHiddenElements };
  }
  if (!decoded.trim()) throw unreadableDocument("the downloaded document contains no text.");
  const t = loadFromText(decoded);
  return { pages: t.pages, text: t.text, pageCount: t.pageCount, warnings: t.warnings, format: t.format === "markdown" || format === "markdown" ? "markdown" : format };
}
