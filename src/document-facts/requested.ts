import type { Fact, RequestedFact } from "../schemas/documentFactsOutputs.js";
import { FACT_LABELS } from "./extract/facts.js";

/**
 * Maps plain-language fact requests ("contract expiry date", "termination notice period",
 * "annual contract value") onto extracted fact keys. Matching is lexical and explainable: each
 * fact key has aliases; a request matches the key whose alias tokens it covers best. A request
 * with no sufficiently strong match is reported not_found — never guessed.
 */
export const FACT_ALIASES: Record<string, readonly string[]> = {
  expiry_date: ["expiry date", "expiration date", "end date", "expire", "expiry", "contract end", "termination date", "lease end", "valid until", "end of term", "policy expiry"],
  effective_date: ["effective date", "start date", "commencement date", "begin date", "start", "commencement", "lease start", "policy start", "inception"],
  notice_period: ["notice period", "termination notice", "notice", "notice required", "days notice"],
  contract_value: ["contract value", "contract price", "total value", "consideration", "contract amount", "contract sum", "fee", "fees", "agreement value", "annual contract value", "annual value"],
  payment_terms: ["payment terms", "terms of payment", "payment conditions", "when payment", "payment schedule", "net days"],
  payment_period: ["payment period", "payment within", "days to pay"],
  term: ["term", "duration", "contract term", "contract period", "length of contract", "lease term", "period"],
  renewal_terms: ["renewal", "renewal terms", "renew", "extension"],
  automatic_renewal: ["automatic renewal", "auto renewal", "auto renew", "renews automatically", "evergreen"],
  termination_clause: ["termination", "termination clause", "terminate", "termination rights"],
  termination_for_convenience: ["termination for convenience", "terminate without cause"],
  governing_law: ["governing law", "applicable law", "jurisdiction", "law"],
  dispute_resolution: ["dispute resolution", "arbitration", "disputes", "courts"],
  penalty_clause: ["penalty", "penalties", "liquidated damages", "late fee", "late penalty", "delay damages"],
  service_level: ["sla", "service level", "uptime", "response time"],
  limitation_of_liability: ["limitation of liability", "liability cap", "liability limit", "liability"],
  liability_cap: ["liability cap amount", "maximum liability"],
  warranties: ["warranty", "warranties", "guarantee"],
  warranty_period: ["warranty period", "guarantee period"],
  parties: ["parties", "party", "counterparties", "who signed", "contracting parties"],
  supplier: ["supplier", "vendor", "seller", "contractor", "service provider", "issued by", "from"],
  customer: ["customer", "client", "buyer", "purchaser", "bill to", "billed to"],
  invoice_number: ["invoice number", "invoice no", "invoice id", "invoice reference"],
  invoice_date: ["invoice date", "date of invoice", "issue date"],
  due_date: ["due date", "payment due", "payment deadline", "due"],
  subtotal: ["subtotal", "sub total", "net amount", "amount before tax"],
  tax_amount: ["tax", "vat", "tax amount", "vat amount", "gst"],
  tax_rate: ["tax rate", "vat rate", "gst rate"],
  total_amount: ["total", "total amount", "grand total", "amount due", "invoice total", "total due", "balance due", "order total", "total price"],
  currency: ["currency"],
  payment_details: ["payment details", "bank details", "bank account", "iban", "account number", "swift", "remittance"],
  line_items: ["line items", "items", "products", "goods", "quantities", "unit prices"],
  po_number: ["po number", "purchase order number", "order number", "po"],
  delivery_location: ["delivery location", "delivery address", "ship to", "deliver to", "place of delivery"],
  delivery_date: ["delivery date", "delivery deadline", "deliver by", "shipping date"],
  quotation_number: ["quotation number", "quote number", "offer number"],
  valid_until: ["valid until", "validity", "quote validity", "offer validity", "expiry of quotation"],
  issuer: ["issuer", "issuing authority", "procuring entity", "tendering authority", "employer", "client"],
  tender_number: ["tender number", "rfp number", "reference number of tender", "bid number"],
  submission_deadline: ["submission deadline", "closing date", "bid deadline", "deadline", "submission date", "due date for bids"],
  eligibility_requirements: ["eligibility", "eligibility requirements", "qualification requirements", "who can bid"],
  technical_requirements: ["technical requirements", "technical specifications", "specifications"],
  financial_requirements: ["financial requirements", "financial criteria", "turnover requirement"],
  mandatory_documents: ["mandatory documents", "required documents", "documents to submit", "submission documents"],
  evaluation_criteria: ["evaluation criteria", "award criteria", "scoring", "evaluation"],
  bid_bond: ["bid bond", "bid security", "tender bond", "bid guarantee"],
  performance_bond: ["performance bond", "performance guarantee", "performance security"],
  landlord: ["landlord", "lessor", "owner"],
  tenant: ["tenant", "lessee", "occupant"],
  property: ["property", "premises", "property address", "leased property"],
  unit: ["unit", "unit number", "apartment", "flat", "villa"],
  rent: ["rent", "rental", "monthly rent", "annual rent", "rent amount", "lease payment"],
  security_deposit: ["deposit", "security deposit"],
  payment_frequency: ["payment frequency", "how often", "rent frequency"],
  policy_number: ["policy number", "policy no"],
  insurer: ["insurer", "insurance company", "underwriter"],
  insured: ["insured", "policyholder", "policy holder"],
  premium: ["premium", "insurance premium"],
  sum_insured: ["sum insured", "coverage limit", "limit of indemnity", "coverage amount"],
  deductible: ["deductible", "excess"],
  revenue: ["revenue", "turnover", "sales"],
  net_income: ["net income", "net profit", "profit", "earnings"],
  total_assets: ["total assets", "assets"],
  total_liabilities: ["total liabilities", "liabilities"],
  total_equity: ["equity", "shareholders equity", "total equity"],
  period_end: ["period end", "reporting period", "year end", "fiscal year end"],
  auditor: ["auditor", "audit firm"],
  person_name: ["name", "candidate name", "full name", "applicant"],
  email: ["email", "email address", "e-mail"],
  phone: ["phone", "telephone", "mobile", "contact number"],
  job_title: ["job title", "current position", "title", "designation", "role"],
  total_experience_years: ["years of experience", "experience", "total experience"],
  education: ["education", "degree", "qualifications", "academic"],
  skills: ["skills", "competencies", "expertise"],
  company_name: ["company name", "company", "organization name", "legal name"],
  founded: ["founded", "established", "year founded", "incorporation"],
  address: ["address", "headquarters", "location", "registered office"],
  website: ["website", "url", "web"],
  services: ["services", "products", "offerings", "what they do"],
  case_number: ["case number", "case no", "claim number"],
  court: ["court", "tribunal"],
  document_date: ["document date", "date", "dated", "date of document"],
  signature_date: ["signature date", "signing date", "date signed", "execution date"],
  reference_number: ["reference number", "reference", "ref"],
  tax_id: ["tax id", "vat number", "tax number", "trn", "tin"],
  registration_number: ["registration number", "cr number", "company number", "commercial registration"],
  indemnity: ["indemnity", "indemnification", "hold harmless"],
  confidentiality: ["confidentiality", "non disclosure", "nda"],
  force_majeure: ["force majeure"],
  exclusivity: ["exclusivity", "exclusive"],
  late_payment_interest: ["late payment interest", "interest on late payment", "late interest"],
  discount_rate: ["discount rate", "discount percentage"],
  discount: ["discount", "discount amount"],
  advance_payment: ["advance payment", "down payment"],
  delivery_terms: ["delivery terms", "incoterms", "lead time"],
  delivery_time: ["delivery time", "delivery period", "lead time"],
  validity_period: ["validity period", "valid for"],
  cure_period: ["cure period", "remedy period"],
  escalation: ["escalation", "rent increase", "price increase", "indexation"]
};

