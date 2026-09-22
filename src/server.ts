import express from "express";
import { createApp } from "./api/app.js";
import { loadConfig } from "./config/env.js";
import { CustomerStore } from "./db/store.js";
import { BillingService } from "./billing/service.js";
import { ConsoleUsageRepository, MemoryUsageRepository, PostgresUsageRepository } from "./billing/usage.js";
// Vercel's zero-config Express detector requires the entrypoint itself to import Express.
void express;
let store: CustomerStore | undefined;
const config = loadConfig();
try {
  if (config.authMode === "postgres") {
    store = new CustomerStore(config.databaseUrl!);
    await store.ready();
  }
} catch (error) {
  process.stderr.write(store ? "Database startup failed; check connectivity and run migrations\n" : `${error instanceof Error ? error.message : "Startup failed"}\n`);
  await store?.close();
  throw new Error("Rafid API initialization failed");
}

// USAGE_REPOSITORY selects the durable store: "console" (default) writes one JSON line to
// stderr per call (visible via `vercel logs`); "postgres" additionally persists a queryable
// ledger in the rafid_agent_usage table (see src/billing/usage.ts); "memory" is for local
// inspection only and loses everything on restart.
const usageRepository = config.usageRepository === "postgres" ? new PostgresUsageRepository(config.databaseUrl!)
  : config.usageRepository === "memory" ? new MemoryUsageRepository()
  : new ConsoleUsageRepository();
const billingService = new BillingService(usageRepository);
const app = createApp(config, { store, billingService });
if (process.env.VERCEL !== "1") {
  const server = app.listen(config.port, () => {
    if (config.logLevel === "info") process.stderr.write(`Rafid Agent API listening on port ${config.port}\n`);
  });
  server.on("error", () => { process.stderr.write("HTTP server failed to start\n"); process.exitCode = 1; void store?.close(); });
  const shutdown = () => {
    server.close(() => { void (store?.close() ?? Promise.resolve()).finally(() => process.exit(0)); });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

export default app;
