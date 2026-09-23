import { createHash } from "node:crypto";
import { analyzeAdverseMedia } from "../company-reputation/analyzers/adverseMediaAnalyzer.js";
import type { AnalysisContext } from "../company-reputation/analyzers/context.js";
import { analyzeCustomerSentiment } from "../company-reputation/analyzers/customerSentimentAnalyzer.js";
import { analyzeSanctions } from "../company-reputation/analyzers/sanctionsAnalyzer.js";
import { assessRelevance, resolveIdentity, type Resolution } from "../company-reputation/companyResolver.js";
import { MIN_RELEVANCE } from "../company-reputation/config.js";
import { dedupeEvidence, groupEvents } from "../company-reputation/deduplication.js";
import type { ReputationEvidenceCache } from "../company-reputation/evidenceCache.js";
import {
  foldForMatch, normalizeCompanyName, normalizeCountry, normalizeLei, normalizeRegistrationNumber, normalizeWebsite, registrationNumbersMatch
} from "../company-reputation/normalization.js";
import { runProvider } from "../company-reputation/providers/runner.js";
import { getDefaultReputationDependencies } from "../company-reputation/service.js";
import type { NormalizedEvidence, ProviderCategory } from "../company-reputation/types.js";
import { businessRiskScoreInput, type BusinessRiskScoreInput } from "../schemas/businessRiskInputs.js";
import type { BusinessRiskScoreOutput } from "../schemas/businessRiskOutputs.js";
import { MemoryAssessmentStore, PostgresAssessmentStore, type AssessmentStore } from "./assessmentStore.js";
import { computeConfidence } from "./confidence.js";
import {
  LIMITS, MISSING_DATA_POLICY, MISSING_DATA_RISK_RULES, RISK_LEVEL_BANDS, SCORING_MODEL_VERSION, SEVERITY_POINTS, getBusinessRiskAssessmentStoreMode,
  getBusinessRiskDisabledProviders, getCategoryWeights, getHighRiskJurisdictions, type CategoryWeights
} from "./config.js";
import { ambiguousEntityError, entityNotFoundError, providerOutageError } from "./errors.js";
import { evidenceFingerprint, freshnessOf, isRestrictedPartyList, lookupEvidence, round2, toEvidenceView, type EvidenceView } from "./evidence.js";
import { buildDefaultBusinessRiskProviders } from "./providers/index.js";
import { INSUFFICIENT_DATA_RECOMMENDATION, recommend } from "./recommendation.js";
import { computeScore, signalPoints } from "./scoring.js";
import { detectCompliance, detectCorporate, detectDigital, detectFinancial, detectOperational, detectReputation, type DetectionContext } from "./signals.js";
import { RISK_CATEGORIES, providerStage, type BusinessRiskProvider, type BusinessRiskQuery, type CoverageLevel, type RiskCategory, type RiskSignal, type RoleRun } from "./types.js";

/**
 * business_risk_score orchestration:
 *
 *   validate → normalize
 *   → STAGE 1: corporate registries + website + RDAP (concurrent, isolated, time-boxed, cache-first)
 *   → entity resolution
 *       ambiguous                          → 409 AMBIGUOUS_ENTITY (candidates; no deep scoring, no paid searches)
 *       registry says "no such company" and
 *       nothing else shows it exists       → 404 ENTITY_NOT_FOUND
 *       every identity source failed       → 504/429/503 (retryable, nothing charged)
 *   → STAGE 2 (with resolved identifiers): sanctions/export-control/debarment lists (company name,
 *     aliases and registry names), news, reviews, regulator publications, statutory filings,
 *     threat feed
 *   → dedup → relevance filtering (same-name companies elsewhere are excluded, never merged)
 *   → six risk-signal detectors → deterministic scoring engine → confidence model → recommendation
 *   → evidence-backed result (+ best-effort persisted assessment for audit).
 *
 * A provider failure never fails the call unless the minimum identity check cannot be performed;
 * otherwise it lowers coverage/confidence and is reported in `providers` and `warnings`.
 */

export interface BusinessRiskDependencies {
  providers: readonly BusinessRiskProvider[];
  cache: ReputationEvidenceCache;
  ttls: Readonly<Record<ProviderCategory, number>>;
  maxStaleMs: number;
  timeoutMs: number;
  maxAttempts: number;
  /** Provider ids, provider categories or roles disabled by the operator. */
  disabled: ReadonlySet<string>;
  now: () => Date;
  weights: CategoryWeights;
  highRiskJurisdictions: { codes: ReadonlySet<string>; source: string };
  assessments: AssessmentStore | null;
}

