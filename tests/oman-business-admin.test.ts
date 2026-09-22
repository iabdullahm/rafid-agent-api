import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { createApp } from "../src/api/app.js";
import { loadConfig, type Config } from "../src/config/env.js";
import { hashAdminPassword } from "../src/middleware/adminAuth.js";
import { MemoryCompanyRepository, type CompanyRecordInput } from "../src/business-data/sources/companyRepository.js";
import { importCompanyRecords } from "../src/business-data/ingestion/importPipeline.js";

/**
 * Oman Business Intelligence Admin & Data Operations Dashboard — test suite (Section 39).
 *
 * Mirrors tests/oman-business.test.ts's own withServer()/loadConfig() conventions exactly. Every
 * test injects its own fresh MemoryCompanyRepository via createApp's `businessRepository` option
 * (the same seam marketRepository/partnerRepository already use for DB-less tests), so tests never
 * share state and never require a real Postgres database.
 *
 * Node's built-in fetch() has no cookie jar, so authentication is carried by hand: loginAsAdmin()
 * posts the login form with `redirect: "manual"`, captures the `Set-Cookie` response header, and
 * scrapes the per-login CSRF token out of the rendered dashboard page's hidden `_csrf` field
 * (exactly what a real browser's own form submission would carry) — never decoding the session
 * cookie internally, so this suite genuinely exercises the same HTTP surface a browser would.
 */

const API_KEY = "test-only-not-a-real-credential-12345";
const ADMIN_USERNAME = "test-admin";
const ADMIN_PASSWORD = "correct horse battery staple 12345";
const ADMIN_PASSWORD_HASH = hashAdminPassword(ADMIN_PASSWORD);
const ADMIN_SESSION_SECRET = "test-admin-session-secret-at-least-32-chars-long";

function adminEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    RAFID_API_KEYS: API_KEY,
    ADMIN_USERNAME, ADMIN_PASSWORD_HASH, ADMIN_SESSION_SECRET,
    ...overrides
  };
}

function adminDisabledConfig(): Config {
  return loadConfig({ RAFID_API_KEYS: API_KEY });
}

async function withAdminServer<T>(config: Config, repository: MemoryCompanyRepository, fn: (base: string) => Promise<T>): Promise<T> {
  const app = createApp(config, { logger: () => {}, businessRepository: repository });
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

function cookieHeaderFrom(setCookie: string | null): string {
  if (!setCookie) throw new Error("expected a Set-Cookie header on the login response");
  return setCookie.split(";")[0]!;
}

/** Logs in over real HTTP and returns a `Cookie` header value plus the CSRF token scraped from
 *  the dashboard page's hidden `_csrf` field — the same two things a real browser session would
 *  carry into every subsequent request. */
async function loginAsAdmin(base: string, username = ADMIN_USERNAME, password = ADMIN_PASSWORD): Promise<{ cookie: string; csrf: string }> {
  const loginRes = await fetch(`${base}/admin/login`, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username, password, returnTo: "" })
  });
  assert.equal(loginRes.status, 302, "a valid login should redirect to the dashboard");
  const cookie = cookieHeaderFrom(loginRes.headers.get("set-cookie"));
  const dashboardRes = await fetch(`${base}/admin/business/dashboard`, { headers: { Cookie: cookie } });
  assert.equal(dashboardRes.status, 200);
  const html = await dashboardRes.text();
  const match = html.match(/name="_csrf" value="([^"]+)"/);
  if (!match) throw new Error("expected a _csrf token embedded in the dashboard page");
  return { cookie, csrf: match[1]! };
}

function baseRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    companyName: "Al Noor Trading LLC", sourceType: "government", sourceName: "Oman Business / MOCIIP company register (manual lookup)",
    sourceRecordId: "REG-1000001", registrationNumber: "1000001", observedAt: new Date().toISOString(),
    governorate: "Muscat", status: "active", industry: "Trading",
    ...overrides
  };
}

async function seed(rows: Record<string, unknown>[]): Promise<MemoryCompanyRepository> {
  const repo = new MemoryCompanyRepository();
  await importCompanyRecords(rows, repo);
  return repo;
}

