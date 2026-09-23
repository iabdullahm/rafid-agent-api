import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { RevenueSettlementInput } from "../../revenue/types.js";
import { publicError } from "../../utils/errors.js";
import type { MppConfig } from "./config.js";
import { MppError, mppErrors, type MppErrorCode } from "./errors.js";
import { mppAudit, type MppAuditSink } from "./audit.js";
import { parseIdempotencyKey, presentSession, remainingMicros, requestHash, termsDigest } from "./metering.js";
import { MppPaymentFailure, type MppProvider, type PaymentChallenge } from "./provider.js";
import type { MppChargeRedemptionStore, MppSessionRepository } from "./sessions.js";
import { buildMppChargeSettlementRecord, buildMppSessionSettlementRecord } from "./settlement.js";
import { microsToUsd, usdToMicros, type MppSession } from "./types.js";

/**
 * MPP billing orchestration — protocol-agnostic tool execution wrapped in the MPP payment
 * lifecycle. Nothing here knows about Express or MCP (routes.ts / mcp.ts adapt requests), and
 * nothing here knows about a specific SDK (provider.ts). Tool execution itself is injected
 * (`executeTool`), so capabilities stay exactly as they are for REST, x402, L402 and MCP.
 *
 * The server is authoritative for every number: tool price comes from the capability registry
 * (BillingService/catalog.ts, never the request), budgets/spent/remaining from mpp_sessions,
 * and the payment amount a credential must cover is re-derived by the SDK from the route's own
 * request — a client-supplied price, spent or remaining value is never read.
 */

export interface MppTool {
  name: string;
  input: z.ZodType;
  execute: (input: unknown) => Promise<unknown>;
}

export interface MppResult {
  status: number;
  headers: Array<[string, string]>;
  body: Record<string, unknown>;
  /** The SDK's wire-form challenges on a 402 (for the MCP binding; never needed over HTTP,
   *  where the same challenges travel in WWW-Authenticate). */
  challengeWire?: unknown[];
  /** Set when a paid tool actually ran (success or failure) — for usage/analytics hooks. */
  executed?: { tool: string; success: boolean; data?: unknown; channel: "mpp" | "mpp-session" };
}

export interface MppServiceDeps {
  config: MppConfig;
  provider: MppProvider;
  sessions: MppSessionRepository;
  redemptions: MppChargeRedemptionStore;
  /** Capability lookup (the shared registry). */
  getTool: (name: string) => MppTool | undefined;
  /** USD price per call from the central registry (BillingService.getToolPrice). */
  priceUsd: (name: string) => number;
  audit: MppAuditSink;
  /** Revenue ledger writer (fire-and-forget, never slows the response). */
  recordSettlement: (input: RevenueSettlementInput) => void;
  now?: () => Date;
}

export const sessionCreateSchema = z.object({
  maxBudget: z.number().positive().finite(),
  currency: z.literal("USD").default("USD"),
  allowedTools: z.array(z.string().min(1).max(100)).min(1).max(100)
}).strict();

const PAYMENT_SCHEME = /^Payment\s+\S/i;
const OPEN_SCOPE = /^rafid:session-open:(mpp_[0-9a-f]{32})$/;

function problemBody(code: MppErrorCode | "INVALID_INPUT" | "INTERNAL_ERROR", message: string, requestId: string, extra: Record<string, unknown> = {}) {
  return { success: false, error: { code, message }, ...extra, meta: { requestId } };
}

export class MppService {
  private readonly now: () => Date;
  constructor(private readonly deps: MppServiceDeps) { this.now = deps.now ?? (() => new Date()); }

  get config() { return this.deps.config; }

  private hasMode(mode: "charge" | "session") { return this.deps.config.enabled && this.deps.config.modes.includes(mode); }

  private errorResult(error: MppError, requestId: string, headers: Array<[string, string]> = []): MppResult {
    return { status: error.status, headers, body: problemBody(error.code, error.message, requestId, error.details) };
  }

  private paidTool(name: string): { tool: MppTool; priceMicros: number } {
    const tool = this.deps.getTool(name);
    const price = tool ? this.deps.priceUsd(name) : 0;
    if (!tool || !(price > 0)) throw mppErrors.toolNotFound(name);
    return { tool, priceMicros: usdToMicros(price) };
  }

  private cheapestMicros(tools: readonly string[]): number {
    return Math.min(...tools.map(t => usdToMicros(this.deps.priceUsd(t))));
  }