let defaultDeps: BusinessRiskDependencies | null = null;

/** Built lazily once per process. The evidence cache (and TTLs/timeouts) is the SAME instance
 *  company_reputation_check uses, so evidence is shared across the two capabilities. */
export function getDefaultBusinessRiskDependencies(): BusinessRiskDependencies {
  if (!defaultDeps) {
    const shared = getDefaultReputationDependencies();
    const store = getBusinessRiskAssessmentStoreMode();
    defaultDeps = {
      providers: buildDefaultBusinessRiskProviders(),
      cache: shared.cache, ttls: shared.ttls, maxStaleMs: shared.maxStaleMs, timeoutMs: shared.timeoutMs,
      maxAttempts: LIMITS.maxProviderAttempts,
      disabled: getBusinessRiskDisabledProviders(),
      now: () => new Date(),
      weights: getCategoryWeights(),
      highRiskJurisdictions: getHighRiskJurisdictions(),
      assessments: store.mode === "postgres" ? new PostgresAssessmentStore(store.url) : store.mode === "memory" ? new MemoryAssessmentStore() : null
    };
  }
  return defaultDeps;
}

const checked = (r: RoleRun) => r.status === "ok" || r.status === "stale_cache";
const attempted = (r: RoleRun) => r.status !== "not_configured" && r.status !== "not_applicable";
const collapse = (s: string) => s.trim().replace(/\s+/g, " ");
const SEV = { info: 0, low: 1, medium: 2, high: 3, critical: 4 } as const;

// ---------------------------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------------------------

export function buildBusinessRiskQuery(input: BusinessRiskScoreInput): BusinessRiskQuery {
  const companyName = collapse(input.companyName);
  const nameKey = normalizeCompanyName(companyName).key;
  const website = normalizeWebsite(input.website ?? null);
  const seen = new Set([nameKey]);
  const knownAliases: string[] = [];
  for (const raw of input.knownAliases ?? []) {
    const alias = collapse(raw);
    const key = normalizeCompanyName(alias).key;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    knownAliases.push(alias);
  }
  return {
    companyName, legalName: null, nameKey,
    country: normalizeCountry(input.country ?? null),
    website: website?.url ?? null, domain: website?.domain ?? null,
    registrationNumber: normalizeRegistrationNumber(input.registrationNumber ?? null),
    lei: normalizeLei(input.lei ?? null),
    city: input.city ? collapse(input.city) : null,
    industry: input.industry ? collapse(input.industry) : null,
    knownAliases: knownAliases.slice(0, LIMITS.maxAliases),
    address: input.address ? collapse(input.address) : null
  };
}

/** Normalized company identity — the key of persisted assessments. Two businesses with the same
 *  name in different countries (or with different identifiers) never share a key. */
export function identityKeyOf(q: BusinessRiskQuery): string {
  return [
    q.nameKey, q.country?.code ?? "*", q.registrationNumber ?? "", q.lei ?? "", q.domain ?? "", q.city ? foldForMatch(q.city) : "",
    q.address ? foldForMatch(q.address) : "", [...q.knownAliases].map(a => normalizeCompanyName(a).key).sort().join(",")
  ].join("|");
}

// ---------------------------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------------------------

const ROLE_ORDER: Readonly<Record<RoleRun["role"], number>> = { corporate: 0, digital: 1, financial: 2, sanctions: 3, news: 4, regulatory: 5 };

/** Runs one collection stage concurrently and returns the runs in a CANONICAL order (role, then
 *  provider id), so every list derived from them — and therefore the whole result — is
 *  independent of provider registration order. */
async function runStage(providers: readonly BusinessRiskProvider[], query: BusinessRiskQuery, deps: BusinessRiskDependencies, stage: 1 | 2, excluded: (p: BusinessRiskProvider) => string | null): Promise<RoleRun[]> {
  const runs = await Promise.all(providers.map(async (p): Promise<RoleRun> => {
    const base = { providerId: p.id, providerName: p.name, category: p.category, evidence: [], fromCache: false, fetchedAt: null, requests: 0, estimatedCostUSD: 0, durationMs: 0, attempts: 0, role: p.role, stage };
    if (deps.disabled.has(p.role) || deps.disabled.has(p.id.toLowerCase())) return { ...base, status: "not_configured", reason: "Disabled by the operator (BUSINESS_RISK_DISABLED_PROVIDERS)." };
    const reason = excluded(p);
    if (reason) return { ...base, status: "not_applicable", reason };
    const run = await runProvider(p, query, { cache: deps.cache, ttls: deps.ttls, maxStaleMs: deps.maxStaleMs, timeoutMs: deps.timeoutMs, maxAttempts: deps.maxAttempts, disabled: deps.disabled, now: deps.now });
    return { ...run, role: p.role, stage };
  }));
  return runs.sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.providerId.localeCompare(b.providerId));
}

