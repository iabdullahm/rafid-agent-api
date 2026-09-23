import { validateFeedUrl, FeedUrlRejectedError } from "../../../domain/oman/feedSecurity.js";
import { safeFeedFetch, FeedFetchError } from "../../../domain/oman/safeFeedFetch.js";
import { getRiskLiveChecksEnabled } from "../../config.js";
import { TtlCache } from "../../cache.js";
import type { IntelligenceSource } from "../../types.js";

/**
 * Section "Risk — domain / website / sanctions checks". All three are FREE (no paid provider,
 * no API key) but make a real outbound network call, so — per intelligence/config.ts's doc
 * comment — they are gated behind RISK_LIVE_CHECKS_ENABLED (default false) rather than a
 * provider-key presence check, purely so `npm test`'s generic per-capability loops (which call
 * `c.execute(c.example)` directly with no way to inject a mock fetch) stay network-free and
 * deterministic by default.
 *
 * Website reachability reuses domain/oman/feedSecurity.ts + safeFeedFetch.ts UNCHANGED — the
 * exact same SSRF protection (scheme allowlist, hostname/IP blocklist, DNS-rebinding-safe
 * resolution, validated redirects) the Production Feed Runner already relies on for
 * partner-supplied URLs. This is genuinely the same class of "untrusted URL from an API caller"
 * problem, so nothing about SSRF handling is reimplemented here.
 */

export interface CheckOutcome {
  status: "performed" | "not_configured" | "unavailable" | "not_applicable";
  summary: string | null;
  findings: string[];
  evidence: { description: string; source: string | null; tier: "confirmed_evidence" | "public_allegation" | "automated_indicator" | "missing_information" }[];
  sources: IntelligenceSource[];
}

const notConfigured = (): CheckOutcome => ({
  status: "not_configured", summary: "Live checks are not enabled for this deployment (RISK_LIVE_CHECKS_ENABLED is not true).",
  findings: [], evidence: [], sources: []
});

// -------------------------------------------------------------------------------------------
// Website reachability + basic security signals
// -------------------------------------------------------------------------------------------

export async function runWebsiteCheck(website: string | null, now: () => Date = () => new Date()): Promise<CheckOutcome> {
  if (!website) return { status: "not_applicable", summary: "No website was provided.", findings: [], evidence: [], sources: [] };
  if (!getRiskLiveChecksEnabled()) return notConfigured();
  const observedAt = now().toISOString();
  try {
    await validateFeedUrl(website, { allowInsecureHttp: false });
  } catch (error) {
    if (error instanceof FeedUrlRejectedError) {
      return {
        status: "unavailable",
        summary: `The provided website URL was rejected before any request was made (${error.reason}).`,
        findings: [`URL rejected: ${error.reason} — this may indicate a malformed or unsafe URL, not necessarily anything about the company itself.`],
        evidence: [{ description: error.message, source: null, tier: "automated_indicator" }],
        sources: []
      };
    }
    return { status: "unavailable", summary: "The provided website URL could not be validated.", findings: [], evidence: [], sources: [] };
  }
  try {
    const result = await safeFeedFetch(website, { timeoutMs: 8000, maxResponseBytes: 200_000, maxRedirects: 3 });
    const reachable = result.status >= 200 && result.status < 400;
    const https = result.finalUrl.startsWith("https://");
    const findings = [
      reachable ? `Website responded with HTTP ${result.status}.` : `Website responded with HTTP ${result.status} (not a success/redirect range).`,
      https ? "Final URL uses HTTPS." : "Final URL does not use HTTPS — an automated indicator only, not a determination of legitimacy."
    ];
    return {
      status: "performed",
      summary: reachable ? "Website is reachable." : "Website did not return a successful response.",
      findings,
      evidence: [{ description: findings.join(" "), source: result.finalUrl, tier: "automated_indicator" }],
      sources: [{ url: result.finalUrl, title: "Website reachability check", publisher: null, sourceType: "company_website", observedAt }]
    };
  } catch (error) {
    const kind = error instanceof FeedFetchError ? error.kind : "network";
    return {
      status: "unavailable",
      summary: `The website could not be reached (${kind}).`,
      findings: [`Website unreachable (${kind}) — this can mean the site is down, blocking automated requests, or the URL is stale; it is not evidence of fraud on its own.`],
      evidence: [{ description: `Website fetch failed: ${kind}`, source: null, tier: "automated_indicator" }],
      sources: []
    };
  }
}

// -------------------------------------------------------------------------------------------
// Domain registration age via public RDAP (rdap.org bootstrap — no API key)
// -------------------------------------------------------------------------------------------

const NEWLY_REGISTERED_DAYS = 180;

