import type { AdverseCategory, LegalStage, SignalSeverity } from "./types.js";

/**
 * Deterministic adverse-media classification over SANITIZED title + snippet text.
 *
 * Principles:
 *  - A mention of the company is NOT adverse media. An item is adverse only when it contains an
 *    adverse-category term; otherwise it is a neutral mention.
 *  - Where the company is the VICTIM or the reporter of wrongdoing ("warns customers of scammers
 *    impersonating…", "hit by cyberattack" is still a breach), the item is not attributed to the
 *    company as misconduct.
 *  - The legal stage is detected separately and conservatively. Only explicit outcome language
 *    ("convicted", "found guilty", "court ruled", "fined by") yields an established stage; anything
 *    else stays an allegation/investigation/lawsuit — allegations are never promoted to facts.
 *  - Explicit exoneration ("acquitted", "charges dropped", "case dismissed") is recognized.
 */

const CATEGORY_TERMS: ReadonlyArray<readonly [AdverseCategory, RegExp]> = [
  ["sanctions", /\b(sanction(s|ed)? (list|violation|evasion|breach)|violat\w* sanctions|evad\w* sanctions|ofac|designated (entity|by the treasury)|asset freeze|export control violation)\b/i],
  ["fraud", /\b(fraud\w*|ponzi|embezzl\w*|misappropriat\w*|money[- ]laundering|laundered|accounting irregularit\w*|falsif\w* (records|accounts))\b/i],
  ["scam", /\b(scam\w*|swindl\w*|con artist|rip[- ]?off|fake (company|website|business))\b/i],
  ["corruption", /\b(brib\w*|corrupt\w*|kickback\w*|fcpa)\b/i],
  ["criminal_proceedings", /\b(criminal (case|charges?|proceedings?|investigation)|indict\w*|prosecut\w*|arrest\w*|raid(ed)?)\b/i],
  ["regulatory", /\b(regulator\w*|enforcement action|fined|penalt(y|ies)|licen[cs]e (revoked|suspended|cancell?ed)|cease[- ]and[- ]desist|consent order|warning letter|sec charges|antitrust|competition authority)\b/i],
  ["insolvency", /\b(insolven\w*|bankrupt\w*|chapter (7|11)|(entered|into) administration|administrators? appointed|receivership|liquidat\w*|winding[- ]up|went bust|collapsed?|defaulted on)\b/i],
  ["data_breach", /\b(data breach|breach of (customer|personal) data|hack(ed|ers?)|ransomware|cyber ?attack|leaked (data|records)|exposed (data|records))\b/i],
  ["litigation", /\b(lawsuit|sued|sues|suing|class action|litigation|legal action|court case|complaint filed)\b/i],
  ["contract_dispute", /\b(contract dispute|breach of contract|arbitration|unpaid (invoices?|suppliers?|contractors?)|failed to pay|non[- ]payment)\b/i],
  ["customer_harm", /\b(recall(ed|s)?|unsafe product|consumer complaints?|mis[- ]?sold|misleading (customers|claims)|refunds? (withheld|refused))\b/i],
  ["operational_failure", /\b(outage|service disruption|grounded|explosion|fatal accident|major failure|systems? failure)\b/i]
];

/** Ordered: strongest explicit outcome first. */
const STAGE_TERMS: ReadonlyArray<readonly [LegalStage, RegExp]> = [
  ["dismissed_or_acquitted", /\b(acquitted|charges? (were |was )?(dropped|dismissed|withdrawn)|case (was )?dismissed|cleared of|found not guilty|exonerated|overturned)\b/i],
  ["conviction", /\b(convicted|found guilty|pleaded guilty|pled guilty|guilty plea|sentenced)\b/i],
  ["judgment", /\b(court (ruled|found|ordered)|judge (ruled|found|ordered)|judgment (against|in favou?r)|found liable|ordered to pay|verdict against|awarded damages)\b/i],
  ["regulatory_action", /\b(fined|penalt(y|ies) (imposed|of)|enforcement action|licen[cs]e (revoked|suspended|cancell?ed)|consent order|cease[- ]and[- ]desist (order|issued)|banned by|censured|sanctioned by (the )?(regulator|authority|commission))\b/i],
  ["settlement", /\b(settle[ds]?|settlement|agreed to pay)\b/i],
  ["charge", /\b(charged with|indicted|faces charges|criminal charges? (filed|brought))\b/i],
  ["lawsuit_filed", /\b(sued|sues|suing|lawsuit (filed|against)|filed (a )?(lawsuit|suit|complaint)|class action)\b/i],
  ["investigation", /\b(investigat\w*|probe[ds]?|inquiry|under scrutiny|raided|audit(ed)? by)\b/i],
  ["allegation", /\b(alleg\w*|accus\w*|claims? (that|of)|reportedly|suspected|whistleblower)\b/i]
];