function str(v: unknown): string | null { return typeof v === "string" && v.length > 0 ? v : null; }
function strs(v: unknown): string[] { return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; }

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------

export async function runBusinessRiskScore(rawInput: unknown, deps: BusinessRiskDependencies = getDefaultBusinessRiskDependencies()): Promise<BusinessRiskScoreOutput> {
  const input = businessRiskScoreInput.parse(rawInput);
  const query = buildBusinessRiskQuery(input);
  const identityKey = identityKeyOf(query);
  const includeNews = input.includeNews !== false;
  const includeDigital = input.includeDigitalSignals !== false;
  const excluded = (p: BusinessRiskProvider): string | null =>
    !includeNews && (p.role === "news" || p.role === "regulatory") ? "Excluded by request (includeNews=false)."
    : !includeDigital && p.role === "digital" ? "Excluded by request (includeDigitalSignals=false)."
    : null;

  // --- Stage 1: identity sources ------------------------------------------------------------------
  const stage1 = deps.providers.filter(p => providerStage(p) === 1);
  const stage2 = deps.providers.filter(p => providerStage(p) === 2);
  const runs1 = await runStage(stage1, query, deps, 1, excluded);
  const ev1 = dedupeEvidence(runs1.flatMap(r => r.evidence)).items;
  const registryEvidence = ev1.filter(e => e.type === "registry" && e.metadata.recordKind !== "company_filing_status");
  const website = ev1.find(e => e.providerId === "website_homepage") ?? null;
  const domain = ev1.find(e => e.providerId === "domain_rdap") ?? null;

  const registryRuns = runs1.filter(r => r.role === "corporate");
  const identityAttempted = runs1.filter(r => (r.role === "corporate" || r.role === "digital") && attempted(r));
  if (registryRuns.some(attempted) && !registryRuns.some(checked) && !runs1.some(r => r.role === "digital" && checked(r))) {
    throw providerOutageError(identityAttempted);
  }

  const registryChecked = registryRuns.some(checked);
  const jurisdictionRegistryChecked = registryRuns.some(r => checked(r) && r.providerId !== "registry_gleif");
  const resolution: Resolution = resolveIdentity(query, registryEvidence, registryChecked, website);
  if (resolution.status === "ambiguous") throw ambiguousEntityError(query, resolution);

  let registryNotFound = false;
  let registrationNumberNotFound = false;
  if (resolution.status === "unresolved" && jurisdictionRegistryChecked) {
    const presence = website?.metadata.reachable === true || domain?.metadata.found === true;
    if (!presence) throw entityNotFoundError(query, registryRuns.filter(checked).map(r => r.providerName));
    registrationNumberNotFound = Boolean(query.registrationNumber) && !registryEvidence.some(e => e.providerId !== "registry_gleif" && registrationNumbersMatch(str(e.metadata.registrationNumber), query.registrationNumber));
    registryNotFound = !registrationNumberNotFound;
  }
  const identityVerified = resolution.status === "resolved" || resolution.status === "probable";
  const matchedIds = new Set(identityVerified && resolution.matched ? [resolution.matched.evidenceId, ...resolution.corroboratingRecords.map(c => c.evidenceId)] : []);
  const matchedRecords = registryEvidence.filter(e => matchedIds.has(e.id)).sort((a, b) => (a.providerId === "registry_gleif" ? 1 : 0) - (b.providerId === "registry_gleif" ? 1 : 0) || a.id.localeCompare(b.id));

  // --- Stage 2: everything else, with the resolved identifiers ---------------------------------------
  const registryNames = matchedRecords.flatMap(e => [str(e.metadata.legalName), ...strs(e.metadata.otherNames)]).filter((n): n is string => Boolean(n));
  const screeningAliases: string[] = [];
  const seenKeys = new Set([query.nameKey]);
  for (const n of [...query.knownAliases, ...registryNames]) {
    const key = normalizeCompanyName(n).key;
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    screeningAliases.push(n);
  }
  const q2: BusinessRiskQuery = {
    ...query,
    registrationNumber: query.registrationNumber ?? (identityVerified ? resolution.matched?.registrationNumber ?? null : null),
    lei: query.lei ?? (identityVerified ? resolution.matched?.lei ?? resolution.corroboratingRecords.find(c => c.lei)?.lei ?? null : null),
    ...(screeningAliases.length ? { aliases: screeningAliases.slice(0, LIMITS.maxSanctionsNames - 1) } : {}),
    filingDetailPresent: matchedRecords.some(e => e.metadata.filingDetail === true)
  };
  const runs2 = await runStage(stage2, q2, deps, 2, excluded);
  const runs = [...runs1, ...runs2];
  const runByProvider = new Map(runs.map(r => [r.providerId, r]));

  const { items: deduped, removed: duplicatesRemoved } = dedupeEvidence(runs.flatMap(r => r.evidence));
  const checkedRuns = runs.filter(checked);
  if (checkedRuns.length === 0) return insufficientData(input, query, identityKey, runs, resolution, deps);
  const evaluatedAt = checkedRuns.map(r => r.fetchedAt!).sort().at(-1)!;
  const asOf = new Date(evaluatedAt);

  // --- Relevance filtering: same-name companies elsewhere are excluded, never merged ------------------
  const variants: BusinessRiskQuery[] = [q2, ...query.knownAliases.map(a => ({ ...q2, companyName: a, legalName: null, nameKey: normalizeCompanyName(a).key }))];
  const relevant: NormalizedEvidence[] = [];
  let excludedOtherEntity = 0;
  for (const e of deduped.filter(x => x.type === "news" || x.type === "regulatory" || x.type === "review" || x.type === "forum")) {
    const best = Math.max(...variants.map(v => assessRelevance(e, v, resolution).relevance));
    if (best >= MIN_RELEVANCE) relevant.push({ ...e, relevance: best });
    else excludedOtherEntity++;
  }
  const groups = groupEvents(relevant);
  const sanctionsEvidence = deduped.filter(e => e.type === "sanctions");
  const filings = deduped.filter(e => e.metadata.recordKind === "company_filing_status");
  const threat = deduped.find(e => e.providerId === "threat_google_safe_browsing") ?? null;

  const analysis: AnalysisContext = { query: q2, resolution, runs, registry: registryEvidence, sanctions: sanctionsEvidence, website, domain, thirdPartyGroups: groups, now: asOf };
  const sanctions = analyzeSanctions(analysis);
  const adverse = analyzeAdverseMedia(analysis);
  const customer = analyzeCustomerSentiment(analysis);

  const freshness = new Map<string, number>();
  for (const e of [...deduped, ...relevant]) freshness.set(e.id, freshnessOf(e, asOf, runByProvider.get(e.providerId)?.status === "stale_cache"));
  const lookups = new Map<string, EvidenceView>();
  const ctx: DetectionContext = {
    query: q2, asOf, resolution, identityVerified, registryNotFound, registrationNumberNotFound, jurisdictionRegistryChecked,
    matchedRecords, filings, website, domain, threat, sanctions, adverse, customer, runs, highRiskJurisdictions: deps.highRiskJurisdictions.codes, freshness,
    lookup: (run, claim) => { const v = lookupEvidence(run, claim, asOf); lookups.set(v.id, v); return v.id; }
  };
  const detections = [detectCorporate(ctx), detectFinancial(ctx), detectCompliance(ctx), detectReputation(ctx), detectOperational(ctx), detectDigital(ctx)];
  const signals: RiskSignal[] = detections.flatMap(d => d.signals);
  const coverage = Object.fromEntries(detections.map(d => [d.category, d.coverage])) as Record<RiskCategory, CoverageLevel>;

  // --- Scoring ----------------------------------------------------------------------------------------
  const weights = deps.weights.weights;
  const score = computeScore(signals, coverage, weights);

  // --- Evidence output (every id cited by a signal is always included) ---------------------------------
  const matchedSanctionIds = new Set(sanctions.matches.map(m => m.evidenceId));
  const pool = new Map<string, NormalizedEvidence>();
  for (const e of [...matchedRecords, ...filings, ...sanctionsEvidence.filter(x => matchedSanctionIds.has(x.id)), ...(website ? [website] : []), ...(domain ? [domain] : []), ...(threat ? [threat] : []), ...relevant]) pool.set(e.id, e);
  const views: EvidenceView[] = [...[...pool.values()].map(e => toEvidenceView(e, asOf, runByProvider.get(e.providerId))), ...lookups.values()];
  const cited = new Set(signals.flatMap(s => s.evidenceIds));
  const order = (a: EvidenceView, b: EvidenceView) => RELIABILITY_RANK[a.reliability] - RELIABILITY_RANK[b.reliability] || (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "") || a.id.localeCompare(b.id);
  const citedViews = views.filter(v => cited.has(v.id)).sort(order);
  const otherViews = views.filter(v => !cited.has(v.id)).sort(order);
  const evidenceOut = [...citedViews, ...otherViews.slice(0, Math.max(0, LIMITS.maxEvidenceInOutput - citedViews.length))].sort(order);

  // --- Confidence + recommendation -----------------------------------------------------------------------
  const conf = computeConfidence({
    entityMatchConfidence: resolution.confidence, identityVerified,
    jurisdictionRegistryMatched: matchedRecords.some(e => e.providerId !== "registry_gleif"), anyRegistryMatched: matchedRecords.length > 0,
    coverage, weights, sourceRecords: views.filter(v => v.recordType === "source_record"), signals,
    staleProviderRuns: runs.filter(r => r.status === "stale_cache").length
  });
  const recommendation = recommend({ riskScore: score.riskScore, confidence: conf.confidence, entityMatchConfidence: resolution.confidence, signals });

  const bySeverity = (a: RiskSignal, b: RiskSignal) => SEV[b.severity] - SEV[a.severity] || b.confidence - a.confidence || a.code.localeCompare(b.code) || a.evidenceIds.join().localeCompare(b.evidenceIds.join());
  const primary = matchedRecords[0] ?? null;
  const fingerprint = evidenceFingerprint(evidenceOut);
  const assessmentId = `bra_${createHash("sha256").update(`${identityKey}|${SCORING_MODEL_VERSION}|${fingerprint}`).digest("hex").slice(0, 24)}`;

  const result: BusinessRiskScoreOutput = {
    status: "assessed",
    assessmentId,
    business: {
      name: query.companyName,
      legalName: identityVerified ? resolution.resolvedName : null,
      country: query.country?.code ?? (identityVerified ? resolution.matched?.country ?? null : null),
      countryName: query.country?.name ?? null,
      registrationNumber: q2.registrationNumber, lei: q2.lei,
      registrationStatus: identityVerified ? registrationStatusOf(matchedRecords) : "not_verified",
      incorporationDate: identityVerified ? matchedRecords.map(e => str(e.metadata.incorporationDate)).filter((d): d is string => Boolean(d)).sort()[0] ?? null : null,
      registry: primary ? str(primary.metadata.registryName) ?? primary.sourceName : null,
      website: query.website, domain: query.domain,
      city: query.city ?? (identityVerified ? resolution.matched?.city ?? null : null), industry: query.industry,
      entityMatchConfidence: round2(resolution.confidence),
      resolutionStatus: resolution.status === "resolved" ? "resolved" : resolution.status === "probable" ? "probable" : "unverified",
      identityVerifiedAgainstRegistry: identityVerified,
      matchedOn: identityVerified ? resolution.matched?.matchedOn ?? [] : []
    },
    riskScore: score.riskScore,
    riskLevel: score.riskLevel,
    confidence: conf.confidence,
    components: {
      corporateRisk: score.categories.corporate.score, financialRisk: score.categories.financial.score, complianceRisk: score.categories.compliance.score,
      reputationRisk: score.categories.reputation.score, operationalRisk: score.categories.operational.score, digitalRisk: score.categories.digital.score
    },
    scoreBreakdown: {
      corporateContribution: score.categories.corporate.contribution, financialContribution: score.categories.financial.contribution,
      complianceContribution: score.categories.compliance.contribution, reputationContribution: score.categories.reputation.contribution,
      operationalContribution: score.categories.operational.contribution, digitalContribution: score.categories.digital.contribution,
      rawWeightedScore: score.rawWeightedScore,
      effectiveWeights: Object.fromEntries(RISK_CATEGORIES.map(c => [c, score.categories[c].effectiveWeight])) as Record<RiskCategory, number>,
      floorsApplied: score.floorsApplied
    },
    riskFlags: signals.filter(s => s.polarity === "negative").sort(bySeverity).map(s => ({
      code: s.code, category: s.category, severity: s.severity, title: s.title, description: s.description, evidenceIds: s.evidenceIds,
      weight: s.weight, confidence: s.confidence, scoreImpactPoints: round2(signalPoints(s)), factStatus: s.factStatus, requiresVerification: s.requiresVerification
    })),
    positiveSignals: signals.filter(s => s.polarity === "positive").sort(bySeverity).map(s => ({
      code: s.code, category: s.category, title: s.title, description: s.description, evidenceIds: s.evidenceIds, weight: s.weight, confidence: s.confidence, mitigationPoints: round2(signalPoints(s))
    })),
    sanctionsScreening: {
      status: sanctions.status, listsChecked: sanctions.listsChecked, listsUnavailable: sanctions.listsUnavailable,
      namesScreened: runs2.some(r => r.role === "sanctions" && checked(r)) ? [query.companyName, ...(q2.aliases ?? [])] : [],
      matches: sanctions.matches.map(m => ({
        listedName: m.listedName, matchedAlias: m.matchedAlias, list: m.list, listType: isRestrictedPartyList(m.list) ? "export_control_or_debarment" as const : "sanctions" as const,
        reference: m.reference, sourceUrl: m.sourceUrl, matchScore: m.matchScore, matchType: m.matchType, matchStrength: m.confidence,
        corroboratingIdentifiers: m.corroboratingIdentifiers, contradictions: m.contradictions, evidenceId: m.evidenceId
      }))
    },
    evidence: evidenceOut,
    recommendation,
    dataCoverage: coverage,
    confidenceBreakdown: { ...conf.components, contradictions: conf.contradictions, capsApplied: conf.capsApplied },
    providers: providersOut(runs),
    warnings: buildWarnings(query, resolution, runs, conf.confidence, registryNotFound || registrationNumberNotFound),
    assumptions: buildAssumptions(input, query, q2, screeningAliases, evaluatedAt),
    limitations: buildLimitations(query, runs, identityVerified, coverage, excludedOtherEntity, duplicatesRemoved + (relevant.length - groups.length), includeNews, includeDigital),
    methodology: methodology(deps),
    evaluatedAt
  };

  if (deps.assessments) {
    const store = deps.assessments;
    // Best-effort audit write, bounded so a slow database can never hold the response.
    await Promise.race([
      store.save({
        assessmentId, identityKey, scoringModelVersion: SCORING_MODEL_VERSION, evidenceFingerprint: fingerprint, status: result.status,
        riskScore: result.riskScore, riskLevel: result.riskLevel, confidence: result.confidence, action: recommendation.action,
        components: result.components, flagCodes: result.riskFlags.map(f => f.code), evidenceIds: evidenceOut.map(e => e.id), evaluatedAt, result
      }).catch(() => false),
      new Promise(resolve => setTimeout(resolve, 1500).unref?.())
    ]);
  }
  return result;
}

