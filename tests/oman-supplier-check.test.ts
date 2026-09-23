import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createApp } from "../src/api/app.js";
import { loadConfig } from "../src/config/env.js";
import { buildOpenapi } from "../src/api/openapi.js";
import { capabilities } from "../src/domain/capabilities.js";
import { prices } from "../src/billing/catalog.js";
import { BillingService } from "../src/billing/service.js";
import { buildX402Info } from "../src/billing/x402.js";
import { MemoryUsageRepository } from "../src/billing/usage.js";
import { classifyDataSource } from "../src/analytics/dataSource.js";
import type { CompanyDataProvider } from "../src/business-data/sources/provider.js";
import type { CompanyRecord } from "../src/business-data/sources/companyRepository.js";
import { omanSupplierCheckInput } from "../src/schemas/supplierCheckInputs.js";
import { omanSupplierCheckOutput } from "../src/schemas/supplierCheckOutputs.js";
import { runOmanSupplierCheck, type SupplierCheckDependencies } from "../src/supplier-check/service.js";
import { MemoryEvidenceStore, PostgresEvidenceStore, cachedProviderCall } from "../src/supplier-check/evidenceStore.js";
import { OmanRegistryIdentityProvider } from "../src/supplier-check/providers/registryProvider.js";
import { PublicWebsiteProvider, type SupplierWebsiteProvider, type WebsiteEvidence, htmlToText, extractEmails, extractPhones } from "../src/supplier-check/providers/websiteProvider.js";
import { UnConsolidatedListProvider, UsConsolidatedScreeningListProvider, parseUnConsolidatedXml, type SanctionsListProvider, type SanctionsListEntry } from "../src/supplier-check/providers/sanctionsProviders.js";
import type { SupplierPublicRiskProvider, PublicWebResult } from "../src/supplier-check/providers/publicRiskProvider.js";
import { findPotentialMatches, nameMatchScore } from "../src/supplier-check/sanctionsMatcher.js";
import { normalizePhone, normalizeSupplierInput, normalizeWebsite, normalizeEmail, supplierIdentityKey, arabicNameToEnglishKey, registrableDomain } from "../src/supplier-check/normalize.js";
import { assessActivity } from "../src/supplier-check/analysis/activity.js";
import { classifyRisk, procurementSuitability, computeConfidence, RISK_THRESHOLDS } from "../src/supplier-check/scoring.js";
import type { ProviderResult } from "../src/supplier-check/types.js";

/**
 * oman_supplier_check. Every provider is replaced by an in-memory fake (registry rows, website
 * evidence, sanctions list entries, web results) or exercised with an injected fetch — never the
 * real network — following tests/intelligence.test.ts's fakeFetch pattern.
 */

const NOW = new Date("2026-09-23T08:00:00.000Z");
const key = "test-only-not-a-real-credential-12345";

// ---------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------

let rowSeq = 0;
function row(companyId: string, overrides: Partial<CompanyRecord> & Pick<CompanyRecord, "companyName" | "normalizedName">): CompanyRecord {
  const observedAt = overrides.observedAt ?? "2026-08-01";
  return {
    nameAr: null, nameEn: null, registrationNumber: null, legalType: "LLC", status: "active", registrationDate: "2015-01-01",
    industry: null, activities: [], governorate: null, wilayat: null, area: null, address: null, website: null, email: null, phone: null,
    vatNumber: null, vatStatus: null, employeeRange: null, estimatedCompanySize: null,
    sourceType: "government", sourceName: "Oman Ministry of Commerce (test)", sourceRecordId: `rec-${++rowSeq}`, sourceUrl: "https://registry.example/om",
    metadata: {}, verificationStatus: "verified", lastVerifiedAt: observedAt,
    id: `row-${rowSeq}`, companyId, ingestedAt: "2026-08-02T00:00:00.000Z", firstSeenAt: "2026-08-02T00:00:00.000Z", lastSeenAt: observedAt, recordVersion: 1,
    ...overrides, observedAt
  } as CompanyRecord;
}

class FakeCompanies implements CompanyDataProvider {
  readonly name = "Fake registry";
  searches = 0;
  constructor(private readonly rows: CompanyRecord[], private readonly fail = false) {}
  async search() { this.searches++; if (this.fail) throw new Error("db down"); return this.rows; }
  async getByCompanyId(id: string) { if (this.fail) throw new Error("db down"); return this.rows.filter(r => r.companyId === id); }
  async getAwardsByCompanyId() { return []; }
}

class FakeWebsite implements SupplierWebsiteProvider {
  readonly kind = "website" as const; readonly id = "fake_website"; readonly name = "Fake website";
  calls = 0;
  constructor(private readonly byUrl: Record<string, WebsiteEvidence | "unavailable">, private readonly configured = true) {}
  async inspectWebsite(url: string, now: Date): Promise<ProviderResult<WebsiteEvidence>> {
    this.calls++;
    if (!this.configured) return { status: "not_configured", evidence: null, sources: [], reason: "off" };
    const ev = this.byUrl[url];
    if (!ev || ev === "unavailable") return { status: "unavailable", evidence: null, sources: [], reason: "The website could not be reached (network)." };
    return { status: "ok", evidence: ev, sources: [{ type: "company_website", name: `Supplier website (${ev.finalDomain})`, url: ev.finalUrl, checkedAt: now.toISOString(), observedAt: now.toISOString() }], reason: null };
  }
}

function site(domain: string, text: string, extra: Partial<WebsiteEvidence> = {}): WebsiteEvidence {
  return {
    requestedUrl: `https://${domain}`, finalUrl: `https://${domain}/`, finalDomain: domain, reachable: true, httpStatus: 200, https: true,
    title: null, textExcerpt: text, emails: [], phones: [], pagesFetched: [`https://${domain}/`], fetchError: null, ...extra
  };
}

class FakeSanctions implements SanctionsListProvider {
  readonly kind = "sanctions" as const; readonly id: string; readonly name: string; readonly listName: string;
  calls = 0;
  constructor(listName: string, private readonly entries: SanctionsListEntry[] | "unavailable") { this.id = `fake_${listName}`; this.name = listName; this.listName = listName; }
  async screenName(_name: string, now: Date): Promise<ProviderResult<{ listName: string; candidates: SanctionsListEntry[] }>> {
    this.calls++;
    if (this.entries === "unavailable") return { status: "unavailable", evidence: null, sources: [], reason: "down" };
    return { status: "ok", evidence: { listName: this.listName, candidates: this.entries }, sources: [{ type: "sanctions_list", name: this.listName, url: "https://list.example", checkedAt: now.toISOString(), observedAt: null }], reason: null };
  }
}

