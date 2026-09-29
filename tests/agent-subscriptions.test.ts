import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSubscriptionPlans } from "../src/api/agent.js";
import { loadBillingConfig } from "../src/billing/unified/config.js";
import { BillingEngine } from "../src/billing/unified/engine.js";
import { MemoryBillingStore } from "../src/billing/unified/memoryStore.js";
import { hashApiKey } from "../src/billing/unified/apiKeys.js";

test("subscription plans expose account scope, monthly dollars and call allowance", () => {
  const billing = loadBillingConfig({ API_CREDITS_ENABLED: "true", SUBSCRIPTIONS_ENABLED: "true" }, { nodeEnv: "test" });
  const discovery = buildSubscriptionPlans({ x402Enabled: false, x402Network: "base", billing });
  assert.equal(discovery.enabled, true);
  assert.equal(discovery.assignment, "account-scoped");
  assert.equal((discovery.plans as any[]).find(p => p.id === "developer")?.allowance.monthlyIncludedCalls, 1000);
});

test("subscription call allowance is enforced and rolls into usage reporting", async () => {
  const billing = loadBillingConfig({
    API_CREDITS_ENABLED: "false",
    SUBSCRIPTIONS_ENABLED: "true",
    BILLING_PLANS_JSON: JSON.stringify({ tiny: { name: "Tiny", monthlyIncludedUsd: "10", monthlyIncludedCalls: 1 } })
  }, { nodeEnv: "test" });
  const store = new MemoryBillingStore();
  const engine = new BillingEngine({ config: billing, store, priceUsd: () => 0.25 });
  const account = await engine.createAccount({ name: "Agent Company" });
  const created = await engine.createApiKey({ accountId: account.id, name: "agent" });
  await engine.assignSubscription({ accountId: account.id, plan: "tiny" });

  const key = (await store.findApiKeyByHash(hashApiKey(created.apiKey)))!.key;
  const first = await engine.authorize({ toolName: "test_tool", account, key, rails: ["subscription"], subscriptionFallback: false, requestId: "r1" });
  assert.equal(first.kind, "authorized");
  if (first.kind === "authorized") await engine.settle(first.authorization);
  const current = await engine.store.getSubscription(account.id, new Date());
  assert.equal(current?.usedCalls, 1);
  assert.equal(current?.includedCalls, 1);

  const auth = await engine.authenticate(created.apiKey);
  assert.equal(auth.ok, true);
  if (!auth.ok) return;
  const second = await engine.authorize({ toolName: "test_tool", account: auth.account, key: auth.key, rails: ["subscription"], subscriptionFallback: false, requestId: "r2" });
  assert.equal(second.kind, "insufficient");
  assert.equal((await engine.usageView(account.id)).subscription?.usedCalls, 1);
});
