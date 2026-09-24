import { z } from "zod";
import { capabilities } from "../domain/capabilities.js";
import { prices } from "../billing/catalog.js";
import { x402BasePath } from "../billing/x402.js";
import { agentBasePath, buildAgentInfo, buildCapabilitiesRegistry, buildPricingInfo, buildToolCatalog, capabilitiesBasePath, pricingBasePath, toolsBasePath } from "./agent.js";
import { buildAgentCard, buildAgentManifest, buildAiPluginManifest } from "./manifest.js";
import { buildLlmsTxt } from "./llms-txt.js";
import { buildX402Status } from "../billing/x402.js";
import { l402BasePath } from "../billing/l402/gate.js";
import { buildMcpStatus, mcpStatusBasePath } from "../mcp/remote.js";
import { buildMppOpenapiPaths } from "../billing/mpp/openapi.js";
import { previewBasePath } from "./previewRoutes.js";
import type { MppConfig } from "../billing/mpp/config.js";
import type { BillingConfig } from "../billing/unified/config.js";
import { buildPaymentMethods, paymentMethodsPath, railAvailability } from "../billing/unified/discovery.js";
import { accountBasePath } from "../billing/unified/http.js";
import { mcpCreditsPath } from "../billing/unified/mcp.js";
const json = (schema: unknown, example?: unknown, summary = "Example") => ({ "application/json": {
  schema, ...(example === undefined ? {} : { examples: { default: { summary, value: example } } })
} });
const meta = { type: "object", required: ["requestId"], properties: { requestId: { type: "string" } } };
const success = (data: unknown) => ({ type: "object", required: ["success", "data", "meta"], properties: { success: { const: true }, data, meta } });
const errorSchema = {
  type: "object", required: ["success", "error", "meta"], properties: {
    success: { const: false }, meta,
    error: { type: "object", required: ["code", "message"], properties: {
      code: { type: "string" }, message: { type: "string" },
      // INVALID_INPUT carries an array of {path, message}; a few capability-specific errors (e.g.
      // business_risk_score's AMBIGUOUS_ENTITY candidate list) carry a structured object instead.
      details: { oneOf: [
        { type: "array", items: { type: "object", required: ["path", "message"], properties: { path: { type: "string" }, message: { type: "string" } } } },
        { type: "object" }
      ] }
    } }
  }
};
const errors = Object.fromEntries([
  [400, "INVALID_INPUT", "Input validation failed"], [401, "UNAUTHORIZED", "A valid X-API-Key header is required"],
  [413, "PAYLOAD_TOO_LARGE", "Request body exceeds 32kb"], [415, "UNSUPPORTED_MEDIA_TYPE", "Use application/json"],
  [429, "RATE_LIMITED", "Per-minute limit or monthly quota exceeded (QUOTA_EXCEEDED)"], [503, "SERVICE_UNAVAILABLE", "Customer or usage storage unavailable"], [500, "INTERNAL_ERROR", "An unexpected error occurred"]
].map(([status, code, message]) => [status, { description: message, content: json(errorSchema, { success: false, error: { code, message }, meta: { requestId: "example-request" } }) }]));
const x402Errors = Object.fromEntries(Object.entries(errors).filter(([status]) => status !== "401"));
/** Capability-specific structured errors (in addition to the shared set above). None of them is a
 *  successful call, so no paid settlement happens on x402 / L402 / MPP. */
const documentFactsErrors = Object.fromEntries(([
  [400, "MISSING_DOCUMENT", "Malformed request (INVALID_JSON / INVALID_INPUT) or no usable document source: MISSING_DOCUMENT when neither documentUrl nor text is supplied (also CONFLICTING_DOCUMENT_SOURCES when both are, EMPTY_DOCUMENT for blank text, INVALID_URL for a non-https or internal URL)", { status: "missing_document" }],
  [413, "DOCUMENT_TOO_LARGE", "Over 25 pages, 200,000 characters or the download limit — rejected, never truncated", { status: "document_too_large", limit: "pages", max: 25, actual: 40 }],
  [415, "UNSUPPORTED_FORMAT", "Not PDF / DOCX / HTML / text / Markdown / CSV (e.g. an image, spreadsheet or legacy .doc)", { status: "unsupported_format", detected: "image", supported: ["pdf", "docx", "html", "text", "markdown", "csv"] }],
  [422, "UNREADABLE_DOCUMENT", "Corrupt, password-protected, or no text layer (scanned); OCR is not performed", { status: "unreadable_document", reason: "the PDF has no extractable text layer" }],
  [502, "DOCUMENT_FETCH_FAILED", "documentUrl could not be downloaded", { status: "fetch_failed", reason: "the server answered HTTP 404.", upstreamStatus: 404 }],
  [504, "DOCUMENT_TIMEOUT", "Download or extraction exceeded its time budget", { status: "timeout", stage: "download" }]
] as const).map(([status, code, message, details]) => [status, { description: `${message}. Not charged.`, content: json(errorSchema, { success: false, error: { code, message, details }, meta: { requestId: "example-request" } }) }]));
/** invoice_anomaly_check: value-level validation errors (400, each naming the offending path, never
 *  echoing the value) and the sanitized ANALYSIS_FAILED (500). Not charged. */
