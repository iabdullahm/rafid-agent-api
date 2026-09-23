import { omanSupplierCheckInput } from "../schemas/supplierCheckInputs.js";
import type { OmanSupplierCheckOutput } from "../schemas/supplierCheckOutputs.js";
import { getOmanCompanyDataProvider } from "../services/omanBusiness.js";
import { normalizeCompanyName } from "../business-data/normalizers/companyName.js";
import { getSupplierCacheTtls, getSupplierEvidenceDatabaseUrl } from "./config.js";
import { cachedProviderCall, MemoryEvidenceStore, PostgresEvidenceStore, type EvidenceStore } from "./evidenceStore.js";
import { normalizeSupplierInput, normalizeWebsite, supplierIdentityKey } from "./normalize.js";
import { OmanRegistryIdentityProvider, dedupeSources, type SupplierIdentityProvider } from "./providers/registryProvider.js";
import { PublicWebsiteProvider, type SupplierWebsiteProvider, type WebsiteEvidence } from "./providers/websiteProvider.js";
import { buildSanctionsProviders, type SanctionsListProvider } from "./providers/sanctionsProviders.js";
import { WebSearchPublicRiskProvider, type SupplierPublicRiskProvider } from "./providers/publicRiskProvider.js";
import { assessAddress, assessContacts, assessIdentity, assessWebsite } from "./analysis/consistency.js";
import { assessActivity } from "./analysis/activity.js";
import { assessPublicRisk } from "./analysis/publicRisk.js";
import { findPotentialMatches, type SanctionsMatch } from "./sanctionsMatcher.js";
import { RISK_THRESHOLDS, procurementSuitability, scoreSupplier } from "./scoring.js";
import type { EvidenceSource, SanctionsStatus, SupplierRiskFlag } from "./types.js";

/**
 * oman_supplier_check orchestration. Flow:
 *   1. validate + normalize input (deterministic)
 *   2. resolve identity against the canonical Oman company registry (cached evidence)
 *   3. in parallel: website inspection (supplied URL, else the registry's), sanctions lists,
 *      public-web signals — each cached independently with its own TTL
 *   4. independent assessments (identity, activity, website, contact, address, sanctions, public risk)
 *   5. transparent weighted scoring (scoring.ts) → risk, suitability, confidence
 * Any provider being unavailable degrades that check to "unknown"/"unavailable" and lowers
 * confidence; only a genuine execution failure (e.g. invalid input) fails the call.
 */

export interface SupplierCheckDependencies {
  identity: SupplierIdentityProvider;
  website: SupplierWebsiteProvider;
  sanctions: readonly SanctionsListProvider[];
  publicRisk: SupplierPublicRiskProvider;
  store: EvidenceStore;
  ttls: ReturnType<typeof getSupplierCacheTtls>;
  now: () => Date;
}

let defaultDeps: SupplierCheckDependencies | null = null;

/** Built lazily once per process (so the UN list and the evidence cache survive across calls on a
 *  warm instance), from the same env-driven configuration as every other capability. */
export function getDefaultSupplierCheckDependencies(): SupplierCheckDependencies {
  if (!defaultDeps) {
    const dbUrl = getSupplierEvidenceDatabaseUrl();
    defaultDeps = {
      identity: new OmanRegistryIdentityProvider(getOmanCompanyDataProvider()),
      website: new PublicWebsiteProvider(),
      sanctions: buildSanctionsProviders(),
      publicRisk: new WebSearchPublicRiskProvider(),
      store: dbUrl ? new PostgresEvidenceStore(dbUrl) : new MemoryEvidenceStore(),
      ttls: getSupplierCacheTtls(),
      now: () => new Date()
    };
  }
  return defaultDeps;
}

const BASE_LIMITATIONS = [
  "This is an automated public-source procurement screening result and is not a substitute for legal, AML, KYC or regulatory due diligence.",
  "identityConfirmed means the submitted identity is consistent with the registry and contact evidence found; it is not a government verification or certification of the supplier.",
  "Sanctions screening is automated name matching only. A potential_match is not a confirmed listing, and a clear result does not guarantee the supplier is not listed under another name or on a list not checked.",
  "Public-risk signals are unverified public-source indicators, never findings of misconduct. Absence of signals is not a clearance.",
  "procurementSuitability informs the procurement decision; it is not a vendor approval or rejection."
];

