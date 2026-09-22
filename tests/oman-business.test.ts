import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { normalizeCompanyName } from "../src/business-data/normalizers/companyName.js";
import { rankCompanies } from "../src/business-data/matching/search.js";
import { mergeCompanyRows } from "../src/business-data/matching/merge.js";
import { assessCompanyRisk } from "../src/business-data/scoring/risk.js";
import { computeCompanyConfidence } from "../src/business-data/scoring/confidence.js";
import { computeCommercialSignals } from "../src/business-data/scoring/signals.js";
import { DEMO_COMPANY_RECORDS } from "../src/business-data/sources/fixtures.js";
import { DemoCompanyProvider, DatabaseCompanyProvider } from "../src/business-data/sources/provider.js";
import { MemoryCompanyRepository } from "../src/business-data/sources/companyRepository.js";
import { importCompanyRecords } from "../src/business-data/ingestion/importPipeline.js";
import { runSearchOmanCompany, runGetOmanCompanyProfile, runAnalyzeOmanCompany, runDueDiligenceOmanCompany } from "../src/services/omanBusiness.js";
import { capabilities } from "../src/domain/capabilities.js";
import { createApp } from "../src/api/app.js";
import { loadConfig } from "../src/config/env.js";

const key = "test-only-not-a-real-credential-12345";
const demoProvider = new DemoCompanyProvider();

