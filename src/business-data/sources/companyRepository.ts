import type {
  AdminRowFlag, AuditLogEntry, AuditLogEntryInput, CompanyAwardRecord, CompanySourceType, CompanyStatus,
  UnmatchedRecord, UnmatchedRecordInput, UnmatchedStatus, VerificationStatus
} from "../types.js";
import { rowVerificationStatus } from "../scoring/verification.js";
import { sourceAuthority } from "../scoring/sourceTrust.js";

/**
 * The seam between the business-intelligence business logic (matching/scoring, all under
 * src/business-data/) and a real, production data store — mirrors
 * src/domain/oman/marketRepository.ts's split for the property domain.
 * `src/db/businessStore.ts` provides the real PostgreSQL-backed implementation;
 * `MemoryCompanyRepository` below is a full in-memory implementation for tests and for local
 * development without provisioning Postgres.
 *
 * Identity model: one ROW per ingested (source, source record) — a company observed by three
 * different sources produces three rows. Rows that represent the same real company share a
 * `companyId`. Section 4's "identity matching must be deterministic" applies here too: a new
 * row's companyId is resolved, in order —
 *   1. an existing row with the exact same non-null `registrationNumber` (the authoritative key)
 *   2. an existing row with the exact same `normalizedName` + `governorate` (a soft key, for
 *      sources that don't carry a registration number)
 *   3. otherwise this row starts a new companyId (its own row id)
 * — never an LLM guess, never fuzzy similarity. `searchCandidates` returns raw rows; grouping rows
 * by companyId into one search "match" per company (picking the most authoritative/most recent
 * row as the representative) is the matching layer's job (src/business-data/matching/search.ts),
 * exactly like PropertyMarketRepository returning an unscored candidate pool for comparables.ts.
 */

export interface CompanyRecordInput {
  companyName: string;
  normalizedName: string;
  nameAr: string | null;
  nameEn: string | null;
  registrationNumber: string | null;
  legalType: string | null;
  status: CompanyStatus | null;
  registrationDate: string | null; // ISO date, e.g. "2019-03-14"
  industry: string | null;
  activities: readonly string[];
  governorate: string | null;
  wilayat: string | null;
  area: string | null;
  address: string | null;
  website: string | null;
  email: string | null;
  phone: string | null;
  vatNumber: string | null;
  vatStatus: string | null;
  employeeRange: string | null;
  estimatedCompanySize: string | null;
  sourceType: CompanySourceType;
  sourceName: string;
  /** The source system's own identifier for this record, when it has one. Combined with
   *  sourceName for deduplication on ingestion — see upsertCompanies(). Null for a source with no
   *  stable per-record identifier (always inserted as new). */
  sourceRecordId: string | null;
  sourceUrl: string | null;
  /** ISO date/timestamp the record represents (when the source last observed these facts), NOT
   *  when Rafid imported it — see `ingestedAt`. */
  observedAt: string;
  metadata: Record<string, unknown>;

  // --- Phase 6: procurement snapshot fields (Tender Board/Esnad). Flat per-source-row fields,
  // same row-per-source model as everything else — merged like any other field by
  // matching/merge.ts. Individual award/contract facts are list-shaped and live in
  // oman_company_awards instead (see CompanyAwardInput/upsertAwards below), never here. All
  // optional: a non-procurement source row simply omits them, and they default to null. ---
  registeredSupplier?: boolean | null;
  supplierCategory?: string | null;
  supplierClassification?: string | null;
  governmentProcurementPresence?: boolean | null;
  tendersParticipated?: number | null;
  awardedContractCount?: number | null;
  lastTenderActivityAt?: string | null;

  // --- Phase 5: tax/VAT verification snapshot fields (Tax Oman). Optional for the same reason —
  // only a tax_authority source row populates these; every other row leaves them undefined/null.
  // taxVerificationStatus is a verification OUTCOME ("verified" | "not_registered" | ...), never
  // inferred from a company merely existing — see taxOmanProvider.ts. ---
  taxVerificationStatus?: string | null;
  taxVerifiedAt?: string | null;