class FakePublicWeb implements SupplierPublicRiskProvider {
  readonly kind = "public_web" as const; readonly id = "fake_web"; readonly name = "Fake web search";
  constructor(private readonly results: PublicWebResult[] | "not_configured" | "unavailable") {}
  async findSignals(name: string, now: Date): Promise<ProviderResult<{ query: string; results: PublicWebResult[] }>> {
    if (this.results === "not_configured") return { status: "not_configured", evidence: null, sources: [], reason: "off" };
    if (this.results === "unavailable") return { status: "unavailable", evidence: null, sources: [], reason: "down" };
    return { status: "ok", evidence: { query: name, results: this.results }, sources: [{ type: "public_web", name: this.name, url: null, checkedAt: now.toISOString(), observedAt: null }], reason: null };
  }
}

function deps(opts: {
  rows?: CompanyRecord[]; registryFails?: boolean; websites?: Record<string, WebsiteEvidence | "unavailable">; websiteConfigured?: boolean;
  sanctions?: SanctionsListProvider[]; web?: PublicWebResult[] | "not_configured" | "unavailable"; store?: MemoryEvidenceStore;
} = {}): SupplierCheckDependencies & { companies: FakeCompanies; websiteFake: FakeWebsite; memory: MemoryEvidenceStore } {
  const companies = new FakeCompanies(opts.rows ?? [], opts.registryFails);
  const websiteFake = new FakeWebsite(opts.websites ?? {}, opts.websiteConfigured ?? true);
  const memory = opts.store ?? new MemoryEvidenceStore();
  return {
    identity: new OmanRegistryIdentityProvider(companies), website: websiteFake,
    sanctions: opts.sanctions ?? [new FakeSanctions("UN Security Council Consolidated List", [])],
    publicRisk: new FakePublicWeb(opts.web ?? []),
    store: memory, ttls: { identityMs: 7 * 86_400_000, websiteMs: 3 * 86_400_000, sanctionsMs: 43_200_000, publicRiskMs: 86_400_000 },
    now: () => NOW, companies, websiteFake, memory
  };
}

/** A well-evidenced Omani HVAC contractor held by a registry-grade source. */
function hvacRows(): CompanyRecord[] {
  return [
    row("co-hvac", {
      companyName: "Al Waha Cooling Services LLC", normalizedName: "AL WAHA COOLING SERVICES", registrationNumber: "1234567",
      industry: "HVAC contracting", activities: ["Air conditioning installation and maintenance", "Ventilation works"],
      governorate: "Muscat", wilayat: "Bawshar", area: "Ghala", address: "Ghala Industrial Area, Bawshar, Muscat",
      website: "https://alwahacooling.om", email: "info@alwahacooling.om", phone: "+968 2450 1122"
    }),
    row("co-hvac", { companyName: "Al Waha Cooling Services LLC", normalizedName: "AL WAHA COOLING SERVICES", registrationNumber: "1234567", sourceType: "tax_authority", sourceName: "Tax Oman (test)", industry: "HVAC contracting" })
  ];
}
const hvacSite = site("alwahacooling.om", "Al Waha Cooling Services LLC — HVAC maintenance, air conditioning installation, chiller servicing and ventilation. Ghala, Muscat, Sultanate of Oman. info@alwahacooling.om +968 2450 1122", { title: "Al Waha Cooling Services", emails: ["info@alwahacooling.om"], phones: ["24501122"] });

const strongInput = { companyName: "Al Waha Cooling Services L.L.C.", crNumber: "123-4567", website: "alwahacooling.om", email: "sales@alwahacooling.om", phone: "24501122", address: "Ghala, Muscat", requiredProductOrService: "HVAC maintenance" };

// ---------------------------------------------------------------------------------------------
// 1. Strong identity, matching activity, clean sanctions → appears_suitable
// ---------------------------------------------------------------------------------------------

test("strong company identity: registry-grade source + CR + corroborating contacts → strong, identityConfirmed, low risk, appears_suitable", async () => {
  const d = deps({ rows: hvacRows(), websites: { "https://alwahacooling.om": hvacSite } });
  const r = await runOmanSupplierCheck(strongInput, d);
  assert.ok(omanSupplierCheckOutput.safeParse(r).success);
  assert.equal(r.supplier.identityMatch, "strong");
  assert.equal(r.supplier.companyId, "co-hvac");
  assert.equal(r.supplier.crNumber, "1234567");
  assert.equal(r.screeningResult.identityConfirmed, true);
  assert.equal(r.checks.companyIdentity.status, "pass");
  assert.ok(r.checks.companyIdentity.confidence >= 0.8);
  assert.equal(r.checks.website.status, "pass");
  assert.equal(r.checks.contactConsistency.status, "pass");
  assert.equal(r.checks.addressConsistency.status, "pass");
  assert.equal(r.checks.sanctions.status, "clear");
  assert.equal(r.screeningResult.risk, "low");
  assert.equal(r.screeningResult.procurementSuitability, "appears_suitable");
  assert.equal(r.riskFlags.length, 0);
  assert.ok(r.confidence >= 0.8);
  // Every factual finding is traceable to a source.
  assert.ok(r.sources.some(s => s.type === "company_registry"));
  assert.ok(r.sources.some(s => s.type === "company_website"));
  assert.ok(r.sources.some(s => s.type === "sanctions_list"));
});

test("strong-identity result never uses certification wording (verified/approved/certified/AML cleared/KYC passed/sanctioned:true)", async () => {
  const r = await runOmanSupplierCheck(strongInput, deps({ rows: hvacRows(), websites: { "https://alwahacooling.om": hvacSite } }));
  const text = JSON.stringify(r);
  for (const banned of ["\"approved\"", "certified supplier", "approved supplier", "government verified", "AML cleared", "KYC passed", "\"sanctioned\"", "supplierVerified"]) {
    assert.ok(!text.includes(banned), `output must not contain ${banned}`);
  }
});

// ---------------------------------------------------------------------------------------------
// 2. Weak identity evidence
// ---------------------------------------------------------------------------------------------

test("weak identity evidence: directory-only exact name match without CR/contacts → weak, not confirmed, review_recommended", async () => {
  const rows = [row("co-dir", { companyName: "Blue Coast Trading LLC", normalizedName: "BLUE COAST TRADING", sourceType: "directory", sourceName: "Business directory (test)", industry: "Trading" })];
  const r = await runOmanSupplierCheck({ companyName: "Blue Coast Trading LLC" }, deps({ rows }));
  assert.equal(r.supplier.identityMatch, "weak");
  assert.equal(r.screeningResult.identityConfirmed, false);
  assert.equal(r.checks.companyIdentity.status, "partial");
  assert.ok(r.riskFlags.some(f => f.code === "IDENTITY_NOT_CONFIRMED"));
  assert.notEqual(r.screeningResult.procurementSuitability, "appears_suitable");
  assert.ok(r.sources.every(s => s.type !== "company_registry"), "directory evidence is labeled company_directory, not registry");
});

