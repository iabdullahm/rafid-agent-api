import type { Deadline, Obligation, Requirement } from "../../schemas/documentFactsOutputs.js";
import { DOCUMENT_FACTS_LIMITS as L } from "../config.js";
import { collapse, isHeadingLine, type SourceEvidence, type TextSpan } from "../document.js";
import { findDates, parseNumber } from "../normalize.js";
import { inSuspicious, round2, type ExtractionContext } from "./context.js";
import { PARTY_ROLES } from "./entities.js";

/**
 * Sentence-level extraction: obligations (who must / must not do what, by when, under which
 * condition), requirements (tender eligibility, mandatory documents, policy rules), deadlines,
 * clause-backed facts (renewal, termination, liability, governing law, ...) and invoice/PO line
 * items. Only sentences present in the document are returned (as short excerpts), never
 * paraphrases.
 */

const MODAL = /\b(shall not|must not|may not|will not|is not permitted to|agrees not to|undertakes not to|shall|must|agrees? to|undertakes? to|is (?:required|obliged|obligated|responsible) (?:to|for)|are (?:required|obliged|responsible) (?:to|for)|will be responsible for|is liable (?:to|for))\b/i;
const NOT_OBLIGATION = /\bshall (?:mean|be deemed|be construed|include|have the meaning|refer to|be interpreted|be governed|prevail|survive|commence|expire|terminate automatically|continue|remain|(?:automatically )?renew|apply|bear|be effective|come into (?:force|effect)|not exceed|be payable|be subject to|be entitled)\b|\bmay\b(?! not)/i;
const CONDITION = /\b(if|in the event (?:that|of)|provided (?:that|always)|unless|subject to|upon|where|in case(?: of)?)\b([^.;:]{3,160})/i;
const WITHIN = /\b(within \S+(?: \(\d+\))?(?: calendar| business| working)? (?:days?|weeks?|months?|hours?|years?)(?: (?:of|from|after|following|before|prior to) [^,.;]{3,80})?|no later than [^,.;]{3,60}|(?:on or )?before [^,.;]{3,60}|by (?:no later than )?(?:\d{1,2}(?:st|nd|rd|th)? \w+ \d{4}|\w+ \d{1,2},? \d{4}|\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4})|prior to [^,.;]{3,60}|immediately|forthwith|promptly)/i;

const REQUIREMENT_WORDS = /\b(required|requirement|mandatory|must (?:submit|provide|have|hold|possess|include|attach|demonstrate)|shall (?:submit|attach|furnish)|eligib\w*|bidders? (?:must|shall|should)|tenderers? (?:must|shall|should)|applicants? (?:must|shall|should)|candidates? (?:must|shall|should)|no bid will be|will be (?:rejected|disqualified))\b/i;
/** Weaker requirement vocabulary, only for documents whose purpose is to state requirements. */
const REQUIREMENT_WORDS_WEAK = /\b(minimum|at least|qualif\w*|certificat\w*|valid (?:commercial|trade|cr)|experience of|must be|shall provide)\b/i;
const REQ_HEADING = /requirement|eligibil|qualification|mandatory|documents? (?:to be|required)|submission|conditions|instructions to (?:bidders|tenderers)/i;
const NOT_REQ_HEADING = /evaluation|scoring|award criteria|weighting/i;

export function splitIntoClauseSentences(ctx: ExtractionContext): TextSpan[] {
  return ctx.doc.sentences().filter(s => s.text.length >= 12 && !inSuspicious(ctx, s.start, s.end));
}

function excerpt(ctx: ExtractionContext, s: TextSpan): { text: string; evidence: SourceEvidence } {
  const bullet = /^(?:[-•*▪·◦]|\(?[a-z0-9ivx]{1,3}[.)])\s+/i.exec(s.text);
  if (bullet) s = { start: s.start + bullet[0].length, end: s.end, text: s.text.slice(bullet[0].length) };
  const text = s.text.length > 300 ? s.text.slice(0, 297).replace(/\s+\S*$/, "") + "…" : s.text;
  return { text, evidence: ctx.doc.evidence(s.start, Math.min(s.end, s.start + 300)) };
}

