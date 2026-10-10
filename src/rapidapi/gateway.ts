import type { RequestHandler } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import type { AgentCapability } from "../domain/capabilities.js";
import { RapidApiIdempotencyStore, rapidApiRequestFingerprint } from "./idempotency.js";

type GatewayOptions = {
  secret: () => string | undefined;
  enabled: () => boolean;
  repository?: RapidApiIdempotencyStore;
};
const fail = (status: number, code: string, message: string) => ({ status, body: { success: false, error: { code, message } } });
function secretMatches(actual: string | undefined, expected: string | undefined): boolean {
  if (!actual || !expected) return false;
  const a = createHash("sha256").update(actual).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}
// The factory permits isolated, fully controlled HTTP tests without connecting
// to production dependencies. Commercial execution is OFF by default.
export function createRapidApiHandler(capability: AgentCapability, options: GatewayOptions): RequestHandler {
  return async (req, res) => {
    if (!secretMatches(req.header("x-rapidapi-proxy-secret"), options.secret())) {
      res.status(401).json(fail(401, "UNAUTHORIZED", "Unauthorized gateway request").body); return;
    }
    const subscriber = req.header("x-rapidapi-user");
    const key = req.header("idempotency-key");
    if (!subscriber || !key || subscriber.length > 255 || key.length > 255) {
      res.status(400).json(fail(400, "RAPIDAPI_HEADERS_REQUIRED", "Subscriber and Idempotency-Key required").body); return;
    }
    if (!options.enabled()) {
      res.status(503).json(fail(503, "RAPIDAPI_NOT_READY", "Marketplace execution disabled pending release checks").body); return;
    }
    if (!options.repository) {
      res.status(503).json(fail(503, "RAPIDAPI_STORAGE_NOT_READY", "Durable request store unavailable").body); return;
    }
    // The gateway MUST only execute validated JSON. No charge is authorized by Rafid:
    // RapidAPI is solely responsible for gateway subscription metering.
    let input: unknown;
    try { input = capability.input.parse(req.body); }
    catch { res.status(422).json(fail(422, "INVALID_INPUT", "Capability input failed validation").body); return; }
    const fingerprint = rapidApiRequestFingerprint(capability.name, input);
    let requestId: string | undefined;
    try {
      const claim = await options.repository.claim(subscriber, key, fingerprint, capability.name);
      if (claim.kind === "conflict") { res.status(409).json(fail(409, "IDEMPOTENCY_CONFLICT", "Key reused with different request").body); return; }
      if (claim.kind === "pending") { res.setHeader("Retry-After", "5"); res.status(409).json(fail(409, "REQUEST_IN_PROGRESS", "Original request still processing").body); return; }
      if (claim.kind === "failed") { res.status(409).json(fail(409, "REQUEST_OUTCOME_UNKNOWN", "Manual reconciliation required").body); return; }
      if (claim.kind === "replay") { res.setHeader("Idempotent-Replay", "true"); res.status(claim.status).json(claim.body); return; }
      requestId = claim.requestId;
      // Side-effecting tools need a recovery protocol before being enabled.
      if (capability.sideEffects) throw new Error("Side-effecting capability not approved");
      const data = await capability.execute(input);
      const body = { success: true, data, meta: { tool: capability.name } };
      await options.repository.complete(requestId, 200, body);
      res.status(200).json(body);
    } catch {
      if (requestId) await options.repository.markFailed(requestId).catch(() => {});
      res.status(503).json(fail(503, "RAPIDAPI_EXECUTION_UNAVAILABLE", "Execution unavailable; inspect request ledger").body);
    }
  };
}