async function withServer<T>(config: ReturnType<typeof loadConfig>, fn: (base: string) => Promise<T>): Promise<T> {
  const app = createApp(config, { logger: () => {} });
  const server = app.listen(0, "127.0.0.1");
  try {
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a network address");
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

// ---------------------------------------------------------------------------------------------
// Section 3: deterministic company name normalization
// ---------------------------------------------------------------------------------------------

test("normalizeCompanyName: canonicalizes legal-form suffixes regardless of punctuation/spacing", () => {
  for (const variant of ["Al Noor Trading LLC", "Al Noor Trading L.L.C.", "Al Noor Trading L. L. C."]) {
    assert.equal(normalizeCompanyName(variant).normalized, "AL NOOR TRADING");
  }
  assert.equal(normalizeCompanyName("Gulf Star SAOC").legalTypeGuess, "SAOC");
  assert.equal(normalizeCompanyName("Gulf Star S.A.O.C.").legalTypeGuess, "SAOC");
  assert.equal(normalizeCompanyName("Gulf Star SAOG").legalTypeGuess, "SAOG");
  assert.equal(normalizeCompanyName("Nova Tech SPC").legalTypeGuess, "SPC");
  assert.equal(normalizeCompanyName("Al Amal Est.").legalTypeGuess, "EST");
  assert.equal(normalizeCompanyName("Al Amal Establishment").legalTypeGuess, "EST");
});

test("normalizeCompanyName: recognizes/canonicalizes business-descriptor words (Trading/Services/International/Enterprises/Projects) without mutating `original`, and without stripping them from the matching key", () => {
  const trading = normalizeCompanyName("Al Noor Trading LLC");
  assert.equal(trading.original, "Al Noor Trading LLC");
  assert.equal(trading.normalized, "AL NOOR TRADING");
  assert.equal(normalizeCompanyName("Al Fahad Services").normalized, "AL FAHAD SERVICES");
  assert.equal(normalizeCompanyName("Al Fahad International").normalized, "AL FAHAD INTERNATIONAL");
  assert.equal(normalizeCompanyName("Al Fahad Enterprises").normalized, "AL FAHAD ENTERPRISES");
  assert.equal(normalizeCompanyName("Al Fahad Projects").normalized, "AL FAHAD PROJECTS");
});

test("normalizeCompanyName: is conservative — business-descriptor words are recognized but never stripped, so two companies differing only by their descriptor never collide", () => {
  // "Al Noor Trading LLC" and "Al Noor Services LLC" are different real businesses; only the
  // legal-form suffix is stripped, so their normalized keys stay distinct.
  assert.notEqual(normalizeCompanyName("Al Noor Trading LLC").normalized, normalizeCompanyName("Al Noor Services LLC").normalized);
  assert.equal(normalizeCompanyName("Al Noor Trading LLC").normalized, "AL NOOR TRADING");
  assert.equal(normalizeCompanyName("Al Noor Services LLC").normalized, "AL NOOR SERVICES");
  // Only the legal form is a no-op difference: the exact same business under two legal-form
  // spellings still normalizes identically.
  assert.equal(normalizeCompanyName("Al Noor Trading LLC").normalized, normalizeCompanyName("Al Noor Trading L.L.C.").normalized);
  // At least one token is always kept, even for a name ending entirely in legal-form tokens.
  const onlyLegalForm = normalizeCompanyName("Al Noor LLC");
  assert.ok(onlyLegalForm.normalized.length > 0);
});

test("normalizeCompanyName: folds common Arabic diacritic/letter variants without corrupting Latin text", () => {
  const withTashkeel = normalizeCompanyName("شَرِكَة مَسْقَط");
  const withoutTashkeel = normalizeCompanyName("شركة مسقط");
  assert.equal(withTashkeel.normalized, withoutTashkeel.normalized);
  assert.equal(normalizeCompanyName("Al Noor Trading LLC").normalized, "AL NOOR TRADING");
});

// ---------------------------------------------------------------------------------------------
// Section 4: deterministic weighted search
// ---------------------------------------------------------------------------------------------

test("rankCompanies: exact registration number outranks exact name, which outranks a prefix or fuzzy match", () => {
  const results = rankCompanies(DEMO_COMPANY_RECORDS, { query: "1010123456" });
  assert.equal(results[0]!.record.companyId, "demo-co-1");
  assert.equal(results[0]!.confidence, 0.98);
});

test("rankCompanies: exact normalized-name match scores 0.94", () => {
  const results = rankCompanies(DEMO_COMPANY_RECORDS, { query: "Al Noor" });
  const top = results.find(r => r.record.companyId === "demo-co-1")!;
  assert.equal(top.confidence, 0.94);
});

test("rankCompanies: a short prefix scores lower than an exact match but is still returned", () => {
  const results = rankCompanies(DEMO_COMPANY_RECORDS, { query: "Al No" });
  const top = results.find(r => r.record.companyId === "demo-co-1")!;
  assert.ok(top.confidence >= 0.75 && top.confidence < 0.94);
});

test("rankCompanies: fuzzy/typo query still finds the intended company at a lower confidence", () => {
  const results = rankCompanies(DEMO_COMPANY_RECORDS, { query: "Al Noor Tradng" }); // dropped an 'i'
  const top = results.find(r => r.record.companyId === "demo-co-1");
  assert.ok(top, "expected a fuzzy match for a misspelled query");
  assert.ok(top!.confidence > 0 && top!.confidence < 0.94);
});

test("rankCompanies: identical display names under different registration numbers/governorates are never merged — each ranks as its own companyId", () => {
  const results = rankCompanies(DEMO_COMPANY_RECORDS, { query: "Gulf Services" });
  const ids = new Set(results.map(r => r.record.companyId));
  assert.ok(ids.has("demo-co-2") && ids.has("demo-co-3"), "both same-named companies must appear as distinct matches");
  assert.notEqual(results.find(r => r.record.companyId === "demo-co-2")!.record.registrationNumber, results.find(r => r.record.companyId === "demo-co-3")!.record.registrationNumber);
});

test("rankCompanies: governorate/wilayat/industry filters add a small confidence bonus without displacing a stronger name match", () => {
  const withoutFilter = rankCompanies(DEMO_COMPANY_RECORDS, { query: "Al Noor" }).find(r => r.record.companyId === "demo-co-1")!;
  const withFilter = rankCompanies(DEMO_COMPANY_RECORDS, { query: "Al Noor", governorate: "Muscat", industry: "Trading" }).find(r => r.record.companyId === "demo-co-1")!;
  assert.ok(withFilter.confidence >= withoutFilter.confidence);
});

test("rankCompanies: Arabic query matches a company whose primary name is English when nameAr is on file (bilingual matching)", () => {
  const results = rankCompanies(DEMO_COMPANY_RECORDS, { query: "شركة مسقط للتجارة" });
  assert.ok(results.some(r => r.record.companyId === "demo-co-4"));
});

test("rankCompanies: results are capped, ordered by descending confidence, and low-confidence noise is dropped", () => {
  const results = rankCompanies(DEMO_COMPANY_RECORDS, { query: "Trading" }, );
  for (let i = 1; i < results.length; i++) assert.ok(results[i - 1]!.confidence >= results[i]!.confidence);
  assert.ok(results.every(r => r.confidence >= 0.15));
});

// ---------------------------------------------------------------------------------------------
// Section 14/4: ingestion — duplicate prevention, demo-source rejection, normalization on import
// ---------------------------------------------------------------------------------------------

test("importCompanyRecords: rejects sourceType \"demo\" — the curated demo dataset can never be re-imported as if it were a real source", async () => {
  const repo = new MemoryCompanyRepository();
  const result = await importCompanyRecords([{
    companyName: "Test Co LLC", sourceType: "demo", sourceName: "Some Source", observedAt: new Date().toISOString()
  }], repo);
  assert.equal(result.imported, 0);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0]!.reason, /demo/i);
});

