import type { AmountItem, DateItem, Entity, Fact, PercentageItem, Requirement } from "../../schemas/documentFactsOutputs.js";
import type { DocumentType } from "../../schemas/documentFactsInputs.js";
import { DOCUMENT_FACTS_LIMITS as L } from "../config.js";
import { collapse, type SourceEvidence } from "../document.js";
import { durationInDays, findAmounts, findDates, findDurations, findPercentages, parseBareAmount } from "../normalize.js";
import { inSuspicious, round2, type ExtractionContext } from "./context.js";
import { extractLineItems, listsUnderHeadings, parseEvaluationCriteria, type ClauseHit, type LineItem } from "./clauses.js";
import type { LabeledField } from "./labels.js";
import type { TypedDuration } from "./values.js";

/**
 * Assembles the document's key facts from every extraction layer, with document-type-aware
 * priorities. One fact per key (the most certain source wins: labeled field > typed value >
 * clause), each with its own evidence.
 */

export const PRIORITY_FACTS: Record<DocumentType, readonly string[]> = {
  contract: ["parties", "effective_date", "expiry_date", "term", "contract_value", "payment_terms", "renewal_terms", "termination_clause", "notice_period", "penalty_clause", "service_level", "governing_law", "limitation_of_liability", "warranties"],
  invoice: ["supplier", "customer", "invoice_number", "invoice_date", "due_date", "subtotal", "tax_amount", "total_amount", "currency", "payment_details", "line_items"],
  purchase_order: ["po_number", "supplier", "customer", "line_items", "total_amount", "currency", "delivery_location", "delivery_date"],
  quotation: ["quotation_number", "supplier", "customer", "document_date", "valid_until", "total_amount", "currency", "payment_terms", "delivery_terms"],
  tender: ["issuer", "tender_number", "submission_deadline", "eligibility_requirements", "technical_requirements", "financial_requirements", "bid_bond", "performance_bond", "mandatory_documents", "evaluation_criteria"],
  lease: ["landlord", "tenant", "property", "unit", "effective_date", "expiry_date", "rent", "security_deposit", "payment_frequency", "renewal_terms", "notice_period"],
  policy: ["policy_number", "insurer", "insured", "effective_date", "expiry_date", "premium", "sum_insured", "deductible"],
  financial_report: ["company_name", "period_end", "revenue", "net_income", "total_assets", "total_liabilities", "total_equity", "currency", "auditor"],
  legal_document: ["case_number", "court", "claimant", "respondent", "document_date", "parties", "governing_law"],
  resume: ["person_name", "email", "phone", "job_title", "total_experience_years", "education", "skills"],
  company_profile: ["company_name", "founded", "address", "website", "email", "phone", "services"],
  other: ["document_date", "reference_number", "parties"]
};