  // --- Phase 3: freshness/verification metadata. Optional on input (sensible defaults are
  // applied by the repository at write time — see resolveCompanyId's neighbors below and
  // PostgresCompanyRepository.upsertCompanies), always present on the stored CompanyRecord. ---
  /** Explicit verification outcome for this row, when the caller already knows it (e.g. a
   *  provider adapter that computed it before calling upsertCompanies). When omitted, the
   *  repository derives it from sourceType + freshness at write time
   *  (src/business-data/scoring/verification.ts). */
  verificationStatus?: VerificationStatus;
  /** When this row's facts were last actively re-verified against the source, distinct from
   *  observedAt (when the source's own data was as of). Defaults to observedAt for a source type
   *  trusted enough to count as verification on its own (authority >= 0.90); null otherwise
   *  unless explicitly supplied. */
  lastVerifiedAt?: string | null;

  // --- Admin & Data Operations Dashboard (Section 14/15): a conservative, manual disposition an
  // operator has attached to THIS row — see types.ts's AdminRowFlag doc comment. Always optional
  // on input/undefined by default; set only via CompanyRepository.setAdminRowFlag, never as a
  // side effect of a normal source import. ---
  adminFlag?: AdminRowFlag | null;
  adminFlagNote?: string | null;
  adminFlagAt?: string | null;
}

export interface CompanyRecord extends CompanyRecordInput {
  /** Row id — unique per ingested (source, source record). */
  id: string;
  /** Entity id — shared by every row this repository has resolved to the same real company. See
   *  this file's doc comment for the deterministic resolution order. */
  companyId: string;
  ingestedAt: string;
  /** Phase 3: when this exact (sourceName, sourceRecordId) row was first ingested — never changes
   *  once set, even across repeated re-imports/updates of the same row. */
  firstSeenAt: string;
  /** Phase 3: the most recent observedAt this row has carried across every re-import — advances
   *  forward only; an older re-import of the same row never moves it backward. */
  lastSeenAt: string;
  /** Phase 3: incremented every time this exact row is updated by a re-import (Phase 12's
   *  incremental sync) — starts at 1 on first insert, never reset. */
  recordVersion: number;
  /** Always present on a stored record — see CompanyRecordInput.verificationStatus above for how
   *  it's derived when not explicitly supplied. */
  verificationStatus: VerificationStatus;
  lastVerifiedAt: string | null;
}

/** Phase 6: input shape for one procurement award/contract fact — see CompanyAwardRecord
 *  (types.ts) for the stored shape. Never fabricated: `id` is assigned by the repository. */
export type CompanyAwardInput = Omit<CompanyAwardRecord, "id">;

/** Phase 13: auditability — one row per ingestion attempt against a given source, independent of
 *  the company data itself. Every source-specific import adapter (omanBusinessProvider.ts,
 *  taxOmanProvider.ts, tenderBoardProvider.ts) and the generic CLI (businessImportCli.ts) records
 *  one of these around each run, so "when did we last try to sync source X, and what happened" is
 *  answerable without inferring it from oman_companies.observed_at/ingested_at timestamps — those
 *  describe the DATA's own freshness, not the ingestion process's history. */
export type SyncRunStatus = "running" | "succeeded" | "failed";
export interface SyncRunRecord {
  id: string;
  sourceName: string;
  startedAt: string;
  finishedAt: string | null;
  status: SyncRunStatus;
  recordsSeen: number;
  recordsInserted: number;
  recordsUpdated: number;
  recordsSkipped: number;
  errorMessage: string | null;
  /** Section 20: a small, structured summary of the run — e.g. the source file name, sheet/row
   *  counts, the identity-repair strategy used — never the imported content itself (Section 20:
   *  "Do not store unnecessary workbook contents in audit metadata"). Always present (defaults to
   *  {} for a run that predates this field or didn't supply one), added additively in
   *  businessSchemaV4 alongside business_source_sync_runs' original columns. */
  metadata: Record<string, unknown>;
}
export interface SyncRunOutcome {
  status: Exclude<SyncRunStatus, "running">;
  recordsSeen: number;
  recordsInserted: number;
  recordsUpdated: number;
  recordsSkipped: number;
  errorMessage: string | null;
  /** See SyncRunRecord.metadata above. Optional — omitted (defaults to {}) by every pre-existing
   *  caller (the generic/MOCIIP/Tax Oman/Tender Board adapters never had anything to report here). */
  metadata?: Record<string, unknown>;
}

