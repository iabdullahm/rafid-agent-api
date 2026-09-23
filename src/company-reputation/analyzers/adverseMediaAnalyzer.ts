import { classifyAdverseMedia, describeStage, type AdverseClassification } from "../adverseMediaClassifier.js";
import type { EvidenceGroup } from "../deduplication.js";
import { TIER_LABELS } from "../sourceQuality.js";
import type { AdverseCategory, Dimension, LegalStage, Signal, SignalSeverity } from "../types.js";
import { checked, groupStrength, runsFor, signal, type AnalysisContext } from "./context.js";

/**
 * Adverse media over NEWS / REGULATORY event groups that passed entity-relevance filtering (reviews
 * and forum posts are handled by the customer-sentiment analyzer, so one anonymous complaint never
 * becomes "adverse media").
 *  - A mention is not adverse unless an adverse-category term is present (classifier).
 *  - Each event GROUP (syndicated copies merged) yields at most one signal.
 *  - The legal stage is the most specific stage stated by any member of the group — but a stage is
 *    never upgraded beyond what a source actually states (allegation stays allegation).
 *  - Routing (no double counting): established outcomes (conviction/judgment/regulatory action/
 *    settlement) and charges → legalRegulatory; insolvency → businessStability; everything else
 *    (allegations, investigations, lawsuits, breaches, operational failures) → adverseMedia.
 */

export interface AdverseMediaItem {
  eventId: string;
  title: string | null;
  category: AdverseCategory;
  categories: AdverseCategory[];
  legalStage: LegalStage;
  stageDescription: string;
  established: boolean;
  severity: SignalSeverity;
  dimension: Dimension;
  publishedAt: string | null;
  coverageCount: number;
  relevance: number;
  sources: { sourceName: string; url: string | null; authority: string }[];
  evidenceIds: string[];
}

export interface AdverseMediaSection {
  status: "none_found" | "items_found" | "not_checked" | "unavailable";
  items: AdverseMediaItem[];
  neutralMentions: number;
  /** Items the company appears in only as victim/reporter (e.g. "scammers impersonating X"). */
  victimOrReporterMentions: number;
  signals: Signal[];
}

const STAGE_RANK: Readonly<Record<LegalStage, number>> = {
  unspecified: 0, allegation: 1, investigation: 2, lawsuit_filed: 3, charge: 4, settlement: 5, regulatory_action: 6, judgment: 7, conviction: 8, dismissed_or_acquitted: 9
};

function classifyGroup(group: EvidenceGroup): AdverseClassification {
  const classifications = group.members.map(m => classifyAdverseMedia(`${m.title ?? ""}. ${m.summary ?? ""}`));
  const adverse = classifications.filter(c => c.adverse);
  if (adverse.length === 0) {
    return classifications.find(c => c.companyRole === "victim_or_reporter") ?? classifications.find(c => c.legalStage === "dismissed_or_acquitted") ?? classifications[0]!;
  }
  // Most specific stated stage among members (exoneration handled separately below).
  const best = [...adverse].sort((a, b) => STAGE_RANK[b.legalStage] - STAGE_RANK[a.legalStage])[0]!;
  const exonerated = classifications.some(c => c.legalStage === "dismissed_or_acquitted");
  return exonerated ? { ...best, adverse: false, legalStage: "dismissed_or_acquitted", severity: "info", established: false } : best;
}

function routeDimension(c: AdverseClassification): Dimension {
  if (c.primaryCategory === "insolvency") return "businessStability";
  if (c.established || c.legalStage === "charge") return "legalRegulatory";
  return "adverseMedia";
}

export function analyzeAdverseMedia(ctx: AnalysisContext): AdverseMediaSection {
  const runs = runsFor(ctx, "news");
  const newsGroups = ctx.thirdPartyGroups.filter(g => g.representative.type === "news" || g.representative.type === "regulatory");
  const items: AdverseMediaItem[] = [];
  const signals: Signal[] = [];
  let neutral = 0, victim = 0;
  for (const group of newsGroups) {
    const c = classifyGroup(group);
    if (c.companyRole === "victim_or_reporter") { victim++; continue; }
    if (!c.adverse || !c.primaryCategory) {
      neutral++;
      if (c.legalStage === "dismissed_or_acquitted" && c.primaryCategory) {
        signals.push(signal("REPORTED_DISMISSAL_OR_ACQUITTAL", "legalRegulatory", "neutral", "info", `Reported dismissal/acquittal: "${group.representative.title ?? "untitled"}".`, group.members, 0));
      }
      continue;
    }
    const dimension = routeDimension(c);
    const strength = groupStrength(group);
    const rep = group.representative;
    const publishers = [...new Map(group.members.map(m => [m.sourceDomain ?? m.sourceName, m])).values()];
    items.push({
      eventId: group.groupId, title: rep.title, category: c.primaryCategory, categories: c.categories, legalStage: c.legalStage,
      stageDescription: describeStage(c.legalStage), established: c.established, severity: c.severity, dimension,
      publishedAt: group.members.map(m => m.publishedAt).filter((d): d is string => Boolean(d)).sort()[0] ?? null,
      coverageCount: group.members.length,
      relevance: Math.round((group.members.reduce((s, m) => s + m.relevance, 0) / group.members.length) * 100) / 100,
      sources: publishers.slice(0, 5).map(m => ({ sourceName: m.sourceName, url: m.sourceUrl, authority: TIER_LABELS[m.sourceTier] })),
      evidenceIds: group.members.map(m => m.id).sort()
    });
    const wording = c.established ? describeStage(c.legalStage) : `${describeStage(c.legalStage)}`;
    signals.push(signal(`ADVERSE_${c.primaryCategory.toUpperCase()}${c.established ? "_ESTABLISHED" : ""}`, dimension, "negative", c.severity,
      `${c.primaryCategory.replace(/_/g, " ")} — ${wording}: "${rep.title ?? "untitled"}" (${publishers.length} publisher(s), ${group.members.length} item(s) grouped as one event).`,
      group.members, strength));
  }
  items.sort((a, b) => STAGE_RANK[b.legalStage] - STAGE_RANK[a.legalStage] || (b.publishedAt ?? "").localeCompare(a.publishedAt ?? "") || a.eventId.localeCompare(b.eventId));
  const anyChecked = runs.some(checked);
  const status: AdverseMediaSection["status"] = !anyChecked ? (runs.some(r => ["unavailable", "timeout", "rate_limited"].includes(r.status)) ? "unavailable" : "not_checked") : items.length > 0 ? "items_found" : "none_found";
  return { status, items, neutralMentions: neutral, victimOrReporterMentions: victim, signals };
}
