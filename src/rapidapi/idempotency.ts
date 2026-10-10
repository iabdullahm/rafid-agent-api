import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";

type RequestState = "processing" | "completed" | "failed";
type ClaimResult =
  | { kind: "claimed"; requestId: string }
  | { kind: "pending"; requestId: string }
  | { kind: "replay"; requestId: string; status: number; body: unknown }
  | { kind: "conflict" }
  | { kind: "failed"; requestId: string };

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

// Call only with validated input. JSON object keys must be normalized upstream
// to achieve semantic rather than byte-identical request fingerprints.
export function rapidApiRequestFingerprint(capability: string, validatedInput: unknown): string {
  return sha256(JSON.stringify({ capability, input: validatedInput }));
}

// Claims are atomic under the UNIQUE(subscriber_id,idempotency_key) constraint.
// There is deliberately no in-flight takeover: an unknown outcome cannot be
// safely re-executed until an operator-defined recovery strategy is implemented.
export class RapidApiIdempotencyStore {
  constructor(private readonly pool: Pool) {}

  async claim(subscriberId: string, idempotencyKey: string, fingerprint: string): Promise<ClaimResult> {
    if (!subscriberId || subscriberId.length > 255 || !idempotencyKey ||
        idempotencyKey.length > 255 || !/^[0-9a-f]{64}$/.test(fingerprint)) {
      throw new Error("Invalid idempotency identifiers");
    }
    const requestId = randomUUID();
    const inserted = await this.pool.query(
      `INSERT INTO rafid_rapidapi_requests
        (id,subscriber_id,idempotency_key,capability,request_fingerprint,status)
        VALUES ($1,$2,$3,'company_due_diligence',$4,'processing')
        ON CONFLICT (subscriber_id,idempotency_key) DO NOTHING
        RETURNING id`,
      [requestId, subscriberId, idempotencyKey, fingerprint]
    );
    if (inserted.rowCount) return { kind: "claimed", requestId };
    const existing = await this.pool.query<{
      id: string; request_fingerprint: string; status: RequestState;
      response_status: number | null; response_body: unknown;
    }>(`SELECT id,request_fingerprint,status,response_status,response_body
         FROM rafid_rapidapi_requests WHERE subscriber_id=$1 AND idempotency_key=$2`,
      [subscriberId, idempotencyKey]);
    const row = existing.rows[0];
    if (!row) throw new Error("Idempotency claim race: retry required");
    if (row.request_fingerprint !== fingerprint) return { kind: "conflict" };
    if (row.status === "completed") {
      if (row.response_status === null || row.response_body === null) throw new Error("Incomplete replay record");
      return { kind: "replay", requestId: row.id, status: row.response_status, body: row.response_body };
    }
    if (row.status === "failed") return { kind: "failed", requestId: row.id };
    return { kind: "pending", requestId: row.id };
  }

  async complete(requestId: string, httpStatus: number, body: unknown): Promise<void> {
    if (!Number.isInteger(httpStatus) || httpStatus < 200 || httpStatus > 599 ||
        body === undefined || body === null) throw new Error("Invalid persisted response");
    const result = await this.pool.query(
      `UPDATE rafid_rapidapi_requests SET status='completed',response_status=$2,
         response_body=$3::jsonb,updated_at=clock_timestamp()
         WHERE id=$1 AND status='processing' RETURNING id`,
      [requestId, httpStatus, JSON.stringify(body)]
    );
    if (result.rowCount !== 1) throw new Error("Unable to complete idempotency claim");
  }

  // Do not retry automatically: execution may have had external side effects.
  async markFailed(requestId: string): Promise<void> {
    await this.pool.query(
      `UPDATE rafid_rapidapi_requests SET status='failed',
         updated_at=clock_timestamp()
         WHERE id=$1 AND status='processing'`,
      [requestId]
    );
  }
}
