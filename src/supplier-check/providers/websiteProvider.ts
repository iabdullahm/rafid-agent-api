import { safeFeedFetch, FeedFetchError } from "../../domain/oman/safeFeedFetch.js";
import { FeedUrlRejectedError, type HostResolver } from "../../domain/oman/feedSecurity.js";
import { getSupplierWebsiteChecksEnabled } from "../config.js";
import { normalizePhone } from "../normalize.js";
import type { ProviderResult, SupplierDataProvider } from "../types.js";

/**
 * Website provider: fetches the supplier's public website (homepage, plus at most one same-host
 * contact page when the homepage shows no contact details) and extracts ONLY raw, public page
 * facts — title, visible text excerpt, published emails and phone numbers, HTTPS.
 *
 * Interpretation (does the company name appear? does it match the required service?) happens
 * later in analysis code, NOT here, because this evidence is cached by URL and the same URL may
 * be screened for different suppliers/services.
 *
 * Every request goes through the existing SSRF-safe fetcher (domain/oman/safeFeedFetch.ts +
 * feedSecurity.ts, unchanged): https only, private/loopback IPs blocked, redirects re-validated,
 * bounded time and size. Gated by RISK_LIVE_CHECKS_ENABLED (default off).
 */

export interface WebsiteEvidence {
  requestedUrl: string;
  finalUrl: string | null;
  finalDomain: string | null;
  reachable: boolean;
  httpStatus: number | null;
  https: boolean;
  title: string | null;
  /** Visible text, whitespace-collapsed, truncated — used for name/activity/address matching. */
  textExcerpt: string;
  emails: string[];
  /** Oman-normalized national numbers (8 digits) found on the page(s). */
  phones: string[];
  pagesFetched: string[];
  fetchError: string | null;
}

export interface SupplierWebsiteProvider extends SupplierDataProvider {
  readonly kind: "website";
  inspectWebsite(url: string, now: Date): Promise<ProviderResult<WebsiteEvidence>>;
}

const MAX_TEXT = 20_000;
const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 8_000;

export interface PublicWebsiteProviderOptions {
  enabled?: boolean;
  fetchImpl?: typeof fetch;
  resolver?: HostResolver;
  /** Tests only: allow http:// URLs against a local fixture server. Never read from env. */
  allowInsecureHttp?: boolean;
}

export class PublicWebsiteProvider implements SupplierWebsiteProvider {
  readonly kind = "website" as const;
  readonly id = "supplier_website";
  readonly name = "Supplier public website";
  private readonly enabled: boolean;

  constructor(private readonly options: PublicWebsiteProviderOptions = {}) {
    this.enabled = options.enabled ?? getSupplierWebsiteChecksEnabled();
  }

