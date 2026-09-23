import type { Resolution } from "../company-reputation/companyResolver.js";
import type { AdverseMediaSection } from "../company-reputation/analyzers/adverseMediaAnalyzer.js";
import type { CustomerSentimentSection } from "../company-reputation/analyzers/customerSentimentAnalyzer.js";
import type { SanctionsSection } from "../company-reputation/analyzers/sanctionsAnalyzer.js";
import { domainConsistentWithName } from "../company-reputation/companyResolver.js";
import { foldForMatch, registrableDomain } from "../company-reputation/normalization.js";
import type { NormalizedEvidence } from "../company-reputation/types.js";
import { AGE_THRESHOLDS, SIGNAL_RULES, type SignalCode } from "./config.js";
import { ageDays, isRestrictedPartyList, round2 } from "./evidence.js";
import type { BusinessRiskQuery, CoverageLevel, RiskCategory, RiskSeverity, RiskSignal, RoleRun } from "./types.js";

/**
 * Risk-signal detection: six independent, deterministic detectors (one per risk category) that turn
 * NORMALIZED evidence and the reused analyzers' structured conclusions into explicit RiskSignals.
 * Detectors never fetch, never score and never see provider-specific payloads. Each also reports its
 * category's data coverage, which drives confidence (not the score).
 */

export interface DetectionContext {
  query: BusinessRiskQuery;
  asOf: Date;
  resolution: Resolution;
  identityVerified: boolean;
  /** Jurisdiction registry (not the global LEI index) checked successfully and returned no match. */
  registryNotFound: boolean;
  registrationNumberNotFound: boolean;
  jurisdictionRegistryChecked: boolean;
  /** Matched registry record plus corroborating records for the same entity. */
  matchedRecords: readonly NormalizedEvidence[];
  filings: readonly NormalizedEvidence[];
  website: NormalizedEvidence | null;
  domain: NormalizedEvidence | null;
  threat: NormalizedEvidence | null;
  sanctions: SanctionsSection;
  adverse: AdverseMediaSection;
  customer: CustomerSentimentSection;
  runs: readonly RoleRun[];
  highRiskJurisdictions: ReadonlySet<string>;
  freshness: ReadonlyMap<string, number>;
  /** Registers a "checked, nothing found" lookup_result evidence item and returns its id. */
  lookup: (run: RoleRun, claim: string) => string;
}

export interface CategoryDetection { category: RiskCategory; signals: RiskSignal[]; coverage: CoverageLevel }

const checked = (r: RoleRun) => r.status === "ok" || r.status === "stale_cache";

export function makeSignal(code: SignalCode, confidence: number, evidenceIds: readonly string[], description: string,
  overrides: { severity?: RiskSeverity; title?: string; factStatus?: RiskSignal["factStatus"] } = {}): RiskSignal {
  const rule = SIGNAL_RULES[code];
  return {
    code, category: rule.category, polarity: rule.polarity, severity: overrides.severity ?? rule.severity, weight: rule.weight,
    confidence: round2(Math.max(0, Math.min(1, confidence))), title: overrides.title ?? rule.title, description,
    evidenceIds: [...new Set(evidenceIds)].sort(), factStatus: overrides.factStatus ?? "observed",
    requiresVerification: "requiresVerification" in rule ? Boolean(rule.requiresVerification) : false
  };
}

function str(v: unknown): string | null { return typeof v === "string" && v.length > 0 ? v : null; }
function strs(v: unknown): string[] { return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []; }
const ids = (items: readonly NormalizedEvidence[]) => items.map(e => e.id);

function jurisdictionRecord(ctx: DetectionContext): NormalizedEvidence | null {
  return ctx.matchedRecords.find(e => e.metadata.recordKind === "company_registry") ?? ctx.matchedRecords[0] ?? null;
}

// ---------------------------------------------------------------------------------------------
// Corporate
// ---------------------------------------------------------------------------------------------

