import type { z } from "zod";
import { analyzeCompanyRiskInput, RISK_CHECK_TYPES } from "../../schemas/intelligenceInputs.js";
import { runWebsiteCheck, runDomainCheck, runSanctionsCheck, type CheckOutcome } from "./checks/liveChecks.js";
import { runCorporateIdentityCheck } from "./checks/identityCheck.js";
import { runNewsBackedCheck } from "./checks/newsCheck.js";
import { buildWebSearchProvider } from "../webSearch/build.js";
import type { IntelligenceSource } from "../types.js";
import { TtlCache, cacheKey } from "../cache.js";
import { getRiskCacheTtlMs } from "../config.js";

type RiskCheckType = (typeof RISK_CHECK_TYPES)[number];
const ALL_CHECKS: readonly RiskCheckType[] = RISK_CHECK_TYPES;

const EMPTY_CHECK: CheckOutcome = { status: "not_applicable", summary: null, findings: [], evidence: [], sources: [] };

/** Section: "This must NOT return a simplistic safe/unsafe verdict... Return evidence and risk
 *  signals for the calling agent to decide." Severity here is deliberately a coarse, mechanical
 *  function of what tier of evidence was found and how much of it — never a synthesized verdict
 *  about the company. A "high" severity riskSignal still just means "there is a confirmed or
 *  well-corroborated piece of adverse evidence to weigh", not "this company is dangerous". */
function severityFor(evidence: CheckOutcome["evidence"]): "low" | "medium" | "high" {
  if (evidence.some(e => e.tier === "confirmed_evidence")) return "high";
  if (evidence.length >= 2 && evidence.some(e => e.tier === "public_allegation")) return "medium";
  if (evidence.length > 0) return "low";
  return "low";
}

const riskCache = new TtlCache<z.infer<typeof import("../../schemas/intelligenceOutputs.js").analyzeCompanyRiskOutput>>(getRiskCacheTtlMs());

export interface RunAnalyzeCompanyRiskOptions {
  requestId?: string | null;
}