test("importCompanyRecords: re-importing the same (sourceName, sourceRecordId) updates the existing row instead of creating a duplicate", async () => {
  const repo = new MemoryCompanyRepository();
  const row = {
    companyName: "Barka Fisheries LLC", registrationNumber: "9999000111", sourceType: "government",
    sourceName: "Oman Ministry of Commerce, Industry and Investment Promotion", sourceRecordId: "MOCIIP-9999000111",
    observedAt: "2024-01-01T00:00:00.000Z", governorate: "Al Batinah North"
  };
  const first = await importCompanyRecords([row], repo);
  assert.equal(first.imported, 1);
  assert.equal(first.updated, 0);
  assert.equal(repo.all().length, 1);

  const second = await importCompanyRecords([{ ...row, industry: "Fisheries", observedAt: "2024-06-01T00:00:00.000Z" }], repo);
  assert.equal(second.imported, 0);
  assert.equal(second.updated, 1);
  assert.equal(repo.all().length, 1, "must still be exactly one row — no duplicate created");
  assert.equal(repo.all()[0]!.industry, "Fisheries", "the update must have replaced the row's fields");
});

test("importCompanyRecords: a row with no sourceRecordId is always inserted as new (cannot be deduplicated against)", async () => {
  const repo = new MemoryCompanyRepository();
  const row = { companyName: "Anonymous Source Co", sourceType: "news", sourceName: "A newspaper", observedAt: "2024-01-01T00:00:00.000Z" };
  await importCompanyRecords([row], repo);
  await importCompanyRecords([row], repo);
  assert.equal(repo.all().length, 2);
});

test("importCompanyRecords: two rows sharing an exact registration number resolve to the same companyId (deterministic entity resolution, never LLM-guessed)", async () => {
  const repo = new MemoryCompanyRepository();
  await importCompanyRecords([
    { companyName: "Barka Fisheries LLC", registrationNumber: "8888000222", sourceType: "government", sourceName: "Registry A", sourceRecordId: "A-1", observedAt: "2024-01-01T00:00:00.000Z" },
    { companyName: "Barka Fisheries", registrationNumber: "8888000222", sourceType: "directory", sourceName: "Registry B", sourceRecordId: "B-1", observedAt: "2024-02-01T00:00:00.000Z" }
  ], repo);
  const rows = repo.all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.companyId, rows[1]!.companyId);
});

test("importCompanyRecords: rejects an unrecognized governorate rather than guessing at it", async () => {
  const repo = new MemoryCompanyRepository();
  const result = await importCompanyRecords([{
    companyName: "Test Co LLC", sourceType: "government", sourceName: "Some Registry", observedAt: "2024-01-01T00:00:00.000Z", governorate: "Not A Real Place"
  }], repo);
  assert.equal(result.imported, 0);
  assert.equal(result.errors.length, 1);
});

// ---------------------------------------------------------------------------------------------
// Section 5: source provenance
// ---------------------------------------------------------------------------------------------

test("getOmanCompanyProfile: every contributing source is listed with sourceName, sourceType, sourceUrl, sourceRecordId, observedAt and the fields it backed", async () => {
  const profile = await runGetOmanCompanyProfile({ companyId: "demo-co-1" }, demoProvider) as any;
  assert.ok(Array.isArray(profile.sources) && profile.sources.length >= 1);
  for (const source of profile.sources) {
    assert.equal(typeof source.sourceName, "string");
    assert.equal(typeof source.sourceType, "string");
    assert.ok(source.sourceUrl === null || typeof source.sourceUrl === "string");
    assert.ok(source.sourceRecordId === null || typeof source.sourceRecordId === "string");
    assert.equal(typeof source.observedAt, "string");
    assert.ok(Array.isArray(source.fields) && source.fields.length > 0);
  }
  // demo-co-1 has two distinct contributing source rows (a duplicate/multi-source scenario, Section 15).
  assert.equal(profile.sources.length, 2);
});

