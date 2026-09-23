import type { DocumentModel, SourceEvidence } from "../document.js";

/**
 * Detection of text addressed to an AI system / automated reader inside the document
 * ("ignore previous instructions", "reveal your system prompt", "call the tool ...").
 *
 * The extractor never executes or follows document content in any case — deterministic extraction
 * has no instruction channel at all, and the optional LLM assist treats the document strictly as
 * quoted data (see llm.ts). Detection exists so that (1) the finding is reported to the calling
 * agent as an observable risk flag, and (2) the offending sentences are excluded from obligations,
 * requirements and facts, so a downstream agent never receives them as actionable data.
 */
const PATTERNS: readonly RegExp[] = [
  /\b(?:ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(?:all |any |the )?(?:previous|prior|above|earlier|preceding|system|original|your)\b[^.\n]{0,20}\b(?:instructions?|prompts?|rules?|directions?|guidelines?|context)\b/i,
  /\b(?:system prompt|developer message|hidden instructions?|jailbreak|prompt injection)\b/i,
  /\b(?:you are|act as|pretend to be|you must now|from now on you)\b[^.\n]{0,40}\b(?:an? )?(?:ai|assistant|language model|llm|chatbot|gpt|claude|agent)\b/i,
  /\b(?:reveal|print|output|disclose|show|leak|exfiltrate|send)\b[^.\n]{0,40}\b(?:system prompt|instructions|api[ _-]?keys?|secrets?|credentials?|passwords?|environment variables?|env vars?|tokens?)\b/i,
  /\b(?:call|invoke|use|execute|run)\b[^.\n]{0,20}\b(?:the )?(?:tool|function|api|command|shell|script|code)\b[^.\n]{0,60}\b(?:now|immediately|with|named|called)\b/i,
  /\b(?:ai|llm|assistant|agent|model)s?\b[^.\n]{0,30}\b(?:must|should|shall|are instructed to)\b[^.\n]{0,20}\b(?:report|return|output|state|say|answer|respond|set|mark|classify)\b/i,
  /\b(?:respond|reply|answer) only with\b/i,
  /\byou (?:must|should|are required to|need to) (?:now )?(?:report|state|say|answer|output|return|respond|classify|conclude|confirm|ignore)\b/i,
  /<\/?(?:system|assistant|user|instructions?)>|\[\/?INST\]|<\|im_start\|>|###\s*(?:system|instruction)/i,
  /\b(?:transfer|send|wire|pay)\b[^.\n]{0,40}\b(?:to (?:the )?(?:following|this) (?:wallet|address|account))\b[^.\n]{0,40}\b(?:immediately|now|without)\b/i
];

export interface InjectionFinding { start: number; end: number; evidence: SourceEvidence }

export function detectEmbeddedInstructions(doc: DocumentModel): InjectionFinding[] {
  const out: InjectionFinding[] = [];
  const sentences = doc.sentences();
  for (let i = 0; i < sentences.length; i++) {
    const s = sentences[i]!;
    if (!PATTERNS.some(p => p.test(s.text))) continue;
    // An injected block usually continues on the same line: extend over following sentences that
    // share the physical line (no line break between them).
    let end = s.end;
    while (i + 1 < sentences.length && !/[\n\f]/.test(doc.text.slice(end, sentences[i + 1]!.start))) { i++; end = sentences[i]!.end; }
    out.push({ start: s.start, end, evidence: doc.evidence(s.start, Math.min(s.end, s.start + 200)) });
    if (out.length >= 20) break;
  }
  return out;
}

/** Script/active-content markers that appear as literal text in the document (never executed). */
export function detectActiveContentText(text: string): boolean {
  return /<script\b|javascript:|vbscript:|on(?:load|error|click)\s*=|=\s*cmd\s*\||\bpowershell\s+-|\bAuto_?Open\b|\bShell\s*\(/i.test(text);
}