const RELIABILITY_RANK = { authoritative: 0, high: 1, medium: 2, low: 3 } as const;

function registrationStatusOf(records: readonly NormalizedEvidence[]): BusinessRiskScoreOutput["business"]["registrationStatus"] {
  const statuses = new Set(records.map(e => str(e.metadata.status) ?? "unknown"));
  for (const s of ["dissolved", "liquidation", "inactive", "active"] as const) if (statuses.has(s)) return s;
  return "unknown";
}

function providersOut(runs: readonly RoleRun[]): BusinessRiskScoreOutput["providers"] {
  return runs.map(r => ({ provider: r.providerName, role: r.role, stage: r.stage, status: r.status, fromCache: r.fromCache, retrievedAt: r.fetchedAt, evidenceCount: r.evidence.length, reason: r.reason }));
}

function methodology(deps: BusinessRiskDependencies): BusinessRiskScoreOutput["methodology"] {
  return {
    scoringModelVersion: SCORING_MODEL_VERSION,
    categoryWeights: { ...deps.weights.weights },
    weightsSource: deps.weights.source,
    severityPoints: { ...SEVERITY_POINTS },
    riskLevelBands: RISK_LEVEL_BANDS.map(b => ({ ...b })),
    missingDataPolicy: MISSING_DATA_POLICY,
    missingDataRiskRules: MISSING_DATA_RISK_RULES.map(r => ({ ...r })),
    highRiskJurisdictionsSource: deps.highRiskJurisdictions.source,
    formula: "Each signal contributes SEVERITY_POINTS[severity] × weight × confidence. Category score = baseline − baseline·(1−e^(−positive/30)) + (100−baseline)·(1−e^(−negative/45)), only for categories with data coverage (else null). riskScore = Σ effectiveWeight × categoryScore over covered categories (weights renormalized), raised to any documented floor set by a confident severe signal; clamped to 0–100. Confidence is computed separately (see confidenceBreakdown)."
  };
}

