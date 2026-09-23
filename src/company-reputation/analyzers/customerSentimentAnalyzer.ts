import type { EvidenceGroup } from "../deduplication.js";
import type { Signal } from "../types.js";
import { checked, groupStrength, runsFor, signal, type AnalysisContext } from "./context.js";

/**
 * Customer reputation from review platforms and forums. Individual reviews/posts are NEVER treated
 * as authoritative facts:
 *  - Published AGGREGATE ratings (e.g. "4.3 out of 5 based on 1,200 reviews") are the strongest
 *    signal here, still tier 3 (self-selected reviewers).
 *  - Individual complaint/praise snippets are weak signals (tier 3-4 authority × relevance); one
 *    anonymous complaint moves the score by ~1-2 points at most.
 *  - Only a PATTERN (≥ 3 independent negative sources) produces an additional medium signal.
 */

export interface AggregateRating { platform: string; rating: number; scale: 5; reviewCount: number | null; url: string | null; evidenceId: string }

export interface CustomerSentimentSection {
  status: "not_checked" | "unavailable" | "insufficient_data" | "mostly_positive" | "mixed" | "mostly_negative";
  aggregateRatings: AggregateRating[];
  positiveSignals: Signal[];
  negativeSignals: Signal[];
}

const NEGATIVE = /\b(scam\w*|fraud\w*|rip[- ]?off|never (received|arrived|delivered)|no refund|refund (refused|denied)|won'?t refund|terrible|awful|worst|avoid|complain\w*|stole|unresponsive|misleading|poor (service|quality|support)|disappointed)\b/i;
const POSITIVE = /\b(excellent|great (service|support|experience|product)|highly recommend\w*|recommend(ed)?|reliable|professional|fast delivery|very (good|helpful|satisfied)|outstanding|trustworthy)\b/i;
const RATING = /(?:trustscore|rated|rating|scores?|average)?\s*:?\s*(\d(?:\.\d{1,2})?)\s*(?:\/|out of)\s*5(?:\s*stars?)?/i;
const REVIEW_COUNT = /(\d{1,3}(?:[,.]\d{3})*|\d+)\s+(?:reviews|ratings|customer reviews)/i;

export function parseAggregateRating(text: string): { rating: number; reviewCount: number | null } | null {
  const m = RATING.exec(text);
  if (!m) return null;
  const rating = Number(m[1]);
  if (!Number.isFinite(rating) || rating < 0 || rating > 5) return null;
  const c = REVIEW_COUNT.exec(text);
  const reviewCount = c ? Number(c[1]!.replace(/[,.]/g, "")) : null;
  return { rating, reviewCount: Number.isFinite(reviewCount) ? reviewCount : null };
}

function groupText(g: EvidenceGroup): string {
  return g.members.map(m => `${m.title ?? ""}. ${m.summary ?? ""}`).join(" ");
}

export function analyzeCustomerSentiment(ctx: AnalysisContext): CustomerSentimentSection {
  const runs = runsFor(ctx, "reviews");
  const groups = ctx.thirdPartyGroups.filter(g => g.representative.type === "review" || g.representative.type === "forum");
  const aggregateRatings: AggregateRating[] = [];
  const signals: Signal[] = [];
  let negativeSources = 0;
  const negativeEvidence: string[] = [];

  for (const g of groups) {
    const rep = g.representative;
    const text = groupText(g);
    const parsed = rep.type === "review" ? parseAggregateRating(text) : null;
    if (parsed) {
      aggregateRatings.push({ platform: rep.sourceDomain ?? rep.sourceName, rating: parsed.rating, scale: 5, reviewCount: parsed.reviewCount, url: rep.sourceUrl, evidenceId: rep.id });
      const volume = parsed.reviewCount !== null && parsed.reviewCount >= 20;
      const strength = groupStrength(g) * (volume ? 1 : 0.6);
      if (parsed.rating >= 4) signals.push(signal("FAVORABLE_AGGREGATE_RATING", "customerReputation", "positive", volume ? "medium" : "low", `Aggregate rating ${parsed.rating}/5${parsed.reviewCount !== null ? ` from ${parsed.reviewCount} reviews` : ""} on ${rep.sourceDomain ?? rep.sourceName} (self-selected reviewers).`, g.members, strength));
      else if (parsed.rating < 2.5) signals.push(signal("UNFAVORABLE_AGGREGATE_RATING", "customerReputation", "negative", volume ? "medium" : "low", `Aggregate rating ${parsed.rating}/5${parsed.reviewCount !== null ? ` from ${parsed.reviewCount} reviews` : ""} on ${rep.sourceDomain ?? rep.sourceName} (self-selected reviewers).`, g.members, strength));
      else signals.push(signal("MIXED_AGGREGATE_RATING", "customerReputation", "neutral", "info", `Aggregate rating ${parsed.rating}/5 on ${rep.sourceDomain ?? rep.sourceName}.`, g.members, 0));
      continue;
    }
    const neg = NEGATIVE.test(text), pos = POSITIVE.test(text);
    if (neg && !pos) {
      negativeSources++;
      negativeEvidence.push(...g.members.map(m => m.id));
      signals.push(signal("NEGATIVE_CUSTOMER_REPORT", "customerReputation", "negative", "low", `Negative customer/user report (unverified, ${rep.type === "forum" ? "forum/social post" : "review platform"}): "${rep.title ?? "untitled"}".`, g.members, groupStrength(g)));
    } else if (pos && !neg) {
      signals.push(signal("POSITIVE_CUSTOMER_REPORT", "customerReputation", "positive", "low", `Positive customer/user report (unverified): "${rep.title ?? "untitled"}".`, g.members, groupStrength(g)));
    }
  }
  if (negativeSources >= 3) {
    signals.push(signal("NEGATIVE_COMPLAINT_PATTERN", "customerReputation", "negative", "medium", `${negativeSources} independent negative customer reports were identified. Individually unverified; the pattern is what is reported.`, negativeEvidence, 0.4, 3));
  }
  const positiveSignals = signals.filter(s => s.polarity === "positive");
  const negativeSignals = signals.filter(s => s.polarity === "negative");
  const anyChecked = runs.some(checked);
  let status: CustomerSentimentSection["status"];
  if (!anyChecked) status = runs.some(r => ["unavailable", "timeout", "rate_limited"].includes(r.status)) ? "unavailable" : "not_checked";
  else if (positiveSignals.length + negativeSignals.length === 0) status = "insufficient_data";
  else {
    const p = positiveSignals.reduce((s, x) => s + x.strength, 0), n = negativeSignals.reduce((s, x) => s + x.strength, 0);
    status = p >= 2 * n ? "mostly_positive" : n >= 2 * p ? "mostly_negative" : "mixed";
  }
  return { status, aggregateRatings, positiveSignals, negativeSignals };
}
