import assert from "node:assert/strict";
import { test } from "node:test";
import { sourceAuthority, SOURCE_TRUST, HIGH_TRUST_SOURCE_TYPES } from "../src/business-data/scoring/sourceTrust.js";
import { freshnessThresholdDays, isStale } from "../src/business-data/config/freshnessPolicy.js";
import { rowVerificationStatus, mergedVerificationStatus } from "../src/business-data/scoring/verification.js";
import { MemoryCompanyRepository, type CompanyRecordInput } from "../src/business-data/sources/companyRepository.js";
import { mergeCompanyRows } from "../src/business-data/matching/merge.js";
import { assessCompanyRisk } from "../src/business-data/scoring/risk.js";
import { computeCommercialSignals, procurementActivityFromCompany } from "../src/business-data/scoring/signals.js";
import { normalizeMociipRecord, importMociipRecords, type MociipRawRecord } from "../src/business-data/sources/omanBusinessProvider.js";
import { normalizeTaxOmanRecord, importTaxOmanRecords, type TaxOmanRawRecord } from "../src/business-data/sources/taxOmanProvider.js";
import {
  normalizeTenderBoardSupplierRecord, importTenderBoardSupplierRecords, importTenderBoardAwardRecords,
  type TenderBoardSupplierRawRecord, type TenderBoardAwardRawRecord
} from "../src/business-data/sources/tenderBoardProvider.js";
import { runGetOmanCompanyProfile, runDueDiligenceOmanCompany } from "../src/services/omanBusiness.js";
import { DatabaseCompanyProvider } from "../src/business-data/sources/provider.js";
import { DEMO_COMPANY_RECORDS } from "../src/business-data/sources/fixtures.js";

// ---------------------------------------------------------------------------------------------
// Phase 2: centralized source-authority model
// ---------------------------------------------------------------------------------------------

test("sourceAuthority: every CompanySourceType has a trust weight in [0, 1], government-family sources are highest, demo is lowest", () => {
  for (const value of Object.values(SOURCE_TRUST)) assert.ok(value >= 0 && value <= 1);
  assert.ok(sourceAuthority("government") >= sourceAuthority("company_website"));
  assert.ok(sourceAuthority("tax_authority") >= sourceAuthority("directory"));
  assert.ok(sourceAuthority("demo") < sourceAuthority("news"));
  assert.equal(sourceAuthority("demo"), Math.min(...Object.values(SOURCE_TRUST)));
});

test("HIGH_TRUST_SOURCE_TYPES: derived from SOURCE_TRUST (authority >= 0.90), includes government-family types, excludes demo/directory/news", () => {
  assert.ok(HIGH_TRUST_SOURCE_TYPES.includes("government"));
  assert.ok(HIGH_TRUST_SOURCE_TYPES.includes("tax_authority"));
  assert.ok(HIGH_TRUST_SOURCE_TYPES.includes("government_procurement"));
  assert.ok(!HIGH_TRUST_SOURCE_TYPES.includes("demo"));
  assert.ok(!HIGH_TRUST_SOURCE_TYPES.includes("directory"));
  for (const t of HIGH_TRUST_SOURCE_TYPES) assert.ok(SOURCE_TRUST[t] >= 0.90);
});

// ---------------------------------------------------------------------------------------------
// Phase 10: per-source-type freshness policy
// ---------------------------------------------------------------------------------------------

test("freshnessThresholdDays: government-procurement data goes stale fastest, demo data effectively never", () => {
  assert.ok(freshnessThresholdDays("government_procurement") < freshnessThresholdDays("government"));
  assert.ok(freshnessThresholdDays("demo") > 1000);
});

test("isStale: a row exactly at the threshold is not yet stale; one day past it is", () => {
  const threshold = freshnessThresholdDays("company_website");
  assert.equal(isStale("company_website", threshold), false);
  assert.equal(isStale("company_website", threshold + 1), true);
});

