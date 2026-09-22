import { PostgresPropertyMarketRepository } from "./db/marketStore.js";
import { PostgresPartnerRepository } from "./db/partnerStore.js";
import { PostgresPartnerIngestionAuditRepository } from "./db/partnerAuditStore.js";
import { PostgresPartnerFeedCredentialRepository } from "./db/partnerFeedCredentialStore.js";
import { getOmanMarketDatabaseUrl } from "./domain/oman/config.js";
import { EnvSecretProvider } from "./domain/oman/partnerFeedCredentials.js";
import { PartnerFeedRunner } from "./domain/oman/partnerFeedRunner.js";

/**
 * Production Feed Runner (Section 5): `npm run partner:feeds` — one scheduling PASS, not an
 * always-running process. Identifies every enabled, due partner, runs each one's feed through
 * `PartnerFeedRunner.runDueFeeds()` (which already isolates one partner's failure from every
 * other's — Section 7), prints a safe operational summary, and exits. Intended to be invoked by an
 * external scheduler — Vercel Cron, a GitHub Actions workflow on a schedule, Windows Task
 * Scheduler, or plain cron — never by a long-lived timer inside this process itself.
 */
const url = getOmanMarketDatabaseUrl();
if (!url) { process.stderr.write("DATABASE_URL (or OMAN_MARKET_DATABASE_URL) is required\n"); process.exit(1); }

const marketRepository = new PostgresPropertyMarketRepository(url);
try {
  await marketRepository.migrate();
  const partnerRepository = new PostgresPartnerRepository(marketRepository.pool);
  const ingestionAuditRepository = new PostgresPartnerIngestionAuditRepository(marketRepository.pool);
  const credentialRepository = new PostgresPartnerFeedCredentialRepository(marketRepository.pool);
  const runner = new PartnerFeedRunner({
    partnerRepository, marketRepository, ingestionAuditRepository, credentialRepository,
    secretProvider: new EnvSecretProvider()
  });
  // Section 6: never print feed credentials or raw records — runDueFeeds()'s outcome shape has no
  // room for either (see PartnerFeedRunOutcome in partnerFeedRunner.ts).
  const summary = await runner.runDueFeeds();
  process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
  if (summary.failed > 0 && summary.successful === 0 && summary.attempted > 0) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`Partner feed scheduling pass failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await marketRepository.close();
}