export interface CompanySearchQuery {
  query: string;
  governorate?: string;
  wilayat?: string;
  industry?: string;
  /** Repository-level candidate-row cap, distinct from the capability's own result `limit` — see
   *  searchCandidates's doc comment. */
  candidateLimit?: number;
}

export interface UpsertResult {
  inserted: number;
  updated: number;
  skipped: number;
}

export interface CompanyRepository {
  readonly name: string;
  /**
   * Returns a broad-enough candidate pool of ROWS (not yet grouped by companyId or scored) for
   * the given free-text query and optional filters, using only cheap, indexed SQL filtering
   * (exact registration-number match, a normalized-name prefix/contains match, plus the optional
   * governorate/wilayat/industry filters). All ranking (exact/prefix/fuzzy/location/industry
   * weighting, confidence) and companyId grouping happen afterwards in
   * src/business-data/matching/search.ts. Capped by `query.candidateLimit`.
   */
  searchCandidates(query: CompanySearchQuery): Promise<readonly CompanyRecord[]>;
  /** Every row resolved to one companyId (one per contributing source) — used to build
   *  get_oman_company_profile's merged view and its `sources` provenance list. */
  findByCompanyId(companyId: string): Promise<readonly CompanyRecord[]>;
  /** Insert-or-update rows, deduplicating on (sourceName, sourceRecordId) where both are present
   *  (a record with no sourceRecordId is always inserted as new), and resolving each row's
   *  companyId per this file's doc comment. */
  upsertCompanies(records: readonly CompanyRecordInput[]): Promise<UpsertResult>;
  /** Phase 6: insert-or-update the full set of award/contract records for one company, keyed on
   *  (sourceName, tenderNumber) — re-importing the same award updates it in place rather than
   *  duplicating it. Never deletes an award that a later import simply omits (Phase 12's
   *  non-destructive incremental sync applies here too). */
  upsertAwards(companyId: string, awards: readonly CompanyAwardInput[]): Promise<void>;
  /** Every award/contract record resolved to this companyId, most recent observedAt first. */
  findAwardsByCompanyId(companyId: string): Promise<readonly CompanyAwardRecord[]>;
  /** Phase 13: records the start of an ingestion attempt against `sourceName`, returning the new
   *  run's id — pass it to finishSyncRun once the run completes (successfully or not). */
  startSyncRun(sourceName: string): Promise<string>;
  /** Marks a previously-started run finished, with its final outcome. Idempotent-in-intent: called
   *  exactly once per startSyncRun, including on failure (see businessImportCli.ts's try/finally). */
  finishSyncRun(runId: string, outcome: SyncRunOutcome): Promise<void>;
  /** Most recent sync runs for one source, most recent first — capped at `limit` (default 20). */
  findSyncRuns(sourceName: string, limit?: number): Promise<readonly SyncRunRecord[]>;

  // ============================================================================================
  // Admin & Data Operations Dashboard (Oman Business Intelligence Admin & Data Operations
  // Dashboard spec) — every method below exists only to let the admin UI/API answer "what's in
  // the dataset right now" and record conservative, auditable manual operator actions. None of
  // them are used by the paid search/profile/analyze/due-diligence capabilities or by the CLI's
  // normal import path; they are read/write seams for src/business-data/admin/adminService.ts
  // only. Built for this MVP's target dataset scale (thousands, not millions, of rows — see
  // datasetTargets.ts) as a full scan grouped in memory; a future scale-up would add materialized
  // aggregates/indexes here without changing this interface's shape.
  // ============================================================================================