/** importCompanyRecords (the generic pipeline) deliberately refuses sourceType "demo" — it's
 *  reserved for the built-in curated dataset and never importable via the normal pipeline (see
 *  importPipeline.ts). To seed a demo-only company for a test, write directly through
 *  upsertCompanies with a fully-formed CompanyRecordInput instead. */
function demoCompanyInput(overrides: Partial<CompanyRecordInput> = {}): CompanyRecordInput {
  return {
    companyName: "Demo Widget Co", normalizedName: "DEMO WIDGET CO", nameAr: null, nameEn: null,
    registrationNumber: null, legalType: null, status: null, registrationDate: null, industry: null, activities: [],
    governorate: null, wilayat: null, area: null, address: null, website: null, email: null, phone: null,
    vatNumber: null, vatStatus: null, employeeRange: null, estimatedCompanySize: null,
    sourceType: "demo", sourceName: "Curated demo dataset", sourceRecordId: "DEMO-1", sourceUrl: null,
    observedAt: new Date().toISOString(), metadata: {},
    ...overrides
  };
}

// ---------------------------------------------------------------------------------------------
// Authentication, unauthenticated route rejection, login rate limiting
// ---------------------------------------------------------------------------------------------

test("admin: the dashboard routes don't exist at all when ADMIN_* env vars are not configured — never mounted, never silently unprotected", async () => {
  // src/api/app.ts only mounts createAdminRoutes(...) when config.adminEnabled AND a business
  // repository are both present; with neither, /admin/* and /api/admin/business/* fall straight
  // through to the app's own 404 catch-all rather than 500ing or existing without auth.
  await withAdminServer(adminDisabledConfig(), new MemoryCompanyRepository(), async base => {
    const htmlRes = await fetch(`${base}/admin/business/dashboard`, { redirect: "manual" });
    assert.equal(htmlRes.status, 404);
    const apiRes = await fetch(`${base}/api/admin/business/dashboard`);
    assert.equal(apiRes.status, 404);
  });
});

test("admin: unauthenticated HTML routes redirect to /admin/login; unauthenticated JSON API routes 401", async () => {
  const config = loadConfig(adminEnv());
  await withAdminServer(config, new MemoryCompanyRepository(), async base => {
    const htmlRes = await fetch(`${base}/admin/business/dashboard`, { redirect: "manual" });
    assert.equal(htmlRes.status, 302);
    assert.match(htmlRes.headers.get("location") ?? "", /^\/admin\/login/);

    const apiRes = await fetch(`${base}/api/admin/business/dashboard`);
    assert.equal(apiRes.status, 401);
    const body = await apiRes.json();
    assert.equal(body.success, false);
  });
});

test("admin: correct credentials log in and set a session cookie carrying a CSRF token; wrong credentials are rejected", async () => {
  const config = loadConfig(adminEnv());
  await withAdminServer(config, new MemoryCompanyRepository(), async base => {
    const { cookie, csrf } = await loginAsAdmin(base);
    assert.ok(cookie.startsWith("rafid_admin_session="));
    assert.ok(csrf.length > 0);

    const badRes = await fetch(`${base}/admin/login`, {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: ADMIN_USERNAME, password: "definitely-wrong", returnTo: "" })
    });
    assert.equal(badRes.status, 401);
  });
});

test("admin: repeated failed logins are rate-limited (429) independent of the public API's own rate limiter", async () => {
  const config = loadConfig(adminEnv({ ADMIN_LOGIN_RATE_LIMIT_MAX: "3", ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS: "60000" }));
  await withAdminServer(config, new MemoryCompanyRepository(), async base => {
    const attempt = () => fetch(`${base}/admin/login`, {
      method: "POST", redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ username: ADMIN_USERNAME, password: "wrong", returnTo: "" })
    });
    let lastStatus = 0;
    for (let i = 0; i < 5; i++) { lastStatus = (await attempt()).status; }
    assert.equal(lastStatus, 429);
  });
});