export function detectCorporate(ctx: DetectionContext): CategoryDetection {
  const signals: RiskSignal[] = [];
  const records = ctx.matchedRecords;
  const primary = jurisdictionRecord(ctx);
  const conf = ctx.resolution.confidence;
  const registryRuns = ctx.runs.filter(r => r.role === "corporate");

  if (primary) {
    const statuses = records.map(e => str(e.metadata.status) ?? "unknown");
    const detail = [...records, ...ctx.filings].map(e => str(e.metadata.statusDetail)).find(Boolean) ?? null;
    if (statuses.includes("dissolved")) {
      const src = records.filter(e => e.metadata.status === "dissolved");
      signals.push(makeSignal("COMPANY_DISSOLVED", conf, ids(src), `The registry reports the company as dissolved/removed (${src.map(e => `${e.metadata.registryName}: ${str(e.metadata.rawStatus) ?? "dissolved"}`).join("; ")}). A dissolved company cannot validly contract.`));
    } else if (statuses.includes("inactive")) {
      const src = records.filter(e => e.metadata.status === "inactive");
      signals.push(makeSignal("COMPANY_INACTIVE", conf, ids(src), `The registry reports the registration as inactive (${src.map(e => str(e.metadata.rawStatus) ?? "inactive").join("; ")}).`));
    } else if (statuses.includes("active")) {
      signals.push(makeSignal("ACTIVE_REGISTRATION", conf, ids(records.filter(e => e.metadata.status === "active")), `The company appears with an active registration in ${[...new Set(records.map(e => str(e.metadata.registryName) ?? e.sourceName))].join(" and ")}.`));
    }
    if (detail && /strike|removal|struck/i.test(detail)) {
      signals.push(makeSignal("STRIKE_OFF_PENDING", conf, ids([...records, ...ctx.filings].filter(e => str(e.metadata.statusDetail))), `Registry status detail: "${detail}".`));
    }
    const incorporated = records.map(e => str(e.metadata.incorporationDate)).filter((d): d is string => Boolean(d)).sort()[0] ?? null;
    const age = ageDays(incorporated, ctx.asOf);
    if (age !== null) {
      const src = ids(records.filter(e => str(e.metadata.incorporationDate)));
      if (age < AGE_THRESHOLDS.veryRecentIncorporationDays) signals.push(makeSignal("VERY_RECENTLY_INCORPORATED", conf, src, `Incorporated ${incorporated} (${age} days before the evaluation date).`));
      else if (age < AGE_THRESHOLDS.recentIncorporationDays) signals.push(makeSignal("RECENTLY_INCORPORATED", conf, src, `Incorporated ${incorporated} (${age} days before the evaluation date).`));
      else if (age >= AGE_THRESHOLDS.establishedBusinessYears * 365) signals.push(makeSignal("ESTABLISHED_BUSINESS", conf, src, `Incorporated ${incorporated} (${Math.floor(age / 365)} years before the evaluation date).`));
    }
    const nameChanges = Math.max(0, ...records.map(e => typeof e.metadata.previousNameCount === "number" ? e.metadata.previousNameCount
      : e.metadata.recordKind === "company_registry" && /companies house/i.test(String(e.metadata.registryName ?? "")) ? strs(e.metadata.otherNames).length : 0));
    if (nameChanges >= AGE_THRESHOLDS.repeatedNameChanges) {
      signals.push(makeSignal("REPEATED_NAME_CHANGES", conf, ids(records), `The registry lists ${nameChanges} previous company names.`));
    }
    if (ctx.resolution.corroboratingRecords.length > 0) {
      signals.push(makeSignal("MULTI_REGISTRY_CORROBORATION", conf, ids(records), `The same legal entity appears in ${records.length} official registries with matching identifiers.`));
    }
    const lapsed = records.filter(e => /lapsed/i.test(str(e.metadata.leiRegistrationStatus) ?? ""));
    if (lapsed.length) signals.push(makeSignal("LEI_LAPSED", conf, ids(lapsed), "The entity's LEI registration has lapsed (reference data not renewed)."));
    const best = ctx.resolution.matched;
    if (best?.conflicts.includes("identifier_matches_differently_named_entity")) {
      signals.push(makeSignal("IDENTIFIER_NAME_MISMATCH", 0.9, [best.evidenceId], `The supplied identifier matches "${best.legalName}", whose name differs materially from "${ctx.query.companyName}".`));
    }
    if (best?.conflicts.includes("city_differs")) {
      signals.push(makeSignal("REGISTRY_CITY_MISMATCH", conf, [best.evidenceId], `Registered city "${best.city}" differs from the supplied city "${ctx.query.city}".`));
    }
  }

  if (ctx.registrationNumberNotFound || ctx.registryNotFound) {
    const run = registryRuns.find(r => checked(r) && r.providerId !== "registry_gleif") ?? registryRuns.find(checked)!;
    const code: SignalCode = ctx.registrationNumberNotFound ? "REGISTRATION_NUMBER_NOT_FOUND" : "IDENTITY_NOT_FOUND_IN_REGISTRY";
    const claim = ctx.registrationNumberNotFound
      ? `${run.providerName} returned no company for registration number ${ctx.query.registrationNumber}.`
      : `${run.providerName} returned no company matching "${ctx.query.companyName}"${ctx.query.country ? ` in ${ctx.query.country.name}` : ""}.`;
    signals.push(makeSignal(code, 0.9, [ctx.lookup(run, claim)], `${claim} The business shows other signs of existence, so this is reported as an unverified identity rather than a non-existent company.`));
  }

  const country = ctx.query.country?.code ?? ctx.resolution.matched?.country ?? null;
  if (country && ctx.highRiskJurisdictions.has(country)) {
    const src = primary ? [primary.id] : [];
    signals.push(makeSignal("HIGH_RISK_JURISDICTION", primary ? conf : 0.8, src, `Country ${country} is on the configured high-risk jurisdiction list (FATF call for action).`));
  }

  // Shell-company indicators: a documented composite — a young company whose supplied web presence
  // is absent in substance (parked, unreachable, placeholder) or brand new.
  const incorporated = records.map(e => str(e.metadata.incorporationDate)).filter((d): d is string => Boolean(d)).sort()[0] ?? null;
  const age = ageDays(incorporated, ctx.asOf);
  const w = ctx.website?.metadata;
  const hollowSite = Boolean(w && (w.parkedIndicators === true || w.reachable === false || w.underConstruction === true));
  const domainAge = ageDays(str(ctx.domain?.metadata.registeredAt), ctx.asOf);
  if (age !== null && age < AGE_THRESHOLDS.shellIndicatorMaxAgeDays && (hollowSite || (domainAge !== null && domainAge < AGE_THRESHOLDS.newDomainDays))) {
    signals.push(makeSignal("SHELL_COMPANY_INDICATORS", 0.7, [...ids(records), ...(ctx.website ? [ctx.website.id] : []), ...(ctx.domain ? [ctx.domain.id] : [])],
      `Incorporated ${incorporated} and the supplied web presence is ${hollowSite ? "parked, unreachable or a placeholder" : "a domain registered within the last 90 days"}. These are common shell-company indicators, not proof.`));
  }

  const jurisdictionMatched = ctx.matchedRecords.some(e => e.providerId !== "registry_gleif");
  const coverage: CoverageLevel = primary && ctx.resolution.status === "resolved" && jurisdictionMatched ? "high"
    : primary ? "medium"
    : registryRuns.some(checked) || ctx.website || ctx.domain ? "low" : "none";
  return { category: "corporate", signals, coverage };
}

