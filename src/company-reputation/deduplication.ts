import { createHash } from "node:crypto";
import { bigramSimilarity } from "../business-data/matching/search.js";
import { canonicalUrl, foldForMatch } from "./normalization.js";
import type { NormalizedEvidence } from "./types.js";

/**
 * Evidence deduplication and event grouping.
 *
 * Two layers:
 *  1. Exact duplicates (same provider record or same canonical URL) collapse into one evidence item.
 *  2. Syndicated / re-reported coverage of the SAME underlying story collapses into one EVENT group:
 *     same canonical URL, or near-identical normalized titles (bigram Dice ≥ TITLE_SIMILARITY), or
 *     the same "event fingerprint" (distinctive title tokens overlapping ≥ FINGERPRINT_OVERLAP)
 *     published within EVENT_WINDOW_DAYS of each other.
 * Independence (for confidence) and impact (for scoring) are counted per GROUP, so ten syndicated
 * copies of one article are one event from one underlying source, not ten.
 */

export const TITLE_SIMILARITY = 0.82;
export const FINGERPRINT_OVERLAP = 0.7;
export const EVENT_WINDOW_DAYS = 14;

const STOP = new Set(["THE", "A", "AN", "AND", "OR", "OF", "TO", "IN", "ON", "FOR", "WITH", "BY", "AT", "FROM", "AS", "IS", "ARE", "WAS", "WERE", "BE", "ITS", "IT", "THAT", "THIS", "OVER", "AFTER", "SAYS", "SAY", "NEW", "REPORT", "REPORTS", "NEWS", "UPDATE", "EXCLUSIVE", "LIVE", "VIDEO"]);

/** Strip "| Reuters", " - BBC News" style publisher suffixes and fold. */
export function normalizeTitle(title: string | null): string {
  if (!title) return "";
  const withoutSuffix = title.replace(/\s+[|\-–—:]\s+[^|\-–—:]{2,40}$/, "");
  return foldForMatch(withoutSuffix);
}

export function titleFingerprint(title: string | null): string[] {
  return [...new Set(normalizeTitle(title).split(" ").filter(t => t.length > 2 && !STOP.has(t)))].sort();
}

function overlap(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sb = new Set(b);
  const shared = a.filter(t => sb.has(t)).length;
  return shared / Math.min(a.length, b.length);
}

function withinWindow(a: string | null, b: string | null): boolean {
  if (!a || !b) return true; // unknown dates don't prevent grouping of near-identical stories
  const da = Date.parse(a), db = Date.parse(b);
  if (!Number.isFinite(da) || !Number.isFinite(db)) return true;
  return Math.abs(da - db) <= EVENT_WINDOW_DAYS * 86_400_000;
}

export function evidenceId(providerId: string, key: string): string {
  return `ev_${createHash("sha256").update(`${providerId}|${key}`).digest("hex").slice(0, 16)}`;
}

/** Layer 1: drop exact duplicates (by id, then by canonical URL), keeping the highest-quality copy
 *  and the earliest publication date seen. Order-independent result (sorted by id). */
export function dedupeEvidence(items: readonly NormalizedEvidence[]): { items: NormalizedEvidence[]; removed: number } {
  const byKey = new Map<string, NormalizedEvidence>();
  for (const item of items) {
    const key = item.sourceRecordId && item.type !== "news" && item.type !== "review" && item.type !== "forum"
      ? `${item.providerId}|${item.sourceRecordId}`
      : canonicalUrl(item.sourceUrl) ?? item.id;
    const existing = byKey.get(key);
    if (!existing || item.quality > existing.quality || (item.quality === existing.quality && item.id < existing.id)) {
      byKey.set(key, existing && existing.publishedAt && (!item.publishedAt || existing.publishedAt < item.publishedAt)
        ? { ...item, publishedAt: existing.publishedAt } : item);
    }
  }
  const out = [...byKey.values()].sort((a, b) => a.id.localeCompare(b.id));
  return { items: out, removed: items.length - out.length };
}

export interface EvidenceGroup {
  groupId: string;
  members: NormalizedEvidence[];
  /** Representative = highest authority, then earliest published, then id. */
  representative: NormalizedEvidence;
}

/** Layer 2: cluster evidence of the same type into underlying events (single-link, deterministic). */
export function groupEvents(items: readonly NormalizedEvidence[]): EvidenceGroup[] {
  const sorted = [...items].sort((a, b) => a.sourceTier - b.sourceTier || (a.publishedAt ?? "9999").localeCompare(b.publishedAt ?? "9999") || a.id.localeCompare(b.id));
  const parent = sorted.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  const union = (i: number, j: number) => { const a = find(i), b = find(j); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); };
  const titles = sorted.map(e => normalizeTitle(e.title));
  const prints = sorted.map(e => titleFingerprint(e.title));
  const urls = sorted.map(e => canonicalUrl(e.sourceUrl));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i]!, b = sorted[j]!;
      if (a.type !== b.type) continue;
      if (urls[i] && urls[i] === urls[j]) { union(i, j); continue; }
      if (!titles[i] || !titles[j]) continue;
      if (!withinWindow(a.publishedAt, b.publishedAt)) continue;
      if (bigramSimilarity(titles[i]!, titles[j]!) >= TITLE_SIMILARITY) { union(i, j); continue; }
      // Event fingerprints only group NEWS coverage; independent user posts with similar wording are
      // separate reports, not one syndicated story.
      if ((a.type === "news" || a.type === "regulatory") && prints[i]!.length >= 4 && prints[j]!.length >= 4 && overlap(prints[i]!, prints[j]!) >= FINGERPRINT_OVERLAP) union(i, j);
    }
  }
  const groups = new Map<number, NormalizedEvidence[]>();
  sorted.forEach((e, i) => { const r = find(i); const g = groups.get(r); if (g) g.push(e); else groups.set(r, [e]); });
  return [...groups.values()].map(members => ({
    groupId: `grp_${createHash("sha256").update(members.map(m => m.id).sort().join(",")).digest("hex").slice(0, 12)}`,
    members,
    representative: members[0]!
  })).sort((a, b) => a.groupId.localeCompare(b.groupId));
}
