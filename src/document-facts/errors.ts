import { ApiError } from "../utils/errors.js";
import { DOCUMENT_FACTS_LIMITS as L } from "./config.js";

/**
 * Structured document_facts_extract errors. Each is an ApiError, so every channel (REST, x402,
 * L402, MPP, MCP) renders it through the shared publicError() as { code, message, details } — and
 * because each is a non-2xx outcome, no paid settlement happens on x402 / L402 / MPP (those gates
 * settle only successful responses). Malformed requests (bad JSON, schema violations, unknown
 * fields) are the shared INVALID_JSON / INVALID_INPUT (400) errors.
 *
 *   MISSING_DOCUMENT              400  neither documentUrl nor text was supplied
 *   CONFLICTING_DOCUMENT_SOURCES  400  both documentUrl and text were supplied
 *   EMPTY_DOCUMENT                400  text was supplied but is empty/whitespace
 *   INVALID_URL                   400  not an https URL, or it targets a private/internal host
 *   DOCUMENT_TOO_LARGE            413  over the page, character or download limit (never truncated)
 *   UNSUPPORTED_FORMAT            415  not PDF / DOCX / HTML / plain text / Markdown / CSV
 *   UNREADABLE_DOCUMENT           422  corrupt, password-protected, or no extractable text (e.g. scanned)
 *   DOCUMENT_FETCH_FAILED         502  the documentUrl could not be downloaded
 *   DOCUMENT_TIMEOUT              504  download or extraction exceeded its time budget
 *   EXTRACTION_FAILED             500  the extractor failed unexpectedly on a readable document
 */
export const DOCUMENT_FACTS_ERROR_CODES = [
  "INVALID_INPUT", "INVALID_JSON", "MISSING_DOCUMENT", "CONFLICTING_DOCUMENT_SOURCES", "EMPTY_DOCUMENT", "INVALID_URL",
  "DOCUMENT_TOO_LARGE", "UNSUPPORTED_FORMAT", "UNREADABLE_DOCUMENT", "DOCUMENT_FETCH_FAILED", "DOCUMENT_TIMEOUT", "EXTRACTION_FAILED"
] as const;

const NO_CHARGE = "No payment was taken.";

export const missingDocument = () => new ApiError(400, "MISSING_DOCUMENT",
  `Supply exactly one of documentUrl (an https link to the document) or text (the document's extracted text). ${NO_CHARGE}`,
  { status: "missing_document" });

export const conflictingSources = () => new ApiError(400, "CONFLICTING_DOCUMENT_SOURCES",
  `Supply documentUrl OR text, not both — it would be ambiguous which one the facts describe. ${NO_CHARGE}`,
  { status: "conflicting_document_sources" });

export const emptyDocument = () => new ApiError(400, "EMPTY_DOCUMENT",
  `The supplied text is empty. ${NO_CHARGE}`, { status: "empty_document" });

export const invalidUrl = (reason: string) => new ApiError(400, "INVALID_URL",
  `documentUrl is not acceptable: ${reason} ${NO_CHARGE}`, { status: "invalid_url", reason });

export type TooLargeLimit = "pages" | "characters" | "bytes";
export const documentTooLarge = (limit: TooLargeLimit, actual: number | null) => {
  const max = limit === "pages" ? L.maxPages : limit === "characters" ? L.maxTextChars : L.maxDownloadBytes;
  const unit = limit === "bytes" ? "bytes" : limit;
  return new ApiError(413, "DOCUMENT_TOO_LARGE",
    `The document exceeds the ${max.toLocaleString("en-US")}-${unit === "pages" ? "page" : unit === "characters" ? "character" : "byte"} limit${actual !== null ? ` (${actual.toLocaleString("en-US")} ${unit})` : ""}. It was not truncated; split it into smaller documents and extract each. ${NO_CHARGE}`,
    { status: "document_too_large", limit, max, actual });
};

export const unsupportedFormat = (detected: string, hint?: string) => new ApiError(415, "UNSUPPORTED_FORMAT",
  `Unsupported document format (${detected}). Supported: PDF with a text layer, DOCX, HTML, plain text, Markdown and CSV.${hint ? ` ${hint}` : ""} ${NO_CHARGE}`,
  { status: "unsupported_format", detected, supported: ["pdf", "docx", "html", "text", "markdown", "csv"] });

export const unreadableDocument = (reason: string) => new ApiError(422, "UNREADABLE_DOCUMENT",
  `The document could not be read: ${reason} ${NO_CHARGE}`, { status: "unreadable_document", reason });

export const fetchFailed = (reason: string, upstreamStatus: number | null) => new ApiError(502, "DOCUMENT_FETCH_FAILED",
  `The document could not be downloaded from documentUrl: ${reason} ${NO_CHARGE}`, { status: "fetch_failed", reason, upstreamStatus });

export const documentTimeout = (stage: "download" | "parse" | "extraction") => new ApiError(504, "DOCUMENT_TIMEOUT",
  `The document ${stage} exceeded its time budget. Retry, or supply the extracted text directly. ${NO_CHARGE}`, { status: "timeout", stage });

export const extractionFailed = () => new ApiError(500, "EXTRACTION_FAILED",
  `Fact extraction failed unexpectedly for this document. ${NO_CHARGE}`, { status: "extraction_failed" });

/** Races `promise` against a timer; the timer's error wins if it fires first. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(onTimeout()), ms); })]);
  } finally { if (timer) clearTimeout(timer); }
}