export async function runOmanSupplierCheck(rawInput: unknown, deps: SupplierCheckDependencies = getDefaultSupplierCheckDependencies()): Promise<OmanSupplierCheckOutput> {
  const input = omanSupplierCheckInput.parse(rawInput);
  const n = normalizeSupplierInput(input);
  const now = deps.now();

  // --- 2. Identity (canonical registry) -------------------------------------------------------
  const identityKey = supplierIdentityKey(n);
  const identityResult = await cachedProviderCall(
    deps.store, deps.identity.id, `${identityKey}|${n.nameVariants.join(",")}`, deps.ttls.identityMs, now,
    () => deps.identity.searchCompany(n, now),
    r => r.evidence?.candidates[0]?.companyId ?? null
  );
  const preliminaryCandidate = identityResult.evidence?.candidates.find(c => c.nameScore >= 0.6 || c.crMatches) ?? null;

  // --- 3. Website / sanctions / public risk in parallel ---------------------------------------
  const suppliedSite = n.website;
  const registrySite = !suppliedSite && preliminaryCandidate?.website ? normalizeWebsite(preliminaryCandidate.website)?.url ?? null : null;
  const inspectedUrl = suppliedSite ?? registrySite;
  const fetchUrl = inspectedUrl ? inspectedUrl.replace(/^http:\/\//i, "https://") : null;
  const urlSource = suppliedSite ? "supplied" as const : registrySite ? "registry" as const : null;

  const sanctionsNames = [...new Map([n.companyName, preliminaryCandidate?.companyName, preliminaryCandidate?.nameEn]
    .filter((v): v is string => Boolean(v)).map(name => [normalizeForKey(name), name] as const)).values()];

  const [websiteResult, sanctionsResults, publicRiskResult] = await Promise.all([
    fetchUrl
      ? cachedProviderCall(deps.store, deps.website.id, fetchUrl.toLowerCase(), deps.ttls.websiteMs, now, () => deps.website.inspectWebsite(fetchUrl, now))
      : Promise.resolve(null),
    Promise.all(deps.sanctions.map(async p => ({
      provider: p,
      results: await Promise.all(sanctionsNames.map(name =>
        cachedProviderCall(deps.store, p.id, normalizeForKey(name), deps.ttls.sanctionsMs, now, () => p.screenName(name, now))))
    }))),
    cachedProviderCall(deps.store, deps.publicRisk.id, normalizeForKey(n.companyName), deps.ttls.publicRiskMs, now, () => deps.publicRisk.findSignals(n.companyName, now))
  ]);
  const websiteEvidence: WebsiteEvidence | null = websiteResult?.status === "ok" ? websiteResult.evidence : null;

  // --- 4. Assessments --------------------------------------------------------------------------
  const identity = assessIdentity(n, identityResult, websiteEvidence, deps.identity.name);
  const candidate = identity.candidate;
  const website = assessWebsite(n, inspectedUrl, urlSource, websiteResult, candidate);
  const contact = assessContacts(n, candidate, websiteEvidence);
  const address = assessAddress(n, candidate, websiteEvidence);

  const registryActivityText = candidate ? [candidate.industry, ...candidate.activities].filter(Boolean).join(". ") || null : null;
  const websiteActivityText = websiteEvidence?.reachable ? `${websiteEvidence.title ?? ""} ${websiteEvidence.textExcerpt}` : null;
  const activity = assessActivity(n.requiredProductOrService, registryActivityText, websiteActivityText);

  // Sanctions
  const listsChecked: string[] = [], listsUnavailable: string[] = [];
  let sanctionsMatches: SanctionsMatch[] = [];
  const sanctionsSources: EvidenceSource[] = [];
  for (const { provider, results } of sanctionsResults) {
    if (results.every(r => r.status === "ok")) {
      listsChecked.push(provider.listName);
      for (const [i, r] of results.entries()) {
        sanctionsMatches.push(...findPotentialMatches(sanctionsNames[i]!, r.evidence?.candidates ?? []));
        sanctionsSources.push(...r.sources);
      }
    } else if (results.some(r => r.status === "unavailable")) listsUnavailable.push(provider.listName);
  }
  sanctionsMatches = dedupeMatches(sanctionsMatches);
  const sanctionsStatus: SanctionsStatus = sanctionsMatches.length > 0 ? "potential_match"
    : listsChecked.length > 0 ? "clear"
    : listsUnavailable.length > 0 ? "unavailable" : "not_checked";

  const publicRisk = assessPublicRisk([n.companyName, candidate?.companyName, candidate?.nameAr], publicRiskResult, {
    lookalikeDomain: contact.lookalikeDomain, crBelongsToOtherCompany: identity.crConflict === "cr_belongs_to_other_company"
  });

  // --- Flags -------------------------------------------------------------------------------------
  const flags: SupplierRiskFlag[] = [...identity.flags, ...website.flags, ...contact.flags, ...address.flags, ...publicRisk.flags];
  if (activity.status === "fail") flags.push({ code: "ACTIVITY_MISMATCH", severity: "medium", message: "The publicly identified business activity does not clearly match the requested product or service." });
  if (sanctionsMatches.length > 0) {
    const exact = sanctionsMatches.some(m => m.matchType === "exact_normalized_name");
    flags.push({ code: "POTENTIAL_SANCTIONS_MATCH", severity: exact ? "high" : "medium", message: "The supplier's name is similar to one or more names on a sanctions list. This is an automated potential match, not a confirmed listing — verify identifiers at the source list before proceeding." });
  }
  const unavailable = [
    identityResult.status === "unavailable" ? deps.identity.name : null,
    websiteResult?.status === "unavailable" ? deps.website.name : null,
    ...listsUnavailable,
    publicRiskResult.status === "unavailable" ? deps.publicRisk.name : null
  ].filter((v): v is string => Boolean(v));
  if (unavailable.length > 0) flags.push({ code: "SOURCE_UNAVAILABLE", severity: "low", message: `Some sources were unavailable during screening (${unavailable.join("; ")}); the result is based on partial evidence.` });

  // --- 5. Scoring ------------------------------------------------------------------------------
  const scored = scoreSupplier({
    identityLevel: identity.level, identityScore: identity.score, identityMatched: Boolean(candidate), crConflict: identity.crConflict,
    activityStatus: activity.status, activityRequested: Boolean(n.requiredProductOrService),
    websiteStatus: website.status, websiteEvidenced: websiteEvidence !== null && !websiteEvidence.fetchError,
    contactStatus: contact.status, addressStatus: address.status,
    sanctionsStatus, sanctionsMatchTypes: sanctionsMatches.map(m => m.matchType),
    publicRiskStatus: publicRisk.status, publicWebMentions: publicRisk.signals.filter(s => s.type === "public_web_mention").length,
    flags
  });
  if (scored.risk === "insufficient_data") flags.push({ code: "INSUFFICIENT_PUBLIC_DATA", severity: "low", message: "Too little public evidence was available to screen this supplier reliably." });
  const suitability = procurementSuitability(scored.risk, identity.identityConfirmed, activity.status);

  const liveChecksPerformed = [
    websiteResult?.status === "ok" ? "website" : null,
    listsChecked.length > 0 ? "sanctions" : null,
    publicRiskResult.status === "ok" ? "public_web" : null
  ].filter((v): v is string => Boolean(v));

  const limitations = [...BASE_LIMITATIONS];
  if (candidate?.demoOnly || (!candidate && identityResult.evidence?.candidates.every(c => c.demoOnly) && (identityResult.evidence?.candidates.length ?? 0) > 0)) {
    limitations.push("Registry evidence for this result comes from Rafid's illustrative demo dataset, not real registry data (OMAN_BUSINESS_DATA_MODE is not configured for production data).");
  }
  if (!fetchUrl) limitations.push("No website was supplied or found in registry data; website checks were not performed (not treated as a risk).");
  else if (websiteResult?.status === "not_configured") limitations.push("Live website inspection is not enabled for this deployment (RISK_LIVE_CHECKS_ENABLED).");
  if (sanctionsStatus === "not_checked") limitations.push("Sanctions lists were not checked: no sanctions source is enabled for this deployment (RISK_LIVE_CHECKS_ENABLED / SUPPLIER_SANCTIONS_PROVIDERS).");
  if (publicRiskResult.status === "not_configured") limitations.push("Public-web risk screening is not enabled for this deployment (WEB_SEARCH_PROVIDER).");
  if (n.nameScript !== "en") limitations.push("Arabic company names are matched against registry Arabic names and a small Arabic-English glossary of common company-name words; proper names are not transliterated.");

  const sources = dedupeSources([
    ...identityResult.sources, ...(websiteResult?.sources ?? []), ...sanctionsSources, ...publicRiskResult.sources,
    ...publicRisk.signals.filter(s => s.sourceUrl).map(s => ({ type: "public_web" as const, name: s.sourceTitle ?? "Public web result", url: s.sourceUrl, checkedAt: publicRiskResult.sources[0]?.checkedAt ?? now.toISOString(), observedAt: null }))
  ]);

  return {
    supplier: {
      inputName: n.companyName, normalizedName: n.normalizedName,
      matchedName: candidate?.companyName ?? null, matchedNameAr: candidate?.nameAr ?? null, companyId: candidate?.companyId ?? null,
      crNumber: candidate?.registrationNumber ?? n.crNumber, crNumberSupplied: n.crNumber,
      country: "OM", identityMatch: identity.level
    },
    screeningResult: {
      risk: scored.risk, riskScore: scored.score, procurementSuitability: suitability,
      identityConfirmed: identity.identityConfirmed, activityMatch: activity.activityMatch,
      summary: summarize(scored.risk, suitability, identity.level, flags)
    },
    checks: {
      companyIdentity: { status: identity.status, confidence: identity.score, explanation: identity.explanation, corroborations: identity.corroborations },
      website: { status: website.status, explanation: website.explanation, url: website.inspectedUrl, urlSource: website.urlSource, signals: website.signals },
      businessActivity: { status: activity.status, explanation: activity.explanation, requiredCategories: activity.requiredCategories, supplierCategories: activity.supplierCategories },
      contactConsistency: { status: contact.status, explanation: contact.explanation },
      addressConsistency: { status: address.status, explanation: address.explanation },
      sanctions: {
        status: sanctionsStatus, matches: sanctionsMatches, listsChecked, listsUnavailable,
        explanation: sanctionsStatus === "potential_match" ? `${sanctionsMatches.length} potential name match(es) found — automated, unconfirmed; verify at the source list.`
          : sanctionsStatus === "clear" ? `No potential name match found on: ${listsChecked.join("; ")}.`
          : sanctionsStatus === "unavailable" ? "Sanctions sources could not be reached; sanctions were not screened."
          : "No sanctions source is enabled for this deployment; sanctions were not screened."
      },
      publicRisk: { status: publicRisk.status, signals: publicRisk.signals, explanation: publicRisk.explanation }
    },
    riskFlags: dedupeFlags(flags),
    riskModel: { score: scored.score, thresholds: { medium: RISK_THRESHOLDS.medium, high: RISK_THRESHOLDS.high }, components: scored.components },
    normalizedInput: {
      companyName: n.companyName, normalizedName: n.normalizedName, nameVariants: n.nameVariants, crNumber: n.crNumber,
      website: n.website, websiteDomain: n.websiteDomain,
      email: n.email, emailDomain: n.emailDomain, freeEmailProvider: n.freeEmailProvider,
      phone: n.phone ? { e164: n.phone.e164, isOman: n.phone.isOman, lineType: n.phone.lineType } : null,
      address: n.address, requiredProductOrService: n.requiredProductOrService
    },
    sources,
    dataCoverage: {
      registryMatch: Boolean(candidate),
      demoDataOnly: Boolean(candidate?.demoOnly),
      liveChecksPerformed,
      unavailableSources: unavailable
    },
    confidence: scored.confidence,
    limitations
  };
}

/** Evidence-cache key for a name: the registry's own normalized matching key, so "ABC Trading
 *  L.L.C." and "abc trading llc" share one cached evidence row (idempotency across spellings). */
function normalizeForKey(name: string): string {
  return normalizeCompanyName(name).normalized || name.trim().replace(/\s+/g, " ").toUpperCase();
}

function dedupeMatches(matches: SanctionsMatch[]): SanctionsMatch[] {
  const byKey = new Map<string, SanctionsMatch>();
  for (const m of matches) {
    const key = `${m.source}|${m.name.toUpperCase()}`;
    const existing = byKey.get(key);
    if (!existing || m.matchScore > existing.matchScore) byKey.set(key, m);
  }
  return [...byKey.values()].sort((a, b) => b.matchScore - a.matchScore || a.name.localeCompare(b.name)).slice(0, 10);
}

function dedupeFlags(flags: SupplierRiskFlag[]): SupplierRiskFlag[] {
  const rank = { low: 0, medium: 1, high: 2 } as const;
  const byCode = new Map<string, SupplierRiskFlag>();
  for (const f of flags) {
    const existing = byCode.get(f.code);
    if (!existing || rank[f.severity] > rank[existing.severity]) byCode.set(f.code, f);
  }
  return [...byCode.values()].sort((a, b) => rank[b.severity] - rank[a.severity] || a.code.localeCompare(b.code));
}

function summarize(risk: string, suitability: string, identity: string, flags: readonly SupplierRiskFlag[]): string {
  const top = flags.filter(f => f.severity !== "low").map(f => f.code);
  const lead: Record<string, string> = {
    appears_suitable: "Supplier appears suitable to receive an RFQ based on the public evidence found",
    review_recommended: "Manual review is recommended before contacting this supplier",
    insufficient_information: "There is not enough public evidence to screen this supplier",
    potential_risk: "Potential risk indicators were found; resolve them before procurement contact"
  };
  return `${lead[suitability]} (risk: ${risk}; identity evidence: ${identity})${top.length ? `. Key flags: ${[...new Set(top)].join(", ")}` : ""}.`;
}

