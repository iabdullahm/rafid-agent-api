import type { RequestHandler } from "express";
import { z } from "zod";
import { x402ResourceServer, HTTPFacilitatorClient, type RoutesConfig } from "@x402/core/server";
import type { Network } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware } from "@x402/express";
import { declareDiscoveryExtension, bazaarResourceServerExtension } from "@x402/extensions/bazaar";
import { createFacilitatorConfig } from "@coinbase/x402";
import { capabilities } from "../domain/capabilities.js";
import type { BillingService } from "./service.js";
import type { Config } from "../config/env.js";

/** Base path for the pay-per-call x402 endpoints. No X-API-Key or customer account is required here;
 *  a valid on-chain payment (X-PAYMENT header) is the sole authorization. */
export const x402BasePath = "/api/v1/x402";

export type X402Config = Pick<Config,
  "x402Enabled" | "x402Network" | "x402WalletAddress" | "x402FacilitatorUrl" | "cdpApiKeyId" | "cdpApiKeySecret" | "cdpConfigured">;

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
  const facilitatorClient = config.cdpConfigured
    ? new HTTPFacilitatorClient(createFacilitatorConfig(config.cdpApiKeyId, config.cdpApiKeySecret))
    : new HTTPFacilitatorClient({ url: config.x402FacilitatorUrl });
  // registerExtension(bazaarResourceServerExtension) turns on Bazaar discovery-metadata
  // enrichment (e.g. filling in the HTTP `method` field at declaration time) and echoing for
  // every route below that declares a `bazaar` extension via declareDiscoveryExtension() — see
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
    routes[`POST ${x402BasePath}${c.path}`] = {
      accepts: billing.buildX402PaymentRequirement(c.name, network, config.x402WalletAddress as `0x${string}`),
      description: `${c.description} Paid per call via x402; no API key required.`,
      // Bazaar discovery declaration: same input/output shape already published via OpenAPI
      // (z.toJSONSchema(c.input)/(c.output), the same conversion src/api/openapi.ts uses) and
      // the same hand-verified example/exampleOutput used everywhere else in this registry —
      // no second copy of a schema or example is maintained here.
      extensions: discoveryDeclaration(c)
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
 *  gracefully — drop the output example, then the output entirely. The complete schemas and
 *  examples always remain available from /openapi.json and /api/v1/capabilities. */
export function discoveryDeclaration(c: (typeof capabilities)[number]): ReturnType<typeof declareDiscoveryExtension> {
  const base = { bodyType: "json" as const, input: c.example as Record<string, unknown>, inputSchema: z.toJSONSchema(c.input) as Record<string, unknown> };
  const outputSchema = z.toJSONSchema(c.output) as Record<string, unknown>;
  const candidates = [
    { ...base, output: { example: c.exampleOutput, schema: outputSchema } },
    { ...base, output: { schema: outputSchema } },
    base
  ];
  for (const candidate of candidates) {
    const declaration = declareDiscoveryExtension(candidate);
    if (JSON.stringify(declaration).length <= MAX_DISCOVERY_DECLARATION_CHARS) return declaration;
  }
  return declareDiscoveryExtension(base);
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