export const FACT_LABELS: Record<string, string> = {
  parties: "Parties", effective_date: "Effective / start date", expiry_date: "Expiry / end date", term: "Term", contract_value: "Contract value",
  payment_terms: "Payment terms", renewal_terms: "Renewal", automatic_renewal: "Automatic renewal", termination_clause: "Termination",
  notice_period: "Notice period", penalty_clause: "Penalty / liquidated damages", service_level: "Service level (SLA)", governing_law: "Governing law",
  limitation_of_liability: "Limitation of liability", warranties: "Warranties", supplier: "Supplier", customer: "Customer / buyer",
  invoice_number: "Invoice number", invoice_date: "Invoice date", due_date: "Due date", subtotal: "Subtotal", tax_amount: "Tax amount",
  tax_rate: "Tax rate", total_amount: "Total amount", currency: "Currency", payment_details: "Payment details", line_items: "Line items",
  po_number: "Purchase order number", delivery_location: "Delivery location", delivery_date: "Delivery date / deadline",
  quotation_number: "Quotation number", document_date: "Document date", valid_until: "Valid until", delivery_terms: "Delivery terms",
  issuer: "Issuer", tender_number: "Tender number", submission_deadline: "Submission deadline", eligibility_requirements: "Eligibility requirements",
  technical_requirements: "Technical requirements", financial_requirements: "Financial requirements", bid_bond: "Bid bond",
  performance_bond: "Performance bond", mandatory_documents: "Mandatory documents", evaluation_criteria: "Evaluation criteria",
  landlord: "Landlord", tenant: "Tenant", property: "Property", unit: "Unit", rent: "Rent", security_deposit: "Security deposit",
  payment_frequency: "Payment frequency", policy_number: "Policy number", insurer: "Insurer", insured: "Insured", premium: "Premium",
  sum_insured: "Sum insured / limit", deductible: "Deductible", company_name: "Company name", period_end: "Reporting period end",
  period_start: "Reporting period start", revenue: "Revenue", net_income: "Net income", total_assets: "Total assets",
  total_liabilities: "Total liabilities", total_equity: "Total equity", auditor: "Auditor", case_number: "Case number", court: "Court",
  claimant: "Claimant", respondent: "Respondent", person_name: "Name", email: "Email", phone: "Phone", job_title: "Current title",
  total_experience_years: "Years of experience", education: "Education", skills: "Skills", founded: "Founded", address: "Address",
  website: "Website", services: "Services", reference_number: "Reference number", signature_date: "Signature date", order_date: "Order date",
  iban: "IBAN", swift_code: "SWIFT/BIC", account_number: "Account number", bank_name: "Bank", account_name: "Account name", tax_id: "Tax ID",
  registration_number: "Registration number", indemnity: "Indemnity", confidentiality: "Confidentiality", force_majeure: "Force majeure",
  dispute_resolution: "Dispute resolution", exclusivity: "Exclusivity", unilateral_amendment: "Unilateral amendment right",
  termination_for_convenience: "Termination for convenience", unlimited_liability: "Unlimited liability language", liability_cap: "Liability cap",
  warranty_period: "Warranty period", cure_period: "Cure period", delivery_time: "Delivery time", validity_period: "Validity period",
  late_payment_interest: "Late-payment interest", penalty_rate: "Penalty rate", discount: "Discount", advance_payment: "Advance payment",
  retention: "Retention", escalation: "Price / rent escalation", uptime: "Uptime / availability", contract_number: "Contract number",
  employee_count: "Employees", reported_unit_scale: "Reported unit scale", reporting_period: "Reporting period", subject: "Subject", scope: "Scope",
  tender_fee: "Tender document fee", share_capital: "Share capital", salary: "Salary", probation_period: "Probation period",
  renewal_term: "Renewal term", agreement_date: "Agreement date", payment_date: "Payment date", unit_price: "Unit price", premium_frequency: "Premium frequency"
};

const humanize = (k: string) => FACT_LABELS[k] ?? k.replace(/^field_/, "").replace(/_/g, " ").replace(/^\w/, c => c.toUpperCase());

interface Builder { facts: Map<string, Fact>; ctx: ExtractionContext; lineItemsMismatch?: SourceEvidence | null }

function put(b: Builder, f: Omit<Fact, "label"> & { label?: string }) {
  const fact = { key: f.key, label: f.label ?? humanize(f.key), value: f.value, ...(f.normalizedValue !== undefined ? { normalizedValue: f.normalizedValue } : {}), confidence: f.confidence, method: f.method, ...(f.sourceEvidence ? { sourceEvidence: f.sourceEvidence } : {}) } as Fact;
  const prev = b.facts.get(fact.key);
  const rank = (m: Fact["method"]) => ({ labeled_field: 4, definition: 4, table: 3, pattern: 2, clause: 1, llm_verified: 0 })[m];
  if (!prev || fact.confidence > prev.confidence + 0.05 || (Math.abs(fact.confidence - prev.confidence) <= 0.05 && rank(fact.method) > rank(prev.method))) b.facts.set(fact.key, fact);
}

const moneyValue = (a: { amount: number; currency?: string; frequency?: string }) => ({ amount: a.amount, ...(a.currency ? { currency: a.currency } : {}), ...(a.frequency ? { frequency: a.frequency } : {}) });

// ---- Labeled fields -----------------------------------------------------------------------------

