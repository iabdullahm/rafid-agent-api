import type { Entity } from "../../schemas/documentFactsOutputs.js";
import { DOCUMENT_FACTS_LIMITS as L } from "../config.js";
import { collapse } from "../document.js";
import { findDates } from "../normalize.js";
import { inSuspicious, type ExtractionContext } from "./context.js";
import type { LabeledField } from "./labels.js";

/**
 * Parties and other named entities. Sources, strongest first: contract party definitions
 * ("ACME LLC (the \"Supplier\")"), labeled party fields ("Bill To:"), then names carrying a legal
 * form (LLC, Ltd, GmbH, SAOG, ...) or a government/organization keyword anywhere in the text.
 */

export const PARTY_ROLES = [
  "supplier", "vendor", "seller", "contractor", "service provider", "provider", "consultant", "customer", "client", "buyer", "purchaser",
  "company", "landlord", "lessor", "tenant", "lessee", "licensor", "licensee", "employer", "employee", "insurer", "insured", "borrower",
  "lender", "guarantor", "owner", "agent", "principal", "distributor", "manufacturer", "bidder", "tenderer", "issuer", "authority",
  "first party", "second party", "party a", "party b", "recipient", "discloser", "disclosing party", "receiving party", "partner", "investor", "subcontractor"
] as const;