  private paymentRequired(challenge: PaymentChallenge, body: Record<string, unknown>, requestId: string, error?: { code: MppErrorCode; message: string }): MppResult {
    return {
      status: 402,
      challengeWire: challenge.wire,
      headers: [...challenge.headers, ["Cache-Control", "no-store"]],
      body: {
        success: false,
        error: error ?? { code: "MPP_PAYMENT_REQUIRED", message: "Payment required: pay one of the offered MPP challenges (WWW-Authenticate: Payment …) and retry with 'Authorization: Payment <credential>'." },
        protocol: "mpp",
        ...body,
        currency: "USD",
        paymentRequired: true,
        challenges: challenge.challenges,
        problem: challenge.problem,
        meta: { requestId }
      }
    };
  }

  private failureToError(failure: MppPaymentFailure): { code: MppErrorCode; message: string } {
    if (failure.kind === "replayed") return { code: "MPP_PAYMENT_REPLAYED", message: "This payment credential was already used; a fresh challenge is attached." };
    if (failure.kind === "payment_required") return { code: "MPP_PAYMENT_REQUIRED", message: "The payment challenge expired; a fresh challenge is attached." };
    if (failure.kind === "closed") return { code: "MPP_SESSION_CLOSED", message: "The MPP payment channel is closed or closing." };
    if (failure.kind === "insufficient") return { code: "MPP_INVALID_PAYMENT", message: "The presented voucher does not cover this call; sign a voucher for the attached challenge." };
    return { code: "MPP_INVALID_PAYMENT", message: `The payment credential was rejected (${failure.reason}); a fresh challenge is attached.` };
  }

  private async runTool(tool: MppTool, input: unknown): Promise<{ ok: true; data: unknown } | { ok: false; status: number; error: unknown }> {
    try { return { ok: true, data: await tool.execute(input) }; }
    catch (error) { const e = publicError(error); return { ok: false, status: e.status, error: e.error }; }
  }

  // ==========================================================================================
  // charge — one-time payment for one tool call
  // ==========================================================================================

