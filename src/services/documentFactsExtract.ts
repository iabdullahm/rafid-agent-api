import { runDocumentFactsExtract } from "../document-facts/service.js";

/** document_facts_extract's registry entry point (src/domain/capabilities.ts) — runs with the
 *  default, env-configured dependencies (real SSRF-safe fetch; LLM assist only when configured). */
export async function documentFactsExtract(input: unknown) {
  return runDocumentFactsExtract(input);
}
