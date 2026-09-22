import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import type { IngestionAuditEntryInput, IngestionWindowStats, PartnerIngestionAuditRepository } from "../domain/oman/partnerAudit.js";

/**
 * PostgreSQL-backed PartnerIngestionAuditRepository (partner_ingestion_audit — see
 * src/db/partnerOpsSchema.ts, migration version 3). Deliberately constructed from an existing
 * `Pool` rather than opening its own — see app.ts's wiring: it is always given the same pool
 * PostgresPropertyMarketRepository already owns, exactly like PostgresPartnerRepository, so the
 * Partner Operations layer never opens a second, redundant connection pool to the same database.
 */
export class PostgresPartnerIngestionAuditRepository implements PartnerIngestionAuditRepository {
  readonly name = "PostgreSQL partner_ingestion_audit";
  constructor(private readonly pool: Pool) {}

  async record(entry: IngestionAuditEntryInput): Promise<string> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO partner_ingestion_audit
        (id, partner_id, request_id, received_at, records_received, records_accepted, records_rejected, records_updated, http_status, duration_ms, error_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, entry.partnerId, entry.requestId, entry.receivedAt, entry.recordsReceived, entry.recordsAccepted,
        entry.recordsRejected, entry.recordsUpdated, entry.httpStatus, entry.durationMs, entry.errorCode]
    );
    return id;
  }
  async latestIngestionAt(partnerId: string): Promise<string | null> {
    const result = await this.pool.query("SELECT max(received_at) AS latest FROM partner_ingestion_audit WHERE partner_id=$1", [partnerId]);
    const latest = result.rows[0]?.latest as Date | null;
    return latest ? latest.toISOString() : null;
  }
  async statsSince(partnerId: string, sinceIso: string): Promise<IngestionWindowStats> {
    const result = await this.pool.query(
      `SELECT coalesce(sum(records_received),0) AS records_received,
              coalesce(sum(records_accepted),0) AS records_accepted,
              coalesce(sum(records_rejected),0) AS records_rejected,
              coalesce(sum(records_updated),0) AS records_updated,
              count(*) AS attempts
       FROM partner_ingestion_audit WHERE partner_id=$1 AND received_at >= $2::timestamptz`,
      [partnerId, sinceIso]
    );
    const row = result.rows[0]!;
    return {
      recordsReceived: Number(row.records_received), recordsAccepted: Number(row.records_accepted),
      recordsRejected: Number(row.records_rejected), recordsUpdated: Number(row.records_updated),
      attempts: Number(row.attempts)
    };
  }
}