test("demo-only registry evidence can never produce a confirmed identity and is labeled demo", async () => {
  const rows = hvacRows().map(r => ({ ...r, sourceType: "demo" as const, sourceName: "demo" }));
  const r = await runOmanSupplierCheck(strongInput, deps({ rows, websites: { "https://alwahacooling.om": hvacSite } }));
  assert.equal(r.screeningResult.identityConfirmed, false);
  assert.ok(r.riskFlags.some(f => f.code === "DEMO_DATA_ONLY"));
  assert.equal(r.dataCoverage.demoDataOnly, true);
  assert.ok(r.sources.some(s => s.type === "demo_dataset"));
});

// ---------------------------------------------------------------------------------------------
// 3. CR number conflict
// ---------------------------------------------------------------------------------------------

test("CR number conflict: supplied CR is registered to a different company → CR_NUMBER_CONFLICT (high), identity fail, contradictory-identity signal, elevated risk", async () => {
  const rows = [...hvacRows(), row("co-other", { companyName: "Sohar Steel Works LLC", normalizedName: "SOHAR STEEL WORKS", registrationNumber: "7654321", industry: "Manufacturing" })];
  const r = await runOmanSupplierCheck({ companyName: "Al Waha Cooling Services LLC", crNumber: "7654321" }, deps({ rows }));
  const flag = r.riskFlags.find(f => f.code === "CR_NUMBER_CONFLICT");
  assert.ok(flag); assert.equal(flag.severity, "high");
  assert.ok(r.riskFlags.some(f => f.code === "COMPANY_NAME_MISMATCH"));
  assert.equal(r.checks.companyIdentity.status, "fail");
  assert.equal(r.screeningResult.identityConfirmed, false);
  assert.ok(r.checks.publicRisk.signals.some(s => s.type === "contradictory_business_identity" && s.evidenceTier === "automated_indicator"));
  assert.ok(["medium", "high"].includes(r.screeningResult.risk));
  assert.ok(r.riskModel.components.some(c => c.points === 35));
});

test("CR number conflict: the name-matched registry company holds a different CR → medium CR_NUMBER_CONFLICT, identity capped at weak", async () => {
  const r = await runOmanSupplierCheck({ companyName: "Al Waha Cooling Services LLC", crNumber: "9999999" }, deps({ rows: hvacRows() }));
  const flag = r.riskFlags.find(f => f.code === "CR_NUMBER_CONFLICT");
  assert.ok(flag); assert.equal(flag.severity, "medium");
  assert.ok(["weak", "unconfirmed"].includes(r.supplier.identityMatch));
  assert.equal(r.supplier.crNumberSupplied, "9999999");
});

// ---------------------------------------------------------------------------------------------
// 4/5. Business activity
// ---------------------------------------------------------------------------------------------

test("matching business activity: registry activities cover the requested service → pass, activityMatch true", async () => {
  const r = await runOmanSupplierCheck({ companyName: "Al Waha Cooling Services LLC", requiredProductOrService: "air conditioning maintenance" }, deps({ rows: hvacRows() }));
  assert.equal(r.checks.businessActivity.status, "pass");
  assert.equal(r.screeningResult.activityMatch, true);
  assert.deepEqual(r.checks.businessActivity.requiredCategories, ["hvac"]);
});

test("activity mismatch: IT consulting supplier vs fire alarm maintenance → fail, ACTIVITY_MISMATCH, never appears_suitable", async () => {
  const rows = [row("co-it", { companyName: "Nizwa Digital Consulting LLC", normalizedName: "NIZWA DIGITAL CONSULTING", registrationNumber: "5550001", industry: "IT consulting", activities: ["Software development", "IT consulting"], website: "https://nizwadigital.om" })];
  const r = await runOmanSupplierCheck({ companyName: "Nizwa Digital Consulting LLC", crNumber: "5550001", requiredProductOrService: "Fire alarm maintenance" }, deps({ rows }));
  assert.equal(r.checks.businessActivity.status, "fail");
  assert.equal(r.screeningResult.activityMatch, false);
  const flag = r.riskFlags.find(f => f.code === "ACTIVITY_MISMATCH");
  assert.ok(flag); assert.equal(flag.severity, "medium");
  assert.match(flag.message, /does not clearly match/);
  assert.notEqual(r.screeningResult.procurementSuitability, "appears_suitable");
});

test("assessActivity: broad general-trading supplier → partial; no required service → unknown with activityMatch null; Arabic request categorized", () => {
  assert.equal(assessActivity("CCTV installation", "General trading. Import and export", null).status, "partial");
  const none = assessActivity(null, "HVAC", null);
  assert.equal(none.status, "unknown"); assert.equal(none.activityMatch, null);
  assert.equal(assessActivity("صيانة أنظمة التكييف", "HVAC contracting", null).status, "pass");
  assert.equal(assessActivity("CCTV installation", null, "We install CCTV cameras and access control systems across Muscat").status, "pass");
});

// ---------------------------------------------------------------------------------------------
// 6. Website checks
// ---------------------------------------------------------------------------------------------

test("website/company-name mismatch: reachable site that neither names the company nor uses a matching domain → WEBSITE_IDENTITY_CONFLICT", async () => {
  const other = site("cheap-parts-online.com", "Discount car parts shipped worldwide. Contact us today.", { title: "Cheap Parts Online" });
  const r = await runOmanSupplierCheck({ companyName: "Al Waha Cooling Services LLC", website: "https://cheap-parts-online.com" }, deps({ rows: hvacRows(), websites: { "https://cheap-parts-online.com": other } }));
  assert.equal(r.checks.website.status, "fail");
  assert.equal(r.checks.website.signals.companyNameOnWebsite, false);
  assert.ok(r.riskFlags.some(f => f.code === "WEBSITE_IDENTITY_CONFLICT"));
});

test("no website supplied or on file: website status unknown, no risk flag or points — a missing website is never high risk", async () => {
  const rows = [row("co-nosite", { companyName: "Sur Marine Supplies LLC", normalizedName: "SUR MARINE SUPPLIES", registrationNumber: "3131313", industry: "Marine supplies" })];
  const r = await runOmanSupplierCheck({ companyName: "Sur Marine Supplies LLC", crNumber: "3131313" }, deps({ rows }));
  assert.equal(r.checks.website.status, "unknown");
  assert.equal(r.checks.website.signals.websiteExists, false);
  assert.ok(!r.riskFlags.some(f => f.code.startsWith("WEBSITE")));
  assert.ok(!r.riskModel.components.some(c => c.factor === "website"));
  assert.notEqual(r.screeningResult.risk, "high");
  assert.ok(r.limitations.some(l => /No website was supplied/.test(l)));
});

