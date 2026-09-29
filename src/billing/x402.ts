import type { RequestHandler } from "express";
import { z } from "zod";
import { x402ResourceServer, HTTPFacilitatorClient, type FacilitatorClient, type RoutesConfig } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { getDefaultAsset } from "@x402/evm";
import { paymentMiddleware } from "@x402/express";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { createFacilitatorConfig } from "@coinbase/x402";
import { capabilities } from "../domain/capabilities.js";
import type { BillingService } from "./service.js";
import type { Config } from "../config/env.js";

/** Base path for the pay-per-call x402 endpoints. No X-API-Key or customer account is required here;
 *  a valid on-chain payment (X-PAYMENT header) is the sole authorization. */
export const x402BasePath = "/api/v1/x402";
export const x402DocsPath = "/docs/x402";
export const X402_PAYMENT_GUIDANCE_VERSION = "2026-09-28.v1";

export type X402Config = Pick<Config,
  "x402Enabled" | "x402Network" | "x402WalletAddress" | "x402FacilitatorUrl" | "cdpApiKeyId" | "cdpApiKeySecret" | "cdpConfigured">;

type SupportedResponse = {
  kinds: { x402Version: number; scheme: string; network: Network; extra?: Record<string, unknown> }[];
  extensions: string[];
  signers: Record<string, string[]>;
};

const FACILITATOR_SUPPORTED_TIMEOUT_MS = 3_000;
const FACILITATOR_VERIFY_SETTLE_TIMEOUT_MS = 90_000;
const FACILITATOR_SUPPORTED_CACHE_MS = 5 * 60_000;

type FacilitatorHealth = {
  status: "not_checked" | "reachable" | "unreachable";
  latencyMs: number | null;
  errorCategory: "timeout" | "auth" | "http" | "network" | null;
  checkedAt: string | null;
};

let facilitatorHealth: FacilitatorHealth = {
  status: "not_checked", latencyMs: null, errorCategory: null, checkedAt: null
};

export function getX402FacilitatorHealth(): FacilitatorHealth {
  return { ...facilitatorHealth };
}

/**
 * Facilitator capability discovery is metadata, not payment authorization. Keep it fast and
 * cache successful responses so an unavailable /supported endpoint cannot turn every unpaid
 * request into a 90-second 502. Verify and settle still use the normal authenticated facilitator
 * client and are never replaced by the fallback below.
 */
function buildFacilitatorClient(config: X402Config): FacilitatorClient {
  const facilitatorConfig = config.cdpConfigured
    ? createFacilitatorConfig(config.cdpApiKeyId, config.cdpApiKeySecret)
    : { url: config.x402FacilitatorUrl };
  const paymentClient = new HTTPFacilitatorClient({ ...facilitatorConfig, timeoutMs: FACILITATOR_VERIFY_SETTLE_TIMEOUT_MS });
  const supportClient = new HTTPFacilitatorClient({ ...facilitatorConfig, timeoutMs: FACILITATOR_SUPPORTED_TIMEOUT_MS });
  let cached: { response: SupportedResponse; expiresAt: number } | null = null;
  const fallback: SupportedResponse = {
    kinds: [{ x402Version: 2, scheme: "exact", network: config.x402Network as Network }],
    extensions: [],
    signers: {}
  };

  return {
    verify: paymentClient.verify.bind(paymentClient),
    settle: paymentClient.settle.bind(paymentClient),
    getSupported: async () => {
      if (cached && cached.expiresAt > Date.now()) return cached.response;
      const startedAt = Date.now();
      try {
        const response = await supportClient.getSupported();
        cached = { response, expiresAt: Date.now() + FACILITATOR_SUPPORTED_CACHE_MS };
        facilitatorHealth = { status: "reachable", latencyMs: Date.now() - startedAt, errorCategory: null, checkedAt: new Date().toISOString() };
        return response;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const errorCategory = /timed out|timeout/i.test(reason) ? "timeout" : /unauthorized|forbidden|invalid key|auth/i.test(reason) ? "auth" : /\bHTTP\s+\d+|failed \(\d+\)/i.test(reason) ? "http" : "network";
        facilitatorHealth = { status: "unreachable", latencyMs: Date.now() - startedAt, errorCategory, checkedAt: new Date().toISOString() };
        console.warn(`[x402] facilitator supported metadata unavailable; using local exact/${config.x402Network} capability for 402 generation (category=${errorCategory})`);
        return cached?.response ?? fallback;
      }
    }
  };
}

