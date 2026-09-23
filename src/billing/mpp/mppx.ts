import { Challenge, Credential, Errors, Receipt, type Store } from "mppx";
import { Mppx, evm, tempo } from "mppx/server";
import { Session as TempoSession } from "mppx/tempo";
import { Assets } from "mppx/evm";
import { createClient, http, type Client } from "viem";
import { getChainId } from "viem/actions";
import { privateKeyToAccount } from "viem/accounts";
import { tempo as tempoMainnetChain, tempoModerato } from "viem/chains";
import type { MppConfig } from "./config.js";
import { microsToDecimalString } from "./types.js";
import {
  MppPaymentFailure,
  type ChannelState, type ChargeTerms, type CredentialPreview, type MppProvider, type OpenedSession, type PaymentChallenge,
  type PublicChallenge, type SessionCallTerms, type SessionOpenTerms, type SettledCharge, type SettlementResult, type VerifiedCharge
} from "./provider.js";

/**
 * MppProvider backed by `mppx` — the official TypeScript SDK for the Machine Payments Protocol
 * (https://mpp.dev/sdk/typescript, maintained in wevm/mppx with Tempo and Stripe; wire format:
 * the IETF "Payment" HTTP authentication scheme, draft-ryan-httpauth-payment).
 *
 * Only documented public SDK entry points are used:
 *  - Mppx.create({ methods, secretKey, realm }) — HMAC-bound challenges; the route handlers
 *    (mppx["tempo/charge"](…)(request) etc.) are used ONLY to mint 402 challenges.
 *  - mppx.validateCredential(…) / mppx.broadcastCredential(…) — the SDK's standalone
 *    verification API, with `request` + `scope` so the SDK itself re-derives this route's
 *    canonical payment request and rejects any credential whose amount, currency, recipient,
 *    realm, scope or expiry differs (a credential for a $0.05 tool can never pay for a $2 one).
 *  - tempo.session.charge(store, channelId, amount) — the SDK's exported primitive "so consumers
 *    can deduct from a channel outside the session() handler": Rafid meters only AFTER a tool
 *    call succeeded instead of the SDK's default pre-handler HTTP accounting.
 *  - tempo.session.settle(store, client, channelId) — server-side on-chain settlement.
 *
 * Settlement semantics (read from the SDK source, not assumed):
 *  - payer `close` credential → payee submits TIP-1034 close capturing max(spent, settled) —
 *    exactly the metered spend — and the escrow refunds the rest of the deposit.
 *  - server `settle` captures the highest SIGNED voucher, so settleSession() only submits it
 *    when that equals the metered spend (see below) and never over-captures.
 */
export class MppxProvider implements MppProvider {
  readonly name = "mppx";
  private readonly server: ReturnType<typeof Mppx.create>;
  private readonly sessionStore: Store.AtomicStore | null;
  private readonly tempoClient: (args: { chainId?: number | undefined }) => Client;
  private readonly account: ReturnType<typeof privateKeyToAccount> | null;
  /** Set by the service: receives every on-chain settle/close the SDK confirms (including ones
   *  it triggers itself), so settlement references are always recorded. */
  onSettlement: ((event: { channelId: string; reference: string; settledMicros: number; deltaMicros: number; trigger: string }) => void) | undefined;

