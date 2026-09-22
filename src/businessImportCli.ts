import { basename } from "node:path";
import { PostgresCompanyRepository } from "./db/businessStore.js";
import { loadImportRows } from "./domain/oman/importPipeline.js";
import { getOmanBusinessDatabaseUrl } from "./business-data/config.js";
import { runSourceImport } from "./business-data/ingestion/importDispatch.js";
import { loadXlsxWorkbook } from "./business-data/sources/xlsxReader.js";
import { importCardifyWorkbook } from "./business-data/sources/cardifyOmanBusinessIndexProvider.js";

/**
 * `npm run business:import -- [--source=<name>] [--dry-run] <path-to-file.csv|.json>`
 *
 * Reads a CSV or JSON file of real Oman company/tax/procurement records, validates/normalizes every
 * row and upserts the valid ones into the production tables via the exact same repository
 * interface the search/profile/analyze/due-diligence capabilities themselves query at request
 * time — there is no second write path. Mirrors src/marketImportCli.ts's structure for the
 * property-market domain.
 *
 * --source selects which adapter parses the file (Phase 4-6/10/11 — each source has its own raw
 * row shape and normalizer, never a one-size-fits-all importer, per companyRepository.ts's doc
 * comment on why the sources are kept distinct):
 *   generic (default)      — the pre-existing free-form CSV/JSON shape (importPipeline.ts)
 *   mociip                 — Oman Business / MOCIIP company-register rows
 *   tax-oman                — Tax Oman VATIN verification rows
 *   tender-board-suppliers — Tender Board/Esnad supplier-registration snapshot rows
 *   tender-board-awards    — Tender Board/Esnad individual award/contract fact rows
 *
 * --dry-run validates and normalizes every row (reporting exactly the same errors a real run
 * would) WITHOUT writing anything — no migration, no upsert, no sync-run record. Safe to run
 * against a file before trusting it with a real import.
 *
 * Every real (non-dry-run) run is wrapped in a Phase 13 sync-run record (business_source_sync_runs)
 * — started before the file is even parsed, finished (succeeded or failed) in a `finally` block, so
 * a crash mid-import still leaves an honest "failed" audit row rather than silently vanishing.
 *
 * Migrates the business-data schema automatically if it hasn't been applied yet, against the
 * independent `rafid_business_migrations` ledger (see src/db/businessStore.ts) — never the
 * customer/billing or property-market migration ledgers.
 */

interface ParsedArgs { source: string; dryRun: boolean; filePath: string | null }

function parseArgs(argv: readonly string[]): ParsedArgs {
  let source = "generic";
  let dryRun = false;
  let filePath: string | null = null;
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg.startsWith("--source=")) source = arg.slice("--source=".length).trim();
    else if (!arg.startsWith("--")) filePath = arg;
  }
  return { source, dryRun, filePath };
}

const SOURCE_NAMES = ["generic", "mociip", "tax-oman", "tender-board-suppliers", "tender-board-awards", "cardify"] as const;

const { source, dryRun, filePath } = parseArgs(process.argv.slice(2));
if (!filePath) {
  process.stderr.write(`Usage: npm run business:import -- [--source=${SOURCE_NAMES.join("|")}] [--dry-run] <path-to-file.csv|.json|.xlsx>\n`);
  process.exit(1);
}
if (!(SOURCE_NAMES as readonly string[]).includes(source)) {
  process.stderr.write(`Unknown --source "${source}"; expected one of ${SOURCE_NAMES.join(", ")}\n`);
  process.exit(1);
}