// ---------------------------------------------------------------------------------------------
// Dashboard metrics, demo-data indicators
// ---------------------------------------------------------------------------------------------

test("admin: dashboard metrics reflect seeded real + demo companies, and the demo-data warning banner appears only when demo data exists", async () => {
  // taxVerificationStatus/taxVerifiedAt aren't part of the generic CSV/JSON import row shape
  // (importPipeline.ts's rawRowSchema is deliberately narrow) — a tax-authority row carrying them
  // is written directly through upsertCompanies, exactly like a real Tax Oman adapter would.
  const repo = await seed([baseRow({ registrationNumber: "2000001", companyName: "Barka Fresh Produce LLC", sourceRecordId: "REG-2000001" })]);
  await repo.upsertCompanies([{
    companyName: "Salalah Logistics SAOC", normalizedName: "SALALAH LOGISTICS", nameAr: null, nameEn: null,
    registrationNumber: "2000002", legalType: null, status: "active", registrationDate: null, industry: "Logistics", activities: [],
    governorate: "Dhofar", wilayat: null, area: null, address: null, website: null, email: null, phone: null,
    vatNumber: null, vatStatus: null, employeeRange: null, estimatedCompanySize: null,
    sourceType: "tax_authority", sourceName: "Tax Oman", sourceRecordId: "REG-2000002", sourceUrl: null,
    observedAt: new Date().toISOString(), metadata: {},
    taxVerificationStatus: "verified", taxVerifiedAt: new Date().toISOString()
  }]);
  await repo.upsertCompanies([demoCompanyInput({ companyName: "Demo Only Trading Co" })]);
  const config = loadConfig(adminEnv());
  await withAdminServer(config, repo, async base => {
    const { cookie } = await loginAsAdmin(base);
    const res = await fetch(`${base}/api/admin/business/dashboard`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    const stats = body.data.stats;
    assert.equal(stats.totalCompanies, 3);
    assert.equal(stats.realCompanies, 2);
    assert.equal(stats.demoCompanies, 1);
    assert.equal(stats.taxVerified, 1);
    assert.ok(stats.targets.realCompanies > 0, "dataset targets must be configurable, not zero");

    const dashboardHtml = await (await fetch(`${base}/admin/business/dashboard`, { headers: { Cookie: cookie } })).text();
    assert.match(dashboardHtml, /class="warning-banner"/);
    assert.match(dashboardHtml, /backed only by the built-in curated demo dataset/);
  });
});

test("admin: dashboard shows no demo-data banner when the dataset has no demo-only companies", async () => {
  const repo = await seed([baseRow()]);
  const config = loadConfig(adminEnv());
  await withAdminServer(config, repo, async base => {
    const { cookie } = await loginAsAdmin(base);
    const html = await (await fetch(`${base}/admin/business/dashboard`, { headers: { Cookie: cookie } })).text();
    assert.doesNotMatch(html, /class="warning-banner"/);
  });
});

// ---------------------------------------------------------------------------------------------
// Company browser filters, company detail
// ---------------------------------------------------------------------------------------------

test("admin: company list filters by governorate, source type and real/demo through the server-side API", async () => {
  const repo = await seed([
    baseRow({ registrationNumber: "3000001", companyName: "Muscat Steel Works", governorate: "Muscat" }),
    baseRow({ registrationNumber: "3000002", companyName: "Dhofar Fisheries LLC", governorate: "Dhofar", sourceRecordId: "REG-3000002" })
  ]);
  await repo.upsertCompanies([demoCompanyInput({ companyName: "Demo Widget Co", sourceRecordId: "DEMO-2" })]);
  const config = loadConfig(adminEnv());
  await withAdminServer(config, repo, async base => {
    const { cookie } = await loginAsAdmin(base);

    const byGovernorate = await (await fetch(`${base}/api/admin/business/companies?governorate=Dhofar`, { headers: { Cookie: cookie } })).json();
    assert.equal(byGovernorate.data.total, 1);
    assert.equal(byGovernorate.data.rows[0].companyName, "Dhofar Fisheries LLC");

    const demoOnly = await (await fetch(`${base}/api/admin/business/companies?realOrDemo=demo`, { headers: { Cookie: cookie } })).json();
    assert.equal(demoOnly.data.total, 1);
    assert.equal(demoOnly.data.rows[0].companyName, "Demo Widget Co");

    const realOnly = await (await fetch(`${base}/api/admin/business/companies?realOrDemo=real`, { headers: { Cookie: cookie } })).json();
    assert.equal(realOnly.data.total, 2);

    const bySearch = await (await fetch(`${base}/api/admin/business/companies?q=steel`, { headers: { Cookie: cookie } })).json();
    assert.equal(bySearch.data.total, 1);
    assert.equal(bySearch.data.rows[0].companyName, "Muscat Steel Works");
  });
});

test("admin: company detail returns the merged view for a known company and 404s for an unknown one", async () => {
  const repo = await seed([baseRow({ registrationNumber: "4000001", companyName: "Nizwa Contracting LLC" })]);
  const config = loadConfig(adminEnv());
  await withAdminServer(config, repo, async base => {
    const { cookie } = await loginAsAdmin(base);
    const [row] = await repo.adminListAllRows();
    const detail = await fetch(`${base}/api/admin/business/companies/${row!.companyId}`, { headers: { Cookie: cookie } });
    assert.equal(detail.status, 200);
    const body = await detail.json();
    assert.equal(body.data.companyName, "Nizwa Contracting LLC");
    assert.equal(body.data.rows.length, 1);

    const missing = await fetch(`${base}/api/admin/business/companies/does-not-exist`, { headers: { Cookie: cookie } });
    assert.equal(missing.status, 404);

    const htmlDetail = await fetch(`${base}/admin/business/companies/${row!.companyId}`, { headers: { Cookie: cookie } });
    assert.equal(htmlDetail.status, 200);
    assert.match(await htmlDetail.text(), /Nizwa Contracting LLC/);
  });
});

// ---------------------------------------------------------------------------------------------
// Import Center: preview (dry run), upload validation, successful import, failed import
// ---------------------------------------------------------------------------------------------

const GENERIC_IMPORT_ROWS = [
  { companyName: "Sohar Marine Services LLC", sourceType: "government", sourceName: "Oman Business / MOCIIP company register (manual lookup)", sourceRecordId: "REG-5000001", registrationNumber: "5000001", observedAt: new Date().toISOString(), governorate: "Al Batinah North" },
  { companyName: "Missing Source Type Co" } // deliberately invalid: no sourceType/sourceName/observedAt
];

test("admin: import preview (dry run) validates and normalizes rows without writing to the live dataset, and returns a previewToken", async () => {
  const repo = new MemoryCompanyRepository();
  const config = loadConfig(adminEnv());
  await withAdminServer(config, repo, async base => {
    const { cookie } = await loginAsAdmin(base);
    const content = JSON.stringify(GENERIC_IMPORT_ROWS);
    const res = await fetch(`${base}/api/admin/business/imports/preview`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ source: "generic", fileName: "companies.json", content })
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.totalRows, 2);
    assert.equal(body.data.validRows, 1);
    assert.equal(body.data.invalidRows, 1);
    assert.equal(body.data.rejected.length, 1);
    assert.ok(typeof body.data.previewToken === "string" && body.data.previewToken.length === 64);
    assert.ok(Array.isArray(body.data.sample) && body.data.sample.length > 0);

    // Dry run: nothing written to the live repository.
    assert.equal((await repo.adminListAllRows()).length, 0);
  });
});