  constructor(private readonly config: MppConfig, deps: {
    chargeStore: Store.AtomicStore;
    sessionStore: Store.AtomicStore;
    /** x402-compatible facilitator ({ verify, settle }) for evm/charge — the same authenticated
     *  Coinbase CDP (or public) facilitator client the x402 rail already uses. */
    evmFacilitator?: { verify: (...args: any[]) => Promise<any>; settle: (...args: any[]) => Promise<any> } | undefined;
  }) {
    const chain = config.tempo.chainId === tempoModerato.id ? tempoModerato : tempoMainnetChain;
    this.account = config.tempo.privateKey ? privateKeyToAccount(config.tempo.privateKey) : null;
    this.tempoClient = () => createClient({ chain, transport: http(config.tempo.rpcUrl ?? undefined), ...(this.account ? { account: this.account } : {}) });
    const methods: unknown[] = [];
    if (config.modes.includes("charge")) {
      if (config.chargeMethods.includes("tempo")) {
        methods.push(tempo.charge({
          chainId: config.tempo.chainId, currency: config.tempo.currency, recipient: config.tempo.recipient!, decimals: 6,
          store: deps.chargeStore, getClient: this.tempoClient
        } as never));
      }
      if (config.chargeMethods.includes("evm")) {
        if (!deps.evmFacilitator) throw new Error("evm/charge requires an x402 facilitator client");
        methods.push(evm.charge({
          currency: config.evm.network === "eip155:84532" ? Assets.baseSepolia.USDC : Assets.base.USDC,
          recipient: config.evm.recipient!,
          x402: { facilitator: deps.evmFacilitator as never }
        }));
      }
    }
    this.sessionStore = null;
    if (config.modes.includes("session")) {
      this.sessionStore = deps.sessionStore;
      methods.push(tempo.session({
        chainId: config.tempo.chainId, currency: config.tempo.currency, recipient: config.tempo.recipient!, decimals: 6,
        unitType: "request", store: deps.sessionStore, getClient: this.tempoClient,
        onSessionSettlement: (ctx: { txHash: string; channelId: string; trigger: string; amount: bigint; delta: bigint }) => {
          try { this.onSettlement?.({ channelId: ctx.channelId.toLowerCase(), reference: ctx.txHash, settledMicros: Number(ctx.amount), deltaMicros: Number(ctx.delta), trigger: ctx.trigger }); }
          catch { /* recording must never affect the settlement itself */ }
        },
        ...(this.account ? { account: this.account } : {})
      } as never));
    }
    this.server = Mppx.create({ methods: methods as never, secretKey: config.secretKey, realm: config.realm });
  }

  // ------------------------------------------------------------------------------------------
  // helpers
  // ------------------------------------------------------------------------------------------

  private handler(key: string): (options: Record<string, unknown>) => (request: Request) => Promise<{ status: number; challenge?: Response }> {
    const h = (this.server as unknown as Record<string, unknown>)[key];
    if (typeof h !== "function") throw new MppPaymentFailure("unavailable", `${key} is not configured`);
    return h as never;
  }

  private challengeExpiry(): string {
    return new Date(Date.now() + this.config.challengeTtlSeconds * 1000).toISOString();
  }

  private async toPaymentChallenge(response: Response): Promise<PaymentChallenge> {
    const headers: Array<[string, string]> = [];
    const wwwAuthenticate = response.headers.get("www-authenticate");
    if (wwwAuthenticate) headers.push(["WWW-Authenticate", wwwAuthenticate]);
    let wire: Challenge.Challenge[] = [];
    try { wire = Challenge.fromResponseList(response); } catch { wire = []; }
    const challenges: PublicChallenge[] = wire.map(c => ({
      id: c.id, method: c.method, intent: c.intent, realm: c.realm,
      request: { ...(c.request as Record<string, unknown>) },
      description: c.description ?? null, expires: c.expires ?? null
    }));
    let problem: Record<string, unknown> = {};
    try { problem = await response.json() as Record<string, unknown>; } catch { problem = {}; }
    return { headers, challenges, problem, wire };
  }

  private deserialize(authorization: string): Credential.Credential {
    try { return Credential.deserialize(authorization.trim()); }
    catch { throw new MppPaymentFailure("invalid", "malformed-credential"); }
  }

  private mapError(error: unknown): MppPaymentFailure {
    if (error instanceof MppPaymentFailure) return error;
    if (error instanceof Errors.PaymentError) {
      const reason = (error as { type?: string }).type?.split("/").pop() ?? error.name;
      const message = error.message.toLowerCase();
      if (error instanceof Errors.PaymentExpiredError) return new MppPaymentFailure("payment_required", reason);
      if (/replay|already (been )?used|already consumed|already redeemed/.test(message)) return new MppPaymentFailure("replayed", reason);
      if (error instanceof Errors.InsufficientBalanceError || error instanceof Errors.AmountExceedsDepositError || error instanceof Errors.PaymentInsufficientError) return new MppPaymentFailure("insufficient", reason);
      if (error instanceof Errors.ChannelClosedError || error instanceof Errors.ChannelNotFoundError) return new MppPaymentFailure("closed", reason);
      if (error instanceof Errors.InternalPaymentError) return new MppPaymentFailure("unavailable", reason);
      return new MppPaymentFailure("invalid", reason);
    }
    return new MppPaymentFailure("unavailable", "provider-error");
  }

  private chargeRequest(terms: ChargeTerms) {
    return { amount: microsToDecimalString(terms.amountMicros) };
  }

  private settledChargeFromReceipt(receipt: Receipt.Receipt, challengeId: string): SettledCharge {
    const method = receipt.method;
    const isEvm = method === "evm";
    return {
      challengeId, method,
      reference: receipt.reference,
      network: isEvm ? this.config.evm.network : `tempo:${this.config.tempo.chainId}`,
      asset: isEvm ? "USDC" : this.config.tempo.asset,
      payTo: (isEvm ? this.config.evm.recipient : this.config.tempo.recipient) ?? "",
      receiptHeader: Receipt.serialize(receipt),
      timestamp: receipt.timestamp
    };
  }