// ---------------------------------------------------------------------------------------------
// Financial
// ---------------------------------------------------------------------------------------------

const INSOLVENCY_RAW = /liquidation|administration|receivership|insolvency|voluntary-arrangement|bankrupt/i;

export function detectFinancial(ctx: DetectionContext): CategoryDetection {
  const signals: RiskSignal[] = [];
  const conf = ctx.resolution.confidence;
  const facts = [...ctx.matchedRecords, ...ctx.filings];
  const inProceedings = facts.filter(e => e.metadata.status === "liquidation" || INSOLVENCY_RAW.test(str(e.metadata.rawStatus) ?? ""));
  if (inProceedings.length) {
    signals.push(makeSignal("INSOLVENCY_PROCEEDINGS", conf, ids(inProceedings), `The registry reports status "${str(inProceedings[0]!.metadata.rawStatus) ?? "liquidation"}" (insolvency, liquidation or administration).`));
  } else {
    const history = facts.filter(e => e.metadata.hasInsolvencyHistory === true);
    if (history.length) signals.push(makeSignal("INSOLVENCY_HISTORY", conf, ids(history), "The registry reports past insolvency history for this company."));
  }
  const accounts = facts.filter(e => typeof e.metadata.accountsOverdue === "boolean");
  const confirmations = facts.filter(e => typeof e.metadata.confirmationStatementOverdue === "boolean");
  const accountsOverdue = accounts.filter(e => e.metadata.accountsOverdue === true);
  const confirmationOverdue = confirmations.filter(e => e.metadata.confirmationStatementOverdue === true);
  if (accountsOverdue.length) signals.push(makeSignal("ACCOUNTS_OVERDUE", conf, ids(accountsOverdue), `Statutory accounts are overdue${str(accountsOverdue[0]!.metadata.accountsNextDue) ? ` (were due ${accountsOverdue[0]!.metadata.accountsNextDue})` : ""}.`));
  if (confirmationOverdue.length) signals.push(makeSignal("CONFIRMATION_STATEMENT_OVERDUE", conf, ids(confirmationOverdue), "The annual confirmation statement is overdue."));
  if (accounts.length && confirmations.length && !accountsOverdue.length && !confirmationOverdue.length && !inProceedings.length) {
    const last = accounts.map(e => str(e.metadata.lastAccountsMadeUpTo)).find(Boolean);
    signals.push(makeSignal("FILINGS_UP_TO_DATE", conf, ids([...accounts, ...confirmations]), `Accounts and confirmation statement are not overdue${last ? `; last accounts made up to ${last}` : ""}.`));
  }
  for (const item of ctx.adverse.items.filter(i => i.category === "insolvency")) {
    const confidence = item.relevance * Math.max(...item.evidenceIds.map(id => ctx.freshness.get(id) ?? 1)) * (item.sources.some(s => s.authority !== "forum_social_or_user_generated") ? 1 : 0.4);
    signals.push(makeSignal("REPORTED_INSOLVENCY", confidence, item.evidenceIds, `Financial distress reported — ${item.stageDescription}: "${item.title ?? "untitled"}" (${item.coverageCount} item(s)).`,
      { severity: item.severity, factStatus: item.established ? "reported" : "alleged" }));
  }
  const filingDetail = accounts.length > 0 || confirmations.length > 0;
  const statusKnown = ctx.matchedRecords.some(e => (str(e.metadata.status) ?? "unknown") !== "unknown" || typeof e.metadata.hasInsolvencyHistory === "boolean");
  if (!filingDetail) {
    const registries = [...new Set(ctx.matchedRecords.map(e => str(e.metadata.registryName) ?? e.sourceName))];
    signals.push(makeSignal("LIMITED_FINANCIAL_HISTORY", 1, ids(ctx.matchedRecords),
      `No reliable public financial statements or statutory-filing status were available${registries.length ? ` (registry data: ${registries.join(", ")})` : ""}. Informational: this lowers confidence and coverage, not the score.`));
  }
  const newsChecked = ctx.runs.some(r => r.role === "news" && r.category === "news" && checked(r));
  const coverage: CoverageLevel = filingDetail ? "high" : statusKnown && ctx.identityVerified ? "medium" : newsChecked || statusKnown ? "low" : "none";
  return { category: "financial", signals, coverage };
}