const invoiceAnomalyErrors = {
  "400": { description: "INVALID_INPUT (schema/unknown fields), INVALID_JSON, INVALID_MONETARY_VALUE, INVALID_DATE or UNSUPPORTED_CURRENCY_FORMAT. Not charged.", content: json(errorSchema, { success: false, error: { code: "INVALID_DATE", message: "invoice.invoiceDate must be a valid ISO 8601 date (YYYY-MM-DD) or date-time. No payment was taken.", details: { path: "invoice.invoiceDate" } }, meta: { requestId: "example-request" } }) },
  "413": { description: "Request body exceeds 1mb", content: json(errorSchema, { success: false, error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds 1mb" }, meta: { requestId: "example-request" } }) },
  "500": { description: "ANALYSIS_FAILED — the engine failed unexpectedly (no internal detail exposed). Not charged.", content: json(errorSchema, { success: false, error: { code: "ANALYSIS_FAILED", message: "The invoice could not be analyzed due to an internal error. No payment was taken.", details: { status: "analysis_failed" } }, meta: { requestId: "example-request" } }) }
};
/** vehicle_value_estimate: schema errors, CURRENCY_REQUIRED (no default currency for the market) and
 *  the sanitized VALUATION_FAILED. Not charged. */
const vehicleValueErrors = {
  "400": { description: "INVALID_INPUT (unrealistic year/mileage/owners/price, unknown enum value or unknown field), INVALID_JSON, or CURRENCY_REQUIRED (the country has no configured default currency). Not charged.", content: json(errorSchema, { success: false, error: { code: "INVALID_INPUT", message: "Input validation failed", details: [{ path: "mileageKm", message: "Too big: expected number to be <=2000000" }] }, meta: { requestId: "example-request" } }) },
  "500": { description: "VALUATION_FAILED — the engine failed unexpectedly (no internal detail exposed). Not charged.", content: json(errorSchema, { success: false, error: { code: "VALUATION_FAILED", message: "The vehicle could not be valued due to an internal error. No payment was taken.", details: { status: "valuation_failed" } }, meta: { requestId: "example-request" } }) }
};
const capabilityErrors: Partial<Record<string, Record<string, unknown>>> = {
  vehicle_value_estimate: vehicleValueErrors,
  document_facts_extract: documentFactsErrors,
  invoice_anomaly_check: invoiceAnomalyErrors,
  business_risk_score: Object.fromEntries(([
    [404, "ENTITY_NOT_FOUND", "No such company in the jurisdiction's registry and no other evidence the business exists", { status: "entity_not_found", registriesChecked: ["UK Companies House"], identifiersUsed: { companyName: "Example Trading Ltd", country: "GB", registrationNumber: null, lei: null, domain: null } }],
    [409, "AMBIGUOUS_ENTITY", "Several registered companies match; retry with a candidate's registrationNumber", { status: "ambiguous_entity", candidates: [{ legalName: "EXAMPLE TRADING LIMITED", country: "GB", city: "London", registrationNumber: "09876543", lei: null, registrationStatus: "active", incorporationDate: "2015-11-03", registry: "UK Companies House", matchScore: 0.9, matchedOn: ["name", "country"] }], suggestedIdentifiers: ["registrationNumber", "city", "website"] }],
    [503, "PROVIDER_UNAVAILABLE", "Every identity source failed; the minimum identity check could not be performed (retry, no charge)", { status: "provider_failure", providers: [{ provider: "UK Companies House", status: "unavailable", reason: "Companies House returned HTTP 502." }] }],
    [504, "PROVIDER_TIMEOUT", "Every identity source timed out (retry, no charge)", { status: "provider_failure", providers: [{ provider: "UK Companies House", status: "timeout", reason: "The provider did not respond within the time budget." }] }]
  ] as const).map(([status, code, message, details]) => [status, { description: message, content: json(errorSchema, { success: false, error: { code, message, details }, meta: { requestId: "example-request" } }) }]))
};
const toolMeta = { type: "object", required: ["requestId", "tool", "price", "currency"], properties: { requestId: { type: "string" }, tool: { type: "string" }, price: { type: "number" }, currency: { type: "string" } } };
const toolSuccess = (data: unknown) => ({ type: "object", required: ["success", "data", "meta"], properties: { success: { const: true }, data, meta: toolMeta } });

export function buildOpenapi(config: { x402Enabled: boolean; x402Network: string; x402WalletAddress: string; cdpConfigured: boolean; mcpRemoteEnabled: boolean; logoUrl: string; contactEmail: string; legalInfoUrl: string; l402Enabled?: boolean; l402Network?: "mainnet" | "testnet" | "signet" | "regtest"; mpp?: MppConfig; billing?: BillingConfig } = { x402Enabled: false, x402Network: "", x402WalletAddress: "", cdpConfigured: false, mcpRemoteEnabled: false, logoUrl: "", contactEmail: "", legalInfoUrl: "" }) {
const paths: Record<string, unknown> = {};
const rails = railAvailability(config);
const anyRail = rails.billing || rails.x402 || rails.l402 || rails.mppCharge;
// Unified billing: request headers every canonical capability route understands (additive).
const paymentParameters = [
  { name: "X-Rafid-Payment-Method", in: "header", required: false, schema: { type: "string", enum: ["auto", "credits", "subscription", "x402", "l402", "mpp"], default: "auto" }, description: "Selects the payment rail. `auto` charges a presented Rafid API key (subscription allowance, then prepaid credits), else the presented x402/L402/MPP credential. Naming a rail never charges the API key for another rail. Only enabled rails are accepted — see GET " + paymentMethodsPath + "." },
  ...(rails.billing ? [{ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string", minLength: 1, maxLength: 255 }, description: "API-credit/subscription calls: a retry with the same key and the same body is never charged twice (the original response is replayed with Idempotent-Replay: true); the same key with a different body returns 409 idempotency_conflict." }] : [])
];
const billing402 = { type: "object", required: ["success", "error", "meta"], properties: {
  success: { const: false }, meta,
  error: { type: "object", required: ["code", "message"], properties: { code: { type: "string", enum: ["payment_required", "insufficient_credits", "subscription_exhausted", "no_active_subscription"] }, message: { type: "string" } } },
  tool: { type: "string" }, price: { type: "object", properties: { amount: { type: "string" }, currency: { type: "string" } } },
  balance: { type: "object", properties: { amount: { type: "string" }, currency: { type: "string" } } },
  paymentOptions: { description: "payment_required: an object keyed by rail with an `enabled` flag each; insufficient_*: an array of enabled payment-method ids.", oneOf: [{ type: "object" }, { type: "array", items: { type: "string" } }] },
  paymentMethods: { type: "string" }
} };
const billingResponses = anyRail ? {
  "402": { description: "Payment required. With no usable credential: `payment_required` listing every enabled rail. With a valid Rafid API key that can't cover the price: `insufficient_credits` / `subscription_exhausted` (price, balance, other enabled options). Nothing is charged. A request selecting x402/L402/MPP (X-Rafid-Payment-Method or its credential) receives that protocol's own standards-compliant 402 challenge instead.", content: json(billing402, { success: false, error: { code: "insufficient_credits", message: "The account balance does not cover research_company." }, tool: "research_company", price: { amount: "0.15", currency: "USD" }, balance: { amount: "0.07", currency: "USD" }, paymentOptions: ["x402", "api_credits"], paymentMethods: paymentMethodsPath, meta: { requestId: "example-request" } }) },
  ...(rails.billing ? { "409": { description: "idempotency_conflict (same Idempotency-Key, different body) or idempotency_in_progress.", content: json(errorSchema, { success: false, error: { code: "idempotency_conflict", message: "This Idempotency-Key was already used for this tool with a different request body." }, meta: { requestId: "example-request" } }) } } : {})
} : {};
for (const c of capabilities) {
  const operation = {
    operationId: c.name,
    tags: [
      c.name === "estimate_maintenance" ? "Maintenance" :
      c.name === "analyze_oman_property" ? "Oman" :
      c.name === "research_company" || c.name === "find_companies" || c.name === "analyze_company_risk" ? "Intelligence" :
      c.name === "oman_supplier_check" ? "Procurement" :
      c.name === "company_reputation_check" || c.name === "business_risk_score" ? "Risk Intelligence" :
      c.name === "document_facts_extract" ? "Document Intelligence" :
      c.name === "invoice_anomaly_check" ? "Finance" :
      c.name === "vehicle_value_estimate" ? "Automotive" :
      "Property"
    ],
    summary: c.description,
    description: `${c.description} Click Authorize and enter an active Rafid API key before using Try it out.` + (rails.billing ? " Accepts either a legacy X-API-Key or a Rafid billing key (Authorization: Bearer raf_live_…), which is charged the listed price from the account's subscription allowance / prepaid credits (response meta.billing and X-Rafid-* headers report the charge)." : ""),
    security: [{ ApiKeyAuth: [] }, ...(rails.billing ? [{ BillingApiKey: [] }] : [])],
    parameters: paymentParameters,
    requestBody: { required: true, description: "Strict JSON input; unknown fields are rejected.", content: json(z.toJSONSchema(c.input), c.example, `${c.name} request`) },
    responses: {
      "200": { description: "Calculated metrics", content: json(toolSuccess(z.toJSONSchema(c.output)), { success: true, data: c.exampleOutput, meta: { requestId: "example-request", tool: c.name, price: prices[c.name], currency: "USD" } }, `${c.name} response`) },
      ...errors,
      ...billingResponses,
      ...(capabilityErrors[c.name] ?? {})
    }
  };
  paths["/api/v1" + c.path] = { post: operation };
  paths["/v1" + c.path] = { post: { ...operation, operationId: c.name + "_legacy", deprecated: true } };
}
if (config.x402Enabled) {
  for (const c of capabilities) {
    paths[x402BasePath + c.path] = { post: {
      operationId: c.name + "_x402",
      tags: ["x402"],
      summary: `${c.description} (pay-per-call via x402, no API key)`,
      description: "Requires a valid X-PAYMENT header per the x402 protocol instead of X-API-Key. Send the request without an X-PAYMENT header first to receive a 402 response listing accepted payment options (price, network and receiving address).",
      security: [],
      requestBody: { required: true, description: "Strict JSON input; unknown fields are rejected.", content: json(z.toJSONSchema(c.input), c.example, `${c.name} request`) },
      responses: {
        "200": { description: "Calculated metrics", content: json(toolSuccess(z.toJSONSchema(c.output)), { success: true, data: c.exampleOutput, meta: { requestId: "example-request", tool: c.name, price: prices[c.name], currency: "USD" } }, `${c.name} response`) },
        "402": { description: `Payment required — ${prices[c.name].toFixed(2)} USD in USDC on ${config.x402Network}. Response body lists accepted payment options per the x402 protocol.` },
        ...x402Errors,
        ...(capabilityErrors[c.name] ?? {})
      }
    } };
  }
}
if (config.l402Enabled) {
  for (const c of capabilities) {
    paths[l402BasePath + c.path] = { post: {
      operationId: c.name + "_l402",
      tags: ["L402"],
      summary: `${c.description} (pay-per-call via L402 / Lightning, no API key)`,
      description: "Requires `Authorization: L402 <macaroon>:<preimage-hex>` instead of X-API-Key. Send the request without an Authorization header first to receive a 402 whose WWW-Authenticate header carries an L402 macaroon and a BOLT11 invoice (the tool's USD price converted to sats at the live BTC/USD rate). Pay the invoice, then retry with the macaroon and the payment preimage. One token buys one successful call.",
      security: [],
      requestBody: { required: true, description: "Strict JSON input; unknown fields are rejected.", content: json(z.toJSONSchema(c.input), c.example, `${c.name} request`) },
      responses: {
        "200": { description: "Calculated metrics", content: json(toolSuccess(z.toJSONSchema(c.output)), { success: true, data: c.exampleOutput, meta: { requestId: "example-request", tool: c.name, price: prices[c.name], currency: "USD" } }, `${c.name} response`) },
        "402": { description: `Payment required — ${prices[c.name].toFixed(2)} USD, payable in BTC over Lightning (lightning:${config.l402Network ?? "mainnet"}). See the WWW-Authenticate header (L402 macaroon + invoice).` },
        ...x402Errors,
        ...(capabilityErrors[c.name] ?? {}),
        "503": { description: "No BTC/USD rate or Lightning invoice could be produced right now; retry or use x402/API-key access." }
      }
    } };
  }
}
// Free Preview (src/preview/): one generic, unauthenticated, FREE route for every capability
// that defines a `preview`. No payment required — deliberately no security scheme, no 402
// response, and never listed alongside a capability's paid x402/L402/MPP routes above.
{
  const previewSuccessSchema = success({
    type: "object", required: ["capability", "status", "inputRecognized", "preview", "fullResult"], properties: {
      capability: { type: "string" },
      status: { type: "string", enum: ["available", "limited", "unavailable", "invalid_input"], description: "\"available\": useful data/analysis coverage was found. \"limited\": some coverage, but thin. \"unavailable\": this capability defines no preview — call GET /api/v1/capabilities first to check `preview.available`. \"invalid_input\" is reserved for a preview implementation that reports invalid input directly rather than throwing (most report a plain 400 instead — see the 400 response)." },
      inputRecognized: { type: "boolean", description: "Whether the input was recognized as a valid request for this capability, independent of whether data/analysis coverage was found for it." },
      preview: { type: "object", description: "Evidence that useful data/analysis is available for this input — proof of \"I have information for this request,\" never the paid analysis itself. Every field is optional; only the fields a given capability's preview computes are present.", properties: {
        entity: { type: "string" }, entityType: { type: "string" }, sourcesFound: { type: "integer" }, freshestSourceDate: { type: "string" },
        coverageScore: { type: "number", minimum: 0, maximum: 1 }, dataCoverage: { type: "string", enum: ["low", "medium", "high"] },
        availableSections: { type: "array", items: { type: "string" }, description: "Which top-level sections the PAID result would populate for this input — the section names only, never their contents." },
        signals: { type: "object", description: "Small, capability-specific objective signals (e.g. configuredSourceCategories, registryCandidatesFound) — counts and booleans, never scored findings." }
      } },
      fullResult: { type: "object", required: ["capability", "price"], properties: {
        capability: { type: "string" },
        price: { type: "object", required: ["amount", "currency"], properties: { amount: { type: "string" }, currency: { type: "string" } }, description: "The PAID capability's price — read from the exact same capability-registry entry the paid route bills from, so it can never drift from GET /api/v1/capabilities or the x402/L402/MPP price." },
        paymentMethods: { type: "array", items: { type: "string" } },
        endpoint: { type: "string", description: "Where to call the paid capability once the preview looks worthwhile." }
      } }
    }
  });
  const previewExamples = {
    available: { summary: "status: available (useful coverage found)", value: { success: true, data: {
      capability: "company_reputation_check", status: "available", inputRecognized: true,
      preview: { entity: "Example Technologies Ltd", entityType: "company", coverageScore: 0.86, dataCoverage: "high",
        availableSections: ["identity", "sanctions", "adverseMedia", "customerSentiment", "onlinePresence", "legalRiskSignals", "businessStabilitySignals", "cyberDomainSignals", "transparencySignals"],
        signals: { configuredSourceCategories: 6, totalSourceCategories: 7 } },
      fullResult: { capability: "company_reputation_check", price: { amount: "0.40", currency: "USD" }, endpoint: "/api/v1/risk/company-reputation-check" }
    }, meta: { requestId: "example-request" } } },
    unavailable: { summary: "status: unavailable (capability defines no preview)", value: { success: true, data: {
      capability: "analyze_company_risk", status: "unavailable", inputRecognized: false, preview: {},
      fullResult: { capability: "analyze_company_risk", price: { amount: "0.35", currency: "USD" }, endpoint: "/api/v1/intelligence/analyze-company-risk" }
    }, meta: { requestId: "example-request" } } }
  };
  paths[previewBasePath + "/{capability}"] = { post: {
    operationId: "preview_capability",
    tags: ["Preview"],
    summary: "Free preview: check data availability before paying",
    description: "FREE — no payment, X-PAYMENT header, X-API-Key or account required. Checks whether a paid capability has useful data/analysis available for the given input, without revealing the paid analysis itself: proof of \"I have information for this request,\" never \"here is the information.\" This route never runs the paid capability's `execute()` and never triggers x402/L402/MPP payment, blockchain settlement, invoice creation or paid usage consumption. Not every capability supports preview — check `preview.available` on GET /api/v1/capabilities, or call this route and read `status: \"unavailable\"` back. Recommended agent flow: discover -> preview -> evaluate -> pay -> execute.",
    security: [],
    parameters: [{ name: "capability", in: "path", required: true, schema: { type: "string", enum: capabilities.map(c => c.name) }, description: "A capability name from GET /api/v1/capabilities, e.g. \"research_company\"." }],
    requestBody: { required: false, description: "The same input the paid capability accepts (unknown fields rejected). Optional: a capability whose preview needs no fields may be called with an empty body.", content: json({ type: "object" }, { companyName: "Example Technologies Ltd", country: "United Kingdom" }, "preview request (company_reputation_check example)") },
    responses: {
      "200": { description: "Preview result (see the `status` field for what it means). Always 200, whatever the capability's own coverage — an empty/thin result is `status: \"limited\"`, not an error.", content: { "application/json": { schema: previewSuccessSchema, examples: previewExamples } } },
      "400": errors["400"],
      "404": { description: "No such capability.", content: json(errorSchema, { success: false, error: { code: "CAPABILITY_NOT_FOUND", message: "No such capability \"not_a_real_tool\". See GET /api/v1/capabilities for the full list of tools." }, meta: { requestId: "example-request" } }) },
      "415": errors["415"],
      "429": errors["429"]
    }
  } };
  paths["/v1/preview/{capability}"] = { post: { ...(paths[previewBasePath + "/{capability}"] as { post: object }).post, operationId: "preview_capability_legacy", deprecated: true } };
}
for (const path of ["/api/v1/health", "/health"]) {
  paths[path] = { get: { operationId: path === "/health" ? "health_legacy" : "health", tags: ["System"], summary: "Process liveness", description: "Public liveness endpoint. No API key is required.", security: [],
    responses: { "200": { description: "Alive", content: json(success({ type: "object", required: ["ok"], properties: { ok: { const: true } } }), { success: true, data: { ok: true }, meta: { requestId: "example-request" } }) } }
  } };
}
const discoverySchema = { type: "object", required: ["name", "version", "docs", "openapi", "health", "endpoints"], properties: {
  name: { type: "string" }, version: { type: "string" }, docs: { type: "string" }, openapi: { type: "string" }, health: { type: "string" },
  agent: { type: "string" }, pricing: { type: "string" }, tools: { type: "string" }, x402: { type: "string" }, endpoints: { type: "array", items: { type: "string" } }
} };
const discoveryExample = { success: true, data: { name: "Rafid Agent API", version: "0.1.0", docs: "/docs", openapi: "/openapi.json", health: "/api/v1/health", agent: agentBasePath, pricing: pricingBasePath, tools: toolsBasePath, ...(config.x402Enabled ? { x402: x402BasePath } : {}), endpoints: capabilities.map(c => "/api/v1" + c.path) }, meta: { requestId: "example-request" } };
paths["/"] = { get: { operationId: "discovery", tags: ["System"], summary: "Service metadata or a browser-facing landing page", description: "Returns an HTML landing page for browsers (Accept: text/html, the default) and a JSON discovery payload for machine/agent clients that send Accept: application/json.", security: [], responses: {
  "200": { description: "Discovery (JSON) or landing page (HTML)", content: {
    ...json(discoverySchema, discoveryExample),
    "text/html": { schema: { type: "string" } }
  } }
} } };
paths["/docs"] = { get: { operationId: "swagger_docs", tags: ["System"], summary: "Interactive Swagger UI", description: "Browser interface for exploring the API, authorizing with X-API-Key, and sending test requests.", security: [], responses: {
  "200": { description: "Swagger UI HTML", content: { "text/html": { schema: { type: "string" } } } }
} } };
paths["/openapi.json"] = { get: { operationId: "openapi", tags: ["System"], summary: "Raw OpenAPI discovery document (no envelope)", security: [], responses: {
  "200": { description: "OpenAPI 3.1 document", content: json({ type: "object", required: ["openapi", "info", "paths"], properties: { openapi: { type: "string" }, info: { type: "object" }, paths: { type: "object" } } }) }
} } };
// Section A/B/C: agent-marketplace discovery, pricing and tool catalog. Always present
// regardless of X402_ENABLED, and reuse the exact same builder functions app.ts calls at
// request time, so this document can never drift from the live response shape.
paths[agentBasePath] = { get: { operationId: "agent", tags: ["Agent"], summary: "Agent-marketplace metadata", description: "Machine-readable service metadata for AI agents and agent directories/marketplaces.", security: [],
  responses: { "200": { description: "Agent metadata", content: json(success({ type: "object", required: ["name", "description", "version", "mcp", "openapi", "pricing", "x402"], properties: {
    name: { type: "string" }, description: { type: "string" }, version: { type: "string" }, mcp: { type: "boolean" },
    docs: { type: "string" }, openapi: { type: "string" }, health: { type: "string" }, pricing: { type: "string" }, tools: { type: "string" },
    x402: { type: "string" }, x402Enabled: { type: "boolean" }, endpoints: { type: "array", items: { type: "string" } }
  } }), { success: true, data: buildAgentInfo(config), meta: { requestId: "example-request" } }) } }
} };
paths[pricingBasePath] = { get: { operationId: "pricing", tags: ["Agent"], summary: "Pay-per-call pricing", description: "Structured, centralized pricing for every tool. Sourced from a single price catalog shared with the x402 payment gate — never duplicated.", security: [],
  responses: { "200": { description: "Pricing", content: json(success({ type: "object", required: ["currency", "model", "tools"], properties: {
    currency: { type: "string" }, model: { type: "string" }, tools: { type: "object", additionalProperties: { type: "number" } }
  } }), { success: true, data: buildPricingInfo(), meta: { requestId: "example-request" } }) } }
} };
paths[toolsBasePath] = { get: { operationId: "tools", tags: ["Agent"], summary: "Tool catalog for AI agents", description: "Every tool available to AI agents: name, description, price, endpoint, method, input JSON Schema and a derived output summary.", security: [],
  responses: { "200": { description: "Tool catalog", content: json(success({ type: "array", items: { type: "object", required: ["name", "description", "price", "currency", "endpoint", "method", "inputSchema", "outputSummary"], properties: {
    name: { type: "string" }, description: { type: "string" }, price: { type: "number" }, currency: { type: "string" },
    endpoint: { type: "string" }, x402Endpoint: { type: "string" }, method: { type: "string" }, inputSchema: { type: "object" }, outputSummary: { type: "string" }
  } } }), { success: true, data: buildToolCatalog(), meta: { requestId: "example-request" } }) } }
} };
// Section F: always-on x402 protocol/pricing information, separate from the payment-gated
// POST routes (which only exist when X402_ENABLED=true and are documented above).
paths[x402BasePath] = { get: { operationId: "x402_info", tags: ["x402"], summary: "x402 protocol and pricing information", description: "Always available, independent of X402_ENABLED, so an agent can discover pricing/network support before deciding whether to pay. No wallet secret is ever included.", security: [],
  responses: { "200": { description: "x402 protocol info", content: json(success({ type: "object", required: ["protocol", "x402Version", "scheme", "enabled", "tools"], properties: {
    protocol: { type: "string" }, x402Version: { type: "integer" }, scheme: { type: "string" }, enabled: { type: "boolean" },
    network: { type: ["string", "null"] }, payTo: { type: ["string", "null"] }, facilitator: { type: ["string", "null"] },
    tools: { type: "array", items: { type: "object", required: ["name", "endpoint", "price"], properties: { name: { type: "string" }, endpoint: { type: "string" }, price: { type: "number" } } } }
  } }), { success: true, data: { protocol: "x402", x402Version: 2, scheme: "exact", enabled: config.x402Enabled, network: config.x402Enabled ? config.x402Network : null, payTo: null, facilitator: null, tools: capabilities.map(c => ({ name: c.name, endpoint: x402BasePath + c.path, price: prices[c.name] })) }, meta: { requestId: "example-request" } }) } }
} };
// Section F hardening: a small, always-on, factual runtime status report distinct from the
// informational endpoint above — see buildX402Status()'s doc comment for exactly why each
// field is safe to expose and cannot silently disagree with reality.
paths[x402BasePath + "/status"] = { get: { operationId: "x402_status", tags: ["x402"], summary: "Factual x402 runtime status", description: "A small, always-on status report so a caller never has to infer payment enforcement from marketing copy: every field is read directly from validated configuration. Never includes a wallet private key or any other secret.", security: [],
  responses: { "200": { description: "x402 runtime status", content: json(success({ type: "object", required: ["enabled", "mode", "network", "asset", "facilitator", "walletConfigured", "paymentEnforcement"], properties: {
    enabled: { type: "boolean" }, mode: { type: "string", enum: ["disabled", "testnet", "production"] },
    network: { type: ["string", "null"] }, asset: { type: ["string", "null"] }, facilitator: { type: ["string", "null"] },
    walletConfigured: { type: "boolean" }, paymentEnforcement: { type: "boolean" }
  } }), { success: true, data: buildX402Status(config), meta: { requestId: "example-request" } }) } }
} };
// L402 (Lightning) info + status — always available, independent of L402_ENABLED.
paths[l402BasePath] = { get: { operationId: "l402_info", tags: ["L402"], summary: "L402 (Lightning) protocol and pricing information", description: "Always available, independent of L402_ENABLED. USD prices per tool; the sats amount is quoted per 402 challenge at the live BTC/USD rate. No secret is ever included.", security: [],
  responses: { "200": { description: "L402 protocol info", content: json(success({ type: "object", required: ["protocol", "enabled", "tools"], properties: {
    protocol: { type: "string" }, spec: { type: "string" }, enabled: { type: "boolean" }, network: { type: ["string", "null"] }, currency: { type: "string" },
    pricing: { type: "string" }, tokenPolicy: { type: "string" }, authorization: { type: "string" },
    tools: { type: "array", items: { type: "object", required: ["name", "endpoint", "priceUsd"], properties: { name: { type: "string" }, endpoint: { type: "string" }, priceUsd: { type: "number" } } } }
  } })) } }
} };
paths[l402BasePath + "/status"] = { get: { operationId: "l402_status", tags: ["L402"], summary: "Factual L402 runtime status", description: "Always-on status read directly from validated configuration. Never includes the root key, LND macaroon or any other secret.", security: [],
  responses: { "200": { description: "L402 runtime status", content: json(success({ type: "object", required: ["enabled", "mode", "paymentEnforcement"], properties: {
    enabled: { type: "boolean" }, mode: { type: "string", enum: ["disabled", "testnet", "production"] }, network: { type: ["string", "null"] },
    asset: { type: ["string", "null"] }, backend: { type: ["string", "null"] }, lightningBackendConfigured: { type: "boolean" },
    rootKeyConfigured: { type: "boolean" }, paymentEnforcement: { type: "boolean" }
  } })) } }
} };
// Section 3/4/5/8: top-level agent discovery. All four reuse the exact builder functions
// app.ts calls at request time, so this document can never drift from the live responses.
const exampleOrigin = "https://api.rafidsystem.com";
paths[capabilitiesBasePath] = { get: { operationId: "capabilities", tags: ["Agent"], summary: "Machine-first capability registry", description: "The full capability registry — schemas, pricing, when to use, examples — optimized for an agent (or the model behind it) to decide what to call without reading prose. The single source every other discovery endpoint here reuses.", security: [],
  responses: { "200": { description: "Capability registry", content: json(success({ type: "array", items: { type: "object", required: ["name", "description", "whenToUse", "price", "currency", "paymentProtocol", "endpoint", "inputSchema", "outputSchema"], properties: {
    name: { type: "string" }, description: { type: "string" }, whenToUse: { type: "string" }, useCases: { type: "array", items: { type: "string" } },
    price: { type: "number" }, currency: { type: "string" }, paymentProtocol: { type: "string" }, network: { type: ["string", "null"] },
    idempotent: { type: "boolean" }, sideEffects: { type: "boolean" }, endpoint: { type: "string" }, x402Endpoint: { type: "string" }, method: { type: "string" },
    inputSchema: { type: "object" }, outputSchema: { type: "object" },
    // Agent tool-selection guidance (AgentCapability.agentGuidance, domain/capabilities.ts):
    // internal recommendation metadata for an agent deciding whether/how to call this tool —
    // never a ranking against a competing service. Empty arrays for a capability with no
    // agentGuidance defined.
    priorityContexts: { type: "array", items: { type: "string" }, description: "Situations/domains where this tool is the right call; not a comparison to any other service." },
    evidenceTypes: { type: "array", items: { type: "object", required: ["type", "description"], properties: { type: { type: "string" }, description: { type: "string" } } }, description: "Distinct kinds of price/comparable evidence this tool's output can involve (e.g. web asking price vs. partner-fed contracted price); report each separately, never blended." },
    limitations: { type: "array", items: { type: "string" }, description: "Hard caveats an agent must account for before treating this tool's output as authoritative." },
    sampleQueries: { type: "array", items: { type: "object", required: ["query", "guidance"], properties: { query: { type: "string" }, guidance: { type: "string" } } }, description: "Worked example end-user questions this tool answers, each with how an agent should use the response." }
  } } }), { success: true, data: buildCapabilitiesRegistry(config), meta: { requestId: "example-request" } }) } }
} };
paths["/agent.json"] = { get: { operationId: "agent_manifest", tags: ["Agent"], summary: "Full agent manifest", description: "Comprehensive, unauthenticated discovery document: product identity, every supported protocol (MCP, x402, REST), the OpenAPI URL, x402 terms and the complete tool catalog with full input/output JSON Schemas. No secrets.", security: [],
  responses: { "200": { description: "Agent manifest", content: json({ type: "object" }, buildAgentManifest(config)) } }
} };
paths["/.well-known/ai-plugin.json"] = { get: { operationId: "ai_plugin_manifest", tags: ["Agent"], summary: "OpenAI-plugin-style manifest", description: "Manifest in the legacy OpenAI ChatGPT-plugin convention, for tooling that still discovers services this way.", security: [],
  responses: { "200": { description: "ai-plugin.json manifest", content: json({ type: "object" }, buildAiPluginManifest(config, exampleOrigin)) } }
} };
paths["/.well-known/agent.json"] = { get: { operationId: "agent_card", tags: ["Agent"], summary: "A2A-style Agent Card", description: "Agent Card in the Agent2Agent (A2A) protocol's convention at this well-known path, listing each tool as a skill.", security: [],
  responses: { "200": { description: "Agent Card", content: json({ type: "object" }, buildAgentCard(config, exampleOrigin)) } }
} };
if (config.mcpRemoteEnabled) {
  paths["/mcp"] = { post: { operationId: "mcp_remote", tags: ["Agent"], summary: "Remote MCP transport (Streamable HTTP, JSON-RPC 2.0)", description: "Not a REST endpoint: this is the MCP Streamable HTTP transport, carrying JSON-RPC 2.0 requests (initialize, tools/list, tools/call, ...) per the Model Context Protocol specification, not an OpenAPI-shaped request/response. Stateless (no session ID), so every request is self-contained. See GET " + mcpStatusBasePath + " to check whether this transport is live, and /llms.txt for a plain-text connection summary.", security: [],
    requestBody: { required: true, description: "A JSON-RPC 2.0 request object.", content: { "application/json": { schema: { type: "object", required: ["jsonrpc", "method"], properties: { jsonrpc: { const: "2.0" }, id: {}, method: { type: "string" }, params: { type: "object" } } } } } },
    responses: { "200": { description: "A JSON-RPC 2.0 response (or an SSE stream negotiated via the Accept header)." } }
  } };
}
paths[mcpStatusBasePath] = { get: { operationId: "mcp_status", tags: ["Agent"], summary: "Factual MCP transport status", description: "Always-on status report for MCP connectivity: which transports are live (stdio always, http only when MCP_REMOTE_ENABLED=true), the tool count, and the remote endpoint path if any. No secret, no session data.", security: [],
  responses: { "200": { description: "MCP status", content: json(success({ type: "object", required: ["enabled", "transport", "tools", "endpoint"], properties: {
    enabled: { type: "boolean" }, transport: { type: "array", items: { type: "string" } }, tools: { type: "integer" }, endpoint: { type: ["string", "null"] }
  } }), { success: true, data: buildMcpStatus(config), meta: { requestId: "example-request" } }) } }
} };
paths["/llms.txt"] = { get: { operationId: "llms_txt", tags: ["Agent"], summary: "Plain-text briefing for LLM-based agents", description: "What Rafid does, every tool and how to call it, pricing, the x402 payment model and known limitations, in plain text for an agent that hasn't called a JSON endpoint yet.", security: [],
  responses: { "200": { description: "llms.txt", content: { "text/plain": { schema: { type: "string" }, example: buildLlmsTxt(config) } } } }
} };
// Unified payment discovery — always present.
paths[paymentMethodsPath] = { get: { operationId: "payment_methods", tags: ["Agent"], summary: "Every enabled payment method", description: "Lists each ENABLED payment rail (x402, API credits, subscription, L402, MPP), how to authenticate, and how to select it with X-Rafid-Payment-Method. Disabled rails are never listed.", security: [],
  responses: { "200": { description: "Payment methods", content: json(success({ type: "object", required: ["methods", "selection"], properties: { methods: { type: "array", items: { type: "object", required: ["id", "enabled", "type"], properties: { id: { type: "string" }, enabled: { type: "boolean" }, type: { type: "string" } } } }, selection: { type: "object" }, idempotency: { type: "object" } } }), { success: true, data: buildPaymentMethods(config), meta: { requestId: "example-request" } }) } }
} };
if (rails.billing) {
  const acctOp = (id: string, summary: string, description: string, data: unknown, params: unknown[] = []) => ({ get: { operationId: id, tags: ["Account"], summary, description, security: [{ BillingApiKey: [] }], parameters: params,
    responses: { "200": { description: summary, content: json(success({ type: "object" }), { success: true, data, meta: { requestId: "example-request" } }) }, "401": errors["401"] } } });
  paths[accountBasePath + "/balance"] = acctOp("account_balance", "Prepaid credit balance and subscription allowance", "The calling API key's account: available prepaid credit and the current subscription period's included/used/remaining allowance.",
    { accountId: "acct_…", status: "active", credits: { available: "12.40", currency: "USD" }, subscription: { id: "sub_…", plan: "developer", periodStartsAt: "2026-09-01T00:00:00.000Z", periodEndsAt: "2026-10-01T00:00:00.000Z", included: "10.00", used: "3.25", remaining: "6.75", currency: "USD" } });
  paths[accountBasePath + "/usage"] = acctOp("account_usage", "Charged usage per tool", "Settled charges grouped by tool and rail since `since` (default: the current subscription period start, else the last 30 days).",
    { accountId: "acct_…", since: "2026-09-01T00:00:00.000Z", tools: [{ tool: "research_company", rail: "api_credits", calls: 4, charged: { amount: "0.60", currency: "USD" } }], total: { amount: "0.60", currency: "USD" }, subscription: null },
    [{ name: "since", in: "query", required: false, schema: { type: "string", format: "date-time" } }]);
  paths[accountBasePath + "/transactions"] = acctOp("account_transactions", "Ledger transactions (newest first)", "Every credit, debit, refund, adjustment and subscription usage entry for the account. Paginate with `before` = the last id.",
    { accountId: "acct_…", transactions: [{ id: "txn_…", requestId: "req…", tool: "research_company", type: "debit", rail: "api_credits", amount: "0.15", direction: "debit", currency: "USD", status: "settled", externalTransactionId: null, relatedTransactionId: null, createdAt: "2026-09-23T10:00:00.000Z" }], nextBefore: null },
    [{ name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } }, { name: "before", in: "query", required: false, schema: { type: "string" } }]);
  if (config.mcpRemoteEnabled) {
    paths[mcpCreditsPath] = { post: { operationId: "mcp_credits", tags: ["Agent"], summary: "Remote MCP with API-key billing (Streamable HTTP, JSON-RPC 2.0)", description: "Same tools as /mcp, but paid tools/call requests are billed to the Rafid account of the Authorization: Bearer raf_live_… key (subscription allowance, then prepaid credits). The billing result is returned in result._meta[\"com.rafidsystem/billing\"]; an idempotency key may be passed in params._meta[\"com.rafidsystem/idempotency-key\"]. /mcp itself is unchanged.", security: [{ BillingApiKey: [] }],
      requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["jsonrpc", "method"], properties: { jsonrpc: { const: "2.0" }, id: {}, method: { type: "string" }, params: { type: "object" } } } } } },
      responses: { "200": { description: "A JSON-RPC 2.0 response." }, "401": { description: "Missing or invalid Rafid API key (JSON-RPC error -32001)." } } } };
  }
}
// MPP (Machine Payments Protocol): info/status always, payment routes only when MPP_ENABLED=true.
Object.assign(paths, buildMppOpenapiPaths(config.mpp));
return {
  openapi: "3.1.0", info: { title: "Rafid Agent API", version: "0.1.0", description: "Property intelligence calculations in OMR for agents and applications. Use Authorize to set X-API-Key. Maintenance is an uncalibrated heuristic. Monetary outputs are rounded to two decimals. Aliases maintenance and maintenanceCost are mutually exclusive; comparison names must be unique." },
  tags: [
    { name: "Property", description: "Property analysis and comparison calculations." },
    { name: "Maintenance", description: "Annual maintenance reserve estimation." },
    { name: "Oman", description: "Oman/Muscat-specific property analysis using local rental/sale comparables, normalization, confidence scoring and provenance. Muscat governorate only; see GET /llms.txt for supported areas and data limitations." },
    { name: "Intelligence", description: "Rafid Agent Intelligence: company research, discovery and evidence-tiered risk signals from public web sources. Inert (no external calls) until an operator configures the relevant provider — see GET /llms.txt." },
    { name: "Risk Intelligence", description: "Global, evidence-first company risk intelligence for AI agents: company_reputation_check investigates a company in any country (registry identity, sanctions-list name screening, adverse media with legal stage, customer reputation, online presence, stability, domain signals) and returns evidence-linked scores with a separate confidence score. business_risk_score ($0.50) answers \"is it risky to do business with this company?\": a deterministic 0–100 risk score (100 = highest detected risk) across corporate, financial, compliance, reputation, operational and digital risk, a separate confidence, evidence-backed risk flags and a machine-readable due-diligence action. Screening only — not a legal or compliance determination." },
    { name: "Finance", description: "invoice_anomaly_check ($0.25): deterministic pre-payment invoice anomaly detection for accounts-payable agents in any country — arithmetic (quantity × unit price, subtotal, tax, total, decimal-safe with rounding tolerance), duplicate and near-duplicate invoices, supplier-history deviations (amount, currency, payment terms, invoice-number format, frequency), changed or unknown bank accounts (masked), purchase-order / contract / approval-limit issues, split-invoice patterns, date anomalies and repeated line items. Returns a transparent 0–100 risk score, risk level, advisory decision (continue / review / hold) and evidence-backed anomalies. Risk indicators only — not a fraud determination." },
    { name: "Automotive", description: "vehicle_value_estimate ($0.25): global, deterministic fair-market valuation of a passenger vehicle from comparable-market evidence — valuation range (low/mid/high), private-sale, dealer buy (trade-in) and dealer retail estimates, asking-price position with exact difference, depreciation, transparent market-derived and heuristic adjustments, weighted-similarity comparables, confidence and risk flags. Provider-independent: live coverage depends on the market-data providers configured on the deployment (see each response's marketCoverage); with no usable evidence it returns status insufficient_market_data rather than a fabricated estimate." },
    { name: "Document Intelligence", description: "document_facts_extract ($0.25): converts business documents from any country (contracts, invoices, purchase orders, quotations, tenders/RFPs, leases, policies, financial reports, legal documents, CVs, company profiles) into structured, evidence-backed facts — each with a 0–1 extraction confidence and source evidence (excerpt, offsets, section, page when real). Accepts an https documentUrl (PDF with a text layer, DOCX, HTML, text; max 25 pages) or extracted text. Document content is untrusted data: embedded instructions are never followed. Unusable documents return structured errors and are not charged." },
    { name: "Procurement", description: "Procurement supplier screening for AI procurement agents: oman_supplier_check screens an Oman supplier (identity, activity, website/contact/address consistency, sanctions and public-risk indicators) before an RFQ. Screening only — not KYC/AML or vendor approval." },
    { name: "Preview", description: "Free Preview: POST " + previewBasePath + "/{capability} checks whether a paid capability has useful data/analysis available for a given input, at no cost and with no account — evidence that the paid call is worthwhile, never the paid analysis itself. Not every capability supports it; see each tool's `preview` field on GET /api/v1/capabilities." },
    { name: "Agent", description: "Public discovery, pricing and tool-catalog endpoints for AI agents and agent marketplaces." },
    ...(rails.billing ? [{ name: "Account", description: "The calling Rafid API key's billing account: prepaid credit balance, subscription allowance, usage and ledger transactions." }] : []),
    { name: "System", description: "Public discovery, health and documentation endpoints." },
    { name: "x402", description: "Pay-per-call protocol information, always available; payment-gated endpoints are settled on-chain via the x402 protocol and require no account or API key." },
    { name: "L402", description: "Pay-per-call over the Bitcoin Lightning Network via the L402 protocol (macaroon + BOLT11 invoice); no account or API key. Payment-gated endpoints exist only when L402_ENABLED=true." },
    { name: "MPP", description: "Machine Payments Protocol (HTTP 'Payment' auth scheme, https://mpp.dev): one-time charges per call and budgeted, metered sessions over Tempo payment channels; no account or API key. Payment-gated endpoints exist only when MPP_ENABLED=true." }
  ],
  servers: [{ url: "/" }], paths,
  components: { securitySchemes: {
    ApiKeyAuth: { type: "apiKey", in: "header", name: "X-API-Key", description: "Enter an active Rafid API key. Swagger UI sends it in the X-API-Key request header." },
    ...(rails.billing ? { BillingApiKey: { type: "http", scheme: "bearer", bearerFormat: "raf_live_<secret>", description: "Rafid billing API key (raf_live_… / raf_test_…). Paid calls are charged to the key's account: subscription allowance, then prepaid USD credits." } } : {})
  } }
};
}
