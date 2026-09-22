import type { CompanyRecord, CompanyRepository, CompanySearchQuery } from "./companyRepository.js";
import type { CompanyAwardRecord } from "../types.js";
import { DEMO_COMPANY_AWARDS, DEMO_COMPANY_RECORDS } from "./fixtures.js";

/**
 * The seam between this capability's business logic (matching/scoring, all under
 * src/business-data/) and wherever company records actually come from — mirrors
 * src/domain/oman/dataProviders.ts's OmanPropertyDataProvider seam for the property domain.
 * Swapping the data source means writing a new class that implements this interface and
 * changing which provider(s) buildCompanyProvider() is constructed with in
 * src/services/omanBusiness.ts — no change to matching, scoring, schemas, routes or MCP.
 */
export interface CompanyDataProvider {
  /** Human-readable identity for logs/tests only — never surfaced to API callers directly. */
  readonly name: string;
  /** A broad-enough candidate pool of rows for the given query — governorate/wilayat/industry
   *  filters applied, but NOT yet scored/ranked or grouped by companyId; see
   *  src/business-data/matching/search.ts for that. */
  search(query: CompanySearchQuery): Promise<readonly CompanyRecord[]>;
  /** Every row for one companyId (one per contributing source), or [] if unknown. */
  getByCompanyId(companyId: string): Promise<readonly CompanyRecord[]>;
  /** Phase 6: every procurement award/contract fact for one companyId, or [] if none — a provider
   *  with no procurement data (e.g. a licensed feed that doesn't cover Tender Board) returns []
   *  honestly rather than fabricating awards. */
  getAwardsByCompanyId(companyId: string): Promise<readonly CompanyAwardRecord[]>;
}

/**
 * The curated demo dataset provider (src/business-data/sources/fixtures.ts). Every record it
 * returns carries sourceType "demo" — never mistaken for a real source (Section 15).
 */
export class DemoCompanyProvider implements CompanyDataProvider {
  readonly name = "Rafid curated Oman business demo dataset (demo/MVP)";
  async search(query: CompanySearchQuery): Promise<readonly CompanyRecord[]> {
    return DEMO_COMPANY_RECORDS.filter(r => {
      if (query.governorate && r.governorate?.toLowerCase() !== query.governorate.toLowerCase()) return false;
      if (query.wilayat && r.wilayat?.toLowerCase() !== query.wilayat.toLowerCase()) return false;
      if (query.industry && !r.industry?.toLowerCase().includes(query.industry.toLowerCase())) return false;
      return true;
    });
  }
  async getByCompanyId(companyId: string): Promise<readonly CompanyRecord[]> {
    return DEMO_COMPANY_RECORDS.filter(r => r.companyId === companyId);
  }
  async getAwardsByCompanyId(companyId: string): Promise<readonly CompanyAwardRecord[]> {
    return DEMO_COMPANY_AWARDS.filter(a => a.companyId === companyId);
  }
}

/**
 * Adapts a production CompanyRepository (src/business-data/sources/companyRepository.ts — backed
 * by PostgreSQL in src/db/businessStore.ts, or an in-memory implementation for tests/local dev)
 * into the CompanyDataProvider shape the services layer already knows how to use.
 */
export class DatabaseCompanyProvider implements CompanyDataProvider {
  readonly name: string;
  constructor(private readonly repository: CompanyRepository) {
    this.name = `Database(${repository.name})`;
  }
  async search(query: CompanySearchQuery): Promise<readonly CompanyRecord[]> {
    return this.repository.searchCandidates(query);
  }
  async getByCompanyId(companyId: string): Promise<readonly CompanyRecord[]> {
    return this.repository.findByCompanyId(companyId);
  }
  async getAwardsByCompanyId(companyId: string): Promise<readonly CompanyAwardRecord[]> {
    return this.repository.findAwardsByCompanyId(companyId);
  }
}

/**
 * A future integration with a licensed Oman business-data feed or a partner API — never
 * unauthorized scraping. Not integrated as of this MVP; always returns empty, honestly — mirrors
 * ListingDataProvider in the property domain's dataProviders.ts.
 */
export class LicensedFeedCompanyProvider implements CompanyDataProvider {
  readonly name = "Licensed Oman business-data feed (not yet integrated)";
  async search(): Promise<readonly CompanyRecord[]> { return []; }
  async getByCompanyId(): Promise<readonly CompanyRecord[]> { return []; }
  async getAwardsByCompanyId(): Promise<readonly CompanyAwardRecord[]> { return []; }
}

/**
 * Merges results from an ordered list of providers, deduplicating by row `id` (first occurrence
 * wins — provider order matters: OMAN_BUSINESS_DATA_MODE="composite" puts the database provider
 * first and the demo provider last, so real data always wins over demo data for the same id).
 * A single provider's rejection is caught and treated as "no records from that provider" rather
 * than failing the whole request — mirrors CompositeOmanPropertyDataProvider exactly.
 */
export class CompositeCompanyProvider implements CompanyDataProvider {
  readonly name: string;
  constructor(private readonly providers: readonly CompanyDataProvider[]) {
    this.name = `Composite(${providers.map(p => p.name).join(", ")})`;
  }
  async search(query: CompanySearchQuery): Promise<readonly CompanyRecord[]> {
    const results = await Promise.all(this.providers.map(p => p.search(query).catch(() => [] as readonly CompanyRecord[])));
    return dedupeById(results.flat());
  }
  async getByCompanyId(companyId: string): Promise<readonly CompanyRecord[]> {
    const results = await Promise.all(this.providers.map(p => p.getByCompanyId(companyId).catch(() => [] as readonly CompanyRecord[])));
    return dedupeById(results.flat());
  }
  async getAwardsByCompanyId(companyId: string): Promise<readonly CompanyAwardRecord[]> {
    const results = await Promise.all(this.providers.map(p => p.getAwardsByCompanyId(companyId).catch(() => [] as readonly CompanyAwardRecord[])));
    return dedupeAwardsById(results.flat());
  }
}

function dedupeById(records: readonly CompanyRecord[]): CompanyRecord[] {
  const seen = new Set<string>();
  const result: CompanyRecord[] = [];
  for (const record of records) {
    if (seen.has(record.id)) continue;
    seen.add(record.id);
    result.push(record);
  }
  return result;
}

function dedupeAwardsById(awards: readonly CompanyAwardRecord[]): CompanyAwardRecord[] {
  const seen = new Set<string>();
  const result: CompanyAwardRecord[] = [];
  for (const award of awards) {
    if (seen.has(award.id)) continue;
    seen.add(award.id);
    result.push(award);
  }
  return result;
}
