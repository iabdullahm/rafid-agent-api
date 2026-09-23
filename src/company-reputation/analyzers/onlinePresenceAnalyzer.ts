import type { Signal } from "../types.js";
import { checked, runsFor, signal, type AnalysisContext } from "./context.js";

export interface OnlinePresenceSection {
  status: "not_checked" | "established" | "limited" | "inconsistent" | "unreachable";
  signals: Signal[];
}

/** Online presence: website availability/completeness plus independent (non-adverse, relevant)
 *  third-party coverage. Conservative: a missing website is a coverage gap, not a risk. */
export function analyzeOnlinePresence(ctx: AnalysisContext): OnlinePresenceSection {
  const signals: Signal[] = [];
  const w = ctx.website;
  const websiteRun = runsFor(ctx, "website")[0];
  if (w) {
    if (w.metadata.urlRejected) {
      signals.push(signal("WEBSITE_URL_REJECTED", "onlinePresence", "neutral", "info", w.summary ?? "The supplied website URL was rejected by URL safety checks.", [w], 0));
    } else if (w.metadata.reachable === true) {
      if (w.metadata.parkedIndicators === true) signals.push(signal("WEBSITE_PARKED_OR_FOR_SALE", "onlinePresence", "negative", "medium", "The website appears to be a parked / for-sale domain page rather than an operating company site.", [w], 0.8));
      else if (w.metadata.underConstruction === true || Number(w.metadata.contentLength ?? 0) < 300) signals.push(signal("WEBSITE_INCOMPLETE", "onlinePresence", "negative", "low", "The website appears incomplete (under construction/placeholder or very little content).", [w], 0.5));
      else signals.push(signal("WEBSITE_OPERATIONAL", "onlinePresence", "positive", "low", `The company website is reachable${w.metadata.https === true ? " over HTTPS" : ""} with substantive content.`, [w], 0.6));
    } else {
      signals.push(signal("WEBSITE_ERROR_RESPONSE", "onlinePresence", "negative", "low", `The company website returned HTTP ${String(w.metadata.httpStatus ?? "error")}. This can be temporary or bot-blocking.`, [w], 0.4));
    }
    if (w.metadata.injectionDetected === true) {
      signals.push(signal("INSTRUCTION_LIKE_TEXT_ON_WEBSITE", "onlinePresence", "neutral", "info", "Text resembling instructions to AI systems was found on the website and removed from the evidence. It was treated as data only.", [w], 0));
    }
  }
  // Independent coverage: relevant, non-self third-party groups from tier 1-3 sources.
  const independent = ctx.thirdPartyGroups.filter(g => g.representative.type !== "forum" && g.representative.sourceTier <= 3 && !(ctx.query.domain && g.representative.sourceDomain?.endsWith(ctx.query.domain)));
  const tier2 = independent.filter(g => g.representative.sourceTier <= 2);
  if (tier2.length > 0) signals.push(signal("COVERAGE_BY_ESTABLISHED_SOURCES", "onlinePresence", "positive", "low", `The company is covered by ${tier2.length} established/official source(s) (coverage is not endorsement).`, tier2.flatMap(g => g.members), 0.7));
  else if (independent.length >= 3) signals.push(signal("INDEPENDENT_WEB_MENTIONS", "onlinePresence", "positive", "low", `${independent.length} independent web sources mention the company.`, independent.flatMap(g => g.members), 0.4));

  const status: OnlinePresenceSection["status"] =
    !w && !(websiteRun && checked(websiteRun)) && independent.length === 0 ? "not_checked"
    : signals.some(s => s.code === "WEBSITE_PARKED_OR_FOR_SALE" || s.code === "WEBSITE_ERROR_RESPONSE") ? (w?.metadata.reachable === true ? "inconsistent" : "unreachable")
    : signals.some(s => s.code === "WEBSITE_OPERATIONAL") && independent.length > 0 ? "established"
    : "limited";
  return { status, signals };
}
