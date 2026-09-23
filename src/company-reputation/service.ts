import { companyReputationCheckInput } from "../schemas/companyReputationInputs.js";
import type { CompanyReputationCheckOutput, ReputationSignalOut } from "../schemas/companyReputationOutputs.js";
import { getOmanCompanyDataProvider } from "../services/omanBusiness.js";
import { analyzeAdverseMedia } from "./analyzers/adverseMediaAnalyzer.js";
import { analyzeBusinessStability } from "./analyzers/businessStabilityAnalyzer.js";
import type { AnalysisContext } from "./analyzers/context.js";
import { analyzeCustomerSentiment } from "./analyzers/customerSentimentAnalyzer.js";
import { analyzeCyberDomain } from "./analyzers/cyberDomainAnalyzer.js";
import { analyzeIdentity } from "./analyzers/identityAnalyzer.js";
import { analyzeOnlinePresence } from "./analyzers/onlinePresenceAnalyzer.js";
import { analyzeSanctions } from "./analyzers/sanctionsAnalyzer.js";
import { analyzeTransparency } from "./analyzers/transparencyAnalyzer.js";
import { assessRelevance, resolveIdentity, type Resolution } from "./companyResolver.js";
import { computeConfidence } from "./confidence.js";
import {
  DIMENSION_WEIGHTS, LIMITS, MIN_RELEVANCE, NEUTRAL_PRIOR, SCORING_MODEL_VERSION, TRUST_THRESHOLDS, getReputationCacheTtls,
  getReputationDisabledProviders, getReputationEvidenceDatabaseUrl, getReputationMaxStaleMs, getReputationProviderTimeoutMs
} from "./config.js";
import { dedupeEvidence, groupEvents, type EvidenceGroup } from "./deduplication.js";
import { MemoryReputationEvidenceCache, PostgresReputationEvidenceCache, type ReputationEvidenceCache } from "./evidenceCache.js";
import { normalizeCompanyName, normalizeCountry, normalizeDomain, normalizeLei, normalizeRegistrationNumber, normalizeWebsite } from "./normalization.js";
import { CompaniesHouseProvider, GleifRegistryProvider, OmanRegistryProvider } from "./providers/registryProviders.js";
import { runProviders } from "./providers/runner.js";
import { buildSanctionsReputationProviders } from "./providers/sanctionsProvider.js";
import type { ReputationProvider, ReputationQuery } from "./providers/types.js";
import { NewsProvider, ReviewsProvider } from "./providers/webSearchProviders.js";
import { DomainRdapProvider, WebsiteProvider } from "./providers/webPresenceProviders.js";
import type { EvidenceUnit } from "./scoring.js";
import { scoreDimensions } from "./scoring.js";
import { TIER_LABELS } from "./sourceQuality.js";
import { recordReputationRun } from "./telemetry.js";
import { DIMENSIONS, type NormalizedEvidence, type ProviderCategory, type ProviderRun, type ReputationWarning, type Signal, type SourceTier } from "./types.js";

/**
 * company_reputation_check orchestration:
 *   validate → normalize → run providers concurrently (cache-first, isolated, time-boxed)
 *   → dedupe → resolve identity → relevance-filter third-party evidence → group events
 *   → analyzers (signals) → scoring → confidence → structured result.
 * A provider outage never fails the call and never becomes a negative signal; it lowers coverage and
 * confidence and is reported in `coverage` / `warnings`. Only invalid input fails the call (400, so
 * no paid settlement happens on x402/L402).
 */

export interface ReputationDependencies {
  providers: readonly ReputationProvider[];
  cache: ReputationEvidenceCache;
  ttls: Readonly<Record<ProviderCategory, number>>;
  maxStaleMs: number;
  timeoutMs: number;
  maxAttempts: number;
  disabled: ReadonlySet<string>;
  now: () => Date;
}

let defaultDeps: ReputationDependencies | null = null;

