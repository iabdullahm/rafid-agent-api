import { z } from "zod";
import { DOCUMENT_FACTS_LIMITS as L } from "../document-facts/config.js";

export const DOCUMENT_TYPES = [
  "contract", "invoice", "purchase_order", "quotation", "tender", "policy", "financial_report",
  "legal_document", "lease", "resume", "company_profile", "other"
] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/**
 * document_facts_extract input. Exactly one of documentUrl / text is required — enforced by the
 * service with explicit MISSING_DOCUMENT / CONFLICTING_DOCUMENT_SOURCES errors (400) rather than a
 * generic schema error, so an agent knows precisely what to fix. Strict: unknown fields are
 * rejected. Document CONTENT is untrusted data and is never interpreted as instructions.
 */
export const documentFactsExtractInput = z.strictObject({
  documentUrl: z.string().trim().min(1).max(L.maxUrlLength)
    .describe(`https URL of the document (PDF with a text layer, DOCX, HTML, plain text, Markdown or CSV; max ${L.maxPages} pages / ${L.maxDownloadBytes / 1024 / 1024} MB). Fetched once, server-side, with SSRF protection; private/internal addresses are rejected. Supply this OR text.`)
    .optional(),
  // No schema-level max: an over-limit document gets the explicit DOCUMENT_TOO_LARGE (413) error
  // from the service (the route's 1 MB JSON body limit bounds the request itself).
  text: z.string()
    .describe(`The document's already-extracted text (max ${L.maxTextChars.toLocaleString("en-US")} characters; longer text is rejected with DOCUMENT_TOO_LARGE, never truncated). Separate pages with form-feed characters (\\f) to get page-level evidence; without them evidence carries sections, not page numbers. Supply this OR documentUrl.`)
    .optional(),
  documentType: z.enum(["auto", ...DOCUMENT_TYPES]).optional()
    .describe("Document type, or \"auto\" (default) to classify automatically. Selects which facts are prioritized."),
  requestedFacts: z.array(z.string().trim().min(2).max(L.maxRequestedFactChars)).max(L.maxRequestedFacts).optional()
    .describe(`Specific facts to establish, in plain language (max ${L.maxRequestedFacts}), e.g. ["contract expiry date", "termination notice period", "annual contract value"]. Each is answered in requestedFacts with status found / not_found — never fabricated.`),
  mode: z.enum(["auto", "requested_only"]).optional()
    .describe("\"auto\" (default): full extraction plus any requestedFacts. \"requested_only\": return only the requested facts (requires requestedFacts)."),
  language: z.string().trim().regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/, "language must be an ISO 639 code such as en, ar or fr").optional()
    .describe("Document language (ISO 639-1, e.g. en, ar, fr). Detected automatically when omitted."),
  includeSourceEvidence: z.boolean().optional()
    .describe("Default true. false omits sourceEvidence objects to reduce response size (facts remain the same).")
});

export type DocumentFactsExtractInput = z.infer<typeof documentFactsExtractInput>;
