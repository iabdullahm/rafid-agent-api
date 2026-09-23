import type { AmountItem, DateItem, Fact, RiskFlag } from "../../schemas/documentFactsOutputs.js";
import type { SourceEvidence } from "../document.js";
import { durationInDays } from "../normalize.js";
import type { ExtractionContext } from "./context.js";
import type { ClauseHit } from "./clauses.js";
import type { InjectionFinding } from "./injection.js";
import type { TypedDuration } from "./values.js";

/**
 * Risk flags are OBSERVABLE CONDITIONS in the document ("the text states that the agreement renews
 * automatically", "no expiry date was found", "subtotal + tax ≠ total") — never legal conclusions.
 * Severity is a coarse, rule-defined triage level for the calling agent, listed in RISK_RULES.
 */
export const RISK_RULES = {
  automatic_renewal: "medium", termination_without_cause: "medium", short_termination_notice: "medium", missing_expiry_date: "medium",
  missing_effective_date: "low", missing_currency: "medium", multiple_currencies: "low", contradictory_amounts: "high",
  totals_do_not_reconcile: "high", line_items_do_not_reconcile: "medium", penalty_clause_detected: "medium", unlimited_liability_language: "high",
  no_limitation_of_liability_found: "low", indemnity_clause_detected: "low", missing_signature: "medium", ambiguous_payment_terms: "medium",
  missing_payment_terms: "low", unilateral_amendment_right: "medium", exclusivity_clause_detected: "low", ambiguous_dates: "low",
  missing_invoice_number: "medium", missing_due_date: "low", missing_submission_deadline: "medium", missing_quotation_validity: "low",
  embedded_instructions_detected: "medium", macros_present: "medium", active_content_text: "low", hidden_characters_removed: "low",
  hidden_html_content_removed: "low", low_text_quality: "medium", pages_without_text: "low", document_type_mismatch: "low"
} as const satisfies Record<string, RiskFlag["severity"]>;

export type RiskType = keyof typeof RISK_RULES;

interface RiskInputs {
  facts: readonly Fact[];
  dates: readonly DateItem[];
  amounts: readonly AmountItem[];
  durations: readonly TypedDuration[];
  clauses: readonly ClauseHit[];
  injections: readonly InjectionFinding[];
  lineItemsMismatch: SourceEvidence | null | undefined;
  macrosPresent: boolean;
  activeContentText: boolean;
  hiddenCharacters: number;
  hiddenHtmlElements: number;
  textQuality: number;
  emptyPageWarning: boolean;
  typeMismatch: string | null;
}