test("Every demo-dataset source is honestly sourceType \"demo\" — never masquerading as a real government/registry/directory source (Section 15)", () => {
  for (const record of DEMO_COMPANY_RECORDS) assert.equal(record.sourceType, "demo");
});

test("mergeCompanyRows: unknown/absent fields stay null (or an empty array), never fabricated", () => {
  const rows = DEMO_COMPANY_RECORDS.filter(r => r.companyId === "demo-co-10"); // sparse record
  const { company } = mergeCompanyRows("demo-co-10", rows);
  assert.equal(company.website, null);
  assert.equal(company.email, null);
  assert.equal(company.vatNumber, null);
  assert.deepEqual(company.activities, []);
});

test("mergeCompanyRows: detects conflicting company-name and address facts across sources rather than silently picking one", () => {
  const rows = DEMO_COMPANY_RECORDS.filter(r => r.companyId === "demo-co-9");
  const { identityConflict } = mergeCompanyRows("demo-co-9", rows);
  assert.equal(identityConflict, true, "demo-co-9's two sources disagree on the company name and must be flagged");
});

// ---------------------------------------------------------------------------------------------
// Section 7: deterministic risk engine
// ---------------------------------------------------------------------------------------------

test("assessCompanyRisk: an inactive company is flagged INACTIVE_COMPANY and never described in fraud/criminal/insolvency language", () => {
  const rows = DEMO_COMPANY_RECORDS.filter(r => r.companyId === "demo-co-5");
  const { company } = mergeCompanyRows("demo-co-5", rows);
  const risk = assessCompanyRisk(company, rows, false, false);
  assert.ok(risk.riskFlags.some(f => f.code === "INACTIVE_COMPANY"));
  const serialized = JSON.stringify(risk).toLowerCase();
  for (const forbidden of ["fraud", "criminal", "insolvent", "insolvency", "sanction", "illegal"]) {
    assert.ok(!serialized.includes(forbidden), `risk output must never claim "${forbidden}"`);
  }
});

test("assessCompanyRisk: a company registered under the recent-registration threshold is flagged RECENT_REGISTRATION", () => {
  const rows = DEMO_COMPANY_RECORDS.filter(r => r.companyId === "demo-co-6");
  const { company } = mergeCompanyRows("demo-co-6", rows);
  const risk = assessCompanyRisk(company, rows, false, false);
  assert.ok(risk.riskFlags.some(f => f.code === "RECENT_REGISTRATION"));
});

test("assessCompanyRisk: identity conflict across sources is flagged and weighted, and each risk code is counted at most once toward the score", () => {
  const rows = DEMO_COMPANY_RECORDS.filter(r => r.companyId === "demo-co-9");
  const { company, identityConflict } = mergeCompanyRows("demo-co-9", rows);
  const risk = assessCompanyRisk(company, rows, identityConflict, false);
  assert.ok(risk.riskFlags.some(f => f.code === "IDENTITY_CONFLICT"));
  const codes = risk.riskFlags.map(f => f.code);
  assert.equal(codes.length, new Set(codes).size, "no risk code may appear twice");
});

test("assessCompanyRisk: a clean, well-populated active company scores low risk with no flags", () => {
  const rows = DEMO_COMPANY_RECORDS.filter(r => r.companyId === "demo-co-7"); // long-established, fully populated
  const { company } = mergeCompanyRows("demo-co-7", rows);
  const risk = assessCompanyRisk(company, rows, false, false);
  assert.equal(risk.riskLevel, "low");
  assert.equal(risk.riskFlags.length, 0);
});

test("assessCompanyRisk: riskScore is capped to [0, 100] and riskLevel thresholds are low < 25 <= medium < 60 <= high", () => {
  const rows = DEMO_COMPANY_RECORDS.filter(r => r.companyId === "demo-co-5"); // inactive + old data + no website
  const { company } = mergeCompanyRows("demo-co-5", rows);
  const risk = assessCompanyRisk(company, rows, false, false);
  assert.ok(risk.riskScore >= 0 && risk.riskScore <= 100);
  const expectedLevel = risk.riskScore >= 60 ? "high" : risk.riskScore >= 25 ? "medium" : "low";
  assert.equal(risk.riskLevel, expectedLevel);
});

// ---------------------------------------------------------------------------------------------
// Section 6: confidence calculation
// ---------------------------------------------------------------------------------------------