test("freshnessThresholdDays: OMAN_BUSINESS_FRESHNESS_DAYS_<TYPE> env override is respected, invalid values fall back to the default", () => {
  const originalEnv = process.env.OMAN_BUSINESS_FRESHNESS_DAYS_LICENSED_FEED;
  try {
    process.env.OMAN_BUSINESS_FRESHNESS_DAYS_LICENSED_FEED = "14";
    assert.equal(freshnessThresholdDays("licensed_feed"), 14);
    process.env.OMAN_BUSINESS_FRESHNESS_DAYS_LICENSED_FEED = "not-a-number";
    assert.equal(freshnessThresholdDays("licensed_feed"), 30);
  } finally {
    if (originalEnv === undefined) delete process.env.OMAN_BUSINESS_FRESHNESS_DAYS_LICENSED_FEED;
    else process.env.OMAN_BUSINESS_FRESHNESS_DAYS_LICENSED_FEED = originalEnv;
  }
});

// ---------------------------------------------------------------------------------------------
// Phase 3: per-row and merged verification status
// ---------------------------------------------------------------------------------------------

test("rowVerificationStatus: demo is always 'unknown' regardless of freshness; a fresh government row is 'verified'; a stale one is 'stale'", () => {
  const now = new Date().toISOString();
  const longAgo = new Date(Date.now() - 10_000 * 86_400_000).toISOString();
  assert.equal(rowVerificationStatus("demo", now), "unknown");
  assert.equal(rowVerificationStatus("demo", longAgo), "unknown");
  assert.equal(rowVerificationStatus("government", now), "verified");
  assert.equal(rowVerificationStatus("government", longAgo), "stale");
});

test("rowVerificationStatus: authority-band thresholds produce reported/estimated for mid/low-trust sources (no non-demo source currently falls under 0.30, so 'inferred' is demo-only in practice — see sourceTrust.ts)", () => {
  const now = new Date().toISOString();
  assert.equal(rowVerificationStatus("company_website", now), "reported"); // authority 0.80
  assert.equal(rowVerificationStatus("directory", now), "estimated"); // authority 0.50
  assert.equal(rowVerificationStatus("news", now), "estimated"); // authority 0.40
});

test("mergedVerificationStatus: a conflict always wins regardless of individual row statuses; otherwise the best row status wins", () => {
  assert.equal(mergedVerificationStatus(["verified", "reported"], true), "conflicting");
  assert.equal(mergedVerificationStatus(["reported", "verified", "stale"], false), "verified");
  assert.equal(mergedVerificationStatus([], false), "unknown");
});

// ---------------------------------------------------------------------------------------------
// Phase 6: award records (list-shaped) on MemoryCompanyRepository
// ---------------------------------------------------------------------------------------------

test("MemoryCompanyRepository: upsertAwards inserts new awards and updates an existing one in place on (companyId, sourceName, tenderNumber)", async () => {
  const repo = new MemoryCompanyRepository();
  await repo.upsertAwards("co-1", [
    { companyId: "co-1", tenderNumber: "TB-001", buyer: "Ministry X", title: "Road works", status: "completed", awardValueOMR: 1000, category: "Civil", sourceName: "Esnad (demo)", observedAt: "2026-01-01T00:00:00.000Z" }
  ]);
  let awards = await repo.findAwardsByCompanyId("co-1");
  assert.equal(awards.length, 1);
  assert.equal(awards[0]!.status, "completed");

  await repo.upsertAwards("co-1", [
    { companyId: "co-1", tenderNumber: "TB-001", buyer: "Ministry X", title: "Road works", status: "in_progress", awardValueOMR: 1200, category: "Civil", sourceName: "Esnad (demo)", observedAt: "2026-02-01T00:00:00.000Z" }
  ]);
  awards = await repo.findAwardsByCompanyId("co-1");
  assert.equal(awards.length, 1, "re-importing the same (companyId, sourceName, tenderNumber) must update in place, never duplicate");
  assert.equal(awards[0]!.status, "in_progress");
  assert.equal(awards[0]!.awardValueOMR, 1200);
});

test("MemoryCompanyRepository: findAwardsByCompanyId never returns another company's awards", async () => {
  const repo = new MemoryCompanyRepository();
  await repo.upsertAwards("co-1", [{ companyId: "co-1", tenderNumber: "TB-A", buyer: null, title: null, status: null, awardValueOMR: null, category: null, sourceName: "Esnad (demo)", observedAt: "2026-01-01T00:00:00.000Z" }]);
  await repo.upsertAwards("co-2", [{ companyId: "co-2", tenderNumber: "TB-B", buyer: null, title: null, status: null, awardValueOMR: null, category: null, sourceName: "Esnad (demo)", observedAt: "2026-01-01T00:00:00.000Z" }]);
  assert.equal((await repo.findAwardsByCompanyId("co-1")).length, 1);
  assert.equal((await repo.findAwardsByCompanyId("co-2")).length, 1);
  assert.equal((await repo.findAwardsByCompanyId("co-3")).length, 0);
});