function partyOf(before: string, definedRoles: Map<string, string>): string | undefined {
  const b = before.toLowerCase();
  let best: { idx: number; name: string } | null = null;
  const roles = new Set<string>([...definedRoles.keys(), ...PARTY_ROLES, "each party", "either party", "both parties", "the parties", "bidder", "the bidder", "tenderer", "applicant", "candidate", "employee", "employees", "staff", "we", "you"]);
  for (const r of roles) {
    const re = new RegExp(`(?<![\\p{L}])${r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?(?![\\p{L}])`, "giu");
    for (const m of b.matchAll(re)) if (!best || m.index! > best.idx) best = { idx: m.index!, name: r };
  }
  if (!best) return undefined;
  const role = best.name;
  return role.replace(/\b\w/g, c => c.toUpperCase());
}

export function extractObligations(ctx: ExtractionContext, sentences: readonly TextSpan[], definedRoles: Map<string, string>): Obligation[] {
  const out: Obligation[] = [];
  for (const s of sentences) {
    const m = MODAL.exec(s.text);
    if (!m || NOT_OBLIGATION.test(s.text.slice(Math.max(0, m.index - 5), m.index + 40))) continue;
    if (s.text.length < 25 || /^(?:article|section|clause|schedule)\s+\d/i.test(s.text) && s.text.length < 60) continue;
    const negative = /not/i.test(m[1]!);
    const ex = excerpt(ctx, s);
    const party = partyOf(s.text.slice(0, m.index), definedRoles);
    const o: Obligation = { obligation: ex.text, modality: negative ? "must_not" : "must", confidence: round2(party ? 0.85 : 0.75), sourceEvidence: ex.evidence };
    if (party) o.party = party;
    const w = WITHIN.exec(s.text);
    if (w) o.deadline = collapse(w[1]!);
    const c = CONDITION.exec(s.text);
    if (c) o.condition = collapse(`${c[1]}${c[2]}`);
    if (s.text.length > 450) o.confidence = round2(o.confidence - 0.1);
    out.push(o);
    if (out.length >= L.maxItemsPerList) break;
  }
  return out;
}

function requirementCategory(t: string): Requirement["category"] {
  const l = t.toLowerCase().replace(/^(?:[-•*▪·◦]\s*)/, "");
  if (/^(?:a |an |the )?(?:copy|copies|certified|original|signed|stamped|scanned)\b/.test(l)) return "documentation";
  if (/turnover|financial|audited|bank guarantee|bond|security|capital|net worth|solvency|credit|insurance cover/.test(l)) return "financial";
  if (/experience|registration|registered|licen[cs]e|eligib|qualif|classification|years in business|track record|similar projects/.test(l)) return "eligibility";
  if (/technical|specification|capacity|equipment|methodology|staff|personnel|iso|standard|performance|uptime|compatib/.test(l)) return "technical";
  if (/submit|copy|copies|certificate|document|form|attach|letter|affidavit|declaration|stamp|signed/.test(l)) return "documentation";
  if (/comply|compliance|law|regulation|confidential|conflict of interest|code of conduct|anti-?bribery|data protection/.test(l)) return "compliance";
  return "general";
}

export function extractRequirements(ctx: ExtractionContext, sentences: readonly TextSpan[], definedRoles: Map<string, string>): Requirement[] {
  const out: Requirement[] = [];
  const seen = new Set<string>();
  const requirementDoc = ["tender", "policy", "resume", "other", "company_profile", "legal_document"].includes(ctx.type);
  for (const s of sentences) {
    const section = ctx.doc.sectionAt(s.start) ?? "";
    if (NOT_REQ_HEADING.test(section)) continue;
    const underHeading = REQ_HEADING.test(section);
    const hasWords = REQUIREMENT_WORDS.test(s.text) || (requirementDoc && REQUIREMENT_WORDS_WEAK.test(s.text));
    const isListItem = /^(?:[-•*▪·◦]|\(?[a-z0-9ivx]{1,3}[.)])\s/i.test(ctx.doc.text.slice(s.start, s.start + 6));
    const modal = MODAL.test(s.text) && !NOT_OBLIGATION.test(s.text);
    if (!(hasWords || (underHeading && (isListItem || modal)) || (requirementDoc && modal && ctx.type !== "other"))) continue;
    if (s.text.length < 15 || isHeadingLine(s.text)) continue;
    const ex = excerpt(ctx, s);
    const k = ex.text.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    const mandatory = /mandatory|required/i.test(section) && isListItem || /\b(must|shall|mandatory|required|will be (?:rejected|disqualified)|no bid will)\b/i.test(s.text) && !/\b(preferred|desirable|optional|should|may)\b/i.test(s.text);
    const r: Requirement = { requirement: ex.text, category: requirementCategory(s.text), mandatory, confidence: round2(hasWords ? 0.82 : 0.72), sourceEvidence: ex.evidence };
    const party = partyOf(s.text.slice(0, 200), definedRoles);
    if (party) r.party = party;
    const w = WITHIN.exec(s.text);
    if (w) r.deadline = collapse(w[1]!);
    out.push(r);
    if (out.length >= L.maxItemsPerList) break;
  }
  return out;
}

