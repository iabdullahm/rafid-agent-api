import { ApiError } from "../utils/errors.js";
import { documentFactsExtractInput, type DocumentFactsExtractInput, type DocumentType } from "../schemas/documentFactsInputs.js";
import type { DocumentFactsExtractOutput, Fact, RequestedFact } from "../schemas/documentFactsOutputs.js";
import type { IntelligenceSynthesizer } from "../intelligence/synthesis/synthesizer.js";
import { buildIntelligenceSynthesizer, isSynthesisConfigured } from "../intelligence/synthesis/build.js";
import { DOCUMENT_FACTS_EXTRACTOR_VERSION, DOCUMENT_FACTS_LIMITS as L, getDocumentFactsLlmMode } from "./config.js";
import { DocumentModel, normalizeDocumentText } from "./document.js";
import { conflictingSources, documentTimeout, documentTooLarge, emptyDocument, extractionFailed, missingDocument, unreadableDocument, withTimeout } from "./errors.js";
import { loadFromText, loadFromUrl, type LoadedDocument, type LoaderDependencies } from "./loader.js";
import { inferDecimalStyle, inferNumericDateOrder } from "./normalize.js";
import { classifyDocument, detectSubtype } from "./extract/classify.js";
import { detectLanguage } from "./extract/language.js";
import { clamp01, round2, type ExtractionContext } from "./extract/context.js";
import { extractLabeledFields } from "./extract/labels.js";
import { extractEntities } from "./extract/entities.js";
import { extractAmounts, extractDates, extractDurations, extractPercentages } from "./extract/values.js";
import { extractClauseFacts, extractDeadlines, extractObligations, extractRequirements, splitIntoClauseSentences } from "./extract/clauses.js";
import { buildFacts, FACT_LABELS, PRIORITY_FACTS } from "./extract/facts.js";
import { assessRisks } from "./extract/risk.js";
import { detectActiveContentText, detectEmbeddedInstructions } from "./extract/injection.js";
import { answerRequests, matchRequest } from "./requested.js";
import { llmAssist, type LlmQuestion } from "./llm.js";
import type { CapabilityPreviewBody } from "../preview/types.js";

/**
 * document_facts_extract — orchestration.
 *
 *   input → load (URL fetch or supplied text; format parsing; limits) → normalize text →
 *   classify → deterministic extraction (labeled fields, typed dates/amounts/percentages/durations,
 *   entities, clauses, obligations, requirements, deadlines, line items) → document-type-aware
 *   fact assembly → requested facts → optional verified LLM assist → risk flags → confidence.
 *
 * Deterministic and side-effect free: the same input yields the same output (no timestamps or
 * timings in the result). The document is untrusted data throughout — see llm.ts and
 * extract/injection.ts. Every failure is a structured ApiError (errors.ts) so no payment settles.
 */

export interface DocumentFactsDependencies extends LoaderDependencies {
  synthesizer?: IntelligenceSynthesizer;
  /** Overrides DOCUMENT_FACTS_LLM / synthesizer configuration detection (tests). */
  llmEnabled?: boolean;
  requestId?: string | null;
  totalBudgetMs?: number;
}

const LIMITATIONS = [
  "Extraction certainty is not business, legal or financial advice: facts are what the document states, risk flags describe observable conditions, and nothing is a legal conclusion.",
  "Scanned/image-only documents are not OCR'd; only an embedded text layer (or supplied text) is read.",
  `Page numbers appear only when the source has real page boundaries (PDF pages, \\f-separated text, DOCX rendered page breaks); otherwise evidence carries section and text only.`,
  "Pattern extraction is tuned for English business documents; dates, amounts, percentages and currencies are recognized in several languages, but clause-level extraction in other languages is limited unless LLM assist is enabled.",
  "Values are returned as stated: nothing is computed, converted or annualized, and ambiguous dates/numbers/currency symbols are not normalized.",
  "Document content is treated as untrusted data: embedded instructions are never followed, and no link, macro or script inside the document is fetched or executed."
];