const STOP = new Set(["the", "a", "an", "of", "for", "what", "is", "are", "in", "on", "this", "that", "document", "contract", "agreement", "please", "tell", "me", "give", "find", "extract", "which", "who", "when", "how", "much", "many", "does", "do", "it", "its", "their", "there", "any", "to", "and", "or", "with", "by", "from", "under", "was", "were", "be", "has", "have", "state", "stated", "listed", "specified"]);
const stem = (w: string) => w.length <= 4 ? w : w.replace(/(?:ations?|ing|ies|es|ed|s|y|e)$/, "");
export const tokens = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").split(/\s+/).filter(w => w && !STOP.has(w)).map(stem);

export interface RequestMatch { key: string; score: number }

/** Best-matching fact keys for one request (highest score first). Score ∈ [0,1]. */
export function matchRequest(request: string, availableKeys: Iterable<string>): RequestMatch[] {
  const req = new Set(tokens(request));
  const reqRaw = request.toLowerCase();
  if (!req.size) return [];
  const results: RequestMatch[] = [];
  const keys = new Set([...Object.keys(FACT_ALIASES), ...availableKeys]);
  for (const key of keys) {
    const aliases = [...(FACT_ALIASES[key] ?? []), key.replace(/^field_/, "").replace(/_/g, " "), (FACT_LABELS[key] ?? "").toLowerCase()].filter(Boolean);
    let best = 0;
    for (const alias of aliases) {
      const at = tokens(alias);
      if (!at.length) continue;
      const covered = at.filter(t => req.has(t)).length;
      let score = covered / at.length;               // alias fully present in the request
      score *= 0.7 + 0.3 * (covered / req.size);     // and the request is mostly about this alias
      if (reqRaw.includes(alias)) score = Math.max(score, 0.9 + Math.min(0.1, alias.length / 200));
      best = Math.max(best, score);
    }
    if (best >= 0.5) results.push({ key, score: Math.round(best * 1000) / 1000 });
  }
  return results.sort((a, b) => b.score - a.score);
}

