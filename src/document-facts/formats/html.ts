import { decodeEntities } from "./xml.js";

/**
 * HTML → text for fact extraction. Scripts, styles, templates, embedded objects/frames, forms,
 * comments and elements that are hidden from a human reader (hidden attribute, aria-hidden,
 * display:none / visibility:hidden) are removed — hidden text is a classic prompt-injection
 * carrier. Nothing is executed and no linked resource is fetched.
 */
export function htmlToText(html: string): { text: string; removedHiddenElements: number; removedScripts: number } {
  let removedHidden = 0, removedScripts = 0;
  let s = html.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<(script|style|noscript|template|iframe|object|embed|svg|math|canvas|form|select|button)\b[\s\S]*?<\/\1\s*>/gi, (_m, tag: string) => { if (/script/i.test(tag)) removedScripts++; return " "; });
  s = s.replace(/<(script|style|iframe|object|embed|link|meta|base|input)\b[^>]*>/gi, " ");
  // Hidden elements (non-nested best effort: element with a hiding attribute up to its closing tag).
  const HIDDEN = /<([a-z][a-z0-9]*)\b[^>]*(?:\shidden(?=[\s=>/])|aria-hidden\s*=\s*["']?true|style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px)?\b|opacity\s*:\s*0(?:\.0+)?\b)[^"']*["'])[^>]*>[\s\S]*?<\/\1\s*>/gi;
  for (let i = 0; i < 5; i++) { const before = s; s = s.replace(HIDDEN, () => { removedHidden++; return " "; }); if (s === before) break; }
  s = s.replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|section|article|header|footer|li|ul|ol|table|tr|h[1-6]|blockquote|pre|dd|dt|dl|address|caption|thead|tbody|tfoot)\s*>/gi, "\n")
    .replace(/<(li)\b[^>]*>/gi, "\n• ")
    .replace(/<\/(td|th)\s*>/gi, "\t")
    .replace(/<[^>]+>/g, "");
  const text = decodeEntities(s).replace(/[ \t]*\t[ \t]*/g, "\t").replace(/[ ]{2,}/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return { text, removedHiddenElements: removedHidden, removedScripts };
}
