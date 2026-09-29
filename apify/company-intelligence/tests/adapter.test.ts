import assert from "node:assert/strict";
import test from "node:test";
import { parseInput, safeError } from "../src/validation.js";
import { run } from "../src/main.js";
import { buildAnalysisInput } from "../src/adapter.js";

const company = { name: "Example Technologies Ltd", domain: "example.com", country: "GB" };

test("analysis adapters send only fields accepted by each strict service schema", () => {
  assert.deepEqual(buildAnalysisInput("company_reputation", { ...company, address: "1 Main Street" }), {
    companyName: "Example Technologies Ltd", domain: "example.com", country: "GB"
  });
  assert.deepEqual(buildAnalysisInput("business_risk", { ...company, address: "1 Main Street" }), {
    companyName: "Example Technologies Ltd", website: "example.com", country: "GB", address: "1 Main Street"
  });
});

test("valid single and batch inputs normalize", () => {
  assert.equal(parseInput({ company }).companies.length, 1);
  assert.equal(parseInput({ company, companies: [] }).companies.length, 1);
  assert.equal(parseInput({ mode: "business_risk", companies: [company, company] }).companies.length, 2);
});

test("Actor-shaped payload validates at the top level", () => {
  const normalized = parseInput({ mode: "company_reputation", company: { name: "Microsoft", domain: "microsoft.com", country: "US" } });
  assert.equal(normalized.companies.length, 1);
  assert.equal(normalized.companies[0]?.name, "Microsoft");
  assert.equal(normalized.companies[0]?.domain, "microsoft.com");
});

test("batch normalization preserves both companies", () => {
  const normalized = parseInput({ mode: "company_reputation", companies: [
    { name: "Microsoft", domain: "microsoft.com", country: "US" },
    { name: "Apple", domain: "apple.com", country: "US" }
  ] });
  assert.equal(normalized.companies.length, 2);
  assert.deepEqual(normalized.companies.map(item => item.name), ["Microsoft", "Apple"]);
});

test("invalid mode, empty input, conflict, malformed identifiers and batch limit fail", () => {
  for (const input of [{ mode: "bad", company }, {}, { company, companies: [company] }, { company: { domain: "localhost" } }, { company: { name: "x" } }]) {
    assert.throws(() => parseInput(input));
  }
  assert.throws(() => parseInput({ companies: Array.from({ length: 101 }, () => company) }));
  assert.throws(() => parseInput({ company, companies: [company] }));
  assert.throws(() => parseInput({ company: { name: "Microsoft", unexpected: true } }));
  assert.throws(() => parseInput({ company: { mode: "company_reputation", company } }));
});

test("routing, one charge per successful result, no charge on failure and partial batch output", async () => {
  const calls: string[] = [], pushed: any[] = [];
  const summary = await run({ mode: "company_reputation", companies: [company, { name: "bad" }] }, {
      analyze: async (mode: string, item: any) => { calls.push(mode); if (item.name === "bad") throw Object.assign(new Error("upstream"), { code: "PROVIDER_UNAVAILABLE" }); return { mode }; },
      charge: async ({ eventName }) => { calls.push(eventName); return { chargedCount: 1 }; },
      pushData: async value => { pushed.push(value); },
      setValue: async () => undefined,
      log: { info: () => undefined, error: () => undefined }
    });
    assert.deepEqual(summary.chargedEvents, { "company-reputation": 1 });
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.failed, 1);
    assert.equal(pushed.length, 2);
    assert.equal(pushed[1].success, false);
    assert.equal(calls.filter(v => v === "company-reputation").length, 1);
});

test("all commercial modes select their event and a denied charge publishes no success", async () => {
  for (const [mode, event] of [["company_basic", "company-basic"], ["company_reputation", "company-reputation"], ["business_risk", "business-risk"]] as const) {
    const charges: string[] = [], items: any[] = [];
    const summary = await run({ mode, company }, {
      analyze: async selected => ({ selected }),
      charge: async ({ eventName }) => { charges.push(eventName); return { chargedCount: 0 }; },
      pushData: async value => { items.push(value); }, setValue: async () => undefined,
      log: { info: () => undefined, error: () => undefined }
    });
    assert.deepEqual(charges, [event]);
    assert.equal(summary.succeeded, 0);
    assert.equal(items[0].success, false);
    assert.match(items[0].error.code, /SPENDING_LIMIT_REACHED|BILLING_NOT_AVAILABLE/);
  }
});

test("development runs publish successful uncharged results for every mode", async () => {
  for (const mode of ["company_basic", "company_reputation", "business_risk"] as const) {
    const charges: string[] = [], items: any[] = [];
    const summary = await run({ mode, company }, {
      billingMode: "development",
      analyze: async selected => ({ selected }),
      charge: async ({ eventName }) => { charges.push(eventName); return { chargedCount: 1 }; },
      pushData: async value => { items.push(value); }, setValue: async () => undefined,
      log: { info: () => undefined, error: () => undefined }
    });
    assert.deepEqual(charges, []);
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.failed, 0);
    assert.deepEqual(items[0].billing, { mode: "development", charged: false, event: `${mode === "company_basic" ? "company-basic" : mode === "company_reputation" ? "company-reputation" : "business-risk"}` });
    assert.deepEqual(summary.billing, { mode: "development", charged: false, event: items[0].billing.event, chargedCount: 0 });
  }
});

