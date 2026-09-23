import { DOCUMENT_FACTS_LIMITS as L } from "./config.js";

/**
 * The in-memory model every extractor works on: the document's normalized text, where each page
 * starts (only when the source format really has pages), detected section headings, and helpers
 * that turn a character range into short, verifiable source evidence.
 *
 * Page numbers come ONLY from real page boundaries (PDF pages, form-feed separated text, DOCX
 * rendered page breaks). When a format has none, `pageStarts` is null and evidence carries the
 * section/text only — a page number is never invented.
 */

export interface SourceEvidence {
  page?: number;
  section?: string;
  text: string;
  /** Character offsets into the normalized extracted text (metadata.characterCount). */
  startOffset: number;
  endOffset: number;
}

export interface TextSpan { start: number; end: number; text: string }

export interface NormalizationReport {
  hiddenCharactersRemoved: number;
  controlCharactersRemoved: number;
}

const ZERO_WIDTH_AND_BIDI = /[​-‏‪-‮⁠-⁤⁦-⁩﻿­]/g;
// C0/C1 controls except \t \n \f (\f is the page separator for supplied text).
const CONTROL = /[\u0000-\u0008\u000B\u000E-\u001F\u007F-\u009F]/g;
const ARABIC_INDIC = /[٠-٩۰-۹]/g;

/** NFKC (folds full-width digits, ligatures), Arabic-Indic digits → ASCII, strips zero-width and
 *  bidi-override characters (a known way to hide text from human reviewers), unifies line breaks. */
export function normalizeDocumentText(raw: string): { text: string; report: NormalizationReport } {
  let hidden = 0, control = 0;
  let text = raw.normalize("NFKC");
  text = text.replace(ZERO_WIDTH_AND_BIDI, () => { hidden++; return ""; });
  text = text.replace(/\r\n?/g, "\n");
  text = text.replace(CONTROL, () => { control++; return " "; });
  text = text.replace(ARABIC_INDIC, d => String((d.charCodeAt(0) & 0xf) % 10));
  text = text.replace(/[  -   　]/g, " ");
  text = text.replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n");
  return { text, report: { hiddenCharactersRemoved: hidden, controlCharactersRemoved: control } };
}

