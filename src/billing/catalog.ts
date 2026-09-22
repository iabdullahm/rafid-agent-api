import { capabilities, type CapabilityName } from "../domain/capabilities.js";

// Indicative USD prices only. No charges, payment verification, or settlement.
// The actual source of truth is each capability's own `price` field in
// src/domain/capabilities.ts — this object is derived from it, never a second literal, so
// GET /api/v1/pricing, GET /api/v1/tools, GET /api/v1/capabilities, the x402 payment gate and
// BillingService can keep reading `prices` (unchanged shape for backward compatibility)
// while there is only ever one place a price is actually written.
export const prices = Object.fromEntries(capabilities.map(c => [c.name, c.price])) as Record<CapabilityName, number>;
export type { CapabilityName };
export interface BillingGate {
  authorize(context: { capability: CapabilityName; requestId: string; customerId: string }): Promise<void>;
}
export const disabledBilling: BillingGate = { async authorize() {} };
