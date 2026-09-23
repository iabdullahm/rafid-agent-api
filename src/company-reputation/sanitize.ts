/**
 * External content is DATA, never instructions. Every title/snippet/page excerpt that enters the
 * evidence model passes through here first:
 *  - HTML tags, scripts, control and zero-width/bidi characters are stripped;
 *  - text is length-bounded;
 *  - sentences that look like instructions aimed at an AI system ("ignore previous instructions",
 *    "you are now…", "system prompt", tool/role markup) are replaced with a neutral marker and the
 *    item is flagged, so a downstream agent reading this capability's output can't be steered by
 *    text a third party planted on a web page.
 * Nothing in this capability ever feeds external text to an LLM or evaluates it; classification is
 * deterministic keyword analysis over the sanitized text.
 */

const INJECTION_PATTERNS: readonly RegExp[] = [
  /\b(ignore|disregard|forget|override)\b[^.!?\n]{0,40}\b(previous|prior|above|earlier|all|any)\b[^.!?\n]{0,30}\b(instruction|instructions|prompt|prompts|rules|directions|context)\b/i,
  /\b(system|developer)\s*(prompt|message|instruction)s?\b/i,
  /\byou\s+are\s+(now|an?\s+(ai|assistant|language model|llm|agent))\b/i,
  /\b(act|behave|respond)\s+as\s+(if\s+you\s+are|an?)\b[^.!?\n]{0,40}\b(ai|assistant|model|agent|system)\b/i,
  /\b(assistant|ai|agent|model|llm)\s*[:,]\s*(please\s+)?(ignore|say|respond|reply|output|print|return|mark|rate|classify|conclude)\b/i,
  /<\/?\s*(system|assistant|user|tool|instructions?)\s*>/i,
  /\[\s*(system|inst|\/inst)\s*\]/i,
  /\b(rate|score|classify|mark)\s+(this\s+)?(company|vendor|supplier|business)\s+as\s+(safe|trusted|trustworthy|legitimate|low[-\s]?risk|verified)\b/i
];

export const INJECTION_MARKER = "[instruction-like text removed]";

export interface SanitizedText { text: string; injectionDetected: boolean }

export function stripHtml(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&quot;/gi, "\"").replace(/&#39;|&apos;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&#(\d{1,6});/g, (_m, d: string) => { const n = Number(d); return n > 31 && n < 0x10ffff ? String.fromCodePoint(n) : " "; });
}

export function sanitizeExternalText(input: string | null | undefined, maxLength: number): SanitizedText {
  if (!input) return { text: "", injectionDetected: false };
  let text = stripHtml(String(input))
    // control chars, zero-width and bidi overrides
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁠-⁤﻿]/g, "")
    // leftover markup-ish angle brackets (after tag stripping) are not needed in evidence text
    .replace(/[<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let injectionDetected = false;
  const sentences = text.split(/(?<=[.!?])\s+/);
  const kept = sentences.map(sentence => {
    if (INJECTION_PATTERNS.some(p => p.test(sentence))) { injectionDetected = true; return INJECTION_MARKER; }
    return sentence;
  });
  text = kept.join(" ");
  if (text.length > maxLength) text = `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
  return { text, injectionDetected };
}

/** Convenience: sanitized string or null when empty. */
export function cleanOrNull(input: string | null | undefined, maxLength: number): string | null {
  const { text } = sanitizeExternalText(input, maxLength);
  return text || null;
}