function buildWarnings(q: BusinessRiskQuery, resolution: Resolution, runs: readonly RoleRun[], confidence: number, notInRegistry: boolean): BusinessRiskScoreOutput["warnings"] {
  const w: BusinessRiskScoreOutput["warnings"] = [];
  if (!q.country) w.push({ code: "COUNTRY_NOT_PROVIDED", message: "No country was supplied; same-name companies in other countries cannot be excluded reliably. Supply country (and ideally registrationNumber or website).", provider: null });
  if (notInRegistry) w.push({ code: "IDENTITY_NOT_IN_REGISTRY", message: "The company was not found in its jurisdiction's registry although other evidence shows the business exists; identity is unverified.", provider: null });
  else if (resolution.status !== "resolved" && resolution.status !== "probable") w.push({ code: "IDENTITY_NOT_VERIFIED", message: "Identity could not be verified against a company registry in this deployment; results rely on the supplied identifiers.", provider: null });
  for (const r of runs) {
    if (r.status === "unavailable") w.push({ code: "PROVIDER_UNAVAILABLE", message: r.reason ?? `${r.providerName} was unavailable.`, provider: r.providerName });
    else if (r.status === "timeout") w.push({ code: "PROVIDER_TIMEOUT", message: r.reason ?? `${r.providerName} timed out.`, provider: r.providerName });
    else if (r.status === "rate_limited") w.push({ code: "RATE_LIMITED", message: r.reason ?? `${r.providerName} rate limited the request.`, provider: r.providerName });
    else if (r.status === "stale_cache") w.push({ code: "DATA_STALE", message: r.reason ?? `${r.providerName} evidence is stale.`, provider: r.providerName });
  }
  const notConfigured = runs.filter(r => r.status === "not_configured");
  if (notConfigured.length) w.push({ code: "PROVIDER_NOT_CONFIGURED", message: `Not enabled in this deployment: ${notConfigured.map(r => r.providerName).join("; ")}.`, provider: null });
  if (confidence < 0.4) w.push({ code: "LOW_CONFIDENCE", message: "Limited independent evidence was available; treat the score as provisional.", provider: null });
  return w;
}