const LEGAL_FORM = String.raw`(?:L\.?L\.?C\.?|Ltd\.?|Limited|Inc\.?|Incorporated|Corp\.?|Corporation|GmbH|AG|S\.?A\.?O\.?G\.?|S\.?A\.?O\.?C\.?|S\.?A\.?|S\.?A\.?S\.?|S\.?A\.?R\.?L\.?|S\.?p\.?A\.?|S\.?R\.?L\.?|PLC|P\.?L\.?C\.?|LLP|L\.?P\.?|Pty\.?(?: Ltd\.?)?|Pte\.?(?: Ltd\.?)?|B\.?V\.?|N\.?V\.?|FZE|FZCO|FZ-LLC|W\.?L\.?L\.?|SPC|Co\.(?:,? Ltd\.?)?|Company|Holdings?|Group)`;
const COMPANY_RE = new RegExp(String.raw`(?<![\p{L}])((?:[A-Z][\p{L}&'’.-]*|[A-Z]{2,}|al|Al|and|&|of|for|the|de|du|la)(?:[ \t](?:[A-Z][\p{L}&'’.-]*|[A-Z]{2,}|al|Al|and|&|of|for|the|de|du|la|\d+)){0,6},?[ \t]+${LEGAL_FORM})(?![\p{L}])`, "gu");
const GOV_RE = /(?<![\p{L}])((?:The )?(?:Ministry|Department|Directorate|Authority|Municipality|Government|Council|Tender Board|Agency|Commission|Office of|Court|Customs|Police|Embassy|Consulate|Secretariat)(?: of| for| General)?(?:[ \t](?:[A-Z][\p{L}'’&-]*|of|and|for|the|&)){1,8})/gu;
const ORG_RE = /(?<![\p{L}])((?:[A-Z][\p{L}'’&-]*[ \t]){1,5}(?:University|College|Institute|Foundation|Association|Hospital|School|Bank|Fund|Trust|Society|Federation|Chamber of Commerce))(?![\p{L}])/gu;
const PERSON_RE = /(?<![\p{L}])((?:Mr|Mrs|Ms|Miss|Dr|Prof|Eng|Sheikh|Sayyid|H\.E)\.?[ \t]+[A-Z][\p{L}'’-]+(?:[ \t][A-Z][\p{L}'’-]+){0,3})/gu;

const NON_PARTY_DEFINITIONS = /^(?:agreement|contract|services?|goods|products?|works?|project|premises|property|effective date|term|site|deliverables|specifications?|scope|fees?|price|confidential information|territory|schedule|annex|appendix|equipment|software|system|lease|policy|parties|party)$/i;

export function classifyName(name: string): Entity["type"] {
  if (/(?:^|\s)(?:وزارة|هيئة|بلدية|حكومة|مجلس|سلطة|محكمة)(?:\s|$)/u.test(name)) return "government";
  if (/(?:^|\s)(?:شركة|مؤسسة|مجموعة|ش\.م\.ع\.ع|ش\.م\.م)(?:\s|$)/u.test(name)) return "company";
  if (/(?:^|\s)(?:جامعة|جمعية|كلية|مستشفى)(?:\s|$)/u.test(name)) return "organization";
  if (new RegExp(`${LEGAL_FORM}\\.?$`, "u").test(name) || /\b(?:LLC|Ltd|Inc|GmbH|SAOG|PLC|Corp)\b/.test(name)) return "company";
  if (/\b(?:Ministry|Authority|Municipality|Government|Council|Tender Board|Agency|Directorate|Commission|Customs|Embassy|Court)\b/.test(name)) return "government";
  if (/\b(?:University|College|Institute|Foundation|Association|Hospital|School|Society|Federation|Chamber)\b/.test(name)) return "organization";
  if (/^(?:Mr|Mrs|Ms|Miss|Dr|Prof|Eng|Sheikh|Sayyid)\.?\s/.test(name)) return "person";
  if (/\b(?:Bank|Trust|Fund|Group|Holdings?|Company|Co\.|Trading|Enterprises?|Industries|Services|Solutions|Technologies|Systems|Partners)\b/.test(name)) return "company";
  if (/^[A-Z][a-z'’-]+(?:\s[A-Z][a-z'’-]+){1,3}$/.test(name)) return "person";
  return "other";
}

function cleanName(raw: string): string {
  let n = collapse(raw).replace(/^[\s,;:"“”'(]+|[\s,;:"“”')]+$/g, "");
  n = n.replace(/^(?:and|between|by and between|made between|of|to|from|m\/s\.?|messrs\.?)\s+/i, "");
  n = n.split(/,\s*(?:a|an)\s+(?:company|corporation|limited|private|public|body|entity|firm|partnership|government)\b|,\s*(?:incorporated|registered|established|organized|having|with (?:its|a) (?:registered|principal)|whose|located|residing|holder of|represented by|CR\b|C\.R\.|registration)/i)[0]!;
  n = n.replace(/\s*\((?:hereinafter|the|referred)[\s\S]*$/i, "").replace(/[,;]\s*$/, "").trim();
  return n.length > 120 ? n.slice(0, 120).trim() : n;
}

interface Candidate { name: string; type: Entity["type"]; role?: string; confidence: number; start: number; end: number }

export function extractEntities(ctx: ExtractionContext, labeled: readonly LabeledField[]): { entities: Entity[]; definedRoles: Map<string, string> } {
  const { doc } = ctx;
  const cands: Candidate[] = [];
  const definedRoles = new Map<string, string>(); // role alias (lowercase, e.g. "supplier") → entity name

  // 1. Party definitions: `<Name ...> (hereinafter [referred to as] "the Supplier")`, `(the "Tenant")`.
  const DEF = /\((?:hereinafter\s+(?:referred\s+to\s+as\s+|called\s+|known\s+as\s+)?|(?:together|collectively)\s+)?(?:the\s+)?["“'‘]{1}(?:the\s+)?([^"”'’()]{2,40})["”'’]\s*(?:or\s+(?:the\s+)?["“][^"”]{2,30}["”])?\s*\)/gi;
  const head = doc.text.slice(0, Math.min(doc.text.length, 25_000));
  for (const m of head.matchAll(DEF)) {
    const role = m[1]!.trim();
    if (NON_PARTY_DEFINITIONS.test(role) || role.split(/\s+/).length > 4) continue;
    const isPartyRole = PARTY_ROLES.some(r => role.toLowerCase() === r) || /^(?:[A-Z][a-z]+\s?){1,3}$/.test(role);
    if (!isPartyRole) continue;
    // Name: from the previous boundary to the definition.
    const before = head.slice(Math.max(0, m.index! - 400), m.index!);
    const boundary = Math.max(before.lastIndexOf("between"), before.lastIndexOf("Between"), before.lastIndexOf("BETWEEN"), before.lastIndexOf(" and "), before.lastIndexOf(" AND "), before.lastIndexOf("\n"), before.lastIndexOf(";"), before.lastIndexOf(":"));
    const rawStart = m.index! - before.length + (boundary >= 0 ? boundary : 0);
    const name = cleanName(head.slice(rawStart, m.index!).replace(/^\s*(?:between|and)\s*/i, ""));
    if (!name || !/\p{L}{2,}/u.test(name) || name.split(/\s+/).length > 14) continue;
    const found = head.indexOf(name, rawStart);
    const start = found >= 0 && found < m.index! ? found : rawStart;
    if (inSuspicious(ctx, m.index!)) continue;
    const type = classifyName(name);
    cands.push({ name, type, role: role.toLowerCase(), confidence: type === "other" ? 0.72 : 0.9, start: Math.max(0, start), end: Math.max(0, start) + name.length });
    definedRoles.set(role.toLowerCase(), name);
  }

  // 2. Labeled party fields.
  for (const f of labeled) {
    if (f.kind !== "party") continue;
    const first = f.value.split(/\s{2,}|,\s(?=\d)|\t/)[0]!.trim();
    const name = cleanName(first);
    if (!name || !/\p{L}{2,}/u.test(name) || findDates(name).length || name.length < 2) continue;
    const type = classifyName(name);
    cands.push({ name, type, role: f.key, confidence: type === "other" ? 0.7 : 0.85, start: f.valueStart, end: f.valueStart + name.length });
    if (!definedRoles.has(f.key)) definedRoles.set(f.key, name);
  }
  for (const f of labeled) {
    if (f.key === "person_name" && ctx.type === "resume") cands.push({ name: f.value, type: "person", role: "candidate", confidence: 0.85, start: f.valueStart, end: f.valueEnd });
    if (f.key === "company_name") cands.push({ name: cleanName(f.value), type: "company", role: "subject_company", confidence: 0.85, start: f.valueStart, end: f.valueEnd });
    if ((f.kind === "location") && f.value.length >= 4) cands.push({ name: f.value, type: "location", role: f.key, confidence: 0.75, start: f.valueStart, end: f.valueEnd });
  }

  // 3. Names with a legal form / government / organization keyword / person title.
  const scan = (re: RegExp, type: Entity["type"] | null, conf: number) => {
    for (const m of doc.text.slice(0, 120_000).matchAll(re)) {
      const name = cleanName(m[1]!);
      if (name.length < 4 || name.split(/\s+/).length < 2 && type !== "company") continue;
      if (inSuspicious(ctx, m.index!)) continue;
      cands.push({ name, type: type ?? classifyName(name), confidence: conf, start: m.index!, end: m.index! + m[1]!.length });
    }
  };
  scan(COMPANY_RE, "company", 0.72);
  scan(GOV_RE, "government", 0.68);
  scan(ORG_RE, "organization", 0.65);
  scan(PERSON_RE, "person", 0.65);

  // Resume: the first line is usually the candidate's name.
  if (ctx.type === "resume" && !cands.some(c => c.role === "candidate")) {
    const first = doc.lines()[0];
    if (first && /^[\p{Lu}][\p{L}'’-]+(?:\s[\p{Lu}][\p{L}'’-]+){1,3}$/u.test(first.text)) cands.push({ name: first.text, type: "person", role: "candidate", confidence: 0.7, start: first.start, end: first.end });
  }

  // Governing-law jurisdiction as a location.
  const gl = /governed by (?:and construed in accordance with )?the laws? of (?:the )?([A-Z][\p{L} ]{2,40}?)(?=[,.;\n]| and | without)/u.exec(doc.text);
  if (gl && !inSuspicious(ctx, gl.index)) {
    const s = gl.index + gl[0].length - gl[1]!.length;
    cands.push({ name: gl[1]!.trim(), type: "location", role: "governing_law_jurisdiction", confidence: 0.85, start: s, end: s + gl[1]!.length });
  }

  // Merge by normalized name; keep the strongest confidence and every stated role.
  const key = (n: string) => n.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const merged = new Map<string, Candidate & { roles: Set<string> }>();
  for (const c of cands.sort((a, b) => b.confidence - a.confidence)) {
    const k = key(c.name);
    if (!k) continue;
    const existing = merged.get(k) ?? [...merged.values()].find(e => e.type === c.type && (key(e.name).startsWith(k) || k.startsWith(key(e.name))) && Math.min(k.length, key(e.name).length) >= 6);
    if (existing) { if (c.role) existing.roles.add(c.role); continue; }
    merged.set(k, { ...c, roles: new Set(c.role ? [c.role] : []) });
  }
  const entities: Entity[] = [...merged.values()]
    .sort((a, b) => b.confidence - a.confidence || a.start - b.start)
    .slice(0, L.maxItemsPerList)
    .map(c => {
      const e: Entity = { type: c.type, name: c.name, confidence: c.confidence, sourceEvidence: doc.evidence(c.start, c.end) };
      if (c.roles.size) e.role = [...c.roles].join(", ");
      return e;
    });
  return { entities, definedRoles };
}