export async function runDomainCheck(website: string | null, now: () => Date = () => new Date()): Promise<CheckOutcome> {
  if (!website) return { status: "not_applicable", summary: "No website was provided.", findings: [], evidence: [], sources: [] };
  if (!getRiskLiveChecksEnabled()) return notConfigured();
  let hostname: string;
  try { hostname = new URL(website).hostname.replace(/^www\./, ""); } catch { return { status: "unavailable", summary: "Could not parse a domain from the provided website.", findings: [], evidence: [], sources: [] }; }
  const observedAt = now().toISOString();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let response: Response;
    try {
      response = await fetch(`https://rdap.org/domain/${encodeURIComponent(hostname)}`, { signal: controller.signal });
    } finally { clearTimeout(timer); }
    if (!response.ok) {
      return { status: "unavailable", summary: `RDAP lookup for ${hostname} did not succeed (HTTP ${response.status}).`, findings: [], evidence: [{ description: `RDAP HTTP ${response.status}`, source: null, tier: "missing_information" }], sources: [] };
    }
    const body = (await response.json()) as { events?: unknown };
    const events = Array.isArray(body.events) ? body.events : [];
    const registration = events.find((e): e is { eventAction: string; eventDate: string } => Boolean(e) && typeof e === "object" && (e as { eventAction?: unknown }).eventAction === "registration");
    if (!registration?.eventDate) {
      return { status: "performed", summary: `RDAP data for ${hostname} did not include a registration date.`, findings: ["Domain registration date unavailable from RDAP."], evidence: [{ description: "No registration event in RDAP response.", source: null, tier: "missing_information" }], sources: [{ url: `https://rdap.org/domain/${hostname}`, title: "RDAP domain record", publisher: "RDAP", sourceType: "domain_registry", observedAt }] };
    }
    const ageDays = Math.max(0, Math.round((now().getTime() - Date.parse(registration.eventDate)) / 86_400_000));
    const isNew = ageDays < NEWLY_REGISTERED_DAYS;
    const findings = [`Domain registered ${registration.eventDate} (${ageDays} day(s) ago).`];
    if (isNew) findings.push(`Domain is newer than ${NEWLY_REGISTERED_DAYS} days old — an automated indicator worth weighing alongside other evidence, not proof of anything on its own.`);
    return {
      status: "performed",
      summary: isNew ? "Domain was registered relatively recently." : "Domain has an established registration history.",
      findings,
      evidence: [{ description: findings.join(" "), source: `https://rdap.org/domain/${hostname}`, tier: "automated_indicator" }],
      sources: [{ url: `https://rdap.org/domain/${hostname}`, title: "RDAP domain record", publisher: "RDAP", sourceType: "domain_registry", observedAt }]
    };
  } catch {
    return { status: "unavailable", summary: `RDAP lookup for ${hostname} failed.`, findings: [], evidence: [], sources: [] };
  }
}

// -------------------------------------------------------------------------------------------
// OFAC Consolidated Screening List — free, public, US government source. Framed strictly as an
// automated NAME-MATCHING indicator, never a sanctions determination (Section: "Do NOT make
// unsupported allegations", "Do NOT infer fraud/criminality from weak signals").
// -------------------------------------------------------------------------------------------

interface OfacListCacheEntry { names: string[]; }
const ofacListCache = new TtlCache<OfacListCacheEntry>(24 * 60 * 60 * 1000);
const OFAC_LIST_URL = "https://api.trade.gov/consolidated_screening_list/v1/search";

async function fetchOfacCandidateNames(companyName: string): Promise<{ names: string[]; sourceUrl: string } | null> {
  // The Consolidated Screening List public API (trade.gov) requires no API key for basic search
  // and covers OFAC's SDN list among several other US government screening lists.
  const url = `${OFAC_LIST_URL}?name=${encodeURIComponent(companyName)}&fuzzy_name=true&size=5`;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let response: Response;
    try { response = await fetch(url, { headers: { Accept: "application/json" }, signal: controller.signal }); }
    finally { clearTimeout(timer); }
    if (!response.ok) return null;
    const body = (await response.json()) as { results?: unknown };
    const results = Array.isArray(body.results) ? body.results : [];
    const names = results
      .map(r => (r && typeof r === "object" ? (r as Record<string, unknown>).name : undefined))
      .filter((n): n is string => typeof n === "string");
    return { names, sourceUrl: url };
  } catch {
    return null;
  }
}

export async function runSanctionsCheck(companyName: string | null, now: () => Date = () => new Date()): Promise<CheckOutcome> {
  if (!companyName) return { status: "not_applicable", summary: "No company name was provided.", findings: [], evidence: [], sources: [] };
  if (!getRiskLiveChecksEnabled()) return notConfigured();
  const observedAt = now().toISOString();
  const cacheKey = companyName.trim().toLowerCase();
  let cached = ofacListCache.get(cacheKey);
  let sourceUrl = OFAC_LIST_URL;
  if (!cached) {
    const fetched = await fetchOfacCandidateNames(companyName);
    if (!fetched) {
      return { status: "unavailable", summary: "The sanctions screening list could not be reached.", findings: [], evidence: [{ description: "Consolidated Screening List API request failed.", source: null, tier: "missing_information" }], sources: [] };
    }
    cached = { names: fetched.names };
    sourceUrl = fetched.sourceUrl;
    ofacListCache.set(cacheKey, cached);
  }
  const source: IntelligenceSource = { url: OFAC_LIST_URL, title: "US Consolidated Screening List (includes OFAC SDN)", publisher: "U.S. Department of Commerce (trade.gov)", sourceType: "sanctions_list", observedAt };
  if (cached.names.length === 0) {
    return { status: "performed", summary: "No name match was found on the US Consolidated Screening List.", findings: ["No candidate match found — this does not guarantee the company is not sanctioned under a different registered name or by another country's list, which this check does not cover."], evidence: [{ description: "No match found by fuzzy name search.", source: sourceUrl, tier: "automated_indicator" }], sources: [source] };
  }
  return {
    status: "performed",
    summary: `${cached.names.length} possible name match(es) found on the US Consolidated Screening List — this is an automated name-similarity match, NOT a determination that this company is sanctioned. Verify directly against the source list before acting on this.`,
    findings: cached.names.map(n => `Possible name match: "${n}" — automated fuzzy match only, requires manual verification.`),
    evidence: [{ description: `Fuzzy name match(es) on a US government sanctions/screening list: ${cached.names.join(", ")}. This is an automated indicator, not a confirmed sanctions determination.`, source: sourceUrl, tier: "automated_indicator" }],
    sources: [source]
  };
}