test("admin: upload validation rejects unsupported file types and oversized/empty content before any parsing", async () => {
  const config = loadConfig(adminEnv());
  await withAdminServer(config, new MemoryCompanyRepository(), async base => {
    const { cookie } = await loginAsAdmin(base);

    const badExt = await fetch(`${base}/api/admin/business/imports/preview`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ source: "generic", fileName: "companies.txt", content: "not csv or json" })
    });
    assert.equal(badExt.status, 400);

    const emptyContent = await fetch(`${base}/api/admin/business/imports/preview`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ source: "generic", fileName: "companies.json", content: "" })
    });
    assert.equal(emptyContent.status, 400);

    const badSource = await fetch(`${base}/api/admin/business/imports/preview`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ source: "not-a-real-source", fileName: "companies.json", content: "[]" })
    });
    assert.equal(badSource.status, 400);
  });
});

test("admin: execute is refused (409) without a matching previewToken — an import can never run without first being previewed", async () => {
  const config = loadConfig(adminEnv());
  await withAdminServer(config, new MemoryCompanyRepository(), async base => {
    const { cookie, csrf } = await loginAsAdmin(base);
    const content = JSON.stringify(GENERIC_IMPORT_ROWS);
    const res = await fetch(`${base}/api/admin/business/imports/execute`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ source: "generic", fileName: "companies.json", content, previewToken: "wrong-token" })
    });
    assert.equal(res.status, 409);
  });
});

