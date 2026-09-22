import { randomUUID } from "node:crypto";

/**
 * Partner Operations layer: a durable, per-request audit trail of ingestion ATTEMPTS (Section 3),
 * entirely separate from the property records those attempts wrote. Deliberately minimal — one row
 * per `POST /api/v1/market-data/import` call, safe counts and timing only. It NEVER stores the
 * partner's bearer token, the raw request body, or any individual property record's fields — see
 * the field list below, which is the complete row shape and intentionally has no room for any of
 * those. This is what lets `GET /api/v1/internal/market-data/partners` report accurate windowed
 * acceptance/rejection figures (Section 4) without ever re-reading anything sensitive.
 */

export interface IngestionAuditEntry {
  id: string;
  partnerId: string;
  requestId: string;
  receivedAt: string;
  recordsReceived: number;
  recordsAccepted: number;
  recordsRejected: number;
  recordsUpdated: number;
  httpStatus: number;
  durationMs: number;
  errorCode: string | null;
}

export type IngestionAuditEntryInput = Omit<IngestionAuditEntry, "id">;

export interface IngestionWindowStats {
  recordsReceived: number;
  recordsAccepted: number;
  recordsRejected: number;
  recordsUpdated: number;
  /** Number of ingestion attempts (HTTP calls) in the window, not records — a health signal in
   *  its own right (a partner that calls once with 10,000 records looks different from one that
   *  calls 500 times with 20 records each, even at the same total volume). */
  attempts: number;
}

export interface PartnerIngestionAuditRepository {
  readonly name: string;
  /** Records exactly one ingestion attempt. Called once per `POST /api/v1/market-data/import`
   *  request that reaches an authenticated partner — including a request that fails validation or
   *  throws, so `errorCode`/`httpStatus` capture failed attempts too, not only successful ones.
   *  Returns the generated audit row id (Production Feed Runner Section 6: `partner:run-feed`'s
   *  output includes it) — callers that don't need it simply ignore the return value. */
  record(entry: IngestionAuditEntryInput): Promise<string>;
  /** ISO timestamp of the partner's most recent ingestion ATTEMPT (successful or not) — distinct
   *  from `latestObservationDate` (PartnerFeedStats), which is the freshest ACCEPTED record's
   *  observedAt. A partner can have a very recent `latestIngestionAt` while every attempt in it
   *  was rejected, which is exactly the kind of thing an operator needs to see. */
  latestIngestionAt(partnerId: string): Promise<string | null>;
  /** Summed counts across every attempt at or after `sinceIso` — the basis for
   *  recordsAcceptedLast24h/Last7d and rejectionRateLast7d (Section 4). */
  statsSince(partnerId: string, sinceIso: string): Promise<IngestionWindowStats>;
}

const EMPTY_WINDOW: IngestionWindowStats = { recordsReceived: 0, recordsAccepted: 0, recordsRejected: 0, recordsUpdated: 0, attempts: 0 };

/** In-memory PartnerIngestionAuditRepository — a full implementation (not a stub) for tests and
 *  the `npm run test:partner-e2e` script, mirroring MemoryPartnerRepository's role. */
export class MemoryPartnerIngestionAuditRepository implements PartnerIngestionAuditRepository {
  readonly name = "In-memory partner ingestion audit (non-durable)";
  private entries: IngestionAuditEntry[] = [];

  async record(entry: IngestionAuditEntryInput): Promise<string> {
    const id = randomUUID();
    this.entries.push({ ...entry, id });
    return id;
  }
  async latestIngestionAt(partnerId: string): Promise<string | null> {
    const forPartner = this.entries.filter(e => e.partnerId === partnerId);
    if (forPartner.length === 0) return null;
    return forPartner.reduce((a, b) => (a.receivedAt > b.receivedAt ? a : b)).receivedAt;
  }
  async statsSince(partnerId: string, sinceIso: string): Promise<IngestionWindowStats> {
    const matches = this.entries.filter(e => e.partnerId === partnerId && e.receivedAt >= sinceIso);
    return matches.reduce((acc, e) => ({
      recordsReceived: acc.recordsReceived + e.recordsReceived,
      recordsAccepted: acc.recordsAccepted + e.recordsAccepted,
      recordsRejected: acc.recordsRejected + e.recordsRejected,
      recordsUpdated: acc.recordsUpdated + e.recordsUpdated,
      attempts: acc.attempts + 1
    }), { ...EMPTY_WINDOW });
  }
  /** Test/dev-only escape hatch to inspect what's stored — not part of the interface. */
  all(): readonly IngestionAuditEntry[] { return this.entries; }
}
