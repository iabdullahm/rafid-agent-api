import { Pool } from "pg";

/**
 * Single-use enforcement for L402 tokens. A standard L402 token is reusable until it expires; Rafid
 * sells ONE call per payment (the same economics as x402), so each paid token is claimed
 * atomically before the capability runs.
 *
 * Lifecycle: claim() → the capability runs → the response succeeds (the claim stays as
 * "redeemed" forever) or fails (release() frees the token so the payer can retry the call they
 * already paid for, e.g. after fixing a 400 validation error).
 */
export interface L402RedemptionStore {
  /** true = this caller now owns the token; false = already redeemed or currently in flight. */
  claim(paymentHashHex: string, toolName: string): Promise<boolean>;
  markRedeemed(paymentHashHex: string): Promise<void>;
  release(paymentHashHex: string): Promise<void>;
}

/** Tests/local dev only. loadConfig() refuses L402 in production without a database, because an
 *  in-process set can't stop a replay against a different serverless instance. */
export class MemoryL402RedemptionStore implements L402RedemptionStore {
  private readonly claimed = new Map<string, "in_flight" | "redeemed">();
  async claim(hash: string): Promise<boolean> {
    if (this.claimed.has(hash)) return false;
    this.claimed.set(hash, "in_flight");
    return true;
  }
  async markRedeemed(hash: string): Promise<void> { this.claimed.set(hash, "redeemed"); }
  async release(hash: string): Promise<void> {
    if (this.claimed.get(hash) === "in_flight") this.claimed.delete(hash);
  }
  status(hash: string): "in_flight" | "redeemed" | undefined { return this.claimed.get(hash); }
}

/** Table `rafid_l402_redemptions`, auto-created like every other store here. The PRIMARY KEY on
 *  payment_hash makes the claim atomic across every instance: two concurrent requests presenting
 *  the same token race on one INSERT and exactly one wins. A stale "in_flight" row (the function
 *  was killed mid-call) becomes claimable again after IN_FLIGHT_TIMEOUT so a paid token is never
 *  stranded. */
export class PostgresL402RedemptionStore implements L402RedemptionStore {
  private readonly pool: Pool;
  private readonly ready: Promise<void>;
  static readonly IN_FLIGHT_TIMEOUT = "5 minutes";

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 3, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
    this.pool.on("error", () => process.stderr.write("L402 redemption store database connection failure\n"));
    this.ready = this.pool.query(
      `CREATE TABLE IF NOT EXISTS rafid_l402_redemptions (
        payment_hash text PRIMARY KEY,
        tool_name text NOT NULL,
        status text NOT NULL,
        claimed_at timestamptz NOT NULL DEFAULT now(),
        redeemed_at timestamptz
      )`
    ).then(() => undefined);
  }

  async claim(hash: string, toolName: string): Promise<boolean> {
    await this.ready;
    const result = await this.pool.query(
      `INSERT INTO rafid_l402_redemptions (payment_hash, tool_name, status) VALUES ($1, $2, 'in_flight')
       ON CONFLICT (payment_hash) DO UPDATE SET status = 'in_flight', claimed_at = now(), tool_name = EXCLUDED.tool_name
         WHERE rafid_l402_redemptions.status = 'in_flight' AND rafid_l402_redemptions.claimed_at < now() - interval '${PostgresL402RedemptionStore.IN_FLIGHT_TIMEOUT}'
       RETURNING payment_hash`,
      [hash, toolName]
    );
    return (result.rowCount ?? 0) === 1;
  }

  async markRedeemed(hash: string): Promise<void> {
    await this.ready;
    await this.pool.query(`UPDATE rafid_l402_redemptions SET status = 'redeemed', redeemed_at = now() WHERE payment_hash = $1`, [hash]);
  }

  async release(hash: string): Promise<void> {
    await this.ready;
    await this.pool.query(`DELETE FROM rafid_l402_redemptions WHERE payment_hash = $1 AND status = 'in_flight'`, [hash]);
  }
}
