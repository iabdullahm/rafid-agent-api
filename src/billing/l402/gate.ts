import { createHash, randomBytes } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import type { Config } from "../../config/env.js";
import type { CapabilityName } from "../catalog.js";
import { capabilities } from "../../domain/capabilities.js";
import type { LightningBackend } from "./lightning.js";
import type { BtcUsdRateProvider } from "./rates.js";
import { usdToSats } from "./rates.js";
import type { L402RedemptionStore } from "./redemptions.js";
import { decodeL402Identifier, deserializeMacaroon, encodeL402Identifier, mintMacaroon, serializeMacaroon, verifyMacaroonSignature } from "./macaroon.js";

/**
 * L402 pay-per-call (Lightning Labs' L402 protocol, formerly LSAT) — a second payment rail next
 * to x402, for agents that pay in bitcoin over Lightning instead of USDC on Base.
 *
 *   1. POST /api/v1/l402/<tool> with no Authorization header
 *        → 402, `WWW-Authenticate: L402 macaroon="<base64>", invoice="<bolt11>"`
 *   2. The client pays the invoice and receives the 32-byte preimage.
 *   3. It retries with `Authorization: L402 <macaroon>:<preimage-hex>` → 200 + the tool result.
 *
 * Verification is purely cryptographic (macaroon HMAC chain + sha256(preimage) == the payment
 * hash signed into the macaroon), so it never calls the Lightning node. Each token buys exactly
 * one successful call (see redemptions.ts); a used, expired, tampered or wrong-tool token gets a
 * fresh 402 challenge — exactly what an L402-aware client already handles by paying again.
 *
 * No secret ever leaves this module: the root key only signs, the LND macaroon lives in
 * lightning.ts, and the preimage is never logged or stored (only its public payment hash is).
 */
export const l402BasePath = "/api/v1/l402";
export const L402_SERVICE = "rafid-agent-api";

export type L402Config = Pick<Config, "l402Enabled" | "l402Network" | "l402RootKey" | "l402InvoiceExpirySeconds">;

export interface L402PaidContext {
  toolName: CapabilityName;
  paymentHashHex: string;
  amountSats: number;
  priceUsd: number;
  btcUsd: number;
}

export interface L402GateDeps {
  config: L402Config;
  backend: LightningBackend;
  rates: BtcUsdRateProvider;
  redemptions: L402RedemptionStore;
  priceUsd: (tool: CapabilityName) => number;
  now?: () => number;
  /** Fired once per 402 challenge actually issued (analytics). */
  onChallenge?: (req: Request, tool: CapabilityName, amountSats: number) => void;
  /** Fired once per paid token whose call completed successfully (revenue ledger + analytics). */
  onRedeemed?: (req: Request, res: Response, ctx: L402PaidContext) => void;
  /** Fired for a presented token that was rejected (analytics). */
  onRejected?: (req: Request, tool: CapabilityName, reason: L402RejectReason) => void;
}

export type L402RejectReason = "malformed" | "bad_signature" | "wrong_service" | "wrong_capability" | "expired" | "bad_preimage" | "already_redeemed";

interface ParsedCaveats { service: string; capability: string; expires: number; amountSats: number; priceUsd: number; btcUsd: number }

/** Every caveat Rafid mints must be present and understood — an unknown caveat fails closed
 *  (macaroon semantics: a verifier must never ignore a restriction it doesn't understand). */
function parseCaveats(caveats: readonly string[]): ParsedCaveats | null {
  const map = new Map<string, string>();
  for (const c of caveats) {
    const i = c.indexOf("=");
    if (i <= 0) return null;
    const k = c.slice(0, i).trim(), v = c.slice(i + 1).trim();
    if (map.has(k)) return null;
    map.set(k, v);
  }
  const known = ["service", "capability", "expires", "amount_sats", "price_usd", "btc_usd"];
  if (map.size !== known.length || !known.every(k => map.has(k))) return null;
  const expires = Number(map.get("expires")), amountSats = Number(map.get("amount_sats"));
  const priceUsd = Number(map.get("price_usd")), btcUsd = Number(map.get("btc_usd"));
  if (![expires, amountSats, priceUsd, btcUsd].every(Number.isFinite) || !Number.isInteger(amountSats) || amountSats < 1) return null;
  return { service: map.get("service")!, capability: map.get("capability")!, expires, amountSats, priceUsd, btcUsd };
}

