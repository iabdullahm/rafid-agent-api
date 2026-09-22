import { PostgresPropertyMarketRepository } from "./db/marketStore.js";
import { PostgresPartnerRepository } from "./db/partnerStore.js";
import { importMarketRecords, loadImportRows, type PartnerAttribution } from "./domain/oman/importPipeline.js";
import { getOmanMarketDatabaseUrl } from "./domain/oman/config.js";

/**
 * Phase 4 CLI: `npm run market:import -- ./data/example-oman-market-import.csv [PARTNER_ID]`
 *
 * Reads a CSV or JSON file of Oman property market records, validates/normalizes every row
 * (src/domain/oman/importPipeline.ts), and upserts the valid ones into the production
 * `property_market_records` table via the exact same PropertyMarketRepository interface the
 * analysis service queries at request time — there is no second write path.
 *
 * Migrates the market schema automatically if it hasn't been applied yet (mirrors src/admin.ts's
 * `migrate` command for the customer/billing schema, but against the independent market-data
 * migration ledger — see src/db/marketStore.ts).
 *
 * The optional second argument attributes this bulk import to an already-enrolled partner
 * (Section 2/10) — an operator-run alternative to the authenticated HTTP ingestion endpoint
 * (src/api/marketDataRoutes.ts) for a partner who hands Rafid a file directly rather than calling
 * the API themselves. Attribution still never comes from the file's own rows: it is looked up from
 * the partner record itself (partnerId, sourceType, partnerName) and applied server-side, exactly
 * like the HTTP path — never trusted from any partnerId-shaped column in the file.
 */
const [filePath, partnerId] = process.argv.slice(2);
if (!filePath) { process.stderr.write("Usage: npm run market:import -- <path-to-file.csv|.json> [PARTNER_ID]\n"); process.exit(1); }

const url = getOmanMarketDatabaseUrl();
if (!url) { process.stderr.write("DATABASE_URL (or OMAN_MARKET_DATABASE_URL) is required\n"); process.exit(1); }

const repository = new PostgresPropertyMarketRepository(url);
try {
  const rows = loadImportRows(filePath);
  await repository.migrate();

  let partner: PartnerAttribution | undefined;
  if (partnerId) {
    const partnerRepository = new PostgresPartnerRepository(repository.pool);
    const record = await partnerRepository.findById(partnerId);
    if (!record) throw new Error(`Partner "${partnerId}" not found — create it first with \`npm run admin -- partner:create\``);
    if (!record.enabled) throw new Error(`Partner "${partnerId}" is disabled — enable it first with \`npm run admin -- partner:enable ${partnerId}\``);
    partner = { partnerId: record.partnerId, sourceType: record.sourceType, sourceName: record.partnerName };
  }

  const result = await importMarketRecords(rows, repository, { partner });
  if (partner) {
    const partnerRepository = new PostgresPartnerRepository(repository.pool);
    await partnerRepository.recordImportStats(partner.partnerId, {
      received: result.totalRows, accepted: result.imported + result.updated,
      rejected: result.errors.length, updated: result.updated, latestObservedAt: result.latestObservedAt
    });
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  if (result.errors.length > 0) process.exitCode = result.imported + result.updated > 0 ? 0 : 1;
} catch (error) {
  process.stderr.write(`Market import failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await repository.close();
}
