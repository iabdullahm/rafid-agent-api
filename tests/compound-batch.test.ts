import assert from "node:assert/strict";
import { test } from "node:test";
import {
  companyDueDiligencePackInput,
  companyDueDiligencePackOutput,
  companyRiskBatchInput,
  portfolioScreenInput,
  procurementVendorShortlistInput
} from "../src/workflows/compound.js";
import { capabilities } from "../src/domain/capabilities.js";

const property = {
  propertyValue: 100_000,
  annualRent: 8_000
};

test("batch schemas accept CSV-only company and supplier requests", () => {
  const csv = "companyName,country\nExample Ltd,OM\nSecond Ltd,AE";
  assert.equal(companyRiskBatchInput.parse({ csv }).csv, csv);

  const supplierCsv = "companyName,crNumber\nExample Supplier,1234567\nSecond Supplier,7654321";
  assert.equal(procurementVendorShortlistInput.parse({ csv: supplierCsv }).csv, supplierCsv);
});

test("portfolio batch schema supports up to 100 properties", () => {
  const parsed = portfolioScreenInput.parse({ properties: Array.from({ length: 100 }, (_, index) => ({ ...property, name: `Unit ${index + 1}` })) });
  assert.equal(parsed.properties.length, 100);
  assert.throws(() => portfolioScreenInput.parse({ properties: Array.from({ length: 101 }, (_, index) => ({ ...property, name: `Unit ${index + 1}` })) }));
});


test("company due diligence pack is a single $2.50 canonical capability with strict bundle schemas", () => {
  const parsed = companyDueDiligencePackInput.parse({
    company: "Example Trading Ltd",
    domain: "example.com",
    country: "GB",
    purpose: "supplier_onboarding",
    depth: "standard"
  });
  assert.equal(parsed.company, "Example Trading Ltd");

  const capability = capabilities.find(c => c.name === "company_due_diligence_pack");
  assert.ok(capability);
  assert.equal(capability.price, 2.50);
  assert.equal(capability.path, "/risk/company-due-diligence-pack");
  assert.equal(capability.paymentProtocol, "x402");
  assert.ok(capability.preview);

  assert.equal(companyDueDiligencePackOutput.safeParse(capability.exampleOutput).success, true);
});