test("production publishes a charged result only after one complete charge", async () => {
  const charges: string[] = [], items: any[] = [];
  const summary = await run({ mode: "company_basic", company }, {
    billingMode: "production",
    analyze: async () => ({ ok: true }),
    charge: async ({ eventName }) => { charges.push(eventName); return { chargedCount: 1 }; },
    pushData: async value => { items.push(value); }, setValue: async () => undefined,
    log: { info: () => undefined, error: () => undefined }
  });
  assert.deepEqual(charges, ["company-basic"]);
  assert.equal(items[0].success, true);
  assert.deepEqual(items[0].billing, { mode: "production", charged: true, event: "company-basic" });
  assert.deepEqual(summary.billing, { mode: "production", charged: true, event: "company-basic", chargedCount: 1 });
});

test("partial production charge publishes a billing failure without retrying or exposing the result", async () => {
  let chargeCalls = 0;
  const items: any[] = [];
  const summary = await run({ mode: "company_reputation", company }, {
    billingMode: "production",
    analyze: async () => ({ premium: true }),
    charge: async () => { chargeCalls++; return { chargedCount: 0.5 }; },
    pushData: async value => { items.push(value); }, setValue: async () => undefined,
    log: { info: () => undefined, error: () => undefined }
  });
  assert.equal(chargeCalls, 1);
  assert.equal(summary.succeeded, 0);
  assert.equal(items[0].success, false);
  assert.equal(items[0].error.code, "SPENDING_LIMIT_REACHED");
  assert.equal(items[0].result, null);
});

test("production charge exceptions are billing failures and analysis failures remain analysis failures", async () => {
  const billingItems: any[] = [];
  const billingSummary = await run({ mode: "company_basic", company }, {
    billingMode: "production",
    analyze: async () => ({ ok: true }),
    charge: async () => { throw new Error("PPE unavailable"); },
    pushData: async value => { billingItems.push(value); }, setValue: async () => undefined,
    log: { info: () => undefined, error: () => undefined }
  });
  assert.equal(billingSummary.succeeded, 0);
  assert.equal(billingItems[0].error.code, "BILLING_NOT_AVAILABLE");

  const analysisItems: any[] = [];
  const analysisSummary = await run({ mode: "company_basic", company }, {
    billingMode: "production",
    analyze: async () => { throw Object.assign(new Error("upstream failed"), { code: "PROVIDER_UNAVAILABLE" }); },
    charge: async () => { throw new Error("must not be called"); },
    pushData: async value => { analysisItems.push(value); }, setValue: async () => undefined,
    log: { info: () => undefined, error: () => undefined }
  });
  assert.equal(analysisSummary.succeeded, 0);
  assert.equal(analysisItems[0].error.code, "PROVIDER_UNAVAILABLE");
});

test("safe errors do not expose paths or stacks", () => {
  const e = safeError(Object.assign(new Error("failed C:\\secret\\file"), { code: "INTERNAL_ERROR", stack: "secret" }));
  assert.equal(e.code, "ANALYSIS_FAILED");
  assert.equal(e.message.includes("C:\\\\"), false);
  assert.equal(e.message.includes("secret"), false);
});

test("ambiguous business-risk results expose sanitized candidates without charging", async () => {
  const items: any[] = [];
  const rawError = Object.assign(new Error("internal candidate details"), {
    code: "AMBIGUOUS_ENTITY",
    details: {
      status: "ambiguous_entity",
      candidateCount: 2,
      candidates: [
        {
          legalName: "Microsoft Example Ltd",
          registrationNumber: "REG-00042",
          country: "US",
          city: "Seattle",
          registry: "Example Registry",
          registrationStatus: "active",
          incorporationDate: "2020-01-02",
          matchedOn: ["name", "country"],
          matchScore: 0.84,
          website: "https://private.example",
          rawProviderPayload: { secret: "must-not-leak" },
          stack: "must-not-leak"
        },
        { legalName: "Microsoft Example Inc", registrationNumber: "REG-00043", country: "US", matchScore: 0.82 }
      ]
    }
  });
  const summary = await run({ mode: "business_risk", company }, {
    billingMode: "development",
    analyze: async () => { throw rawError; },
    charge: async () => { throw new Error("ambiguous results must not charge"); },
    pushData: async value => { items.push(value); }, setValue: async () => undefined,
    log: { info: () => undefined, error: () => undefined }
  });
  const item = items[0];
  assert.equal(summary.succeeded, 0);
  assert.equal(summary.failed, 1);
  assert.equal(item.success, false);
  assert.equal(item.companyName, "Example Technologies Ltd");
  assert.equal(item.domain, "example.com");
  assert.equal(item.country, "GB");
  assert.equal(item.riskScore, null);
  assert.equal(item.riskLevel, null);
  assert.equal(item.confidence, null);
  assert.equal(item.error.code, "AMBIGUOUS_ENTITY");
  assert.equal(item.resolution.status, "ambiguous");
  assert.equal(item.resolution.candidateCount, 2);
  assert.equal(item.resolution.candidates.length, 2);
  assert.equal(item.resolution.recommendedNextAction, "retry_with_registration_number");
  assert.equal(item.resolution.candidates[0].registrationNumber, "REG-00042");
  assert.deepEqual(item.resolution.candidates[0].matchedOn, ["name", "country"]);
  assert.equal(item.resolution.candidates[0].matchConfidence, 0.84);
  assert.equal(item.resolution.candidates[0].website, undefined);
  assert.equal(item.resolution.candidates[0].rawProviderPayload, undefined);
  assert.equal(item.resolution.candidates[1].city, undefined);
  assert.deepEqual(item.billing, { mode: "development", charged: false, event: "business-risk" });
});
