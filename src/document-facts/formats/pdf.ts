import { DOCUMENT_FACTS_LIMITS as L } from "../config.js";
import { documentTooLarge, unreadableDocument } from "../errors.js";
import type { ExtractedPages } from "./docx.js";

/**
 * PDF → per-page text via unpdf (a serverless build of Mozilla pdf.js). Hardened options:
 * isEvalSupported=false (no dynamic code generation for fonts — mitigates pdf.js font-program
 * code-execution issues), no font-face injection, no system fonts, no worker. PDF JavaScript,
 * actions, forms, attachments and links are never executed or followed — only the text layer is
 * read. The page limit is checked from the document's page tree BEFORE any page is parsed.
 */
export async function extractPdf(buf: Buffer): Promise<ExtractedPages> {
  const { getDocumentProxy } = await import("unpdf");
  let doc: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    doc = await getDocumentProxy(new Uint8Array(buf), {
      isEvalSupported: false, disableFontFace: true, useSystemFonts: false, stopAtErrors: false, verbosity: 0
    } as Parameters<typeof getDocumentProxy>[1]);
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    if (name === "PasswordException") throw unreadableDocument("the PDF is password-protected/encrypted.");
    throw unreadableDocument("the PDF is corrupt or not a valid PDF file.");
  }
  try {
    if (doc.numPages > L.maxPages) throw documentTooLarge("pages", doc.numPages);
    const warnings: string[] = [];
    const pages: string[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let text = "";
      for (const item of content.items as { str?: string; hasEOL?: boolean }[]) {
        if (typeof item.str !== "string") continue;
        text += item.str;
        if (item.hasEOL) text += "\n";
      }
      pages.push(text.replace(/[ \t]+\n/g, "\n").trim());
      page.cleanup();
    }
    const meaningful = pages.join("").replace(/\s+/g, "").length;
    if (meaningful < L.minMeaningfulCharsPerPage) {
      throw unreadableDocument("the PDF has no extractable text layer (it appears to be scanned or image-only). OCR is not supported in this version; supply the document's text instead.");
    }
    const emptyPages = pages.map((p, i) => (p.replace(/\s+/g, "").length < L.minMeaningfulCharsPerPage ? i + 1 : 0)).filter(Boolean);
    if (emptyPages.length) warnings.push(`Page(s) ${emptyPages.join(", ")} have little or no extractable text (possibly scanned images); facts on those pages cannot be extracted.`);
    return { pages, text: pages.join("\n\n"), pageCount: doc.numPages, warnings };
  } finally {
    await (doc as unknown as { destroy?: () => Promise<void> }).destroy?.().catch(() => {});
  }
}