export function answerRequests(requests: readonly string[], facts: readonly Fact[]): { answers: RequestedFact[]; unresolved: number[] } {
  const byKey = new Map(facts.map(f => [f.key, f]));
  const answers: RequestedFact[] = [];
  const unresolved: number[] = [];
  requests.forEach((request, i) => {
    const matches = matchRequest(request, byKey.keys());
    const hit = matches.find(m => byKey.has(m.key));
    const top = matches[0];
    // Only accept an available fact if it is (near-)best among ALL candidate keys — otherwise the
    // request is about something else that simply wasn't found.
    if (hit && top && hit.score >= top.score - 0.15) {
      const f = byKey.get(hit.key)!;
      const a: RequestedFact = { request, status: "found", key: f.key, value: f.value, confidence: Math.round(f.confidence * Math.min(1, 0.75 + hit.score / 4) * 100) / 100, method: f.method };
      if (f.normalizedValue !== undefined) a.normalizedValue = f.normalizedValue;
      if (f.sourceEvidence) a.sourceEvidence = f.sourceEvidence;
      const freq = (f.normalizedValue as { frequency?: string } | undefined)?.frequency;
      if (/\bannual|yearly|per year\b/i.test(request) && freq && freq !== "annual") a.note = `The document states a ${freq} figure; no annual figure is stated (not computed).`;
      if (/\bmonthly|per month\b/i.test(request) && freq && freq !== "monthly") a.note = `The document states a ${freq} figure; no monthly figure is stated (not computed).`;
      answers.push(a);
    } else {
      answers.push({ request, status: "not_found", key: top?.key ?? null, value: null, confidence: null, method: null, note: "No statement in the document establishes this fact." });
      unresolved.push(i);
    }
  });
  return { answers, unresolved };
}