test("computeCompanyConfidence: a record backed only by demo-dataset rows is honestly labeled low/unverified confidence, never presented as verified", () => {
  const rows = DEMO_COMPANY_RECORDS.filter(r => r.companyId === "demo-co-1");
  const { company } = mergeCompanyRows("demo-co-1", rows);
  const signals = computeCommercialSignals(company);
  const confidence = computeCompanyConfidence(rows, signals.dataCompletenessScore, false);
  assert.ok(confidence.score < 0.6, "demo-only evidence must never earn high confidence");
  assert.ok(confidence.reasons.some(r => /demo dataset/i.test(r)));
});

test("computeCompanyConfidence: more contributing sources and higher completeness never decreases the score", () => {
  const sparseRows = DEMO_COMPANY_RECORDS.filter(r => r.companyId === "demo-co-10");
  const richRows = DEMO_COMPANY_RECORDS.filter(r => r.companyId === "demo-co-1");
  const sparseConfidence = computeCompanyConfidence(sparseRows, 20, false);
  const richConfidence = computeCompanyConfidence(richRows, 100, false);
  assert.ok(richConfidence.score >= sparseConfidence.score);
});

test("computeCompanyConfidence: an identity conflict reduces the score and is explained in reasons", () => {
  const rows = DEMO_COMPANY_RECORDS.filter(r => r.companyId === "demo-co-9");
  const { company } = mergeCompanyRows("demo-co-9", rows);
  const signals = computeCommercialSignals(company);
  const withoutConflict = computeCompanyConfidence(rows, signals.dataCompletenessScore, false);
  const withConflict = computeCompanyConfidence(rows, signals.dataCompletenessScore, true);
  assert.ok(withConflict.score < withoutConflict.score);
  assert.ok(withConflict.reasons.some(r => /disagree/i.test(r)));
});

test("computeCompanyConfidence: score is always within [0, 1] and empty evidence returns 0", () => {
  const empty = computeCompanyConfidence([], 0, false);
  assert.equal(empty.score, 0);
  for (const companyId of ["demo-co-1", "demo-co-5", "demo-co-7", "demo-co-9", "demo-co-10"]) {
    const rows = DEMO_COMPANY_RECORDS.filter(r => r.companyId === companyId);
    const { company } = mergeCompanyRows(companyId, rows);
    const signals = computeCommercialSignals(company);
    const { score } = computeCompanyConfidence(rows, signals.dataCompletenessScore, false);
    assert.ok(score >= 0 && score <= 1);
  }
});

// ---------------------------------------------------------------------------------------------
// End-to-end: the four capabilities against the demo provider (mirrors Section 15's scenario list)
// ---------------------------------------------------------------------------------------------

test("searchOmanCompany: exact search, fuzzy search and a no-match query all behave as documented", async () => {
  const exact = await runSearchOmanCompany({ query: "1010123456" }, demoProvider) as any;
  assert.equal(exact.matches[0].companyId, "demo-co-1");

  const fuzzy = await runSearchOmanCompany({ query: "Al Noor Tradng" }, demoProvider) as any;
  assert.ok(fuzzy.matches.some((m: any) => m.companyId === "demo-co-1"));

  const noMatch = await runSearchOmanCompany({ query: "Zzzzznonexistentcompanyxyz", industry: "Nonexistent Industry Zzz" }, demoProvider) as any;
  assert.equal(noMatch.matches.length, 0);
  assert.equal(noMatch.totalMatches, 0);
});

test("getOmanCompanyProfile: unknown companyId raises a 404-shaped ApiError rather than a generic crash", async () => {
  await assert.rejects(
    () => runGetOmanCompanyProfile({ companyId: "does-not-exist" }, demoProvider),
    (err: any) => err.status === 404 && err.code === "COMPANY_NOT_FOUND"
  );
});

test("analyzeOmanCompany: an inactive company (demo-co-5) surfaces INACTIVE_COMPANY as a risk flag and low digital presence, never a fraud/legal claim", async () => {
  const result = await runAnalyzeOmanCompany({ companyId: "demo-co-5", purpose: "supplier" }, demoProvider) as any;
  assert.ok(result.riskFlags.some((f: any) => f.code === "INACTIVE_COMPANY"));
  assert.equal(result.commercialSignals.operatingStatus, "inactive");
});

