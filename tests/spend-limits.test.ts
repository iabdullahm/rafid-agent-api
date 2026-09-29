import assert from "node:assert/strict";
import { test } from "node:test";
import { BillingEngine, MemoryBillingStore, loadBillingConfig } from "../src/billing/unified/index.js";

test("account and agent spend limits are enforced before a reservation", async () => {
  let now = new Date("2026-09-27T10:00:00.000Z");
  const store = new MemoryBillingStore();
  const config = loadBillingConfig({ API_CREDITS_ENABLED: "true" }, { nodeEnv: "test" });
  const engine = new BillingEngine({ config, store, priceUsd: () => 0.25, now: () => now });
  const account = await engine.createAccount({ name: "agent-org" });
  const created = await engine.createApiKey({ accountId: account.id, name: "research-agent" });
  await engine.addCredit({ accountId: account.id, amount: "10" });
  await engine.setAccountSpendLimits(account.id, { monthlyUsd: "0.50" });
  await engine.setApiKeySpendLimits(account.id, created.key.id, { dailyUsd: "0.25", monthlyUsd: "10" });

  const authenticated = await engine.authenticate(created.apiKey);
  assert.equal(authenticated.ok, true);
  if (!authenticated.ok) return;
  const input = { toolName: "test_tool", account: authenticated.account, key: authenticated.key, rails: ["api_credits"] as const, subscriptionFallback: false };
  const first = await engine.authorize({ ...input, requestId: "req-1" });
  assert.equal(first.kind, "authorized");
  if (first.kind !== "authorized") return;
  await engine.settle(first.authorization);

  const second = await engine.authorize({ ...input, requestId: "req-2" });
  assert.deepEqual(second, { kind: "spend_limit", scope: "api_key_daily", limitMicros: 250000, spentMicros: 250000 });

  now = new Date("2026-09-28T10:00:00.000Z");
  const nextDay = await engine.authorize({ ...input, requestId: "req-3" });
  assert.equal(nextDay.kind, "authorized");
});