export function buildDefaultReputationProviders(): ReputationProvider[] {
  return [
    new GleifRegistryProvider(),
    new CompaniesHouseProvider(),
    new OmanRegistryProvider(() => getOmanCompanyDataProvider()),
    ...buildSanctionsReputationProviders(),
    new NewsProvider(),
    new ReviewsProvider(),
    new WebsiteProvider(),
    new DomainRdapProvider()
  ];
}

/** Built lazily once per process so list caches (UN/EU XML) and the evidence cache survive across
 *  calls on a warm instance. */
export function getDefaultReputationDependencies(): ReputationDependencies {
  if (!defaultDeps) {
    const dbUrl = getReputationEvidenceDatabaseUrl();
    defaultDeps = {
      providers: buildDefaultReputationProviders(),
      cache: dbUrl ? new PostgresReputationEvidenceCache(dbUrl) : new MemoryReputationEvidenceCache(),
      ttls: getReputationCacheTtls(),
      maxStaleMs: getReputationMaxStaleMs(),
      timeoutMs: getReputationProviderTimeoutMs(),
      maxAttempts: LIMITS.maxProviderAttempts,
      disabled: getReputationDisabledProviders(),
      now: () => new Date()
    };
  }
  return defaultDeps;
}

const BASE_LIMITATIONS = [
  "Evidence-based public-source screening only — not a legal, KYC/AML, credit or compliance determination, and not a guarantee of legitimacy or of misconduct.",
  "reputationScore summarizes publicly observable signals; confidenceScore states how much evidence supports it. Read them together.",
  "Absence of evidence is not evidence of absence: sources not checked, or companies with little public footprint, lower confidence rather than raising the score.",
  "Sanctions results are automated name matching. 'possible' matches are not listings; 'high' matches still require verification at the source list.",
  "Adverse media is reported at the legal stage the source states; allegations, investigations and lawsuits are not findings of wrongdoing.",
  "Customer reviews and forum posts are unverified, self-selected opinions and are weighted accordingly.",
  "External web content is treated strictly as data; instruction-like text found in it is removed and never acted upon."
];

function buildQuery(input: ReturnType<typeof companyReputationCheckInput.parse>): ReputationQuery {
  const website = normalizeWebsite(input.website ?? null) ?? (input.domain ? normalizeWebsite(input.domain) : null);
  return {
    companyName: input.companyName.replace(/\s+/g, " "),
    legalName: input.legalName?.replace(/\s+/g, " ") ?? null,
    nameKey: normalizeCompanyName(input.legalName ?? input.companyName).key,
    country: normalizeCountry(input.country ?? null),
    website: website?.url ?? null,
    domain: website?.domain ?? normalizeDomain(input.domain ?? null),
    registrationNumber: normalizeRegistrationNumber(input.registrationNumber ?? null),
    lei: normalizeLei(input.lei ?? null),
    city: input.city ?? null,
    industry: input.industry ?? null
  };
}

const checkedRun = (r: ProviderRun) => r.status === "ok" || r.status === "stale_cache";
const SEVERITY_RANK = { info: 0, low: 1, medium: 2, high: 3, critical: 4 } as const;

function toSignalOut(s: Signal): ReputationSignalOut {
  return { code: s.code, dimension: s.dimension, polarity: s.polarity, severity: s.severity, message: s.message, evidenceIds: s.evidenceIds, sourceAuthority: s.sourceTier ? TIER_LABELS[s.sourceTier] as ReputationSignalOut["sourceAuthority"] : null, strength: s.strength };
}