const DEADLINE_WORDS: [string, RegExp][] = [
  ["submission_deadline", /submission|submit(?:ted)?|closing date|bids? (?:must|shall) be|proposals? (?:must|shall) be|tenders? (?:must|shall) be/i],
  ["payment_deadline", /payment|pay|paid|invoice|due/i],
  ["delivery_deadline", /deliver|shipment|dispatch|install/i],
  ["notice_deadline", /notice|notify/i],
  ["renewal_deadline", /renew/i],
  ["expiry", /expir|terminat|end of|valid until|valid till/i],
  ["clarification_deadline", /clarification|queries|questions/i],
  ["completion_deadline", /complet|commission|handover|milestone/i]
];

export function extractDeadlines(ctx: ExtractionContext, sentences: readonly TextSpan[]): Deadline[] {
  const out: Deadline[] = [];
  const KEY = /\b(deadline|due|no later than|not later than|on or before|before|by|within|closing date|last date|expire|expiry|must be (?:received|submitted|paid|delivered)|shall be (?:received|submitted|paid|delivered|completed))\b/i;
  for (const s of sentences) {
    if (!KEY.test(s.text)) continue;
    const keyAt = KEY.exec(s.text)!.index;
    const all = findDates(s.text, ctx.dateOrder).filter(d => !d.ambiguous && d.precision === "day");
    const dates = [...all.filter(d => d.start >= keyAt), ...all.filter(d => d.start < keyAt).reverse()];
    const rel = WITHIN.exec(s.text);
    if (!dates.length && !(rel && /within|prior to|no later than/i.test(rel[1]!))) continue;
    const type = DEADLINE_WORDS.find(([, re]) => re.test(s.text))?.[0] ?? "deadline";
    const ex = excerpt(ctx, s);
    const d: Deadline = { type, description: ex.text, confidence: dates.length ? 0.85 : 0.75, sourceEvidence: ex.evidence };
    if (dates.length) d.date = dates[0]!.normalized!;
    if (rel && !dates.length) d.relative = collapse(rel[1]!);
    out.push(d);
    if (out.length >= L.maxItemsPerList) break;
  }
  return out;
}

// ---- Clause-backed facts ----------------------------------------------------------------------

export interface ClauseHit { key: string; label: string; value: unknown; sentence: TextSpan; confidence: number }

