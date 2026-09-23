import type { AmountItem, DateItem, PercentageItem } from "../../schemas/documentFactsOutputs.js";
import { findAmounts, findDates, findDurations, findPercentages, parseBareAmount, type DurationMatch } from "../normalize.js";
import { inSuspicious, nearestRule, round2, type ContextRule, type ExtractionContext } from "./context.js";

/**
 * Typed dates, amounts, percentages and durations. Each value is found by a normalizer
 * (normalize.ts) and typed by the NEAREST keyword in its own sentence/line (context.ts) — a date
 * is an "expiry_date" only when expiry language sits next to it in the document.
 */

const DATE_RULES: readonly ContextRule<string>[] = [
  ["invoice_date", /invoice date|date of invoice|invoice dated|تاريخ الفاتورة/],
  ["due_date", /due date|payment due|due on|due by|payable (?:on or )?(?:before|by)|pay(?:ment)? by|to be paid by|تاريخ الاستحقاق/],
  ["order_date", /order date|p\.?o\.? date|date of (?:the )?order/],
  ["submission_deadline", /submission deadline|closing date|deadline|submitted (?:no later than|by|before|on or before)|last date (?:for|of) submission|received (?:no later than|by|before|on or before)|آخر موعد/],
  ["valid_until", /valid (?:until|till|through|up to)|validity date|offer (?:is )?valid/],
  ["effective_date", /effective (?:date|from|as of|on)|commencement date|commenc(?:e|es|ing|ement)(?: on| from)?|start(?:ing)? date|start(?:s|ing)? (?:on|from)|with effect from|تاريخ السريان|تاريخ البدء|يبدأ|يسري/],
  ["expiry_date", /expir(?:y|ation)(?: date)?|shall expire|expires?(?: on)?|end date|ends? on|terminat(?:es|ion date)(?: on)?|تاريخ الانتهاء|ينتهي|تنتهي/],
  ["delivery_date", /deliver(?:y|ed)?(?: date)?(?: by| on| no later than| before)?|shipment date|ship by|dispatch date/],
  ["signature_date", /signed (?:on|this|at)|executed (?:on|this)|date of signature|signature date|in witness whereof/],
  ["agreement_date", /(?:is |was )?made (?:on|this|as of)|entered into (?:on|this|as of)|dated as of/],
  ["period_end", /(?:year|period|quarter|months?) ended|as (?:at|of)|for the year ending/],
  ["payment_date", /paid on|payment date|date of payment/],
  ["issue_date", /issue date|date of issue|issued on|\bdated\b|(?:^|\n)\s*date$/]
];

const RANGE_GAP = /^\s*(?:to|until|till|through|and|-|–|—|up to)\s*$/i;

export function extractDates(ctx: ExtractionContext): DateItem[] {
  const { doc } = ctx;
  const matches = findDates(doc.text, ctx.dateOrder);
  const out: DateItem[] = [];
  const rangeTypes = new Map<number, string>();
  for (let i = 0; i + 1 < matches.length; i++) {
    const a = matches[i]!, b = matches[i + 1]!;
    if (!RANGE_GAP.test(doc.text.slice(a.end, b.start))) continue;
    const lead = doc.text.slice(Math.max(0, a.start - 80), a.start).toLowerCase();
    if (!/(from|between|period|term|commenc|valid|effective|dated)\W*$|(from|between)\s*$/.test(lead) && !/period|term|from|between/.test(lead)) continue;
    const reporting = ctx.type === "financial_report" || /year|quarter|reporting/.test(lead);
    rangeTypes.set(i, reporting ? "period_start" : "effective_date");
    rangeTypes.set(i + 1, reporting ? "period_end" : "expiry_date");
  }
  matches.forEach((m, i) => {
    if (inSuspicious(ctx, m.start, m.end)) return;
    const typed = rangeTypes.get(i) ? { type: rangeTypes.get(i)!, distance: 5 } : nearestRule(ctx.doc, m.start, m.end, DATE_RULES, { left: 90, right: 30 });
    let type = typed?.type ?? "date";
    if (type === "issue_date" && ctx.type === "invoice" && !typed?.type.startsWith("invoice")) type = "invoice_date";
    if (type === "expiry_date" && ctx.type === "quotation") type = "valid_until";
    const typeCertainty = typed ? (typed.distance <= 25 ? 1 : typed.distance <= 60 ? 0.9 : 0.8) : 0.75;
    const base = m.ambiguous ? 0.5 : m.certainty;
    const item: DateItem = {
      type, originalValue: m.original, precision: m.precision,
      confidence: round2(Math.min(0.97, base * typeCertainty)),
      sourceEvidence: doc.evidence(m.start, m.end)
    };
    if (m.normalized) item.normalizedDate = m.normalized;
    out.push(item);
  });
  if (matches.some(m => m.ambiguous)) {
    ctx.warnings.push("Some numeric dates are ambiguous (day/month order cannot be determined from the document); they are returned without normalizedDate.");
  }
  return out;
}