function buildAssumptions(input: BusinessRiskScoreInput, q: BusinessRiskQuery, q2: BusinessRiskQuery, screeningAliases: readonly string[], evaluatedAt: string | null): string[] {
  const a: string[] = [];
  if (input.country && q.country && input.country.trim().toUpperCase() !== q.country.code) a.push(`Country "${input.country}" was normalized to ISO 3166 code ${q.country.code} (${q.country.name}).`);
  if (input.website && q.website && input.website.trim() !== q.website) a.push(`Website "${input.website}" was normalized to ${q.website} (domain ${q.domain}).`);
  if (input.registrationNumber && q.registrationNumber && input.registrationNumber !== q.registrationNumber) a.push(`Registration number was normalized to ${q.registrationNumber}.`);
  a.push(`Company name is matched on its normalized core "${q.nameKey}" (legal-form words such as Ltd/LLC are compared separately, never ignored for disambiguation).`);
  if (!input.registrationNumber && q2.registrationNumber) a.push(`Registration number ${q2.registrationNumber} was taken from the matched registry record.`);
  if (screeningAliases.length) a.push(`Also screened against sanctions/restricted-party lists: ${screeningAliases.map(n => `"${n}"`).join(", ")} (supplied aliases and registry names).`);
  if (evaluatedAt) a.push(`Ages and freshness are computed as of the evidence snapshot time ${evaluatedAt}.`);
  return a;
}