  /** Every row currently stored, most recently observed first, capped at `limit` (default 20,000
   *  — comfortably above every dataset target in datasetTargets.ts). The admin dashboard's one
   *  full-scan read seam: every other admin query (company list, conflicts, stale, data quality,
   *  procurement, coverage) groups this same array by companyId rather than issuing a separate
   *  repository call each, so they can never disagree with each other mid-request. */
  adminListAllRows(limit?: number): Promise<readonly CompanyRecord[]>;
  /** Every award/contract record currently stored, most recently observed first. */
  adminListAllAwards(limit?: number): Promise<readonly CompanyAwardRecord[]>;
  /** Most recent sync runs across EVERY source (Import History, Section 11) — unlike
   *  findSyncRuns(sourceName), not filtered to one source. */
  findAllSyncRuns(limit?: number): Promise<readonly SyncRunRecord[]>;

  /** Inserts (or, on a re-submitted sourceRecordId, updates) one new evidence row directly under
   *  the given `companyId` — bypassing the normal registrationNumber/name+governorate identity
   *  resolution in resolveCompanyId(), because the caller (manual evidence entry, Tax Oman manual
   *  verification, conflict-resolution "confirm same company") already knows exactly which
   *  company this evidence belongs to and must never have it silently re-resolved to a different
   *  one. Section 12/21: "persist source evidence first, then recalculate the merged company
   *  view" — this is that persistence step; recalculation itself is just re-reading (see
   *  adminService.ts's buildCompanyAdminView, which is always live, never cached). */
  attachSourceRecord(companyId: string, record: CompanyRecordInput): Promise<CompanyRecord>;
  /** Reassigns one existing ROW to a different (or brand-new) companyId — the only way a
   *  companyId ever changes after insertion. Used by conflict resolution's "keep separate" (split
   *  a wrongly-merged row out into its own companyId) and by unmatched-record linking (attach a
   *  previously-unresolved row to an existing company). Never fuzzy, never automatic — always one
   *  explicit operator-confirmed call naming both ids. */
  relinkRow(rowId: string, companyId: string): Promise<void>;
  /** Sets (or clears, with `flag: null`) one row's manual disposition — see types.ts's
   *  AdminRowFlag. Never deletes the row itself; this is metadata alongside it. */
  setAdminRowFlag(rowId: string, flag: AdminRowFlag | null, note: string | null): Promise<void>;
  /** Looks a single row up by its row id (not companyId) — used to validate a rowId before
   *  relinking/flagging it, and to render "which row" in the conflict/unmatched queues. */
  findRowById(rowId: string): Promise<CompanyRecord | null>;

  /** Section 19: persists one batch of import rows that could not be safely resolved to a
   *  company, so an operator can revisit them later rather than losing them once the import
   *  response has been shown. Called only on a real (non-dry-run) import execution. */
  recordUnmatched(entries: readonly UnmatchedRecordInput[]): Promise<void>;
  /** Unmatched records, optionally filtered by status, most recently created first. */
  listUnmatched(status?: UnmatchedStatus, limit?: number): Promise<readonly UnmatchedRecord[]>;
  /** Resolves one unmatched record: "linked" (attach to an existing company — the caller is
   *  responsible for also calling attachSourceRecord/relinkRow as appropriate), "created" (a new
   *  company identity was justified and created from it), or "rejected" (operator determined the
   *  row should not be imported at all). Never auto-applied — always one explicit call. */
  resolveUnmatched(id: string, resolution: { status: Exclude<UnmatchedStatus, "unresolved">; linkedCompanyId?: string | null; note?: string | null; resolvedBy: string }): Promise<void>;

  /** Section 29: appends one audit-trail entry. Best-effort from the caller's perspective (an
   *  admin route should still complete its underlying action even if this write fails — see
   *  adminService.ts's writeAudit wrapper), but never silently skipped when it does succeed. */
  writeAuditLog(entry: AuditLogEntryInput): Promise<void>;
  /** Most recent audit-trail entries, most recent first, optionally filtered. */
  listAuditLog(filter?: { limit?: number; action?: string; entityType?: string }): Promise<readonly AuditLogEntry[]>;
}

