import assert from "node:assert/strict";
import test from "node:test";
import { capabilities } from "../src/domain/capabilities.js";
import { websiteProjectEstimateInput } from "../src/schemas/websiteEstimateInputs.js";
import { calculateWebsiteProjectEstimate, previewWebsiteProjectEstimate } from "../src/website-estimate/service.js";
import { auditWebsite } from "../src/website-audit/service.js";
import { validateFeedUrl, type HostResolver } from "../src/domain/oman/feedSecurity.js";

const publicResolver: HostResolver = { async resolve() { return ["93.184.216.34"]; } };
const response = (body: string, status = 200, headers: Record<string, string> = { "content-type": "text/html" }) => new Response(body, { status, headers });

test("website project estimate is deterministic and exposes documented factors", () => {
  const input = { projectType: "corporate_website" as const, pages: 12, languages: ["en", "ar"], features: ["cms", "seo"], designComplexity: "custom" as const, integrations: ["crm"], ecommerce: false, deadlineDays: 30, market: "Oman", currency: "OMR" };
  const a = calculateWebsiteProjectEstimate(input); const b = calculateWebsiteProjectEstimate(input);
  assert.deepEqual(a, b); assert.equal(a.estimatedCost.currency, "OMR"); assert.ok(a.riskFlags.includes("ARABIC_RTL_SCOPE")); assert.ok(a.methodology.factors.includes("feature weights"));
});

test("website estimate rejects unrealistic and unknown inputs", () => {
  assert.throws(() => websiteProjectEstimateInput.parse({ projectType: "corporate_website", pages: 501, languages: ["en"] }));
  assert.throws(() => websiteProjectEstimateInput.parse({ projectType: "corporate_website", pages: 1, languages: ["en"], unknown: true }));
});

test("website estimate preview withholds paid breakdown", async () => {
  const preview = await previewWebsiteProjectEstimate({ projectType: "landing_page", pages: 1, languages: ["en"] });
  assert.equal(preview.status, "available"); assert.ok(preview.preview.availableSections?.includes("complexity")); assert.equal("breakdown" in preview.preview, false);
});

test("website audit detects objective HTML and header findings with mocked network", async () => {
  const html = `<!doctype html><html><head><title>Example</title></head><body><h1>Welcome</h1><img src="/hero.jpg"><a href="/about">About</a></body></html>`;
  const seen: string[] = [];
  const result = await auditWebsite({ url: "https://example.test", auditTypes: ["seo", "accessibility", "security", "technical"], maxPages: 2 }, {
    resolver: publicResolver,
    fetchImpl: async (request) => { const url = String(request); seen.push(url); if (url.endsWith("/about")) return response("<html lang='en'><head><title>About</title><meta name='description' content='About'></head><body><h1>About</h1></body></html>"); if (url.endsWith("robots.txt")) return response("User-agent: *", 200, { "content-type": "text/plain" }); if (url.endsWith("sitemap.xml")) return response("<urlset></urlset>", 200, { "content-type": "application/xml" }); return response(html); }
  });
  assert.equal(result.pagesAudited.length, 2); assert.ok(result.accessibilityIssues.some(i => i.issue.includes("alternative text"))); assert.ok(result.seoIssues.some(i => i.issue.includes("description"))); assert.ok(result.securityFindings.some(i => i.issue.includes("Content-Security-Policy"))); assert.ok(seen.some(v => v.endsWith("robots.txt")));
});

test("website audit follows only validated redirects and enforces SSRF protections", async () => {
  await assert.rejects(() => validateFeedUrl("http://127.0.0.1", { resolver: publicResolver }), /not allowed|only https/);
  await assert.rejects(() => validateFeedUrl("https://127.0.0.1", { resolver: publicResolver }), /private|loopback|reserved/);
  await assert.rejects(() => validateFeedUrl("https://internal.example", { resolver: { async resolve() { return ["10.0.0.4"]; } } }), /private/);
  const result = await auditWebsite({ url: "https://example.test", auditTypes: ["technical"], maxPages: 1 }, { resolver: publicResolver, fetchImpl: async (request) => new URL(String(request)).pathname === "/" ? response("", 302, { location: "https://127.0.0.1/private" }) : response("") });
  assert.ok(result.limitations.some(v => v.includes("SSRF protection")));
});

test("website capabilities are registered with requested prices and previews", () => {
  const estimate = capabilities.find(c => c.name === "website_project_estimate"); const audit = capabilities.find(c => c.name === "website_audit");
  assert.ok(estimate && audit); assert.equal(estimate.price, 0.25); assert.equal(audit.price, 0.75); assert.equal(estimate.path, "/websites/project-estimate"); assert.equal(audit.path, "/websites/audit"); assert.equal(typeof estimate.preview, "function"); assert.equal(typeof audit.preview, "function");
});
