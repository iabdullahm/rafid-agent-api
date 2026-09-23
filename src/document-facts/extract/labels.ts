import type { SourceEvidence } from "../document.js";
import { inSuspicious, type ExtractionContext } from "./context.js";

/**
 * "Label: value" fields (headers of invoices, POs, policies, tender notices, CV headers, ...). A
 * label is mapped to a canonical fact key when it matches a known synonym; the value's evidence is
 * the value's own character range. Label-above-value layouts (label line ending in ":" followed by
 * a short value line) are supported.
 */
export type LabelKind = "id" | "date" | "amount" | "party" | "text" | "email" | "phone" | "url" | "currency" | "percent" | "duration" | "location" | "list";

export interface LabeledField {
  key: string;
  label: string;
  kind: LabelKind;
  value: string;
  valueStart: number;
  valueEnd: number;
  mapped: boolean;
  evidence: SourceEvidence;
}

const ID = String.raw`\s*(?:no|nos|number|num|#|ref(?:erence)?|id)\.?\s*`;
export const LABEL_MAP: readonly [RegExp, string, LabelKind][] = [
  [new RegExp(`^(?:tax\\s+)?invoice${ID}$`), "invoice_number", "id"],
  [new RegExp(`^(?:p\\.?\\s?o\\.?|purchase\\s+order|order|your\\s+(?:po|order))${ID}$`), "po_number", "id"],
  [new RegExp(`^(?:quotation|quote|offer|proposal)${ID}$`), "quotation_number", "id"],
  [new RegExp(`^(?:tender|rfp|rfq|rfi|bid|itb|solicitation)${ID}$`), "tender_number", "id"],
  [new RegExp(`^(?:contract|agreement)${ID}$`), "contract_number", "id"],
  [new RegExp(`^policy${ID}$`), "policy_number", "id"],
  [new RegExp(`^(?:case|claim|file)${ID}$`), "case_number", "id"],
  [/^(?:our\s+|your\s+)?ref(?:erence)?\.?(?:\s*(?:no|number|#)\.?)?$/, "reference_number", "id"],
  [/^(?:invoice\s+date|date\s+of\s+invoice)$/, "invoice_date", "date"],
  [/^(?:payment\s+)?due(?:\s+date)?$|^pay\s+by$|^payment\s+deadline$/, "due_date", "date"],
  [/^(?:order|po|p\.o\.)\s+date$/, "order_date", "date"],
  [/^(?:delivery|required|ship(?:ping)?|dispatch)\s+(?:date|by)$|^deliver\s+by$/, "delivery_date", "date"],
  [/^valid(?:ity)?(?:\s+(?:until|till|date|period))?$|^offer\s+valid(?:\s+until)?$/, "valid_until", "date"],
  [/^(?:effective|start|commencement|lease\s+start|policy\s+start|contract\s+start)(?:\s+date)?$|^period\s+from$|^from$/, "effective_date", "date"],
  [/^(?:expiry|expiration|end|termination|lease\s+end|policy\s+end|contract\s+end)(?:\s+date)?$|^period\s+to$/, "expiry_date", "date"],
  [/^(?:(?:bid|tender|proposal)\s+)?(?:submission|closing)(?:\s+date)?(?:\s+(?:and|&)\s+time)?(?:\s+deadline)?$|^deadline(?:\s+for\s+submission)?$|^last\s+date\s+(?:of|for)\s+submission$/, "submission_deadline", "date"],
  [/^(?:date(?:\s+of\s+issue)?|issue\s+date|issued\s+on|dated)$/, "document_date", "date"],
  [/^(?:period\s+of\s+insurance|policy\s+period|contract\s+period|lease\s+(?:term|period)|term)$/, "term", "text"],
  [/^(?:supplier|vendor|seller|contractor|service\s+provider|issued\s+by|billed\s+by|from|consultant|bill\s+from)$/, "supplier", "party"],
  [/^(?:customer|client|bill(?:ed)?\s+to|sold\s+to|buyer|purchaser|invoice\s+to|to|attention|attn\.?)$/, "customer", "party"],
  [/^(?:ship\s+to|deliver(?:y)?\s+to|delivery\s+(?:address|location|point|place)|place\s+of\s+delivery|site\s+address)$/, "delivery_location", "location"],
  [/^(?:landlord|lessor|owner)$/, "landlord", "party"],
  [/^(?:tenant|lessee|occupant)$/, "tenant", "party"],
  [/^(?:insurer|underwriter|insurance\s+company)$/, "insurer", "party"],
  [/^(?:insured|policy\s*holder|assured)$/, "insured", "party"],
  [/^(?:issuer|procuring\s+entity|contracting\s+authority|employer|issuing\s+authority|tendering\s+authority)$/, "issuer", "party"],
  [/^(?:auditor|auditors|independent\s+auditor)$/, "auditor", "party"],
  [/^(?:property|premises|property\s+address|address\s+of\s+(?:the\s+)?(?:property|premises)|location\s+of\s+(?:the\s+)?premises)$/, "property", "location"],
  [/^(?:unit|flat|apartment|villa|office|shop|suite)(?:\s+(?:no|number|#))?\.?$/, "unit", "id"],
  [/^currency$/, "currency", "currency"],
  [/^(?:sub-?\s?total|net\s+amount|amount\s+before\s+(?:tax|vat))$/, "subtotal", "amount"],
  [/^(?:grand\s+total|total(?:\s+amount)?(?:\s+(?:due|payable))?(?:\s+\(?incl\w*\.?\s+(?:vat|tax)\)?)?|amount\s+(?:due|payable)|balance\s+due)$/, "total_amount", "amount"],
  [/^(?:vat|tax|gst|sales\s+tax)(?:\s+amount)?(?:\s*\(?\d+(?:\.\d+)?\s*%\)?)?$/, "tax_amount", "amount"],
  [/^(?:vat|tax|gst)\s+rate$/, "tax_rate", "percent"],
  [/^discount$/, "discount", "amount"],
  [/^(?:security\s+)?deposit$/, "security_deposit", "amount"],
  [/^(?:monthly\s+|annual\s+|yearly\s+)?rent(?:al)?(?:\s+amount)?$/, "rent", "amount"],
  [/^(?:contract\s+(?:value|price|sum|amount)|total\s+contract\s+value|consideration)$/, "contract_value", "amount"],
  [/^(?:annual\s+)?premium$/, "premium", "amount"],
  [/^(?:sum\s+insured|limit\s+of\s+(?:indemnity|liability)|coverage\s+limit)$/, "sum_insured", "amount"],
  [/^(?:deductible|excess)$/, "deductible", "amount"],
  [/^(?:bid\s+(?:bond|security)|tender\s+(?:bond|security))$/, "bid_bond", "text"],
  [/^performance\s+(?:bond|security|guarantee)$/, "performance_bond", "text"],
  [/^(?:payment\s+terms?|terms\s+of\s+payment|payment\s+conditions?)$/, "payment_terms", "text"],
  [/^(?:payment\s+(?:frequency|schedule)|rent\s+payable)$/, "payment_frequency", "text"],
  [/^(?:delivery\s+(?:terms?|time|period)|lead\s+time|incoterms?)$/, "delivery_terms", "text"],
  [/^(?:notice\s+period)$/, "notice_period", "duration"],
  [/^(?:governing\s+law|applicable\s+law|jurisdiction)$/, "governing_law", "text"],
  [/^iban$/, "iban", "id"],
  [/^(?:swift|bic|swift\s+code|swift\/bic|bic\/swift)$/, "swift_code", "id"],
  [/^(?:account|a\/c|acct|bank\s+account)\.?\s*(?:no|number|#)?\.?$/, "account_number", "id"],
  [/^(?:bank|bank\s+name|name\s+of\s+bank)$/, "bank_name", "text"],
  [/^(?:account\s+name|account\s+holder|beneficiary(?:\s+name)?)$/, "account_name", "text"],
  [/^(?:vat|tax|gst|trn|tin|ein|vat\s+reg(?:istration)?|tax\s+reg(?:istration)?|tax\s+id(?:entification)?)\s*(?:no|number|id|#)?\.?$/, "tax_id", "id"],
  [/^(?:cr|c\.r\.|commercial\s+reg(?:istration|\.)?|company\s+reg(?:istration|\.)?|registration|reg\.?|company)\s*(?:no|number|#)\.?$/, "registration_number", "id"],
  [/^(?:e-?mail|email\s+address)$/, "email", "email"],
  [/^(?:tel|telephone|phone|mobile|mob|gsm|cell|contact\s+(?:no|number))\.?$/, "phone", "phone"],
  [/^(?:web|website|url|web\s+site)$/, "website", "url"],
  [/^(?:full\s+)?name$|^candidate(?:\s+name)?$|^applicant(?:\s+name)?$/, "person_name", "text"],
  [/^(?:current\s+)?(?:position|title|designation|job\s+title|role)$/, "job_title", "text"],
  [/^(?:company\s+name|name\s+of\s+(?:the\s+)?company|legal\s+name|registered\s+name)$/, "company_name", "text"],
  [/^(?:address|registered\s+(?:address|office)|head\s+office|headquarters)$/, "address", "location"],
  [/^(?:established|founded|year\s+(?:established|founded)|date\s+of\s+incorporation|incorporated)$/, "founded", "text"],
  [/^(?:employees|number\s+of\s+employees|staff|headcount|team\s+size)$/, "employee_count", "text"],
  [/^(?:subject|re|title)$/, "subject", "text"],
  [/^(?:scope(?:\s+of\s+(?:work|services))?)$/, "scope", "text"],
  [/^(?:court|tribunal)$/, "court", "text"],
  [/^(?:plaintiff|claimant|appellant|petitioner)$/, "claimant", "party"],
  [/^(?:defendant|respondent)$/, "respondent", "party"],
  [/^(?:reporting\s+period|financial\s+year|fiscal\s+year|period)$/, "reporting_period", "text"],
  [/^(?:(?:key|technical|core)\s+)?skills$/, "skills", "list"],
  [/^(?:services|our\s+services|products)$/, "services", "list"],
  // Arabic labels (common business-document headers).
  [/^رقم الفاتورة$/, "invoice_number", "id"], [/^تاريخ الفاتورة$/, "invoice_date", "date"], [/^تاريخ الاستحقاق$/, "due_date", "date"],
  [/^رقم (?:أمر|امر) الشراء$/, "po_number", "id"], [/^رقم العقد$/, "contract_number", "id"], [/^رقم المناقصة$/, "tender_number", "id"],
  [/^(?:المورد|البائع|المقاول)$/, "supplier", "party"], [/^(?:العميل|المشتري)$/, "customer", "party"],
  [/^(?:المؤجر|المالك)$/, "landlord", "party"], [/^المستأجر$/, "tenant", "party"],
  [/^(?:الإجمالي|الاجمالي|المجموع|المبلغ الإجمالي|الإجمالي المستحق)$/, "total_amount", "amount"],
  [/^(?:ضريبة القيمة المضافة|الضريبة)$/, "tax_amount", "amount"], [/^(?:الإيجار|الإيجار الشهري|قيمة الإيجار)$/, "rent", "amount"],
  [/^(?:العملة)$/, "currency", "currency"], [/^(?:العقار|الموقع|العنوان)$/, "property", "location"],
  [/^(?:تاريخ البدء|تاريخ السريان)$/, "effective_date", "date"], [/^(?:تاريخ الانتهاء)$/, "expiry_date", "date"]
];

const LINE = /^([\p{L}][\p{L}\p{N} .#/&()%'’-]{0,48}?)\s*[:：]\s*(.*)$/u;
const MAX_UNMAPPED = 40;

function slug(label: string): string {
  return label.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{M}\p{N}]+/gu, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "field";
}

export function mapLabel(label: string): { key: string; kind: LabelKind } | null {
  const l = label.toLowerCase().replace(/\s+/g, " ").replace(/[.:]+$/, "").trim();
  for (const [re, key, kind] of LABEL_MAP) if (re.test(l)) return { key, kind };
  return null;
}

export function extractLabeledFields(ctx: ExtractionContext): LabeledField[] {
  const { doc } = ctx;
  const lines = doc.lines();
  const out: LabeledField[] = [];
  let unmapped = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.text.length > 260) continue;
    const m = LINE.exec(line.text);
    if (!m) continue;
    const label = m[1]!.trim();
    if (label.split(/\s+/).length > 6) continue;
    let value = m[2]!.trim();
    let valueStart = line.start + line.text.length - m[2]!.length + (m[2]!.length - m[2]!.trimStart().length);
    if (!value) {
      const next = lines[i + 1];
      if (!next || next.text.length > 140 || LINE.test(next.text)) continue;
      value = next.text; valueStart = next.start;
    }
    // A value that runs into another "Label: value" on the same line (two-column layouts).
    const split = /\s{2,}(?=[\p{L}][\p{L} .#/]{1,30}:\s)/u.exec(value);
    if (split) value = value.slice(0, split.index);
    value = value.replace(/[\s|]+$/, "");
    if (!value || value.length > 200) continue;
    const valueEnd = valueStart + value.length;
    if (inSuspicious(ctx, line.start, valueEnd)) continue;
    const mapped = mapLabel(label);
    if (!mapped) {
      if (unmapped >= MAX_UNMAPPED || value.length > 120 || /^(?:note|notes|remarks?|important|warning|nb)$/i.test(label)) continue;
      unmapped++;
    }
    out.push({
      key: mapped?.key ?? `field_${slug(label)}`, label, kind: mapped?.kind ?? "text", value, valueStart, valueEnd,
      mapped: Boolean(mapped), evidence: doc.evidence(valueStart, valueEnd)
    });
  }
  // Identifier patterns without a colon: "Invoice No. INV-2026-0042", "Tender No 12/2026".
  const ID_RE = /\b(tax invoice|invoice|quotation|quote|purchase order|p\.?o\.?|tender|rfp|rfq|contract|agreement|policy)\s*(?:no|number|#|ref)\.?\s*[#:.-]?\s*([A-Z0-9][A-Z0-9/._-]{2,40})\b/gi;
  for (const m of doc.text.matchAll(ID_RE)) {
    const mapped = mapLabel(`${m[1]} no`);
    if (!mapped) continue;
    if (!/\d/.test(m[2]!)) continue;
    const valueStart = m.index! + m[0].length - m[2]!.length;
    if (out.some(f => f.key === mapped.key) || inSuspicious(ctx, valueStart)) continue;
    out.push({ key: mapped.key, label: `${m[1]} number`, kind: "id", value: m[2]!, valueStart, valueEnd: valueStart + m[2]!.length, mapped: true, evidence: doc.evidence(valueStart, valueStart + m[2]!.length) });
  }
  return out;
}