function resolveCompanyId(input: CompanyRecordInput, existing: readonly CompanyRecord[]): string | null {
  if (input.registrationNumber) {
    const byReg = existing.find(r => r.registrationNumber === input.registrationNumber);
    if (byReg) return byReg.companyId;
  }
  if (input.governorate) {
    const byNameLocation = existing.find(r => r.normalizedName === input.normalizedName && r.governorate === input.governorate);
    if (byNameLocation) return byNameLocation.companyId;
  }
  return null;
}

/**
 * A full, dependency-free implementation of CompanyRepository, backed by an in-memory array.
 * Used by tests and available as a genuine, if non-durable, "database" mode for local development
 * without provisioning Postgres — mirrors MemoryPropertyMarketRepository.
 */
export class MemoryCompanyRepository implements CompanyRepository {
  readonly name = "In-memory company repository (non-durable)";
  private records: CompanyRecord[] = [];
  private nextId = 1;
  private awards: CompanyAwardRecord[] = [];
  private nextAwardId = 1;
  private syncRuns: SyncRunRecord[] = [];
  private nextSyncRunId = 1;
  private unmatched: UnmatchedRecord[] = [];
  private nextUnmatchedId = 1;
  private auditLog: AuditLogEntry[] = [];
  private nextAuditId = 1;

  async searchCandidates(query: CompanySearchQuery): Promise<readonly CompanyRecord[]> {
    const needle = query.query.trim().toLowerCase();
    const limit = query.candidateLimit ?? 200;
    const matches = this.records.filter(r => {
      if (query.governorate && r.governorate?.toLowerCase() !== query.governorate.toLowerCase()) return false;
      if (query.wilayat && r.wilayat?.toLowerCase() !== query.wilayat.toLowerCase()) return false;
      if (query.industry && !r.industry?.toLowerCase().includes(query.industry.toLowerCase())) return false;
      if (!needle) return true;
      return (
        r.normalizedName.toLowerCase().includes(needle) ||
        r.companyName.toLowerCase().includes(needle) ||
        r.registrationNumber?.toLowerCase() === needle
      );
    });
    return matches.slice(0, limit);
  }

  async findByCompanyId(companyId: string): Promise<readonly CompanyRecord[]> {
    return this.records.filter(r => r.companyId === companyId);
  }

  async upsertCompanies(inputs: readonly CompanyRecordInput[]): Promise<UpsertResult> {
    let inserted = 0, updated = 0;
    for (const input of inputs) {
      const dedupeKey = input.sourceRecordId ? `${input.sourceName}::${input.sourceRecordId}` : null;
      const existingIndex = dedupeKey
        ? this.records.findIndex(r => r.sourceRecordId && `${r.sourceName}::${r.sourceRecordId}` === dedupeKey)
        : -1;
      const defaultVerificationStatus = input.verificationStatus ?? rowVerificationStatus(input.sourceType, input.observedAt);
      const defaultLastVerifiedAt = input.lastVerifiedAt ?? (sourceAuthority(input.sourceType) >= 0.90 ? input.observedAt : null);
      if (existingIndex >= 0) {
        const prior = this.records[existingIndex]!;
        this.records[existingIndex] = {
          ...input,
          id: prior.id,
          companyId: prior.companyId,
          ingestedAt: prior.ingestedAt,
          firstSeenAt: prior.firstSeenAt,
          lastSeenAt: input.observedAt > prior.lastSeenAt ? input.observedAt : prior.lastSeenAt,
          recordVersion: prior.recordVersion + 1,
          verificationStatus: defaultVerificationStatus,
          lastVerifiedAt: defaultLastVerifiedAt
        };
        updated++;
      } else {
        const rowId = `mem-company-${this.nextId++}`;
        const companyId = resolveCompanyId(input, this.records) ?? rowId;
        this.records.push({
          ...input,
          id: rowId,
          companyId,
          ingestedAt: new Date().toISOString(),
          firstSeenAt: input.observedAt,
          lastSeenAt: input.observedAt,
          recordVersion: 1,
          verificationStatus: defaultVerificationStatus,
          lastVerifiedAt: defaultLastVerifiedAt
        });
        inserted++;
      }
    }
    return { inserted, updated, skipped: 0 };
  }