const CLAUSES: readonly { key: string; label: string; re: RegExp; value?: (s: string) => unknown; confidence?: number }[] = [
  { key: "automatic_renewal", label: "Automatic renewal", re: /\b(?:automatically renew\w*|auto-?renew\w*|renew\w* automatically|shall be renewed for (?:a )?(?:further|successive|additional)|tacit(?:ly)? renew\w*|deemed (?:to be )?renewed)\b/i, value: () => true, confidence: 0.9 },
  { key: "renewal_terms", label: "Renewal", re: /\b(?:renew\w*|extension of (?:the )?term|extend(?:ed)? (?:for|by) (?:a )?further)\b/i },
  { key: "termination_clause", label: "Termination", re: /\bterminat\w+\b[^.]{0,200}\b(?:notice|breach|convenience|insolven\w*|at any time|without cause|for cause)\b/i },
  { key: "termination_for_convenience", label: "Termination for convenience", re: /\bterminat\w+\b[^.]{0,120}\b(?:for convenience|at any time|without cause|for any reason)\b/i, value: () => true, confidence: 0.85 },
  { key: "penalty_clause", label: "Penalty / liquidated damages", re: /\b(?:liquidated damages|penalt(?:y|ies)|late (?:delivery )?(?:fee|charge)s?|delay damages)\b/i },
  { key: "service_level", label: "Service level (SLA)", re: /\b(?:service levels? (?:agreement|shall|of)|sla\b|uptime|\d+(?:\.\d+)?\s?% (?:availability|uptime)|availability of \d|response times? (?:of|shall|within)|respond[^.]{0,40}within|resolution times?)/i },
  { key: "limitation_of_liability", label: "Limitation of liability", re: /\b(?:limitation of liability|liability[^.]{0,80}(?:shall not exceed|limited to|capped)|in no event shall[^.]{0,80}liab\w+|aggregate liability)\b/i },
  { key: "unlimited_liability", label: "Unlimited liability language", re: /\b(?:unlimited liability|liability shall be unlimited|without (?:any )?limit(?:ation)? (?:of|on|to) (?:its |their )?liability|shall be (?:fully|jointly and severally) liable for all)\b/i, value: () => true, confidence: 0.85 },
  { key: "indemnity", label: "Indemnity", re: /\bindemnif\w+|hold harmless\b/i },
  { key: "warranties", label: "Warranties", re: /\bwarrant(?:s|y|ies)\b|\bguarantee(?:s|d)? (?:that|the quality|against defects)\b/i },
  { key: "confidentiality", label: "Confidentiality", re: /\bconfidential(?:ity)?\b[^.]{0,100}\b(?:shall|must|agree|undertake|not disclose)\b/i },
  { key: "force_majeure", label: "Force majeure", re: /\bforce majeure\b/i },
  { key: "dispute_resolution", label: "Dispute resolution", re: /\b(?:arbitration|arbitral|dispute[s]? (?:shall|will) be (?:referred|settled|resolved)|exclusive jurisdiction|courts of)\b/i },
  { key: "exclusivity", label: "Exclusivity", re: /\bexclusiv(?:e|ity)\b[^.]{0,80}\b(?:right|supplier|distribut|agreement|basis)\b/i },
  { key: "unilateral_amendment", label: "Unilateral amendment right", re: /\b(?:may|reserves the right to) (?:amend|modify|change|vary|revise)\b[^.]{0,120}\b(?:at (?:its|their) (?:sole )?discretion|without (?:prior )?(?:notice|consent))\b/i, value: () => true, confidence: 0.8 },
  { key: "payment_terms", label: "Payment terms", re: /\b(?:net \d{1,3}\b|payment[^.]{0,60}\bwithin \S+(?: \(\d+\))? (?:calendar |business |working )?days|payable (?:in advance|monthly|quarterly|annually|upon|on receipt|within)|\d{1,3}\s?% (?:advance|upon|on delivery|payment)|advance payment|payment (?:schedule|terms?)|paid (?:in advance|monthly|quarterly|annually))/i }
];

export function extractClauseFacts(ctx: ExtractionContext, sentences: readonly TextSpan[]): ClauseHit[] {
  const hits: ClauseHit[] = [];
  for (const c of CLAUSES) {
    const s = sentences.find(x => x.text.length >= 25 && !isHeadingLine(x.text) && c.re.test(x.text) && !/^(?:table of contents|contents)\b/i.test(x.text));
    if (!s) continue;
    const ex = s.text.length > 300 ? s.text.slice(0, 297).replace(/\s+\S*$/, "") + "…" : s.text;
    hits.push({ key: c.key, label: c.label, value: c.value ? c.value(s.text) : ex, sentence: s, confidence: c.confidence ?? 0.8 });
  }
  // Governing law.
  const gl = /\bgoverned by(?: and construed in accordance with)?(?: the)? laws? of(?: the)? ([A-Z][\p{L} ]{2,40}?)(?=[,.;\n]| and | without)/u.exec(ctx.doc.text);
  if (gl && !inSuspicious(ctx, gl.index)) {
    const s = ctx.doc.sentenceAt(gl.index) ?? { start: gl.index, end: gl.index + gl[0].length, text: gl[0] };
    hits.push({ key: "governing_law", label: "Governing law", value: gl[1]!.trim(), sentence: { ...s, start: gl.index + gl[0].length - gl[1]!.length, end: gl.index + gl[0].length }, confidence: 0.9 });
  }
  // "Net 30" payment terms → normalized net days (handled by caller via value string).
  return hits;
}

// ---- Line items -------------------------------------------------------------------------------

export interface LineItem { description: string; quantity: number; unitPrice: number; amount: number }

/** Line items from table-like lines (description, quantity, unit price, line total). A row is
 *  accepted ONLY when quantity × unit price equals the line total (±0.5%), so a misread column
 *  never becomes a fact. */
