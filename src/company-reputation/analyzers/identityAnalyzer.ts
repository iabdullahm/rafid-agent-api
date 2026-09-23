import { registrableDomain } from "../normalization.js";
import type { Signal } from "../types.js";
import { checked, runsFor, signal, type AnalysisContext } from "./context.js";

export interface IdentitySection {
  status: "consistent" | "partially_consistent" | "ambiguous" | "unresolved" | "conflicting" | "not_checked";
  signals: Signal[];
}

/** Identity/verification: is the requested company a real, identifiable legal entity, and do the
 *  identifiers the caller supplied agree with each other and with public records? */
export function analyzeIdentity(ctx: AnalysisContext): IdentitySection {
  const { resolution: r, query: q } = ctx;
  const signals: Signal[] = [];
  const matchedEvidence = r.matched ? ctx.registry.filter(e => e.id === r.matched!.evidenceId) : [];
  const registryRuns = runsFor(ctx, "registry").filter(checked);
  const jurisdictionRegistryChecked = registryRuns.some(run => run.providerId !== "registry_gleif");

  if (r.matched) {
    const byIdentifier = r.matched.matchedOn.includes("lei") || r.matched.matchedOn.includes("registration_number");
    signals.push(byIdentifier
      ? signal("REGISTRY_IDENTIFIER_MATCH", "identity", "positive", "high", `Supplied ${r.matched.matchedOn.includes("lei") ? "LEI" : "registration number"} matches an official registry record (${r.matched.registryName}: ${r.matched.legalName}).`, matchedEvidence, 1)
      : signal("REGISTRY_NAME_MATCH", "identity", "positive", r.status === "resolved" ? "medium" : "low", `A registry record with a matching name${r.matched.matchedOn.includes("country") ? " in the requested country" : ""} was found (${r.matched.registryName}: ${r.matched.legalName}); no registration number or LEI was available to confirm it is the same entity.`, matchedEvidence, r.status === "resolved" ? 0.8 : 0.5));
    if (r.corroboratingRecords.length > 0) {
      signals.push(signal("MULTIPLE_REGISTRIES_CONSISTENT", "identity", "positive", "medium", "The same legal entity appears consistently in more than one registry (shared LEI/registration number).", r.corroboratingRecords.map(c => c.evidenceId), 1, 1));
    }
  } else if (r.status === "ambiguous") {
    signals.push(signal("AMBIGUOUS_COMPANY_IDENTITY", "identity", "neutral", "info", `Several registry entities match this name (${r.candidates.slice(0, 3).map(c => `${c.legalName}${c.country ? `, ${c.country}` : ""}`).join("; ")}). Supply a registration number, LEI, country or website to disambiguate. No evidence was attributed to any of them.`, r.candidates.map(c => c.evidenceId), 0));
  } else if (r.status === "unresolved" && jurisdictionRegistryChecked) {
    const jr = registryRuns.filter(run => run.providerId !== "registry_gleif");
    signals.push(signal("NOT_FOUND_IN_JURISDICTION_REGISTRY", "identity", "negative", "medium", `No matching record was found in ${jr.map(j => j.providerName).join(", ")} for the supplied identifiers. This can also result from a name/format difference — verify directly.`, [], 0.6, 1));
  } else if (r.status === "unresolved") {
    signals.push(signal("NO_REGISTRY_MATCH_IN_GLOBAL_INDEX", "identity", "neutral", "info", "No matching legal-entity record was found in the registries checked. Many legitimate companies have no LEI; this is not a negative finding on its own.", [], 0));
  }

  for (const c of r.conflicts) {
    if (c === "identifier_matches_differently_named_entity") {
      signals.push(signal("IDENTIFIER_BELONGS_TO_DIFFERENT_NAME", "identity", "negative", "high", "The supplied registration number/LEI belongs to a registry entity with a materially different name. Confirm the counterparty's legal identity before proceeding.", r.candidates.filter(x => x.conflicts.includes(c)).map(x => x.evidenceId), 1, 1));
    }
  }

  if (r.websiteCorroborates && ctx.website) {
    signals.push(signal("WEBSITE_NAMES_COMPANY", "identity", "positive", "low", "The company's website names the company (self-published; weak corroboration).", [ctx.website], 0.5));
  }
  if (r.domainConsistentWithName && q.domain) {
    signals.push(signal("DOMAIN_CONSISTENT_WITH_NAME", "identity", "positive", "info", `The domain ${q.domain} is consistent with the company name.`, [], 0.3, 3));
  }
  if (ctx.website && ctx.website.metadata.redirectedToOtherDomain === true) {
    const finalDomain = typeof ctx.website.metadata.finalDomain === "string" ? registrableDomain(ctx.website.metadata.finalDomain) : "another domain";
    signals.push(signal("WEBSITE_REDIRECTS_TO_OTHER_DOMAIN", "identity", "negative", "low", `The supplied website redirects to a different registrable domain (${finalDomain}). This is common after rebrands/acquisitions; confirm the correct domain.`, [ctx.website], 0.5));
  }

  const status: IdentitySection["status"] =
    signals.some(s => s.code === "IDENTIFIER_BELONGS_TO_DIFFERENT_NAME") ? "conflicting"
    : r.status === "ambiguous" ? "ambiguous"
    : r.status === "resolved" ? "consistent"
    : r.status === "probable" ? "partially_consistent"
    : registryRuns.length === 0 && !ctx.website ? "not_checked" : "unresolved";
  return { status, signals };
}
