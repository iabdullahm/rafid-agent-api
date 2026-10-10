import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { Server } from "node:http";
import { z } from "zod";
import type { AgentCapability } from "../src/domain/capabilities.js";
import { createRapidApiHandler } from "../src/rapidapi/gateway.js";
import { rapidApiRequestFingerprint } from "../src/rapidapi/idempotency.js";

test("HTTP gateway: execute once, replay, conflict, failure and auth checks", async () => {
  const records = new Map<string, { fingerprint: string; body?: unknown; status: string }>();
  let executions = 0;
  let dbFailure = false;
  const repository = {
    claim: async (subscriber: string, key: string, fingerprint: string) => {
      if (dbFailure) throw new Error("database unavailable");
      const identity = subscriber + ":" + key;
      const item = records.get(identity);
      if (item) {
        if (item.fingerprint !== fingerprint) return { kind: "conflict" } as const;
        if (item.status === "completed") return { kind: "replay", requestId: identity, status: 200, body: item.body } as const;
        return { kind: "pending", requestId: identity } as const;
      }
      records.set(identity, { fingerprint, status: "processing" });
      return { kind: "claimed", requestId: identity } as const;
    },
    complete: async (id: string, _status: number, body: unknown) => {
      const row = records.get(id); assert.ok(row); row.status = "completed"; row.body = body;
    },
    markFailed: async (id: string) => { const row = records.get(id); if (row) row.status = "failed"; }
  };
  const capability = {
    name: "test_capability", path: "/test", input: z.object({ value: z.string() }),
    sideEffects: false,
    execute: async (input: unknown) => { executions++; return input; }
  } as unknown as AgentCapability;
  const app = express();
  app.post("/test", express.json(), createRapidApiHandler(capability, {
    secret: () => "gateway-test-secret",
    enabled: () => true,
    repository: repository as never
  }));
  const server: Server = app.listen(0, "127.0.0.1");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/test`;
    const send = (body: unknown, key: string, secret = "gateway-test-secret") =>
      fetch(url, { method: "POST", headers: {
        "content-type": "application/json", "x-rapidapi-proxy-secret": secret,
        "x-rapidapi-user": "test-subscriber", "idempotency-key": key
      }, body: JSON.stringify(body) });
    assert.equal((await send({ value: "a" }, "one", "wrong")).status, 401);
    assert.equal(executions, 0);
    const first = await send({ value: "a" }, "one");
    assert.equal(first.status, 200);
    const expected = await first.json();
    const replay = await send({ value: "a" }, "one");
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get("idempotent-replay"), "true");
    assert.deepEqual(await replay.json(), expected);
    assert.equal((await send({ value: "b" }, "one")).status, 409);
    assert.equal(executions, 1);
    dbFailure = true;
    assert.equal((await send({ value: "c" }, "new")).status, 503);
    assert.equal(executions, 1);
    assert.notEqual(rapidApiRequestFingerprint("test_capability", { value: "a" }),
      rapidApiRequestFingerprint("test_capability", { value: "b" }));
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
