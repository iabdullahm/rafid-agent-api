import type { Pool } from "pg";
import type { PartnerFeedCredentialConfig, PartnerFeedCredentialRepository, SetPartnerFeedCredentialInput } from "../domain/oman/partnerFeedCredentials.js";

/**
 * PostgreSQL-backed PartnerFeedCredentialRepository (`partner_feed_credentials` — migration
 * version 4, src/db/partnerFeedSchema.ts). Shares the same `Pool` as every other partner-related
 * repository rather than opening its own — see PostgresPartnerRepository's own doc comment for why.
 * Stores only a credential's SHAPE (auth type, header name, secret REFERENCE) — never a secret
 * value; see partnerFeedCredentials.ts's doc comment for the full reasoning.
 */
export class PostgresPartnerFeedCredentialRepository implements PartnerFeedCredentialRepository {
  readonly name = "PostgreSQL partner_feed_credentials";
  constructor(private readonly pool: Pool) {}

  async setCredential(partnerId: string, input: SetPartnerFeedCredentialInput): Promise<PartnerFeedCredentialConfig> {
    const result = await this.pool.query(
      `INSERT INTO partner_feed_credentials (partner_id, auth_type, secret_ref, header_name, updated_at)
       VALUES ($1,$2,$3,$4,now())
       ON CONFLICT (partner_id) DO UPDATE SET auth_type=EXCLUDED.auth_type, secret_ref=EXCLUDED.secret_ref, header_name=EXCLUDED.header_name, updated_at=now()
       RETURNING *`,
      [partnerId, input.authType, input.secretRef ?? null, input.headerName ?? null]
    );
    return toConfig(result.rows[0]);
  }
  async getCredential(partnerId: string): Promise<PartnerFeedCredentialConfig | null> {
    const result = await this.pool.query("SELECT * FROM partner_feed_credentials WHERE partner_id=$1", [partnerId]);
    return result.rows[0] ? toConfig(result.rows[0]) : null;
  }
}

function toConfig(row: Record<string, unknown>): PartnerFeedCredentialConfig {
  return {
    partnerId: row.partner_id as string,
    authType: row.auth_type as PartnerFeedCredentialConfig["authType"],
    secretRef: (row.secret_ref as string | null) ?? null,
    headerName: (row.header_name as string | null) ?? null
  };
}