export async function runCompanyReputationCheck(rawInput: unknown, deps: ReputationDependencies = getDefaultReputationDependencies()): Promise<CompanyReputationCheckOutput> {
  const input = companyReputationCheckInput.parse(rawInput);
  const query = buildQuery(input);
  const now = deps.now();

  // --- Collection -----------------------------------------------------------------------------
  const runs = await runProviders(deps.providers, query, {
    cache: deps.cache, ttls: deps.ttls, maxStaleMs: deps.maxStaleMs, timeoutMs: deps.timeoutMs, maxAttempts: deps.maxAttempts, disabled: deps.disabled, now: deps.now
  });
  const fromCacheByProvider = new Map(runs.map(r => [r.providerId, r.fromCache]));
  const collected = runs.flatMap(r => r.evidence);
  const { items: deduped, removed: exactDuplicates } = dedupeEvidence(collected);
  recordReputationRun(runs, collected.length); // internal cost/latency telemetry only

  // --- Identity resolution ----------------------------------------------------------------------
  const registry = deduped.filter(e => e.type === "registry");
  const registryChecked = runs.some(r => r.category === "registry" && checkedRun(r));
  const website = deduped.find(e => e.type === "website") ?? null;
  const domain = deduped.find(e => e.type === "domain") ?? null;
  const resolution = resolveIdentity(query, registry, registryChecked, website);

  // --- Relevance filtering of third-party evidence ----------------------------------------------
  const thirdParty = deduped.filter(e => e.type === "news" || e.type === "regulatory" || e.type === "review" || e.type === "forum");
  const relevant: NormalizedEvidence[] = [];
  let excluded = 0;
  for (const e of thirdParty) {
    const a = assessRelevance(e, query, resolution);
    const identifierBacked = a.reasons.includes("mentions_company_domain") || a.reasons.includes("mentions_registration_number");
    // Ambiguous identity: only evidence tied to a supplied identifier can be attributed.
    if (a.relevance >= MIN_RELEVANCE && (resolution.status !== "ambiguous" || identifierBacked)) relevant.push({ ...e, relevance: a.relevance });
    else excluded++;
  }
  const groups: EvidenceGroup[] = groupEvents(relevant);
  const syndicatedMerged = relevant.length - groups.length;

  // --- Analysis ---------------------------------------------------------------------------------
  const ctx: AnalysisContext = { query, resolution, runs, registry, sanctions: deduped.filter(e => e.type === "sanctions"), website, domain, thirdPartyGroups: groups, now };
  const identity = analyzeIdentity(ctx);
  const sanctions = analyzeSanctions(ctx);
  const adverse = analyzeAdverseMedia(ctx);
  const customer = analyzeCustomerSentiment(ctx);
  const online = analyzeOnlinePresence(ctx);
  const stability = analyzeBusinessStability(ctx);
  const cyber = analyzeCyberDomain(ctx);
  const transparency = analyzeTransparency(ctx);
  const signals: Signal[] = [
    ...identity.signals, ...sanctions.signals, ...adverse.signals, ...customer.positiveSignals, ...customer.negativeSignals,
    ...online.signals, ...stability, ...cyber, ...transparency
  ];

  // --- Evidence units (independence) -------------------------------------------------------------
  const unitsByEvidence = new Map<string, EvidenceUnit>();
  for (const g of groups) {
    const tier = Math.min(...g.members.map(m => m.sourceTier)) as SourceTier;
    const relevance = g.members.reduce((s, m) => s + m.relevance, 0) / g.members.length;
    for (const m of g.members) unitsByEvidence.set(m.id, { unitKey: g.groupId, tier, relevance });
  }
  for (const e of [...registry, ...ctx.sanctions, ...(website ? [website] : []), ...(domain ? [domain] : [])]) {
    unitsByEvidence.set(e.id, { unitKey: e.id, tier: e.sourceTier, relevance: e.relevance });
  }
  const matchedRegistryIds = resolution.matched ? [resolution.matched.evidenceId, ...resolution.corroboratingRecords.map(c => c.evidenceId)] : [];
  const independentUnits: EvidenceUnit[] = [
    ...groups.map(g => unitsByEvidence.get(g.members[0]!.id)!),
    ...matchedRegistryIds.map(id => unitsByEvidence.get(id)).filter((u): u is EvidenceUnit => Boolean(u)),
    ...runs.filter(r => r.category === "sanctions" && checkedRun(r)).map(r => ({ unitKey: `list:${r.providerId}`, tier: 1 as SourceTier, relevance: 1 })),
    ...(website && website.metadata.reachable === true ? [unitsByEvidence.get(website.id)!] : []),
    ...(domain && domain.metadata.found === true ? [unitsByEvidence.get(domain.id)!] : [])
  ];

  // --- Scoring + confidence ---------------------------------------------------------------------
  const scoring = scoreDimensions(signals, runs, unitsByEvidence, resolution.confidence);
  const evidenceTypes = new Set<string>([
    ...groups.map(g => g.representative.type),
    ...(matchedRegistryIds.length ? ["registry"] : []),
    ...(runs.some(r => r.category === "sanctions" && checkedRun(r)) ? ["sanctions"] : []),
    ...(website && website.metadata.reachable === true ? ["website"] : []),
    ...(domain && domain.metadata.found === true ? ["domain"] : [])
  ]);
  const confidence = computeConfidence({ resolution, scoring, runs, units: independentUnits, evidenceTypes, datedThirdParty: relevant.map(e => e.publishedAt), now });

  const trustLevel = decideTrustLevel(scoring.reputationScore, confidence.score, signals);

  // --- Output evidence ----------------------------------------------------------------------------
  const outputEvidencePool: NormalizedEvidence[] = [
    ...registry.filter(e => resolution.candidates.some(c => c.evidenceId === e.id) || matchedRegistryIds.includes(e.id)),
    ...ctx.sanctions.filter(e => sanctions.matches.some(m => m.evidenceId === e.id)),
    ...(website ? [website] : []), ...(domain ? [domain] : []),
    ...relevant
  ];
  const sortedEvidence = [...new Map(outputEvidencePool.map(e => [e.id, e])).values()]
    .sort((a, b) => a.sourceTier - b.sourceTier || (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "") || a.id.localeCompare(b.id));
  const evidenceOut = sortedEvidence.slice(0, LIMITS.maxEvidenceInOutput).map(e => ({
    id: e.id, type: e.type, sourceName: e.sourceName, sourceUrl: e.sourceUrl, sourceRecordId: e.sourceRecordId,
    sourceAuthority: TIER_LABELS[e.sourceTier] as CompanyReputationCheckOutput["evidence"][number]["sourceAuthority"],
    title: e.title, summary: e.summary, publishedAt: e.publishedAt, observedAt: e.observedAt, jurisdiction: e.jurisdiction,
    companyIdentifiers: {
      name: e.companyIdentifiers.legalName ?? e.companyIdentifiers.name ?? null, registrationNumber: e.companyIdentifiers.registrationNumber ?? null,
      lei: e.companyIdentifiers.lei ?? null, domain: e.companyIdentifiers.domain ?? null, country: e.companyIdentifiers.country ?? null
    },
    quality: e.quality, relevance: e.relevance, fromCache: fromCacheByProvider.get(e.providerId) ?? false
  }));
  const dates = sortedEvidence.map(e => e.publishedAt ?? e.observedAt).filter(Boolean).sort();

  // --- Warnings / limitations / summary -------------------------------------------------------------
  const warnings = buildWarnings(query, resolution, runs, confidence.score);
  const limitations = buildLimitations(query, runs, resolution);
  const out = (s: Signal[]) => s.map(toSignalOut);
  const byImportance = (a: Signal, b: Signal) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.strength - a.strength || a.code.localeCompare(b.code);

  return {
    company: {
      requestedName: input.companyName, resolvedName: resolution.resolvedName,
      country: query.country?.code ?? resolution.matched?.country ?? null, countryName: query.country?.name ?? null,
      website: query.website, domain: query.domain,
      registrationNumber: query.registrationNumber ?? resolution.matched?.registrationNumber ?? null,
      lei: query.lei ?? resolution.matched?.lei ?? resolution.corroboratingRecords.find(c => c.lei)?.lei ?? null, city: query.city ?? resolution.matched?.city ?? null, industry: query.industry
    },
    resolution: {
      status: resolution.status, confidence: Math.round(resolution.confidence * 100), methods: resolution.methods, conflicts: resolution.conflicts,
      candidates: resolution.candidates.map(c => ({ legalName: c.legalName, country: c.country, city: c.city, registrationNumber: c.registrationNumber, lei: c.lei, status: c.status, registry: c.registryName, matchScore: c.score, matchedOn: c.matchedOn, conflicts: c.conflicts, evidenceId: c.evidenceId }))
    },
    reputationScore: scoring.reputationScore,
    confidenceScore: confidence.score,
    trustLevel,
    scores: Object.fromEntries(DIMENSIONS.map(d => [d, scoring.dimensions[d].score])) as CompanyReputationCheckOutput["scores"],
    scoreBreakdown: DIMENSIONS.map(d => scoring.dimensions[d]),
    confidenceBreakdown: { ...confidence.components, capsApplied: [...confidence.capsApplied, ...scoring.capsApplied.map(c => `score_cap:${c}`)] },
    identity: { status: identity.status, signals: out(identity.signals) },
    sanctions: { status: sanctions.status, listsChecked: sanctions.listsChecked, listsUnavailable: sanctions.listsUnavailable, matches: sanctions.matches, highestConfidence: sanctions.highestConfidence },
    adverseMedia: {
      status: adverse.status, items: adverse.items.slice(0, LIMITS.maxAdverseItemsInOutput), neutralMentions: adverse.neutralMentions,
      victimOrReporterMentions: adverse.victimOrReporterMentions, excludedPossibleOtherEntity: excluded, duplicatesMerged: syndicatedMerged + exactDuplicates
    },
    customerSentiment: { status: customer.status, aggregateRatings: customer.aggregateRatings, positiveSignals: out(customer.positiveSignals), negativeSignals: out(customer.negativeSignals) },
    onlinePresence: { status: online.status, signals: out(online.signals) },
    legalRiskSignals: out(signals.filter(s => s.dimension === "legalRegulatory")),
    businessStabilitySignals: out(signals.filter(s => s.dimension === "businessStability")),
    cyberDomainSignals: out(signals.filter(s => s.dimension === "cyberDomain")),
    transparencySignals: out(signals.filter(s => s.dimension === "transparency")),
    positiveSignals: out(signals.filter(s => s.polarity === "positive").sort(byImportance)),
    redFlags: out(signals.filter(s => s.polarity === "negative" && SEVERITY_RANK[s.severity] >= SEVERITY_RANK.medium).sort(byImportance)),
    evidenceSummary: {
      totalEvidence: sortedEvidence.length,
      independentSources: independentUnits.length,
      highConfidenceSources: independentUnits.filter(u => u.tier <= 2).length,
      freshestEvidenceAt: dates.at(-1) ?? null,
      oldestEvidenceAt: dates[0] ?? null,
      duplicatesMerged: syndicatedMerged + exactDuplicates,
      excludedPossibleOtherEntity: excluded,
      servedFromCache: runs.filter(r => r.fromCache).length,
      staleEvidence: runs.filter(r => r.status === "stale_cache").length,
      evidenceTruncated: sortedEvidence.length > LIMITS.maxEvidenceInOutput
    },
    evidence: evidenceOut,
    coverage: {
      providers: runs.map(r => ({ provider: r.providerName, category: r.category, status: r.status, fromCache: r.fromCache, fetchedAt: r.fetchedAt, evidenceCount: r.evidence.length, reason: r.reason })),
      dimensionsWithEvidence: DIMENSIONS.filter(d => scoring.dimensions[d].coverage > 0),
      jurisdictionRegistryChecked: runs.some(r => r.category === "registry" && r.providerId !== "registry_gleif" && checkedRun(r))
    },
    warnings,
    limitations,
    summary: buildSummary({ resolution, sanctionsStatus: sanctions.status, sanctionsLists: sanctions.listsChecked, adverse, customerStatus: customer.status, confidence: confidence.score, score: scoring.reputationScore, independent: independentUnits.length, highAuthority: independentUnits.filter(u => u.tier <= 2).length, trustLevel }),
    methodology: {
      scoringModelVersion: SCORING_MODEL_VERSION,
      weights: { ...DIMENSION_WEIGHTS },
      neutralPrior: NEUTRAL_PRIOR,
      note: "Each dimension score = neutralPrior + coverage × (evidence-derived score − neutralPrior); reputationScore = Σ weight × dimension score (then documented caps). Missing evidence pulls toward the neutral prior and lowers confidence; it never raises the score."
    }
  } satisfies CompanyReputationCheckOutput;
}

