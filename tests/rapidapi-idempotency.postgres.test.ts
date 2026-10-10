import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { RapidApiIdempotencyStore, rapidApiRequestFingerprint } from "../src/rapidapi/idempotency.js";

// Explicitly opt in to database integration tests. Requires a dedicated staging database
// whose rafid_rapidapi_requests table was initialized using migration 002.
// Never supply credentials to GitHub Actions or place DB URLs in repository files.
const connectionString = process.env.MARKETPLACE_TEST_DATABASE_URL;
test("Neon/Postgres: concurrent claim, pending, replay, conflict and isolation", { skip: !connectionString }, async () => {
  const pool = new Pool({ connectionString, max: 5, connectionTimeoutMillis: 5000 });
  const store = new RapidApiIdempotencyStore(pool);
  const suffix = randomUUID();
  const subscriber = `integration-${suffix}`;
  const subscriber2 = `integration-other-${suffix}`;
  const key = `idempotency-${suffix}`;
  const fingerprint = rapidApiRequestFingerprint("company_due_diligence", { company: "Test" });
  try {
    const results = await Promise.all(Array.from({ length: 8 }, () => store.claim(subscriber, key, fingerprint)));
    assert.equal(results.filter(x => x.kind === "claimed").length, 1);
    assert.equal(results.filter(x => x.kind === "pending").length, 7);
    const claimed = results.find(x => x.kind === "claimed");
    assert.ok(claimed && claimed.kind === "claimed");
    assert.deepEqual(await store.claim(subscriber, key, rapidApiRequestFingerprint("company_due_diligence", { company: "Changed" })), { kind: "conflict" });
    await store.complete(claimed.requestId, 200, { success: true });
    assert.deepEqual(await store.claim(subscriber, key, fingerprint), {
      kind: "replay", requestId: claimed.requestId, status: 200, body: { success: true }
    });
    const isolated = await store.claim(subscriber2, key, fingerprint);
    assert.equal(isolated.kind, "claimed");
  } finally {
    await pool.query("DELETE FROM rafid_rapidapi_requests WHERE subscriber_id = ANY($1::text[])", [[subscriber, subscriber2]]);
    await pool.end();
  }
});
