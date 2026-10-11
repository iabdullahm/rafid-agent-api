import test from "node:test";
import assert from "node:assert/strict";
import { runPropertyAgent, rafidRequest } from "./agent.mjs";

test("orchestrates exactly three authenticated API calls", async () => {
  const calls = [];
  const fakeFetch = async (url, options) => {
    calls.push({ url, options });
    const data = url.endsWith("/compare")
      ? { sortedByNetYield: ["Apartment A", "Apartment B"] }
      : url.endsWith("/analyze")
      ? { annualNetIncome: 6150, netYield: 7.24 }
      : { estimatedAnnualMaintenance: 1105, monthlyReserve: 92.08 };
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, data }) };
  };
  const result = await runPropertyAgent({ key: "local-test-only", fetcher: fakeFetch });
  assert.equal(result.preferredProperty, "Apartment A");
  assert.equal(calls.length, 3);
  assert.ok(calls.every(c => c.options.headers["X-RapidAPI-Key"] === "local-test-only"));
  assert.equal(new Set(calls.map(c => c.options.headers["Idempotency-Key"])).size, 3);
});

test("rejects missing secret", async () => {
  await assert.rejects(rafidRequest("/test", {}, { key: "" }), /Missing RAPIDAPI_KEY/);
});

test("surfaces failed gateway responses", async () => {
  await assert.rejects(
    rafidRequest("/test", {}, {
      key: "local-test-only",
      fetcher: async () => ({ ok: false, status: 429, text: async () => '{"message":"quota exceeded"}' })
    }),
    /429/
  );
});
