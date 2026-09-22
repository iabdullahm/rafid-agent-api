import type { CompanyRecord, CompanyRecordInput } from "./companyRepository.js";
import type { CompanyAwardRecord } from "../types.js";
import { rowVerificationStatus } from "../scoring/verification.js";
import { sourceAuthority } from "../scoring/sourceTrust.js";

/**
 * Section 15: a small, explicitly curated demo dataset — sourceType is ALWAYS "demo" (never
 * "government"/"public_registry"/etc.) so it can never be mistaken for a real source. Used only
 * when OMAN_BUSINESS_DATA_MODE is "manual" (the default) or "composite" — see
 * src/business-data/sources/provider.ts and src/business-data/config.ts.
 *
 * THESE ARE NOT REAL OMAN COMPANIES. Every record is a hand-authored, illustrative example built
 * to exercise this capability's normalization, search-ranking, provenance, confidence and risk
 * machinery end to end (Section 15's explicit test-scenario checklist — exact search, fuzzy
 * matching, same-name companies under different registration numbers, Arabic/English names,
 * different governorates, an inactive company, a very recently registered company, an established
 * company, a company with no website on file, and a duplicate/conflicting source record). It must
 * be replaced with a real licensed/official feed (see src/business-data/sources/provider.ts's
 * DatabaseCompanyProvider) before this capability's output should be treated as real company data.
 *
 * `observedAt`/`ingestedAt` for the two dynamically-dated records (the "new company" and the
 * "established company") are computed relative to the current date so those two scenarios stay
 * correct no matter when this dataset is loaded; every other record uses a fixed illustrative
 * date safely in the past.
 */

const DEMO_SOURCE_NAME = "Rafid curated Oman business demo dataset (illustrative — not a real company registry)";

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
}

function demoInput(overrides: Partial<CompanyRecordInput> & Pick<CompanyRecordInput, "companyName" | "normalizedName">): CompanyRecordInput {
  return {
    nameAr: null, nameEn: null, registrationNumber: null, legalType: null, status: "active",
    registrationDate: null, industry: null, activities: [], governorate: null, wilayat: null, area: null,
    address: null, website: null, email: null, phone: null, vatNumber: null, vatStatus: null,
    employeeRange: null, estimatedCompanySize: null,
    sourceType: "demo", sourceName: DEMO_SOURCE_NAME, sourceRecordId: null, sourceUrl: null,
    observedAt: isoDaysAgo(30), metadata: {},
    ...overrides
  };
}

let nextRowId = 1;
function toRecord(companyId: string, input: CompanyRecordInput): CompanyRecord {
  const verificationStatus = input.verificationStatus ?? rowVerificationStatus(input.sourceType, input.observedAt);
  const lastVerifiedAt = input.lastVerifiedAt ?? (sourceAuthority(input.sourceType) >= 0.90 ? input.observedAt : null);
  return {
    ...input, id: `demo-row-${nextRowId++}`, companyId, ingestedAt: input.observedAt,
    firstSeenAt: input.observedAt, lastSeenAt: input.observedAt, recordVersion: 1,
    verificationStatus, lastVerifiedAt
  };
}