test("registry website is inspected when none is supplied", async () => {
  const d = deps({ rows: hvacRows(), websites: { "https://alwahacooling.om": hvacSite } });
  const r = await runOmanSupplierCheck({ companyName: "Al Waha Cooling Services LLC" }, d);
  assert.equal(r.checks.website.urlSource, "registry");
  assert.equal(r.checks.website.status, "pass");
});

// ---------------------------------------------------------------------------------------------
// 7. Contact consistency
// ---------------------------------------------------------------------------------------------

test("email-domain mismatch: corporate email on an unrelated domain → EMAIL_DOMAIN_MISMATCH; lookalike domain → LOOKALIKE_DOMAIN + impersonation signal", async () => {
  const mismatch = await runOmanSupplierCheck({ companyName: "Al Waha Cooling Services LLC", email: "orders@globalsupplyhub.net" }, deps({ rows: hvacRows() }));
  assert.ok(mismatch.riskFlags.some(f => f.code === "EMAIL_DOMAIN_MISMATCH"));
  assert.equal(mismatch.checks.contactConsistency.status, "fail");

  const look = await runOmanSupplierCheck({ companyName: "Al Waha Cooling Services LLC", email: "accounts@alwahacooling-om.com" }, deps({ rows: hvacRows() }));
  assert.ok(look.riskFlags.some(f => f.code === "LOOKALIKE_DOMAIN"));
  assert.ok(look.checks.publicRisk.signals.some(s => s.type === "possible_impersonation"));
  assert.equal(look.checks.publicRisk.status, "signal_detected");
});

test("a Gmail/Outlook address alone is only a low FREE_EMAIL_PROVIDER note, never high risk", async () => {
  const r = await runOmanSupplierCheck({ ...strongInput, email: "alwaha.cooling@gmail.com" }, deps({ rows: hvacRows(), websites: { "https://alwahacooling.om": hvacSite } }));
  const flag = r.riskFlags.find(f => f.code === "FREE_EMAIL_PROVIDER");
  assert.ok(flag); assert.equal(flag.severity, "low");
  assert.ok(!r.riskFlags.some(f => f.code === "EMAIL_DOMAIN_MISMATCH"));
  assert.equal(r.screeningResult.risk, "low");
});

test("phone mismatch is a low-severity consistency flag; a foreign number is flagged PHONE_NOT_OMAN", async () => {
  const r = await runOmanSupplierCheck({ companyName: "Al Waha Cooling Services LLC", phone: "+968 9123 4567" }, deps({ rows: hvacRows() }));
  const flag = r.riskFlags.find(f => f.code === "PHONE_MISMATCH");
  assert.ok(flag); assert.equal(flag.severity, "low");
  const foreign = await runOmanSupplierCheck({ companyName: "Al Waha Cooling Services LLC", phone: "+971 4 123 4567" }, deps({ rows: hvacRows() }));
  assert.ok(foreign.riskFlags.some(f => f.code === "PHONE_NOT_OMAN"));
});

// ---------------------------------------------------------------------------------------------
// 9. Address
// ---------------------------------------------------------------------------------------------

test("no address supplied: address status unknown with no risk contribution; different governorate → ADDRESS_MISMATCH conflict", async () => {
  const none = await runOmanSupplierCheck({ companyName: "Al Waha Cooling Services LLC" }, deps({ rows: hvacRows() }));
  assert.equal(none.checks.addressConsistency.status, "unknown");
  assert.ok(!none.riskModel.components.some(c => c.factor === "addressConsistency"));

  const conflict = await runOmanSupplierCheck({ companyName: "Al Waha Cooling Services LLC", address: "Salalah, Dhofar" }, deps({ rows: hvacRows() }));
  assert.equal(conflict.checks.addressConsistency.status, "conflict");
  assert.ok(conflict.riskFlags.some(f => f.code === "ADDRESS_MISMATCH"));

  const partial = await runOmanSupplierCheck({ companyName: "Al Waha Cooling Services LLC", address: "Al Khuwair, Muscat" }, deps({ rows: hvacRows() }));
  assert.equal(partial.checks.addressConsistency.status, "partial");
});

// ---------------------------------------------------------------------------------------------
// 10/11. Sanctions
// ---------------------------------------------------------------------------------------------

test("clean sanctions result: lists checked, no candidate names close enough → status clear, matches []", async () => {
  const sanctions = [new FakeSanctions("UN Security Council Consolidated List", [{ name: "Totally Unrelated Shipping Company", aliases: [], listName: "UN", reference: "QDe.001", sourceUrl: null }])];
  const r = await runOmanSupplierCheck({ companyName: "Al Waha Cooling Services LLC" }, deps({ rows: hvacRows(), sanctions }));
  assert.equal(r.checks.sanctions.status, "clear");
  assert.deepEqual(r.checks.sanctions.matches, []);
  assert.deepEqual(r.checks.sanctions.listsChecked, ["UN Security Council Consolidated List"]);
});

test("fuzzy potential sanctions match: reported as potential_match with score/reason, never as a confirmed listing", async () => {
  const sanctions = [new FakeSanctions("US Consolidated Screening List (includes OFAC SDN)", [{ name: "AL WAHA COOLING SERVICE CO", aliases: [], listName: "SDN", reference: "IRAN", sourceUrl: "https://list.example/1" }])];
  const r = await runOmanSupplierCheck({ companyName: "Al Waha Cooling Services LLC" }, deps({ rows: hvacRows(), sanctions }));
  assert.equal(r.checks.sanctions.status, "potential_match");
  const m = r.checks.sanctions.matches[0]!;
  assert.equal(m.matchType, "fuzzy_name");
  assert.ok(m.matchScore >= 0.88 && m.matchScore < 1);
  assert.match(m.reason, /potential match only/);
  assert.ok(r.riskFlags.some(f => f.code === "POTENTIAL_SANCTIONS_MATCH" && f.severity === "medium"));
  assert.ok(!("sanctioned" in r.checks.sanctions));
  assert.ok(!JSON.stringify(r).includes("\"sanctioned\":true"));
});

test("exact normalized-name sanctions match → high risk / potential_risk, still a potential match, even with thin evidence", async () => {
  const sanctions = [new FakeSanctions("UN", [{ name: "Blue Horizon Trading Est.", aliases: [], listName: "UN", reference: "QDe.999", sourceUrl: null }])];
  const r = await runOmanSupplierCheck({ companyName: "Blue Horizon Trading" }, deps({ sanctions }));
  assert.equal(r.checks.sanctions.status, "potential_match");
  assert.equal(r.checks.sanctions.matches[0]!.matchType, "exact_normalized_name");
  assert.equal(r.screeningResult.risk, "high");
  assert.equal(r.screeningResult.procurementSuitability, "potential_risk");
});

