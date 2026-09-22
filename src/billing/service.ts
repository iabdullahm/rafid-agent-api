import { prices, type CapabilityName } from "./catalog.js";
import { MemoryUsageRepository, type UsageRecord, type UsageRepository } from "./usage.js";

export interface X402PaymentRequirement {
  scheme: "exact";
  price: string;
  network: `${string}:${string}`;
  payTo: `0x${string}`;
}

/**
 * The single place that turns a tool name into money. Route handlers, the x402 gate and the
 * REST authorization seam all call into this instead of reading src/billing/catalog.ts (or,
 * worse, hardcoding a number) directly — business/calculation logic in src/services and
 * src/domain must never contain a price.
 */
export class BillingService {
  constructor(private readonly usage: UsageRepository = new MemoryUsageRepository()) {}

  getToolPrice(tool: CapabilityName): number {
    return prices[tool];
  }

  /** Every current tool is billable per call. Kept as an explicit seam so a future free tier,
   *  bundled quota, or subscription-only tool doesn't require callers to special-case pricing. */
  isBillable(_tool: CapabilityName): boolean {
    return true;
  }

  /** Builds the x402 "accepts" payment requirement for a tool. The price always comes from
   *  getToolPrice(), so the catalog stays the only source of truth. */
  buildX402PaymentRequirement(tool: CapabilityName, network: `${string}:${string}`, payTo: `0x${string}`): X402PaymentRequirement {
    return { scheme: "exact", price: `$${this.getToolPrice(tool).toFixed(2)}`, network, payTo };
  }

  async recordUsage(entry: Omit<UsageRecord, "timestamp">): Promise<void> {
    await this.usage.record({ ...entry, timestamp: new Date().toISOString() });
  }
}