// ---------------------------------------------------------------------------------------------
// Compliance
// ---------------------------------------------------------------------------------------------

const COMPLIANCE_ADVERSE = new Set(["sanctions", "regulatory", "corruption"]);

export function detectCompliance(ctx: DetectionContext): CategoryDetection {
  const signals: RiskSignal[] = [];
  const s = ctx.sanctions;
  for (const restricted of [false, true]) {
    const matches = s.matches.filter(m => isRestrictedPartyList(m.list) === restricted);
    const high = matches.filter(m => m.confidence === "high");
    const possible = matches.filter(m => m.confidence === "possible");
    const label = restricted ? "export-control / debarment" : "sanctions";
    if (high.length) {
      signals.push(makeSignal(restricted ? "RESTRICTED_PARTY_HIGH_CONFIDENCE_MATCH" : "SANCTIONS_HIGH_CONFIDENCE_MATCH", Math.max(...high.map(m => m.matchScore)), high.map(m => m.evidenceId),
        `High-confidence potential ${label} list match: ${high.map(m => `"${m.listedName}"${m.matchedAlias ? ` (alias "${m.matchedAlias}")` : ""} on ${m.list}, name score ${m.matchScore.toFixed(2)}, corroborated by ${m.corroboratingIdentifiers.join(" and ")}`).join("; ")}. Verify at the source list before any transaction; this is not a legal determination.`,
        { factStatus: "reported" }));
    }
    if (possible.length) {
      // Match strength: an exact normalized name with nothing contradicting it is a stronger (still
      // unconfirmed) candidate than a fuzzy one or one whose listed countries differ.
      const strength = Math.max(...possible.map(m => (m.matchType === "exact_normalized_name" && m.contradictions.length === 0 ? 0.6 : 0.3) * m.matchScore));
      signals.push(makeSignal(restricted ? "RESTRICTED_PARTY_POSSIBLE_MATCH" : "SANCTIONS_POSSIBLE_MATCH", strength, possible.map(m => m.evidenceId),
        `Possible ${label} list name match (NOT confirmed): ${possible.slice(0, 3).map(m => `"${m.listedName}" on ${m.list} (${m.matchType === "exact_normalized_name" ? "exact normalized name" : "fuzzy"}, similarity ${m.matchScore.toFixed(2)}${m.contradictions.length ? `, contradicted by ${m.contradictions.join(", ")}` : ""})`).join("; ")}. A similar name alone does not establish identity.`,
        { factStatus: "alleged" }));
    }
  }
  const listRuns = ctx.runs.filter(r => r.role === "sanctions" && checked(r));
  if (s.matches.length === 0 && listRuns.length > 0) {
    const lookupIds = listRuns.map(r => ctx.lookup(r, `Name screening of ${[ctx.query.companyName, ctx.query.legalName, ...(ctx.query.aliases ?? [])].filter(Boolean).map(n => `"${n}"`).join(", ")} against ${r.providerName} returned no match at or above the conservative similarity threshold.`));
    signals.push(makeSignal("NO_SANCTIONS_MATCH", 1, lookupIds, `No sanctions or restricted-party list match in: ${listRuns.map(r => r.providerName).join("; ")}. Lists not checked are not covered.`));
  }
  for (const item of ctx.adverse.items.filter(i => COMPLIANCE_ADVERSE.has(i.category))) {
    const freshness = Math.max(...item.evidenceIds.map(id => ctx.freshness.get(id) ?? 1));
    const confidence = item.relevance * freshness * (item.sources.some(x => x.authority === "official_or_regulatory") ? 1 : item.sources.some(x => x.authority === "major_news_or_authoritative") ? 0.85 : 0.6);
    signals.push(makeSignal(item.established ? "REGULATORY_ENFORCEMENT" : "REGULATORY_CONCERN", confidence, item.evidenceIds,
      `${item.category.replace(/_/g, " ")} — ${item.stageDescription}: "${item.title ?? "untitled"}" (${item.sources.map(x => x.sourceName).slice(0, 3).join(", ")}).`,
      { severity: item.severity, factStatus: item.established ? "reported" : "alleged" }));
  }
  const regulatoryChecked = ctx.runs.some(r => (r.role === "regulatory" || (r.role === "news" && r.category === "news")) && checked(r));
  const coverage: CoverageLevel = listRuns.length >= 2 && regulatoryChecked ? "high" : listRuns.length >= 1 ? "medium" : regulatoryChecked ? "low" : "none";
  return { category: "compliance", signals, coverage };
}

