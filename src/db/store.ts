import { Pool, type PoolClient } from "pg";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { schema } from "./schema.js";
import { ApiError } from "../utils/errors.js";
import type { CapabilityName } from "../billing/catalog.js";
const uuid = z.uuid();
const limits = z.object({ name: z.string().trim().min(1).max(120), requestsPerMinute: z.number().int().min(1).max(1000000), monthlyQuota: z.number().int().min(1).max(1000000000) });
export type Principal = { customerId: string; keyId: string };
export const keyDigest = (key: string) => createHash("sha256").update(key).digest("hex");
export class CustomerStore {
  readonly pool: Pool;
  constructor(url: string) {
    this.pool = new Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 5000, statement_timeout: 10000, idle_in_transaction_session_timeout: 10000 });
    this.pool.on("error", () => process.stderr.write("Database connection failure\n"));
  }
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try { await c.query("BEGIN"); const result = await fn(c); await c.query("COMMIT"); return result; }
    catch (error) { await c.query("ROLLBACK").catch(() => {}); throw error; }
    finally { c.release(); }
  }
  async migrate() {
    await this.transaction(async c => {
      await c.query("SELECT pg_advisory_xact_lock(74382001)");
      await c.query("CREATE TABLE IF NOT EXISTS rafid_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      const existing = await c.query("SELECT version FROM rafid_migrations WHERE version=1");
      if (!existing.rowCount) { await c.query(schema); await c.query("INSERT INTO rafid_migrations(version) VALUES(1)"); }
    });
  }
  async ready() { await this.pool.query("SELECT version FROM rafid_migrations WHERE version=1").then(r => { if (!r.rowCount) throw new Error("Migration required"); }); }
  async createCustomer(input: z.input<typeof limits>) {
    const p = limits.parse(input);
    const id = randomUUID();
    await this.pool.query("INSERT INTO rafid_customers(id,name,requests_per_minute,monthly_quota) VALUES($1,$2,$3,$4)", [id,p.name,p.requestsPerMinute,p.monthlyQuota]);
    return { id, ...p };
  }
  async issueKey(customerId: string, label: string) {
    uuid.parse(customerId); z.string().trim().min(1).max(120).parse(label);
    const key = "rafid_" + randomBytes(32).toString("hex");
    const keyId = randomUUID();
    await this.transaction(async c => {
      const customer = await c.query("SELECT active FROM rafid_customers WHERE id=$1 FOR UPDATE", [customerId]);
      if (!customer.rows[0]?.active) throw new ApiError(404,"CUSTOMER_NOT_FOUND","Active customer not found");
      await c.query("INSERT INTO rafid_keys(id,customer_id,digest,label) VALUES($1,$2,$3,$4)", [keyId,customerId,keyDigest(key),label.trim()]);
    });
    return { customerId, keyId, key };
  }
  async revokeKey(customerId: string, keyId: string) {
    uuid.parse(customerId); uuid.parse(keyId);
    return this.transaction(async c => {
      await c.query("SELECT id FROM rafid_customers WHERE id=$1 FOR UPDATE", [customerId]);
      const result = await c.query("UPDATE rafid_keys SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE customer_id=$1 AND id=$2 RETURNING id", [customerId,keyId]);
      if (!result.rowCount) throw new ApiError(404,"KEY_NOT_FOUND","Key not found for customer");
    });
  }
  async setActive(customerId: string, active: boolean) {
    uuid.parse(customerId);
    const r = await this.pool.query("UPDATE rafid_customers SET active=$2 WHERE id=$1 RETURNING id", [customerId,active]);
    if (!r.rowCount) throw new ApiError(404,"CUSTOMER_NOT_FOUND","Customer not found");
  }
  async authenticate(key: string): Promise<Principal> {
    const r = await this.pool.query("SELECT k.id,k.customer_id FROM rafid_keys k JOIN rafid_customers c ON c.id=k.customer_id WHERE k.digest=$1 AND k.revoked_at IS NULL AND c.active", [keyDigest(key)]);
    if (!r.rowCount) throw new ApiError(401,"UNAUTHORIZED","A valid X-API-Key header is required");
    return { customerId: r.rows[0].customer_id, keyId: r.rows[0].id };
  }
  async admit(p: Principal, requestId: string, capability: CapabilityName) {
    const result = await this.transaction(async c => {
      const customer = (await c.query("SELECT * FROM rafid_customers WHERE id=$1 FOR UPDATE", [p.customerId])).rows[0];
      const key = await c.query("SELECT id FROM rafid_keys WHERE customer_id=$1 AND id=$2 AND revoked_at IS NULL", [p.customerId,p.keyId]);
      if (!customer?.active || !key.rowCount) throw new ApiError(401,"UNAUTHORIZED","A valid X-API-Key header is required");
      // UTC boundaries from database time, evaluated after acquiring the customer lock.
      const windows = (await c.query("SELECT date_trunc('minute',clock_timestamp(),'UTC') AS minute, date_trunc('month',clock_timestamp(),'UTC') AS month")).rows[0];
      await c.query("INSERT INTO rafid_counters VALUES($1,$2,0,$3,0) ON CONFLICT(customer_id) DO NOTHING", [p.customerId,windows.minute,windows.month]);
      await c.query("UPDATE rafid_counters SET minute_count=CASE WHEN minute_start=$2 THEN minute_count ELSE 0 END, month_count=CASE WHEN month_start=$3 THEN month_count ELSE 0 END, minute_start=$2,month_start=$3 WHERE customer_id=$1", [p.customerId,windows.minute,windows.month]);
      const counts = (await c.query("SELECT * FROM rafid_counters WHERE customer_id=$1", [p.customerId])).rows[0];
      const code = counts.month_count >= customer.monthly_quota ? "QUOTA_EXCEEDED" : counts.minute_count >= customer.requests_per_minute ? "RATE_LIMITED" : null;
      await c.query("INSERT INTO rafid_usage(request_id,customer_id,key_id,capability,admitted,status,duration_ms) VALUES($1,$2,$3,$4,$5,$6,$7)", [requestId,p.customerId,p.keyId,capability,!code,code ? 429 : null,null]);
      if (!code) await c.query("UPDATE rafid_counters SET minute_count=minute_count+1,month_count=month_count+1 WHERE customer_id=$1", [p.customerId]);
      return code;
    });
    if (result) throw new ApiError(429,result,result === "RATE_LIMITED" ? "Per-minute request limit exceeded" : "Monthly request quota exceeded");
  }
  async complete(p: Principal, requestId: string, status: number, durationMs: number) {
    await this.pool.query("UPDATE rafid_usage SET status=$3,duration_ms=$4 WHERE request_id=$1 AND customer_id=$2 AND key_id=$5 AND duration_ms IS NULL", [requestId,p.customerId,status,Math.max(0,Math.round(durationMs)),p.keyId]);
  }
  async usage(customerId: string) {
    uuid.parse(customerId);
    return (await this.pool.query("SELECT request_id,key_id,capability,created_at,admitted,status,duration_ms FROM rafid_usage WHERE customer_id=$1 ORDER BY created_at DESC LIMIT 100", [customerId])).rows;
  }
  async close() { await this.pool.end(); }
}
