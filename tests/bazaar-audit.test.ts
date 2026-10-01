import assert from "node:assert/strict";
import { test } from "node:test";
import { capabilities } from "../src/domain/capabilities.js";
import { discoveryDeclaration } from "../src/billing/x402.js";
import { validateDiscoveryExtensionSpec } from "@x402/extensions/bazaar";

const HERO_NAMES = [
  "company_due_diligence", "business_risk_score", "invoice_anomaly_check",
  "analyze_oman_property", "analyze_property", "vehicle_value_estimate",
  "shipping_cost_estimate", "website_audit", "website_project_estimate", "oman_supplier_check"
];

test("hero capabilities expose compact Bazaar input and output metadata", () => {
  for (const name of HERO_NAMES) {
    const capability = capabilities.find(c => c.name === name);
    assert.ok(capability, `${name} must be registered`);
    const declaration = discoveryDeclaration(capability!) as { bazaar: { info: { input?: unknown; output?: { type?: string }; }; schema?: unknown } };
    assert.equal(validateDiscoveryExtensionSpec(declaration.bazaar).valid, true, `${name} Bazaar spec`);
    assert.ok(declaration.bazaar.info.input, `${name} input example`);
    assert.ok(declaration.bazaar.schema, `${name} Bazaar schema`);
    const schema = declaration.bazaar.schema as { properties?: { input?: { properties?: { bodyType?: { enum?: unknown[] }; method?: { enum?: unknown[] }; type?: { const?: unknown } } }; output?: unknown } };
    assert.ok(schema.properties?.input?.properties?.bodyType?.enum?.includes("json"), `${name} body type`);
    assert.equal(schema.properties?.input?.properties?.method?.enum?.[0], "POST", `${name} method`);
    assert.equal(schema.properties?.input?.properties?.type?.const, "http", `${name} input type`);
    assert.equal(capability!.input.safeParse(capability!.example).success, true, `${name} input example validates`);
    assert.equal(capability!.output.safeParse(capability!.exampleOutput).success, true, `${name} output example validates`);
  }
});

test("the known-good control retains Bazaar output metadata", () => {
  const capability = capabilities.find(c => c.name === "analyze_property")!;
  const declaration = discoveryDeclaration(capability) as unknown as { bazaar: { info: { output?: { type?: string; example?: unknown } } } };
  assert.equal(declaration.bazaar.info.output?.type, "json");
  assert.ok(declaration.bazaar.info.output?.example);
});

test("hero prices remain canonical and unchanged", () => {
  const expected = {
    company_due_diligence: 1.5,
    business_risk_score: 0.5,
    invoice_anomaly_check: 0.25,
    analyze_oman_property: 0.25,
    analyze_property: 0.01,
    vehicle_value_estimate: 0.25,
    shipping_cost_estimate: 0.25,
    website_audit: 0.75,
    website_project_estimate: 0.25,
    oman_supplier_check: 0.5
  };
  for (const [name, price] of Object.entries(expected)) {
    assert.equal(capabilities.find(c => c.name === name)?.price, price, `${name} canonical price`);
  }
});
