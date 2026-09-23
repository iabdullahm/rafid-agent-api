import { Pool } from "pg";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { createFacilitatorConfig } from "@coinbase/x402";
import { capabilities } from "../../domain/capabilities.js";
import type { RevenueSettlementInput } from "../../revenue/types.js";
import type { MppConfig } from "./config.js";
import type { MppAuditSink } from "./audit.js";
import { MppxProvider } from "./mppx.js";
import type { MppProvider } from "./provider.js";
import { MemoryMppChargeRedemptionStore, MemoryMppSessionRepository, PostgresMppChargeRedemptionStore, PostgresMppSessionRepository, type MppChargeRedemptionStore, type MppSessionRepository } from "./sessions.js";
import { MemoryMppKv, PostgresMppKv, toMppxStore, type MppKv } from "./store.js";
import { MppService } from "./service.js";

export * from "./config.js";
export * from "./errors.js";
export * from "./types.js";
export * from "./provider.js";
export * from "./service.js";
export * from "./routes.js";
export * from "./sessions.js";
export * from "./store.js";
export * from "./settlement.js";
export * from "./audit.js";
export { MppxProvider } from "./mppx.js";
export { createMppMcpHandler, mppMcpPath, RAFID_SESSION_META_KEY, toJsonRpc } from "./mcp.js";

export interface MppRailOptions {
  config: MppConfig;
  databaseUrl: string | undefined;
  priceUsd: (tool: string) => number;
  recordSettlement: (input: RevenueSettlementInput) => void;
  audit: MppAuditSink;
  /** x402 settings evm/charge reuses (the same facilitator/CDP credentials as the x402 rail). */
  x402: { facilitatorUrl: string; cdpConfigured: boolean; cdpApiKeyId: string | undefined; cdpApiKeySecret: string | undefined };
  /** Test seams. */
  provider?: MppProvider;
  sessions?: MppSessionRepository;
  redemptions?: MppChargeRedemptionStore;
  kv?: MppKv;
  now?: () => Date;
}

/**
 * Wires the MPP rail: persistence (Postgres when a database is configured, in-process
 * otherwise — refused in production by loadMppConfig), the official-SDK provider, and the
 * service. Tool execution comes straight from the shared capability registry.
 */
export function buildMppService(o: MppRailOptions): MppService {
  const pool = o.databaseUrl && (!o.sessions || !o.redemptions || !o.kv)
    ? new Pool({ connectionString: o.databaseUrl, max: 5, connectionTimeoutMillis: 5000, statement_timeout: 15000 })
    : null;
  pool?.on("error", () => process.stderr.write("MPP store database connection failure\n"));
  const kv = o.kv ?? (pool ? new PostgresMppKv(pool) : new MemoryMppKv());
  const sessions = o.sessions ?? (pool ? new PostgresMppSessionRepository(pool) : new MemoryMppSessionRepository());
  const redemptions = o.redemptions ?? (pool ? new PostgresMppChargeRedemptionStore(pool) : new MemoryMppChargeRedemptionStore());
  const provider = o.provider ?? new MppxProvider(o.config, {
    chargeStore: toMppxStore(kv, "mppx:charge:"),
    sessionStore: toMppxStore(kv, "mppx:session:"),
    evmFacilitator: o.config.chargeMethods.includes("evm")
      ? (o.x402.cdpConfigured
        ? new HTTPFacilitatorClient(createFacilitatorConfig(o.x402.cdpApiKeyId, o.x402.cdpApiKeySecret))
        : new HTTPFacilitatorClient({ url: o.x402.facilitatorUrl }))
      : undefined
  });
  return new MppService({
    config: o.config, provider, sessions, redemptions,
    getTool: name => capabilities.find(c => c.name === name),
    priceUsd: o.priceUsd,
    audit: o.audit,
    recordSettlement: o.recordSettlement,
    now: o.now
  });
}