// ---------------------------------------------------------------------------------------------
// Phase 13: sync-run auditability
// ---------------------------------------------------------------------------------------------

test("MemoryCompanyRepository: startSyncRun/finishSyncRun/findSyncRuns records an honest audit trail, most recent first", async () => {
  const repo = new MemoryCompanyRepository();
  const run1 = await repo.startSyncRun("mociip");
  await repo.finishSyncRun(run1, { status: "succeeded", recordsSeen: 5, recordsInserted: 5, recordsUpdated: 0, recordsSkipped: 0, errorMessage: null });
  const run2 = await repo.startSyncRun("mociip");
  await repo.finishSyncRun(run2, { status: "failed", recordsSeen: 0, recordsInserted: 0, recordsUpdated: 0, recordsSkipped: 0, errorMessage: "connection refused" });

  const runs = await repo.findSyncRuns("mociip");
  assert.equal(runs.length, 2);
  assert.equal(runs[0]!.id, run2, "most recent run first");
  assert.equal(runs[0]!.status, "failed");
  assert.equal(runs[0]!.errorMessage, "connection refused");
  assert.equal(runs[1]!.status, "succeeded");
  assert.equal((await repo.findSyncRuns("some-other-source")).length, 0);
});

// ---------------------------------------------------------------------------------------------
// Phase 4: MOCIIP manual-import adapter
// ---------------------------------------------------------------------------------------------

const validMociipRow: MociipRawRecord = {
  registrationNumber: "1012345678", companyNameEn: "Nizwa Steel Works LLC", legalForm: "LLC",
  status: "active", registrationDate: "2012-05-01", governorate: "Ad Dakhiliyah", wilayat: "Nizwa",
  activity: "Manufacturing", observedAt: "2026-09-01T00:00:00.000Z"
};

test("normalizeMociipRecord: a well-formed row normalizes to a government-sourced CompanyRecordInput with the registration number as sourceRecordId", () => {
  const result = normalizeMociipRecord(validMociipRow, 1);
  assert.ok("record" in result);
  if ("record" in result) {
    assert.equal(result.record.sourceType, "government");
    assert.equal(result.record.registrationNumber, "1012345678");
    assert.equal(result.record.sourceRecordId, "1012345678");
    assert.equal(result.record.governorate, "Ad Dakhiliyah");
    assert.equal(result.record.status, "active");
  }
});

test("normalizeMociipRecord: rejects a row missing registrationNumber or company name, and an unrecognized governorate, rather than guessing", () => {
  const missingReg = normalizeMociipRecord({ ...validMociipRow, registrationNumber: "" }, 1);
  assert.ok("error" in missingReg);
  const missingName = normalizeMociipRecord({ ...validMociipRow, companyNameEn: null }, 2);
  assert.ok("error" in missingName);
  const badGovernorate = normalizeMociipRecord({ ...validMociipRow, governorate: "Not A Real Governorate" }, 3);
  assert.ok("error" in badGovernorate);
});

test("importMociipRecords: valid and invalid rows in the same batch are partitioned — good rows import, bad rows are reported by 1-based row number, nothing aborts the batch", async () => {
  const repo = new MemoryCompanyRepository();
  const result = await importMociipRecords([validMociipRow, { ...validMociipRow, registrationNumber: "" }], repo);
  assert.equal(result.totalRows, 2);
  assert.equal(result.imported, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]!.row, 2);
});

// ---------------------------------------------------------------------------------------------
// Phase 5: Tax Oman manual-import adapter
// ---------------------------------------------------------------------------------------------

const validTaxRow: TaxOmanRawRecord = {
  registrationNumber: "1012345678", companyName: "Nizwa Steel Works LLC", vatNumber: "OM1099887766",
  taxVerificationStatus: "verified", observedAt: "2026-09-05T00:00:00.000Z"
};

