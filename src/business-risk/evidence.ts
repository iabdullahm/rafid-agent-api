import { createHash } from "node:crypto";
import { classifyAdverseMedia } from "../company-reputation/adverseMediaClassifier.js";
import { evidenceId } from "../company-reputation/deduplication.js";
import type { NormalizedEvidence, SourceTier } from "../company-reputation/types.js";
import { FRESHNESS_HALF_LIFE_DAYS, STALE_AFTER_DAYS } from "./config.js";
import { RELIABILITY_BY_TIER, type EvidenceClass, type EvidenceSourceType, type Reliability, type RoleRun } from "./types.js";

/**
 * The business_risk_score evidence model: every material risk flag and positive signal cites
 * evidence ids that resolve to one of these items. Two kinds:
 *  - source_record:  something a source actually returned (a registry record, a list entry, an
 *                    article, the website, an RDAP record, a threat-feed verdict)
 *  - lookup_result:  the documented OUTCOME of a successful check that returned nothing relevant
 *                    ("UK Companies House returned no record for 01234567", "no sanctions-list
 *                    match above threshold") — so negative/clean findings are traceable too.
 * Never contains credentials or raw provider payloads (only NormalizedEvidence fields, which are
 * already sanitized/bounded by the providers).
 */

export interface EvidenceView {
  id: string;
  recordType: "source_record" | "lookup_result";
  type: EvidenceSourceType;
  evidenceClass: EvidenceClass;
  sourceName: string;
  sourceUrl: string | null;
  sourceRecordId: string | null;
  publishedAt: string | null;
  /** When the fact was observed by the source (publication date when known, else retrieval time). */
  observedAt: string;
  /** When Rafid retrieved it (a cached item keeps its ORIGINAL retrieval time). */
  retrievedAt: string;
  ageDays: number | null;
  stale: boolean;
  freshness: number;
  claim: string;
  reliability: Reliability;
  relevance: number;
  fromCache: boolean;
}

const RESTRICTED_PARTY_LIST = /debar|denied|entity list|unverified list|military end|non-?proliferation|itar|\bdtc\b|\bbis\b|\(el\)|\(dpl\)|\(uvl\)|\(meu\)|\(isn\)/i;

export function isRestrictedPartyList(listName: string): boolean {
  return RESTRICTED_PARTY_LIST.test(listName);
}

const COURT_HOST = /(^|\.)(judiciary\.uk|courtlistener\.com|uscourts\.gov|courts?\.[a-z.]+|supremecourt\.[a-z.]+)$/;

export function sourceTypeOf(e: NormalizedEvidence): EvidenceSourceType {
  const kind = typeof e.metadata.recordKind === "string" ? e.metadata.recordKind : null;
  switch (e.type) {
    case "registry": return kind === "lei_registry" ? "lei_registry" : kind === "company_filing_status" ? "company_filing" : "company_registry";
    case "sanctions": return isRestrictedPartyList(String(e.metadata.listName ?? e.sourceName)) ? "export_control_or_debarment_list" : "sanctions_list";
    case "regulatory": return e.sourceDomain && COURT_HOST.test(e.sourceDomain) ? "court_record" : "regulatory_publication";
    case "news": return "news";
    case "review": return "review_platform";
    case "forum": return "forum_or_social";
    case "website": return kind === "threat_intelligence" ? "threat_intelligence" : "company_website";
    case "domain": return "domain_registration";
  }
}

type AgedType = keyof typeof FRESHNESS_HALF_LIFE_DAYS;
function agedType(e: NormalizedEvidence): AgedType | null {
  return e.type === "news" || e.type === "regulatory" || e.type === "review" || e.type === "forum" ? e.type : null;
}

export function ageDays(iso: string | null, asOf: Date): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((asOf.getTime() - t) / 86_400_000));
}

/** Freshness weight 0–1: publication-dated media decays with a documented half-life; current-state
 *  records (registries, lists, RDAP, website) are 1 — halved when served from a stale cache. */
export function freshnessOf(e: NormalizedEvidence, asOf: Date, fromStaleCache: boolean): number {
  const t = agedType(e);
  let f = 1;
  if (t) {
    const age = ageDays(e.publishedAt, asOf);
    if (age !== null) f = Math.pow(0.5, age / FRESHNESS_HALF_LIFE_DAYS[t]);
  }
  if (fromStaleCache) f *= 0.5;
  return round2(f);
}

export function isStale(e: NormalizedEvidence, asOf: Date, fromStaleCache: boolean): boolean {
  if (fromStaleCache) return true;
  const t = agedType(e);
  if (!t) return false;
  const age = ageDays(e.publishedAt, asOf);
  return age !== null && age > STALE_AFTER_DAYS[t];
}