// ---------------------------------------------------------------------------------------------
// Reputation
// ---------------------------------------------------------------------------------------------

export function detectReputation(ctx: DetectionContext): CategoryDetection {
  const signals: RiskSignal[] = [];
  const items = ctx.adverse.items.filter(i => i.category !== "insolvency" && !COMPLIANCE_ADVERSE.has(i.category));
  for (const item of items) {
    const freshness = Math.max(...item.evidenceIds.map(id => ctx.freshness.get(id) ?? 1));
    const authority = item.sources.some(x => x.authority === "official_or_regulatory") ? 1 : item.sources.some(x => x.authority === "major_news_or_authoritative") ? 0.85 : 0.55;
    signals.push(makeSignal(item.established ? "ADVERSE_MEDIA_ESTABLISHED" : "ADVERSE_MEDIA_ALLEGATION", item.relevance * freshness * authority, item.evidenceIds,
      `${item.category.replace(/_/g, " ")} — ${item.stageDescription}: "${item.title ?? "untitled"}" (${item.coverageCount} item(s) from ${item.sources.map(x => x.sourceName).slice(0, 3).join(", ")}${item.publishedAt ? `, first published ${item.publishedAt.slice(0, 10)}` : ""}).`,
      { severity: item.severity, factStatus: item.established ? "reported" : "alleged", title: `${SIGNAL_RULES[item.established ? "ADVERSE_MEDIA_ESTABLISHED" : "ADVERSE_MEDIA_ALLEGATION"].title}: ${item.category.replace(/_/g, " ")}` }));
  }
  const newsRuns = ctx.runs.filter(r => r.role === "news" && r.category === "news" && checked(r));
  if (newsRuns.length && ctx.adverse.items.length === 0) {
    signals.push(makeSignal("NO_ADVERSE_MEDIA_FOUND", 0.6, newsRuns.map(r => ctx.lookup(r, `News and web search for "${ctx.query.legalName ?? ctx.query.companyName}" found no adverse media attributable to this company.`)),
      "No adverse media attributable to this company was found in the checked news sources (absence of evidence is weak evidence)."));
  }
  const fresh = (evidenceIds: readonly string[]) => Math.max(...evidenceIds.map(id => ctx.freshness.get(id) ?? 1));
  for (const sig of ctx.customer.positiveSignals.filter(x => x.code === "FAVORABLE_AGGREGATE_RATING")) {
    signals.push(makeSignal("FAVORABLE_CUSTOMER_RATING", sig.strength * fresh(sig.evidenceIds), sig.evidenceIds, sig.message, { factStatus: "reported" }));
  }
  for (const sig of ctx.customer.negativeSignals) {
    const code: SignalCode = sig.code === "UNFAVORABLE_AGGREGATE_RATING" ? "UNFAVORABLE_CUSTOMER_RATING" : sig.code === "NEGATIVE_COMPLAINT_PATTERN" ? "COMPLAINT_PATTERN" : "CUSTOMER_COMPLAINT";
    signals.push(makeSignal(code, sig.strength * fresh(sig.evidenceIds), sig.evidenceIds, sig.message, { factStatus: "alleged" }));
  }
  const reviewsChecked = ctx.runs.some(r => r.role === "news" && r.category === "reviews" && checked(r));
  const independent = ctx.adverse.items.length + ctx.adverse.neutralMentions + ctx.customer.aggregateRatings.length;
  const coverage: CoverageLevel = newsRuns.length && reviewsChecked && independent >= 3 ? "high" : newsRuns.length ? "medium" : reviewsChecked ? "low" : "none";
  return { category: "reputation", signals, coverage };
}