export function extractLineItems(ctx: ExtractionContext): { items: LineItem[]; start: number; end: number } | null {
  if (!["invoice", "purchase_order", "quotation"].includes(ctx.type)) return null;
  const ROW = /^(?:\d{1,3}[.)]?\s+)?([\p{L}][^\t|]{1,80}?)[\s|]{2,}|\t/u;
  const items: LineItem[] = [];
  let first = -1, last = -1;
  for (const line of ctx.doc.lines()) {
    if (inSuspicious(ctx, line.start, line.end) || !/\d/.test(line.text)) continue;
    const nums = [...line.text.matchAll(/(?<![\p{L}\d.,])(\d{1,3}(?:[,.]\d{3})*(?:[.,]\d{1,3})?|\d+(?:[.,]\d{1,3})?)(?![\d])/gu)];
    if (nums.length < 3) continue;
    const last3 = nums.slice(-3).map(n => parseNumber(n[1]!, ctx.decimalStyle));
    if (last3.some(v => v === null)) continue;
    const [q, u, a] = last3 as [number, number, number];
    if (q <= 0 || q > 1e6 || Math.abs(q * u - a) > Math.max(0.01, a * 0.005)) continue;
    const descEnd = nums[nums.length - 3]!.index!;
    const desc = collapse(line.text.slice(0, descEnd).replace(/^\d{1,3}[.)]?\s+/, "").replace(/[\s|:@x×-]+$/i, "").replace(/\b[A-Z]{3}\s*$/, "").replace(/\b(?:pcs?|units?|nos?|ea|each|qty)\s*$/i, "").trim());
    if (!/\p{L}{2,}/u.test(desc) || /\b(?:total|subtotal|vat|tax|discount|balance)\b/i.test(desc)) continue;
    if (!ROW.test(line.text) && !/\s{2,}|\t|\|/.test(line.text)) { /* single-spaced rows are still accepted when the arithmetic checks out */ }
    items.push({ description: desc, quantity: q, unitPrice: u, amount: a });
    if (first < 0) first = line.start;
    last = line.end;
    if (items.length >= L.maxItemsPerList) break;
  }
  return items.length ? { items, start: first, end: last } : null;
}

// ---- Lists under headings (tender requirements, mandatory documents, evaluation criteria) -------

export interface HeadingList { heading: string; items: { text: string; start: number; end: number }[] }

export function listsUnderHeadings(ctx: ExtractionContext, headingRe: RegExp): HeadingList[] {
  const out: HeadingList[] = [];
  const lines = ctx.doc.lines();
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i]!;
    if (h.text.length > 90 || !headingRe.test(h.text) || /[.;]$/.test(h.text)) continue;
    const shortTitle = h.text.split(/\s+/).length <= 6 && !/[.,;!?]$/.test(h.text) && /^[\p{Lu}\d]/u.test(h.text);
    if (/^(?:[-•*▪·◦]|\(?[a-z0-9ivx]{1,3}[.)])\s/i.test(h.text) || !(isHeadingLine(h.text) || /[:：]$/.test(h.text) || shortTitle)) continue;
    const items: HeadingList["items"] = [];
    for (let j = i + 1; j < lines.length && items.length < 30; j++) {
      const l = lines[j]!;
      const bullet = /^(?:[-•*▪·◦]|\(?[a-z0-9ivx]{1,3}[.)])\s+(.+)$/i.exec(l.text);
      if (!bullet) { if (items.length) break; if (j > i + 2) break; continue; }
      if (inSuspicious(ctx, l.start, l.end)) continue;
      const text = bullet[1]!.trim();
      items.push({ text: text.length > 240 ? text.slice(0, 237) + "…" : text, start: l.end - bullet[1]!.length, end: l.end });
    }
    if (items.length) out.push({ heading: h.text, items });
  }
  return out;
}

export function parseEvaluationCriteria(ctx: ExtractionContext): { criterion: string; weight: number | null; start: number; end: number }[] {
  const out: { criterion: string; weight: number | null; start: number; end: number }[] = [];
  const lists = listsUnderHeadings(ctx, /evaluation|criteria|scoring|award/i);
  for (const l of lists) for (const it of l.items) {
    const w = /(\d{1,3}(?:\.\d+)?)\s?(?:%|percent|points|marks)/i.exec(it.text);
    out.push({ criterion: it.text.replace(/[\s:–-]*\(?\d{1,3}(?:\.\d+)?\s?(?:%|percent|points|marks)\)?\s*$/i, "").trim(), weight: w ? Number(w[1]) : null, start: it.start, end: it.end });
  }
  return out;
}
