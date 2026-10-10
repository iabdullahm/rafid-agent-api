import assert from "node:assert/strict";
import test from "node:test";
import { capabilities } from "../src/domain/capabilities.js";

const EXPECTED_CAPABILITIES = 70;

test("Marketplace bulk audit: registry, schemas, outputs, pricing and execution policy", () => {
  const paths = new Set<string>();
  const names = new Set<string>();
  const findings: string[] = [];
  const rows = capabilities.map(c => {
    const issues: string[] = [];
    if (!c.name || !/^[a-z][a-z0-9_]*$/.test(c.name)) issues.push("invalid_name");
    if (!c.path || !c.path.startsWith("/") || c.path.includes("?")) issues.push("invalid_path");
    if (names.has(c.name)) issues.push("duplicate_name");
    if (paths.has(c.path)) issues.push("duplicate_path");
    names.add(c.name); paths.add(c.path);
    if (!c.input?.safeParse || !c.output?.safeParse) issues.push("schema_missing");
    if (typeof c.execute !== "function") issues.push("executor_missing");
    if (!Number.isFinite(c.price) || c.price < 0) issues.push("invalid_price");
    if (c.currency !== "USD") issues.push("unsupported_currency");
    if (typeof c.idempotent !== "boolean" || typeof c.sideEffects !== "boolean") issues.push("execution_policy_missing");
    const inputCheck = c.input.safeParse(c.example);
    if (!inputCheck.success) issues.push("example_input_invalid");
    const outputCheck = c.output.safeParse(c.exampleOutput);
    if (!outputCheck.success) issues.push("example_output_invalid: " + outputCheck.error.issues.map(i => i.path.join(".") + " " + i.message).join(" | "));
    if (typeof c.estimatedLatencyMs === "number" && (!Number.isFinite(c.estimatedLatencyMs) || c.estimatedLatencyMs <= 0)) issues.push("invalid_latency_estimate");
    findings.push(...issues.map(issue => c.name + ": " + issue));
    return { name: c.name, path: c.path, price: c.price, currency: c.currency,
      latencyEstimateMs: c.estimatedLatencyMs ?? null, sideEffects: c.sideEffects,
      hasLimitations: (c.limitations?.length ?? 0) > 0,
      inputValid: inputCheck.success, outputValid: outputCheck.success, issues };
  });
  const report = {
    count: rows.length, expected: EXPECTED_CAPABILITIES,
    staticAuditOnly: true,
    actualProviderCalls: 0,
    realLatencyMeasured: false,
    providerReadinessValidated: false,
    realCostVerified: false,
    rapidApiSubscriptionTested: false,
    errors: findings.length, rows
  };
  process.stdout.write("MARKETPLACE_BULK_AUDIT=" + JSON.stringify(report) + "\n");
  assert.equal(rows.length, EXPECTED_CAPABILITIES, "Registry count changed: review marketplace release inventory");
  assert.deepEqual(findings, [], "Bulk audit findings: " + findings.join("; "));
});
