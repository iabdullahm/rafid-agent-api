import { importCompanyRecords } from "./importPipeline.js";
import { importMociipRecords, type MociipRawRecord } from "../sources/omanBusinessProvider.js";
import { importTaxOmanRecords, type TaxOmanRawRecord } from "../sources/taxOmanProvider.js";
import { importTenderBoardAwardRecords, importTenderBoardSupplierRecords, type TenderBoardAwardRawRecord, type TenderBoardSupplierRawRecord } from "../sources/tenderBoardProvider.js";
import type { CompanyRepository } from "../sources/companyRepository.js";

/**
 * Section 8/32: the one place that maps an import "source" key to the adapter that parses it —
 * shared verbatim by the CLI (src/businessImportCli.ts) and the Admin Import Center
 * (src/api/adminRoutes.ts), so the dashboard's preview/dry-run/execute flow can never drift from
 * what `npm run business:import` does. Neither caller re-implements row parsing/normalization —
 * both call exactly this.
 */
export const IMPORT_SOURCE_NAMES = ["generic", "mociip", "tax-oman", "tender-board-suppliers", "tender-board-awards"] as const;
export type ImportSourceName = (typeof IMPORT_SOURCE_NAMES)[number];

export interface DispatchImportResult { totalRows: number; imported: number; updated: number; skipped: number; errors: { row: number; reason: string }[] }

export async function runSourceImport(source: string, rows: readonly unknown[], repository: CompanyRepository): Promise<DispatchImportResult> {
  switch (source) {
    case "generic": return importCompanyRecords(rows, repository);
    case "mociip": return importMociipRecords(rows as MociipRawRecord[], repository);
    case "tax-oman": return importTaxOmanRecords(rows as TaxOmanRawRecord[], repository);
    case "tender-board-suppliers": return importTenderBoardSupplierRecords(rows as TenderBoardSupplierRawRecord[], repository);
    case "tender-board-awards": return importTenderBoardAwardRecords(rows as TenderBoardAwardRawRecord[], repository);
    default: throw new Error(`Unknown import source "${source}"; expected one of ${IMPORT_SOURCE_NAMES.join(", ")}`);
  }
}