function textQuality(text: string): number {
  const sample = text.slice(0, 50_000);
  const nonSpace = sample.replace(/\s+/g, "");
  if (!nonSpace.length) return 0;
  const good = (nonSpace.match(/[\p{L}\p{N}.,;:%$€£()'"\/&@#+\-–—]/gu) ?? []).length;
  const replacement = (sample.match(/�/g) ?? []).length;
  const words = sample.match(/\p{L}{2,}/gu) ?? [];
  const avgLen = words.length ? words.reduce((n, w) => n + w.length, 0) / words.length : 0;
  let q = good / nonSpace.length - replacement / nonSpace.length * 5;
  if (avgLen > 14 || (avgLen > 0 && avgLen < 2.2)) q -= 0.25;
  return clamp01(q);
}

function stripEvidence<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripEvidence) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([k]) => k !== "sourceEvidence").map(([k, v]) => [k, k === "value" || k === "normalizedValue" ? v : stripEvidence(v)])) as T;
  }
  return value;
}

export async function runDocumentFactsExtract(rawInput: unknown, deps: DocumentFactsDependencies = {}): Promise<DocumentFactsExtractOutput> {
  const input: DocumentFactsExtractInput = documentFactsExtractInput.parse(rawInput);
  const hasUrl = input.documentUrl !== undefined && input.documentUrl.trim() !== "";
  const hasText = input.text !== undefined;
  if (hasUrl && hasText) throw conflictingSources();
  if (!hasUrl && !hasText) throw missingDocument();
  if (hasText && !input.text!.trim()) throw emptyDocument();
  const mode = input.mode ?? "auto";
  const requests = input.requestedFacts ?? [];
  if (mode === "requested_only" && !requests.length) {
    throw new ApiError(400, "INVALID_INPUT", "mode \"requested_only\" requires a non-empty requestedFacts list. No payment was taken.", [{ path: "requestedFacts", message: "Required when mode is requested_only" }]);
  }
  const budget = deps.totalBudgetMs ?? L.totalBudgetMs;
  const startedAt = Date.now();

  let loaded: LoadedDocument;
  try {
    loaded = hasUrl
      ? await withTimeout(loadFromUrl(input.documentUrl!, deps), budget, () => documentTimeout("download"))
      : loadFromText(input.text!);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw unreadableDocument("the document could not be parsed.");
  }

  try {
    return await withTimeout(extract(input, loaded, deps, budget - (Date.now() - startedAt)), Math.max(1000, budget - (Date.now() - startedAt)), () => documentTimeout("extraction"));
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw extractionFailed();
  }
}

/** Free Preview (src/preview/) for document_facts_extract. Reuses the real `load → normalize →
 *  classify` prefix of the pipeline above (documentUrl fetch is SSRF-protected and size/time-
 *  bounded by loader.ts's existing DOCUMENT_FACTS_LIMITS, exactly as it is for a paid call) but
 *  stops there — it never runs labeled-field/date/amount/percentage/duration/entity/clause
 *  extraction, requested-fact answering, the optional LLM assist, or risk-flag assessment, all of
 *  which stay exclusively in the paid result. This is the one preview in this codebase that
 *  cannot avoid its own real network fetch when documentUrl is used (a document's content is only
 *  knowable by reading it) — see the Free Preview implementation report's "remaining limitations"
 *  for why that is disclosed rather than hidden. */