  async upsertAwards(companyId: string, awards: readonly CompanyAwardInput[]): Promise<void> {
    for (const award of awards) {
      const existingIndex = this.awards.findIndex(
        a => a.companyId === companyId && a.sourceName === award.sourceName && a.tenderNumber === award.tenderNumber
      );
      if (existingIndex >= 0) {
        const prior = this.awards[existingIndex]!;
        this.awards[existingIndex] = { ...award, id: prior.id, companyId };
      } else {
        this.awards.push({ ...award, id: `mem-award-${this.nextAwardId++}`, companyId });
      }
    }
  }

  async findAwardsByCompanyId(companyId: string): Promise<readonly CompanyAwardRecord[]> {
    return this.awards
      .filter(a => a.companyId === companyId)
      .slice()
      .sort((a, b) => (a.observedAt < b.observedAt ? 1 : a.observedAt > b.observedAt ? -1 : 0));
  }

  async startSyncRun(sourceName: string): Promise<string> {
    const id = `mem-sync-${this.nextSyncRunId++}`;
    this.syncRuns.push({
      id, sourceName, startedAt: new Date().toISOString(), finishedAt: null, status: "running",
      recordsSeen: 0, recordsInserted: 0, recordsUpdated: 0, recordsSkipped: 0, errorMessage: null, metadata: {}
    });
    return id;
  }

  async finishSyncRun(runId: string, outcome: SyncRunOutcome): Promise<void> {
    const index = this.syncRuns.findIndex(r => r.id === runId);
    if (index < 0) return;
    const prior = this.syncRuns[index]!;
    this.syncRuns[index] = { ...prior, finishedAt: new Date().toISOString(), ...outcome, metadata: outcome.metadata ?? {} };
  }

  async findSyncRuns(sourceName: string, limit = 20): Promise<readonly SyncRunRecord[]> {
    // Ties on startedAt (real, if unlikely, under fast successive test/real runs sharing the same
    // millisecond) break on insertion order — the later-pushed run is the more recent one — rather
    // than an unstable/arbitrary tie, which a plain string sort alone cannot guarantee.
    return this.syncRuns
      .map((r, index) => ({ r, index }))
      .filter(x => x.r.sourceName === sourceName)
      .sort((a, b) => (a.r.startedAt !== b.r.startedAt ? (a.r.startedAt < b.r.startedAt ? 1 : -1) : b.index - a.index))
      .slice(0, limit)
      .map(x => x.r);
  }

  // ---- Admin & Data Operations Dashboard ----------------------------------------------------

  async adminListAllRows(limit = 20_000): Promise<readonly CompanyRecord[]> {
    return [...this.records].sort((a, b) => (a.observedAt < b.observedAt ? 1 : -1)).slice(0, limit);
  }

  async adminListAllAwards(limit = 20_000): Promise<readonly CompanyAwardRecord[]> {
    return [...this.awards].sort((a, b) => (a.observedAt < b.observedAt ? 1 : -1)).slice(0, limit);
  }

  async findAllSyncRuns(limit = 50): Promise<readonly SyncRunRecord[]> {
    return this.syncRuns
      .map((r, index) => ({ r, index }))
      .sort((a, b) => (a.r.startedAt !== b.r.startedAt ? (a.r.startedAt < b.r.startedAt ? 1 : -1) : b.index - a.index))
      .slice(0, limit)
      .map(x => x.r);
  }

