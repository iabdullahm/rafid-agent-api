import assert from "node:assert/strict";
import test from "node:test";
import { capabilities } from "../src/domain/capabilities.js";

const names = ["compare_properties", "estimate_maintenance"];
for (const name of names) {
  test("Marketplace real executor smoke: " + name, async () => {
    const capability = capabilities.find(c => c.name === name);
    assert.ok(capability, "Missing capability");
    assert.equal(capability.sideEffects, false);
    assert.equal(capability.idempotent, true);
    const input = capability.input.parse(capability.example);
    const actual = await Promise.race([
      capability.execute(input),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Execution timeout")), 5000))
    ]);
    const valid = capability.output.safeParse(actual);
    assert.equal(valid.success, true, valid.success ? "" : JSON.stringify(valid.error.issues));
    assert.deepEqual(actual, capability.exampleOutput, "Review divergence from documented deterministic example");
  });
}
