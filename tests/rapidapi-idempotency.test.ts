import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { RapidApiIdempotencyStore, rapidApiRequestFingerprint } from "../src/rapidapi/idempotency.js";

test("request fingerprint is deterministic and distinguishes capability input", () => {
  const a = rapidApiRequestFingerprint("company_due_diligence", { company: "A" });
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(a, rapidApiRequestFingerprint("company_due_diligence", { company: "A" }));
  assert.notEqual(a, rapidApiRequestFingerprint("company_due_diligence", { company: "B" }));
});

test("atomic insert claims an unused subscriber key", async () => {
  let calls = 0;
  const pool = { query: async (sql: string) => {
    calls++;
    assert.match(sql, /ON CONFLICT \(subscriber_id,idempotency_key\) DO NOTHING/);
    return { rowCount: 1 };
  } } as unknown as Pool;
  const result = await new RapidApiIdempotencyStore(pool).claim("consumer-a", "key-123", "a".repeat(64));
  assert.equal(result.kind, "claimed");
  assert.equal(calls, 1);
});

test("duplicate with changed payload returns conflict", async () => {
  const pool = { query: async (_sql: string) => {
    if (_sql.startsWith("INSERT")) return { rowCount: 0 };
    return { rows: [{ id: "existing", capability: "company_due_diligence", request_fingerprint: "b".repeat(64), status: "completed", response_status: 200, response_body: { ok: true } }] };
  } } as unknown as Pool;
  const result = await new RapidApiIdempotencyStore(pool).claim("consumer-a", "key-123", "a".repeat(64));
  assert.equal(result.kind, "conflict");
});

test("identical completed duplicate replays prior response", async () => {
  const pool = { query: async (sql: string) => {
    if (sql.startsWith("INSERT")) return { rowCount: 0 };
    return { rows: [{ id: "existing", capability: "company_due_diligence", request_fingerprint: "a".repeat(64), status: "completed", response_status: 200, response_body: { success: true } }] };
  } } as unknown as Pool;
  const result = await new RapidApiIdempotencyStore(pool).claim("consumer-a", "key-123", "a".repeat(64));
  assert.deepEqual(result, { kind: "replay", requestId: "existing", status: 200, body: { success: true } });
});

test("identical in-flight duplicate remains pending", async () => {
  const pool = { query: async (sql: string) => {
    if (sql.startsWith("INSERT")) return { rowCount: 0 };
    return { rows: [{ id: "existing", capability: "company_due_diligence", request_fingerprint: "a".repeat(64), status: "processing", response_status: null, response_body: null }] };
  } } as unknown as Pool;
  const result = await new RapidApiIdempotencyStore(pool).claim("consumer-a", "key-123", "a".repeat(64));
  assert.deepEqual(result, { kind: "pending", requestId: "existing" });
});
