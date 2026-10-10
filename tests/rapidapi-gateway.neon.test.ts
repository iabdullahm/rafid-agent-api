import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { z } from "zod";
import type { AgentCapability } from "../src/domain/capabilities.js";
import { createRapidApiHandler } from "../src/rapidapi/gateway.js";
import { RapidApiIdempotencyStore } from "../src/rapidapi/idempotency.js";

const connection = process.env.MARKETPLACE_TEST_DATABASE_URL;
test("real Neon HTTP: concurrent calls, replay, conflict, failure, isolation", { skip: !connection }, async () => {
  if (!connection) throw new Error("Missing isolated TEST database URL");
  const pool = new Pool({ connectionString: connection, max: 12, connectionTimeoutMillis: 10000 });
  const repository = new RapidApiIdempotencyStore(pool);
  const prefix = "e2e-" + randomUUID();
  let executions = 0;
  let resolveExecution: (() => void) | undefined;
  let begunExecution: (() => void) | undefined;
  const started = new Promise<void>(r => { begunExecution = r; });
  const gate = new Promise<void>(r => { resolveExecution = r; });
  const capability = {
    name: "analyze_property", path: "/test",
    input: z.object({ value: z.string() }),
    sideEffects: false,
    execute: async (input: unknown) => {
      executions++;
      if (executions === 1) { begunExecution?.(); await gate; }
      return input;
    }
  } as unknown as AgentCapability;
  const app = express();
  app.post("/test", express.json(), createRapidApiHandler(capability, {
    secret: () => "only-test-secret",
    enabled: () => true,
    repository: { claim: (...args: Parameters<RapidApiIdempotencyStore["claim"]>) => forceDbFailure ? Promise.reject(new Error("Simulated DB outage")) : repository.claim(...args), complete: (id: string, status: number, body: unknown) => repository.complete(id, status, body), markFailed: (id: string) => repository.markFailed(id) } as unknown as RapidApiIdempotencyStore
  }));
  let server: ReturnType<typeof app.listen> | undefined;
  let forceDbFailure = false;
  try {
    const alive = await pool.query("SELECT to_regclass('public.rafid_rapidapi_requests') AS name");
    assert.ok(alive.rows[0]?.name, "Missing test schema: public.rafid_rapidapi_requests");
    server = await new Promise((resolve, reject) => {
      const instance = app.listen(0, "127.0.0.1", () => resolve(instance));
      instance.once("error", reject);
    });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/test`;
    const send = (subscriber: string, key: string, value: string, secret = "only-test-secret") =>
      fetch(url, { method: "POST", headers: {
        "content-type": "application/json", "x-rapidapi-proxy-secret": secret,
        "x-rapidapi-user": subscriber, "idempotency-key": key
      }, body: JSON.stringify({ value }) });
    const subscriber = prefix + "-subscriber";
    assert.equal((await send(subscriber, prefix + "-auth", "a", "wrong")).status, 401);
    const first = send(subscriber, prefix + "-one", "a");
    await started;
    const pending = await Promise.all(Array.from({length: 7}, () => send(subscriber, prefix + "-one", "a")));
    assert.ok(pending.every(r => r.status === 409));
    assert.equal(executions, 1);
    resolveExecution?.();
    const firstResponse = await first;
    assert.equal(firstResponse.status, 200);
    const savedBody = await firstResponse.json();
    const replay = await send(subscriber, prefix + "-one", "a");
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get("idempotent-replay"), "true");
    assert.deepEqual(await replay.json(), savedBody);
    assert.equal((await send(subscriber, prefix + "-one", "different")).status, 409);
    assert.equal((await send(subscriber + "-other", prefix + "-one", "a")).status, 200);
    assert.equal(executions, 2);
    forceDbFailure = true;
    assert.equal((await send(subscriber, prefix + "-db-down", "a")).status, 503);
  } finally {
    resolveExecution?.();
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve()));
    await pool.query("DELETE FROM rafid_rapidapi_requests WHERE subscriber_id LIKE $1", [prefix + "%"]).catch(() => {});
    await pool.end().catch(() => {});
  }
});
