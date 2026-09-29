import assert from "node:assert/strict";
import { test } from "node:test";
import { capabilities } from "../src/domain/capabilities.js";
import { companyDueDiligenceInput } from "../src/schemas/companyDueDiligenceInputs.js";
import { companyDueDiligenceOutput } from "../src/schemas/companyDueDiligenceOutputs.js";
import { COMPANY_DUE_DILIGENCE_EXAMPLE_OUTPUT } from "../src/domain/examples/companyDueDiligenceExample.js";

const capability = capabilities.find(c => c.name === "company_due_diligence")!;

test("company_due_diligence is a registry-native $1.50 capability with a schema-valid example", async () => {
  assert.equal(capability.path, "/risk/company-due-diligence");
  assert.equal(capability.price, 1.5);
  assert.equal(capability.category, "risk_intelligence");
  assert.equal(capability.paymentProtocol, "x402");
  assert.equal(companyDueDiligenceInput.safeParse(capability.example).success, true);
  assert.equal(companyDueDiligenceOutput.safeParse(capability.exampleOutput).success, true);
  const result = await capability.execute(capability.example);
  assert.equal(companyDueDiligenceOutput.safeParse(result).success, true);
  assert.deepEqual(capability.exampleOutput, COMPANY_DUE_DILIGENCE_EXAMPLE_OUTPUT);
});

test("company_due_diligence input is strict and rejects SSRF-shaped domains", () => {
  assert.equal(companyDueDiligenceInput.safeParse({ company: "Example Ltd", purpose: "vendor_review", extra: true }).success, false);
  for (const domain of ["localhost", "127.0.0.1", "http://127.0.0.1", "http://user:pass@example.com"]) {
    assert.equal(companyDueDiligenceInput.safeParse({ company: "Example Ltd", domain }).success, false, domain);
  }
  assert.equal(companyDueDiligenceInput.parse({ company: "Example Ltd" }).purpose, "general_due_diligence");
});

test("free preview exposes coverage and price metadata only, never paid findings", async () => {
  const preview = await capability.preview!(capability.example);
  assert.equal(preview.capability, "company_due_diligence");
  assert.ok(preview.preview.availableSections?.includes("riskScore"));
  for (const secret of ["redFlags", "recommendation", "decision", "sanctions", "riskLevel"]) {
    assert.equal(Object.prototype.hasOwnProperty.call(preview.preview, secret), false, `preview leaked ${secret}`);
  }
});