export const DEMO_COMPANY_RECORDS: readonly CompanyRecord[] = [
  // A — well-populated, two contributing sources (also covers "duplicate source record" / Section
  // 15's multi-source scenario for the same registration number, and the exact-search scenario).
  toRecord("demo-co-1", demoInput({
    companyName: "Al Noor Trading LLC", normalizedName: "AL NOOR",
    registrationNumber: "1010123456", legalType: "LLC", status: "active", registrationDate: "2015-04-10",
    industry: "Trading", activities: ["General trading", "Import and export"],
    governorate: "Muscat", wilayat: "Muscat", area: "Ghala", address: "Ghala Industrial Area, Muscat",
    website: "https://alnoortrading.om", email: "info@alnoortrading.om", phone: "+968 2440 1234",
    vatNumber: "OM1000123456", vatStatus: "registered", employeeRange: "11-50", estimatedCompanySize: "small",
    sourceType: "demo", sourceName: "Oman Ministry of Commerce, Industry and Investment Promotion (demo)",
    sourceRecordId: "MOCIIP-1010123456", sourceUrl: "https://example-registry.om/companies/1010123456",
    observedAt: isoDaysAgo(45)
  })),
  toRecord("demo-co-1", demoInput({
    companyName: "Al Noor Trading LLC", normalizedName: "AL NOOR",
    registrationNumber: "1010123456", legalType: "LLC", status: "active",
    industry: "Trading", governorate: "Muscat", wilayat: "Muscat", area: "Ghala",
    website: "https://alnoortrading.om", email: "sales@alnoortrading.om", phone: "+968 2440 1234",
    sourceType: "demo", sourceName: "alnoortrading.om (demo)",
    sourceUrl: "https://alnoortrading.om/about", observedAt: isoDaysAgo(10)
  })),

  // B / C — identical display name, different registration numbers and governorates: identity
  // must be told apart by registration number, never merged on name alone (Section 15).
  toRecord("demo-co-2", demoInput({
    companyName: "Gulf Services LLC", normalizedName: "GULF",
    registrationNumber: "1010200111", legalType: "LLC", status: "active", registrationDate: "2010-01-20",
    industry: "Professional Services", governorate: "Muscat", wilayat: "Bawshar",
    website: "https://gulfservices-muscat.om", email: "contact@gulfservices-muscat.om", phone: "+968 2450 5678",
    employeeRange: "51-200", estimatedCompanySize: "medium",
    sourceType: "demo", sourceName: "Oman public business registry (demo)",
    sourceRecordId: "REG-1010200111", observedAt: isoDaysAgo(60)
  })),
  toRecord("demo-co-3", demoInput({
    companyName: "Gulf Services LLC", normalizedName: "GULF",
    registrationNumber: "2020300222", legalType: "LLC", status: "active", registrationDate: "2018-07-15",
    industry: "Facilities Management", governorate: "Dhofar", wilayat: "Salalah",
    website: "https://gulfservices-salalah.om", phone: "+968 2329 8765",
    employeeRange: "11-50", estimatedCompanySize: "small",
    sourceType: "demo", sourceName: "Oman public business registry (demo)",
    sourceRecordId: "REG-2020300222", observedAt: isoDaysAgo(90)
  })),

  // D — Arabic and English names both populated, exercising bilingual matching.
  toRecord("demo-co-4", demoInput({
    companyName: "Muscat Trading Company", normalizedName: "MUSCAT",
    nameAr: "شركة مسقط للتجارة", nameEn: "Muscat Trading Company",
    registrationNumber: "1010400333", legalType: "SAOC", status: "active", registrationDate: "2008-11-02",
    industry: "Trading", governorate: "Muscat", wilayat: "Muttrah", area: "Muttrah",
    website: "https://muscat-trading.om", email: "info@muscat-trading.om",
    employeeRange: "201-500", estimatedCompanySize: "medium",
    sourceType: "demo", sourceName: "Oman Ministry of Commerce, Industry and Investment Promotion (demo)",
    sourceRecordId: "MOCIIP-1010400333", observedAt: isoDaysAgo(75)
  })),

  // E — inactive company (drives the "inactive company" risk flag).
  toRecord("demo-co-5", demoInput({
    companyName: "Al Rawda Contracting LLC", normalizedName: "AL RAWDA",
    registrationNumber: "1010500444", legalType: "LLC", status: "inactive", registrationDate: "2011-03-05",
    industry: "Construction", governorate: "Al Batinah North", wilayat: "Sohar",
    website: null, phone: "+968 2673 4455",
    sourceType: "demo", sourceName: "Oman public business registry (demo)",
    sourceRecordId: "REG-1010500444", observedAt: isoDaysAgo(400)
  })),

  // F — a very recently registered company (drives the "recent registration" risk flag and the
  // "new company" scenario); registrationDate computed relative to "now" so it stays recent.
  toRecord("demo-co-6", demoInput({
    companyName: "Nova Tech Solutions SPC", normalizedName: "NOVA TECH",
    registrationNumber: "1010600555", legalType: "SPC", status: "active", registrationDate: isoDaysAgo(60),
    industry: "Information Technology", governorate: "Muscat", wilayat: "Bawshar", area: "Al Khuwair",
    website: "https://novatech.om", email: "hello@novatech.om",
    employeeRange: "1-10", estimatedCompanySize: "micro",
    sourceType: "demo", sourceName: "Oman Ministry of Commerce, Industry and Investment Promotion (demo)",
    sourceRecordId: "MOCIIP-1010600555", observedAt: isoDaysAgo(20)
  })),

  // G — a long-established company (drives "established" business maturity).
  toRecord("demo-co-7", demoInput({
    companyName: "Salalah Fisheries SAOG", normalizedName: "SALALAH FISHERIES",
    registrationNumber: "1010700666", legalType: "SAOG", status: "active", registrationDate: "2001-05-18",
    industry: "Fisheries", governorate: "Dhofar", wilayat: "Salalah",
    website: "https://salalahfisheries.om", email: "info@salalahfisheries.om", phone: "+968 2329 1122",
    vatNumber: "OM1000700666", vatStatus: "registered", employeeRange: "201-500", estimatedCompanySize: "medium",
    sourceType: "demo", sourceName: "Oman Ministry of Commerce, Industry and Investment Promotion (demo)",
    sourceRecordId: "MOCIIP-1010700666", observedAt: isoDaysAgo(120)
  })),

  // H — active, established, but no website on file (drives "no website" risk flag / low digital
  // presence without also triggering "inactive"/"recent registration").
  toRecord("demo-co-8", demoInput({
    companyName: "Sohar Steel Works LLC", normalizedName: "SOHAR STEEL WORKS",
    registrationNumber: "1010800777", legalType: "LLC", status: "active", registrationDate: "2012-09-01",
    industry: "Manufacturing", governorate: "Al Batinah North", wilayat: "Sohar",
    website: null, email: null, phone: "+968 2685 3300",
    employeeRange: "51-200", estimatedCompanySize: "medium",
    sourceType: "demo", sourceName: "Oman public business registry (demo)",
    sourceRecordId: "REG-1010800777", observedAt: isoDaysAgo(200)
  })),

  // I — same registration number reported with a conflicting company name by two sources: drives
  // the "conflicting identity information" risk flag.
  toRecord("demo-co-9", demoInput({
    companyName: "Al Yusr Logistics LLC", normalizedName: "AL YUSR LOGISTICS",
    registrationNumber: "1010999888", legalType: "LLC", status: "active", registrationDate: "2016-02-14",
    industry: "Logistics", governorate: "Muscat", wilayat: "Seeb",
    website: "https://alyusr-logistics.om", phone: "+968 2451 9900",
    sourceType: "demo", sourceName: "Oman Ministry of Commerce, Industry and Investment Promotion (demo)",
    sourceRecordId: "MOCIIP-1010999888", observedAt: isoDaysAgo(50)
  })),
  toRecord("demo-co-9", demoInput({
    companyName: "Al Yusra Logistics Est.", normalizedName: "AL YUSRA LOGISTICS",
    registrationNumber: "1010999888", legalType: "EST", status: "active",
    industry: "Logistics", governorate: "Muscat", wilayat: "Seeb",
    sourceType: "demo", sourceName: "Business directory listing (demo)",
    sourceRecordId: "DIR-1010999888", observedAt: isoDaysAgo(15)
  })),

  // J — sparse record: only a name and registration number on file, exercising low
  // dataCompleteness / "unknown" confidence labeling and missingInformation reporting.
  toRecord("demo-co-10", demoInput({
    companyName: "Zahra Consulting", normalizedName: "ZAHRA",
    registrationNumber: "1010900999", status: "unknown",
    governorate: "Ad Dakhiliyah", wilayat: "Nizwa",
    sourceType: "demo", sourceName: "Business directory listing (demo)",
    sourceRecordId: "DIR-1010900999", observedAt: isoDaysAgo(300)
  })),

  // K — Phase 20: a company with a registered-supplier/procurement snapshot on file, so
  // search/profile/analyze/due-diligence all have at least one demo scenario exercising the
  // Phase 6/17/18 procurement fields end to end without depending on real Tender Board data.
  toRecord("demo-co-11", demoInput({
    companyName: "Barka Engineering Services LLC", normalizedName: "BARKA ENGINEERING SERVICES",
    registrationNumber: "1011100111", legalType: "LLC", status: "active", registrationDate: "2013-06-22",
    industry: "Construction", governorate: "Al Batinah South", wilayat: "Barka",
    website: "https://barka-eng.om", email: "info@barka-eng.om", phone: "+968 2688 1122",
    employeeRange: "51-200", estimatedCompanySize: "medium",
    sourceType: "demo", sourceName: "Oman Ministry of Commerce, Industry and Investment Promotion (demo)",
    sourceRecordId: "MOCIIP-1011100111", observedAt: isoDaysAgo(40),
    registeredSupplier: true, supplierCategory: "Construction & Engineering", supplierClassification: "Grade 3",
    governmentProcurementPresence: true, tendersParticipated: 6, awardedContractCount: 2,
    lastTenderActivityAt: isoDaysAgo(25)
  }))
];

/** Phase 20: demo award/contract facts for demo-co-11 (Barka Engineering Services) — illustrates
 *  Phase 6's list-shaped award records; never mistaken for a real Tender Board award since every
 *  sourceName here is explicitly marked "(demo)". */
export const DEMO_COMPANY_AWARDS: readonly CompanyAwardRecord[] = [
  {
    id: "demo-award-1", companyId: "demo-co-11", tenderNumber: "TB-2025-00417",
    buyer: "Ministry of Housing and Urban Planning", title: "Road resurfacing — Barka wilayat",
    status: "completed", awardValueOMR: 185000, category: "Civil Works",
    sourceName: "Oman Tender Board / Esnad (demo)", observedAt: isoDaysAgo(180)
  },
  {
    id: "demo-award-2", companyId: "demo-co-11", tenderNumber: "TB-2026-00092",
    buyer: "Barka Municipality", title: "Drainage system maintenance contract",
    status: "in_progress", awardValueOMR: 62000, category: "Civil Works",
    sourceName: "Oman Tender Board / Esnad (demo)", observedAt: isoDaysAgo(25)
  }
];