  // ------------------------------------------------------------------------------------------
  // charge
  // ------------------------------------------------------------------------------------------

  async createCharge(terms: ChargeTerms): Promise<PaymentChallenge> {
    const keys = this.config.chargeMethods.map(m => `${m}/charge`);
    const options = { ...this.chargeRequest(terms), description: terms.description, scope: terms.scope, expires: this.challengeExpiry() };
    const request = new Request(terms.url, { method: "POST" });
    let result: { status: number; challenge?: Response };
    try {
      result = keys.length === 1
        ? await this.handler(keys[0]!)(options)(request)
        : await (this.server as unknown as { compose: (...e: unknown[]) => (r: Request) => Promise<{ status: number; challenge?: Response }> })
            .compose(...keys.map(k => [k, options]))(request);
    } catch (error) { throw this.mapError(error); }
    if (result.status !== 402 || !result.challenge) throw new MppPaymentFailure("unavailable", "no-challenge");
    return this.toPaymentChallenge(result.challenge);
  }

  async verifyCharge(authorization: string, terms: ChargeTerms): Promise<VerifiedCharge> {
    const credential = this.deserialize(authorization);
    if (credential.challenge.intent !== "charge") throw new MppPaymentFailure("invalid", "wrong-intent");
    try {
      const validation = await this.server.validateCredential(credential, { request: this.chargeRequest(terms), scope: terms.scope, realm: this.config.realm });
      const source = (validation as { source?: unknown }).source;
      return { challengeId: credential.challenge.id, method: credential.challenge.method, intent: credential.challenge.intent, payer: typeof source === "string" ? source : null };
    } catch (error) { throw this.mapError(error); }
  }

  async settleCharge(authorization: string, terms: ChargeTerms): Promise<SettledCharge> {
    const credential = this.deserialize(authorization);
    try {
      const receipt = await this.server.broadcastCredential(credential, { request: this.chargeRequest(terms), scope: terms.scope, realm: this.config.realm });
      return this.settledChargeFromReceipt(receipt, credential.challenge.id);
    } catch (error) { throw this.mapError(error); }
  }

  // ------------------------------------------------------------------------------------------
  // session
  // ------------------------------------------------------------------------------------------

  previewCredential(authorization: string): CredentialPreview | null {
    let credential: Credential.Credential;
    try { credential = Credential.deserialize(authorization.trim()); } catch { return null; }
    const meta = { ...(Challenge.meta(credential.challenge) ?? {}) };
    const scope = meta._mppx_scope ?? null;
    delete meta._mppx_scope;
    const payload = (credential.payload ?? {}) as { action?: unknown; channelId?: unknown };
    return {
      challengeId: credential.challenge.id, method: credential.challenge.method, intent: credential.challenge.intent,
      scope, meta,
      action: typeof payload.action === "string" ? payload.action : null,
      channelId: typeof payload.channelId === "string" ? payload.channelId.toLowerCase() : null
    };
  }

  private openRequest(terms: SessionOpenTerms) {
    return { amount: microsToDecimalString(terms.unitAmountMicros), unitType: "request", suggestedDeposit: microsToDecimalString(terms.suggestedDepositMicros) };
  }

  async createSession(terms: SessionOpenTerms): Promise<PaymentChallenge> {
    let result: { status: number; challenge?: Response };
    try {
      result = await this.handler("tempo/session")({ ...this.openRequest(terms), scope: terms.scope, meta: terms.meta, description: terms.description, expires: this.challengeExpiry() })(new Request(terms.url, { method: "POST" }));
    } catch (error) { throw this.mapError(error); }
    if (result.status !== 402 || !result.challenge) throw new MppPaymentFailure("unavailable", "no-challenge");
    return this.toPaymentChallenge(result.challenge);
  }

  async verifySession(authorization: string, terms: SessionOpenTerms): Promise<OpenedSession> {
    const credential = this.deserialize(authorization);
    const preview = this.previewCredential(authorization);
    if (credential.challenge.intent !== "session" || preview?.action !== "open" || !preview.channelId) throw new MppPaymentFailure("invalid", "expected-open-credential");
    try {
      const receipt = await this.server.broadcastCredential(credential, { request: this.openRequest(terms), scope: terms.scope, meta: terms.meta, realm: this.config.realm }) as Receipt.Receipt & { txHash?: string };
      const channel = await this.getChannel(preview.channelId);
      if (!channel) throw new MppPaymentFailure("unavailable", "channel-not-persisted");
      return { channelId: channel.channelId, reference: receipt.txHash ?? null, depositMicros: channel.depositMicros, receiptHeader: Receipt.serialize(receipt) };
    } catch (error) { throw this.mapError(error); }
  }

