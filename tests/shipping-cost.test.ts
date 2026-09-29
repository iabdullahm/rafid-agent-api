import assert from "node:assert/strict";
import test from "node:test";
import { estimateShippingCost, previewShippingCost } from "../src/shipping-cost/service.js";
import { shippingCostEstimateInput } from "../src/schemas/shippingCostInputs.js";
import { capabilities } from "../src/domain/capabilities.js";

const base = {
  origin: { country: "CN", postalCode: "518000", city: "Shenzhen" },
  destination: { country: "OM", postalCode: "100", city: "Muscat" },
  shipment: { weightKg: 8, lengthCm: 45, widthCm: 35, heightCm: 30 },
  shippingMode: "air" as const, serviceLevel: "standard" as const, currency: "USD"
};

test("shipping estimate calculates volumetric and chargeable weight", async () => {
  const result = await estimateShippingCost(base);
  assert.equal(result.actualWeightKg, 8);
  assert.equal(result.volumetricWeightKg, 9.45);
  assert.equal(result.chargeableWeightKg, 9.45);
  assert.equal(result.rateSource, "heuristic_estimate");
  assert.equal(result.dutiesAndTaxes.included, false);
});

test("actual weight wins when it exceeds volumetric weight and missing dimensions are explicit", async () => {
  const result = await estimateShippingCost({ ...base, shipment: { weightKg: 50 }, shippingMode: "road", serviceLevel: "economy" });
  assert.equal(result.chargeableWeightKg, 50);
  assert.equal(result.volumetricWeightKg, 0);
  assert.ok(result.riskFlags.some(flag => flag.code === "DIMENSIONS_MISSING"));
});

test("strict validation rejects invalid countries and dimensions", () => {
  assert.throws(() => shippingCostEstimateInput.parse({ ...base, origin: { country: "ZZ" } }));
  assert.throws(() => shippingCostEstimateInput.parse({ ...base, shipment: { ...base.shipment, lengthCm: 0 } }));
});

test("economy, standard and express are accepted", () => {
  for (const serviceLevel of ["economy", "standard", "express"] as const) {
    const parsed = shippingCostEstimateInput.parse({ ...base, serviceLevel });
    assert.equal(parsed.serviceLevel, serviceLevel);
  }
});

test("configured internal route rates are used deterministically", async () => {
  const previous = process.env.SHIPPING_INTERNAL_RATES_JSON;
  process.env.SHIPPING_INTERNAL_RATES_JSON = JSON.stringify([{ originCountry: "CN", destinationCountry: "OM", shippingMode: "air", serviceLevel: "standard", weightFromKg: 0, weightToKg: 20, provider: "test-dataset", source: "internal_estimate", currency: "USD", baseRate: 40, ratePerKg: 1, minimumCharge: 40, fuelSurchargePercent: 10, handlingFee: 5, remoteAreaSurcharge: 0, oversizeSurcharge: 0, estimatedOtherFees: 2, transitDaysMin: 4, transitDaysMax: 8 }]);
  try {
    const a = await estimateShippingCost(base);
    const b = await estimateShippingCost(base);
    assert.equal(a.rateSource, "internal_estimate");
    assert.deepEqual({ cost: a.estimatedCost, weight: a.chargeableWeightKg }, { cost: b.estimatedCost, weight: b.chargeableWeightKg });
  } finally { if (previous === undefined) delete process.env.SHIPPING_INTERNAL_RATES_JSON; else process.env.SHIPPING_INTERNAL_RATES_JSON = previous; }
});

test("preview withholds the precise paid quote", async () => {
  const preview = await previewShippingCost(base);
  assert.equal(preview.capability, "shipping_cost_estimate");
  assert.equal("estimatedCost" in preview.preview, false);
  assert.ok(preview.preview.availableSections?.includes("chargeableWeightKg"));
});

test("capability registry is canonical and priced at 0.25 USD", () => {
  const capability = capabilities.find(c => c.name === "shipping_cost_estimate");
  assert.ok(capability);
  assert.equal(capability.price, 0.25);
  assert.equal(capability.path, "/logistics/shipping-cost-estimate");
  assert.equal(capability.idempotent, true);
});