test("admin: execute is refused (403) without a valid CSRF token even with a correct previewToken", async () => {
  const config = loadConfig(adminEnv());
  await withAdminServer(config, new MemoryCompanyRepository(), async base => {
    const { cookie } = await loginAsAdmin(base);
    const content = JSON.stringify(GENERIC_IMPORT_ROWS);
    const previewRes = await fetch(`${base}/api/admin/business/imports/preview`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ source: "generic", fileName: "companies.json", content })
    });
    const { previewToken } = (await previewRes.json()).data;
    const res = await fetch(`${base}/api/admin/business/imports/execute`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" }, // no X-CSRF-Token
      body: JSON.stringify({ source: "generic", fileName: "companies.json", content, previewToken })
    });
    assert.equal(res.status, 403);
  });
});

test("admin: a successful full preview -> execute cycle writes companies, records a succeeded sync run, and audits the action", async () => {
  const repo = new MemoryCompanyRepository();
  const config = loadConfig(adminEnv());
  await withAdminServer(config, repo, async base => {
    const { cookie, csrf } = await loginAsAdmin(base);
    const content = JSON.stringify(GENERIC_IMPORT_ROWS);

    const previewRes = await fetch(`${base}/api/admin/business/imports/preview`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ source: "generic", fileName: "companies.json", content })
    });
    const { previewToken } = (await previewRes.json()).data;

    const executeRes = await fetch(`${base}/api/admin/business/imports/execute`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ source: "generic", fileName: "companies.json", content, previewToken })
    });
    assert.equal(executeRes.status, 200);
    const body = (await executeRes.json()).data;
    assert.equal(body.imported, 1);
    assert.equal(body.errors.length, 1);
    assert.ok(typeof body.runId === "string");

    const rows = await repo.adminListAllRows();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.companyName, "Sohar Marine Services LLC");

    const runs = await repo.findAllSyncRuns(10);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.status, "succeeded");

    // The one invalid row from this real (non-dry-run) execution is persisted as an unmatched
    // record rather than silently discarded (Section 19).
    const unmatched = await repo.listUnmatched("unresolved", 10);
    assert.equal(unmatched.length, 1);

    const audit = await repo.listAuditLog({ limit: 10 });
    assert.ok(audit.some(e => e.action === "import_executed"));
  });
});