export function decideTrustLevel(score: number, confidence: number, signals: readonly Signal[]): CompanyReputationCheckOutput["trustLevel"] {
  if (confidence < TRUST_THRESHOLDS.minConfidenceForAssessment) return "insufficient_evidence";
  const negative = signals.filter(s => s.polarity === "negative" && s.strength > 0);
  if (score < TRUST_THRESHOLDS.someConcerns.minScore || negative.some(s => (s.severity === "critical" && s.strength >= 0.5) || (s.severity === "high" && s.strength >= 0.8))) return "significant_concerns";
  if (score < TRUST_THRESHOLDS.noMajorConcerns.minScore || negative.some(s => SEVERITY_RANK[s.severity] >= SEVERITY_RANK.medium && s.strength >= 0.4)) return "some_concerns";
  if (score >= TRUST_THRESHOLDS.favorable.minScore && confidence >= TRUST_THRESHOLDS.favorable.minConfidence) return "favorable_public_signals";
  return "no_major_concerns_found";
}

function buildWarnings(q: ReputationQuery, resolution: Resolution, runs: readonly ProviderRun[], confidence: number): ReputationWarning[] {
  const w: ReputationWarning[] = [];
  if (!q.country) w.push({ code: "COUNTRY_NOT_PROVIDED", message: "No country was supplied; same-name companies in other jurisdictions cannot be excluded reliably. Supply country (and ideally registrationNumber or website).", provider: null });
  if (resolution.status === "ambiguous") w.push({ code: "AMBIGUOUS_COMPANY", message: "Multiple registry entities match this name; evidence not tied to a supplied identifier was not attributed. Supply registrationNumber, LEI, country or website.", provider: null });
  if (resolution.status === "unresolved" || resolution.status === "registry_not_checked") w.push({ code: "COMPANY_NOT_RESOLVED", message: resolution.status === "unresolved" ? "The company could not be matched to a registry record; results rely on the supplied identifiers." : "No company registry was available for this company in this deployment; identity was not verified against a registry.", provider: null });
  for (const r of runs) {
    if (r.status === "unavailable") w.push({ code: "PROVIDER_UNAVAILABLE", message: r.reason ?? `${r.providerName} was unavailable.`, provider: r.providerName });
    else if (r.status === "timeout") w.push({ code: "PROVIDER_TIMEOUT", message: r.reason ?? `${r.providerName} timed out.`, provider: r.providerName });
    else if (r.status === "rate_limited") w.push({ code: "RATE_LIMITED", message: r.reason ?? `${r.providerName} rate limited the request.`, provider: r.providerName });
    else if (r.status === "stale_cache") w.push({ code: "DATA_STALE", message: r.reason ?? `${r.providerName} evidence is stale.`, provider: r.providerName });
  }
  const notConfigured = runs.filter(r => r.status === "not_configured");
  if (notConfigured.length > 0) w.push({ code: "PROVIDER_NOT_CONFIGURED", message: `Not enabled in this deployment: ${notConfigured.map(r => r.providerName).join("; ")}.`, provider: null });
  if (confidence < TRUST_THRESHOLDS.minConfidenceForAssessment) w.push({ code: "INSUFFICIENT_EVIDENCE", message: "Too little independent evidence was available to assess this company's reputation reliably.", provider: null });
  return w;
}

