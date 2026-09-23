import { safeFeedFetch, FeedFetchError } from "../../domain/oman/safeFeedFetch.js";
import { FeedUrlRejectedError, type HostResolver } from "../../domain/oman/feedSecurity.js";
import { getReputationLiveChecksEnabled, LIMITS } from "../config.js";
import { evidenceId } from "../deduplication.js";
import { hostOf, registrableDomain } from "../normalization.js";
import { sanitizeExternalText, stripHtml } from "../sanitize.js";
import type { NormalizedEvidence, ProviderFetchResult } from "../types.js";
import { fetchWithSignal, isAbortError, outage, type Applicability, type ProviderContext, type ReputationProvider, type ReputationQuery } from "./types.js";

/**
 * Website and domain collection.
 *
 * WebsiteProvider fetches ONE page (the homepage) through the existing SSRF-safe fetcher
 * (domain/oman/safeFeedFetch.ts + feedSecurity.ts: https only, private/loopback IPs blocked,
 * redirects re-validated, bounded time and size). Large pages are truncated rather than failed.
 * It records raw, observable page facts only; interpretation happens in the analyzers.
 *
 * DomainProvider reads the domain's public RDAP record (registration/expiry dates, status codes).
 */

export interface WebsiteProviderOptions {
  enabled?: boolean;
  fetchImpl?: typeof fetch;
  resolver?: HostResolver;
  /** Tests only. */
  allowInsecureHttp?: boolean;
}

const PARKED = /\b(this domain (is|may be) for sale|buy this domain|domain (is )?parked|parked (free|domain)|sedo|dan\.com|hugedomains|afternic)\b/i;
const UNDER_CONSTRUCTION = /\b(under construction|coming soon|website is being built|site is currently being updated|lorem ipsum)\b/i;
const REG_NUMBER_TEXT = /\b(company (registration )?(no|number)|registered in [a-z ]+ (no|number)|registration (no|number)|reg\.? no|cr (no|number)|commercial registration|vat (no|number|reg)|registered office)\b/i;

export class WebsiteProvider implements ReputationProvider {
  readonly id = "website_homepage";
  readonly name = "Company website";
  readonly category = "website" as const;
  readonly retryable = true;
  private readonly enabled: boolean;

  constructor(private readonly options: WebsiteProviderOptions = {}) {
    this.enabled = options.enabled ?? getReputationLiveChecksEnabled();
  }

  applicability(q: ReputationQuery): Applicability {
    if (!q.website) return { status: "not_applicable", reason: "No website or domain was supplied." };
    return this.enabled ? { status: "ready" } : { status: "not_configured", reason: "Live website inspection is not enabled for this deployment (RISK_LIVE_CHECKS_ENABLED)." };
  }

  cacheKey(q: ReputationQuery): string {
    return q.website!.toLowerCase();
  }