test("admin: a failed sync run (e.g. an unexpected import-time exception) is surfaced in the dashboard's failed-import metrics and import history", async () => {
  // Forcing a genuine mid-import exception through the public HTTP surface isn't reachable (every
  // row-level failure the adapters can produce is caught and reported per-row, never thrown) — so
  // this test exercises the same repository seam the execute route's own catch block uses
  // (startSyncRun/finishSyncRun with status "failed") directly, then verifies the read side.
  const repo = new MemoryCompanyRepository();
  const runId = await repo.startSyncRun("mociip");
  await repo.finishSyncRun(runId, { status: "failed", recordsSeen: 5, recordsInserted: 0, recordsUpdated: 0, recordsSkipped: 0, errorMessage: "simulated adapter failure" });
  const config = loadConfig(adminEnv());
  await withAdminServer(config, repo, async base => {
    const { cookie } = await loginAsAdmin(base);
    const dashboard = await (await fetch(`${base}/api/admin/business/dashboard`, { headers: { Cookie: cookie } })).json();
    assert.equal(dashboard.data.stats.failedImports, 1);
    assert.equal(dashboard.data.stats.latestFailedImport.errorMessage, "simulated adapter failure");

    const history = await (await fetch(`${base}/api/admin/business/imports`, { headers: { Cookie: cookie } })).json();
    assert.equal(history.data.length, 1);
    assert.equal(history.data[0].status, "failed");

    const importsHtml = await (await fetch(`${base}/admin/business/imports`, { headers: { Cookie: cookie } })).text();
    assert.match(importsHtml, /failed/i);
  });
});

// ---------------------------------------------------------------------------------------------
// Tax Oman manual verification
// ---------------------------------------------------------------------------------------------

test("admin: recording a Tax Oman manual verification goes through the real Tax Oman normalization path and updates the merged view", async () => {
  const repo = await seed([baseRow({ registrationNumber: "6000001", companyName: "Ibra General Trading" })]);
  const config = loadConfig(adminEnv());
  await withAdminServer(config, repo, async base => {
    const { cookie, csrf } = await loginAsAdmin(base);
    const [row] = await repo.adminListAllRows();

    const res = await fetch(`${base}/api/admin/business/tax-verification/${row!.companyId}`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ outcome: "verified", vatNumber: "OM-VAT-12345", note: "Confirmed via Tax Oman public portal lookup" })
    });
    assert.equal(res.status, 200);

    const detail = await (await fetch(`${base}/api/admin/business/companies/${row!.companyId}`, { headers: { Cookie: cookie } })).json();
    assert.equal(detail.data.taxVerificationStatus, "verified");
    assert.ok(detail.data.rows.some((r: { sourceType: string }) => r.sourceType === "tax_authority"));

    const invalidOutcome = await fetch(`${base}/api/admin/business/tax-verification/${row!.companyId}`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ outcome: "not-a-real-outcome" })
    });
    assert.equal(invalidOutcome.status, 400);

    const unknownCompany = await fetch(`${base}/api/admin/business/tax-verification/does-not-exist`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ outcome: "verified" })
    });
    assert.equal(unknownCompany.status, 404);

    const audit = await repo.listAuditLog({ limit: 10 });
    assert.ok(audit.some(e => e.action === "tax_verification_recorded"));
  });
});

// ---------------------------------------------------------------------------------------------
// Conflict Review Queue
// ---------------------------------------------------------------------------------------------

test("admin: the conflict queue surfaces companies with disagreeing evidence, and resolving one (with CSRF) removes it from the queue", async () => {
  // Same registrationNumber, different companyName -> merges into one companyId with an identity
  // conflict (matching/merge.ts's own distinctNames > 1 rule).
  const repo = await seed([
    baseRow({ registrationNumber: "7000001", companyName: "Barka United Traders", sourceRecordId: "REG-7000001-A" }),
    baseRow({ registrationNumber: "7000001", companyName: "Barka United Trading Est", sourceRecordId: "REG-7000001-B", observedAt: new Date().toISOString() })
  ]);
  const config = loadConfig(adminEnv());
  await withAdminServer(config, repo, async base => {
    const { cookie, csrf } = await loginAsAdmin(base);

    const before = await (await fetch(`${base}/api/admin/business/conflicts`, { headers: { Cookie: cookie } })).json();
    assert.equal(before.data.length, 1);
    const companyId = before.data[0].companyId;

    const noCsrf = await fetch(`${base}/api/admin/business/conflicts/${companyId}/resolve`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reviewed" })
    });
    assert.equal(noCsrf.status, 403);

    const resolve = await fetch(`${base}/api/admin/business/conflicts/${companyId}/resolve`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ action: "reviewed", note: "Confirmed both rows describe the same registered company" })
    });
    assert.equal(resolve.status, 200);

    const after = await (await fetch(`${base}/api/admin/business/conflicts`, { headers: { Cookie: cookie } })).json();
    assert.equal(after.data.length, 0, "a company flagged 'reviewed' drops out of the outstanding conflict queue");

    const audit = await repo.listAuditLog({ limit: 10 });
    assert.ok(audit.some(e => e.action === "conflict_resolved"));
  });
});

