import { TIER_QUALITY } from "./config.js";
import type { EvidenceType, SourceTier } from "./types.js";

/**
 * Source-quality model. A government sanctions list and an anonymous forum post are not the same
 * kind of evidence; this module assigns every source an authority tier (1 best … 4 weakest) from
 * its domain and evidence type. Deterministic and conservative: an unknown publisher is tier 3,
 * never promoted to "major news".
 */

/** Tier 1 host patterns: governments, regulators, courts, statutory registries, supranational bodies. */
const TIER1_PATTERNS: readonly RegExp[] = [
  /(^|\.)gov$/, /(^|\.)gov\.[a-z]{2}$/, /(^|\.)gob\.[a-z]{2}$/, /(^|\.)gouv\.[a-z]{2}$/, /(^|\.)govt\.[a-z]{2}$/, /(^|\.)go\.[a-z]{2}$/, /(^|\.)mil$/,
  /(^|\.)europa\.eu$/, /(^|\.)un\.org$/, /(^|\.)worldbank\.org$/, /(^|\.)gleif\.org$/, /(^|\.)judiciary\.uk$/, /(^|\.)courtlistener\.com$/,
  /(^|\.)fca\.org\.uk$/, /(^|\.)sec\.gov$/, /(^|\.)finra\.org$/, /(^|\.)bafin\.de$/, /(^|\.)amf-france\.org$/, /(^|\.)asic\.gov\.au$/, /(^|\.)mas\.gov\.sg$/,
  /(^|\.)cbo\.gov\.om$/, /(^|\.)cma\.gov\.om$/, /(^|\.)dfsa\.ae$/, /(^|\.)sca\.gov\.ae$/, /(^|\.)cma\.org\.sa$/, /(^|\.)company-information\.service\.gov\.uk$/,
  /(^|\.)opensanctions\.org$/, /(^|\.)trade\.gov$/, /(^|\.)treasury\.gov$/, /(^|\.)ofac\.treasury\.gov$/
];

/** Tier 2: major, established news organizations and authoritative industry sources (curated; a
 *  domain not on this list is never assumed to be major news). */
const TIER2_DOMAINS = new Set([
  "reuters.com", "apnews.com", "bbc.co.uk", "bbc.com", "ft.com", "wsj.com", "bloomberg.com", "nytimes.com", "theguardian.com",
  "economist.com", "cnbc.com", "washingtonpost.com", "aljazeera.com", "aljazeera.net", "lemonde.fr", "dw.com", "nikkei.com", "asia.nikkei.com",
  "scmp.com", "thenationalnews.com", "gulfnews.com", "khaleejtimes.com", "arabnews.com", "timesofoman.com", "omanobserver.om", "zawya.com",
  "forbes.com", "fortune.com", "businessinsider.com", "axios.com", "politico.com", "politico.eu", "latimes.com", "theatlantic.com",
  "techcrunch.com", "theverge.com", "wired.com", "arstechnica.com", "theregister.com", "bleepingcomputer.com", "krebsonsecurity.com",
  "spiegel.de", "faz.net", "handelsblatt.com", "lesechos.fr", "elpais.com", "corriere.it", "nrc.nl", "smh.com.au", "abc.net.au",
  "globeandmail.com", "cbc.ca", "straitstimes.com", "thehindu.com", "livemint.com", "economictimes.indiatimes.com", "japantimes.co.jp",
  "afr.com", "irishtimes.com", "telegraph.co.uk", "independent.co.uk", "npr.org", "pbs.org", "cnn.com", "nbcnews.com", "cbsnews.com", "abcnews.go.com",
  "lexology.com", "law360.com", "occrp.org", "icij.org"
]);

/** Tier 3 business databases and review platforms (established, but user- or self-reported data). */
export const REVIEW_PLATFORM_DOMAINS = new Set([
  "trustpilot.com", "g2.com", "capterra.com", "sitejabber.com", "bbb.org", "productreview.com.au", "reviews.io", "yelp.com",
  "getapp.com", "softwareadvice.com", "trustradius.com", "glassdoor.com", "indeed.com", "google.com", "feefo.com", "resellerratings.com"
]);
const TIER3_BUSINESS_DATABASES = new Set([
  "crunchbase.com", "dnb.com", "opencorporates.com", "zoominfo.com", "pitchbook.com", "craft.co", "owler.com", "bizapedia.com",
  "wikipedia.org", "linkedin.com", "companieshouse.id", "endole.co.uk", "northdata.com", "kompass.com"
]);

/** Tier 4: forums / social / UGC. */
const TIER4_DOMAINS = new Set([
  "reddit.com", "quora.com", "x.com", "twitter.com", "facebook.com", "instagram.com", "tiktok.com", "youtube.com", "medium.com",
  "substack.com", "blogspot.com", "wordpress.com", "tumblr.com", "pinterest.com", "complaintsboard.com", "pissedconsumer.com",
  "ripoffreport.com", "scamadviser.com", "trustscam.com", "scam-detector.com", "4chan.org", "stackexchange.com", "threads.net"
]);

function inSet(set: ReadonlySet<string>, host: string): boolean {
  if (set.has(host)) return true;
  const labels = host.split(".");
  for (let i = 1; i < labels.length - 1; i++) if (set.has(labels.slice(i).join("."))) return true;
  return false;
}

export function isReviewPlatform(host: string | null): boolean {
  return Boolean(host) && inSet(REVIEW_PLATFORM_DOMAINS, host!);
}

export function isForumOrSocial(host: string | null): boolean {
  return Boolean(host) && (inSet(TIER4_DOMAINS, host!) || /(^|\.)(forum|forums|community|discuss)\./.test(host!));
}

/** Tier for a host, given what kind of evidence it is. */
export function classifySourceTier(host: string | null, type: EvidenceType): SourceTier {
  if (type === "sanctions" || type === "registry" || type === "regulatory") return 1;
  if (type === "domain") return 1; // RDAP registry data is authoritative for registration facts
  if (!host) return 3;
  const h = host.toLowerCase().replace(/^www\d?\./, "");
  if (TIER1_PATTERNS.some(p => p.test(h))) return 1;
  if (isForumOrSocial(h)) return 4;
  if (inSet(TIER2_DOMAINS, h)) return 2;
  if (inSet(REVIEW_PLATFORM_DOMAINS, h) || inSet(TIER3_BUSINESS_DATABASES, h)) return 3;
  return 3;
}

export function tierQuality(tier: SourceTier): number {
  return TIER_QUALITY[tier];
}

export const TIER_LABELS: Readonly<Record<SourceTier, string>> = {
  1: "official_or_regulatory",
  2: "major_news_or_authoritative",
  3: "business_database_or_other_publisher",
  4: "forum_social_or_user_generated"
};
