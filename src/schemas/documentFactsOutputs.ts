import { z } from "zod";
import { DOCUMENT_TYPES } from "./documentFactsInputs.js";

/**
 * document_facts_extract output — a stable, machine-readable contract. Every assertion carries a
 * 0–1 `confidence` (extraction certainty, never business risk) and, whenever the document supports
 * it, `sourceEvidence` pointing back into the document: a short verbatim excerpt, character
 * offsets into the extracted text, the section heading, and the page number ONLY when the source
 * format has real pages. Normalized values are provided only when normalization is unambiguous;
 * the original text is always kept.
 */
const confidence = z.number().min(0).max(1);

export const sourceEvidenceSchema = z.strictObject({
  page: z.number().int().min(1).optional().describe("1-based page number — present only when the source has real page boundaries (never inferred)."),
  section: z.string().optional().describe("Nearest preceding section heading."),
  text: z.string().describe("Short verbatim excerpt (whitespace-collapsed) containing the value."),
  startOffset: z.number().int().min(0).describe("Start character offset of the matched value in the extracted text."),
  endOffset: z.number().int().min(0)
});

const extractionMethod = z.enum(["labeled_field", "pattern", "clause", "table", "definition", "llm_verified"]);

export const factSchema = z.strictObject({
  key: z.string().describe("Stable snake_case fact key, e.g. expiry_date, invoice_number, total_amount, notice_period."),
  label: z.string().describe("Human-readable label."),
  value: z.unknown().describe("The value as stated (string, number, boolean, list or object)."),
  normalizedValue: z.unknown().optional().describe("Normalized form when unambiguous: ISO date, {amount, currency}, ratio, {value, unit, iso8601}."),
  confidence,
  method: extractionMethod.describe("How the fact was established. llm_verified = proposed by the optional LLM assist AND verified against a verbatim quote in the document."),
  sourceEvidence: sourceEvidenceSchema.optional()
});

export const requestedFactSchema = z.strictObject({
  request: z.string().describe("The requested fact, as asked."),
  status: z.enum(["found", "not_found"]),
  key: z.string().nullable().describe("The fact key that answers it, when found."),
  value: z.unknown().describe("The value when found; null when not found."),
  normalizedValue: z.unknown().optional(),
  confidence: confidence.nullable().describe("Null when not found — absence is reported, never guessed."),
  method: extractionMethod.nullable(),
  sourceEvidence: sourceEvidenceSchema.optional(),
  note: z.string().optional().describe("Why it was not found, or a caveat about the match.")
});

export const entitySchema = z.strictObject({
  type: z.enum(["person", "company", "organization", "government", "location", "other"]),
  name: z.string(),
  role: z.string().optional().describe("Role in the document when stated, e.g. supplier, customer, landlord, tenant, issuer."),
  confidence,
  sourceEvidence: sourceEvidenceSchema.optional()
});

export const dateSchema = z.strictObject({
  type: z.string().describe("e.g. effective_date, expiry_date, invoice_date, due_date, submission_deadline, or date when untyped."),
  originalValue: z.string(),
  normalizedDate: z.string().optional().describe("ISO 8601 (YYYY-MM-DD, or YYYY-MM for month precision). Absent when the written form is ambiguous."),
  precision: z.enum(["day", "month"]),
  confidence,
  sourceEvidence: sourceEvidenceSchema.optional()
});

export const amountSchema = z.strictObject({
  type: z.string().describe("e.g. total, subtotal, tax, contract_value, rent, deposit, bid_bond, penalty, or amount when untyped."),
  amount: z.number(),
  currency: z.string().optional().describe("ISO 4217 code when stated unambiguously (or declared by a Currency field in the document)."),
  currencySymbol: z.string().optional().describe("The currency marker as written when it maps to more than one currency (e.g. \"$\")."),
  frequency: z.enum(["one_time", "daily", "weekly", "monthly", "quarterly", "annual"]).optional(),
  originalValue: z.string(),
  confidence,
  sourceEvidence: sourceEvidenceSchema.optional()
});

export const percentageSchema = z.strictObject({
  type: z.string().describe("e.g. tax_rate, late_payment_interest, penalty_rate, discount, uptime, evaluation_weight, or percentage when untyped."),
  value: z.number().describe("As written, e.g. 5 for 5%."),
  ratio: z.number().describe("Normalized ratio, e.g. 0.05."),
  originalValue: z.string(),
  confidence,
  sourceEvidence: sourceEvidenceSchema.optional()
});