  async inspectWebsite(url: string, now: Date): Promise<ProviderResult<WebsiteEvidence>> {
    if (!this.enabled) return { status: "not_configured", evidence: null, sources: [], reason: "Website inspection is not enabled for this deployment (RISK_LIVE_CHECKS_ENABLED is not true)." };
    const checkedAt = now.toISOString();
    const fetchOpts = {
      timeoutMs: TIMEOUT_MS, maxResponseBytes: MAX_BYTES, maxRedirects: 4,
      headers: { "User-Agent": "RafidSupplierCheck/1.0 (+https://api.rafidsystem.com)", Accept: "text/html,application/xhtml+xml" },
      fetchImpl: this.options.fetchImpl, resolver: this.options.resolver, allowInsecureHttp: this.options.allowInsecureHttp ?? false
    };
    try {
      const home = await safeFeedFetch(url, fetchOpts);
      const pages = [home.finalUrl];
      const reachable = home.status >= 200 && home.status < 400;
      let html = home.body;
      let emails = extractEmails(html);
      let phones = extractPhones(htmlToText(html));
      if (reachable && emails.length === 0 && phones.length === 0) {
        const contactUrl = findContactLink(html, home.finalUrl);
        if (contactUrl) {
          try {
            const contact = await safeFeedFetch(contactUrl, fetchOpts);
            if (contact.status >= 200 && contact.status < 400) {
              pages.push(contact.finalUrl);
              html += "\n" + contact.body;
              emails = extractEmails(html);
              phones = extractPhones(htmlToText(html));
            }
          } catch { /* the contact page is optional evidence */ }
        }
      }
      const finalHost = new URL(home.finalUrl).hostname.toLowerCase();
      const evidence: WebsiteEvidence = {
        requestedUrl: url, finalUrl: home.finalUrl, finalDomain: finalHost.replace(/^www\./, ""),
        reachable, httpStatus: home.status, https: home.finalUrl.startsWith("https://"),
        title: extractTitle(home.body), textExcerpt: htmlToText(html).slice(0, MAX_TEXT),
        emails, phones, pagesFetched: pages, fetchError: null
      };
      return { status: "ok", evidence, sources: [{ type: "company_website", name: `Supplier website (${evidence.finalDomain})`, url: home.finalUrl, checkedAt, observedAt: checkedAt }], reason: null };
    } catch (error) {
      if (error instanceof FeedUrlRejectedError) {
        // The URL itself was unsafe/malformed — a real, cacheable observation about the input.
        const evidence: WebsiteEvidence = { requestedUrl: url, finalUrl: null, finalDomain: null, reachable: false, httpStatus: null, https: url.startsWith("https://"), title: null, textExcerpt: "", emails: [], phones: [], pagesFetched: [], fetchError: `url_rejected:${error.reason}` };
        return { status: "ok", evidence, sources: [{ type: "company_website", name: "Supplier website (URL rejected before request)", url, checkedAt, observedAt: null }], reason: null };
      }
      const kind = error instanceof FeedFetchError ? error.kind : "network";
      if (kind === "timeout" || kind === "network") {
        // Unreachable is itself evidence, but may be transient: report it, never cache it.
        return { status: "unavailable", evidence: { requestedUrl: url, finalUrl: null, finalDomain: null, reachable: false, httpStatus: null, https: url.startsWith("https://"), title: null, textExcerpt: "", emails: [], phones: [], pagesFetched: [], fetchError: kind }, sources: [], reason: `The website could not be reached (${kind}).` };
      }
      return { status: "unavailable", evidence: null, sources: [], reason: `The website could not be inspected (${kind}).` };
    }
  }
}

const ENTITY_MAP: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", "#39": "'" };

export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#?\w+);/g, (m, e: string) => ENTITY_MAP[e.toLowerCase()] ?? (e.startsWith("#") && /^#\d+$/.test(e) ? String.fromCharCode(Number(e.slice(1))) : m))
    .replace(/\s+/g, " ")
    .trim();
}

export function extractTitle(html: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = match ? htmlToText(match[1]!).slice(0, 200) : "";
  return title || null;
}

export function extractEmails(html: string): string[] {
  const found = new Set<string>();
  // Scripts/styles/comments are removed first (they carry tracking/library addresses, not the
  // supplier's published contacts); tag attributes such as mailto: hrefs are kept.
  const decoded = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/&#64;|&commat;/gi, "@");
  for (const m of decoded.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) {
    const email = m[0].toLowerCase();
    if (/\.(png|jpe?g|gif|svg|webp)$/.test(email)) continue; // image@2x.png false positives
    found.add(email);
    if (found.size >= 10) break;
  }
  return [...found];
}

export function extractPhones(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/(?:\+|00)?\s*(?:968[\s-]*)?[279]\d(?:[\s-]*\d){6}/g)) {
    const p = normalizePhone(m[0]);
    if (p.isOman) found.add(p.digits);
    if (found.size >= 10) break;
  }
  return [...found];
}

function findContactLink(html: string, baseUrl: string): string | null {
  const base = new URL(baseUrl);
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>/gi)) {
    const href = m[1]!;
    if (!/contact|اتصل|تواصل/i.test(href) && !/contact|اتصل|تواصل/i.test(m[0])) continue;
    try {
      const target = new URL(href, base);
      if (target.hostname === base.hostname && (target.protocol === "https:" || target.protocol === "http:")) return target.toString();
    } catch { /* ignore malformed hrefs */ }
  }
  return null;
}
