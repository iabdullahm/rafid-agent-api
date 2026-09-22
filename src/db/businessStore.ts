import { Pool, type PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { businessSchema, businessSchemaV2, businessSchemaV3, businessSchemaV4 } from "./businessSchema.js";
import type {
  CompanyAwardInput, CompanyRecord, CompanyRecordInput, CompanyRepository, CompanySearchQuery,
  SyncRunOutcome, SyncRunRecord, UpsertResult
} from "../business-data/sources/companyRepository.js";
import type {
  AdminRowFlag, AuditLogEntry, AuditLogEntryInput, CompanyAwardRecord, UnmatchedRecord,
  UnmatchedRecordInput, UnmatchedStatus
} from "../business-data/types.js";
import { rowVerificationStatus } from "../business-data/scoring/verification.js";
import { sourceAuthority } from "../business-data/scoring/sourceTrust.js";

const MAX_CANDIDATE_ROWS = 200;

/** Applied in order against the independent `rafid_business_migrations` ledger — see migrate()'s
 *  doc comment. Adding a future version means appending here, never editing an already-applied
 *  entry's `sql` — mirrors marketStore.ts's MIGRATIONS array exactly. */
const MIGRATIONS: readonly { version: number; sql: string }[] = [
  { version: 1, sql: businessSchema },
  { version: 2, sql: businessSchemaV2 },
  { version: 3, sql: businessSchemaV3 },
  { version: 4, sql: businessSchemaV4 }
];

function toRecord(row: Record<string, unknown>): CompanyRecord {
  return {
    id: row.id as string,
    companyId: row.company_id as string,
    companyName: row.company_name as string,
    normalizedName: row.normalized_name as string,
    nameAr: (row.name_ar as string | null) ?? null,
    nameEn: (row.name_en as string | null) ?? null,
    registrationNumber: (row.registration_number as string | null) ?? null,
    legalType: (row.legal_type as string | null) ?? null,
    status: (row.status as CompanyRecordInput["status"]) ?? null,
    registrationDate: row.registration_date ? (row.registration_date as Date).toISOString().slice(0, 10) : null,
    industry: (row.industry as string | null) ?? null,
    activities: (row.activities as string[] | null) ?? [],
    governorate: (row.governorate as string | null) ?? null,
    wilayat: (row.wilayat as string | null) ?? null,
    area: (row.area as string | null) ?? null,
    address: (row.address as string | null) ?? null,
    website: (row.website as string | null) ?? null,
    email: (row.email as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    vatNumber: (row.vat_number as string | null) ?? null,
    vatStatus: (row.vat_status as string | null) ?? null,
    employeeRange: (row.employee_range as string | null) ?? null,
    estimatedCompanySize: (row.estimated_company_size as string | null) ?? null,
    sourceType: row.source_type as CompanyRecordInput["sourceType"],
    sourceName: row.source_name as string,
    sourceRecordId: (row.source_record_id as string | null) ?? null,
    sourceUrl: (row.source_url as string | null) ?? null,
    observedAt: (row.observed_at as Date).toISOString(),
    ingestedAt: (row.ingested_at as Date).toISOString(),
    metadata: (row.metadata as Record<string, unknown>) ?? {},

    registeredSupplier: (row.registered_supplier as boolean | null) ?? null,
    supplierCategory: (row.supplier_category as string | null) ?? null,
    supplierClassification: (row.supplier_classification as string | null) ?? null,
    governmentProcurementPresence: (row.government_procurement_presence as boolean | null) ?? null,
    tendersParticipated: (row.tenders_participated as number | null) ?? null,
    awardedContractCount: (row.awarded_contract_count as number | null) ?? null,
    lastTenderActivityAt: row.last_tender_activity_at ? (row.last_tender_activity_at as Date).toISOString() : null,

    taxVerificationStatus: (row.tax_verification_status as string | null) ?? null,
    taxVerifiedAt: row.tax_verified_at ? (row.tax_verified_at as Date).toISOString() : null,

    firstSeenAt: (row.first_seen_at as Date).toISOString(),
    lastSeenAt: (row.last_seen_at as Date).toISOString(),
    recordVersion: row.record_version as number,
    verificationStatus: row.verification_status as CompanyRecord["verificationStatus"],
    lastVerifiedAt: row.last_verified_at ? (row.last_verified_at as Date).toISOString() : null,

    adminFlag: (row.admin_flag as AdminRowFlag | null) ?? null,
    adminFlagNote: (row.admin_flag_note as string | null) ?? null,
    adminFlagAt: row.admin_flag_at ? (row.admin_flag_at as Date).toISOString() : null
  };
}

function toUnmatchedRecord(row: Record<string, unknown>): UnmatchedRecord {
  return {
    id: row.id as string,
    sourceType: row.source_type as UnmatchedRecord["sourceType"],
    sourceName: row.source_name as string,
    rawPayload: (row.raw_payload as Record<string, unknown>) ?? {},
    reason: row.reason as UnmatchedRecord["reason"],
    reasonDetail: (row.reason_detail as string) ?? "",
    status: row.status as UnmatchedStatus,
    linkedCompanyId: (row.linked_company_id as string | null) ?? null,
    createdAt: (row.created_at as Date).toISOString(),
    resolvedAt: row.resolved_at ? (row.resolved_at as Date).toISOString() : null,
    resolvedBy: (row.resolved_by as string | null) ?? null,
    note: (row.note as string | null) ?? null
  };
}

function toAuditLogEntry(row: Record<string, unknown>): AuditLogEntry {
  return {
    id: row.id as string,
    occurredAt: (row.occurred_at as Date).toISOString(),
    adminUser: row.admin_user as string,
    action: row.action as string,
    entityType: (row.entity_type as string | null) ?? null,
    entityId: (row.entity_id as string | null) ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? {}
  };
}

function toSyncRunRecord(row: Record<string, unknown>): SyncRunRecord {
  return {
    id: row.id as string,
    sourceName: row.source_name as string,
    startedAt: (row.started_at as Date).toISOString(),
    finishedAt: row.finished_at ? (row.finished_at as Date).toISOString() : null,
    status: row.status as SyncRunRecord["status"],
    recordsSeen: row.records_seen as number,
    recordsInserted: row.records_inserted as number,
    recordsUpdated: row.records_updated as number,
    recordsSkipped: row.records_skipped as number,
    errorMessage: (row.error_message as string | null) ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? {}
  };
}

function toAwardRecord(row: Record<string, unknown>): CompanyAwardRecord {
  return {
    id: row.id as string,
    companyId: row.company_id as string,
    tenderNumber: row.tender_number as string,
    buyer: (row.buyer as string | null) ?? null,
    title: (row.title as string | null) ?? null,
    status: (row.status as string | null) ?? null,
    awardValueOMR: row.award_value_omr === null || row.award_value_omr === undefined ? null : Number(row.award_value_omr),
    category: (row.category as string | null) ?? null,
    sourceName: row.source_name as string,
    observedAt: (row.observed_at as Date).toISOString()
  };
}

/**
 * The real, PostgreSQL-backed CompanyRepository. Its own migration ledger
 * (`rafid_business_migrations`) and advisory-lock number (74382003 — distinct from
 * store.ts's 74382001 and marketStore.ts's 74382002) so business-data migrations never contend
 * with customer/billing or property market-data migrations, and can be run independently.
 */
export class PostgresCompanyRepository implements CompanyRepository {
  readonly name = "PostgreSQL oman_companies";
  readonly pool: Pool;
  constructor(url: string) {
    this.pool = new Pool({ connectionString: url, max: 5, connectionTimeoutMillis: 5000, statement_timeout: 10000, idle_in_transaction_session_timeout: 10000 });
    this.pool.on("error", () => process.stderr.write("Business database connection failure\n"));
  }
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try { await c.query("BEGIN"); const result = await fn(c); await c.query("COMMIT"); return result; }
    catch (error) { await c.query("ROLLBACK").catch(() => {}); throw error; }
    finally { c.release(); }
  }
  /** Applies every not-yet-applied entry in MIGRATIONS, in order, against the same
   *  `rafid_business_migrations` ledger — so adding businessSchemaV2 (version 2) never disturbs an
   *  already-applied version-1 deployment: each version is checked and applied independently. */
  async migrate() {
    await this.transaction(async c => {
      await c.query("SELECT pg_advisory_xact_lock(74382003)");
      await c.query("CREATE TABLE IF NOT EXISTS rafid_business_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
      for (const migration of MIGRATIONS) {
        const existing = await c.query("SELECT version FROM rafid_business_migrations WHERE version=$1", [migration.version]);
        if (!existing.rowCount) { await c.query(migration.sql); await c.query("INSERT INTO rafid_business_migrations(version) VALUES($1)", [migration.version]); }
      }
    });
  }
  async ready() {
    const latestVersion = MIGRATIONS[MIGRATIONS.length - 1]!.version;
    await this.pool.query("SELECT version FROM rafid_business_migrations WHERE version=$1", [latestVersion])
      .then(r => { if (!r.rowCount) throw new Error("Business data migration required"); });
  }

  async searchCandidates(query: CompanySearchQuery): Promise<readonly CompanyRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    const needle = query.query.trim();
    if (needle) {
      params.push(`%${needle.toUpperCase()}%`, needle, needle);
      conditions.push(`(normalized_name ILIKE $${params.length - 2} OR company_name ILIKE '%' || $${params.length - 1} || '%' OR registration_number = $${params.length})`);
    }
    if (query.governorate) { params.push(query.governorate); conditions.push(`governorate = $${params.length}`); }
    if (query.wilayat) { params.push(query.wilayat); conditions.push(`wilayat = $${params.length}`); }
    if (query.industry) { params.push(`%${query.industry}%`); conditions.push(`industry ILIKE $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(MAX_CANDIDATE_ROWS, query.candidateLimit ?? MAX_CANDIDATE_ROWS));
    const sql = `SELECT * FROM oman_companies ${where} ORDER BY observed_at DESC LIMIT ${limit}`;
    const result = await this.pool.query(sql, params);
    return result.rows.map(toRecord);
  }

  async findByCompanyId(companyId: string): Promise<readonly CompanyRecord[]> {
    const result = await this.pool.query("SELECT * FROM oman_companies WHERE company_id = $1 ORDER BY observed_at DESC", [companyId]);
    return result.rows.map(toRecord);
  }

  async upsertCompanies(records: readonly CompanyRecordInput[]): Promise<UpsertResult> {
    let inserted = 0, updated = 0, skipped = 0;
    await this.transaction(async c => {
      for (const r of records) {
        const verificationStatus = r.verificationStatus ?? rowVerificationStatus(r.sourceType, r.observedAt);
        const lastVerifiedAt = r.lastVerifiedAt ?? (sourceAuthority(r.sourceType) >= 0.90 ? r.observedAt : null);

        const existingBySource = r.sourceRecordId
          ? await c.query("SELECT id, company_id, first_seen_at, last_seen_at, record_version FROM oman_companies WHERE source_name=$1 AND source_record_id=$2", [r.sourceName, r.sourceRecordId])
          : { rows: [] as Array<{ id: string; company_id: string; first_seen_at: Date; last_seen_at: Date; record_version: number }> };
        if (existingBySource.rows[0]) {
          const { id, company_id: companyId, last_seen_at: priorLastSeenAt, record_version: priorVersion } = existingBySource.rows[0];
          const lastSeenAt = r.observedAt > priorLastSeenAt.toISOString() ? r.observedAt : priorLastSeenAt.toISOString();
          await c.query(
            `UPDATE oman_companies SET company_name=$3,normalized_name=$4,name_ar=$5,name_en=$6,registration_number=$7,
              legal_type=$8,status=$9,registration_date=$10,industry=$11,activities=$12,governorate=$13,wilayat=$14,area=$15,
              address=$16,website=$17,email=$18,phone=$19,vat_number=$20,vat_status=$21,employee_range=$22,
              estimated_company_size=$23,source_type=$24,source_url=$25,observed_at=$26,metadata=$27,
              registered_supplier=$28,supplier_category=$29,supplier_classification=$30,government_procurement_presence=$31,
              tenders_participated=$32,awarded_contract_count=$33,last_tender_activity_at=$34,
              tax_verification_status=$35,tax_verified_at=$36,
              last_seen_at=$37,record_version=$38,verification_status=$39,last_verified_at=$40
             WHERE id=$1 AND company_id=$2`,
            [id, companyId, r.companyName, r.normalizedName, r.nameAr, r.nameEn, r.registrationNumber,
              r.legalType, r.status, r.registrationDate, r.industry, JSON.stringify(r.activities), r.governorate, r.wilayat, r.area,
              r.address, r.website, r.email, r.phone, r.vatNumber, r.vatStatus, r.employeeRange,
              r.estimatedCompanySize, r.sourceType, r.sourceUrl, r.observedAt, JSON.stringify(r.metadata),
              r.registeredSupplier ?? null, r.supplierCategory ?? null, r.supplierClassification ?? null, r.governmentProcurementPresence ?? null,
              r.tendersParticipated ?? null, r.awardedContractCount ?? null, r.lastTenderActivityAt ?? null,
              r.taxVerificationStatus ?? null, r.taxVerifiedAt ?? null,
              lastSeenAt, priorVersion + 1, verificationStatus, lastVerifiedAt]
          );
          updated++;
          continue;
        }

        // Deterministic identity resolution (never an LLM guess) — see companyRepository.ts's
        // doc comment: an exact registration-number match wins; otherwise an exact
        // normalizedName+governorate match; otherwise this row starts a new company identity.
        let companyId: string | null = null;
        if (r.registrationNumber) {
          const byReg = await c.query("SELECT company_id FROM oman_companies WHERE registration_number=$1 LIMIT 1", [r.registrationNumber]);
          if (byReg.rows[0]) companyId = byReg.rows[0].company_id as string;
        }
        if (!companyId && r.governorate) {
          const byName = await c.query("SELECT company_id FROM oman_companies WHERE normalized_name=$1 AND governorate=$2 LIMIT 1", [r.normalizedName, r.governorate]);
          if (byName.rows[0]) companyId = byName.rows[0].company_id as string;
        }
        const rowId = randomUUID();
        companyId = companyId ?? rowId;
        await c.query(
          `INSERT INTO oman_companies
            (id,company_id,company_name,normalized_name,name_ar,name_en,registration_number,legal_type,status,
             registration_date,industry,activities,governorate,wilayat,area,address,website,email,phone,
             vat_number,vat_status,employee_range,estimated_company_size,source_type,source_name,source_record_id,
             source_url,observed_at,metadata,
             registered_supplier,supplier_category,supplier_classification,government_procurement_presence,
             tenders_participated,awarded_contract_count,last_tender_activity_at,
             tax_verification_status,tax_verified_at,
             first_seen_at,last_seen_at,record_version,verification_status,last_verified_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,
             $30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43)`,
          [rowId, companyId, r.companyName, r.normalizedName, r.nameAr, r.nameEn, r.registrationNumber, r.legalType, r.status,
            r.registrationDate, r.industry, JSON.stringify(r.activities), r.governorate, r.wilayat, r.area, r.address, r.website,
            r.email, r.phone, r.vatNumber, r.vatStatus, r.employeeRange, r.estimatedCompanySize, r.sourceType, r.sourceName,
            r.sourceRecordId, r.sourceUrl, r.observedAt, JSON.stringify(r.metadata),
            r.registeredSupplier ?? null, r.supplierCategory ?? null, r.supplierClassification ?? null, r.governmentProcurementPresence ?? null,
            r.tendersParticipated ?? null, r.awardedContractCount ?? null, r.lastTenderActivityAt ?? null,
            r.taxVerificationStatus ?? null, r.taxVerifiedAt ?? null,
            r.observedAt, r.observedAt, 1, verificationStatus, lastVerifiedAt]
        );
        inserted++;
      }
    });
    return { inserted, updated, skipped };
  }

  async upsertAwards(companyId: string, awards: readonly CompanyAwardInput[]): Promise<void> {
    if (awards.length === 0) return;
    await this.transaction(async c => {
      for (const a of awards) {
        await c.query(
          `INSERT INTO oman_company_awards (id,company_id,tender_number,buyer,title,status,award_value_omr,category,source_name,observed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (company_id, source_name, tender_number) DO UPDATE SET
             buyer=EXCLUDED.buyer, title=EXCLUDED.title, status=EXCLUDED.status, award_value_omr=EXCLUDED.award_value_omr,
             category=EXCLUDED.category, observed_at=EXCLUDED.observed_at`,
          [randomUUID(), companyId, a.tenderNumber, a.buyer, a.title, a.status, a.awardValueOMR, a.category, a.sourceName, a.observedAt]
        );
      }
    });
  }

  async findAwardsByCompanyId(companyId: string): Promise<readonly CompanyAwardRecord[]> {
    const result = await this.pool.query("SELECT * FROM oman_company_awards WHERE company_id = $1 ORDER BY observed_at DESC", [companyId]);
    return result.rows.map(toAwardRecord);
  }

  async startSyncRun(sourceName: string): Promise<string> {
    const id = randomUUID();
    await this.pool.query(
      `INSERT INTO business_source_sync_runs (id, source_name, started_at, status) VALUES ($1, $2, now(), 'running')`,
      [id, sourceName]
    );
    return id;
  }

  async finishSyncRun(runId: string, outcome: SyncRunOutcome): Promise<void> {
    await this.pool.query(
      `UPDATE business_source_sync_runs SET finished_at = now(), status = $2, records_seen = $3,
        records_inserted = $4, records_updated = $5, records_skipped = $6, error_message = $7, metadata = $8
       WHERE id = $1`,
      [runId, outcome.status, outcome.recordsSeen, outcome.recordsInserted, outcome.recordsUpdated, outcome.recordsSkipped, outcome.errorMessage, JSON.stringify(outcome.metadata ?? {})]
    );
  }

  async findSyncRuns(sourceName: string, limit = 20): Promise<readonly SyncRunRecord[]> {
    const result = await this.pool.query(
      "SELECT * FROM business_source_sync_runs WHERE source_name = $1 ORDER BY started_at DESC LIMIT $2",
      [sourceName, Math.max(1, Math.min(100, limit))]
    );
    return result.rows.map(toSyncRunRecord);
  }

  // ---- Admin & Data Operations Dashboard ----------------------------------------------------

  async adminListAllRows(limit = 20_000): Promise<readonly CompanyRecord[]> {
    const result = await this.pool.query(
      "SELECT * FROM oman_companies ORDER BY observed_at DESC LIMIT $1",
      [Math.max(1, Math.min(20_000, limit))]
    );
    return result.rows.map(toRecord);
  }

  async adminListAllAwards(limit = 20_000): Promise<readonly CompanyAwardRecord[]> {
    const result = await this.pool.query(
      "SELECT * FROM oman_company_awards ORDER BY observed_at DESC LIMIT $1",
      [Math.max(1, Math.min(20_000, limit))]
    );
    return result.rows.map(toAwardRecord);
  }

  async findAllSyncRuns(limit = 50): Promise<readonly SyncRunRecord[]> {
    const result = await this.pool.query(
      "SELECT * FROM business_source_sync_runs ORDER BY started_at DESC LIMIT $1",
      [Math.max(1, Math.min(200, limit))]
    );
    return result.rows.map(toSyncRunRecord);
  }

  async attachSourceRecord(companyId: string, r: CompanyRecordInput): Promise<CompanyRecord> {
    const verificationStatus = r.verificationStatus ?? rowVerificationStatus(r.sourceType, r.observedAt);
    const lastVerifiedAt = r.lastVerifiedAt ?? (sourceAuthority(r.sourceType) >= 0.90 ? r.observedAt : null);
    return this.transaction(async c => {
      const existingBySource = r.sourceRecordId
        ? await c.query("SELECT id, first_seen_at, last_seen_at, record_version FROM oman_companies WHERE source_name=$1 AND source_record_id=$2", [r.sourceName, r.sourceRecordId])
        : { rows: [] as Array<{ id: string; first_seen_at: Date; last_seen_at: Date; record_version: number }> };
      if (existingBySource.rows[0]) {
        const { id, last_seen_at: priorLastSeenAt, record_version: priorVersion } = existingBySource.rows[0];
        const lastSeenAt = r.observedAt > priorLastSeenAt.toISOString() ? r.observedAt : priorLastSeenAt.toISOString();
        const updated = await c.query(
          `UPDATE oman_companies SET company_id=$2,company_name=$3,normalized_name=$4,name_ar=$5,name_en=$6,registration_number=$7,
            legal_type=$8,status=$9,registration_date=$10,industry=$11,activities=$12,governorate=$13,wilayat=$14,area=$15,
            address=$16,website=$17,email=$18,phone=$19,vat_number=$20,vat_status=$21,employee_range=$22,
            estimated_company_size=$23,source_type=$24,source_url=$25,observed_at=$26,metadata=$27,
            registered_supplier=$28,supplier_category=$29,supplier_classification=$30,government_procurement_presence=$31,
            tenders_participated=$32,awarded_contract_count=$33,last_tender_activity_at=$34,
            tax_verification_status=$35,tax_verified_at=$36,
            last_seen_at=$37,record_version=$38,verification_status=$39,last_verified_at=$40
           WHERE id=$1 RETURNING *`,
          [id, companyId, r.companyName, r.normalizedName, r.nameAr, r.nameEn, r.registrationNumber,
            r.legalType, r.status, r.registrationDate, r.industry, JSON.stringify(r.activities), r.governorate, r.wilayat, r.area,
            r.address, r.website, r.email, r.phone, r.vatNumber, r.vatStatus, r.employeeRange,
            r.estimatedCompanySize, r.sourceType, r.sourceUrl, r.observedAt, JSON.stringify(r.metadata),
            r.registeredSupplier ?? null, r.supplierCategory ?? null, r.supplierClassification ?? null, r.governmentProcurementPresence ?? null,
            r.tendersParticipated ?? null, r.awardedContractCount ?? null, r.lastTenderActivityAt ?? null,
            r.taxVerificationStatus ?? null, r.taxVerifiedAt ?? null,
            lastSeenAt, priorVersion + 1, verificationStatus, lastVerifiedAt]
        );
        return toRecord(updated.rows[0]!);
      }
      const rowId = randomUUID();
      const inserted = await c.query(
        `INSERT INTO oman_companies
          (id,company_id,company_name,normalized_name,name_ar,name_en,registration_number,legal_type,status,
           registration_date,industry,activities,governorate,wilayat,area,address,website,email,phone,
           vat_number,vat_status,employee_range,estimated_company_size,source_type,source_name,source_record_id,
           source_url,observed_at,metadata,
           registered_supplier,supplier_category,supplier_classification,government_procurement_presence,
           tenders_participated,awarded_contract_count,last_tender_activity_at,
           tax_verification_status,tax_verified_at,
           first_seen_at,last_seen_at,record_version,verification_status,last_verified_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,
           $30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43) RETURNING *`,
        [rowId, companyId, r.companyName, r.normalizedName, r.nameAr, r.nameEn, r.registrationNumber, r.legalType, r.status,
          r.registrationDate, r.industry, JSON.stringify(r.activities), r.governorate, r.wilayat, r.area, r.address, r.website,
          r.email, r.phone, r.vatNumber, r.vatStatus, r.employeeRange, r.estimatedCompanySize, r.sourceType, r.sourceName,
          r.sourceRecordId, r.sourceUrl, r.observedAt, JSON.stringify(r.metadata),
          r.registeredSupplier ?? null, r.supplierCategory ?? null, r.supplierClassification ?? null, r.governmentProcurementPresence ?? null,
          r.tendersParticipated ?? null, r.awardedContractCount ?? null, r.lastTenderActivityAt ?? null,
          r.taxVerificationStatus ?? null, r.taxVerifiedAt ?? null,
          r.observedAt, r.observedAt, 1, verificationStatus, lastVerifiedAt]
      );
      return toRecord(inserted.rows[0]!);
    });
  }

  async relinkRow(rowId: string, companyId: string): Promise<void> {
    const result = await this.pool.query("UPDATE oman_companies SET company_id=$2 WHERE id=$1", [rowId, companyId]);
    if (result.rowCount === 0) throw new Error(`No row found with id "${rowId}"`);
  }

  async setAdminRowFlag(rowId: string, flag: AdminRowFlag | null, note: string | null): Promise<void> {
    const result = await this.pool.query(
      "UPDATE oman_companies SET admin_flag=$2, admin_flag_note=$3, admin_flag_at=now() WHERE id=$1",
      [rowId, flag, note]
    );
    if (result.rowCount === 0) throw new Error(`No row found with id "${rowId}"`);
  }

  async findRowById(rowId: string): Promise<CompanyRecord | null> {
    const result = await this.pool.query("SELECT * FROM oman_companies WHERE id=$1", [rowId]);
    return result.rows[0] ? toRecord(result.rows[0]) : null;
  }

  async recordUnmatched(entries: readonly UnmatchedRecordInput[]): Promise<void> {
    if (entries.length === 0) return;
    await this.transaction(async c => {
      for (const e of entries) {
        await c.query(
          `INSERT INTO business_unmatched_records (id, source_type, source_name, raw_payload, reason, reason_detail)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [randomUUID(), e.sourceType, e.sourceName, JSON.stringify(e.rawPayload), e.reason, e.reasonDetail]
        );
      }
    });
  }

  async listUnmatched(status?: UnmatchedStatus, limit = 500): Promise<readonly UnmatchedRecord[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (status) { params.push(status); conditions.push(`status = $${params.length}`); }
    params.push(Math.max(1, Math.min(2000, limit)));
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query(`SELECT * FROM business_unmatched_records ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    return result.rows.map(toUnmatchedRecord);
  }

  async resolveUnmatched(id: string, resolution: { status: Exclude<UnmatchedStatus, "unresolved">; linkedCompanyId?: string | null; note?: string | null; resolvedBy: string }): Promise<void> {
    const result = await this.pool.query(
      `UPDATE business_unmatched_records SET status=$2, linked_company_id=$3, note=$4, resolved_at=now(), resolved_by=$5 WHERE id=$1`,
      [id, resolution.status, resolution.linkedCompanyId ?? null, resolution.note ?? null, resolution.resolvedBy]
    );
    if (result.rowCount === 0) throw new Error(`No unmatched record found with id "${id}"`);
  }

  async writeAuditLog(entry: AuditLogEntryInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO business_admin_audit_log (id, admin_user, action, entity_type, entity_id, metadata) VALUES ($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), entry.adminUser, entry.action, entry.entityType, entry.entityId, JSON.stringify(entry.metadata)]
    );
  }

  async listAuditLog(filter: { limit?: number; action?: string; entityType?: string } = {}): Promise<readonly AuditLogEntry[]> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (filter.action) { params.push(filter.action); conditions.push(`action = $${params.length}`); }
    if (filter.entityType) { params.push(filter.entityType); conditions.push(`entity_type = $${params.length}`); }
    params.push(Math.max(1, Math.min(2000, filter.limit ?? 200)));
    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query(`SELECT * FROM business_admin_audit_log ${where} ORDER BY occurred_at DESC LIMIT $${params.length}`, params);
    return result.rows.map(toAuditLogEntry);
  }

  async close() { await this.pool.end(); }
}