  async charge(args: { tool: string; body: unknown; authorization: string | undefined; url: string; requestId: string }): Promise<MppResult> {
    const { requestId } = args;
    if (!this.hasMode("charge")) return this.errorResult(new MppError(404, "MPP_MODE_DISABLED", "MPP charge mode is not enabled on this deployment."), requestId);
    let tool: MppTool, priceMicros: number;
    try { ({ tool, priceMicros } = this.paidTool(args.tool)); } catch (e) { return this.errorResult(e as MppError, requestId); }
    // Validate the tool input BEFORE any payment step: a request that can't succeed is never
    // challenged, never verified and never charged.
    const parsed = tool.input.safeParse(args.body);
    if (!parsed.success) { const e = publicError(parsed.error); return { status: e.status, headers: [], body: { success: false, error: e.error, meta: { requestId } } }; }
    const terms = { tool: tool.name, amountMicros: priceMicros, description: `Rafid ${tool.name} (1 call)`, scope: `rafid:charge:${tool.name}`, url: args.url };
    const describe = { mode: "charge", tool: tool.name, amount: microsToUsd(priceMicros) };

    const challenge = async (error?: { code: MppErrorCode; message: string }): Promise<MppResult> => {
      try {
        const c = await this.deps.provider.createCharge(terms);
        mppAudit(this.deps.audit, "mpp.charge.created", { requestId, tool: tool.name, amountUsd: microsToUsd(priceMicros), challengeId: c.challenges[0]?.id });
        return this.paymentRequired(c, describe, requestId, error);
      } catch { return this.errorResult(mppErrors.providerUnavailable(), requestId); }
    };

    if (!args.authorization || !PAYMENT_SCHEME.test(args.authorization)) return challenge();

    let verified;
    try { verified = await this.deps.provider.verifyCharge(args.authorization, terms); }
    catch (error) {
      const f = error instanceof MppPaymentFailure ? error : new MppPaymentFailure("unavailable", "provider-error");
      mppAudit(this.deps.audit, "mpp.payment.failed", { requestId, tool: tool.name, reason: f.reason, status: f.kind });
      if (f.kind === "unavailable") return this.errorResult(mppErrors.providerUnavailable(), requestId);
      return challenge(this.failureToError(f));
    }
    let claimed: boolean;
    try { claimed = await this.deps.redemptions.claim(verified.challengeId, tool.name); }
    catch { return this.errorResult(mppErrors.storageUnavailable(), requestId); }
    if (!claimed) {
      mppAudit(this.deps.audit, "mpp.payment.failed", { requestId, tool: tool.name, challengeId: verified.challengeId, reason: "replayed" });
      return challenge({ code: "MPP_PAYMENT_REPLAYED", message: "This payment credential was already used (or is in use by another request); a fresh challenge is attached." });
    }
    mppAudit(this.deps.audit, "mpp.charge.verified", { requestId, tool: tool.name, challengeId: verified.challengeId, method: verified.method });

    const run = await this.runTool(tool, parsed.data);
    if (!run.ok) {
      // The payment was only verified, never settled: nothing is consumed, and the payer can
      // retry the same credential (until its challenge expires).
      await this.deps.redemptions.release(verified.challengeId).catch(() => undefined);
      return { status: run.status, headers: [], body: { success: false, error: run.error, meta: { requestId } }, executed: { tool: tool.name, success: false, channel: "mpp" } };
    }

    let settled;
    try { settled = await this.deps.provider.settleCharge(args.authorization, terms); }
    catch (error) {
      const f = error instanceof MppPaymentFailure ? error : new MppPaymentFailure("unavailable", "provider-error");
      await this.deps.redemptions.release(verified.challengeId).catch(() => undefined);
      mppAudit(this.deps.audit, "mpp.payment.failed", { requestId, tool: tool.name, challengeId: verified.challengeId, reason: f.reason, status: "settlement_failed" });
      // Same rule as x402: the result of an unsettled call is withheld.
      const r = await challenge({ code: f.kind === "replayed" ? "MPP_PAYMENT_REPLAYED" : "MPP_SETTLEMENT_FAILED", message: `Payment settlement failed (${f.reason}); the tool result was withheld and nothing was charged.` });
      return { ...r, executed: { tool: tool.name, success: false, channel: "mpp" } };
    }
    await this.deps.redemptions.markRedeemed(verified.challengeId, settled.reference).catch(() => process.stderr.write("MPP markRedeemed failed\n"));
    this.deps.recordSettlement(buildMppChargeSettlementRecord({ settled, tool: tool.name, amountMicros: priceMicros, requestId, payer: verified.payer }));
    mppAudit(this.deps.audit, "mpp.charge.settled", { requestId, tool: tool.name, challengeId: verified.challengeId, method: settled.method, reference: settled.reference, amountUsd: microsToUsd(priceMicros) });
    return {
      status: 200,
      headers: [["Payment-Receipt", settled.receiptHeader]],
      body: {
        success: true, data: run.data,
        payment: { protocol: "mpp", mode: "charge", method: settled.method, network: settled.network, amount: microsToUsd(priceMicros), currency: "USD", asset: settled.asset, reference: settled.reference },
        meta: { requestId, tool: tool.name, price: microsToUsd(priceMicros), currency: "USD" }
      },
      executed: { tool: tool.name, success: true, data: run.data, channel: "mpp" }
    };
  }

  // ==========================================================================================
  // session — reusable authorization + metered usage
  // ==========================================================================================

