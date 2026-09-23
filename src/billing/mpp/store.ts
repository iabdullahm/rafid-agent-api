import { Pool } from "pg";
import { Store } from "mppx";
import { ensureMppSchema } from "./sessions.js";

/**
 * Backing key-value storage for the official mppx SDK's own state — TIP-1034 payment-channel
 * records (highest accepted voucher, metered spend, deposit, settlement) and tempo/charge replay
 * markers. mppx requires an AtomicStore ("Session mutations must be linearizable across
 * instances so spent, highest-voucher, top-up, and close/finalization updates cannot race") —
 * the SDK's own Store.memory() is explicitly single-process only, which a serverless deployment
 * (Vercel: independent warm instances, no shared memory) cannot rely on.
 *
 * PostgresMppKv provides the raw string operations mppx's Store.redis() adapter wraps
 * (JSON/bigint encoding stays the SDK's own, via ox's Json). `update` is a real
 * read-modify-write transaction serialized per key with a transaction-scoped advisory lock, so
 * it is atomic even for a key that doesn't exist yet (a row lock alone could not guard an
 * INSERT race). The SDK guarantees the callback is synchronous and side-effect free, so running
 * it inside the transaction is safe.
 */
export interface MppKv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  del(key: string): Promise<void>;
  update<result>(key: string, fn: (current: string | null) => Store.Change<string, result>): Promise<result>;
}

export class PostgresMppKv implements MppKv {
  private get ready(): Promise<void> { return ensureMppSchema(this.pool); }
  constructor(private readonly pool: Pool) { void this.ready.catch(() => undefined); }

  async get(key: string): Promise<string | null> {
    await this.ready;
    const r = await this.pool.query<{ value: string }>("SELECT value FROM mpp_kv WHERE key = $1", [key]);
    return r.rows[0]?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.ready;
    await this.pool.query(
      "INSERT INTO mpp_kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
      [key, value]
    );
  }

  async del(key: string): Promise<void> {
    await this.ready;
    await this.pool.query("DELETE FROM mpp_kv WHERE key = $1", [key]);
  }

  async update<result>(key: string, fn: (current: string | null) => Store.Change<string, result>): Promise<result> {
    await this.ready;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 7424))", [key]);
      const r = await client.query<{ value: string }>("SELECT value FROM mpp_kv WHERE key = $1", [key]);
      const change = fn(r.rows[0]?.value ?? null);
      if (change.op === "set") {
        await client.query(
          "INSERT INTO mpp_kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
          [key, change.value]
        );
      } else if (change.op === "delete") {
        await client.query("DELETE FROM mpp_kv WHERE key = $1", [key]);
      }
      await client.query("COMMIT");
      return change.result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

/** Same contract in process memory — tests and local development only (loadMppConfig refuses
 *  MPP in production without a database). Operations are serialized per key with a promise
 *  chain so concurrent updates in one process behave like the Postgres implementation. */
export class MemoryMppKv implements MppKv {
  private readonly data = new Map<string, string>();
  private readonly locks = new Map<string, Promise<unknown>>();
  async get(key: string) { return this.data.get(key) ?? null; }
  async set(key: string, value: string) { this.data.set(key, value); }
  async del(key: string) { this.data.delete(key); }
  async update<result>(key: string, fn: (current: string | null) => Store.Change<string, result>): Promise<result> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    const run = previous.then(() => {
      const change = fn(this.data.get(key) ?? null);
      if (change.op === "set") this.data.set(key, change.value);
      else if (change.op === "delete") this.data.delete(key);
      return change.result;
    });
    this.locks.set(key, run.catch(() => undefined));
    return run;
  }
}

/** Wraps an MppKv in mppx's own Store.redis() adapter (string values, SDK-owned JSON/bigint
 *  encoding) and returns the SDK's AtomicStore type, with a namespace prefix per purpose. */
export function toMppxStore(kv: MppKv, keyPrefix: string): Store.AtomicStore {
  return Store.redis({
    get: key => kv.get(key),
    set: (key, value) => kv.set(key, value),
    del: key => kv.del(key),
    update: (key, fn) => kv.update(key, fn)
  }, { keyPrefix });
}