  async fetch(q: ReputationQuery, ctx: ProviderContext): Promise<ProviderFetchResult> {
    const url = q.website!;
    const now = ctx.now.toISOString();
    try {
      const page = await safeFeedFetch(url, {
        timeoutMs: LIMITS.websiteTimeoutMs, maxResponseBytes: LIMITS.websiteMaxBytes, maxRedirects: 4, truncateAtLimit: true,
        headers: { "User-Agent": "RafidReputationCheck/1.0 (+https://api.rafidsystem.com)", Accept: "text/html,application/xhtml+xml" },
        fetchImpl: this.options.fetchImpl, resolver: this.options.resolver, allowInsecureHttp: this.options.allowInsecureHttp ?? false
      });
      const finalHost = hostOf(page.finalUrl);
      const html = page.body;
      const text = sanitizeExternalText(stripHtml(html), 6000);
      const title = sanitizeExternalText(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "", 200);
      const hrefs = [...html.matchAll(/<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map(m => `${m[1]} ${stripHtml(m[2] ?? "")}`.toLowerCase());
      const emailDomains = [...new Set([...html.replace(/<script[\s\S]*?<\/script>/gi, " ").matchAll(/[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g)].map(m => m[1]!.toLowerCase()).filter(d => !/\.(png|jpe?g|gif|svg|webp)$/.test(d)))].slice(0, 10);
      const reachable = page.status >= 200 && page.status < 400;
      const evidence: NormalizedEvidence = {
        id: evidenceId(this.id, url.toLowerCase()), type: "website", providerId: this.id, sourceName: `Company website (${finalHost ?? "unknown"})`,
        sourceUrl: page.finalUrl, sourceDomain: finalHost, sourceRecordId: null, sourceTier: 3,
        title: title.text || null, summary: reachable ? `Website responded with HTTP ${page.status}${page.finalUrl.startsWith("https://") ? " over HTTPS" : ""}.` : `Website responded with HTTP ${page.status}.`,
        publishedAt: null, observedAt: now, jurisdiction: null, companyIdentifiers: { domain: finalHost ? registrableDomain(finalHost) : null },
        // Self-published content: useful for identity/transparency, not independent evidence of reputation.
        quality: 0.5, relevance: 1,
        metadata: {
          reachable, httpStatus: page.status, https: page.finalUrl.startsWith("https://"), finalDomain: finalHost,
          redirectedToOtherDomain: Boolean(finalHost && q.domain && registrableDomain(finalHost) !== registrableDomain(q.domain)),
          truncated: Boolean(page.truncated), textExcerpt: text.text, injectionDetected: text.injectionDetected || title.injectionDetected,
          hasContactLink: hrefs.some(h => /contact/.test(h)), hasAboutLink: hrefs.some(h => /about|company|who-we-are/.test(h)),
          hasPrivacyPolicy: hrefs.some(h => /privacy/.test(h)), hasTerms: hrefs.some(h => /terms|conditions|legal/.test(h)),
          emailDomains, hasPhone: /(\+|00)\d[\d\s().-]{7,}\d/.test(text.text),
          parkedIndicators: PARKED.test(html), underConstruction: UNDER_CONSTRUCTION.test(text.text), mentionsRegistrationDetails: REG_NUMBER_TEXT.test(text.text),
          contentLength: text.text.length
        }
      };
      return { status: "ok", evidence: [evidence], reason: null, requests: 1, estimatedCostUSD: 0 };
    } catch (error) {
      if (error instanceof FeedUrlRejectedError) {
        // The URL itself is unsafe/malformed — an observation about the input, not an outage.
        const evidence: NormalizedEvidence = {
          id: evidenceId(this.id, url.toLowerCase()), type: "website", providerId: this.id, sourceName: "Company website (URL rejected before request)",
          sourceUrl: null, sourceDomain: null, sourceRecordId: null, sourceTier: 3, title: null,
          summary: `The supplied website URL was rejected by URL safety checks (${error.reason}); no request was made.`,
          publishedAt: null, observedAt: now, jurisdiction: null, companyIdentifiers: {}, quality: 0.5, relevance: 1,
          metadata: { reachable: false, httpStatus: null, https: false, urlRejected: error.reason, finalDomain: null }
        };
        return { status: "ok", evidence: [evidence], reason: null, requests: 0, estimatedCostUSD: 0 };
      }
      const kind = error instanceof FeedFetchError ? error.kind : "network";
      return kind === "timeout" ? outage("timeout", "The website did not respond in time.") : outage("unavailable", `The website could not be reached (${kind}).`);
    }
  }
}

export class DomainRdapProvider implements ReputationProvider {
  readonly id = "domain_rdap";
  readonly name = "Domain registration (RDAP)";
  readonly category = "domain" as const;
  readonly retryable = true;
  private readonly fetchImpl: typeof fetch;
  private readonly enabled: boolean;

  constructor(options: { fetchImpl?: typeof fetch; enabled?: boolean } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.enabled = options.enabled ?? getReputationLiveChecksEnabled();
  }

  applicability(q: ReputationQuery): Applicability {
    if (!q.domain) return { status: "not_applicable", reason: "No website or domain was supplied." };
    return this.enabled ? { status: "ready" } : { status: "not_configured", reason: "Domain registration lookups are not enabled for this deployment (RISK_LIVE_CHECKS_ENABLED)." };
  }

  cacheKey(q: ReputationQuery): string {
    return registrableDomain(q.domain!);
  }

  async fetch(q: ReputationQuery, ctx: ProviderContext): Promise<ProviderFetchResult> {
    const domain = registrableDomain(q.domain!);
    const url = `https://rdap.org/domain/${encodeURIComponent(domain)}`;
    try {
      const response = await fetchWithSignal(this.fetchImpl, url, { headers: { Accept: "application/rdap+json, application/json" } }, ctx.signal, 8000);
      if (response.status === 404) {
        return { status: "ok", evidence: [this.evidence(domain, url, ctx.now, { found: false })], reason: null, requests: 1, estimatedCostUSD: 0 };
      }
      if (response.status === 429) return outage("rate_limited", "RDAP rate limited the request.");
      if (!response.ok) return outage("unavailable", `RDAP returned HTTP ${response.status} for ${domain}.`);
      const body = (await response.json()) as { events?: unknown; status?: unknown; entities?: unknown };
      const events = Array.isArray(body.events) ? body.events as { eventAction?: unknown; eventDate?: unknown }[] : [];
      const date = (action: string) => {
        const e = events.find(ev => ev && ev.eventAction === action && typeof ev.eventDate === "string");
        return e && Number.isFinite(Date.parse(e.eventDate as string)) ? new Date(Date.parse(e.eventDate as string)).toISOString() : null;
      };
      const statuses = Array.isArray(body.status) ? body.status.filter((s): s is string => typeof s === "string").map(s => s.toLowerCase()) : [];
      return {
        status: "ok", requests: 1, estimatedCostUSD: 0, reason: null,
        evidence: [this.evidence(domain, url, ctx.now, { found: true, registeredAt: date("registration"), expiresAt: date("expiration"), lastChangedAt: date("last changed"), statuses })]
      };
    } catch (error) {
      return isAbortError(error) ? outage("timeout", "RDAP did not respond in time.") : outage("unavailable", "RDAP could not be reached.");
    }
  }

  private evidence(domain: string, url: string, now: Date, facts: { found: boolean; registeredAt?: string | null; expiresAt?: string | null; lastChangedAt?: string | null; statuses?: string[] }): NormalizedEvidence {
    return {
      id: evidenceId(this.id, domain), type: "domain", providerId: this.id, sourceName: "RDAP domain registration data",
      sourceUrl: url, sourceDomain: "rdap.org", sourceRecordId: domain, sourceTier: 1,
      title: `Domain registration record for ${domain}`,
      summary: facts.found ? `Registered: ${facts.registeredAt ?? "not published"}; expires: ${facts.expiresAt ?? "not published"}.` : "No RDAP registration record was found for this domain.",
      publishedAt: facts.lastChangedAt ?? null, observedAt: now.toISOString(), jurisdiction: null, companyIdentifiers: { domain },
      quality: 1, relevance: 1,
      metadata: { domain, found: facts.found, registeredAt: facts.registeredAt ?? null, expiresAt: facts.expiresAt ?? null, statuses: facts.statuses ?? [] }
    };
  }
}