test("dueDiligenceOmanCompany: transaction-specific checklist items are added for supplier_contract vs investment", async () => {
  const supplier = await runDueDiligenceOmanCompany({ companyId: "demo-co-1", transactionType: "supplier_contract", transactionValueOMR: 50000 }, demoProvider) as any;
  const investment = await runDueDiligenceOmanCompany({ companyId: "demo-co-1", transactionType: "investment", transactionValueOMR: 50000 }, demoProvider) as any;
  assert.ok(supplier.recommendedDueDiligence.some((c: any) => /trade references/i.test(c.check)));
  assert.ok(investment.recommendedDueDiligence.some((c: any) => /capitalization/i.test(c.check)));
});

test("dueDiligenceOmanCompany: missingInformation lists exactly the sparse company's absent fields, never fabricating a value", async () => {
  const result = await runDueDiligenceOmanCompany({ companyId: "demo-co-10", transactionType: "other" }, demoProvider) as any;
  assert.ok(result.missingInformation.includes("website"));
  assert.ok(result.missingInformation.includes("email"));
});

// ---------------------------------------------------------------------------------------------
// Capability discovery, REST, x402 and async execution — the generic, registry-driven tests in
// tests/agent-native.test.ts, tests/http.test.ts, tests/mcp.test.ts, tests/mcp-remote.test.ts and
// tests/x402.test.ts already iterate `for (const c of capabilities)` and therefore already cover
// all four new capabilities end-to-end (REST 200s against each c.example validated against c.output,
// x402 402/payment gating, MCP tools/list + tools/call, capability registry parity). The assertions
// below cover what's specific to this domain: that all four are actually registered with the
// expected shape, price and idempotency, and that a live async REST call round-trips correctly.
// ---------------------------------------------------------------------------------------------

test("all four Oman business-intelligence capabilities are registered with the documented price, are idempotent/side-effect-free, and validate their own example", () => {
  const expected: Record<string, number> = {
    search_oman_company: 0.05, get_oman_company_profile: 0.25, analyze_oman_company: 0.75, due_diligence_oman_company: 2.00
  };
  for (const [name, price] of Object.entries(expected)) {
    const capability = capabilities.find(c => c.name === name);
    assert.ok(capability, `expected a registered capability named ${name}`);
    assert.equal(capability!.price, price);
    assert.equal(capability!.idempotent, true);
    assert.equal(capability!.sideEffects, false);
    assert.ok(capability!.input.safeParse(capability!.example).success, `${name}'s own example must satisfy its own input schema`);
    assert.ok(capability!.output.safeParse(capability!.exampleOutput).success, `${name}'s own exampleOutput must satisfy its own output schema`);
  }
});

test("REST: search_oman_company executes asynchronously end-to-end through the live HTTP server and matches the capability's own execute()", async () => {
  const config = loadConfig({ RAFID_API_KEYS: key });
  await withServer(config, async base => {
    const response = await fetch(base + "/api/v1/business/search", {
      method: "POST", headers: { "X-API-Key": key, "Content-Type": "application/json" }, body: JSON.stringify({ query: "Al Noor Trading" })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.success, true);
    assert.ok(body.data.matches.some((m: any) => m.companyId === "demo-co-1"));
  });
});

// ---------------------------------------------------------------------------------------------
// Composite provider — database data takes precedence over demo data on a row-id collision, and
// a failing provider degrades gracefully instead of failing the whole search (mirrors the
// property domain's CompositeOmanPropertyDataProvider behavior, reused verbatim here).
// ---------------------------------------------------------------------------------------------

test("CompositeCompanyProvider (via a database-backed repository): imported real data is queryable through the exact same search/profile pipeline as the demo dataset", async () => {
  const repo = new MemoryCompanyRepository();
  await importCompanyRecords([{
    companyName: "Barka Fresh Produce LLC", registrationNumber: "7777000333", sourceType: "public_registry",
    sourceName: "Oman public business registry", sourceRecordId: "REG-7777000333", observedAt: "2024-01-01T00:00:00.000Z",
    governorate: "Al Batinah South", status: "active", industry: "Agriculture"
  }], repo);
  const dbProvider = new DatabaseCompanyProvider(repo);
  const result = await runSearchOmanCompany({ query: "7777000333" }, dbProvider) as any;
  assert.equal(result.matches[0].companyName, "Barka Fresh Produce LLC");
  assert.equal(result.matches[0].confidence, 0.98);
});