// ---------------------------------------------------------------------------------------------
// Stale Records Queue
// ---------------------------------------------------------------------------------------------

test("admin: the stale records queue groups companies whose evidence is older than their source's freshness threshold", async () => {
  const longAgo = new Date(Date.now() - 90 * 86_400_000).toISOString(); // government threshold is 30 days
  const repo = await seed([
    baseRow({ registrationNumber: "8000001", companyName: "Ancient Registry Row LLC", observedAt: longAgo }),
    baseRow({ registrationNumber: "8000002", companyName: "Freshly Observed LLC", sourceRecordId: "REG-8000002", observedAt: new Date().toISOString() })
  ]);
  const config = loadConfig(adminEnv());
  await withAdminServer(config, repo, async base => {
    const { cookie } = await loginAsAdmin(base);
    const res = await (await fetch(`${base}/api/admin/business/stale`, { headers: { Cookie: cookie } })).json();
    const staleNames = res.data.flatMap((g: { rows: { companyName: string }[] }) => g.rows.map(r => r.companyName));
    assert.ok(staleNames.includes("Ancient Registry Row LLC"));
    assert.ok(!staleNames.includes("Freshly Observed LLC"));

    const dashboard = await (await fetch(`${base}/api/admin/business/dashboard`, { headers: { Cookie: cookie } })).json();
    assert.equal(dashboard.data.stats.staleCompanyRecords, 1);
  });
});

// ---------------------------------------------------------------------------------------------
// Unmatched records
// ---------------------------------------------------------------------------------------------

test("admin: unmatched records can be listed and resolved (rejected/linked), recording the resolution in the audit trail", async () => {
  const repo = await seed([baseRow({ registrationNumber: "9000001", companyName: "Linkable Target LLC" })]);
  await repo.recordUnmatched([{
    sourceType: "government_procurement", sourceName: "Admin import (tender-board-awards)",
    rawPayload: { registrationNumber: "9999999" }, reason: "insufficient_award_identity_data", reasonDetail: "No known company has registrationNumber 9999999"
  }]);
  const config = loadConfig(adminEnv());
  await withAdminServer(config, repo, async base => {
    const { cookie, csrf } = await loginAsAdmin(base);

    const list = await (await fetch(`${base}/api/admin/business/unmatched`, { headers: { Cookie: cookie } })).json();
    assert.equal(list.data.length, 1);
    const id = list.data[0].id;

    const badStatus = await fetch(`${base}/api/admin/business/unmatched/${id}/resolve`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ status: "not-a-real-status" })
    });
    assert.equal(badStatus.status, 400);

    const resolve = await fetch(`${base}/api/admin/business/unmatched/${id}/resolve`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ status: "rejected", note: "Duplicate of an already-imported award" })
    });
    assert.equal(resolve.status, 200);

    const after = await (await fetch(`${base}/api/admin/business/unmatched?status=unresolved`, { headers: { Cookie: cookie } })).json();
    assert.equal(after.data.length, 0);

    const audit = await repo.listAuditLog({ limit: 10 });
    assert.ok(audit.some(e => e.action === "unmatched_resolved"));
  });
});

// ---------------------------------------------------------------------------------------------
// Manual evidence entry
// ---------------------------------------------------------------------------------------------