/** `L402 <macaroon>[,<macaroon>...]:<preimage>` (the legacy `LSAT` scheme name is accepted too). */
export function parseL402Authorization(header: string | undefined): { macaroon: string; preimageHex: string } | null {
  if (!header) return null;
  const m = /^(?:L402|LSAT)\s+(\S+)$/i.exec(header.trim());
  if (!m) return null;
  const token = m[1]!;
  const sep = token.lastIndexOf(":");
  if (sep <= 0) return null;
  const macaroon = token.slice(0, sep).split(",")[0]!;
  const preimageHex = token.slice(sep + 1);
  return macaroon ? { macaroon, preimageHex } : null;
}

export function verifyL402Token(args: { header: string | undefined; rootKey: Buffer; tool: CapabilityName; nowMs: number }):
  | { ok: true; paymentHashHex: string; caveats: ParsedCaveats }
  | { ok: false; reason: Exclude<L402RejectReason, "already_redeemed"> } {
  const parsed = parseL402Authorization(args.header);
  if (!parsed) return { ok: false, reason: "malformed" };
  const macaroon = deserializeMacaroon(parsed.macaroon);
  if (!macaroon) return { ok: false, reason: "malformed" };
  if (!verifyMacaroonSignature(macaroon, args.rootKey)) return { ok: false, reason: "bad_signature" };
  const id = decodeL402Identifier(macaroon.identifier);
  const caveats = parseCaveats(macaroon.caveats);
  if (!id || !caveats) return { ok: false, reason: "malformed" };
  if (caveats.service !== L402_SERVICE) return { ok: false, reason: "wrong_service" };
  if (caveats.capability !== args.tool) return { ok: false, reason: "wrong_capability" };
  if (caveats.expires * 1000 <= args.nowMs) return { ok: false, reason: "expired" };
  if (!/^[0-9a-fA-F]{64}$/.test(parsed.preimageHex)) return { ok: false, reason: "bad_preimage" };
  const hash = createHash("sha256").update(Buffer.from(parsed.preimageHex, "hex")).digest();
  if (!hash.equals(id.paymentHash)) return { ok: false, reason: "bad_preimage" };
  return { ok: true, paymentHashHex: id.paymentHash.toString("hex"), caveats };
}

function errorBody(res: Response, code: string, message: string, extra: Record<string, unknown> = {}) {
  return { success: false, error: { code, message }, ...extra, meta: { requestId: res.locals.requestId } };
}

/** Per-tool middleware for POST /api/v1/l402/<tool>. On success it sets res.locals.l402 and calls
 *  next(); the capability handler runs normally after it. */
