import type { DocumentType } from "../../schemas/documentFactsInputs.js";
import type { DocumentModel } from "../document.js";

/**
 * Keyword-evidence document classification. Title-area matches (first ~600 characters) count
 * triple. Returns the best type, a confidence derived from the margin over the runner-up, and a
 * subtype when a specific signal is present. Falls back to "other" when evidence is weak.
 */
type Rule = [RegExp, number];
const RULES: Record<Exclude<DocumentType, "other">, Rule[]> = {
  invoice: [[/\btax invoice\b/, 6], [/\binvoice\b/, 3], [/\binvoice (?:no|number|#|date)\b/, 4], [/\bbill(?:ed)? to\b/, 2], [/\bamount due\b|\bbalance due\b|\btotal due\b/, 3], [/\bsub-?total\b/, 1.5], [/\bdue date\b/, 1.5], [/\bremit to\b/, 2], [/فاتورة/, 4]],
  purchase_order: [[/\bpurchase order\b/, 6], [/\bp\.?o\.? (?:no|number|#)\b|\bpo number\b|\border number\b/, 4], [/\bship to\b|\bdeliver to\b|\bdelivery address\b/, 2], [/\border date\b/, 2], [/\bvendor\b/, 1], [/أمر شراء/, 5]],
  quotation: [[/\bquotation\b|\bquote\b|\bprice offer\b|\bproforma\b|\bpro-forma\b|\bestimate\b/, 3], [/\bquot(?:e|ation) (?:no|number|#|ref)\b/, 4], [/\bvalid (?:for|until|till)\b|\bvalidity\b/, 2], [/\bwe are pleased to (?:quote|offer|submit)\b/, 3], [/عرض سعر/, 5]],
  tender: [[/\btender\b/, 3], [/\brequest for (?:proposal|quotation|tender|information)\b|\brfp\b|\brfq\b|\bitb\b|\binvitation to (?:bid|tender)\b/, 5], [/\bbidders?\b|\btenderers?\b/, 3], [/\bbid (?:bond|security)\b|\btender bond\b/, 3], [/\bsubmission deadline\b|\bclosing date\b|\bdeadline for (?:submission|receipt)\b/, 3], [/\bevaluation criteria\b/, 3], [/\bscope of work\b/, 1], [/مناقصة/, 5]],
  lease: [[/\blease agreement\b|\btenancy agreement\b|\brental agreement\b|\blease contract\b/, 7], [/\blandlord\b|\blessor\b/, 3], [/\btenant\b|\blessee\b/, 3], [/\bpremises\b/, 2], [/\bmonthly rent\b|\bannual rent\b|\brent\b/, 2], [/\bsecurity deposit\b/, 1.5], [/عقد إيجار|المؤجر|المستأجر/, 5]],
  contract: [[/\bagreement\b|\bcontract\b/, 2], [/\bthis (?:agreement|contract)\b/, 3], [/\bby and between\b|\bbetween\b[^.]{0,200}\band\b[^.]{0,200}\((?:the )?["“]/, 4], [/\bwhereas\b/, 3], [/\bhereinafter\b/, 3], [/\bin witness whereof\b/, 3], [/\bgoverning law\b|\bgoverned by the laws\b/, 3], [/\btermination\b/, 1.5], [/\bparties\b/, 1.5], [/\bservice level\b|\bscope of services\b/, 1], [/عقد|اتفاقية/, 4]],
  policy: [[/\bpolicy (?:no|number|schedule|period|wording)\b/, 5], [/\binsured\b|\binsurer\b|\bpolicyholder\b|\bunderwriter\b/, 3], [/\bpremium\b/, 2], [/\bsum insured\b|\bcoverage\b|\bdeductible\b|\bexcess\b|\bexclusions?\b/, 2], [/\bthis policy (?:applies|sets out|describes|is)\b|\bpolicy statement\b|\bpurpose and scope\b/, 4], [/\bpolicy\b/, 1.5], [/وثيقة تأمين|سياسة/, 4]],
  financial_report: [[/\bbalance sheet\b|\bstatement of financial position\b/, 5], [/\bincome statement\b|\bprofit (?:and|&) loss\b|\bstatement of (?:comprehensive )?income\b/, 5], [/\bcash flows?\b/, 3], [/\btotal assets\b|\btotal liabilities\b|\bshareholders'? equity\b/, 3], [/\bannual report\b|\bfinancial statements\b|\bfiscal year\b|\bquarterly report\b/, 4], [/\baudit(?:or|ed)\b/, 2], [/\brevenue\b|\bebitda\b|\bnet (?:income|profit)\b/, 2], [/القوائم المالية|الميزانية/, 5]],
  legal_document: [[/\bcourt\b|\btribunal\b/, 3], [/\bplaintiff\b|\bdefendant\b|\bclaimant\b|\brespondent\b|\bappellant\b/, 4], [/\bjudg(?:e)?ment\b|\bruling\b|\bverdict\b|\border of the court\b/, 3], [/\bcase (?:no|number)\b/, 4], [/\bpower of attorney\b|\baffidavit\b|\bnotari(?:al|zed|sed)\b|\bdeed\b|\bmemorandum of association\b|\barticles of association\b/, 5], [/\bstatute\b|\bdecree\b|\bregulation\b/, 1.5], [/محكمة|وكالة/, 4]],
  resume: [[/\bcurriculum vitae\b|\bresume\b|\brésumé\b/, 6], [/\bwork experience\b|\bprofessional experience\b|\bemployment history\b/, 4], [/\beducation\b/, 2], [/\bskills\b/, 2], [/\bcertifications?\b/, 1], [/\breferences\b/, 1], [/السيرة الذاتية/, 6]],
  company_profile: [[/\bcompany profile\b|\bcorporate profile\b/, 7], [/\babout us\b|\bwho we are\b/, 4], [/\bour (?:mission|vision|values|services|clients|team)\b/, 3], [/\b(?:established|founded) in \d{4}\b/, 3], [/\bheadquartered\b/, 2], [/نبذة عن الشركة|ملف الشركة/, 6]]
};

const SUBTYPES: [DocumentType, RegExp, string][] = [
  ["invoice", /\btax invoice\b/, "tax_invoice"], ["invoice", /\bcredit note\b/, "credit_note"], ["invoice", /\bproforma|pro-forma\b/, "proforma_invoice"],
  ["contract", /\bservice (?:level )?agreement\b|\bservices agreement\b/, "service_agreement"], ["contract", /\bmaintenance (?:contract|agreement)\b|\bannual maintenance\b/, "maintenance_contract"],
  ["contract", /\bnon-disclosure\b|\bconfidentiality agreement\b/, "nda"], ["contract", /\bemployment (?:contract|agreement)\b/, "employment_contract"],
  ["contract", /\bsupply agreement\b|\bsupplier agreement\b|\bpurchase agreement\b/, "supply_agreement"], ["contract", /\bdistribution agreement\b/, "distribution_agreement"],
  ["contract", /\bloan agreement\b|\bfacility agreement\b/, "loan_agreement"], ["contract", /\bconsult(?:ing|ancy) agreement\b/, "consulting_agreement"],
  ["policy", /\binsur(?:ance|ed|er)\b|\bpremium\b/, "insurance_policy"], ["policy", /\bthis policy (?:applies|sets out|describes)\b|\bemployees?\b.{0,40}\bpolicy\b/, "organizational_policy"],
  ["tender", /\brequest for proposal\b|\brfp\b/, "rfp"], ["tender", /\brequest for quotation\b|\brfq\b/, "rfq"],
  ["financial_report", /\bannual report\b/, "annual_report"], ["financial_report", /\bquarterly\b|\bq[1-4]\b/, "quarterly_report"],
  ["other", /\bstatement of account\b|\baccount statement\b|\bbank statement\b/, "account_statement"], ["other", /\bdelivery note\b|\bgoods received\b/, "delivery_note"],
  ["other", /\bcertificate of (?:incorporation|registration|origin|insurance)\b/, "certificate"], ["other", /\bmemorandum of understanding\b|\bmou\b/, "memorandum_of_understanding"]
];

export interface Classification { type: DocumentType; subtype: string | null; confidence: number; scores: Record<string, number> }

export function classifyDocument(doc: DocumentModel): Classification {
  const lower = doc.lower;
  const head = lower.slice(0, 600);
  const body = lower.slice(0, 60_000);
  const scores: Record<string, number> = {};
  for (const [type, rules] of Object.entries(RULES)) {
    let s = 0;
    for (const [re, w] of rules) {
      if (re.test(head)) s += w * 3;
      const count = Math.min(5, (body.match(new RegExp(re.source, "g")) ?? []).length);
      s += w * Math.log2(1 + count);
    }
    scores[type] = Math.round(s * 100) / 100;
  }
  // A lease is a contract; prefer lease when its specific signals are present.
  if (scores.lease! >= 12 && scores.contract! > 0) scores.contract = scores.contract! * 0.6;
  // A tender's "contract" vocabulary (conditions of contract) should not outvote tender signals.
  if (scores.tender! >= 15) scores.contract = scores.contract! * 0.7;
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [bestType, best] = ranked[0]!;
  const second = ranked[1]?.[1] ?? 0;
  let type: DocumentType = best >= 8 ? (bestType as DocumentType) : "other";
  const margin = best > 0 ? (best - second) / best : 0;
  let confidence = type === "other" ? 0.5 : Math.min(0.97, 0.5 + 0.35 * margin + 0.15 * Math.min(1, best / 40));
  const subtype = detectSubtype(type, lower.slice(0, 20_000));
  if (type === "other" && subtype) confidence = 0.6;
  return { type, subtype, confidence: Math.round(confidence * 100) / 100, scores };
}

export function detectSubtype(type: DocumentType, lower: string): string | null {
  for (const [t, re, sub] of SUBTYPES) if (t === type && re.test(lower)) return sub;
  return null;
}
