import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import {
  generatePartnerToken, isValidPartnerId, partnerTokenDigest,
  type CreatePartnerInput, type ImportStatsDelta, type PartnerFeedConfigInput, type PartnerFeedStats,
  type PartnerRepository, type PropertyDataPartner, type PropertyDataPartnerWithStats
} from "../domain/oman/partners.js";

/**
 * PostgreSQL-backed PartnerRepository (data_partners — see src/db/partnerSchema.ts, migration
 * version 2). Deliberately constructed from an existing `Pool` rather than opening its own —
 * see app.ts/server.ts wiring: it is always given the same pool PostgresPropertyMarketRepository
 * already owns, so the Partner Data Feed layer never opens a second, redundant connection pool to
 * the same database.
 */

function toPartner(row: Record<string, unknown>): PropertyDataPartner {
  return {
    partnerId: row.partner_id as string,
    partnerName: row.partner_name as string,
    feedType: row.feed_type as PropertyDataPartner["feedType"],
    sourceType: row.source_type as PropertyDataPartner["sourceType"],
    enabled: row.enabled as boolean,
    dataLicenseReference: (row.data_license_reference as string | null) ?? null,
    contactReference: (row.contact_reference as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
    feedUrl: (row.feed_url as string | null) ?? null,
    feedFormat: (row.feed_format as PropertyDataPartner["feedFormat"]) ?? null,
    scheduleEnabled: (row.schedule_enabled as boolean | null) ?? false,
    scheduleIntervalMinutes: row.schedule_interval_minutes === null || row.schedule_interval_minutes === undefined ? null : Number(row.schedule_interval_minutes),
    lastSuccessfulRunAt: row.last_successful_run_at ? (row.last_successful_run_at as Date).toISOString() : null,
    lastAttemptAt: row.last_attempt_at ? (row.last_attempt_at as Date).toISOString() : null,
    consecutiveFailures: Number(row.consecutive_failures ?? 0)
  };
}

function toStats(row: Record<string, unknown>): PartnerFeedStats {
  return {
    recordsReceived: Number(row.records_received),
    recordsAccepted: Number(row.records_accepted),
    recordsRejected: Number(row.records_rejected),
    recordsUpdated: Number(row.records_updated),
    latestObservationDate: row.latest_observation_date ? (row.latest_observation_date as Date).toISOString() : null
  };
}

function isStale(latestObservationDate: string | null, staleDays: number): boolean {
  if (!latestObservationDate) return true;
  const ageDays = Math.max(0, Math.round((Date.now() - Date.parse(latestObservationDate)) / 86_400_000));
  return ageDays > staleDays;
}

export class PostgresPartnerRepository implements PartnerRepository {
  readonly name = "PostgreSQL data_partners";
  constructor(private readonly pool: Pool) {}

  /** Section 2/10: writes one row to `data_partner_audit_log` — safe metadata only (partner id +
   *  event type + timestamp), never a token, digest or any ingestion detail. Best-effort: a
   *  logging failure must never block the underlying admin action it's recording, so callers
   *  invoke this AFTER the action already succeeded. */
  private async recordAuditEvent(partnerId: string, eventType: "created" | "enabled" | "disabled" | "token_rotated"): Promise<void> {
    await this.pool.query(
      "INSERT INTO data_partner_audit_log (id, partner_id, event_type) VALUES ($1,$2,$3)",
      [randomUUID(), partnerId, eventType]
    );
  }

  async create(input: CreatePartnerInput): Promise<{ partner: PropertyDataPartner; token: string }> {
    if (!isValidPartnerId(input.partnerId)) throw new Error(`Partner id "${input.partnerId}" must be lowercase alphanumeric/hyphen, 2-64 characters`);
    const token = generatePartnerToken();
    const digest = partnerTokenDigest(token);
    const result = await this.pool.query(
      `INSERT INTO data_partners (partner_id, partner_name, feed_type, source_type, enabled, data_license_reference, contact_reference, token_digest)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [input.partnerId, input.partnerName, input.feedType, input.sourceType, input.enabled ?? true,
        input.dataLicenseReference ?? null, input.contactReference ?? null, digest]
    );
    await this.recordAuditEvent(input.partnerId, "created");
    return { partner: toPartner(result.rows[0]), token };
  }
  async findById(partnerId: string): Promise<PropertyDataPartner | null> {
    const result = await this.pool.query("SELECT * FROM data_partners WHERE partner_id=$1", [partnerId]);
    return result.rows[0] ? toPartner(result.rows[0]) : null;
  }
  async authenticate(token: string): Promise<PropertyDataPartner | null> {
    if (!token) return null;
    const digest = partnerTokenDigest(token);
    const result = await this.pool.query("SELECT * FROM data_partners WHERE token_digest=$1 AND enabled=true", [digest]);
    return result.rows[0] ? toPartner(result.rows[0]) : null;
  }
  async setEnabled(partnerId: string, enabled: boolean): Promise<void> {
    const result = await this.pool.query("UPDATE data_partners SET enabled=$2 WHERE partner_id=$1", [partnerId, enabled]);
    if (result.rowCount === 0) throw new Error(`Partner "${partnerId}" not found`);
    await this.recordAuditEvent(partnerId, enabled ? "enabled" : "disabled");
  }
  async rotateToken(partnerId: string): Promise<{ partner: PropertyDataPartner; token: string }> {
    const token = generatePartnerToken();
    const digest = partnerTokenDigest(token);
    // A single UPDATE ... RETURNING * both invalidates the old digest (overwritten, so the old
    // token stops authenticating the instant this resolves — no window where both work) and
    // issues the new one, so there's no separate SELECT-then-UPDATE race.
    const result = await this.pool.query("UPDATE data_partners SET token_digest=$2 WHERE partner_id=$1 RETURNING *", [partnerId, digest]);
    if (result.rowCount === 0) throw new Error(`Partner "${partnerId}" not found`);
    await this.recordAuditEvent(partnerId, "token_rotated");
    return { partner: toPartner(result.rows[0]), token };
  }
  async list(): Promise<readonly PropertyDataPartner[]> {
    const result = await this.pool.query("SELECT * FROM data_partners ORDER BY created_at ASC");
    return result.rows.map(toPartner);
  }
  async listWithStats(staleDays: number): Promise<readonly PropertyDataPartnerWithStats[]> {
    const result = await this.pool.query("SELECT * FROM data_partners ORDER BY created_at ASC");
    return result.rows.map(row => {
      const stats = toStats(row);
      return { ...toPartner(row), ...stats, stale: isStale(stats.latestObservationDate, staleDays) };
    });
  }
  async recordImportStats(partnerId: string, delta: ImportStatsDelta): Promise<void> {
    await this.pool.query(
      `UPDATE data_partners SET
         records_received = records_received + $2,
         records_accepted = records_accepted + $3,
         records_rejected = records_rejected + $4,
         records_updated = records_updated + $5,
         latest_observation_date = GREATEST(latest_observation_date, $6::timestamptz)
       WHERE partner_id=$1`,
      [partnerId, delta.received, delta.accepted, delta.rejected, delta.updated, delta.latestObservedAt]
    );
  }
  async setFeedConfig(partnerId: string, config: PartnerFeedConfigInput): Promise<PropertyDataPartner> {
    const result = await this.pool.query(
      `UPDATE data_partners SET feed_url=$2, feed_format=$3, schedule_enabled=$4, schedule_interval_minutes=$5
       WHERE partner_id=$1 RETURNING *`,
      [partnerId, config.feedUrl, config.feedFormat, config.scheduleEnabled, config.scheduleIntervalMinutes]
    );
    if (result.rowCount === 0) throw new Error(`Partner "${partnerId}" not found`);
    return toPartner(result.rows[0]);
  }
  async recordFeedAttempt(partnerId: string, outcome: { success: boolean; at: string }): Promise<void> {
    const result = await this.pool.query(
      `UPDATE data_partners SET
         last_attempt_at = $2::timestamptz,
         last_successful_run_at = CASE WHEN $3 THEN $2::timestamptz ELSE last_successful_run_at END,
         consecutive_failures = CASE WHEN $3 THEN 0 ELSE consecutive_failures + 1 END
       WHERE partner_id=$1`,
      [partnerId, outcome.at, outcome.success]
    );
    if (result.rowCount === 0) throw new Error(`Partner "${partnerId}" not found`);
  }
}