function buildLimitations(q: BusinessRiskQuery, runs: readonly RoleRun[], identityVerified: boolean, coverage: Readonly<Record<RiskCategory, CoverageLevel>>, excludedOtherEntity: number, merged: number, includeNews: boolean, includeDigital: boolean): string[] {
  const l = [
    "Evidence-based public-source screening for business decisions — not a legal, KYC/AML, credit, insurance or compliance determination, and never a guarantee that a company is safe or unsafe.",
    "riskScore and confidence are separate: a low score with low confidence means little evidence, not a safe company.",
    "Sanctions and restricted-party results are automated name matching; 'possible' matches are not listings, and even 'high' matches must be verified at the source list.",
    "Adverse media is reported at the legal stage the source states; allegations, investigations and lawsuits are not findings of wrongdoing.",
    "Company-level intelligence only; no personal data about individuals is collected or returned."
  ];
  const role = (r: RoleRun["role"]) => runs.filter(x => x.role === r);
  if (!role("corporate").some(checked)) l.push(`No company registry was checked${q.country ? ` for ${q.country.name}` : ""}; corporate identity and status are unverified.`);
  else if (!role("corporate").some(r => checked(r) && r.providerId !== "registry_gleif")) l.push("Only the global LEI index was checked; it covers only entities that hold an LEI. No jurisdiction-specific registry was available for this company.");
  if (coverage.financial !== "high") l.push("No reliable public financial statements or statutory-filing status were available; financial risk rests on registry status and media only (no financial figures are estimated).");
  if (!role("sanctions").some(checked)) l.push("Sanctions / restricted-party lists were not checked in this call.");
  else l.push(`Lists checked: ${role("sanctions").filter(checked).map(r => r.providerName).join("; ")}. Other national lists and PEP databases were not checked.`);
  if (!includeNews) l.push("News, review and regulator searches were skipped by request (includeNews=false).");
  else if (!role("news").some(checked)) l.push("News / adverse-media search was not performed in this call.");
  if (!includeDigital) l.push("Website, domain and threat-feed checks were skipped by request (includeDigitalSignals=false).");
  else if (!q.website) l.push("No website was supplied, so website, domain and email-consistency checks were not performed (not treated as a risk).");
  if (!runs.some(r => r.providerId === "threat_google_safe_browsing" && checked(r))) l.push("No malware/phishing threat feed was checked.");
  if (!identityVerified) l.push("Identity was not verified against a registry; evidence attribution is limited to items consistent with the supplied identifiers.");
  if (excludedOtherEntity > 0) l.push(`${excludedOtherEntity} search result(s) appeared to concern a different entity (other country, legal form or name) and were excluded.`);
  if (merged > 0) l.push(`${merged} duplicate or syndicated item(s) were merged so one story counts once.`);
  return l;
}