  private sessionCallRequest(args: SessionCallTerms) {
    return { amount: microsToDecimalString(args.amountMicros), unitType: "request", channelId: args.channelId };
  }

  private assertVoucherFor(authorization: string, args: SessionCallTerms): Credential.Credential {
    const credential = this.deserialize(authorization);
    const preview = this.previewCredential(authorization);
    if (credential.challenge.intent !== "session" || (preview?.action !== "voucher" && preview?.action !== "topUp")) throw new MppPaymentFailure("invalid", "expected-voucher-credential");
    if (preview.channelId !== args.channelId.toLowerCase()) throw new MppPaymentFailure("invalid", "channel-mismatch");
    return credential;
  }

  async sessionCallChallenge(args: SessionCallTerms & { url: string; description: string }): Promise<PaymentChallenge> {
    let result: { status: number; challenge?: Response };
    try {
      result = await this.handler("tempo/session")({
        ...this.sessionCallRequest(args), scope: args.scope, description: args.description, expires: this.challengeExpiry()
      })(new Request(args.url, { method: "POST" }));
    } catch (error) { throw this.mapError(error); }
    if (result.status !== 402 || !result.challenge) throw new MppPaymentFailure("unavailable", "no-challenge");
    return this.toPaymentChallenge(result.challenge);
  }

  async verifySessionCall(authorization: string, args: SessionCallTerms): Promise<void> {
    const credential = this.assertVoucherFor(authorization, args);
    try {
      await this.server.validateCredential(credential, { request: this.sessionCallRequest(args), scope: args.scope, realm: this.config.realm });
    } catch (error) { throw this.mapError(error); }
  }

  async recordUsage(authorization: string, args: SessionCallTerms): Promise<{ channel: ChannelState; receiptHeader: string }> {
    if (!this.sessionStore) throw new MppPaymentFailure("unavailable", "session-mode-disabled");
    const credential = this.assertVoucherFor(authorization, args);
    try {
      // 1. Authorization: accept the voucher. No capturedRequest is passed, so the SDK's default
      //    pre-handler HTTP accounting does not run here — nothing is charged by this step.
      const receipt = await this.server.broadcastCredential(credential, { request: this.sessionCallRequest(args), scope: args.scope, realm: this.config.realm });
      // 2. Metering: atomically deduct exactly this call's price (fails, charging nothing, when the
      //    accepted voucher doesn't cover spent + price).
      const next = await tempo.session.charge(channelStoreOf(this.sessionStore) as never, args.channelId.toLowerCase() as `0x${string}`, BigInt(args.amountMicros));
      const channel = toChannelState(args.channelId.toLowerCase(), next as unknown as Record<string, unknown>);
      const chargedReceipt = { ...receipt, spent: String(channel.spentMicros) };
      return { channel, receiptHeader: Receipt.serialize(chargedReceipt as Receipt.Receipt) };
    } catch (error) { throw this.mapError(error); }
  }

  async getChannel(channelId: string): Promise<ChannelState | null> {
    if (!this.sessionStore) return null;
    const raw = await this.sessionStore.get(channelId.toLowerCase()) as Record<string, unknown> | null;
    return raw ? toChannelState(channelId.toLowerCase(), raw) : null;
  }

  async settleSession(channelId: string): Promise<SettlementResult | null> {
    if (!this.sessionStore || !this.account) return null;
    const before = await this.getChannel(channelId);
    if (!before || before.finalized) return null;
    // tempo.session.settle() submits the highest SIGNED voucher. Only settle when that equals the
    // metered spend; if a call failed after its voucher was accepted, the headroom must never be
    // captured — the payer's close credential (closeSession) captures exactly the spend instead.
    if (before.acceptedMicros !== before.spentMicros || before.spentMicros <= before.settledMicros) return null;
    try {
      const txHash = await tempo.session.settle(this.sessionStore, this.tempoClient({}) as never, channelId.toLowerCase() as `0x${string}`, { account: this.account });
      const after = await this.getChannel(channelId);
      const settledMicros = after?.settledMicros ?? before.spentMicros;
      return { reference: txHash, settledMicros, deltaMicros: settledMicros - before.settledMicros, finalized: false, ...this.sessionSettlementTarget() };
    } catch (error) { throw this.mapError(error); }
  }

