import assert from "node:assert/strict";
import { test } from "node:test";
import {
  companyRiskBatchInput,
  portfolioScreenInput,
  procurementVendorShortlistInput
} from "../src/workflows/compound.js";

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