test("sanctions matcher is conservative: similar-but-different names and short names don't match; aliases are checked", () => {
  assert.equal(findPotentialMatches("Gulf Star Trading LLC", [{ name: "Gulf Stream Travel Ltd", aliases: [], listName: "X", reference: null, sourceUrl: null }]).length, 0);
  assert.equal(findPotentialMatches("ABC Co", [{ name: "ABD Co", aliases: [], listName: "X", reference: null, sourceUrl: null }]).length, 0);
  const viaAlias = findPotentialMatches("Red Dune Logistics", [{ name: "Some Other Name", aliases: ["RED DUNE LOGISTICS LTD"], listName: "X", reference: null, sourceUrl: null }]);
  assert.equal(viaAlias.length, 1); assert.equal(viaAlias[0]!.matchedAlias, "RED DUNE LOGISTICS LTD");
  assert.equal(nameMatchScore("Trading Acme International", "Acme International Trading").score, 1);
});

test("UN Consolidated List XML parsing and CSL response parsing (mocked fetch)", async () => {
  const xml = `<CONSOLIDATED_LIST><ENTITIES><ENTITY><REFERENCE_NUMBER>QDe.001</REFERENCE_NUMBER><FIRST_NAME>RED DUNE LOGISTICS</FIRST_NAME><ENTITY_ALIAS><ALIAS_NAME>RDL CO</ALIAS_NAME></ENTITY_ALIAS></ENTITY></ENTITIES></CONSOLIDATED_LIST>`;
  assert.deepEqual(parseUnConsolidatedXml(xml)[0]!.aliases, ["RDL CO"]);
  const un = new UnConsolidatedListProvider({ url: "https://un.example/list.xml", fetchImpl: (async () => new Response(xml, { status: 200 })) as typeof fetch });
  const unResult = await un.screenName("Red Dune Logistics LLC", NOW);
  assert.equal(unResult.status, "ok"); assert.equal(unResult.evidence!.candidates.length, 1);
  const unDown = new UnConsolidatedListProvider({ url: "https://un.example/list.xml", fetchImpl: (async () => new Response("", { status: 503 })) as typeof fetch });
  assert.equal((await unDown.screenName("x", NOW)).status, "unavailable");

  let seenHeaders: Headers | null = null;
  const csl = new UsConsolidatedScreeningListProvider({ url: "https://csl.example/search", apiKey: "k", fetchImpl: (async (_u: string, init?: RequestInit) => { seenHeaders = new Headers(init?.headers); return Response.json({ results: [{ name: "RED DUNE LOGISTICS", alt_names: ["RDL"], source: "Specially Designated Nationals (SDN) - Treasury Department", programs: ["SDGT"] }] }); }) as typeof fetch });
  const cslResult = await csl.screenName("Red Dune Logistics", NOW);
  assert.equal(cslResult.status, "ok");
  assert.equal(cslResult.evidence!.candidates[0]!.reference, "SDGT");
  assert.equal(seenHeaders!.get("subscription-key"), "k");
  assert.ok(!cslResult.sources[0]!.url!.includes("subscription"));
});

// ---------------------------------------------------------------------------------------------
// 12/17. Incomplete data / insufficient_data
// ---------------------------------------------------------------------------------------------

test("incomplete data: only a company name, no registry match, no live sources → insufficient_data / insufficient_information, risk score 0", async () => {
  const r = await runOmanSupplierCheck({ companyName: "Unknown Phantom Enterprises" }, deps({ sanctions: [], web: "not_configured" }));
  assert.equal(r.supplier.identityMatch, "unconfirmed");
  assert.equal(r.screeningResult.risk, "insufficient_data");
  assert.equal(r.screeningResult.procurementSuitability, "insufficient_information");
  assert.equal(r.screeningResult.riskScore, 0);
  assert.equal(r.checks.sanctions.status, "not_checked");
  assert.equal(r.checks.publicRisk.status, "not_checked");
  assert.ok(r.riskFlags.some(f => f.code === "INSUFFICIENT_PUBLIC_DATA"));
  assert.ok(r.confidence < 0.25);
  assert.match(r.checks.companyIdentity.explanation, /not evidence that the company does not exist/);
});

// ---------------------------------------------------------------------------------------------
// 13. Source provider unavailable
// ---------------------------------------------------------------------------------------------

test("source providers unavailable: registry throws, website and sanctions down → partial result (no exception), SOURCE_UNAVAILABLE, statuses honest", async () => {
  const d = deps({ registryFails: true, websites: { "https://alwahacooling.om": "unavailable" }, sanctions: [new FakeSanctions("UN", "unavailable")], web: "unavailable" });
  const r = await runOmanSupplierCheck(strongInput, d);
  assert.ok(omanSupplierCheckOutput.safeParse(r).success);
  assert.equal(r.checks.companyIdentity.status, "unknown");
  assert.equal(r.checks.sanctions.status, "unavailable");
  assert.equal(r.checks.publicRisk.status, "unavailable");
  assert.ok(r.riskFlags.some(f => f.code === "SOURCE_UNAVAILABLE"));
  assert.ok(r.dataCoverage.unavailableSources.length >= 3);
  assert.notEqual(r.screeningResult.procurementSuitability, "appears_suitable");
});

test("unavailable results are never cached: the provider is retried on the next call", async () => {
  const d = deps({ rows: hvacRows(), websites: { "https://alwahacooling.om": "unavailable" } });
  await runOmanSupplierCheck(strongInput, d);
  await runOmanSupplierCheck(strongInput, d);
  assert.equal(d.websiteFake.calls, 2);
});

// ---------------------------------------------------------------------------------------------
// 14. Normalization
// ---------------------------------------------------------------------------------------------

test("normalized duplicate company identity: spelling/format variants share one identity key and evidence cache entry", async () => {
  const a = normalizeSupplierInput({ companyName: "Al Waha Cooling Services L.L.C.", crNumber: "123-4567" });
  const b = normalizeSupplierInput({ companyName: "  al waha   cooling services llc ", crNumber: "1234567" });
  assert.equal(supplierIdentityKey(a), supplierIdentityKey(b));
  const d = deps({ rows: hvacRows() });
  const r1 = await runOmanSupplierCheck({ companyName: "Al Waha Cooling Services L.L.C.", crNumber: "123-4567" }, d);
  const searchesAfterFirst = d.companies.searches;
  const r2 = await runOmanSupplierCheck({ companyName: "al waha cooling services llc", crNumber: "1234567" }, d);
  assert.equal(d.companies.searches, searchesAfterFirst, "second, equivalent request is served from the identity evidence cache");
  assert.equal(r1.supplier.companyId, r2.supplier.companyId);
});