  async createSession(args: { body: unknown; authorization: string | undefined; url: string; requestId: string }): Promise<MppResult> {
    const { requestId } = args;
    const config = this.deps.config;
    if (!this.hasMode("session")) return this.errorResult(new MppError(404, "MPP_MODE_DISABLED", "MPP session mode is not enabled on this deployment."), requestId);
    const parsed = sessionCreateSchema.safeParse(args.body);
    if (!parsed.success) { const e = publicError(parsed.error); return { status: 400, headers: [], body: { success: false, error: e.error, meta: { requestId } } }; }
    const allowedTools = [...new Set(parsed.data.allowedTools)];
    for (const t of allowedTools) {
      try { this.paidTool(t); } catch (e) { return this.errorResult(e as MppError, requestId); }
    }
    const budgetMicros = usdToMicros(parsed.data.maxBudget);
    const maxMicros = usdToMicros(config.maxSessionBudgetUsd), minMicros = usdToMicros(config.minSessionBudgetUsd);
    if (budgetMicros > maxMicros || budgetMicros < minMicros) {
      return this.errorResult(new MppError(400, "MPP_INVALID_REQUEST", `maxBudget must be between ${config.minSessionBudgetUsd} and ${config.maxSessionBudgetUsd} USD.`, { min: config.minSessionBudgetUsd, max: config.maxSessionBudgetUsd }), requestId);
    }
    const cheapest = this.cheapestMicros(allowedTools);
    if (budgetMicros < cheapest) {
      return this.errorResult(new MppError(400, "MPP_INVALID_REQUEST", "maxBudget is below the price of the cheapest allowed tool.", { cheapestToolPrice: microsToUsd(cheapest) }), requestId);
    }
    const digest = termsDigest({ maxBudgetMicros: budgetMicros, currency: "USD", allowedTools });
    const openTerms = (sessionId: string) => ({
      scope: `rafid:session-open:${sessionId}`, meta: { terms: digest }, suggestedDepositMicros: budgetMicros, unitAmountMicros: cheapest, url: args.url,
      description: `Rafid MPP session ${sessionId} (budget ${microsToUsd(budgetMicros)} USD)`
    });
    const describe = (s: MppSession) => ({ mode: "session", sessionId: s.id, status: s.status, maxBudget: microsToUsd(s.requestedBudgetMicros), allowedTools: s.allowedTools, expiresAt: s.expiresAt });
    const challengeFor = async (s: MppSession, error?: { code: MppErrorCode; message: string }): Promise<MppResult> => {
      try {
        const c = await this.deps.provider.createSession(openTerms(s.id));
        return this.paymentRequired(c, describe(s), requestId, error);
      } catch { return this.errorResult(mppErrors.providerUnavailable(), requestId); }
    };

    // ---- 1. No credential: create a pending session + an open-channel challenge ----------
    if (!args.authorization || !PAYMENT_SCHEME.test(args.authorization)) {
      let session: MppSession;
      try {
        session = await this.deps.sessions.createPending({
          requestedBudgetMicros: budgetMicros, maxBudgetMicros: budgetMicros, allowedTools, paymentProvider: this.deps.provider.name,
          paymentMethod: "tempo/session", termsDigest: digest,
          expiresAt: new Date(this.now().getTime() + config.challengeTtlSeconds * 1000).toISOString(), metadata: {}
        });
      } catch { return this.errorResult(mppErrors.storageUnavailable(), requestId); }
      mppAudit(this.deps.audit, "mpp.session.created", { requestId, sessionId: session.id, amountUsd: microsToUsd(budgetMicros), status: "pending" });
      return challengeFor(session);
    }

    // ---- 2. Open credential: bind it to the pending session it was issued for -----------
    const preview = this.deps.provider.previewCredential(args.authorization);
    const pendingId = preview?.scope ? OPEN_SCOPE.exec(preview.scope)?.[1] : undefined;
    if (!preview || !pendingId || preview.intent !== "session") {
      return this.errorResult(new MppError(400, "MPP_INVALID_PAYMENT", "Expected an MPP session 'open' credential issued by POST /api/v1/mpp/sessions."), requestId);
    }
    let session: MppSession | null;
    try { session = await this.deps.sessions.get(pendingId); } catch { return this.errorResult(mppErrors.storageUnavailable(), requestId); }
    if (!session) return this.errorResult(mppErrors.sessionNotFound(), requestId);
    // The terms the payer authorized (HMAC-bound in the challenge) must be exactly the terms in
    // this request and in the pending session — the budget/allowed tools can't be swapped.
    if (preview.meta.terms !== digest || session.termsDigest !== digest) {
      return this.errorResult(new MppError(409, "MPP_TERMS_MISMATCH", "The session terms in this request differ from the terms the payment challenge was issued for."), requestId);
    }
    // Idempotent retry of an already-completed open (e.g. the client lost the 201 response).
    if (session.status === "active" && preview.channelId && session.externalSessionId === preview.channelId) {
      const s = await this.deps.sessions.get(session.id);
      return { status: 200, headers: [], body: { success: true, data: presentSession(s ?? session, { usageByTool: {} }), idempotentReplay: true, meta: { requestId } } };
    }
    if (session.status !== "pending") return this.errorResult(new MppError(409, "MPP_SESSION_NOT_ACTIVE", `This session is ${session.status} and can no longer be opened.`, { status: session.status }), requestId);
    if (Date.parse(session.expiresAt) <= this.now().getTime()) {
      await this.deps.sessions.expireIfDue(session.id, this.now()).catch(() => undefined);
      return this.errorResult(new MppError(410, "MPP_SESSION_EXPIRED", "The session-open challenge expired; request a new session."), requestId);
    }

    let opened;
    try { opened = await this.deps.provider.verifySession(args.authorization, openTerms(session.id)); }
    catch (error) {
      const f = error instanceof MppPaymentFailure ? error : new MppPaymentFailure("unavailable", "provider-error");
      mppAudit(this.deps.audit, "mpp.payment.failed", { requestId, sessionId: session.id, reason: f.reason, status: "open_failed" });
      if (f.kind === "unavailable") return this.errorResult(mppErrors.providerUnavailable(), requestId);
      return challengeFor(session, this.failureToError(f));
    }
    const effectiveMicros = Math.min(budgetMicros, opened.depositMicros);
    const activated = await this.deps.sessions.activate(session.id, {
      externalSessionId: opened.channelId, maxBudgetMicros: effectiveMicros, authorizationReference: opened.reference,
      expiresAt: new Date(this.now().getTime() + config.sessionTtlSeconds * 1000).toISOString(),
      metadata: { depositMicros: opened.depositMicros }
    }).catch(() => null);
    if (!activated) {
      mppAudit(this.deps.audit, "mpp.payment.failed", { requestId, sessionId: session.id, channelId: opened.channelId, reason: "channel_already_bound" });
      return this.errorResult(new MppError(409, "MPP_PAYMENT_REPLAYED", "This payment channel is already bound to another session."), requestId);
    }
    mppAudit(this.deps.audit, "mpp.session.opened", { requestId, sessionId: activated.id, channelId: opened.channelId, reference: opened.reference, amountUsd: microsToUsd(effectiveMicros), status: "active" });
    return {
      status: 201,
      headers: [["Payment-Receipt", opened.receiptHeader]],
      body: { success: true, data: presentSession(activated, { usageByTool: {} }), meta: { requestId } }
    };
  }