function buildLimitations(q: ReputationQuery, runs: readonly ProviderRun[], resolution: Resolution): string[] {
  const l = [...BASE_LIMITATIONS];
  const cat = (c: ProviderCategory) => runs.filter(r => r.category === c);
  if (!cat("sanctions").some(checkedRun)) l.push("Sanctions lists were not checked in this call.");
  else l.push(`Sanctions lists checked: ${cat("sanctions").filter(checkedRun).map(r => r.providerName).join("; ")}. Other national lists were not checked.`);
  if (!cat("news").some(checkedRun)) l.push("News / adverse-media search was not performed in this call.");
  if (!cat("reviews").some(checkedRun)) l.push("Customer review platforms were not searched in this call.");
  if (!q.website && !q.domain) l.push("No website/domain was supplied, so website, domain and contact-transparency checks were not performed (not treated as a risk).");
  if (!cat("registry").some(r => checkedRun(r) && r.providerId !== "registry_gleif")) l.push(`No jurisdiction-specific company registry was checked${q.country ? ` for ${q.country.name}` : ""}; the global LEI index covers only entities that hold an LEI.`);
  if (resolution.status !== "resolved") l.push("Company identity was not fully resolved; evidence attribution is limited to items that name the company and are consistent with the supplied identifiers.");
  return l;
}

