import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCapabilitiesRegistry } from "../src/api/agent.js";

test("agent discovery exposes compact purchase and execution contracts", () => {
  const supplier = buildCapabilitiesRegistry({ x402Enabled: true, x402Network: "base" }).find(tool => tool.name === "supplier_due_diligence_report");
  assert.ok(supplier);
  assert.equal(supplier.price, 1.25);
  assert.equal(supplier.currency, "USD");
  assert.deepEqual(supplier.payment, ["x402"]);
  assert.equal(supplier.estimated_latency_ms, 8000);
  assert.ok(supplier.requires.includes("company_name"));
  assert.equal(supplier.returns, "structured_report");
});