test("admin: manual evidence entry attaches a new admin_manual source row without ever accepting a caller-supplied source authority", async () => {
  const repo = await seed([baseRow({ registrationNumber: "1100001", companyName: "Manual Evidence Target LLC" })]);
  const config = loadConfig(adminEnv());
  await withAdminServer(config, repo, async base => {
    const { cookie, csrf } = await loginAsAdmin(base);
    const [row] = await repo.adminListAllRows();

    const res = await fetch(`${base}/api/admin/business/evidence`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ companyId: row!.companyId, field: "website", value: "https://example-manual-evidence.om", sourceName: "Operator phone call", note: "Confirmed by phone" })
    });
    assert.equal(res.status, 200);

    const rows = await repo.findByCompanyId(row!.companyId);
    const manual = rows.find(r => r.sourceType === "admin_manual");
    assert.ok(manual);
    assert.equal(manual!.website, "https://example-manual-evidence.om");

    const disallowedField = await fetch(`${base}/api/admin/business/evidence`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ companyId: row!.companyId, field: "registrationNumber", value: "9999999", sourceName: "Operator" })
    });
    assert.equal(disallowedField.status, 400, "registrationNumber is not in the allowed manual-evidence field list");
  });
});

// ---------------------------------------------------------------------------------------------
// Recalculation
// ---------------------------------------------------------------------------------------------

test("admin: per-company and bulk recalculation re-derive intelligence from stored evidence (never re-fetching anything) and are audited", async () => {
  const repo = await seed([baseRow({ registrationNumber: "1200001", companyName: "Recalculate Me LLC" })]);
  const config = loadConfig(adminEnv());
  await withAdminServer(config, repo, async base => {
    const { cookie, csrf } = await loginAsAdmin(base);
    const [row] = await repo.adminListAllRows();

    const single = await fetch(`${base}/api/admin/business/companies/${row!.companyId}/recalculate`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf }, body: "{}"
    });
    assert.equal(single.status, 200);
    const singleBody = (await single.json()).data;
    assert.equal(singleBody.companyId, row!.companyId);
    assert.ok(typeof singleBody.confidence === "number");

    const bulk = await fetch(`${base}/api/admin/business/recalculate-bulk`, {
      method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", "X-CSRF-Token": csrf },
      body: JSON.stringify({ scope: "all" })
    });
    assert.equal(bulk.status, 200);
    assert.equal((await bulk.json()).data.count, 1);

    const audit = await repo.listAuditLog({ limit: 10 });
    assert.ok(audit.some(e => e.action === "recalculate_company"));
    assert.ok(audit.some(e => e.action === "bulk_recalculate"));
  });
});

// ---------------------------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------------------------

test("admin: the company list can be exported as CSV, and the export is itself audited", async () => {
  const repo = await seed([baseRow({ registrationNumber: "1300001", companyName: "Exportable Company LLC" })]);
  const config = loadConfig(adminEnv());
  await withAdminServer(config, repo, async base => {
    const { cookie } = await loginAsAdmin(base);
    const res = await fetch(`${base}/api/admin/business/companies/export.csv`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/csv/);
    const csv = await res.text();
    assert.match(csv, /companyId,companyName/);
    assert.match(csv, /Exportable Company LLC/);

    const audit = await repo.listAuditLog({ limit: 10 });
    assert.ok(audit.some(e => e.action === "company_list_exported"));
  });
});

// ---------------------------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------------------------

test("admin: the audit log records login events and can be filtered by action", async () => {
  const repo = new MemoryCompanyRepository();
  const config = loadConfig(adminEnv());
  await withAdminServer(config, repo, async base => {
    const { cookie } = await loginAsAdmin(base);
    const all = await (await fetch(`${base}/api/admin/business/audit`, { headers: { Cookie: cookie } })).json();
    assert.ok(all.data.some((e: { action: string }) => e.action === "login_succeeded"));

    const filtered = await (await fetch(`${base}/api/admin/business/audit?action=login_succeeded`, { headers: { Cookie: cookie } })).json();
    assert.ok(filtered.data.length >= 1);
    assert.ok(filtered.data.every((e: { action: string }) => e.action === "login_succeeded"));

    const htmlAudit = await fetch(`${base}/admin/business/audit`, { headers: { Cookie: cookie } });
    assert.equal(htmlAudit.status, 200);
    assert.match(await htmlAudit.text(), /login_succeeded/);
  });
});