export function assessRisks(ctx: ExtractionContext, r: RiskInputs): RiskFlag[] {
  const flags: RiskFlag[] = [];
  const add = (type: RiskType, reason: string, ev?: SourceEvidence) => {
    if (flags.some(f => f.type === type)) return;
    const f: RiskFlag = { type, severity: RISK_RULES[type], reason };
    if (ev) f.sourceEvidence = ev;
    flags.push(f);
  };
  const t = ctx.type;
  const clause = (k: string) => r.clauses.find(c => c.key === k);
  const factOf = (k: string) => r.facts.find(f => f.key === k);
  const evOf = (c: ClauseHit) => ctx.doc.evidence(c.sentence.start, Math.min(c.sentence.end, c.sentence.start + 240));
  const contractLike = t === "contract" || t === "lease";

  // Security / document-integrity observations (any type).
  if (r.injections.length) add("embedded_instructions_detected", `The document contains ${r.injections.length} passage(s) addressed to an AI system or automated reader (e.g. instructions to ignore prior instructions or reveal information). They were treated as document content only, were not followed, and were excluded from obligations, requirements and facts.`, r.injections[0]!.evidence);
  if (r.macrosPresent) add("macros_present", "The document file contains embedded macros (VBA). They were not executed; only the text was read.");
  if (r.activeContentText) add("active_content_text", "The document text contains script- or macro-like strings. They were treated as text and not executed.");
  if (r.hiddenCharacters > 0) add("hidden_characters_removed", `${r.hiddenCharacters} zero-width or bidirectional-override character(s) were removed; such characters can hide or reorder text for human readers.`);
  if (r.hiddenHtmlElements > 0) add("hidden_html_content_removed", `${r.hiddenHtmlElements} HTML element(s) hidden from human readers were excluded from extraction.`);
  if (r.textQuality < 0.6) add("low_text_quality", "A large share of the extracted text is not recognizable words (possible OCR noise, encoding problems or garbled text layer); extracted values are less reliable.");
  if (r.emptyPageWarning) add("pages_without_text", "Some pages have no extractable text (possibly scanned images); facts on those pages could not be extracted.");
  if (r.typeMismatch) add("document_type_mismatch", r.typeMismatch);

  // Contract / lease terms.
  const auto = clause("automatic_renewal");
  if (auto) add("automatic_renewal", "The document states that the term renews automatically.", evOf(auto));
  const tfc = clause("termination_for_convenience");
  if (tfc && contractLike) add("termination_without_cause", "The document allows termination at any time / without cause / for convenience.", evOf(tfc));
  const notice = r.durations.find(d => d.type === "notice_period");
  if (notice && contractLike && durationInDays(notice) <= 14) add("short_termination_notice", `The notice period stated is ${notice.original} (${durationInDays(notice)} days or less than 15 days).`, ctx.doc.evidence(notice.start, notice.end));
  if (contractLike && !factOf("expiry_date") && !r.durations.some(d => d.type === "term") && !factOf("term")) add("missing_expiry_date", "No expiry/end date and no term length were found in the document.");
  if (t === "contract" && !factOf("effective_date") && !factOf("signature_date") && !factOf("document_date")) add("missing_effective_date", "No effective, commencement, signature or document date was found.");
  const penalty = clause("penalty_clause");
  if (penalty && (contractLike || t === "purchase_order" || t === "tender" || t === "quotation")) add("penalty_clause_detected", "The document contains a penalty, liquidated-damages or late-charge provision.", evOf(penalty));
  const unlimited = clause("unlimited_liability");
  if (unlimited) add("unlimited_liability_language", "The document contains language indicating liability without a limit.", evOf(unlimited));
  if (t === "contract" && !clause("limitation_of_liability") && !unlimited) add("no_limitation_of_liability_found", "No limitation-of-liability language was found in the extracted text.");
  const indemnity = clause("indemnity");
  if (indemnity && contractLike) add("indemnity_clause_detected", "The document contains an indemnity / hold-harmless provision.", evOf(indemnity));
  const amend = clause("unilateral_amendment");
  if (amend) add("unilateral_amendment_right", "One party may amend or change terms at its discretion or without notice/consent.", evOf(amend));
  const excl = clause("exclusivity");
  if (excl && contractLike) add("exclusivity_clause_detected", "The document contains exclusivity language.", evOf(excl));
  if (contractLike && !/\b(?:signature|signed(?: by)?|authori[sz]ed signatory|in witness whereof|for and on behalf of|\/s\/|signatory|توقيع)\b/i.test(ctx.doc.text)) {
    add("missing_signature", "No signature block or signature indicator was found in the extracted text (image signatures are not visible to text extraction).");
  }

  // Payment terms.
  const paymentMentioned = /\bpay(?:ment|able)?\b/i.test(ctx.doc.text);
  const vague = /\b(?:as (?:mutually )?agreed|to be (?:agreed|determined|confirmed)|tbd|tba|at a later date|upon satisfaction|at (?:the )?discretion of)\b/i.exec(ctx.doc.text);
  const vagueNearPayment = vague && /pay/i.test(ctx.doc.text.slice(Math.max(0, vague.index - 120), vague.index + 60));
  if (vagueNearPayment) add("ambiguous_payment_terms", "Payment terms are stated in non-specific terms (e.g. 'as agreed', 'to be determined').", ctx.doc.evidence(vague!.index, vague!.index + vague![0].length));
  else if ((contractLike || t === "invoice" || t === "purchase_order" || t === "quotation") && paymentMentioned && !factOf("payment_terms") && !factOf("due_date") && !r.durations.some(d => d.type === "payment_terms")) {
    add("missing_payment_terms", "Payment is mentioned but no payment timeframe or due date was found.");
  }

  // Amount consistency.
  const monetaryTypes = ["invoice", "purchase_order", "quotation", "contract", "lease", "tender"];
  if (monetaryTypes.includes(t) && r.amounts.length && r.amounts.every(a => !a.currency)) {
    add("missing_currency", r.amounts.some(a => a.currencySymbol) ? "Amounts use a currency symbol shared by several currencies and no ISO currency is stated." : "Amounts are stated without any currency.", r.amounts[0]!.sourceEvidence);
  }
  const currencies = new Set(r.amounts.filter(a => ["total", "subtotal", "contract_value", "rent"].includes(a.type) && a.currency).map(a => a.currency));
  if (currencies.size > 1) add("multiple_currencies", `Key amounts are stated in more than one currency (${[...currencies].join(", ")}).`);
  for (const type of ["total", "contract_value", "rent", "security_deposit", "subtotal"]) {
    const same = r.amounts.filter(a => a.type === type && a.frequency !== "monthly" && a.frequency !== "annual");
    const byCur = new Map<string, Set<number>>();
    for (const a of same) { const k = a.currency ?? "?"; if (!byCur.has(k)) byCur.set(k, new Set()); byCur.get(k)!.add(a.amount); }
    for (const [, values] of byCur) {
      if (values.size > 1 && (type !== "total" || t === "invoice" || t === "quotation" || t === "purchase_order" || t === "contract")) {
        const ev = same.find(a => a.amount === [...values][1])?.sourceEvidence;
        add("contradictory_amounts", `The document states different values for ${type.replace(/_/g, " ")} (${[...values].join(" vs ")}).`, ev);
      }
    }
  }
  if (t === "invoice" || t === "quotation" || t === "purchase_order") {
    const pick = (k: string) => r.facts.find(f => f.key === k)?.normalizedValue as { amount?: number; currency?: string } | undefined;
    const sub = pick("subtotal"), tax = pick("tax_amount"), total = pick("total_amount"), discount = pick("discount");
    if (sub?.amount !== undefined && tax?.amount !== undefined && total?.amount !== undefined) {
      const expected = sub.amount + tax.amount - (discount?.amount ?? 0);
      const alt = sub.amount + tax.amount;
      const tol = Math.max(0.011, total.amount * 0.001);
      if (Math.abs(expected - total.amount) > tol && Math.abs(alt - total.amount) > tol) {
        add("totals_do_not_reconcile", `Subtotal (${sub.amount}) + tax (${tax.amount})${discount?.amount ? ` − discount (${discount.amount})` : ""} does not equal the stated total (${total.amount}).`, r.facts.find(f => f.key === "total_amount")?.sourceEvidence);
      }
    }
    if (r.lineItemsMismatch) add("line_items_do_not_reconcile", "The sum of the line items does not equal the stated subtotal/total.", r.lineItemsMismatch);
  }
  if (t === "invoice" && !factOf("invoice_number")) add("missing_invoice_number", "No invoice number was found.");
  if (t === "invoice" && !factOf("due_date") && !r.durations.some(d => d.type === "payment_terms") && !factOf("payment_terms")) add("missing_due_date", "No due date or payment period was found.");
  if (t === "tender" && !factOf("submission_deadline")) add("missing_submission_deadline", "No submission deadline was found.");
  if (t === "quotation" && !factOf("valid_until") && !r.durations.some(d => d.type === "validity_period")) add("missing_quotation_validity", "No validity date or validity period was found for the quotation.");
  if (r.dates.some(d => !d.normalizedDate && d.precision === "day")) add("ambiguous_dates", "Some numeric dates cannot be normalized because the day/month order is ambiguous in this document.");
  return flags;
}
