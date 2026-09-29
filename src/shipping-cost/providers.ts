import type { ShippingEstimateInput } from "../schemas/shippingCostInputs.js";

export type ShippingRateSource = "live_carrier" | "internal_estimate" | "heuristic_estimate";
export interface ShippingRateQuote { provider: string; source: ShippingRateSource; currency: string; baseRate: number; ratePerKg: number; minimumCharge: number; fuelSurchargePercent: number; handlingFee: number; remoteAreaSurcharge: number; oversizeSurcharge: number; estimatedOtherFees: number; transitDaysMin: number; transitDaysMax: number; }
export interface ShippingRateProvider { name: string; supports(input: ShippingEstimateInput): boolean; estimate(input: ShippingEstimateInput): Promise<ShippingRateQuote[]>; }

type ConfiguredRate = ShippingRateQuote & { originCountry: string; destinationCountry: string; shippingMode: string; serviceLevel: string; weightFromKg: number; weightToKg: number };

function configuredRates(): ConfiguredRate[] {
  try {
    const raw = process.env.SHIPPING_INTERNAL_RATES_JSON;
    if (!raw) return [];
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter(r => r && typeof r === "object") as ConfiguredRate[] : [];
  } catch { return []; }
}

export class InternalShippingRateProvider implements ShippingRateProvider {
  name = "internal-rate-dataset";
  supports(input: ShippingEstimateInput) { return configuredRates().some(r => r.originCountry === input.origin.country && r.destinationCountry === input.destination.country); }
  async estimate(input: ShippingEstimateInput): Promise<ShippingRateQuote[]> {
    const mode = input.shippingMode === "auto" ? undefined : input.shippingMode;
    const level = input.serviceLevel === "auto" ? undefined : input.serviceLevel;
    return configuredRates().filter(r => r.originCountry === input.origin.country && r.destinationCountry === input.destination.country && (!mode || r.shippingMode === mode) && (!level || r.serviceLevel === level) && input.shipment.weightKg >= r.weightFromKg && input.shipment.weightKg <= r.weightToKg).map(({ originCountry: _o, destinationCountry: _d, shippingMode: _m, serviceLevel: _s, weightFromKg: _f, weightToKg: _t, ...quote }) => quote);
  }
}

export class ConfiguredCarrierProvider implements ShippingRateProvider {
  name = "configured-carrier";
  supports(_input: ShippingEstimateInput) { return false; }
  async estimate(_input: ShippingEstimateInput): Promise<ShippingRateQuote[]> { return []; }
}

export const shippingRateProviders: ShippingRateProvider[] = [new ConfiguredCarrierProvider(), new InternalShippingRateProvider()];

/** Deployment integration point for DHL/FedEx/UPS/Shippo/etc. adapters. Adapters are expected
 * to enforce their own timeout/retry policy and return normalized quotes only; the core service
 * isolates provider exceptions and never exposes provider credentials. */
export function registerShippingRateProvider(provider: ShippingRateProvider): void {
  shippingRateProviders.unshift(provider);
}
