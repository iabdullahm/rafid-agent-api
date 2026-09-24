import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";
import { parseCsv } from "./domain/oman/importPipeline.js";
import { getVehicleMarketDatabaseUrl } from "./vehicle-value/config.js";
import { validateNewPriceRows, validateVehicleMarketRows, type VehicleMarketRecord } from "./vehicle-value/store/records.js";
import { PostgresVehicleMarketRepository } from "./vehicle-value/store/postgres.js";

/**
 * `npm run vehicle:import -- <file.csv|file.json> [--dry-run] [--source-type=licensed_feed|partner_feed|marketplace_api|manual_import|auction_results]`
 * `npm run vehicle:import -- <file.csv|file.json> --new-prices [--dry-run]`  (verified original / new-vehicle prices → vehicle_new_prices)
 *
 * Validates and normalizes vehicle market evidence (listings or recorded sales) from an APPROVED
 * source and upserts it into vehicle_market_records — the table the `vehicle_market_records`
 * provider reads when VEHICLE_MARKET_DATA_MODE=database. De-duplicates on (sourceName,
 * sourceRecordId). Columns that look like personal data (seller name/phone/e-mail, VIN, plate) are
 * dropped and reported, never stored. --dry-run validates without touching any database.
 *
 * Operators run this themselves against their own database; it is never called by the API.
 */
const MAX_BYTES = 20 * 1024 * 1024;
const args = process.argv.slice(2);
const filePath = args.find(a => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");
const sourceTypeArg = args.find(a => a.startsWith("--source-type="))?.split("=")[1] as VehicleMarketRecord["sourceType"] | undefined;
if (!filePath) { process.stderr.write("Usage: npm run vehicle:import -- <file.csv|file.json> [--dry-run] [--source-type=...]\n"); process.exit(1); }
if (statSync(filePath).size > MAX_BYTES) { process.stderr.write(`File exceeds ${MAX_BYTES / 1024 / 1024} MB\n`); process.exit(1); }

const text = readFileSync(filePath, "utf8");
const rows: Record<string, unknown>[] = extname(filePath).toLowerCase() === ".json"
  ? (() => { const parsed = JSON.parse(text) as unknown; return (Array.isArray(parsed) ? parsed : (parsed as { records?: unknown[] }).records ?? []) as Record<string, unknown>[]; })()
  : parseCsv(text);
if (args.includes("--new-prices")) {
  const prices = validateNewPriceRows(rows);
  const priceSummary = { totalRows: rows.length, valid: prices.records.length, rejected: prices.errors.length, errors: prices.errors.slice(0, 50) };
  if (dryRun) { process.stdout.write(`${JSON.stringify({ dryRun: true, ...priceSummary }, null, 2)}\n`); process.exit(0); }
  const url = getVehicleMarketDatabaseUrl();
  if (!url) { process.stderr.write("VEHICLE_MARKET_DATABASE_URL (or DATABASE_URL) is required\n"); process.exit(1); }
  const repository = new PostgresVehicleMarketRepository(url);
  try { process.stdout.write(`${JSON.stringify({ ...priceSummary, ...(await repository.upsertNewPrices(prices.records)) }, null, 2)}\n`); }
  finally { await repository.close(); }
  process.exit(0);
}

const result = validateVehicleMarketRows(rows, { sourceType: sourceTypeArg });
const summary = {
  totalRows: rows.length, valid: result.records.length, rejected: result.errors.length,
  droppedPersonalDataColumns: result.droppedPersonalDataColumns, ignoredColumns: result.ignoredColumns,
  errors: result.errors.slice(0, 50)
};

if (dryRun) {
  process.stdout.write(`${JSON.stringify({ dryRun: true, ...summary }, null, 2)}\n`);
} else {
  const url = getVehicleMarketDatabaseUrl();
  if (!url) { process.stderr.write("VEHICLE_MARKET_DATABASE_URL (or DATABASE_URL) is required\n"); process.exit(1); }
  const repository = new PostgresVehicleMarketRepository(url);
  try {
    const written = await repository.upsertRecords(result.records);
    process.stdout.write(`${JSON.stringify({ ...summary, ...written }, null, 2)}\n`);
  } finally {
    await repository.close();
  }
}