/**
 * Builds the Express payment-gate middleware for the x402 pay-per-call routes. This is REAL
 * payment enforcement (not informational): paymentMiddleware, from @x402/express, verifies and
 * settles each payment against the configured facilitator (the public x402.org facilitator, or
 * Coinbase Developer Platform for networks it doesn't support) before a request reaches the
 * capability handler. See buildX402Info() below for the separate, always-on informational route.
 *
 * Mount this once via app.use(); it internally matches only the configured "METHOD path" route
 * keys and calls next() for every other request.
 */
export function buildX402Gate(config: X402Config, billing: BillingService): RequestHandler {
  // Validated as "<namespace>:<reference>" (CAIP-2) by loadConfig before this is ever called.
  const network = config.x402Network as Network;
  // The free public x402.org facilitator only settles Base Sepolia (eip155:84532) for EVM.
  // Any other network (Base mainnet included) requires an authenticated Coinbase Developer
  // Platform facilitator, which loadConfig has already confirmed is configured in that case.
  const facilitatorClient = buildFacilitatorClient(config);
  // registerExtension(bazaarResourceServerExtension) turns on Bazaar discovery-metadata
  // enrichment (e.g. filling in the HTTP `method` field at declaration time) and echoing for
  // each eligible route below that declares a `bazaar` extension via declareDiscoveryExtension() — see
  // https://docs.x402.org/extensions/bazaar. This makes each route's request/response shape
  // legible to Bazaar-aware facilitators/clients; it does not itself register Rafid with any
  // catalog. Cataloging only happens once a facilitator processes a real settled payment whose
  // PaymentPayload echoes this declaration back (facilitator-side, out of this codebase's
  // control) — see distribution/X402.md for the current status of that step.
  const resourceServer = new x402ResourceServer(facilitatorClient)
    .register(network, new ExactEvmScheme())
    .registerExtension(bazaarResourceServerExtension);
  const routes: RoutesConfig = {};
  for (const c of capabilities) {
    const paymentRequirement = billing.buildX402PaymentRequirement(c.name, network, config.x402WalletAddress as `0x${string}`);
    routes[`POST ${x402BasePath}${c.path}`] = {
      accepts: paymentRequirement,
      description: `${c.description} Paid per call via x402; no API key required.`,
      // The PAYMENT-REQUIRED header remains the standards-compatible source of truth. This
      // additive JSON body is deliberately derived from the same route requirement and gives a
      // generic agent enough information to decide whether it can pay and how to retry.
      unpaidResponseBody: context => {
        const resource = context.adapter.getUrl();
        const docs = new URL(x402DocsPath, resource).toString();
        const requestId = context.adapter.getHeader("x-rafid-request-id") ?? null;
        let assetContract: string | null = null;
        let assetDecimals: number | null = null;
        try {
          const asset = getDefaultAsset(network);
          assetContract = asset.asset;
          assetDecimals = asset.decimals;
        } catch {
          // Network validation belongs to config loading; a missing SDK asset mapping should not
          // make an otherwise valid x402 challenge impossible to render.
        }
        const amount = typeof paymentRequirement.price === "string"
          ? paymentRequirement.price.replace(/^\$/, "")
          : String(paymentRequirement.price);
        return {
          contentType: "application/json",
          body: {
            success: false,
            error: "payment_required",
            message: "This capability requires an x402 payment. Read PAYMENT-REQUIRED, pay the listed requirement, then retry the same request with X-PAYMENT.",
            protocol: "x402",
            x402Version: 2,
            guidanceVersion: X402_PAYMENT_GUIDANCE_VERSION,
            // Additive aliases for generic agents. Keep the original names above/below for
            // backwards compatibility with clients that already consume this body.
            paymentGuidanceVersion: X402_PAYMENT_GUIDANCE_VERSION,
            capability: { id: c.name, name: c.name, price: { amount, currency: "USD" } },
            payment: {
              required: true,
              protocol: "x402",
              scheme: paymentRequirement.scheme,
              network: paymentRequirement.network,
              asset: "USDC",
              assetContract,
              assetDecimals,
              payTo: paymentRequirement.payTo,
              resource,
              method: context.method,
              paymentRequiredHeader: "PAYMENT-REQUIRED"
            },
            retry: {
              action: "pay_and_retry",
              method: context.method,
              url: resource,
              header: "X-PAYMENT",
              preserveRequestBody: true,
              retrySameBody: true,
              instructions: "Use an x402-compatible client or SDK to create the payment, attach its X-PAYMENT header, and retry the same method, URL, and JSON body."
            },
            nextAction: {
              type: "pay_and_retry",
              protocol: "x402",
              method: context.method,
              url: resource,
              retrySameBody: true
            },
            clients: {
              recommended: ["@x402/fetch", "@x402/evm"],
              documentation: docs,
              javascript: { install: "npm install @x402/fetch @x402/evm", example: "Use wrapFetchWithPayment with an EVM wallet, then fetch the same endpoint and body again." },
              generic: { flow: ["parse PAYMENT-REQUIRED", "select the exact x402 requirement", "create payment proof", "retry unchanged request with X-PAYMENT"] }
            },
            docs,
            requestId,
            paymentSupportRequired: true,
            supportedProtocols: ["x402"],
            unsupportedClientAction: "Use an x402-compatible client or SDK; do not retry unpaid requests repeatedly."
          }
        };
      },
      // Bazaar discovery declaration: same input/output shape already published via OpenAPI
      // (z.toJSONSchema(c.input)/(c.output), the same conversion src/api/openapi.ts uses) and
      // the same hand-verified example/exampleOutput used everywhere else in this registry —
      // no second copy of a schema or example is maintained here. The exceptionally large invoice
      // schema is intentionally excluded below rather than emitting a malformed header.
      // The invoice schema is too large for a valid Bazaar declaration inside a payment header.
      // Its complete, tested contract remains available in OpenAPI and the capability registry.
      ...(c.name === "invoice_anomaly_check" ? {} : { extensions: discoveryDeclaration(c) })
    };
  }
  // syncFacilitatorOnStart (default true): the returned handler awaits the facilitator's
  // supported-kinds sync on its own first invocation, inside the normal per-request async
  // flow — this does not block app construction or add a separate startup step.
  return paymentMiddleware(routes, resourceServer);
}

