import type { AnalyticsRepository, PreviewEventType } from "../analytics/types.js";
import type { RequestClientContext } from "../analytics/context.js";

/**
 * Free Preview — funnel analytics + preview→paid conversion tracking.
 *
 * Reuses the exact same AnalyticsRepository (src/analytics/types.ts, src/analytics/recorder.ts)
 * every other domain in this codebase (discovery/mcp/x402/l402/tool) already records into, rather
 * than a second event-logging system — see analytics/types.ts's new "preview" category and
 * PreviewEventType for the vocabulary this module writes. Recording is fire-and-forget (mirrors
 * recorder.ts's fireAndForget()) and NEVER throws into its caller — analytics must never slow down
 * or fail the real request it's observing, and paid execution must never depend on this store (see
 * this module's PreviewConversionIndex doc comment for the same discipline applied to conversion
 * matching).
 */

function fireAndForget(repository: AnalyticsRepository, event: Parameters<AnalyticsRepository["record"]>[0]): void {
  try {
    void Promise.resolve(repository.record(event)).catch(() => {});
  } catch {
    /* a synchronous throw from a misbehaving repository must not propagate either */
  }
}

const emptyClient: RequestClientContext = { clientHash: null, userAgent: null, referer: null, clientName: null };

export function recordPreviewEvent(
  repository: AnalyticsRepository,
  args: {
    eventType: PreviewEventType;
    toolName: string | null;
    requestFingerprint?: string | null;
    paymentRail?: string | null;
    previewSeen?: boolean | null;
    conversionLatencyMs?: number | null;
    client?: RequestClientContext;
  }
): void {
  fireAndForget(repository, {
    category: "preview", eventType: args.eventType, path: null, toolName: args.toolName, channel: null,
    success: null, durationMs: null, amount: null, currency: null, txHash: null, dataSource: null,
    requestFingerprint: args.requestFingerprint ?? null, paymentRail: args.paymentRail ?? null,
    previewSeen: args.previewSeen ?? null, conversionLatencyMs: args.conversionLatencyMs ?? null,
    ...(args.client ?? emptyClient)
  });
}

/**
 * Preview→paid conversion index — operational state (NOT the durable analytics log above) that
 * answers, at the moment a paid capability call starts, "did the same logical request (same
 * capability + same request fingerprint) see a free preview recently enough to count?"
 *
 * Deliberately a small, bounded, in-memory, best-effort structure — not the analytics store, not a
 * database — so it can never become a dependency paid execution relies on: api/app.ts's finish
 * handler reads it, wrapped in try/catch, strictly AFTER the response has already been sent (see
 * that handler's doc comment), so even a throw here can never affect the real request. It stores
 * only a fingerprint (a one-way hash — see preview/fingerprint.ts), a capability name, and a
 * timestamp: never raw input, never a client identity.
 *
 * "Same capability + same normalized fingerprint + paid execution within window = conversion. Use
 * the most recent qualifying preview if multiple" (spec) is satisfied by storing at most ONE entry
 * per (capability, fingerprint) key — every new preview_requested simply overwrites the stored
 * timestamp with "now", so there is only ever one, and it is always the most recent.
 */
export interface PreviewConversionIndex {
  recordPreviewSeen(capabilityName: string, fingerprint: string, seenAtMs?: number): void;
  /** Returns the qualifying preview's timestamp (ms) if one exists within `windowMs` of `nowMs`,
   *  else null. Does not remove the entry — a single preview may legitimately be followed by more
   *  than one paid call within the window (e.g. the agent pays for the same lookup twice). */
  findQualifyingPreviewAt(capabilityName: string, fingerprint: string, nowMs: number, windowMs: number): number | null;
}

const DEFAULT_MAX_ENTRIES = 20000;

export function createInMemoryPreviewConversionIndex(maxEntries = DEFAULT_MAX_ENTRIES): PreviewConversionIndex {
  const seenAt = new Map<string, number>();
  const key = (capabilityName: string, fingerprint: string) => `${capabilityName}:${fingerprint}`;
  return {
    recordPreviewSeen(capabilityName, fingerprint, seenAtMs = Date.now()) {
      seenAt.set(key(capabilityName, fingerprint), seenAtMs);
      if (seenAt.size > maxEntries) {
        // No per-entry expiry to sweep against here (unlike preview/cache.ts's TTL entries) — a
        // conversion window is only checked relative to "now" at read time, not stored with its
        // own expiry — so once over the cap, drop the oldest-inserted entries (Map iteration
        // order is insertion order), which are also the least likely to still be within any
        // reasonable conversion window.
        const overflow = seenAt.size - maxEntries;
        let dropped = 0;
        for (const k of seenAt.keys()) {
          if (dropped >= overflow) break;
          seenAt.delete(k);
          dropped++;
        }
      }
    },
    findQualifyingPreviewAt(capabilityName, fingerprint, nowMs, windowMs) {
      const at = seenAt.get(key(capabilityName, fingerprint));
      if (at === undefined) return null;
      return nowMs - at <= windowMs ? at : null;
    }
  };
}