test("normalization: Oman phones, websites, emails, CR numbers and Arabic name variants", () => {
  for (const p of ["+968 2440 1234", "00968-24401234", "24401234", "968 24401234"]) assert.equal(normalizePhone(p).e164, "+96824401234");
  assert.equal(normalizePhone("+968 9123 4567").lineType, "mobile");
  assert.equal(normalizePhone("+968 24XXXXXX").isOman, false);
  assert.equal(normalizePhone("+971 4 123 4567").isOman, false);
  assert.deepEqual(normalizeWebsite("WWW.Example.OM/"), { url: "https://www.example.om", domain: "example.om" });
  assert.equal(normalizeWebsite("ftp://example.om"), null);
  assert.equal(registrableDomain("mail.acme.co.om"), "acme.co.om");
  assert.equal(normalizeEmail("Sales@Acme.OM")!.domain, "acme.om");
  assert.equal(normalizeEmail("someone@gmail.com")!.free, true);
  assert.equal(normalizeSupplierInput({ companyName: "X", crNumber: " 1234-567 " }).crNumber, "1234567");
  assert.equal(arabicNameToEnglishKey("شركة الخليج للتجارة ش.م.م"), "GULF TRADING");
  const ar = normalizeSupplierInput({ companyName: "شركة الخليج للتجارة ش.م.م" });
  assert.equal(ar.nameScript, "ar");
  assert.ok(ar.nameVariants.includes("GULF TRADING"));
});

test("Arabic company name resolves to the English registry record through the glossary variant", async () => {
  const rows = [row("co-gulf", { companyName: "Gulf Trading LLC", normalizedName: "GULF TRADING", registrationNumber: "4444444", industry: "Trading" })];
  const r = await runOmanSupplierCheck({ companyName: "شركة الخليج للتجارة ش.م.م" }, deps({ rows }));
  assert.equal(r.supplier.companyId, "co-gulf");
  assert.ok(r.limitations.some(l => /Arabic company names/.test(l)));
});

test("input validation: companyName required; malformed optional fields rejected; unknown fields rejected", () => {
  assert.throws(() => omanSupplierCheckInput.parse({}));
  assert.throws(() => omanSupplierCheckInput.parse({ companyName: "A" }));
  assert.throws(() => omanSupplierCheckInput.parse({ companyName: "ABC", email: "not-an-email" }));
  assert.throws(() => omanSupplierCheckInput.parse({ companyName: "ABC", website: "javascript:alert(1)" }));
  assert.throws(() => omanSupplierCheckInput.parse({ companyName: "ABC", phone: "call me" }));
  assert.throws(() => omanSupplierCheckInput.parse({ companyName: "ABC", extra: true }));
  assert.doesNotThrow(() => omanSupplierCheckInput.parse({ companyName: "ABC Trading LLC", crNumber: "1234567", website: "example.com", email: "sales@example.com", phone: "+968 24XXXXXX", address: "Muscat, Oman", requiredProductOrService: "HVAC maintenance" }));
});

// ---------------------------------------------------------------------------------------------
// 15. Idempotency
// ---------------------------------------------------------------------------------------------

test("repeated call remains idempotent: identical output, no duplicate evidence records, cached evidence reused", async () => {
  const d = deps({ rows: hvacRows(), websites: { "https://alwahacooling.om": hvacSite } });
  const first = await runOmanSupplierCheck(strongInput, d);
  const sizeAfterFirst = d.memory.size;
  const second = await runOmanSupplierCheck(strongInput, d);
  assert.deepEqual(second, first);
  assert.equal(d.memory.size, sizeAfterFirst, "no new evidence rows on a repeated call");
  assert.equal(d.websiteFake.calls, 1, "website evidence is served from cache");
  assert.equal(d.memory.writesFor("fake_website", "https://alwahacooling.om"), 1);
});

test("evidence cache TTL: expired evidence is refetched and upserted in place (same key, no duplicate)", async () => {
  const store = new MemoryEvidenceStore();
  let calls = 0;
  const fetchOk = async (): Promise<ProviderResult<string>> => { calls++; return { status: "ok", evidence: "x", sources: [], reason: null }; };
  await cachedProviderCall(store, "p", "k", 1000, new Date(0), fetchOk);
  await cachedProviderCall(store, "p", "k", 1000, new Date(500), fetchOk);
  assert.equal(calls, 1);
  await cachedProviderCall(store, "p", "k", 1000, new Date(1500), fetchOk);
  assert.equal(calls, 2);
  assert.equal(store.size, 1);
  assert.equal(store.writesFor("p", "k"), 2);
});

const dbUrl = process.env.TEST_DATABASE_URL;
test("PostgresEvidenceStore upserts on (provider_id, evidence_key): repeated writes never duplicate rows (dedicated test database required)", { skip: !dbUrl }, async () => {
  const store = new PostgresEvidenceStore(dbUrl!);
  try {
    const provider = `test_provider_${Date.now()}`;
    const value = { result: { status: "ok" as const, evidence: { a: 1 }, sources: [], reason: null }, checkedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 60_000).toISOString() };
    await store.put(provider, "same-key", value, "co-1");
    await store.put(provider, "same-key", { ...value, result: { ...value.result, evidence: { a: 2 } } }, "co-1");
    assert.equal(await store.countRows(provider), 1);
    const got = await store.get<{ a: number }>(provider, "same-key", NOW);
    assert.equal(got?.result.evidence?.a, 2);
    assert.equal(await store.get(provider, "same-key", new Date(NOW.getTime() + 120_000)), null, "expired evidence is not served");
  } finally { await store.close(); }
});

test("repeated oman_supplier_check calls against a PostgreSQL evidence store create no duplicate rows (dedicated test database required)", { skip: !dbUrl }, async () => {
  const store = new PostgresEvidenceStore(dbUrl!);
  try {
    const d = deps({ rows: hvacRows(), websites: { "https://alwahacooling.om": hvacSite } });
    const pgDeps = { ...d, store };
    const first = await runOmanSupplierCheck(strongInput, pgDeps);
    const rowsAfterFirst = await store.countRows();
    const second = await runOmanSupplierCheck({ ...strongInput, companyName: "  al waha cooling services llc " , crNumber: "1234567" }, pgDeps);
    assert.equal(await store.countRows(), rowsAfterFirst, "equivalent normalized input reuses the same evidence rows");
    assert.equal(first.screeningResult.risk, second.screeningResult.risk);
    assert.equal(d.websiteFake.calls, 1);
  } finally { await store.close(); }
});

// ---------------------------------------------------------------------------------------------
// 16. Risk scoring boundaries
// ---------------------------------------------------------------------------------------------