/** The Bazaar declaration travels inside the base64 PAYMENT-REQUIRED header of every 402 response.
 *  Node's built-in HTTP client (undici — what @x402/fetch and most agent runtimes use) rejects
 *  response headers above 16 KB, so an oversized declaration makes the 402 challenge unreadable and
 *  the route unpayable. Budget for the declaration's JSON so the whole header stays under ~15 KB
 *  (base64 adds a third, plus the payment requirements). Routes under budget are unchanged. */
export const MAX_DISCOVERY_DECLARATION_CHARS = 10_000;

/** Full declaration (input + output schema + output example) when it fits; otherwise degrade
 *  gracefully — drop the output example, then the output entirely, then (for capabilities whose
 *  input schema alone is large, e.g. invoice_anomaly_check) the human-readable descriptions inside
 *  the input schema, then the example input. The complete schemas and examples always remain
 *  available from /openapi.json and /api/v1/capabilities. Capabilities that already fit are
 *  unaffected by the later steps. */
export function discoveryDeclaration(c: (typeof capabilities)[number]): ReturnType<typeof declareDiscoveryExtension> {
  const inputSchema = z.toJSONSchema(c.input) as Record<string, unknown>;
  const base = { bodyType: "json" as const, input: c.example as Record<string, unknown>, inputSchema };
  const outputSchema = z.toJSONSchema(c.output) as Record<string, unknown>;
  const compactInputSchema = stripDescriptions(inputSchema) as Record<string, unknown>;
  const candidates = [
    { ...base, output: { example: c.exampleOutput, schema: outputSchema } },
    { ...base, output: { schema: outputSchema } },
    base,
    { ...base, inputSchema: compactInputSchema },
    { bodyType: "json" as const, inputSchema: compactInputSchema }
  ];
  for (const candidate of candidates) {
    const declaration = declareDiscoveryExtension(candidate);
    if (JSON.stringify(declaration).length <= MAX_DISCOVERY_DECLARATION_CHARS) return declaration;
  }
  return declareDiscoveryExtension({ bodyType: "json" as const, input: minimumDiscoveryInput(c) });
}

/** Keeps Bazaar declarations valid when a full JSON Schema cannot fit in a payment header. */
function minimumDiscoveryInput(c: (typeof capabilities)[number]): Record<string, unknown> {
  if (c.name === "invoice_anomaly_check") return { invoice: { total: 0 } };
  return c.example as Record<string, unknown>;
}