  async getSession(args: { sessionId: string; requestId: string }): Promise<MppResult> {
    const { requestId } = args;
    if (!this.hasMode("session")) return this.errorResult(new MppError(404, "MPP_MODE_DISABLED", "MPP session mode is not enabled on this deployment."), requestId);
    let session: MppSession | null;
    try { session = await this.deps.sessions.expireIfDue(args.sessionId, this.now()); }
    catch { return this.errorResult(mppErrors.storageUnavailable(), requestId); }
    if (!session) return this.errorResult(mppErrors.sessionNotFound(), requestId);
    const usageByTool = await this.deps.sessions.usageByTool(session.id);
    const channel = session.externalSessionId ? await this.deps.provider.getChannel(session.externalSessionId).catch(() => null) : null;
    return { status: 200, headers: [], body: { success: true, data: presentSession(session, { usageByTool, channel }), meta: { requestId } } };
  }

  private statusError(session: MppSession): MppError {
    switch (session.status) {
      case "expired": return new MppError(410, "MPP_SESSION_EXPIRED", "This MPP session has expired; close it to settle, then open a new one.", { sessionId: session.id });
      case "closed": return new MppError(409, "MPP_SESSION_CLOSED", "This MPP session is closed.", { sessionId: session.id });
      case "exhausted": return new MppError(402, "MPP_SESSION_EXHAUSTED", "This MPP session's budget is exhausted.", { sessionId: session.id, remaining: microsToUsd(remainingMicros(session)), currency: "USD" });
      case "failed": return new MppError(409, "MPP_SESSION_FAILED", "This MPP session failed to open.", { sessionId: session.id });
      case "pending": return new MppError(409, "MPP_SESSION_NOT_ACTIVE", "This MPP session has not been opened yet (pay its open challenge first).", { sessionId: session.id });
      default:
        return Date.parse(session.expiresAt) <= this.now().getTime()
          ? new MppError(410, "MPP_SESSION_EXPIRED", "This MPP session has expired.", { sessionId: session.id })
          : new MppError(409, "MPP_SESSION_NOT_ACTIVE", "This MPP session is not active.", { sessionId: session.id });
    }
  }