const HEADING_PATTERNS: readonly RegExp[] = [
  /^(?:article|section|clause|part|schedule|annex|appendix|exhibit)\s+[\dIVXLC]+[A-Za-z]?(?:\.\d+)*\b[\s.:\-–—]*.{0,80}$/i,
  /^\d{1,2}(?:\.\d{1,2}){0,2}\.?\s+[A-Z][A-Za-z&,'()\/ -]{2,70}$/,
  /^[A-Z][A-Z0-9&,'()\/ .-]{3,70}$/
];

export class DocumentModel {
  readonly text: string;
  /** Start offset of each page in `text`, or null when the source has no real page boundaries. */
  readonly pageStarts: readonly number[] | null;
  readonly headings: readonly { offset: number; label: string }[];
  private sentenceCache: TextSpan[] | null = null;
  private lineCache: TextSpan[] | null = null;
  private lowerText: string | null = null;

  constructor(pages: readonly string[] | null, text?: string) {
    if (pages) {
      const starts: number[] = [];
      let acc = "";
      pages.forEach((p, i) => { starts.push(acc.length); acc += p + (i < pages.length - 1 ? "\n\n" : ""); });
      this.text = acc;
      this.pageStarts = starts;
    } else {
      this.text = text ?? "";
      this.pageStarts = null;
    }
    this.headings = detectHeadings(this.text);
  }

  get pageCount(): number | null { return this.pageStarts ? this.pageStarts.length : null; }
  get lower(): string { return (this.lowerText ??= this.text.toLowerCase()); }

  pageAt(offset: number): number | undefined {
    if (!this.pageStarts) return undefined;
    let lo = 0, hi = this.pageStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (this.pageStarts[mid]! <= offset) lo = mid; else hi = mid - 1; }
    return lo + 1;
  }

  sectionAt(offset: number): string | undefined {
    let label: string | undefined;
    for (const h of this.headings) { if (h.offset > offset) break; label = h.label; }
    return label;
  }

  lines(): TextSpan[] {
    if (this.lineCache) return this.lineCache;
    const out: TextSpan[] = [];
    let start = 0;
    for (let i = 0; i <= this.text.length; i++) {
      const ch = this.text[i];
      if (i === this.text.length || ch === "\n" || ch === "\f") {
        const raw = this.text.slice(start, i);
        const lead = raw.length - raw.trimStart().length;
        const t = raw.trim();
        if (t) out.push({ start: start + lead, end: start + lead + t.length, text: t });
        start = i + 1;
      }
    }
    return (this.lineCache = out);
  }

  /** Sentence-like spans: split at sentence punctuation followed by a capital/digit/quote, at blank
   *  lines, at list-item/heading line starts and at page boundaries. Abbreviations and decimal
   *  numbers do not split. Soft line wraps inside a sentence are kept together. */
  sentences(): TextSpan[] {
    if (this.sentenceCache) return this.sentenceCache;
    const text = this.text;
    const out: TextSpan[] = [];
    const push = (s: number, e: number) => {
      while (s < e && /\s/.test(text[s]!)) s++;
      while (e > s && /\s/.test(text[e - 1]!)) e--;
      if (e > s) out.push({ start: s, end: e, text: collapse(text.slice(s, e)) });
    };
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]!;
      if (ch === "\f") { push(start, i); start = i + 1; continue; }
      if (ch === "\n") {
        const next = text.slice(i + 1, i + 40);
        const prevLine = text.slice(text.lastIndexOf("\n", i - 1) + 1, i).trim();
        if (/^\s*\n/.test(next) || /^\s*(?:[-•*▪·◦]|\(?[a-z]\)|\(?[ivx]{1,4}\)|\d{1,2}(?:\.\d{1,2})*[.)])\s/i.test(next)
          || isHeadingLine(prevLine) || /^\s*[\p{Lu}][\p{L}\p{N} /#.()%&'-]{1,40}[:：]\s/u.test(next) || /^[\p{L}][\p{L}\p{N} /#.()%&'-]{1,40}[:：]\s*\S/u.test(prevLine) || /[:;]\s*$/.test(prevLine) && prevLine.length < 60) {
          push(start, i); start = i + 1;
        }
        continue;
      }
      if ((ch === "." || ch === "!" || ch === "?" || ch === ";") && /\s/.test(text[i + 1] ?? " ")) {
        if (ch === "." && isAbbreviation(text, i)) continue;
        const after = text.slice(i + 1, i + 4).trimStart();
        if (ch === ";" || after === "" || /^[A-Z0-9"“'(\[؀-ۿ]/.test(after)) { push(start, i + 1); start = i + 1; }
      }
      if (i - start > 1200) { push(start, i); start = i; } // guard: pathological run-on text
    }
    push(start, text.length);
    return (this.sentenceCache = out);
  }

  /** The sentence containing [start, end), or null. */
  sentenceAt(start: number): TextSpan | null {
    const s = this.sentences();
    let lo = 0, hi = s.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (s[mid]!.end < start) lo = mid + 1; else if (s[mid]!.start > start) hi = mid - 1; else return s[mid]!;
    }
    return null;
  }

  /** Short evidence for a match at [start, end): the containing sentence, trimmed around the match
   *  to at most maxEvidenceChars. Offsets always point at the match itself. */
  evidence(start: number, end: number): SourceEvidence {
    const sentence = this.sentenceAt(start);
    let excerpt: string;
    if (sentence && sentence.end >= end) {
      excerpt = window(this.text, Math.max(sentence.start, start - 160), Math.min(sentence.end, end + 160), start, end);
    } else {
      excerpt = window(this.text, Math.max(0, start - 100), Math.min(this.text.length, end + 100), start, end);
    }
    const page = this.pageAt(start);
    const section = this.sectionAt(start);
    return { ...(page !== undefined ? { page } : {}), ...(section ? { section } : {}), text: excerpt, startOffset: start, endOffset: end };
  }

  /** Finds a verbatim quote (whitespace/quote-style/case-insensitive) in the document. Used to verify
   *  LLM-supplied evidence; returns the matched range or null. */
  locateQuote(quote: string): { start: number; end: number } | null {
    const needle = canonical(quote).trim();
    if (needle.length < 8) return null;
    const { canon, map } = this.canonicalIndex();
    const idx = canon.indexOf(needle);
    if (idx < 0) return null;
    return { start: map[idx]!, end: map[idx + needle.length - 1]! + 1 };
  }

  private canonCache: { canon: string; map: number[] } | null = null;
  private canonicalIndex(): { canon: string; map: number[] } {
    if (this.canonCache) return this.canonCache;
    let canon = "";
    const map: number[] = [];
    let lastSpace = true;
    for (let i = 0; i < this.text.length; i++) {
      let c = canonicalChar(this.text[i]!);
      if (/\s/.test(c)) { if (lastSpace) continue; c = " "; lastSpace = true; } else lastSpace = false;
      canon += c; map.push(i);
    }
    return (this.canonCache = { canon, map });
  }
}