  async attachSourceRecord(companyId: string, input: CompanyRecordInput): Promise<CompanyRecord> {
    const dedupeKey = input.sourceRecordId ? `${input.sourceName}::${input.sourceRecordId}` : null;
    const existingIndex = dedupeKey
      ? this.records.findIndex(r => r.sourceRecordId && `${r.sourceName}::${r.sourceRecordId}` === dedupeKey)
      : -1;
    const defaultVerificationStatus = input.verificationStatus ?? rowVerificationStatus(input.sourceType, input.observedAt);
    const defaultLastVerifiedAt = input.lastVerifiedAt ?? (sourceAuthority(input.sourceType) >= 0.90 ? input.observedAt : null);
    if (existingIndex >= 0) {
      const prior = this.records[existingIndex]!;
      const updated: CompanyRecord = {
        ...input, id: prior.id, companyId, ingestedAt: prior.ingestedAt, firstSeenAt: prior.firstSeenAt,
        lastSeenAt: input.observedAt > prior.lastSeenAt ? input.observedAt : prior.lastSeenAt,
        recordVersion: prior.recordVersion + 1, verificationStatus: defaultVerificationStatus, lastVerifiedAt: defaultLastVerifiedAt
      };
      this.records[existingIndex] = updated;
      return updated;
    }
    const rowId = `mem-company-${this.nextId++}`;
    const created: CompanyRecord = {
      ...input, id: rowId, companyId, ingestedAt: new Date().toISOString(), firstSeenAt: input.observedAt,
      lastSeenAt: input.observedAt, recordVersion: 1, verificationStatus: defaultVerificationStatus, lastVerifiedAt: defaultLastVerifiedAt
    };
    this.records.push(created);
    return created;
  }

  async relinkRow(rowId: string, companyId: string): Promise<void> {
    const index = this.records.findIndex(r => r.id === rowId);
    if (index < 0) throw new Error(`No row found with id "${rowId}"`);
    this.records[index] = { ...this.records[index]!, companyId };
  }

  async setAdminRowFlag(rowId: string, flag: AdminRowFlag | null, note: string | null): Promise<void> {
    const index = this.records.findIndex(r => r.id === rowId);
    if (index < 0) throw new Error(`No row found with id "${rowId}"`);
    this.records[index] = { ...this.records[index]!, adminFlag: flag, adminFlagNote: note, adminFlagAt: new Date().toISOString() };
  }

  async findRowById(rowId: string): Promise<CompanyRecord | null> {
    return this.records.find(r => r.id === rowId) ?? null;
  }

  async recordUnmatched(entries: readonly UnmatchedRecordInput[]): Promise<void> {
    for (const e of entries) {
      this.unmatched.push({
        ...e, id: `mem-unmatched-${this.nextUnmatchedId++}`, status: "unresolved",
        linkedCompanyId: null, createdAt: new Date().toISOString(), resolvedAt: null, resolvedBy: null, note: null
      });
    }
  }

  async listUnmatched(status?: UnmatchedStatus, limit = 500): Promise<readonly UnmatchedRecord[]> {
    return this.unmatched
      .filter(u => !status || u.status === status)
      .slice()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
  }

  async resolveUnmatched(id: string, resolution: { status: Exclude<UnmatchedStatus, "unresolved">; linkedCompanyId?: string | null; note?: string | null; resolvedBy: string }): Promise<void> {
    const index = this.unmatched.findIndex(u => u.id === id);
    if (index < 0) throw new Error(`No unmatched record found with id "${id}"`);
    this.unmatched[index] = {
      ...this.unmatched[index]!, status: resolution.status, linkedCompanyId: resolution.linkedCompanyId ?? null,
      note: resolution.note ?? null, resolvedAt: new Date().toISOString(), resolvedBy: resolution.resolvedBy
    };
  }

  async writeAuditLog(entry: AuditLogEntryInput): Promise<void> {
    this.auditLog.push({ ...entry, id: `mem-audit-${this.nextAuditId++}`, occurredAt: new Date().toISOString() });
  }

  async listAuditLog(filter: { limit?: number; action?: string; entityType?: string } = {}): Promise<readonly AuditLogEntry[]> {
    return this.auditLog
      .filter(a => (!filter.action || a.action === filter.action) && (!filter.entityType || a.entityType === filter.entityType))
      .slice()
      .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1))
      .slice(0, filter.limit ?? 200);
  }

  /** Test/dev-only escape hatch to inspect what's stored — not part of the interface. */
  all(): readonly CompanyRecord[] { return this.records; }
}