/** The company appears as the victim / reporter, not the wrongdoer. */
const VICTIM_PATTERNS: readonly RegExp[] = [
  /\b(impersonat\w*|posing as|pretending to be|fake (emails?|websites?|accounts?|recruiters?) (claiming|pretending|posing))\b/i,
  /\bwarns? (customers|users|clients|the public) (of|about|against)\b/i,
  /\b(victims? of|targeted by|fell victim)\b/i,
  /\b(scam|phishing) (using|exploiting|abusing) (the )?(name|brand)\b/i
];

export interface AdverseClassification {
  adverse: boolean;
  categories: AdverseCategory[];
  primaryCategory: AdverseCategory | null;
  legalStage: LegalStage;
  companyRole: "subject" | "victim_or_reporter" | "unclear";
  severity: SignalSeverity;
  /** Established outcome (conviction/judgment/regulatory action/settlement) vs unproven. */
  established: boolean;
}

const CATEGORY_WEIGHT: Readonly<Record<AdverseCategory, number>> = {
  fraud: 1, scam: 0.9, sanctions: 1, corruption: 1, criminal_proceedings: 0.9, regulatory: 0.8, insolvency: 0.8,
  data_breach: 0.6, litigation: 0.5, contract_dispute: 0.5, customer_harm: 0.6, operational_failure: 0.4
};

/** Base severity by legal stage (before category weighting). */
const STAGE_SEVERITY: Readonly<Record<LegalStage, SignalSeverity>> = {
  conviction: "critical", judgment: "high", regulatory_action: "high", charge: "high", settlement: "medium",
  investigation: "medium", lawsuit_filed: "low", allegation: "low", unspecified: "low", dismissed_or_acquitted: "info"
};

const SEVERITY_ORDER: readonly SignalSeverity[] = ["info", "low", "medium", "high", "critical"];

export function classifyAdverseMedia(text: string): AdverseClassification {
  const categories = CATEGORY_TERMS.filter(([, re]) => re.test(text)).map(([c]) => c);
  if (categories.length === 0) {
    return { adverse: false, categories: [], primaryCategory: null, legalStage: "unspecified", companyRole: "unclear", severity: "info", established: false };
  }
  const victim = VICTIM_PATTERNS.some(re => re.test(text));
  const stage = STAGE_TERMS.find(([, re]) => re.test(text))?.[0] ?? "unspecified";
  const primary = [...categories].sort((a, b) => CATEGORY_WEIGHT[b] - CATEGORY_WEIGHT[a])[0]!;
  // Insolvency/operational items describe the company's condition rather than a legal process;
  // their "stage" is reported as-is but severity comes from the category.
  let severity = STAGE_SEVERITY[stage];
  if (primary === "insolvency" && stage === "unspecified") severity = "medium";
  // Category weighting: low-weight categories (litigation, operational) cap one level lower.
  if (CATEGORY_WEIGHT[primary] <= 0.6 && severity !== "info") severity = SEVERITY_ORDER[Math.max(1, SEVERITY_ORDER.indexOf(severity) - 1)]!;
  const established = stage === "conviction" || stage === "judgment" || stage === "regulatory_action" || stage === "settlement";
  if (victim) {
    return { adverse: false, categories, primaryCategory: primary, legalStage: stage, companyRole: "victim_or_reporter", severity: "info", established: false };
  }
  return { adverse: stage !== "dismissed_or_acquitted", categories, primaryCategory: primary, legalStage: stage, companyRole: "subject", severity, established };
}

/** Human-readable, non-overstating description of a stage. */
export function describeStage(stage: LegalStage): string {
  switch (stage) {
    case "allegation": return "allegation reported (not established)";
    case "investigation": return "investigation reported (no finding reported)";
    case "lawsuit_filed": return "lawsuit reported as filed (claims not adjudicated)";
    case "charge": return "charges reported (not a conviction)";
    case "regulatory_action": return "regulatory action reported";
    case "settlement": return "settlement reported (settlements often involve no admission of liability)";
    case "judgment": return "court judgment reported";
    case "conviction": return "conviction reported";
    case "dismissed_or_acquitted": return "dismissal/acquittal reported";
    default: return "adverse topic mentioned (legal stage not stated)";
  }
}