export function createL402Gate(deps: L402GateDeps): (tool: CapabilityName) => RequestHandler {
  const rootKey = Buffer.from(deps.config.l402RootKey, "hex");
  const now = () => deps.now?.() ?? Date.now();

  const challenge = async (req: Request, res: Response, tool: CapabilityName, rejected?: L402RejectReason) => {
    const priceUsd = deps.priceUsd(tool);
    const quote = await deps.rates.getRate();
    if (!quote) {
      res.status(503).json(errorBody(res, "L402_PRICING_UNAVAILABLE", "No BTC/USD rate is available right now to price this call in sats; retry shortly or use x402/API-key access."));
      return;
    }
    const amountSats = usdToSats(priceUsd, quote.btcUsd);
    let invoice;
    try {
      invoice = await deps.backend.createInvoice({ amountSats, memo: `Rafid ${tool} (1 call)`, expirySeconds: deps.config.l402InvoiceExpirySeconds });
    } catch {
      res.status(503).json(errorBody(res, "L402_LIGHTNING_UNAVAILABLE", "Could not create a Lightning invoice right now; retry shortly or use x402/API-key access."));
      return;
    }
    const expires = Math.floor(now() / 1000) + deps.config.l402InvoiceExpirySeconds + 3600;
    const macaroon = serializeMacaroon(mintMacaroon({
      rootKey, location: L402_SERVICE,
      identifier: encodeL402Identifier(invoice.paymentHash, randomBytes(32)),
      caveats: [
        `service=${L402_SERVICE}`, `capability=${tool}`, `expires=${expires}`,
        `amount_sats=${amountSats}`, `price_usd=${priceUsd}`, `btc_usd=${quote.btcUsd}`
      ]
    }));
    deps.onChallenge?.(req, tool, amountSats);
    res.setHeader("WWW-Authenticate", `L402 macaroon="${macaroon}", invoice="${invoice.paymentRequest}"`);
    if (rejected) res.setHeader("X-L402-Error", rejected);
    res.status(402).json(errorBody(res, "PAYMENT_REQUIRED", "Pay the Lightning invoice, then retry with 'Authorization: L402 <macaroon>:<preimage>'. One token buys one successful call.", {
      l402: {
        macaroon, invoice: invoice.paymentRequest, amountSats, priceUsd, currency: "BTC", network: `lightning:${deps.config.l402Network}`,
        btcUsdRate: quote.btcUsd, rateSource: quote.source, invoiceExpiresInSeconds: deps.config.l402InvoiceExpirySeconds,
        tokenValidUntil: new Date(expires * 1000).toISOString(), ...(rejected ? { previousTokenRejected: rejected } : {})
      }
    }));
  };

  return tool => async (req, res, next) => {
    try {
      const authorization = req.header("authorization");
      if (!parseL402Authorization(authorization)) { await challenge(req, res, tool); return; }
      const verdict = verifyL402Token({ header: authorization, rootKey, tool, nowMs: now() });
      if (!verdict.ok) { deps.onRejected?.(req, tool, verdict.reason); await challenge(req, res, tool, verdict.reason); return; }
      let claimed: boolean;
      try { claimed = await deps.redemptions.claim(verdict.paymentHashHex, tool); }
      catch {
        res.status(503).json(errorBody(res, "L402_STORAGE_UNAVAILABLE", "Token redemption storage is unavailable; your token was not consumed — retry shortly."));
        return;
      }
      if (!claimed) { deps.onRejected?.(req, tool, "already_redeemed"); await challenge(req, res, tool, "already_redeemed"); return; }
      const ctx: L402PaidContext = {
        toolName: tool, paymentHashHex: verdict.paymentHashHex, amountSats: verdict.caveats.amountSats,
        priceUsd: verdict.caveats.priceUsd, btcUsd: verdict.caveats.btcUsd
      };
      res.locals.l402 = ctx;
      res.on("finish", () => {
        if (res.statusCode < 400) {
          void deps.redemptions.markRedeemed(ctx.paymentHashHex).catch(() => process.stderr.write("L402 markRedeemed failed\n"));
          deps.onRedeemed?.(req, res, ctx);
        } else {
          // The payer already paid; a failed call (bad input, upstream error) must not burn the token.
          void deps.redemptions.release(ctx.paymentHashHex).catch(() => process.stderr.write("L402 release failed\n"));
        }
      });
      next();
    } catch (error) { next(error); }
  };
}

/** GET /api/v1/l402 — always mounted, like GET /api/v1/x402. Prices are the USD catalog prices;
 *  the sats amount is quoted per challenge at the live rate. */
export function buildL402Info(config: Pick<Config, "l402Enabled" | "l402Network">, priceUsd: (tool: CapabilityName) => number) {
  return {
    protocol: "L402",
    spec: "https://github.com/lightninglabs/L402",
    enabled: config.l402Enabled,
    network: config.l402Enabled ? `lightning:${config.l402Network}` : null,
    currency: "BTC",
    pricing: "Each tool's USD catalog price, converted to sats at the live BTC/USD rate when the 402 challenge is issued.",
    tokenPolicy: "One paid token buys one successful call. Failed calls do not consume the token.",
    authorization: "Authorization: L402 <macaroon>:<preimage-hex>",
    tools: capabilities.map(c => ({ name: c.name, endpoint: l402BasePath + c.path, priceUsd: priceUsd(c.name) }))
  };
}

export function buildL402Status(config: Pick<Config, "l402Enabled" | "l402Network" | "lndRestUrl" | "lndInvoiceMacaroon" | "l402RootKey">) {
  const enabled = config.l402Enabled;
  return {
    enabled,
    mode: !enabled ? "disabled" : config.l402Network === "mainnet" ? "production" : "testnet",
    network: enabled ? `lightning:${config.l402Network}` : null,
    asset: enabled ? "BTC" : null,
    backend: enabled ? "lnd" : null,
    lightningBackendConfigured: Boolean(config.lndRestUrl && config.lndInvoiceMacaroon),
    rootKeyConfigured: /^[0-9a-fA-F]{64,}$/.test(config.l402RootKey),
    paymentEnforcement: enabled
  };
}