  async callTool(args: { sessionId: string; tool: string; body: unknown; authorization: string | undefined; idempotencyKey: string | undefined; url: string; requestId: string }): Promise<MppResult> {
    const { requestId } = args;
    const config = this.deps.config;
    if (!this.hasMode("session")) return this.errorResult(new MppError(404, "MPP_MODE_DISABLED", "MPP session mode is not enabled on this deployment."), requestId);

    // 1-2. session exists and is active
    let session: MppSession | null;
    try { session = await this.deps.sessions.expireIfDue(args.sessionId, this.now()); }
    catch { return this.errorResult(mppErrors.storageUnavailable(), requestId); }
    if (!session) return this.errorResult(mppErrors.sessionNotFound(), requestId);
    if (session.status === "expired") mppAudit(this.deps.audit, "mpp.session.expired", { requestId, sessionId: session.id });
    // A session that is exhausted/closed/expired can still serve an idempotent replay of a call
    // it already charged — so status is checked after the idempotency lookup below, not here,
    // except for sessions that never became usable.
    if (session.status === "pending" || session.status === "failed") return this.errorResult(this.statusError(session), requestId);

    // 3-4. tool allowed; price from the central registry
    let tool: MppTool, priceMicros: number;
    try { ({ tool, priceMicros } = this.paidTool(args.tool)); } catch (e) { return this.errorResult(e as MppError, requestId); }
    if (!session.allowedTools.includes(tool.name)) return this.errorResult(mppErrors.toolNotAllowed(tool.name, session.allowedTools), requestId);

    // idempotency key
    let idempotencyKey = parseIdempotencyKey(args.idempotencyKey);
    if (args.idempotencyKey !== undefined && !idempotencyKey) return this.errorResult(mppErrors.idempotencyRequired(), requestId);
    if (!idempotencyKey) {
      if (config.requireIdempotency) return this.errorResult(mppErrors.idempotencyRequired(), requestId);
      idempotencyKey = `auto:${randomUUID()}`;
    }

    // 6. validate input (before anything is reserved or authorized)
    const parsed = tool.input.safeParse(args.body);
    if (!parsed.success) { const e = publicError(parsed.error); return { status: e.status, headers: [], body: { success: false, error: e.error, meta: { requestId } } }; }
    const hash = requestHash(tool.name, parsed.data);

    // 5. atomic budget reservation (row-locked; concurrent calls can never overspend)
    let reserved;
    try { reserved = await this.deps.sessions.reserve({ sessionId: session.id, toolName: tool.name, amountMicros: priceMicros, idempotencyKey, requestHash: hash, now: this.now() }); }
    catch { return this.errorResult(mppErrors.storageUnavailable(), requestId); }
    if (!reserved.ok) {
      if (reserved.reason === "not_found") return this.errorResult(mppErrors.sessionNotFound(), requestId);
      if (reserved.reason === "duplicate") {
        const e = reserved.event;
        if (e.requestHash !== hash) return this.errorResult(mppErrors.idempotencyConflict(), requestId);
        if (e.status === "reserved") return this.errorResult(mppErrors.idempotencyInProgress(), requestId);
        // Already charged: return the stored result, charge nothing.
        mppAudit(this.deps.audit, "mpp.session.call", { requestId, sessionId: session.id, tool: tool.name, idempotentReplay: true });
        return {
          status: 200, headers: [["Idempotent-Replay", "true"]],
          body: {
            success: true, data: e.response,
            usage: { sessionId: reserved.session.id, tool: e.toolName, charge: 0, originalCharge: microsToUsd(e.amountMicros), spent: microsToUsd(reserved.session.spentMicros), remaining: microsToUsd(remainingMicros(reserved.session)), calls: reserved.session.calls, idempotentReplay: true },
            meta: { requestId, tool: tool.name, price: microsToUsd(priceMicros), currency: "USD" }
          }
        };
      }
      if (reserved.reason === "status") return this.errorResult(this.statusError(reserved.session), requestId);
      mppAudit(this.deps.audit, "mpp.payment.failed", { requestId, sessionId: session.id, tool: tool.name, reason: "budget_exceeded", amountUsd: microsToUsd(priceMicros), remainingUsd: microsToUsd(remainingMicros(reserved.session)) });
      return this.errorResult(mppErrors.budgetExceeded(priceMicros, remainingMicros(reserved.session)), requestId);
    }
    const event = reserved.event;
    session = reserved.session;
    const channelId = session.externalSessionId!;
    const terms = { channelId, amountMicros: priceMicros, scope: `rafid:session:${session.id}` };
    const describe = { mode: "session", sessionId: session.id, tool: tool.name, amount: microsToUsd(priceMicros), remaining: microsToUsd(remainingMicros(session) + priceMicros) };
    const voucherChallenge = async (error?: { code: MppErrorCode; message: string }): Promise<MppResult> => {
      try {
        const c = await this.deps.provider.sessionCallChallenge({ ...terms, url: args.url, description: `Rafid ${tool.name} (1 call, session ${session!.id})` });
        return this.paymentRequired(c, describe, requestId, error);
      } catch { return this.errorResult(mppErrors.providerUnavailable(), requestId); }
    };

    // 7. payment authorization for this call: a voucher signed by the channel's payer.
    if (!args.authorization || !PAYMENT_SCHEME.test(args.authorization)) {
      await this.deps.sessions.release(event.id, "released", { reason: "payment_required" }).catch(() => undefined);
      return voucherChallenge();
    }
    try { await this.deps.provider.verifySessionCall(args.authorization, terms); }
    catch (error) {
      const f = error instanceof MppPaymentFailure ? error : new MppPaymentFailure("unavailable", "provider-error");
      await this.deps.sessions.release(event.id, "released", { reason: f.reason }).catch(() => undefined);
      mppAudit(this.deps.audit, "mpp.payment.failed", { requestId, sessionId: session.id, tool: tool.name, reason: f.reason, status: "voucher_rejected" });
      if (f.kind === "unavailable") return this.errorResult(mppErrors.providerUnavailable(), requestId);
      return voucherChallenge(this.failureToError(f));
    }
    mppAudit(this.deps.audit, "mpp.session.call", { requestId, sessionId: session.id, tool: tool.name, amountUsd: microsToUsd(priceMicros) });

    // 8. execute; meter only on success
    const run = await this.runTool(tool, parsed.data);
    if (!run.ok) {
      await this.deps.sessions.release(event.id, "failed", { reason: "tool_failed", status: run.status }).catch(() => undefined);
      return { status: run.status, headers: [], body: { success: false, error: run.error, usage: { sessionId: session.id, tool: tool.name, charge: 0 }, meta: { requestId } }, executed: { tool: tool.name, success: false, channel: "mpp-session" } };
    }
    let metered;
    try { metered = await this.deps.provider.recordUsage(args.authorization, terms); }
    catch (error) {
      const f = error instanceof MppPaymentFailure ? error : new MppPaymentFailure("unavailable", "provider-error");
      await this.deps.sessions.release(event.id, "failed", { reason: `metering_failed:${f.reason}` }).catch(() => undefined);
      mppAudit(this.deps.audit, "mpp.payment.failed", { requestId, sessionId: session.id, tool: tool.name, reason: f.reason, status: "metering_failed" });
      const r = f.kind === "unavailable" ? this.errorResult(mppErrors.providerUnavailable(), requestId) : await voucherChallenge({ ...this.failureToError(f), message: `Metering failed (${f.reason}); the tool result was withheld and nothing was charged.` });
      return { ...r, executed: { tool: tool.name, success: false, channel: "mpp-session" } };
    }

    // 9. commit Rafid's metering (spent/remaining/calls/per-tool usage + stored response)
    const cheapest = this.cheapestMicros(session.allowedTools);
    let committed: MppSession;
    try {
      ({ session: committed } = await this.deps.sessions.commit(event.id, { response: run.data, cheapestAllowedMicros: cheapest, metadata: { channelSpentMicros: metered.channel.spentMicros } }));
    } catch {
      // The channel was metered but Rafid's own record couldn't be written: the payer was charged
      // exactly the price, so the result is returned; the channel (on-chain truth) is what
      // settlement captures. Logged loudly for reconciliation.
      process.stderr.write(`MPP commit failed after metering (session ${session.id}, event ${event.id})\n`);
      committed = { ...session, spentMicros: session.spentMicros + priceMicros, reservedMicros: session.reservedMicros - priceMicros, calls: session.calls + 1 };
    }
    mppAudit(this.deps.audit, "mpp.session.usage_recorded", { requestId, sessionId: committed.id, tool: tool.name, amountUsd: microsToUsd(priceMicros), spentUsd: microsToUsd(committed.spentMicros), remainingUsd: microsToUsd(remainingMicros(committed)) });
    if (committed.status === "exhausted") mppAudit(this.deps.audit, "mpp.session.exhausted", { requestId, sessionId: committed.id, spentUsd: microsToUsd(committed.spentMicros) });
    return {
      status: 200,
      headers: [["Payment-Receipt", metered.receiptHeader]],
      body: {
        success: true, data: run.data,
        usage: { sessionId: committed.id, tool: tool.name, charge: microsToUsd(priceMicros), spent: microsToUsd(committed.spentMicros), remaining: microsToUsd(remainingMicros(committed)), calls: committed.calls, status: committed.status },
        meta: { requestId, tool: tool.name, price: microsToUsd(priceMicros), currency: "USD" }
      },
      executed: { tool: tool.name, success: true, data: run.data, channel: "mpp-session" }
    };
  }