function canonicalChar(c: string): string {
  if (c === "“" || c === "”" || c === "„" || c === "«" || c === "»") return '"';
  if (c === "‘" || c === "’" || c === "`") return "'";
  if (c === "–" || c === "—" || c === "‑") return "-";
  return c.toLowerCase();
}
function canonical(s: string): string {
  let out = "", lastSpace = true;
  for (const ch of s) {
    let c = canonicalChar(ch);
    if (/\s/.test(c)) { if (lastSpace) continue; c = " "; lastSpace = true; } else lastSpace = false;
    out += c;
  }
  return out;
}

export function collapse(s: string): string { return s.replace(/\s+/g, " ").trim(); }

function window(text: string, from: number, to: number, matchStart: number, matchEnd: number): string {
  const max = L.maxEvidenceChars;
  let s = from, e = to;
  if (e - s > max) {
    const matchLen = matchEnd - matchStart;
    const room = Math.max(0, max - matchLen);
    s = Math.max(from, matchStart - Math.floor(room * 0.6));
    e = Math.min(to, s + max);
  }
  // Snap to word boundaries.
  if (s > from) { const sp = text.indexOf(" ", s); if (sp > -1 && sp < matchStart) s = sp + 1; }
  if (e < to) { const sp = text.lastIndexOf(" ", e); if (sp > matchEnd) e = sp; }
  let out = collapse(text.slice(s, e));
  if (s > from) out = "…" + out;
  if (e < to) out = out + "…";
  return out;
}

const ABBREVIATIONS = new Set(["no", "nos", "co", "ltd", "inc", "corp", "mr", "mrs", "ms", "dr", "prof", "st", "art", "sec", "cl", "para", "vs", "etc", "e.g", "i.e", "approx", "est", "dept", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec", "p.a", "ref", "tel", "fig", "vol", "pp", "llc", "l.l.c", "w.l.l", "s.a", "u.s", "u.k", "r.o", "p.o", "a.m", "p.m", "govt", "int'l", "mfg"]);
function isAbbreviation(text: string, dot: number): boolean {
  if (/\d/.test(text[dot - 1] ?? "") && /\d/.test(text[dot + 1] ?? "")) return true;
  const m = /([A-Za-z][A-Za-z.']{0,7})$/.exec(text.slice(Math.max(0, dot - 8), dot));
  if (!m) return false;
  const w = m[1]!.toLowerCase();
  if (ABBREVIATIONS.has(w)) return true;
  return /^[a-z]$/i.test(w) && /[A-Z]/.test(m[1]!); // an initial ("J. Smith")
}

export function isHeadingLine(line: string): boolean {
  const t = line.trim();
  if (t.length < 3 || t.length > 90) return false;
  if (/[.,;]$/.test(t) && !/^(?:article|section|clause)\s/i.test(t)) return false;
  if (/^[A-Z][A-Z0-9&,'()\/ .-]{3,70}$/.test(t)) {
    const letters = t.replace(/[^A-Za-z]/g, "");
    return letters.length >= 4 && !/\d{3,}/.test(t);
  }
  return HEADING_PATTERNS.slice(0, 2).some(p => p.test(t));
}

function detectHeadings(text: string): { offset: number; label: string }[] {
  const out: { offset: number; label: string }[] = [];
  let pos = 0;
  for (const raw of text.split(/\n|\f/)) {
    const t = raw.trim();
    if (t && isHeadingLine(t)) {
      const offset = pos + raw.indexOf(t);
      out.push({ offset, label: t.length > 80 ? t.slice(0, 77) + "…" : t });
    }
    pos += raw.length + 1;
  }
  return out;
}