test("risk scoring boundaries and suitability mapping", () => {
  assert.equal(RISK_THRESHOLDS.medium, 20); assert.equal(RISK_THRESHOLDS.high, 45);
  assert.equal(classifyRisk(19, 0.9, "strong"), "low");
  assert.equal(classifyRisk(20, 0.9, "strong"), "medium");
  assert.equal(classifyRisk(44, 0.9, "strong"), "medium");
  assert.equal(classifyRisk(45, 0.9, "strong"), "high");
  assert.equal(classifyRisk(60, 0.05, "unconfirmed"), "high", "strong adverse evidence is never hidden behind insufficient_data");
  assert.equal(classifyRisk(0, 0.24, "strong"), "insufficient_data");
  assert.equal(classifyRisk(0, 0.34, "unconfirmed"), "insufficient_data");
  assert.equal(classifyRisk(0, 0.35, "unconfirmed"), "low");
  assert.equal(classifyRisk(0, 0.3, "weak"), "low");
  assert.equal(procurementSuitability("high", true, "pass"), "potential_risk");
  assert.equal(procurementSuitability("insufficient_data", true, "pass"), "insufficient_information");
  assert.equal(procurementSuitability("medium", true, "pass"), "review_recommended");
  assert.equal(procurementSuitability("low", true, "pass"), "appears_suitable");
  assert.equal(procurementSuitability("low", true, "unknown"), "appears_suitable");
  assert.equal(procurementSuitability("low", false, "pass"), "review_recommended");
  assert.equal(procurementSuitability("low", true, "fail"), "review_recommended");
});

test("missing information lowers confidence, not risk: activity not requested is excluded from the confidence denominator", () => {
  const base = { identityLevel: "strong" as const, identityScore: 1, identityMatched: true, crConflict: null, activityStatus: "unknown" as const, websiteStatus: "pass" as const, websiteEvidenced: true, contactStatus: "pass" as const, addressStatus: "pass" as const, sanctionsStatus: "clear" as const, sanctionsMatchTypes: [], publicRiskStatus: "clear" as const, publicWebMentions: 0, flags: [] };
  assert.equal(computeConfidence({ ...base, activityRequested: false }), 1);
  assert.ok(computeConfidence({ ...base, activityRequested: true }) < 1);
  assert.ok(computeConfidence({ ...base, activityRequested: false, websiteEvidenced: false }) < 1);
});

test("public-web results only become signals when they name the supplier alongside a risk term; wording stays neutral", async () => {
  const web: PublicWebResult[] = [
    { title: "Scam warning: fake suppliers in the Gulf", url: "https://news.example/1", snippet: "Beware of fraud by unnamed companies.", publishedAt: null, publisher: null },
    { title: "Al Waha Cooling Services impersonation warning", url: "https://news.example/2", snippet: "Customers warned about fake invoices using the Al Waha Cooling name.", publishedAt: null, publisher: null }
  ];
  const r = await runOmanSupplierCheck({ companyName: "Al Waha Cooling Services LLC" }, deps({ rows: hvacRows(), web }));
  const mentions = r.checks.publicRisk.signals.filter(s => s.type === "public_web_mention");
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0]!.sourceUrl, "https://news.example/2");
  assert.equal(mentions[0]!.evidenceTier, "public_allegation");
  assert.match(mentions[0]!.description, /^Potential public-risk signal detected/);
  assert.ok(r.riskFlags.some(f => f.code === "PUBLIC_RISK_SIGNAL"));
  assert.ok(r.sources.some(s => s.url === "https://news.example/2"));
});

// ---------------------------------------------------------------------------------------------
// Website provider (real class, mocked fetch + resolver)
// ---------------------------------------------------------------------------------------------

test("PublicWebsiteProvider: extracts title/emails/phones, follows one same-host contact page, is off by default, and blocks private addresses", async () => {
  const pages: Record<string, string> = {
    "https://acme.om/": `<html><head><title>Acme Cooling LLC</title></head><body><h1>Acme Cooling LLC</h1><p>HVAC services in Muscat</p><a href="/contact-us">Contact</a><script>var x="ignored@script.com"</script></body></html>`,
    "https://acme.om/contact-us": `<p>Email: sales&#64;acme.om — Tel +968 2412 3456, Muscat, Sultanate of Oman</p>`
  };
  const fetchImpl = (async (url: string) => pages[url] !== undefined ? new Response(pages[url], { status: 200, headers: { "content-type": "text/html" } }) : new Response("nf", { status: 404 })) as typeof fetch;
  const resolver = { resolve: async (h: string) => (h === "internal.acme.om" ? ["10.0.0.5"] : ["93.184.216.34"]) };
  const provider = new PublicWebsiteProvider({ enabled: true, fetchImpl, resolver });
  const r = await provider.inspectWebsite("https://acme.om/", NOW);
  assert.equal(r.status, "ok");
  assert.equal(r.evidence!.title, "Acme Cooling LLC");
  assert.deepEqual(r.evidence!.emails, ["sales@acme.om"]);
  assert.deepEqual(r.evidence!.phones, ["24123456"]);
  assert.equal(r.evidence!.pagesFetched.length, 2);
  assert.ok(!r.evidence!.textExcerpt.includes("ignored@script.com"));

  const blocked = await provider.inspectWebsite("https://internal.acme.om/", NOW);
  assert.equal(blocked.evidence!.fetchError, "url_rejected:private_ip_resolved");

  const off = await new PublicWebsiteProvider({ enabled: false, fetchImpl }).inspectWebsite("https://acme.om/", NOW);
  assert.equal(off.status, "not_configured");
  assert.equal(htmlToText("<p>a&amp;b</p>"), "a&b");
  assert.deepEqual(extractEmails("logo@2x.png info@x.om"), ["info@x.om"]);
  assert.deepEqual(extractPhones("call 9123 4567 or +968 2412 3456"), ["91234567", "24123456"]);
});

// ---------------------------------------------------------------------------------------------
// Registry, analytics, example output
// ---------------------------------------------------------------------------------------------

test("registry integration: default capability resolves identity through the existing Oman company provider (demo dataset by default), never creating records", async () => {
  const capability = capabilities.find(c => c.name === "oman_supplier_check")!;
  const r = await capability.execute({ companyName: "Al Noor Trading LLC", crNumber: "1010123456" }) as ReturnType<typeof omanSupplierCheckOutput.parse>;
  assert.equal(r.supplier.companyId, "demo-co-1");
  assert.equal(r.dataCoverage.demoDataOnly, true);
  assert.equal(r.screeningResult.identityConfirmed, false, "demo data never confirms identity");
});

test("exampleOutput satisfies the output schema and equals execute(example) in the default (network-free) configuration", async () => {
  const capability = capabilities.find(c => c.name === "oman_supplier_check")!;
  assert.ok(omanSupplierCheckOutput.safeParse(capability.exampleOutput).success);
  assert.deepEqual(await capability.execute(capability.example), capability.exampleOutput);
});

