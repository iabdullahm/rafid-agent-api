/**
 * document_facts_extract — limits and env configuration, in one place.
 *
 * Every limit here is enforced BEFORE extraction work is done where possible, and a document that
 * exceeds a limit is REJECTED with a structured error (DOCUMENT_TOO_LARGE) — never silently
 * truncated. Env reads follow the codebase's plain `process.env` pattern (see
 * src/intelligence/config.ts) and default to the safe/off behaviour.
 */

export const DOCUMENT_FACTS_EXTRACTOR_VERSION = "dfx-1.0.0";

export const DOCUMENT_FACTS_LIMITS = {
  /** Maximum pages for the initial version (PDF page count, DOCX app-reported pages, or
   *  form-feed-separated pages of supplied text). */
  maxPages: 25,
  /** Maximum extracted characters (~25 dense pages). Supplied text above this is rejected. */
  maxTextChars: 200_000,
  /** Maximum bytes downloaded from documentUrl (the download is aborted beyond this). */
  maxDownloadBytes: 15 * 1024 * 1024,
  /** Zip-bomb guard for DOCX parts. */
  maxDocxPartBytes: 20 * 1024 * 1024,
  maxUrlLength: 2048,
  /** Per-stage and whole-request time budgets (ms). Vercel's function maxDuration is 60 s. */
  fetchTimeoutMs: 15_000,
  parseTimeoutMs: 20_000,
  llmTimeoutMs: 25_000,
  totalBudgetMs: 50_000,
  maxRequestedFacts: 20,
  maxRequestedFactChars: 200,
  /** Evidence excerpts are kept short (characters). */
  maxEvidenceChars: 240,
  /** Upper bound on items per output list, so a pathological document cannot produce a huge response. */
  maxItemsPerList: 60,
  /** Fewer meaningful characters than this per page ⇒ no usable text layer (e.g. a scanned PDF). */
  minMeaningfulCharsPerPage: 20,
  /** Characters of document text sent to the optional LLM assist (relevance-selected segments). */
  maxLlmContextChars: 40_000,
  /** JSON request-body limit for this capability's routes (text input up to maxTextChars). */
  requestBodyLimit: "1mb"
} as const;

export type DocumentFactsLlmMode = "auto" | "off";

/** DOCUMENT_FACTS_LLM: "auto" (default) uses the shared intelligence LLM synthesizer when it is
 *  configured (INTELLIGENCE_LLM_PROVIDER / ANTHROPIC_API_KEY / INTELLIGENCE_LLM_MODEL) to fill
 *  requested/priority facts the deterministic extractor could not establish — every such fact must
 *  quote the document verbatim or it is discarded. "off" disables LLM assist entirely. */
export function getDocumentFactsLlmMode(env: NodeJS.ProcessEnv = process.env): DocumentFactsLlmMode {
  const raw = (env.DOCUMENT_FACTS_LLM ?? "auto").trim().toLowerCase();
  if (raw !== "auto" && raw !== "off") throw new Error("DOCUMENT_FACTS_LLM must be one of: auto, off");
  return raw;
}

/** DOCUMENT_FACTS_ALLOWED_HOSTS: optional comma-separated hostname allowlist for documentUrl.
 *  Empty (default) = any public https host that passes the SSRF checks. */
export function getDocumentFactsAllowedHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.DOCUMENT_FACTS_ALLOWED_HOSTS ?? "").split(",").map(h => h.trim().toLowerCase()).filter(Boolean);
}