test("normalizeTaxOmanRecord: a 'verified' outcome produces a tax_authority row with taxVerificationStatus/taxVerifiedAt populated honestly", () => {
  const result = normalizeTaxOmanRecord(validTaxRow, 1);
  assert.ok("record" in result);
  if ("record" in result) {
    assert.equal(result.record.sourceType, "tax_authority");
    assert.equal(result.record.taxVerificationStatus, "verified");
    assert.equal(result.record.taxVerifiedAt, "2026-09-05T00:00:00.000Z");
    assert.equal(result.record.vatStatus, "registered");
  }
});

test("normalizeTaxOmanRecord: a 'not_registered' outcome is preserved as a real, distinct fact — never silently reinterpreted as 'unverified' or dropped", () => {
  const result = normalizeTaxOmanRecord({ ...validTaxRow, taxVerificationStatus: "not_registered" }, 1);
  assert.ok("record" in result);
  if ("record" in result) assert.equal(result.record.taxVerificationStatus, "not_registered");
});

test("normalizeTaxOmanRecord: rejects an invalid taxVerificationStatus rather than guessing at an outcome", () => {
  const result = normalizeTaxOmanRecord({ ...validTaxRow, taxVerificationStatus: "probably_fine" as TaxOmanRawRecord["taxVerificationStatus"] }, 1);
  assert.ok("error" in result);
});

test("Tax Oman + risk engine integration: a company whose tax row reports not_registered is flagged TAX_NOT_REGISTERED", async () => {
  const repo = new MemoryCompanyRepository();
  const mociip = normalizeMociipRecord(validMociipRow, 1);
  assert.ok("record" in mociip);
  const tax = normalizeTaxOmanRecord({ ...validTaxRow, taxVerificationStatus: "not_registered" }, 1);
  assert.ok("record" in tax);
  if ("record" in mociip && "record" in tax) await repo.upsertCompanies([mociip.record, tax.record]);

  const rows = await repo.findByCompanyId((await repo.searchCandidates({ query: "1012345678" }))[0]!.companyId);
  assert.equal(rows.length, 2, "the two rows should have merged onto the same companyId via the shared registration number");
  const { company, identityConflict, addressConflict } = mergeCompanyRows(rows[0]!.companyId, rows);
  const risk = assessCompanyRisk(company, rows, identityConflict, addressConflict);
  assert.ok(risk.riskFlags.some(f => f.code === "TAX_NOT_REGISTERED"));
});

// ---------------------------------------------------------------------------------------------
// Phase 6/17: Tender Board / Esnad manual-import adapters + procurement signals
// ---------------------------------------------------------------------------------------------

const validSupplierRow: TenderBoardSupplierRawRecord = {
  registrationNumber: "1012345678", companyName: "Nizwa Steel Works LLC",
  registeredSupplier: true, supplierCategory: "Manufacturing & Supply", tendersParticipated: 4,
  observedAt: "2026-09-10T00:00:00.000Z"
};

test("normalizeTenderBoardSupplierRecord: registeredSupplier must be an explicit boolean, never inferred from other fields", () => {
  const missing = normalizeTenderBoardSupplierRecord({ ...validSupplierRow, registeredSupplier: undefined as unknown as boolean }, 1);
  assert.ok("error" in missing);
  const ok = normalizeTenderBoardSupplierRecord(validSupplierRow, 1);
  assert.ok("record" in ok);
  if ("record" in ok) {
    assert.equal(ok.record.sourceType, "government_procurement");
    assert.equal(ok.record.registeredSupplier, true);
    assert.equal(ok.record.governmentProcurementPresence, true);
  }
});

test("importTenderBoardAwardRecords: an award for an unknown registrationNumber is rejected (never starts a new company identity from an award alone); a known company's award imports successfully", async () => {
  const repo = new MemoryCompanyRepository();
  const mociip = normalizeMociipRecord(validMociipRow, 1);
  assert.ok("record" in mociip);
  if ("record" in mociip) await repo.upsertCompanies([mociip.record]);

  const unknownAward: TenderBoardAwardRawRecord = { registrationNumber: "9999999999", tenderNumber: "TB-999", observedAt: "2026-09-11T00:00:00.000Z" };
  const knownAward: TenderBoardAwardRawRecord = { registrationNumber: "1012345678", tenderNumber: "TB-100", buyer: "Ministry of Transport", title: "Bridge maintenance", status: "completed", awardValueOMR: 45000, category: "Civil Works", observedAt: "2026-09-11T00:00:00.000Z" };

  const result = await importTenderBoardAwardRecords([unknownAward, knownAward], repo);
  assert.equal(result.imported, 1);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]!.row, 1);
  assert.ok(/no known company/.test(result.errors[0]!.reason));

  const companyId = (await repo.searchCandidates({ query: "1012345678" }))[0]!.companyId;
  const awards = await repo.findAwardsByCompanyId(companyId);
  assert.equal(awards.length, 1);
  assert.equal(awards[0]!.tenderNumber, "TB-100");
});