  async closeSession(args: { sessionId: string; authorization: string | undefined; requestId: string }): Promise<MppResult> {
    const { requestId } = args;
    if (!this.hasMode("session")) return this.errorResult(new MppError(404, "MPP_MODE_DISABLED", "MPP session mode is not enabled on this deployment."), requestId);
    let closed;
    try {
      await this.deps.sessions.expireIfDue(args.sessionId, this.now());
      closed = await this.deps.sessions.close(args.sessionId, this.now());
    } catch { return this.errorResult(mppErrors.storageUnavailable(), requestId); }
    if (!closed.ok) {
      if (closed.reason === "not_found") return this.errorResult(mppErrors.sessionNotFound(), requestId);
      if (closed.reason === "busy") return this.errorResult(new MppError(409, "MPP_SESSION_BUSY", "A call on this session is still executing; retry close after it completes.", { sessionId: closed.session.id }), requestId);
      return this.errorResult(this.statusError(closed.session), requestId);
    }
    let session = closed.session;
    if (!closed.alreadyClosed) mppAudit(this.deps.audit, "mpp.session.closed", { requestId, sessionId: session.id, spentUsd: microsToUsd(session.spentMicros), status: "closed" });

    // Settlement — separate from closing: metering is final the moment the session is closed.
    const headers: Array<[string, string]> = [];
    if (session.settlementStatus !== "settled" && session.externalSessionId) {
      const channelId = session.externalSessionId;
      try {
        let result = null;
        if (args.authorization && PAYMENT_SCHEME.test(args.authorization)) {
          // Payer-initiated close: captures exactly the metered spend, refunds the rest.
          result = await this.deps.provider.closeSession(args.authorization, { channelId, scope: `rafid:session:${session.id}` });
        } else if (session.spentMicros > session.settledMicros) {
          // Server-initiated settle (only submitted by the provider when it can't over-capture).
          result = await this.deps.provider.settleSession(channelId);
        }
        if (result) {
          const record = buildMppSessionSettlementRecord({ result, sessionId: session.id, requestId });
          if (record) this.deps.recordSettlement(record);
          session = (await this.deps.sessions.updateSettlement(session.id, { settlementStatus: "settled", settlementReference: result.reference, settledMicros: result.settledMicros })) ?? session;
          mppAudit(this.deps.audit, "mpp.session.settled", { requestId, sessionId: session.id, channelId, reference: result.reference, amountUsd: microsToUsd(result.deltaMicros) });
        } else {
          const status = session.spentMicros === 0 || session.spentMicros <= session.settledMicros ? "nothing_to_settle" : "pending_payer_close";
          session = (await this.deps.sessions.updateSettlement(session.id, { settlementStatus: status })) ?? session;
          if (status === "pending_payer_close") {
            // Offer the payer a challenge to answer with its channel `close` credential.
            const c = await this.deps.provider.sessionCallChallenge({ channelId, amountMicros: this.cheapestMicros(session.allowedTools), scope: `rafid:session:${session.id}`, url: "https://" + this.deps.config.realm + `/api/v1/mpp/sessions/${session.id}/close`, description: `Close Rafid MPP session ${session.id}` }).catch(() => null);
            if (c) headers.push(...c.headers);
          }
        }
      } catch (error) {
        const f = error instanceof MppPaymentFailure ? error : new MppPaymentFailure("unavailable", "provider-error");
        session = (await this.deps.sessions.updateSettlement(session.id, { settlementStatus: "failed" }).catch(() => null)) ?? session;
        mppAudit(this.deps.audit, "mpp.payment.failed", { requestId, sessionId: session.id, reason: f.reason, status: "settlement_failed" });
      }
    } else if (!session.externalSessionId) {
      session = (await this.deps.sessions.updateSettlement(session.id, { settlementStatus: "nothing_to_settle" }).catch(() => null)) ?? session;
    }
    const usageByTool = await this.deps.sessions.usageByTool(session.id).catch(() => ({}));
    return { status: 200, headers, body: { success: true, data: presentSession(session, { usageByTool }), ...(closed.alreadyClosed ? { idempotentReplay: true } : {}), meta: { requestId } } };
  }
}