function fromLabeled(b: Builder, fields: readonly LabeledField[]) {
  const { ctx } = b;
  for (const f of fields) {
    const base = { key: f.key, label: f.mapped ? undefined : f.label, method: "labeled_field" as const, sourceEvidence: f.evidence };
    switch (f.kind) {
      case "date": {
        const d = findDates(f.value, ctx.dateOrder)[0];
        if (!d) { if (/^(?:from|to)$/i.test(f.label)) continue; if (f.key === "document_date") continue; put(b, { ...base, value: f.value, confidence: 0.6 }); continue; }
        let key = f.key;
        if (key === "document_date" && ctx.type === "invoice") key = "invoice_date";
        const s = f.valueStart + d.start;
        put(b, { ...base, key, value: d.original, ...(d.normalized ? { normalizedValue: d.normalized } : {}), confidence: round2(d.ambiguous ? 0.5 : 0.93 * d.certainty), sourceEvidence: ctx.doc.evidence(s, s + d.original.length) });
        break;
      }
      case "amount": {
        const a = findAmounts(f.value, ctx.decimalStyle).find(x => x.amount !== null);
        if (a) {
          const s = f.valueStart + a.start;
          put(b, { ...base, value: a.original, normalizedValue: moneyValue({ amount: a.amount!, currency: a.currency }), confidence: a.ambiguousCurrency ? 0.78 : 0.93, sourceEvidence: ctx.doc.evidence(s, s + a.original.length) });
        } else {
          const bare = parseBareAmount(f.value.replace(/[^\d.,' ()]/g, "").trim(), ctx.decimalStyle);
          if (bare === null) { put(b, { ...base, value: f.value, confidence: 0.6 }); continue; }
          put(b, { ...base, value: f.value, normalizedValue: moneyValue({ amount: bare, currency: ctx.declaredCurrency?.code }), confidence: ctx.declaredCurrency ? 0.85 : 0.8 });
        }
        break;
      }
      case "percent": {
        const p = findPercentages(f.value)[0];
        put(b, { ...base, value: f.value, ...(p ? { normalizedValue: p.ratio } : {}), confidence: p ? 0.9 : 0.65 });
        break;
      }
      case "duration": {
        const d = findDurations(f.value)[0];
        put(b, { ...base, value: f.value, ...(d ? { normalizedValue: { value: d.value, unit: d.unit, iso8601: d.iso, approxDays: durationInDays(d) } } : {}), confidence: d ? 0.9 : 0.65 });
        break;
      }
      case "currency": {
        const code = /\b([A-Z]{3})\b/.exec(f.value.toUpperCase())?.[1];
        put(b, { ...base, value: f.value, ...(code ? { normalizedValue: code } : {}), confidence: code ? 0.93 : 0.6 });
        break;
      }
      case "list": {
        const items = f.value.split(/\s*[,;|•·]\s*/).map(x => x.trim()).filter(x => x.length > 1 && x.length < 80);
        if (items.length) put(b, { ...base, value: items, confidence: 0.85 });
        break;
      }
      case "email": {
        const e = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/.exec(f.value)?.[0];
        if (e) put(b, { ...base, value: e, confidence: 0.95 });
        break;
      }
      case "id": {
        const v = f.value.split(/\s{2,}|\t/)[0]!.replace(/^[#:]\s*/, "").trim();
        if (v && v.length <= 60) put(b, { ...base, value: v, confidence: /\d/.test(v) ? 0.93 : 0.8 });
        break;
      }
      case "party": {
        const name = f.value.split(/\s{2,}|\t|,\s(?=\d)/)[0]!.trim();
        if (!/\p{L}{2,}/u.test(name) || findDates(name).length) continue;
        put(b, { ...base, value: name, confidence: 0.88 });
        break;
      }
      default:
        put(b, { ...base, value: f.value, confidence: f.mapped ? 0.88 : 0.7 });
    }
  }
}

// ---- Typed values ----------------------------------------------------------------------------------

const DATE_FACTS = new Set(["agreement_date", "invoice_date", "due_date", "order_date", "submission_deadline", "valid_until", "effective_date", "expiry_date", "delivery_date", "signature_date", "period_end", "period_start", "payment_date", "issue_date"]);
const AMOUNT_FACTS: Record<string, string> = {
  subtotal: "subtotal", total: "total_amount", tax: "tax_amount", discount: "discount", bid_bond: "bid_bond", performance_bond: "performance_bond",
  tender_fee: "tender_fee", security_deposit: "security_deposit", advance_payment: "advance_payment", rent: "rent", liability_cap: "liability_cap",
  premium: "premium", sum_insured: "sum_insured", deductible: "deductible", contract_value: "contract_value", revenue: "revenue", net_income: "net_income",
  total_assets: "total_assets", total_liabilities: "total_liabilities", total_equity: "total_equity", share_capital: "share_capital", salary: "salary"
};

function fromValues(b: Builder, dates: readonly DateItem[], amounts: readonly AmountItem[], percents: readonly PercentageItem[], durations: readonly TypedDuration[]) {
  const { ctx } = b;
  for (const d of dates) {
    let key = d.type === "issue_date" ? "document_date" : d.type;
    if (!DATE_FACTS.has(d.type) && key !== "document_date") continue;
    if (key === "document_date" && ctx.type === "invoice") key = "invoice_date";
    // The first occurrence is usually the operative one; later repeats get a small discount.
    put(b, { key, value: d.originalValue, ...(d.normalizedDate ? { normalizedValue: d.normalizedDate } : {}), confidence: d.normalizedDate ? d.confidence : Math.min(d.confidence, 0.5), method: "pattern", sourceEvidence: d.sourceEvidence });
  }
  // Amounts: for totals prefer the LAST stated grand total on invoices (summary block); otherwise the first.
  const byType = new Map<string, AmountItem[]>();
  for (const a of amounts) { if (!byType.has(a.type)) byType.set(a.type, []); byType.get(a.type)!.push(a); }
  for (const [type, list] of byType) {
    const key = AMOUNT_FACTS[type];
    if (!key) continue;
    const chosen = type === "total" && ["invoice", "purchase_order", "quotation"].includes(ctx.type) ? list.reduce((m, a) => (a.amount >= m.amount ? a : m)) : list[0]!;
    const distinct = new Set(list.map(a => `${a.amount}|${a.currency ?? ""}|${a.frequency ?? ""}`)).size;
    put(b, { key, value: chosen.originalValue, normalizedValue: moneyValue(chosen), confidence: round2(distinct > 1 ? chosen.confidence - 0.1 : chosen.confidence), method: "pattern", sourceEvidence: chosen.sourceEvidence });
    if (type === "rent" && chosen.frequency) put(b, { key: "payment_frequency", value: chosen.frequency, confidence: 0.75, method: "pattern", sourceEvidence: chosen.sourceEvidence });
  }
  for (const p of percents) {
    if (p.type === "bid_bond" || p.type === "performance_bond") {
      const sentence = ctx.doc.sentenceAt(p.sourceEvidence!.startOffset);
      put(b, { key: p.type, value: sentence ? sentence.text.slice(0, 200) : p.originalValue, normalizedValue: { ratio: p.ratio }, confidence: round2(p.confidence - 0.05), method: "pattern", sourceEvidence: p.sourceEvidence });
      continue;
    }
    const key = p.type === "tax_rate" ? "tax_rate" : ["late_payment_interest", "penalty_rate", "discount", "advance_payment", "retention", "escalation", "uptime"].includes(p.type) ? p.type : null;
    if (!key) continue;
    put(b, { key: key === "discount" ? "discount_rate" : key, label: key === "discount" ? "Discount rate" : undefined, value: p.originalValue, normalizedValue: p.ratio, confidence: p.confidence, method: "pattern", sourceEvidence: p.sourceEvidence });
  }
  for (const d of durations) {
    if (d.type === "duration") continue;
    const key = d.type === "payment_terms" ? "payment_period" : d.type;
    put(b, {
      key, label: key === "payment_period" ? "Payment period" : undefined, value: d.original,
      normalizedValue: { value: d.value, unit: d.unit, iso8601: d.iso, approxDays: durationInDays(d), ...(d.dayKind ? { dayKind: d.dayKind } : {}) },
      confidence: d.confidence, method: "pattern", sourceEvidence: ctx.doc.evidence(d.start, d.end)
    });
  }
}

// ---- Clauses, parties, lists ------------------------------------------------------------------------

function fromClauses(b: Builder, clauses: readonly ClauseHit[], durations: readonly TypedDuration[]) {
  const { ctx } = b;
  for (const c of clauses) {
    const ev = ctx.doc.evidence(c.sentence.start, Math.min(c.sentence.end, c.sentence.start + 240));
    if (c.key === "payment_terms") {
      const net = /\bnet\s?(\d{1,3})\b/i.exec(c.sentence.text);
      const d = durations.find(x => x.type === "payment_terms" && x.start >= c.sentence.start && x.end <= c.sentence.end);
      const normalized = net ? { netDays: Number(net[1]) } : d ? { netDays: d.unit === "day" ? d.value : Math.round(durationInDays(d)) } : undefined;
      put(b, { key: "payment_terms", value: c.value, ...(normalized ? { normalizedValue: normalized } : {}), confidence: c.confidence, method: "clause", sourceEvidence: ev });
      continue;
    }
    if (c.key === "governing_law") { put(b, { key: c.key, value: c.value, confidence: c.confidence, method: "clause", sourceEvidence: ctx.doc.evidence(c.sentence.start, c.sentence.end) }); continue; }
    if (c.key === "termination_clause") {
      const notice = durations.find(x => x.type === "notice_period" && x.start >= c.sentence.start && x.end <= c.sentence.end);
      put(b, { key: c.key, value: c.value, confidence: c.confidence, method: "clause", sourceEvidence: ev });
      if (notice) put(b, { key: "notice_period", value: notice.original, normalizedValue: { value: notice.value, unit: notice.unit, iso8601: notice.iso, approxDays: durationInDays(notice) }, confidence: 0.9, method: "clause", sourceEvidence: ctx.doc.evidence(notice.start, notice.end) });
      continue;
    }
    put(b, { key: c.key, value: c.value, confidence: c.confidence, method: "clause", sourceEvidence: ev });
  }
}

const ROLE_FACT: Record<string, string> = {
  supplier: "supplier", vendor: "supplier", seller: "supplier", contractor: "supplier", "service provider": "supplier", provider: "supplier", consultant: "supplier",
  customer: "customer", client: "customer", buyer: "customer", purchaser: "customer", landlord: "landlord", lessor: "landlord", tenant: "tenant", lessee: "tenant",
  insurer: "insurer", insured: "insured", issuer: "issuer", employer: "issuer", authority: "issuer", auditor: "auditor",
  claimant: "claimant", respondent: "respondent", candidate: "person_name", subject_company: "company_name"
};

function fromEntities(b: Builder, entities: readonly Entity[]) {
  const parties = entities.filter(e => e.role && e.type !== "location" && !/governing_law/.test(e.role));
  if (parties.length) {
    const first = parties[0]!;
    put(b, { key: "parties", value: parties.map(p => ({ name: p.name, role: p.role })), confidence: round2(Math.min(...parties.map(p => p.confidence))), method: "definition", sourceEvidence: first.sourceEvidence });
  }
  for (const e of entities) {
    if (!e.role) continue;
    for (const role of e.role.split(", ")) {
      const key = ROLE_FACT[role];
      if (!key) continue;
      if (key === "issuer" && b.ctx.type !== "tender" && role === "employer") continue;
      put(b, { key, value: e.name, confidence: round2(e.confidence - 0.02), method: "definition", sourceEvidence: e.sourceEvidence });
    }
    if (e.role.includes("property") || e.role.includes("delivery_location") || e.role.includes("address")) {
      const key = e.role.includes("property") ? "property" : e.role.includes("delivery_location") ? "delivery_location" : "address";
      put(b, { key, value: e.name, confidence: round2(e.confidence), method: "labeled_field", sourceEvidence: e.sourceEvidence });
    }
  }
  if (b.ctx.type === "tender" && !b.facts.has("issuer")) {
    const gov = entities.find(e => e.type === "government" || e.type === "company" || e.type === "organization");
    if (gov) put(b, { key: "issuer", value: gov.name, confidence: round2(Math.min(0.65, gov.confidence)), method: "pattern", sourceEvidence: gov.sourceEvidence });
  }
}

function listFact(b: Builder, key: string, items: { text: string; start: number; end: number }[], confidence: number) {
  if (!items.length) return;
  put(b, { key, value: items.map(i => i.text), confidence, method: "table", sourceEvidence: b.ctx.doc.evidence(items[0]!.start, items[0]!.end) });
}

function tenderFacts(b: Builder, requirements: readonly Requirement[]) {
  const { ctx } = b;
  const heads: [string, RegExp][] = [
    ["eligibility_requirements", /eligib|qualification|pre-?qualification|who (?:can|may) (?:bid|apply)/i],
    ["technical_requirements", /technical/i],
    ["financial_requirements", /financial|commercial/i],
    ["mandatory_documents", /documents?|submission (?:requirements|checklist)|checklist|attachments/i]
  ];
  for (const [key, re] of heads) {
    const lists = listsUnderHeadings(ctx, re);
    if (lists.length) listFact(b, key, lists.flatMap(l => l.items).slice(0, 30), 0.85);
  }
  const cat: Record<string, Requirement["category"]> = { eligibility_requirements: "eligibility", technical_requirements: "technical", financial_requirements: "financial", mandatory_documents: "documentation" };
  for (const [key, category] of Object.entries(cat)) {
    if (b.facts.has(key)) continue;
    const rs = requirements.filter(r => r.category === category);
    if (rs.length) put(b, { key, value: rs.map(r => r.requirement).slice(0, 30), confidence: 0.72, method: "clause", sourceEvidence: rs[0]!.sourceEvidence });
  }
  const criteria = parseEvaluationCriteria(ctx);
  if (criteria.length) put(b, { key: "evaluation_criteria", value: criteria.map(c => ({ criterion: c.criterion, weight: c.weight })), normalizedValue: criteria.map(c => ({ criterion: c.criterion, weightRatio: c.weight !== null && c.weight <= 100 ? round2(c.weight / 100) : null })), confidence: 0.82, method: "table", sourceEvidence: ctx.doc.evidence(criteria[0]!.start, criteria[0]!.end) });
}

function lineItemFacts(b: Builder) {
  const li = extractLineItems(b.ctx);
  if (!li) return;
  put(b, { key: "line_items", value: li.items, confidence: 0.85, method: "table", sourceEvidence: b.ctx.doc.evidence(li.start, Math.min(li.end, li.start + 240)) });
  const sum = li.items.reduce((s, i: LineItem) => s + i.amount, 0);
  const sub = (b.facts.get("subtotal")?.normalizedValue as { amount?: number } | undefined)?.amount;
  const total = (b.facts.get("total_amount")?.normalizedValue as { amount?: number } | undefined)?.amount;
  const target = sub ?? (b.facts.has("tax_amount") ? undefined : total);
  if (target !== undefined && Math.abs(sum - target) > Math.max(0.011, target * 0.001)) b.lineItemsMismatch = b.facts.get("line_items")!.sourceEvidence;
}

function resumeFacts(b: Builder) {
  const { doc } = b.ctx;
  const exp = /(\d{1,2})\+?\s*(?:years?|yrs?)(?:\s+of)?\s+(?:(?:professional|relevant|work|industry|total)\s+)?experience/i.exec(doc.text);
  if (exp && !inSuspicious(b.ctx, exp.index)) put(b, { key: "total_experience_years", value: exp[0], normalizedValue: Number(exp[1]), confidence: 0.8, method: "pattern", sourceEvidence: doc.evidence(exp.index, exp.index + exp[0].length) });
  const edu = doc.lines().filter(l => /\b(?:Bachelor|Master|MBA|Ph\.?D|Doctorate|B\.?Sc|M\.?Sc|B\.?Eng|M\.?Eng|B\.?A\.|M\.?A\.|Diploma|Associate (?:degree|of))\b/.test(l.text) && l.text.length < 200 && !inSuspicious(b.ctx, l.start)).slice(0, 10);
  listFact(b, "education", edu.map(l => ({ text: l.text, start: l.start, end: l.end })), 0.78);
  if (!b.facts.has("skills")) {
    const skillsLine = doc.lines().find(l => /^(?:(?:key|technical|core)\s+)?skills\s*[:：]/i.test(l.text));
    if (skillsLine) {
      const items = skillsLine.text.replace(/^[^:：]+[:：]/, "").split(/[,;|•]/).map(s => s.trim()).filter(s => s.length > 1 && s.length < 60);
      if (items.length) put(b, { key: "skills", value: items, confidence: 0.82, method: "labeled_field", sourceEvidence: doc.evidence(skillsLine.start, skillsLine.end) });
    } else {
      const lists = listsUnderHeadings(b.ctx, /^(?:(?:key|technical|core)\s+)?skills$/i);
      if (lists.length) listFact(b, "skills", lists[0]!.items, 0.78);
    }
  }
}

function profileFacts(b: Builder, entities: readonly Entity[]) {
  const { doc } = b.ctx;
  if (!b.facts.has("company_name")) {
    const c = entities.find(e => e.type === "company");
    if (c) put(b, { key: "company_name", value: c.name, confidence: round2(Math.min(0.75, c.confidence)), method: "pattern", sourceEvidence: c.sourceEvidence });
  }
  const f = /\b(?:established|founded|incorporated|since)\s+(?:in\s+)?(\d{4})\b/i.exec(doc.text);
  if (f && !inSuspicious(b.ctx, f.index)) put(b, { key: "founded", value: f[1]!, normalizedValue: Number(f[1]), confidence: 0.82, method: "pattern", sourceEvidence: doc.evidence(f.index, f.index + f[0].length) });
  const emp = /(\d[\d,]*)\+?\s+(?:employees|staff|professionals|team members|people)\b/i.exec(doc.text);
  if (emp && !inSuspicious(b.ctx, emp.index)) put(b, { key: "employee_count", value: emp[0], normalizedValue: Number(emp[1]!.replace(/,/g, "")), confidence: 0.75, method: "pattern", sourceEvidence: doc.evidence(emp.index, emp.index + emp[0].length) });
  const lists = listsUnderHeadings(b.ctx, /services|what we do|our (?:products|solutions|expertise)|capabilities/i);
  if (lists.length) listFact(b, "services", lists.flatMap(l => l.items).slice(0, 25), 0.78);
}

function financialFacts(b: Builder) {
  const { doc, ctx } = { doc: b.ctx.doc, ctx: b.ctx };
  const scale = /\((?:all amounts |amounts |figures )?in (thousands|millions|billions)(?: of ([A-Z]{3}|[\p{L} ]{3,20}?))?\)|\b(?:in|expressed in) ([A-Z]{3})\s?'?000s?\b|\b([A-Z]{3})\s?'000\b/iu.exec(doc.text);
  if (scale && !inSuspicious(ctx, scale.index)) {
    const unit = scale[1]?.toLowerCase() ?? "thousands";
    put(b, { key: "reported_unit_scale", value: scale[0], normalizedValue: { scale: unit, multiplier: unit === "millions" ? 1e6 : unit === "billions" ? 1e9 : 1e3 }, confidence: 0.85, method: "pattern", sourceEvidence: doc.evidence(scale.index, scale.index + scale[0].length) });
    ctx.warnings.push(`The report states that figures are in ${unit}; financial amounts are returned exactly as written (not multiplied).`);
  }
  const ROW: [string, RegExp][] = [
    ["revenue", /^(?:total\s+)?(?:revenues?|turnover|net sales|sales)\b/i], ["net_income", /^(?:net (?:income|profit|earnings)|profit (?:for the (?:year|period)|after tax))\b/i],
    ["total_assets", /^total assets\b/i], ["total_liabilities", /^total liabilities\b/i], ["total_equity", /^total (?:shareholders'?\s+)?equity\b/i]
  ];
  for (const line of doc.lines()) {
    for (const [key, re] of ROW) {
      if (b.facts.has(key) || !re.test(line.text) || inSuspicious(ctx, line.start)) continue;
      const m = /(\(?-?\d[\d.,']*\d\)?|\d)(?=\s|$)/.exec(line.text.replace(/^[^\d(]+/, (s) => " ".repeat(s.length)));
      if (!m) continue;
      const neg = m[1]!.startsWith("(") || m[1]!.startsWith("-");
      const amount = parseBareAmount(m[1]!.replace(/[()-]/g, ""), ctx.decimalStyle);
      if (amount === null) continue;
      const s = line.start + m.index;
      put(b, { key, value: m[1]!, normalizedValue: { amount: neg ? -amount : amount, ...(scale?.[2] && /^[A-Z]{3}$/.test(scale[2]) ? { currency: scale[2] } : scale?.[3] ? { currency: scale[3] } : scale?.[4] ? { currency: scale[4] } : {}) }, confidence: 0.7, method: "table", sourceEvidence: doc.evidence(s, s + m[1]!.length) });
    }
  }
}

function contactFacts(b: Builder) {
  const { doc, ctx } = { doc: b.ctx.doc, ctx: b.ctx };
  if (!b.facts.has("email")) {
    const e = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/i.exec(doc.text);
    if (e && !inSuspicious(ctx, e.index)) put(b, { key: "email", value: e[0], confidence: 0.85, method: "pattern", sourceEvidence: doc.evidence(e.index, e.index + e[0].length) });
  }
  if (!b.facts.has("website")) {
    const w = /\b(?:https?:\/\/|www\.)[\w.-]+\.[a-z]{2,}(?:\/[^\s)]*)?/i.exec(doc.text);
    if (w && !inSuspicious(ctx, w.index)) put(b, { key: "website", value: w[0].replace(/[.,;]+$/, ""), confidence: 0.8, method: "pattern", sourceEvidence: doc.evidence(w.index, w.index + w[0].length) });
  }
  if (!b.facts.has("phone")) {
    const p = /\+\d{1,3}[\s-]?\(?\d{1,4}\)?(?:[\s-]?\d{2,4}){2,4}/.exec(doc.text);
    if (p && !inSuspicious(ctx, p.index)) put(b, { key: "phone", value: p[0].trim(), confidence: 0.75, method: "pattern", sourceEvidence: doc.evidence(p.index, p.index + p[0].length) });
  }
}

function paymentDetails(b: Builder) {
  const parts = ["iban", "swift_code", "account_number", "bank_name", "account_name"].map(k => b.facts.get(k)).filter((f): f is Fact => Boolean(f));
  if (!parts.length) {
    const iban = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){2,7}(?:[ ]?[A-Z0-9]{1,4})?\b/.exec(b.ctx.doc.text);
    if (iban && /iban/i.test(b.ctx.doc.text.slice(Math.max(0, iban.index - 30), iban.index)) && !inSuspicious(b.ctx, iban.index)) {
      put(b, { key: "iban", value: iban[0], confidence: 0.85, method: "pattern", sourceEvidence: b.ctx.doc.evidence(iban.index, iban.index + iban[0].length) });
      parts.push(b.facts.get("iban")!);
    }
  }
  if (parts.length) put(b, { key: "payment_details", value: Object.fromEntries(parts.map(p => [p.key, p.value])), confidence: round2(Math.min(...parts.map(p => p.confidence))), method: "labeled_field", sourceEvidence: parts[0]!.sourceEvidence });
}

function currencyFact(b: Builder, amounts: readonly AmountItem[]) {
  if (b.facts.has("currency")) return;
  if (b.ctx.declaredCurrency) { put(b, { key: "currency", value: b.ctx.declaredCurrency.code, normalizedValue: b.ctx.declaredCurrency.code, confidence: 0.93, method: "labeled_field", sourceEvidence: b.ctx.declaredCurrency.evidence }); return; }
  const key = amounts.filter(a => a.currency && ["total", "subtotal", "contract_value", "rent", "premium", "revenue"].includes(a.type));
  const set = new Set(key.map(a => a.currency));
  if (set.size === 1) put(b, { key: "currency", value: key[0]!.currency!, normalizedValue: key[0]!.currency!, confidence: 0.88, method: "pattern", sourceEvidence: key[0]!.sourceEvidence });
}

export interface FactInputs {
  labeled: readonly LabeledField[];
  dates: readonly DateItem[];
  amounts: readonly AmountItem[];
  percents: readonly PercentageItem[];
  durations: readonly TypedDuration[];
  clauses: readonly ClauseHit[];
  entities: readonly Entity[];
  requirements: readonly Requirement[];
}

export function buildFacts(ctx: ExtractionContext, input: FactInputs): { facts: Fact[]; lineItemsMismatch: SourceEvidence | null } {
  const b: Builder = { facts: new Map(), ctx, lineItemsMismatch: null };
  fromClauses(b, input.clauses, input.durations);
  fromValues(b, input.dates, input.amounts, input.percents, input.durations);
  fromEntities(b, input.entities);
  fromLabeled(b, input.labeled);
  if (ctx.type === "tender") tenderFacts(b, input.requirements);
  lineItemFacts(b);
  if (ctx.type === "resume") resumeFacts(b);
  if (ctx.type === "company_profile") profileFacts(b, input.entities);
  if (ctx.type === "financial_report") financialFacts(b);
  if (["resume", "company_profile", "other", "invoice", "quotation"].includes(ctx.type)) contactFacts(b);
  paymentDetails(b);
  currencyFact(b, input.amounts);
  // Order: priority facts for the type first, then the rest by document position.
  const priority = PRIORITY_FACTS[ctx.type];
  const facts = [...b.facts.values()].sort((x, y) => {
    const px = priority.indexOf(x.key), py = priority.indexOf(y.key);
    if (px !== -1 || py !== -1) return (px === -1 ? 999 : px) - (py === -1 ? 999 : py);
    return (x.sourceEvidence?.startOffset ?? 0) - (y.sourceEvidence?.startOffset ?? 0);
  });
  return { facts: facts.slice(0, L.maxItemsPerList * 2), lineItemsMismatch: b.lineItemsMismatch ?? null };
}

export { humanize as factLabel, collapse };