  async closeSession(authorization: string, args: { channelId: string; scope: string }): Promise<SettlementResult> {
    const credential = this.deserialize(authorization);
    const preview = this.previewCredential(authorization);
    if (credential.challenge.intent !== "session" || preview?.action !== "close") throw new MppPaymentFailure("invalid", "expected-close-credential");
    if (preview.channelId !== args.channelId.toLowerCase()) throw new MppPaymentFailure("invalid", "channel-mismatch");
    const before = await this.getChannel(args.channelId);
    try {
      // A close credential may answer any challenge issued for this channel (mppx's session
      // manager answers the last one it saw); the SDK re-checks the challenge HMAC, expiry and the
      // close voucher itself, and the payee-submitted close captures max(spent, settled).
      const receipt = await this.server.broadcastCredential(credential) as Receipt.Receipt & { txHash?: string };
      const after = await this.getChannel(args.channelId);
      const settledMicros = after?.settledMicros ?? before?.spentMicros ?? 0;
      return {
        reference: receipt.txHash ?? receipt.reference, settledMicros, deltaMicros: settledMicros - (before?.settledMicros ?? 0),
        receiptHeader: Receipt.serialize(receipt), finalized: after?.finalized ?? true, ...this.sessionSettlementTarget()
      };
    } catch (error) { throw this.mapError(error); }
  }

  async readOnChainChannel(channelId: string): Promise<{ depositMicros: number; settledMicros: number; closeRequested: boolean } | null> {
    if (!this.sessionStore) return null;
    const raw = await this.sessionStore.get(channelId.toLowerCase()) as Record<string, unknown> | null;
    const escrow = typeof raw?.escrowContract === "string" ? raw.escrowContract as `0x${string}` : undefined;
    try {
      const state = await TempoSession.Precompile.Chain.getChannelState(this.tempoClient({}) as never, channelId.toLowerCase() as `0x${string}`, escrow);
      return { depositMicros: Number(state.deposit), settledMicros: Number(state.settled), closeRequested: Number(state.closeRequestedAt) !== 0 };
    } catch { throw new MppPaymentFailure("unavailable", "rpc-read-failed"); }
  }

  async probe(timeoutMs = 3000): Promise<{ reachable: boolean; chainId: number | null; reason: string | null }> {
    try {
      const chainId = await Promise.race([
        getChainId(this.tempoClient({}) as never),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs))
      ]);
      return { reachable: true, chainId, reason: chainId === this.config.tempo.chainId ? null : "chain-id-mismatch" };
    } catch (error) {
      return { reachable: false, chainId: null, reason: error instanceof Error && error.message === "timeout" ? "timeout" : "rpc-error" };
    }
  }

  private sessionSettlementTarget() {
    return { network: `tempo:${this.config.tempo.chainId}`, asset: this.config.tempo.asset, payTo: this.config.tempo.recipient ?? "" };
  }
}

const big = (v: unknown): bigint => {
  if (typeof v === "bigint") return v;
  if (typeof v === "number" && Number.isFinite(v)) return BigInt(Math.trunc(v));
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  return 0n;
};

export function toChannelState(channelId: string, raw: Record<string, unknown>): ChannelState {
  return {
    channelId,
    depositMicros: Number(big(raw.deposit)),
    acceptedMicros: Number(big(raw.highestVoucherAmount)),
    spentMicros: Number(big(raw.spent)),
    settledMicros: Number(big(raw.settledOnChain)),
    finalized: raw.finalized === true,
    closeRequested: big(raw.closeRequestedAt) !== 0n
  };
}

/** The SDK's session charge/settle helpers take its internal ChannelStore shape
 *  ({ getChannel, updateChannel, updateChannelResult }); this builds exactly that over the same
 *  atomic store the session method itself was configured with, so every mutation still goes
 *  through the one linearizable store.update(). */
function channelStoreOf(store: Store.AtomicStore) {
  return {
    async getChannel(channelId: string) { return store.get(channelId); },
    async updateChannel(channelId: string, fn: (current: unknown) => unknown) {
      return store.update(channelId, (current: unknown) => {
        const next = fn(current);
        return next ? { op: "set", value: next, result: next } : { op: "delete", result: null };
      });
    },
    async updateChannelResult(channelId: string, fn: (current: unknown) => unknown) {
      return store.update(channelId, fn as never);
    },
    waitForUpdate() { return new Promise<void>(() => undefined); }
  };
}