const AMOUNT_RULES: readonly ContextRule<string>[] = [
  ["subtotal", /sub-?\s?total|net amount|amount before (?:tax|vat)|taxable (?:amount|value)|total (?:excl\w*\.?|excluding|before) (?:vat|tax)/],
  ["total", /grand total|total amount|total (?:due|payable|price|value|invoice|cost|sum)|total (?:incl\w*\.?|including|inc\.|with) (?:vat|tax)|amount (?:due|payable)|balance (?:due|payable)|\btotal\b|الإجمالي|المجموع/],
  ["tax", /\bvat\b|\btax\b|\bgst\b|sales tax|ضريبة/],
  ["discount", /discount/],
  ["bid_bond", /bid (?:bond|security|guarantee)|tender (?:bond|security|guarantee)|earnest money/],
  ["performance_bond", /performance (?:bond|security|guarantee)/],
  ["tender_fee", /tender (?:fee|document fee)|cost of (?:the )?(?:tender|bid(?:ding)?) documents?|document fee/],
  ["security_deposit", /security deposit|refundable deposit|\bdeposit\b|تأمين/],
  ["advance_payment", /advance payment|down payment|mobili[sz]ation advance/],
  ["rent", /\brent(?:al)?\b|الإيجار/],
  ["penalty", /penalt(?:y|ies)|liquidated damages|late (?:fee|charge|payment)|\bfines?\b|غرامة/],
  ["liability_cap", /liabilit(?:y|ies)[^.]{0,120}(?:exceed|limited to|capped|cap of)|aggregate liability|maximum liability/],
  ["premium", /\bpremium\b/],
  ["sum_insured", /sum insured|limit of (?:indemnity|liability)|coverage limit|insured (?:amount|value)/],
  ["deductible", /deductible|\bexcess\b/],
  ["unit_price", /unit price|rate per|price per|per unit/],
  ["contract_value", /contract (?:value|price|sum|amount)|total contract|consideration|agreed (?:price|fee|sum)|\bfees? of\b|service fee|annual fee|licen[sc]e fee|قيمة العقد/],
  ["revenue", /\brevenues?\b|\bturnover\b|\bnet sales\b/],
  ["net_income", /net (?:income|profit|loss|earnings)|profit (?:for|after)/],
  ["total_assets", /total assets/],
  ["total_liabilities", /total liabilities/],
  ["total_equity", /total (?:shareholders'? )?equity/],
  ["share_capital", /(?:paid[- ]up|share|authori[sz]ed) capital/],
  ["salary", /salary|remuneration|compensation package/]
];

const FREQUENCY: [AmountItem["frequency"] & string, RegExp][] = [
  ["monthly", /per month|monthly|a month|\/\s?month|\/\s?mo\b|per mensem|p\.?m\.?(?![\w])/],
  ["annual", /per annum|annual(?:ly)?|per year|a year|yearly|\/\s?year|\/\s?yr\b|p\.a\./],
  ["quarterly", /quarterly|per quarter/],
  ["weekly", /weekly|per week/],
  ["daily", /per day|daily|a day/],
  ["one_time", /one-?time|lump sum|one-off/]
];

/** The frequency keyword nearest to the amount (right side first: "OMR 48,000 per annum"). */
export function amountFrequency(ctx: ExtractionContext, start: number, end: number): AmountItem["frequency"] | undefined {
  const text = ctx.doc.text;
  const right = text.slice(end, Math.min(text.length, end + 50)).toLowerCase();
  const left = text.slice(Math.max(0, start - 50), start).toLowerCase();
  let best: { f: AmountItem["frequency"]; d: number } | null = null;
  for (const [f, re] of FREQUENCY) {
    const g = new RegExp(re.source, "g");
    const r = g.exec(right);
    if (r && (!best || r.index < best.d)) best = { f, d: r.index };
    let li = -1;
    for (const m of left.matchAll(new RegExp(re.source, "g"))) li = m.index! + m[0].length;
    if (li >= 0 && (!best || left.length - li + 5 < best.d)) best = { f, d: left.length - li + 5 };
  }
  return best && best.d <= 40 ? best.f : undefined;
}

export function extractAmounts(ctx: ExtractionContext): AmountItem[] {
  const { doc } = ctx;
  const out: AmountItem[] = [];
  const covered: [number, number][] = [];
  let ambiguousNumbers = 0, ambiguousCurrency = 0;
  for (const m of findAmounts(doc.text, ctx.decimalStyle)) {
    if (inSuspicious(ctx, m.start, m.end)) continue;
    covered.push([m.start, m.end]);
    if (m.amount === null) { ambiguousNumbers++; continue; }
    if (m.ambiguousCurrency) ambiguousCurrency++;
    const typed = nearestRule(doc, m.start, m.end, AMOUNT_RULES, { left: 100, right: 25 });
    const conf = (m.ambiguousCurrency ? 0.75 : 0.92) * (typed ? (typed.distance <= 30 ? 1 : 0.9) : 0.85);
    const item: AmountItem = {
      type: typed?.type ?? "amount", amount: m.amount, originalValue: m.original, confidence: round2(conf),
      sourceEvidence: doc.evidence(m.start, m.end)
    };
    if (m.currency) item.currency = m.currency; else if (m.currencySymbol) item.currencySymbol = m.currencySymbol;
    const freq = amountFrequency(ctx, m.start, m.end);
    if (freq) item.frequency = freq;
    out.push(item);
  }
  // Labeled amounts written without a currency marker ("Total: 1,050.00", "Rent | 450").
  const LABELED = /(^|\n)[ \t]*((?:grand |sub-?)?total(?: amount| due| payable)?|amount due|balance due|vat|tax|discount|deposit|security deposit|rent|monthly rent|annual rent|contract value|premium|sum insured)\b[^\n:=\t|]{0,30}?[:=\t|][ \t]*\(?(\d[\d.,' ]*\d|\d)\)?[ \t]*(?=\n|$)/gi;
  for (const m of doc.text.matchAll(LABELED)) {
    const numStart = m.index! + m[0].lastIndexOf(m[3]!);
    const numEnd = numStart + m[3]!.length;
    if (covered.some(([s, e]) => numStart < e && numEnd > s) || inSuspicious(ctx, numStart, numEnd)) continue;
    const amount = parseBareAmount(m[3]!, ctx.decimalStyle);
    if (amount === null) continue;
    const typed = nearestRule(doc, numStart, numEnd, AMOUNT_RULES, { left: 60, right: 0 });
    const item: AmountItem = {
      type: typed?.type ?? "amount", amount, originalValue: m[3]!.trim(), confidence: 0.8, sourceEvidence: doc.evidence(numStart, numEnd)
    };
    if (ctx.declaredCurrency) { item.currency = ctx.declaredCurrency.code; item.confidence = 0.78; }
    const freq = amountFrequency(ctx, numStart, numEnd);
    if (freq) item.frequency = freq;
    out.push(item);
  }
  if (ambiguousNumbers) ctx.warnings.push(`${ambiguousNumbers} amount(s) use a number format whose decimal/thousands separator is ambiguous in this document; they were not normalized and are omitted from amounts.`);
  if (ambiguousCurrency) ctx.warnings.push(`${ambiguousCurrency} amount(s) use a currency symbol shared by several currencies (e.g. "$"); currency is left unset and currencySymbol is returned instead.`);
  return out.sort((a, b) => a.sourceEvidence!.startOffset - b.sourceEvidence!.startOffset);
}

const PERCENT_RULES: readonly ContextRule<string>[] = [
  ["tax_rate", /\bvat\b|\btax\b|\bgst\b/],
  ["late_payment_interest", /interest|late payment/],
  ["penalty_rate", /penalt(?:y|ies)|liquidated damages/],
  ["discount", /discount/],
  ["uptime", /uptime|availability|service level/],
  ["evaluation_weight", /weight(?:ing)?|score|criteri(?:a|on)|evaluation|points/],
  ["advance_payment", /advance/],
  ["retention", /retention/],
  ["escalation", /increase|escalation|index(?:ation|ed)|annual adjustment/],
  ["bid_bond", /bid (?:bond|security)|tender (?:bond|security)/],
  ["performance_bond", /performance (?:bond|security|guarantee)/],
  ["ownership", /\bshares?\b|\bstake\b|\bowned\b|\bownership\b/],
  ["commission", /commission/],
  ["growth", /growth|grew|increase[sd]? by/]
];

export function extractPercentages(ctx: ExtractionContext): PercentageItem[] {
  return findPercentages(ctx.doc.text).filter(p => !inSuspicious(ctx, p.start, p.end)).map(p => {
    const typed = nearestRule(ctx.doc, p.start, p.end, PERCENT_RULES, { left: 90, right: 30 });
    const inCriteria = !typed && /evaluation|criteria|scoring|weight/i.test(ctx.doc.sectionAt(p.start) ?? "");
    return {
      type: typed?.type ?? (inCriteria ? "evaluation_weight" : "percentage"), value: p.value, ratio: p.ratio, originalValue: p.original.trim(),
      confidence: typed ? (typed.distance <= 40 ? 0.9 : 0.8) : 0.75, sourceEvidence: ctx.doc.evidence(p.start, p.end)
    };
  });
}

const DURATION_RULES: readonly ContextRule<string>[] = [
  ["notice_period", /\bnotice\b/],
  ["cure_period", /remedy|cure|rectif/],
  ["payment_terms", /payment|\bpay\b|\bpaid\b|invoice|net\b/],
  ["warranty_period", /warrant|guarantee period|defects? liability/],
  ["delivery_time", /deliver|lead time|shipment|dispatch/],
  ["validity_period", /\bvalid\b|validity/],
  ["probation_period", /probation/],
  ["renewal_term", /renew/],
  ["term", /\bterm\b|period of|for a period|duration|shall (?:remain|continue) in (?:force|effect)|contract period|lease period/]
];

export interface TypedDuration extends DurationMatch { type: string; confidence: number }

export function extractDurations(ctx: ExtractionContext): TypedDuration[] {
  return findDurations(ctx.doc.text).filter(d => !inSuspicious(ctx, d.start, d.end)).map(d => {
    const typed = nearestRule(ctx.doc, d.start, d.end, DURATION_RULES, { left: 80, right: 50 });
    let type = typed?.type ?? "duration";
    if (type === "term" && /\b(?:renew\w*|extension|extend\w*)\b/i.test(ctx.doc.sentenceAt(d.start)?.text ?? "")) type = "renewal_term";
    return { ...d, type, confidence: typed ? (typed.distance <= 30 ? 0.88 : 0.78) : 0.6 };
  });
}