export async function previewDocumentFactsExtract(rawInput: unknown, deps: DocumentFactsDependencies = {}): Promise<CapabilityPreviewBody> {
  const input: DocumentFactsExtractInput = documentFactsExtractInput.parse(rawInput);
  const hasUrl = input.documentUrl !== undefined && input.documentUrl.trim() !== "";
  const hasText = input.text !== undefined;
  if (hasUrl && hasText) throw conflictingSources();
  if (!hasUrl && !hasText) throw missingDocument();
  if (hasText && !input.text!.trim()) throw emptyDocument();
  const budget = deps.totalBudgetMs ?? L.totalBudgetMs;

  let loaded: LoadedDocument;
  try {
    loaded = hasUrl
      ? await withTimeout(loadFromUrl(input.documentUrl!, deps), budget, () => documentTimeout("download"))
      : loadFromText(input.text!);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw unreadableDocument("the document could not be parsed.");
  }

  const norm = (t: string) => normalizeDocumentText(t).text;
  const doc = loaded.pages ? new DocumentModel(loaded.pages.map(norm)) : new DocumentModel(null, norm(loaded.text));
  if (doc.text.length > L.maxTextChars) throw documentTooLarge("characters", doc.text.length);
  const meaningful = doc.text.replace(/\s+/g, "").length;
  if (meaningful < L.minMeaningfulCharsPerPage) {
    throw loaded.source.kind === "text" ? emptyDocument() : unreadableDocument("no extractable text was found in the document.");
  }

  const requestedType = input.documentType && input.documentType !== "auto" ? input.documentType as DocumentType : null;
  const detected = classifyDocument(doc);
  const type: DocumentType = requestedType ?? detected.type;
  const documentTypeConfidence = requestedType ? 1 : detected.confidence;
  const wordCount = (doc.text.match(/\p{L}[\p{L}\p{N}'’-]*/gu) ?? []).length;
  const pageCount = loaded.pageCount ?? doc.pageCount;
  // Real, array-valued output-schema top-level fields (schemas/documentFactsOutputs.ts) the paid
  // result populates — a static list, independent of this document's actual content.
  const availableSections = ["facts", "entities", "dates", "amounts", "percentages", "obligations", "requirements", "deadlines", "riskFlags"];

  return {
    capability: "document_facts_extract",
    status: "available",
    inputRecognized: true,
    preview: {
      entity: loaded.source.url ?? "supplied text", entityType: "document",
      coverageScore: Math.round(documentTypeConfidence * 100) / 100,
      dataCoverage: documentTypeConfidence >= 0.66 ? "high" : documentTypeConfidence >= 0.33 ? "medium" : "low",
      availableSections,
      signals: { documentType: type, pageCount: pageCount ?? 0, characterCount: doc.text.length, wordCount, format: loaded.format }
    }
  };
}

async function extract(input: DocumentFactsExtractInput, loaded: LoadedDocument, deps: DocumentFactsDependencies, remainingMs: number): Promise<DocumentFactsExtractOutput> {
  const warnings = [...loaded.warnings];
  const mode = input.mode ?? "auto";
  // Normalize each page separately so page boundaries survive.
  let hiddenChars = 0;
  const norm = (t: string) => { const n = normalizeDocumentText(t); hiddenChars += n.report.hiddenCharactersRemoved; return n.text; };
  const doc = loaded.pages ? new DocumentModel(loaded.pages.map(norm)) : new DocumentModel(null, norm(loaded.text));
  if (doc.text.length > L.maxTextChars) throw documentTooLarge("characters", doc.text.length);
  const meaningful = doc.text.replace(/\s+/g, "").length;
  if (meaningful < L.minMeaningfulCharsPerPage) {
    throw loaded.source.kind === "text" ? emptyDocument() : unreadableDocument("no extractable text was found in the document.");
  }
  if (hiddenChars) warnings.push(`${hiddenChars} zero-width/bidirectional-control character(s) were removed before extraction.`);

  // Classification.
  const detected = classifyDocument(doc);
  const requestedType = input.documentType && input.documentType !== "auto" ? input.documentType as DocumentType : null;
  const type: DocumentType = requestedType ?? detected.type;
  let typeMismatch: string | null = null;
  if (requestedType && detected.type !== "other" && detected.type !== requestedType && detected.confidence >= 0.75 && (detected.scores[detected.type] ?? 0) > 2 * (detected.scores[requestedType] ?? 0)) {
    typeMismatch = `documentType "${requestedType}" was supplied, but the content reads as "${detected.type}"; extraction used "${requestedType}" as requested.`;
    warnings.push(typeMismatch);
  }
  const subtype = requestedType ? detectSubtype(type, doc.lower.slice(0, 20_000)) : detected.subtype;

  // Language.
  const detectedLang = detectLanguage(doc.text);
  const language = input.language?.toLowerCase().split("-")[0] ?? detectedLang.language;
  if (!["en", "und"].includes(language)) warnings.push(`Document language "${language}": clause-level pattern extraction is tuned for English; dates, amounts, percentages and currencies are still normalized.`);

  // Injection detection first, so suspicious passages are excluded from every extractor.
  const injections = detectEmbeddedInstructions(doc);
  const ctx: ExtractionContext = {
    doc, type, subtype, dateOrder: inferNumericDateOrder(doc.text), decimalStyle: inferDecimalStyle(doc.text),
    declaredCurrency: null, suspiciousRanges: injections.map(i => [i.start, i.end]), warnings
  };
  if (injections.length) warnings.push(`${injections.length} passage(s) addressed to an AI system were detected in the document and treated as data only (not followed, not extracted as facts).`);

  const labeled = extractLabeledFields(ctx);
  const currencyField = labeled.find(f => f.key === "currency");
  const code = currencyField && /\b([A-Z]{3})\b/.exec(currencyField.value.toUpperCase())?.[1];
  if (code && currencyField) ctx.declaredCurrency = { code, evidence: currencyField.evidence };

  const dates = extractDates(ctx);
  const amounts = extractAmounts(ctx);
  const percentages = extractPercentages(ctx);
  const durations = extractDurations(ctx);
  const { entities, definedRoles } = extractEntities(ctx, labeled);
  const sentences = splitIntoClauseSentences(ctx);
  const clauses = extractClauseFacts(ctx, sentences);
  const obligations = ["contract", "lease", "purchase_order", "policy", "legal_document", "quotation", "other"].includes(type) ? extractObligations(ctx, sentences, definedRoles) : [];
  const requirements = extractRequirements(ctx, sentences, definedRoles);
  const deadlines = extractDeadlines(ctx, sentences);
  const { facts: baseFacts, lineItemsMismatch } = buildFacts(ctx, { labeled, dates, amounts, percents: percentages, durations, clauses, entities, requirements });
  let facts: Fact[] = baseFacts;

  // Requested facts (deterministic first).
  const requests = input.requestedFacts ?? [];
  let { answers, unresolved } = answerRequests(requests, facts);

  // Optional LLM assist, only for what is still missing.
  const llmMode = getDocumentFactsLlmMode();
  const llmEnabled = deps.llmEnabled ?? (llmMode === "auto" && isSynthesisConfigured());
  let llmStatus: DocumentFactsExtractOutput["metadata"]["llmAssist"]["status"] = deps.llmEnabled === false || llmMode === "off" ? "disabled" : llmEnabled ? "not_needed" : "not_configured";
  let verified = 0, rejected = 0;
  const factKeys = new Set(facts.map(f => f.key));
  const questions: LlmQuestion[] = [];
  if (llmEnabled) {
    unresolved.forEach(i => {
      const key = matchRequest(requests[i]!, factKeys)[0]?.key ?? `requested_${i + 1}`;
      questions.push({ id: `r${i + 1}`, key, question: requests[i]! });
    });
    if ((input.mode ?? "auto") === "auto") {
      for (const key of PRIORITY_FACTS[type]) {
        if (!factKeys.has(key) && !questions.some(q => q.key === key) && questions.length < 20 && !["line_items", "parties", "payment_details"].includes(key)) {
          questions.push({ id: `k-${key}`, key, question: `${FACT_LABELS[key] ?? key.replace(/_/g, " ")} (as stated in this ${type.replace(/_/g, " ")})` });
        }
      }
    }
    const synthesizer = deps.synthesizer ?? buildIntelligenceSynthesizer();
    const assist = await llmAssist(synthesizer, ctx, questions, { timeoutMs: Math.max(1000, Math.min(L.llmTimeoutMs, remainingMs - 3000)), requestId: deps.requestId ?? null });
    llmStatus = assist.status;
    verified = assist.verified; rejected = assist.rejected;
    if (assist.status === "failed") warnings.push("LLM assist was unavailable or returned no valid answer; results are from deterministic extraction only.");
    if (rejected) warnings.push(`${rejected} LLM-proposed fact(s) were discarded because their quote was not found verbatim in the document or did not support the value.`);
    const added = assist.facts.filter(f => !factKeys.has(f.key));
    facts = [...facts, ...added];
    // Re-answer requests that were resolved by verified LLM facts.
    for (const i of unresolved) {
      const f = assist.facts.find(x => questions.find(q => q.id === `r${i + 1}`)?.key === x.key);
      if (!f) continue;
      const a: RequestedFact = { request: requests[i]!, status: "found", key: f.key, value: f.value, confidence: f.confidence, method: "llm_verified" };
      if (f.normalizedValue !== undefined) a.normalizedValue = f.normalizedValue;
      if (f.sourceEvidence) a.sourceEvidence = f.sourceEvidence;
      answers[i] = a;
    }
    unresolved = unresolved.filter(i => answers[i]!.status !== "found");
  }

  const riskFlags = assessRisks(ctx, {
    facts, dates, amounts, durations, clauses, injections, lineItemsMismatch,
    macrosPresent: Boolean(loaded.macrosPresent), activeContentText: detectActiveContentText(doc.text), hiddenCharacters: hiddenChars,
    hiddenHtmlElements: loaded.hiddenHtmlElementsRemoved ?? 0, textQuality: textQuality(doc.text),
    emptyPageWarning: loaded.warnings.some(w => /little or no extractable text/.test(w)), typeMismatch
  });

  // Overall confidence: text quality × (fact confidence) × (priority coverage) × classification certainty.
  const quality = textQuality(doc.text);
  const priority = PRIORITY_FACTS[type];
  const covered = priority.filter(k => facts.some(f => f.key === k)).length;
  const coverage = priority.length ? covered / priority.length : 0.5;
  const confs = facts.map(f => f.confidence).sort((a, b) => b - a).slice(0, 25);
  const meanConf = confs.length ? confs.reduce((s, c) => s + c, 0) / confs.length : 0;
  const typeConf = requestedType ? 1 : detected.confidence;
  let overall = confs.length ? meanConf * (0.55 + 0.45 * coverage) * quality * (0.85 + 0.15 * typeConf) : 0;
  if (mode === "requested_only" && requests.length) {
    const found = answers.filter(a => a.status === "found");
    overall = found.length ? (found.reduce((s, a) => s + (a.confidence ?? 0), 0) / found.length) * (found.length / requests.length) * quality : 0;
  }

  const wordCount = (doc.text.match(/\p{L}[\p{L}\p{N}'’-]*/gu) ?? []).length;
  const titleLine = doc.lines().slice(0, 8).find(l => l.text.length >= 4 && l.text.length <= 120 && /\p{L}{3,}/u.test(l.text) && !/^(?:page \d|confidential|draft)\b/i.test(l.text) && !/[:：]\s*\S/.test(l.text));
  const requestedOnly = mode === "requested_only";
  const cap = <T,>(xs: T[]) => xs.slice(0, L.maxItemsPerList);

  let output: DocumentFactsExtractOutput = {
    documentType: type,
    documentSubtype: subtype,
    documentTypeConfidence: requestedType ? 1 : detected.confidence,
    documentTypeSource: requestedType ? "caller" : "detected",
    language,
    title: titleLine ? titleLine.text : null,
    facts: requestedOnly ? facts.filter(f => answers.some(a => a.status === "found" && a.key === f.key)) : facts,
    requestedFacts: answers,
    entities: requestedOnly ? [] : entities,
    dates: requestedOnly ? [] : cap(dates),
    amounts: requestedOnly ? [] : cap(amounts),
    percentages: requestedOnly ? [] : cap(percentages),
    obligations: requestedOnly ? [] : obligations,
    requirements: requestedOnly ? [] : requirements,
    deadlines: requestedOnly ? [] : deadlines,
    riskFlags: requestedOnly ? riskFlags.filter(f => ["embedded_instructions_detected", "macros_present", "low_text_quality"].includes(f.type)) : riskFlags,
    metadata: {
      pageCount: loaded.pageCount ?? doc.pageCount,
      characterCount: doc.text.length,
      wordCount,
      format: loaded.format,
      source: loaded.source,
      pageProvenance: doc.pageStarts !== null,
      extractionMode: mode,
      extractionMethod: verified > 0 ? "deterministic+llm_verified" : "deterministic",
      llmAssist: { status: llmStatus, verifiedFacts: verified, rejectedFacts: rejected },
      extractorVersion: DOCUMENT_FACTS_EXTRACTOR_VERSION
    },
    warnings: [...new Set(warnings)],
    overallConfidence: round2(clamp01(Math.min(0.95, overall))),
    limitations: LIMITATIONS
  };
  if (input.includeSourceEvidence === false) {
    output = { ...output, facts: stripEvidence(output.facts), requestedFacts: stripEvidence(output.requestedFacts), entities: stripEvidence(output.entities), dates: stripEvidence(output.dates), amounts: stripEvidence(output.amounts), percentages: stripEvidence(output.percentages), obligations: stripEvidence(output.obligations), requirements: stripEvidence(output.requirements), deadlines: stripEvidence(output.deadlines), riskFlags: stripEvidence(output.riskFlags) };
  }
  return output;
}