function evidenceClassOf(e: NormalizedEvidence, type: EvidenceSourceType): EvidenceClass {
  if (type === "company_registry" || type === "lei_registry" || type === "company_filing" || type === "sanctions_list"
    || type === "export_control_or_debarment_list" || type === "domain_registration" || type === "threat_intelligence") return "official_record";
  if (type === "company_website") return "self_published";
  if (type === "review_platform" || type === "forum_or_social") return "user_generated";
  const c = classifyAdverseMedia(`${e.title ?? ""}. ${e.summary ?? ""}`);
  if (type === "court_record") return "court_record";
  if (c.adverse && !c.established) return "allegation";
  if (type === "regulatory_publication") return "regulatory_action";
  return e.sourceTier <= 2 ? "credible_journalism" : "other_publication";
}

function str(v: unknown): string | null { return typeof v === "string" && v.length > 0 ? v : null; }

function claimOf(e: NormalizedEvidence, type: EvidenceSourceType): string {
  const m = e.metadata;
  switch (type) {
    case "company_registry":
    case "lei_registry": {
      const parts = [
        `${str(m.registryName) ?? e.sourceName} record "${str(m.legalName) ?? e.title ?? "unnamed"}"`,
        str(m.registrationNumber) ? `registration no. ${m.registrationNumber}` : null,
        str(m.lei) ? `LEI ${m.lei}` : null,
        str(m.country) ? `country ${m.country}` : null,
        `status ${str(m.rawStatus) ?? str(m.status) ?? "unknown"}`,
        str(m.incorporationDate) ? `incorporated/created ${m.incorporationDate}` : null
      ].filter(Boolean);
      return `${parts.join(", ")}.`;
    }
    case "company_filing": return `${e.title ?? "Filing status"}: ${e.summary ?? "no filing facts published"}.`;
    case "sanctions_list":
    case "export_control_or_debarment_list":
      return `"${e.title ?? "unnamed"}" is listed on ${str(m.listName) ?? e.sourceName}${str(m.reference) ? ` (ref. ${m.reference})` : ""}; returned as a candidate for a name search. Whether it is the same entity is assessed separately (match strength).`;
    case "domain_registration": return e.summary ?? "Domain registration record.";
    case "threat_intelligence": return e.summary ?? "Threat-feed verdict.";
    case "company_website": return `${e.summary ?? "Website checked."}${e.title ? ` Title: "${e.title}".` : ""}`;
    default: return e.title ? `Reports: "${e.title}".` : e.summary ?? "Publication.";
  }
}

export function toEvidenceView(e: NormalizedEvidence, asOf: Date, run: RoleRun | undefined): EvidenceView {
  const type = sourceTypeOf(e);
  const staleCache = run?.status === "stale_cache";
  return {
    id: e.id, recordType: "source_record", type, evidenceClass: evidenceClassOf(e, type),
    sourceName: e.sourceName, sourceUrl: e.sourceUrl, sourceRecordId: e.sourceRecordId,
    publishedAt: e.publishedAt, observedAt: e.publishedAt ?? e.observedAt, retrievedAt: run?.fetchedAt ?? e.observedAt,
    ageDays: ageDays(e.publishedAt, asOf), stale: isStale(e, asOf, staleCache), freshness: freshnessOf(e, asOf, staleCache),
    claim: claimOf(e, type), reliability: RELIABILITY_BY_TIER[e.sourceTier as SourceTier], relevance: e.relevance, fromCache: run?.fromCache ?? false
  };
}

const LOOKUP_TYPE: Readonly<Record<RoleRun["category"], EvidenceSourceType>> = {
  registry: "company_registry", sanctions: "sanctions_list", news: "news", reviews: "review_platform", website: "company_website", domain: "domain_registration"
};

/** A documented "checked, nothing found" outcome of one successful provider run. */
export function lookupEvidence(run: RoleRun, claim: string, asOf: Date): EvidenceView {
  const retrievedAt = run.fetchedAt ?? asOf.toISOString();
  const type: EvidenceSourceType = run.role === "regulatory" ? "regulatory_publication" : run.role === "financial" ? "company_filing" : LOOKUP_TYPE[run.category];
  return {
    id: evidenceId(run.providerId, `lookup|${claim}`), recordType: "lookup_result", type,
    evidenceClass: type === "news" || type === "review_platform" ? "other_publication" : "official_record",
    sourceName: run.providerName, sourceUrl: null, sourceRecordId: null, publishedAt: null, observedAt: retrievedAt, retrievedAt,
    ageDays: null, stale: run.status === "stale_cache", freshness: run.status === "stale_cache" ? 0.5 : 1, claim,
    reliability: type === "news" || type === "review_platform" ? "medium" : "authoritative", relevance: 1, fromCache: run.fromCache
  };
}

/** Stable fingerprint of an evidence snapshot (ids + retrieval times) — the dedup key of persisted
 *  assessments: the same evidence under the same scoring version is stored once. */
export function evidenceFingerprint(items: readonly EvidenceView[]): string {
  // Content-based (a changed record under the same id is a new snapshot); cache provenance is not
  // part of the snapshot, so serving the same evidence from cache yields the same fingerprint.
  const canonical = items.map(({ fromCache: _fromCache, ...e }) => JSON.stringify(e)).sort().join("\n");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export function round2(n: number): number { return Math.round(n * 100) / 100; }