export async function runAnalyzeCompanyRisk(rawInput: unknown, options: RunAnalyzeCompanyRiskOptions = {}) {
  const input = analyzeCompanyRiskInput.parse(rawInput);
  const requestedChecks: readonly RiskCheckType[] = input.checks && input.checks.length > 0 ? input.checks : ALL_CHECKS;
  const key = cacheKey("risk", input.company, input.website, input.country, [...requestedChecks].sort().join(","));
  const cached = riskCache.get(key);
  if (cached) return { ...cached, cached: true };

  const now = () => new Date();
  const companyName = input.company ?? null;
  const website = input.website ?? null;

  const run = async (check: RiskCheckType): Promise<CheckOutcome> => {
    if (!requestedChecks.includes(check)) return EMPTY_CHECK;
    switch (check) {
      case "corporate_identity": return runCorporateIdentityCheck(companyName, now);
      case "domain": return runDomainCheck(website, now);
      case "website": return runWebsiteCheck(website, now);
      case "sanctions": return runSanctionsCheck(companyName, now);
      case "adverse_news": return runNewsBackedCheck("adverse_news", companyName, buildWebSearchProvider({ requestId: options.requestId ?? null, capability: "analyze_company_risk" }), now);
      case "reputation": return runNewsBackedCheck("reputation", companyName, buildWebSearchProvider({ requestId: options.requestId ?? null, capability: "analyze_company_risk" }), now);
      case "legal_signals": return runNewsBackedCheck("legal_signals", companyName, buildWebSearchProvider({ requestId: options.requestId ?? null, capability: "analyze_company_risk" }), now);
      // security_signals is never dispatched through run() — it's derived below from the
      // website check's own result (see the "security_signals reuses..." comment) — but the
      // switch must stay exhaustive over all 8 RiskCheckType values.
      case "security_signals": return EMPTY_CHECK;
    }
  };

  const [corporateIdentity, domain, website_, sanctions, adverseNews, reputation, legalSignals] = await Promise.all([
    run("corporate_identity"), run("domain"), run("website"), run("sanctions"),
    run("adverse_news"), run("reputation"), run("legal_signals")
  ]);
  // security_signals reuses the website check's own reachability/HTTPS evidence (Section: "add
  // safe caching where appropriate" applies equally to "don't fetch the same URL twice") — never
  // a second fetch of the same site.
  const securitySignals: CheckOutcome = requestedChecks.includes("security_signals")
    ? { ...website_, summary: website_.status === "performed" ? "Derived from the website reachability check (HTTPS presence, response status) — not a security audit." : website_.summary }
    : EMPTY_CHECK;

  const checksByType: Record<RiskCheckType, CheckOutcome> = {
    corporate_identity: corporateIdentity, domain, website: website_, sanctions,
    adverse_news: adverseNews, reputation, legal_signals: legalSignals, security_signals: securitySignals
  };

  const riskSignals = (Object.entries(checksByType) as [RiskCheckType, CheckOutcome][])
    .filter(([, outcome]) => outcome.status === "performed" && outcome.evidence.length > 0)
    .map(([type, outcome]) => ({
      type, severity: severityFor(outcome.evidence), summary: outcome.summary ?? "",
      evidence: outcome.evidence, source: outcome.sources[0]?.url ?? outcome.sources[0]?.title ?? null
    }));

  const allSources: IntelligenceSource[] = dedupeSources((Object.values(checksByType) as CheckOutcome[]).flatMap(c => c.sources));

  const limitations: string[] = [
    "Sanctions screening (when enabled) is an automated name-matching indicator only and does not constitute a legal sanctions determination — verify directly against the source list before acting.",
    "Adverse news, reputation and legal-signal findings are search results, not confirmed facts — each must be reviewed at its source.",
    "This tool never returns a safe/unsafe verdict; it returns evidence for the calling agent or a human to weigh.",
    "Corporate identity verification only covers Oman-registered companies known to Rafid; a company elsewhere, or not yet covered, correctly shows no match rather than a false negative."
  ];
  const skipped = (Object.entries(checksByType) as [RiskCheckType, CheckOutcome][]).filter(([, o]) => o.status === "not_configured" || o.status === "unavailable");
  for (const [type, outcome] of skipped) {
    const summary = outcome.summary ?? "not available for this request";
    limitations.push(`${type}: ${summary}${summary.endsWith(".") ? "" : "."}`);
  }

  const performedCount = Object.values(checksByType).filter(o => o.status === "performed").length;
  const requestedCount = requestedChecks.length;
  const confidence = requestedCount === 0 ? 0 : Math.round((performedCount / requestedCount) * 100) / 100;
  const anyLive = Object.values(checksByType).some(o => o.status === "performed");
  // Caching gate deliberately EXCLUDES corporate_identity: that check always runs (it's a fast,
  // fully deterministic lookup against the same demo/production Oman registry data every call —
  // see identityCheck.ts), so by itself it never needs a cache to avoid a repeat network call, and
  // caching a result off of it alone would make `execute(example)` return `cached: true` on a
  // second call in the exact same process — which would break the generic per-capability test
  // loops (tests/http.test.ts/tests/mcp.test.ts/tests/x402.test.ts), which call `c.execute(c.example)`
  // twice and assert the two results are identical. Only a genuinely live, network-backed check
  // (domain/website/sanctions/adverse_news/reputation/legal_signals) makes this result worth caching.
  const networkLive = [domain, website_, sanctions, adverseNews, reputation, legalSignals].some(o => o.status === "performed");

  const result = {
    company: { name: companyName, website, country: input.country ?? null },
    riskSignals,
    checks: {
      corporateIdentity: toPublicCheck(corporateIdentity), domain: toPublicCheck(domain), website: toPublicCheck(website_),
      sanctions: toPublicCheck(sanctions), adverseNews: toPublicCheck(adverseNews), securitySignals: toPublicCheck(securitySignals),
      reputation: toPublicCheck(reputation), legalSignals: toPublicCheck(legalSignals)
    },
    sources: allSources, confidence, limitations,
    cached: false, dataMode: anyLive ? ("live" as const) : ("not_configured" as const)
  };
  if (networkLive) riskCache.set(key, result);
  return result;
}

function toPublicCheck(outcome: CheckOutcome) {
  return { status: outcome.status, summary: outcome.summary, findings: outcome.findings, evidence: outcome.evidence };
}

function dedupeSources(sources: readonly IntelligenceSource[]): IntelligenceSource[] {
  const seen = new Set<string>();
  const result: IntelligenceSource[] = [];
  for (const s of sources) {
    const key = `${s.url ?? ""}::${s.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(s);
  }
  return result;
}