// ---------------------------------------------------------------------------------------------
// Operational
// ---------------------------------------------------------------------------------------------

function tokens(s: string): string[] {
  return foldForMatch(s).split(" ").filter(t => t.length >= 2);
}

/** Address consistency (deterministic, conservative): the supplied address is consistent with the
 *  registered one when at least half of its distinctive words (≥ 3 letters, e.g. street name, town)
 *  appear in the registered address AND, when both contain numbers/postcode parts, they share one.
 *  Postcode fragments alone never establish consistency (UK inward codes such as "1AA" repeat). */
export function addressConsistent(supplied: string, registered: string): boolean {
  const a = tokens(supplied), b = new Set(tokens(registered));
  const words = a.filter(t => t.length >= 3 && !/\d/.test(t));
  const codesA = a.filter(t => /\d/.test(t)), codesB = [...b].filter(t => /\d/.test(t));
  const wordsOk = words.length === 0 || words.filter(t => b.has(t)).length / words.length >= 0.5;
  const codesOk = !codesA.length || !codesB.length || codesA.some(t => b.has(t));
  return wordsOk && codesOk;
}

export function detectOperational(ctx: DetectionContext): CategoryDetection {
  const signals: RiskSignal[] = [];
  const site = ctx.website;
  const m = site?.metadata;
  if (site && m) {
    if (m.reachable !== true) {
      signals.push(makeSignal("WEBSITE_UNREACHABLE", 0.9, [site.id], typeof m.urlRejected === "string"
        ? `The supplied website URL was rejected by safety checks (${m.urlRejected}); it could not be verified as a working business site.`
        : `The supplied website responded with HTTP ${m.httpStatus ?? "error"}.`));
    } else {
      if (m.parkedIndicators === true) signals.push(makeSignal("WEBSITE_PARKED", 0.9, [site.id], "The supplied website shows parked / domain-for-sale indicators rather than a business site."));
      else if (m.underConstruction === true) signals.push(makeSignal("WEBSITE_UNDER_CONSTRUCTION", 0.8, [site.id], "The supplied website is a placeholder / under construction."));
      if (ctx.resolution.websiteCorroborates) signals.push(makeSignal("VERIFIED_OPERATING_PRESENCE", 0.8, [site.id], "The supplied website is reachable and names the company."));
      const hasContact = m.hasContactLink === true || m.hasPhone === true || strs(m.emailDomains).length > 0;
      if (hasContact) signals.push(makeSignal("CONTACT_INFORMATION_PRESENT", 0.8, [site.id], `The website publishes contact information (${[m.hasContactLink === true ? "contact page" : null, m.hasPhone === true ? "phone number" : null, strs(m.emailDomains).length ? "email address" : null].filter(Boolean).join(", ")}).`));
      else if (m.parkedIndicators !== true) signals.push(makeSignal("NO_CONTACT_INFORMATION", 0.7, [site.id], "The reachable website publishes no contact page, phone number or email address."));
      if (ctx.query.industry) {
        const text = foldForMatch(`${site.title ?? ""} ${str(m.textExcerpt) ?? ""}`);
        const keywords = tokens(ctx.query.industry).filter(t => t.length >= 4).map(t => t.slice(0, Math.max(4, t.length - 2)));
        if (keywords.length) {
          if (keywords.some(k => text.includes(k))) signals.push(makeSignal("BUSINESS_ACTIVITY_CONSISTENT", 0.6, [site.id], `The website content is consistent with the stated industry "${ctx.query.industry}".`));
          else signals.push(makeSignal("BUSINESS_ACTIVITY_NOT_EVIDENT", 1, [site.id], `The stated industry "${ctx.query.industry}" is not evident from the website's homepage (informational only).`));
        }
      }
    }
  }
  if (ctx.query.address) {
    const withAddress = ctx.matchedRecords.filter(e => str(e.metadata.registeredAddress));
    if (withAddress.length) {
      const consistent = withAddress.some(e => addressConsistent(ctx.query.address!, String(e.metadata.registeredAddress)));
      if (!consistent) signals.push(makeSignal("ADDRESS_MISMATCH", ctx.resolution.confidence, ids(withAddress), `The supplied address does not match the registered address on record (${withAddress.map(e => `${e.metadata.registryName}: ${e.metadata.registeredAddress}`).join("; ")}).`));
    }
  }
  const siteChecked = ctx.runs.some(r => r.providerId === "website_homepage" && checked(r));
  const coverage: CoverageLevel = siteChecked && m?.reachable === true && ctx.matchedRecords.length > 0 ? "high"
    : siteChecked ? "medium" : ctx.matchedRecords.length > 0 ? "low" : "none";
  return { category: "operational", signals, coverage };
}