test("procurementActivityFromCompany: 'active' when awardedContractCount > 0, 'limited' when only tendersParticipated/presence is on file, 'none' otherwise", async () => {
  const repo = new MemoryCompanyRepository();
  const supplier = normalizeTenderBoardSupplierRecord(validSupplierRow, 1);
  assert.ok("record" in supplier);
  if ("record" in supplier) await repo.upsertCompanies([supplier.record]);
  const rows = await repo.findByCompanyId((await repo.searchCandidates({ query: "1012345678" }))[0]!.companyId);
  const { company } = mergeCompanyRows(rows[0]!.companyId, rows);
  assert.equal(procurementActivityFromCompany(company), "limited");

  const noProcurement = mergeCompanyRows("x", DEMO_COMPANY_RECORDS.filter(r => r.companyId === "demo-co-1"));
  assert.equal(procurementActivityFromCompany(noProcurement.company), "none");
});

test("importTenderBoardSupplierRecords: valid/invalid rows partition the same way as the other adapters", async () => {
  const repo = new MemoryCompanyRepository();
  const result = await importTenderBoardSupplierRecords([validSupplierRow, { ...validSupplierRow, registeredSupplier: "yes" as unknown as boolean }], repo);
  assert.equal(result.imported, 1);
  assert.equal(result.errors.length, 1);
});

// ---------------------------------------------------------------------------------------------
// Phase 15/16: real-vs-demo dataCoverage + verification/procurement output wiring, end to end
// ---------------------------------------------------------------------------------------------

test("dataCoverage + verification metadata: a company backed by one real (government) row and no demo rows reports realSources=1/demoSources=0 and a non-'unknown' verificationStatus", async () => {
  const repo = new MemoryCompanyRepository();
  const mociip = normalizeMociipRecord(validMociipRow, 1);
  assert.ok("record" in mociip);
  if ("record" in mociip) await repo.upsertCompanies([mociip.record]);
  const provider = new DatabaseCompanyProvider(repo);
  const companyId = (await repo.searchCandidates({ query: "1012345678" }))[0]!.companyId;

  const profile = await runGetOmanCompanyProfile({ companyId }, provider);
  assert.equal(profile.dataCoverage.realSources, 1);
  assert.equal(profile.dataCoverage.demoSources, 0);
  assert.notEqual(profile.verification.verificationStatus, "unknown");
  assert.notEqual(profile.dataCoverage.latestVerifiedAt, null, "a fresh government-sourced row should count as its own verification event");
});

test("due_diligence_oman_company: procurement.awards reflects real Tender Board award data end to end, and awardedContractCount matches the imported award count", async () => {
  const repo = new MemoryCompanyRepository();
  const mociip = normalizeMociipRecord(validMociipRow, 1);
  const supplier = normalizeTenderBoardSupplierRecord(validSupplierRow, 1);
  assert.ok("record" in mociip && "record" in supplier);
  if ("record" in mociip && "record" in supplier) await repo.upsertCompanies([mociip.record, supplier.record]);
  const companyId = (await repo.searchCandidates({ query: "1012345678" }))[0]!.companyId;
  await repo.upsertAwards(companyId, [
    { companyId, tenderNumber: "TB-200", buyer: "Ministry of Housing", title: "School renovation", status: "completed", awardValueOMR: 30000, category: "Civil Works", sourceName: "Esnad", observedAt: "2026-09-12T00:00:00.000Z" }
  ]);

  const provider = new DatabaseCompanyProvider(repo);
  const dd = await runDueDiligenceOmanCompany({ companyId, transactionType: "supplier_contract" }, provider);
  assert.equal(dd.procurement.awards.length, 1);
  assert.equal(dd.procurement.awardedContractCount, 1);
  assert.equal(dd.procurement.registeredSupplier, true);
  assert.equal(dd.commercialAssessment.governmentProcurementActivity, "active");
});