function insufficientData(input: BusinessRiskScoreInput, query: BusinessRiskQuery, identityKey: string, runs: readonly RoleRun[], resolution: Resolution, deps: BusinessRiskDependencies): BusinessRiskScoreOutput {
  const none: Record<RiskCategory, CoverageLevel> = { corporate: "none", financial: "none", compliance: "none", reputation: "none", operational: "none", digital: "none" };
  const zeroWeights = Object.fromEntries(RISK_CATEGORIES.map(c => [c, 0])) as Record<RiskCategory, number>;
  return {
    status: "insufficient_data",
    assessmentId: `bra_${createHash("sha256").update(`${identityKey}|${SCORING_MODEL_VERSION}|none`).digest("hex").slice(0, 24)}`,
    business: {
      name: query.companyName, legalName: null, country: query.country?.code ?? null, countryName: query.country?.name ?? null,
      registrationNumber: query.registrationNumber, lei: query.lei, registrationStatus: "not_verified", incorporationDate: null, registry: null,
      website: query.website, domain: query.domain, city: query.city, industry: query.industry,
      entityMatchConfidence: round2(resolution.confidence), resolutionStatus: "unverified", identityVerifiedAgainstRegistry: false, matchedOn: []
    },
    riskScore: null, riskLevel: null, confidence: 0,
    components: { corporateRisk: null, financialRisk: null, complianceRisk: null, reputationRisk: null, operationalRisk: null, digitalRisk: null },
    scoreBreakdown: {
      corporateContribution: null, financialContribution: null, complianceContribution: null, reputationContribution: null, operationalContribution: null, digitalContribution: null,
      rawWeightedScore: null, effectiveWeights: zeroWeights, floorsApplied: []
    },
    riskFlags: [], positiveSignals: [],
    sanctionsScreening: { status: runs.some(r => r.role === "sanctions" && attempted(r)) ? "unavailable" : "not_checked", listsChecked: [], listsUnavailable: runs.filter(r => r.role === "sanctions" && attempted(r)).map(r => r.providerName), namesScreened: [], matches: [] },
    evidence: [],
    recommendation: INSUFFICIENT_DATA_RECOMMENDATION,
    dataCoverage: none,
    confidenceBreakdown: { entityResolution: round2(resolution.confidence), categoryCoverage: 0, sourceQuality: 0, authoritativeRecords: 0, freshness: 0, consistency: 1, contradictions: [], capsApplied: [] },
    providers: providersOut(runs),
    warnings: [
      { code: "INSUFFICIENT_DATA", message: "No evidence source could be checked for this company in this deployment (see providers). No risk score was computed.", provider: null },
      ...buildWarnings(query, resolution, runs, 1, false).filter(x => x.code !== "IDENTITY_NOT_VERIFIED")
    ],
    assumptions: buildAssumptions(input, query, query, [], null),
    limitations: [
      "No provider returned evidence for this request (sources not configured, not applicable to this company, or excluded by request), so no risk assessment was possible. This is not a statement about the company.",
      "Configure RISK_LIVE_CHECKS_ENABLED (public registries, sanctions lists, website, RDAP), WEB_SEARCH_PROVIDER (news/reviews/regulators) and registry keys such as COMPANIES_HOUSE_API_KEY to enable evidence collection."
    ],
    methodology: methodology(deps),
    evaluatedAt: null
  };
}