test("classifyDataSource: oman_supplier_check reads its own dataCoverage", () => {
  assert.equal(classifyDataSource("oman_supplier_check", { dataCoverage: { registryMatch: true, demoDataOnly: true, liveChecksPerformed: [], unavailableSources: [] } }), "demo_manual");
  assert.equal(classifyDataSource("oman_supplier_check", { dataCoverage: { registryMatch: true, demoDataOnly: false, liveChecksPerformed: [], unavailableSources: [] } }), "partner_feed");
  assert.equal(classifyDataSource("oman_supplier_check", { dataCoverage: { registryMatch: false, demoDataOnly: false, liveChecksPerformed: ["sanctions"], unavailableSources: [] } }), "live_provider");
  assert.equal(classifyDataSource("oman_supplier_check", { dataCoverage: { registryMatch: false, demoDataOnly: false, liveChecksPerformed: [], unavailableSources: [] } }), "not_configured");
});

// ---------------------------------------------------------------------------------------------
// 18. x402 pricing
// ---------------------------------------------------------------------------------------------

test("x402 pricing is $0.50 and the pay-per-call route is generated from the registry", () => {
  const capability = capabilities.find(c => c.name === "oman_supplier_check")!;
  assert.equal(capability.price, 0.5);
  assert.equal(capability.paymentProtocol, "x402");
  assert.equal(prices.oman_supplier_check, 0.5);
  const billing = new BillingService(new MemoryUsageRepository());
  assert.equal(billing.getToolPrice("oman_supplier_check"), 0.5);
  const requirement = billing.buildX402PaymentRequirement("oman_supplier_check", "eip155:8453", "0x1234567890123456789012345678901234567890");
  assert.equal(requirement.price, "$0.50");
  const config = loadConfig({ RAFID_API_KEYS: key, X402_ENABLED: "true", X402_WALLET_ADDRESS: "0x1234567890123456789012345678901234567890" });
  const info = buildX402Info(config, billing);
  const tool = info.tools.find(t => t.name === "oman_supplier_check");
  assert.equal(tool?.price, 0.5);
  assert.equal(tool?.endpoint, "/api/v1/x402/procurement/oman-supplier-check");
  const doc = buildOpenapi(config) as { paths: Record<string, any> };
  const x402Op = doc.paths["/api/v1/x402/procurement/oman-supplier-check"]?.post;
  assert.equal(x402Op?.operationId, "oman_supplier_check_x402");
  assert.ok(x402Op.responses["402"].description.includes("0.50"));
});

// ---------------------------------------------------------------------------------------------
// 19/20. MCP registration and discovery surfaces
// ---------------------------------------------------------------------------------------------

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const config = loadConfig({ RAFID_API_KEYS: key, X402_ENABLED: "true", X402_WALLET_ADDRESS: "0x1234567890123456789012345678901234567890" });
  const app = createApp(config, { logger: () => {} });
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("no address");
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally { server.closeAllConnections(); server.close(); }
}

test("MCP registration: oman_supplier_check is listed with its registry description/whenToUse and strict schemas, and tools/call returns structured content", async () => {
  await withServer(async base => {
    const rpc = async (id: number, method: string, params: unknown) => (await (await fetch(base + "/mcp", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
    })).json()) as any;
    const listed = await rpc(1, "tools/list", {});
    const tool = listed.result.tools.find((t: any) => t.name === "oman_supplier_check");
    assert.ok(tool);
    assert.match(tool.description, /Screen an Oman supplier for procurement/);
    assert.match(tool.description, /Use before adding an Oman supplier to an RFQ/);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(tool.inputSchema.required, ["companyName"]);
    assert.equal(tool.annotations.idempotentHint, true);
    const called = await rpc(2, "tools/call", { name: "oman_supplier_check", arguments: { companyName: "Example Technical Services LLC", requiredProductOrService: "HVAC maintenance" } });
    assert.ok(!called.result.isError);
    assert.equal(called.result.structuredContent.supplier.country, "OM");
    const invalid = await rpc(3, "tools/call", { name: "oman_supplier_check", arguments: { website: "https://x.om" } });
    assert.ok(invalid.result?.isError || invalid.error);
  });
});

test("discovery endpoints include oman_supplier_check from the registry: /agent.json, /.well-known/agent.json, /llms.txt, /api/v1/capabilities, /api/v1/pricing, /api/v1/tools, OpenAPI", async () => {
  await withServer(async base => {
    for (const path of ["/agent.json", "/.well-known/agent.json", "/llms.txt", "/api/v1/capabilities", "/api/v1/pricing", "/api/v1/tools", "/openapi.json"]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200, path);
      const text = await response.text();
      assert.ok(text.includes("oman_supplier_check"), `${path} should list oman_supplier_check`);
    }
    const llms = await (await fetch(base + "/llms.txt")).text();
    assert.match(llms, /## oman_supplier_check[\s\S]*Price: \$0\.50 USD per call\.[\s\S]*POST \/api\/v1\/x402\/procurement\/oman-supplier-check/);
    assert.match(llms, /Check this supplier before I add it to an RFQ\./);
    const capsText = await (await fetch(base + "/api/v1/capabilities")).text();
    assert.match(capsText, /Use before adding an Oman supplier to an RFQ, vendor shortlist, procurement process or supplier onboarding workflow\./);
    const openapi = await (await fetch(base + "/openapi.json")).json() as any;
    const op = openapi.paths["/api/v1/procurement/oman-supplier-check"].post;
    assert.equal(op.operationId, "oman_supplier_check");
    assert.deepEqual(op.tags, ["Procurement"]);
    assert.equal(op.requestBody.content["application/json"].examples ? true : Boolean(op.requestBody.content["application/json"].example), true);
  });
});

test("REST route: API-key call returns the structured screening envelope", async () => {
  await withServer(async base => {
    const response = await fetch(base + "/api/v1/procurement/oman-supplier-check", {
      method: "POST", headers: { "X-API-Key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ companyName: "Example Technical Services LLC", website: "https://example.om", email: "sales@example.om", requiredProductOrService: "HVAC maintenance" })
    });
    assert.equal(response.status, 200);
    const body = await response.json() as any;
    assert.equal(body.meta.price, 0.5);
    assert.ok(omanSupplierCheckOutput.safeParse(body.data).success);
    const bad = await fetch(base + "/api/v1/procurement/oman-supplier-check", { method: "POST", headers: { "X-API-Key": key, "Content-Type": "application/json" }, body: JSON.stringify({ email: "a@b.om" }) });
    assert.equal(bad.status, 400);
  });
});
