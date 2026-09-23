import { BillingEngine, PostgresBillingStore, loadBillingConfig } from "./billing/unified/index.js";
import { prices } from "./billing/catalog.js";

/**
 * Billing administration CLI (internal) — `npm run billing -- <command>`. The same engine
 * operations the BILLING_ADMIN_SECRET-protected admin API exposes, for operators who prefer not to
 * enable that API at all. Talks directly to BILLING_DATABASE_URL (or DATABASE_URL).
 *
 * A newly created API key is printed exactly once, to stdout, for the operator; it is never
 * stored or logged anywhere in plain text.
 */
const USAGE = `Usage: npm run billing -- <command>
  migrate
  plans
  account:create NAME [EMAIL]
  account:show ACCOUNT_ID
  account:status ACCOUNT_ID active|suspended|closed
  key:create ACCOUNT_ID [NAME] [live|test] [EXPIRES_AT_ISO]
  key:list ACCOUNT_ID
  key:revoke ACCOUNT_ID KEY_ID
  credit:add ACCOUNT_ID AMOUNT_USD [REASON] [EXTERNAL_TRANSACTION_ID]
  credit:adjust ACCOUNT_ID SIGNED_AMOUNT_USD REASON
  ledger ACCOUNT_ID [LIMIT]
  usage ACCOUNT_ID [SINCE_ISO]
  subscription:assign ACCOUNT_ID PLAN [INCLUDED_USD]
  subscription:cancel ACCOUNT_ID
  release-stale`;

const [command, ...args] = process.argv.slice(2);
const url = process.env.BILLING_DATABASE_URL || process.env.DATABASE_URL;
if (!command || command === "help") { process.stdout.write(USAGE + "\n"); process.exit(command ? 0 : 1); }
if (!url && command !== "plans") { process.stderr.write("Set BILLING_DATABASE_URL (or DATABASE_URL)\n"); process.exit(1); }

const config = loadBillingConfig({ ...process.env, API_CREDITS_ENABLED: "true" }, { nodeEnv: "development", databaseUrl: url });
const store = url ? new PostgresBillingStore(url, { poolMax: 2 }) : null;
const engine = store ? new BillingEngine({ config, store, priceUsd: tool => prices[tool as keyof typeof prices] ?? 0 }) : null;
const need = (n: number) => { if (args.length < n) { process.stderr.write(USAGE + "\n"); process.exit(1); } };

try {
  let result: unknown;
  switch (command) {
    case "migrate": await store!.migrate(); result = { migrated: true }; break;
    case "plans": result = Object.values(config.plans).map(p => ({ id: p.id, name: p.name, monthlyIncludedUsd: (p.allowance.monthlyIncludedMicros / 1e6).toFixed(2) })); break;
    case "account:create": need(1); result = await engine!.createAccount({ name: args[0]!, email: args[1] ?? null }); break;
    case "account:show": need(1); result = { ...(await engine!.balanceView(args[0]!)), apiKeys: await engine!.listApiKeys(args[0]!) }; break;
    case "account:status": need(2); {
      if (!["active", "suspended", "closed"].includes(args[1]!)) throw new Error("status must be active, suspended or closed");
      await store!.setAccountStatus(args[0]!, args[1] as "active"); result = await engine!.balanceView(args[0]!);
    } break;
    case "key:create": need(1); {
      const created = await engine!.createApiKey({ accountId: args[0]!, name: args[1], environment: (args[2] as "live" | "test" | undefined) ?? "live", expiresAt: args[3] ?? null });
      process.stderr.write("Store this API key now — it is shown only once and cannot be recovered.\n");
      result = created;
    } break;
    case "key:list": need(1); result = await engine!.listApiKeys(args[0]!); break;
    case "key:revoke": need(2); result = await engine!.revokeApiKey(args[0]!, args[1]!); break;
    case "credit:add": need(2); result = await engine!.addCredit({ accountId: args[0]!, amount: args[1]!, reason: args[2], externalTransactionId: args[3] ?? null }); break;
    case "credit:adjust": need(3); result = await engine!.adjustCredit({ accountId: args[0]!, amount: args[1]!, reason: args[2]! }); break;
    case "ledger": need(1); result = await engine!.ledgerView(args[0]!, { limit: args[1] ? Number(args[1]) : 50 }); break;
    case "usage": need(1); result = await engine!.usageView(args[0]!, args[1]); break;
    case "subscription:assign": need(2); result = await engine!.assignSubscription({ accountId: args[0]!, plan: args[1]!, includedUsd: args[2] }); break;
    case "subscription:cancel": need(1); result = await engine!.cancelSubscription(args[0]!); break;
    case "release-stale": result = await engine!.releaseStale(); break;
    default: process.stderr.write(USAGE + "\n"); process.exitCode = 1;
  }
  if (result !== undefined) process.stdout.write(JSON.stringify(result, null, 2) + "\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Billing command failed"}\n`);
  process.exitCode = 1;
} finally {
  await store?.close();
}
