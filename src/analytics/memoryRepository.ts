import type { AnalyticsEvent, AnalyticsEventInput, AnalyticsRepository } from "./types.js";
import { MAX_QUERY_EVENTS } from "./types.js";

/** In-memory analytics log; entries are lost on process restart/redeploy — the safe default for
 *  createApp() and for tests, exactly like MemoryUsageRepository (billing/usage.ts). Recording
 *  still always happens (never conditional on a database being configured) so nothing observable
 *  during a session is silently dropped; only durability across restarts requires
 *  ANALYTICS_DATABASE_URL / DATABASE_URL (see src/db/analyticsStore.ts). */
export class MemoryAnalyticsRepository implements AnalyticsRepository {
  private readonly events: AnalyticsEvent[] = [];

  record(event: AnalyticsEventInput): void {
    this.events.push({ ...event, createdAt: event.createdAt ?? new Date().toISOString() });
    // Bound memory even for a long-running process with no database configured — same spirit as
    // MAX_QUERY_EVENTS on the read side, applied here so an unbounded, DB-less deployment can't
    // grow this array forever. Drops the oldest events first (FIFO), never the newest.
    if (this.events.length > MAX_QUERY_EVENTS) this.events.splice(0, this.events.length - MAX_QUERY_EVENTS);
  }

  async queryEvents(since: Date): Promise<AnalyticsEvent[]> {
    const sinceMs = since.getTime();
    return this.events
      .filter(e => new Date(e.createdAt).getTime() >= sinceMs)
      .slice()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, MAX_QUERY_EVENTS);
  }

  /** Test-only helpers — never used by production call sites. */
  clear(): void {
    this.events.length = 0;
  }
  all(): readonly AnalyticsEvent[] {
    return this.events;
  }
}