// ---------------------------------------------------------------------------------------------
// Digital
// ---------------------------------------------------------------------------------------------

const FREE_MAIL = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mail|gmx|proton|protonmail|yandex|zoho|qq|163|126)\./i;
const HOLD = /hold|redemption|pending ?delete/i;

export function detectDigital(ctx: DetectionContext): CategoryDetection {
  const signals: RiskSignal[] = [];
  const d = ctx.domain;
  if (d) {
    const dm = d.metadata;
    if (dm.found === false) {
      signals.push(makeSignal("DOMAIN_NOT_REGISTERED", 0.9, [d.id], `The domain registry (RDAP) has no registration record for ${dm.domain ?? ctx.query.domain}.`));
    } else {
      const age = ageDays(str(dm.registeredAt), ctx.asOf);
      if (age !== null) {
        if (age < AGE_THRESHOLDS.newDomainDays) signals.push(makeSignal("DOMAIN_NEWLY_REGISTERED", 1, [d.id], `Domain registered ${String(dm.registeredAt).slice(0, 10)} (${age} days before the evaluation date).`));
        else if (age < AGE_THRESHOLDS.recentDomainDays) signals.push(makeSignal("DOMAIN_RECENTLY_REGISTERED", 1, [d.id], `Domain registered ${String(dm.registeredAt).slice(0, 10)} (${age} days before the evaluation date).`));
        else if (age >= AGE_THRESHOLDS.establishedDomainYears * 365) signals.push(makeSignal("ESTABLISHED_DOMAIN", 1, [d.id], `Domain registered ${String(dm.registeredAt).slice(0, 10)} (${Math.floor(age / 365)} years before the evaluation date).`));
      }
      const expiresAt = str(dm.expiresAt);
      if (expiresAt) {
        const remaining = Math.floor((Date.parse(expiresAt) - ctx.asOf.getTime()) / 86_400_000);
        if (Number.isFinite(remaining) && remaining <= AGE_THRESHOLDS.domainExpirySoonDays) signals.push(makeSignal("DOMAIN_EXPIRING_SOON", 1, [d.id], `Domain registration expires ${expiresAt.slice(0, 10)} (${remaining} days after the evaluation date).`));
      }
      const holds = strs(dm.statuses).filter(x => HOLD.test(x));
      if (holds.length) signals.push(makeSignal("DOMAIN_HOLD_STATUS", 1, [d.id], `Domain status: ${holds.join(", ")}.`));
    }
  }
  const site = ctx.website;
  const m = site?.metadata;
  if (site && m && m.reachable === true) {
    if (m.https === false) signals.push(makeSignal("NO_HTTPS", 1, [site.id], "The website is not served over HTTPS."));
    if (m.redirectedToOtherDomain === true) signals.push(makeSignal("REDIRECTS_TO_OTHER_DOMAIN", 0.9, [site.id], `The supplied website redirects to a different domain (${m.finalDomain}).`));
    const emailDomains = strs(m.emailDomains);
    const free = emailDomains.filter(x => FREE_MAIL.test(x));
    if (free.length) signals.push(makeSignal("FREE_EMAIL_ON_WEBSITE", 0.8, [site.id], `The website publishes free webmail addresses (${free.join(", ")}) instead of a company domain.`));
    const company = ctx.query.domain ? registrableDomain(ctx.query.domain) : null;
    const corporate = emailDomains.filter(x => !FREE_MAIL.test(x));
    if (company && corporate.length && !corporate.some(x => registrableDomain(x) === company)) {
      signals.push(makeSignal("EMAIL_DOMAIN_MISMATCH", 0.7, [site.id], `Published email domains (${corporate.join(", ")}) differ from the website's domain (${company}).`));
    }
  }
  if ((d || site) && ctx.query.domain) {
    const src = [...(d ? [d.id] : []), ...(site ? [site.id] : [])];
    if (domainConsistentWithName(ctx.query.domain, ctx.query.legalName ?? ctx.query.companyName) || ctx.query.knownAliases.some(a => domainConsistentWithName(ctx.query.domain, a))) {
      signals.push(makeSignal("DOMAIN_NAME_CONSISTENT", 0.6, src, `The domain ${ctx.query.domain} is consistent with the company name.`));
    } else {
      signals.push(makeSignal("DOMAIN_NAME_INCONSISTENT", 0.6, src, `The domain ${ctx.query.domain} does not resemble the company name (brand domains can legitimately differ).`));
    }
  }
  const t = ctx.threat;
  if (t) {
    if (t.metadata.listed === true) signals.push(makeSignal("MALWARE_OR_PHISHING_LISTED", 1, [t.id], `Google Safe Browsing lists the domain for: ${strs(t.metadata.threatTypes).join(", ")}.`));
    else signals.push(makeSignal("NO_THREAT_LISTING", 1, [t.id], "Not listed by Google Safe Browsing for malware, social engineering or unwanted software at retrieval time."));
  }
  const siteChecked = ctx.runs.some(r => r.providerId === "website_homepage" && checked(r));
  const domainChecked = ctx.runs.some(r => r.providerId === "domain_rdap" && checked(r));
  const coverage: CoverageLevel = siteChecked && domainChecked ? "high" : siteChecked || domainChecked ? "medium" : t ? "low" : "none";
  return { category: "digital", signals, coverage };
}