/** A JSON Schema without its `description` annotations (validation keywords unchanged). */
function stripDescriptions(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripDescriptions);
  if (!node || typeof node !== "object") return node;
  return Object.fromEntries(Object.entries(node as Record<string, unknown>).filter(([k, v]) => !(k === "description" && typeof v === "string")).map(([k, v]) => [k, stripDescriptions(v)]));
}

/**
 * Protocol/pricing information for GET /api/v1/x402 — deliberately separate from the
 * paymentMiddleware-gated POST routes above (Section F). This always responds, even when
 * X402_ENABLED=false, so an agent can discover whether/how to pay without guessing or
 * hitting a 404; only the actual payment *enforcement* on the POST routes is conditional
 * on X402_ENABLED. No wallet secret is ever included — payTo is the public receiving
 * address, the same value already disclosed in every 402 response.
 */
export function buildX402Info(config: X402Config, billing: BillingService) {
  return {
    protocol: "x402",
    x402Version: 2,
    scheme: "exact" as const,
    enabled: config.x402Enabled,
    network: config.x402Enabled ? config.x402Network : null,
    payTo: config.x402Enabled ? config.x402WalletAddress : null,
    facilitator: config.x402Enabled ? (config.cdpConfigured ? "coinbase-cdp" : "public") : null,
    asset: config.x402Enabled ? "USDC" : null,
    docs: x402DocsPath,
    executionFlow: ["POST without payment", "parse PAYMENT-REQUIRED", "pay exact requirement", "retry same request with X-PAYMENT"],
    tools: capabilities.map(c => ({ name: c.name, endpoint: x402BasePath + c.path, price: billing.getToolPrice(c.name) }))
  };
}

/** Networks the free public x402.org facilitator actually settles (no real money moves there);
 *  anything else is a network where a completed payment is a real, irreversible transfer. Kept
 *  local (rather than imported from config/env.ts) because this is a display/reporting concern,
 *  not a config-validation one — duplicating the one constant is cheaper than coupling the two
 *  modules over it. */
const TEST_NETWORKS = new Set(["eip155:84532"]);

/**
 * Section F hardening: GET /api/v1/x402/status — a small, factual, always-on runtime status
 * report. It exists so a caller (or this project's own landing page) never has to *infer*
 * whether payment is really enforced from marketing copy; every field here is read directly off
 * validated config, never off a hardcoded claim, and no secret is ever included.
 *
 *  - enabled / paymentEnforcement: identical by construction. app.ts only ever constructs and
 *    mounts buildX402Gate() (the real @x402/express paymentMiddleware, wired to a real
 *    facilitator) when config.x402Enabled is true, and loadConfig() fails startup closed if the
 *    wallet address, network, facilitator URL or (for non-Sepolia networks) the CDP credentials
 *    required for that middleware to actually function are missing or malformed. There is no
 *    state where enabled=true but the gate silently isn't doing real verification, so reporting
 *    them as separate fields is not creating a fake distinction — paymentEnforcement is here
 *    because the field is part of the requested contract, not because it can diverge from
 *    `enabled` today.
 *  - mode: "disabled" when the flag is off; "testnet" when the configured network is one the
 *    public facilitator settles with no real value moving (Base Sepolia); "production" for any
 *    other configured network, where a verified payment is a real on-chain transfer.
 *  - asset: every network this codebase currently supports settles USDC by the x402 SDK's own
 *    default asset table (see @x402/evm's exact scheme) — this project never overrides the
 *    asset, so "USDC" is accurate for both eip155:84532 and eip155:8453. If a future network or
 *    an explicit asset override changes that, this must be updated alongside it.
 *  - walletConfigured: true only for a syntactically valid 0x-prefixed 40-hex-character address,
 *    independent of `enabled` (useful for a "what's left before I can turn this on" check).
 */
export function buildX402Status(config: Pick<Config, "x402Enabled" | "x402Network" | "x402WalletAddress" | "cdpConfigured">) {
  const enabled = config.x402Enabled;
  return {
    enabled,
    mode: !enabled ? "disabled" : TEST_NETWORKS.has(config.x402Network) ? "testnet" : "production",
    network: enabled ? config.x402Network : null,
    asset: enabled ? "USDC" : null,
    facilitator: enabled ? (config.cdpConfigured ? "coinbase-cdp" : "public") : null,
    walletConfigured: /^0x[0-9a-fA-F]{40}$/.test(config.x402WalletAddress),
    paymentEnforcement: enabled
  };
}