function buildSummary(p: { resolution: Resolution; sanctionsStatus: string; sanctionsLists: string[]; adverse: ReturnType<typeof analyzeAdverseMedia>; customerStatus: string; confidence: number; score: number; independent: number; highAuthority: number; trustLevel: string }): string {
  const r = p.resolution;
  const parts: string[] = [];
  if (r.status === "resolved" || r.status === "probable") parts.push(`Identity ${r.status === "resolved" ? "matched" : "probably matched"} to registry record "${r.matched!.legalName}" (${r.matched!.registryName}${r.matched!.matchedOn.length ? `; matched on ${r.matched!.matchedOn.join(", ")}` : ""}).`);
  else if (r.status === "ambiguous") parts.push(`Identity could not be resolved to a single entity: ${r.candidates.length} similarly named registry entities; evidence was not attributed to any of them.`);
  else parts.push("Identity was not confirmed against a company registry; results rely on the supplied identifiers.");
  parts.push(
    p.sanctionsStatus === "high_confidence_match" ? "A high-confidence potential sanctions-list match was found — verify at the source list before any transaction."
    : p.sanctionsStatus === "possible_match" ? "A possible sanctions-list name match was found; manual verification recommended (not a confirmed listing)."
    : p.sanctionsStatus === "no_match_found" || p.sanctionsStatus === "partial" ? `No sanctions-list name match was found in the checked sources (${p.sanctionsLists.join("; ")}).`
    : "Sanctions lists were not checked."
  );
  const items = p.adverse.items;
  if (p.adverse.status === "items_found") {
    const established = items.filter(i => i.established).length;
    parts.push(`${items.length} adverse-media event(s) identified (${established} reporting an established outcome such as a judgment, settlement or regulatory action; ${items.length - established} allegation/investigation/lawsuit-stage).`);
  } else if (p.adverse.status === "none_found") parts.push("No adverse media was identified in the checked sources.");
  else parts.push("Adverse media was not checked.");
  if (p.customerStatus === "mostly_negative") parts.push("Customer-reported signals were predominantly negative (unverified reviews/posts).");
  else if (p.customerStatus === "mostly_positive") parts.push("Customer-reported signals were predominantly positive (unverified reviews/posts).");
  else if (p.customerStatus === "mixed") parts.push("Customer-reported signals were mixed.");
  parts.push(`Evidence: ${p.independent} independent source(s), ${p.highAuthority} official/major. Reputation ${p.score}/100 at confidence ${p.confidence}/100 (${p.trustLevel.replace(/_/g, " ")}).`);
  if (p.confidence < 60) parts.push("Limited independent evidence was available; treat the score as provisional.");
  return parts.join(" ");
}