export const obligationSchema = z.strictObject({
  party: z.string().optional(),
  obligation: z.string(),
  modality: z.enum(["must", "must_not"]).describe("must_not = a prohibition (\"shall not\")."),
  deadline: z.string().optional(),
  condition: z.string().optional(),
  confidence,
  sourceEvidence: sourceEvidenceSchema.optional()
});

export const requirementSchema = z.strictObject({
  requirement: z.string(),
  category: z.enum(["eligibility", "technical", "financial", "documentation", "compliance", "general"]),
  party: z.string().optional(),
  deadline: z.string().optional(),
  mandatory: z.boolean(),
  confidence,
  sourceEvidence: sourceEvidenceSchema.optional()
});

export const deadlineSchema = z.strictObject({
  type: z.string(),
  date: z.string().optional().describe("ISO date when the deadline is a calendar date."),
  relative: z.string().optional().describe("Relative deadline as written, e.g. \"within 30 days of receipt of invoice\"."),
  description: z.string(),
  confidence,
  sourceEvidence: sourceEvidenceSchema.optional()
});

export const riskFlagSchema = z.strictObject({
  type: z.string().describe("Observable condition, e.g. automatic_renewal, missing_expiry_date, contradictory_amounts, unlimited_liability_language, embedded_instructions_detected."),
  severity: z.enum(["low", "medium", "high"]),
  reason: z.string().describe("The observable condition in the document — never a legal conclusion."),
  sourceEvidence: sourceEvidenceSchema.optional()
});

export const documentFactsExtractOutput = z.strictObject({
  documentType: z.enum(DOCUMENT_TYPES),
  documentSubtype: z.string().nullable().describe("Finer classification when evident, e.g. service_agreement, insurance_policy, tax_invoice, rfp."),
  documentTypeConfidence: confidence,
  documentTypeSource: z.enum(["detected", "caller"]),
  language: z.string().describe("ISO 639-1 code, or \"und\" when undetermined."),
  title: z.string().nullable(),
  facts: z.array(factSchema),
  requestedFacts: z.array(requestedFactSchema).describe("One entry per requested fact, in request order (empty when none were requested)."),
  entities: z.array(entitySchema),
  dates: z.array(dateSchema),
  amounts: z.array(amountSchema),
  percentages: z.array(percentageSchema),
  obligations: z.array(obligationSchema),
  requirements: z.array(requirementSchema),
  deadlines: z.array(deadlineSchema),
  riskFlags: z.array(riskFlagSchema),
  metadata: z.strictObject({
    pageCount: z.number().int().nullable(),
    characterCount: z.number().int(),
    wordCount: z.number().int(),
    format: z.enum(["pdf", "docx", "html", "text", "markdown", "csv"]),
    source: z.strictObject({ kind: z.enum(["url", "text"]), url: z.string().nullable(), contentType: z.string().nullable(), byteLength: z.number().int().nullable() }),
    pageProvenance: z.boolean().describe("true when evidence page numbers come from real page boundaries."),
    extractionMode: z.enum(["auto", "requested_only"]),
    extractionMethod: z.enum(["deterministic", "deterministic+llm_verified"]),
    llmAssist: z.strictObject({
      status: z.enum(["not_configured", "disabled", "not_needed", "used", "failed"]),
      verifiedFacts: z.number().int(),
      rejectedFacts: z.number().int().describe("LLM proposals discarded because their quote was not found verbatim in the document or did not support the value.")
    }),
    extractorVersion: z.string()
  }),
  warnings: z.array(z.string()),
  overallConfidence: confidence.describe("Overall extraction certainty for this document (text quality × fact coverage × fact confidence). Not a measure of business risk."),
  limitations: z.array(z.string())
});

export type DocumentFactsExtractOutput = z.infer<typeof documentFactsExtractOutput>;
export type Fact = z.infer<typeof factSchema>;
export type RequestedFact = z.infer<typeof requestedFactSchema>;
export type Entity = z.infer<typeof entitySchema>;
export type DateItem = z.infer<typeof dateSchema>;
export type AmountItem = z.infer<typeof amountSchema>;
export type PercentageItem = z.infer<typeof percentageSchema>;
export type Obligation = z.infer<typeof obligationSchema>;
export type Requirement = z.infer<typeof requirementSchema>;
export type Deadline = z.infer<typeof deadlineSchema>;
export type RiskFlag = z.infer<typeof riskFlagSchema>;
export type SourceEvidenceOut = z.infer<typeof sourceEvidenceSchema>;