// Section 13: the Cardify Oman Business Index workbook is a MULTI-SHEET .xlsx import (Companies +
// Sources + Tax Verification + Procurement + Awards, joined by the workbook's own company_id — see
// cardifyOmanBusinessIndexProvider.ts), which does not fit the single-flat-row-array shape every
// other --source uses (importDispatch.ts's runSourceImport). It is therefore handled as its own
// branch here rather than forced through that one-shape-per-source dispatch — still the exact same
// repository write path (CompanyRepository.upsertCompanies/upsertAwards), same sync-run auditing,
// same CLI entry point; never a second importer.
if (source === "cardify") {
  if (dryRun) {
    try {
      const workbook = loadXlsxWorkbook(filePath);
      const { MemoryCompanyRepository } = await import("./business-data/sources/companyRepository.js");
      const scratch = new MemoryCompanyRepository();
      const result = await importCardifyWorkbook(workbook, scratch, true);
      process.stdout.write(JSON.stringify({ dryRun: true, source, ...result }, null, 2) + "\n");
      process.exitCode = result.invalidRows > 0 && result.validRows === 0 ? 1 : 0;
    } catch (error) {
      process.stderr.write(`Dry-run failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  } else {
    const url = getOmanBusinessDatabaseUrl();
    if (!url) { process.stderr.write("DATABASE_URL (or OMAN_BUSINESS_DATABASE_URL) is required for a real (non-dry-run) import\n"); process.exit(1); }
    const repository = new PostgresCompanyRepository(url);
    let runId: string | null = null;
    try {
      const workbook = loadXlsxWorkbook(filePath);
      await repository.migrate();
      runId = await repository.startSyncRun("Cardify Oman Business Index Excel Import");
      const result = await importCardifyWorkbook(workbook, repository, false, { recordUnmatched: true });
      await repository.finishSyncRun(runId, {
        status: "succeeded", recordsSeen: result.totalCompanyRows,
        recordsInserted: result.sourceEvidenceInserted, recordsUpdated: result.sourceEvidenceUpdated,
        recordsSkipped: result.invalidRows,
        errorMessage: result.errors.length > 0 ? `${result.errors.length} row(s) had errors — see recordsSkipped/errors in this run's output` : null,
        // Section 20: a small, structured summary — never the imported content itself.
        metadata: {
          workbookFileName: basename(filePath),
          sheetsFound: result.sheetsFound,
          sheetRowCounts: {
            companies: result.totalCompanyRows, tax: result.taxTotalRows,
            procurement: result.procurementTotalRows, awards: result.awardTotalRows,
            reviewQueueSkipped: result.reviewQueueRowsSkipped, dataQualitySkipped: result.dataQualityRowsSkipped
          },
          sourceRecordIdRepairStrategy: "cardify:<workbook company_id, lowercased> — replaces the workbook's own page-level source_record_id (preserved per-row in metadata.cardifyOriginalSourceRecordId), never the page number itself"
        }
      });
      process.stdout.write(JSON.stringify({ dryRun: false, source, ...result }, null, 2) + "\n");
      process.exitCode = result.errors.length > 0 && result.sourceEvidenceInserted + result.sourceEvidenceUpdated === 0 ? 1 : 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (runId) await repository.finishSyncRun(runId, { status: "failed", recordsSeen: 0, recordsInserted: 0, recordsUpdated: 0, recordsSkipped: 0, errorMessage: message }).catch(() => {});
      process.stderr.write(`Cardify workbook import failed: ${message}\n`);
      process.exitCode = 1;
    } finally {
      await repository.close();
    }
  }
} else if (dryRun) {
  // A dry run never touches the database at all — not even to migrate — so it's safe to run with
  // no DATABASE_URL configured, against a file whose rows haven't been trusted yet.
  try {
    const rows = loadImportRows(filePath);
    const { MemoryCompanyRepository } = await import("./business-data/sources/companyRepository.js");
    const scratch = new MemoryCompanyRepository();
    const result = await runSourceImport(source, rows, scratch);
    process.stdout.write(JSON.stringify({ dryRun: true, source, ...result }, null, 2) + "\n");
    process.exitCode = result.errors.length > 0 && result.imported + (("updated" in result ? result.updated : 0)) === 0 ? 1 : 0;
  } catch (error) {
    process.stderr.write(`Dry-run failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
} else {
  const url = getOmanBusinessDatabaseUrl();
  if (!url) { process.stderr.write("DATABASE_URL (or OMAN_BUSINESS_DATABASE_URL) is required for a real (non---dry-run) import\n"); process.exit(1); }

  const repository = new PostgresCompanyRepository(url);
  let runId: string | null = null;
  try {
    const rows = loadImportRows(filePath);
    await repository.migrate();
    runId = await repository.startSyncRun(source);
    const result = await runSourceImport(source, rows, repository);
    const inserted = "imported" in result ? result.imported : 0;
    const updated = "updated" in result ? result.updated : 0;
    const skipped = "skipped" in result ? result.skipped : 0;
    await repository.finishSyncRun(runId, {
      status: "succeeded", recordsSeen: result.totalRows, recordsInserted: inserted,
      recordsUpdated: updated, recordsSkipped: skipped,
      errorMessage: result.errors.length > 0 ? `${result.errors.length} row(s) had errors — see recordsSeen/errors in this run's output` : null
    });
    process.stdout.write(JSON.stringify({ dryRun: false, source, ...result }, null, 2) + "\n");
    if (result.errors.length > 0) process.exitCode = inserted + updated > 0 ? 0 : 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (runId) await repository.finishSyncRun(runId, { status: "failed", recordsSeen: 0, recordsInserted: 0, recordsUpdated: 0, recordsSkipped: 0, errorMessage: message }).catch(() => {});
    process.stderr.write(`Business import failed: ${message}\n`);
    process.exitCode = 1;
  } finally {
    await repository.close();
  }
}
