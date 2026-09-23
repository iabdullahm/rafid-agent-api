import { z } from "zod";

/**
 * MPP (Machine Payments Protocol — https://mpp.dev, the IETF "Payment" HTTP authentication
 * scheme co-authored by Tempo and Stripe) configuration. A third payment rail next to x402 and
 * L402 — never a replacement for either.
 *
 * Inert by default: with MPP_ENABLED unset/false nothing under /api/v1/mpp/* is mounted (the
 * always-on GET /api/v1/mpp/status reports `enabled: false`), and loadConfig() refuses to start
 * with MPP enabled but misconfigured — the same fail-closed discipline as X402_ENABLED and
 * L402_ENABLED. There is never a state where MPP is "enabled" but can't issue a real challenge
 * or verify a real credential.
 *
 * Real protocol semantics this config maps onto (read from the official `mppx` SDK's source, not
 * assumed):
 *  - `charge` intent: `tempo/charge` (a TIP-20 stablecoin transfer on Tempo) and, optionally,
 *    `evm/charge` (an EIP-3009 USDC authorization on an EVM chain such as Base, settled through
 *    an x402-compatible facilitator — this deployment's existing Coinbase CDP facilitator).
 *  - `session` intent: `tempo/session` only — a TIP-1034 payment channel: the payer deposits
 *    into an escrow (the session's budget authorization), signs cumulative vouchers per call,
 *    and the payee closes/settles on-chain. No other MPP method implements `session` today.
 */

const evmAddress = /^0x[0-9a-fA-F]{40}$/;
const privateKey = /^0x[0-9a-fA-F]{64}$/;
const caip2 = /^eip155:[0-9]{1,12}$/;

export const MPP_CHARGE_METHODS = ["tempo", "evm"] as const;
export type MppChargeMethod = (typeof MPP_CHARGE_METHODS)[number];
export const MPP_MODES = ["charge", "session"] as const;
export type MppMode = (typeof MPP_MODES)[number];

/** Tempo chain ids and canonical stablecoin addresses, mirrored from mppx's own defaults
 *  (mppx/dist/tempo/internal/defaults.js) so they can be overridden by env var but are never
 *  guessed: USDC.e on Tempo mainnet, pathUSD on the Moderato testnet. */
export const TEMPO_NETWORKS = {
  tempo: { chainId: 4217, currency: "0x20C000000000000000000000b9537d11c60E8b50", asset: "USDC", testnet: false },
  "tempo-testnet": { chainId: 42431, currency: "0x20c0000000000000000000000000000000000000", asset: "pathUSD", testnet: true }
} as const;
export type TempoNetwork = keyof typeof TEMPO_NETWORKS;

/** EVM networks mppx ships known USDC asset metadata for (mppx/evm Assets.base / baseSepolia). */
export const EVM_NETWORKS = { "eip155:8453": { asset: "USDC", testnet: false }, "eip155:84532": { asset: "USDC", testnet: true } } as const;
export type EvmNetwork = keyof typeof EVM_NETWORKS;

const csv = (value: string) => value.split(",").map(s => s.trim()).filter(Boolean);

export const mppEnvSchema = z.object({
  MPP_ENABLED: z.enum(["true", "false"]).default("false"),
  /** Which MPP implementation backs the provider abstraction (billing/mpp/provider.ts). Only
   *  the official TypeScript SDK ("mppx") exists today; the field exists so a future provider
   *  (a hosted MPP service, a Stripe-only adapter) can be selected without touching the API. */
  MPP_PROVIDER: z.string().default("mppx"),
  /** Tempo network for tempo/charge and tempo/session. */
  MPP_NETWORK: z.string().default("tempo"),
  MPP_MODES: z.string().default("charge,session"),
  MPP_CHARGE_METHODS: z.string().default("tempo"),
  /** Pricing currency. Rafid prices every capability in USD (capabilities.ts CURRENCY) and MPP
   *  settles in USD stablecoins 1:1, so USD is the only accepted value. */
  MPP_CURRENCY: z.string().default("USD"),
  /** HMAC key binding every challenge to its contents (mppx `secretKey`, ≥ 32 bytes). */
  MPP_SECRET_KEY: z.string().default(""),
  /** Protection-space realm echoed in every challenge; bound into the challenge HMAC, so it must
   *  be stable across deployments (never the per-deployment VERCEL_URL mppx would auto-detect). */
  MPP_REALM: z.string().default("api.rafidsystem.com"),
  /** Tempo payee. Defaults to the address of MPP_TEMPO_PRIVATE_KEY when that is set. */
  MPP_TEMPO_RECIPIENT: z.string().default(""),
  /** Payee key for server-submitted TIP-1034 close/settle transactions (session mode only).
   *  Never logged, never returned by any endpoint. */
  MPP_TEMPO_PRIVATE_KEY: z.string().default(""),
  MPP_TEMPO_CURRENCY: z.string().default(""),
  MPP_TEMPO_RPC_URL: z.string().default(""),
  MPP_EVM_NETWORK: z.string().default("eip155:8453"),
  /** evm/charge payee; defaults to X402_WALLET_ADDRESS (the wallet x402 already settles to). */
  MPP_EVM_RECIPIENT: z.string().default(""),
  MPP_SESSION_TTL_SECONDS: z.coerce.number().int().min(60).max(30 * 24 * 3600).default(3600),
  MPP_MAX_SESSION_BUDGET_USD: z.coerce.number().positive().max(1_000_000).default(1000),
  MPP_MIN_SESSION_BUDGET_USD: z.coerce.number().positive().max(1_000_000).default(0.01),
  MPP_REQUIRE_IDEMPOTENCY: z.enum(["true", "false"]).default("true"),
  /** How long an unpaid charge/session-open challenge stays valid. */
  MPP_CHALLENGE_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),
  MPP_MCP_ENABLED: z.enum(["true", "false"]).default("false"),
  // ---- production hardening -------------------------------------------------------------
  /** Grace added to a pending session's expiry beyond its open challenge's expiry, so an open
   *  credential that was valid when the SDK accepted it always finds its session still pending. */
  MPP_PENDING_GRACE_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),
  /** Unpaid pending sessions one client (hashed IP) may hold at once. */
  MPP_MAX_PENDING_SESSIONS_PER_CLIENT: z.coerce.number().int().min(1).max(1000).default(5),
  /** POST /api/v1/mpp/sessions requests per client per minute (per instance, like every limiter here). */
  MPP_SESSION_CREATE_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(100000).default(10),
  /** Expired pending sessions that never opened a channel are purged after this many days. */
  MPP_PENDING_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  /** Lease on an in-flight settlement attempt; a crashed attempt becomes retryable after it. */
  MPP_SETTLEMENT_LEASE_SECONDS: z.coerce.number().int().min(10).max(3600).default(120),
  /** Bearer secret for GET /api/v1/mpp/internal/maintenance. Falls back to Vercel's CRON_SECRET. */
  MPP_MAINTENANCE_SECRET: z.string().default(""),
  CRON_SECRET: z.string().default("")
});

export interface MppConfig {
  enabled: boolean;
  provider: "mppx";
  modes: readonly MppMode[];
  chargeMethods: readonly MppChargeMethod[];
  currency: "USD";
  secretKey: string;
  realm: string;
  tempo: { network: TempoNetwork; chainId: number; currency: `0x${string}`; asset: string; testnet: boolean; recipient: `0x${string}` | null; privateKey: `0x${string}` | null; rpcUrl: string | null };
  evm: { network: EvmNetwork; testnet: boolean; recipient: `0x${string}` | null };
  sessionTtlSeconds: number;
  maxSessionBudgetUsd: number;
  minSessionBudgetUsd: number;
  requireIdempotency: boolean;
  challengeTtlSeconds: number;
  mcpEnabled: boolean;
  pendingGraceSeconds: number;
  maxPendingSessionsPerClient: number;
  sessionCreateRateLimitMax: number;
  pendingRetentionDays: number;
  settlementLeaseSeconds: number;
  /** Secret for the maintenance endpoint ("" = endpoint answers 503). Never exposed. */
  maintenanceSecret: string;
}

export class MppConfigError extends Error {}

/**
 * Parses and validates MPP settings. Called by loadConfig() (config/env.ts) with the same env
 * object, plus the few x402 values evm/charge reuses. Throws MppConfigError with an actionable
 * message on any misconfiguration while MPP_ENABLED=true; with MPP disabled it never throws on
 * MPP-only settings (so an unrelated deployment can't be broken by a stray MPP_* variable).
 */
export function loadMppConfig(
  env: NodeJS.ProcessEnv,
  shared: { nodeEnv: string; databaseUrl: string | undefined; x402WalletAddress: string; x402Network: string; cdpConfigured: boolean; derivePayeeAddress?: (privateKey: `0x${string}`) => `0x${string}` }
): MppConfig {
  const parsed = mppEnvSchema.safeParse(env);
  if (!parsed.success) throw new MppConfigError("Invalid MPP_* environment configuration: " + parsed.error.issues.map(i => i.path.join(".")).join(", "));
  const e = parsed.data;
  const enabled = e.MPP_ENABLED === "true";
  const modes = csv(e.MPP_MODES) as MppMode[];
  const chargeMethods = csv(e.MPP_CHARGE_METHODS) as MppChargeMethod[];
  const network = (e.MPP_NETWORK in TEMPO_NETWORKS ? e.MPP_NETWORK : "tempo") as TempoNetwork;
  const tempoDefaults = TEMPO_NETWORKS[network];
  const evmNetwork = (e.MPP_EVM_NETWORK in EVM_NETWORKS ? e.MPP_EVM_NETWORK : "eip155:8453") as EvmNetwork;
  const tempoKey = e.MPP_TEMPO_PRIVATE_KEY.trim();
  let tempoRecipient = e.MPP_TEMPO_RECIPIENT.trim();
  if (!tempoRecipient && privateKey.test(tempoKey) && shared.derivePayeeAddress) tempoRecipient = shared.derivePayeeAddress(tempoKey as `0x${string}`);
  const evmRecipient = e.MPP_EVM_RECIPIENT.trim() || shared.x402WalletAddress;
  const config: MppConfig = {
    enabled,
    provider: "mppx",
    modes,
    chargeMethods,
    currency: "USD",
    secretKey: e.MPP_SECRET_KEY,
    realm: e.MPP_REALM.trim(),
    tempo: {
      network, chainId: tempoDefaults.chainId,
      currency: (e.MPP_TEMPO_CURRENCY.trim() || tempoDefaults.currency) as `0x${string}`,
      asset: tempoDefaults.asset, testnet: tempoDefaults.testnet,
      recipient: evmAddress.test(tempoRecipient) ? tempoRecipient as `0x${string}` : null,
      privateKey: privateKey.test(tempoKey) ? tempoKey as `0x${string}` : null,
      rpcUrl: e.MPP_TEMPO_RPC_URL.trim() || null
    },
    evm: { network: evmNetwork, testnet: EVM_NETWORKS[evmNetwork].testnet, recipient: evmAddress.test(evmRecipient) ? evmRecipient as `0x${string}` : null },
    sessionTtlSeconds: e.MPP_SESSION_TTL_SECONDS,
    maxSessionBudgetUsd: e.MPP_MAX_SESSION_BUDGET_USD,
    minSessionBudgetUsd: e.MPP_MIN_SESSION_BUDGET_USD,
    requireIdempotency: e.MPP_REQUIRE_IDEMPOTENCY === "true",
    challengeTtlSeconds: e.MPP_CHALLENGE_TTL_SECONDS,
    mcpEnabled: e.MPP_MCP_ENABLED === "true",
    pendingGraceSeconds: e.MPP_PENDING_GRACE_SECONDS,
    maxPendingSessionsPerClient: e.MPP_MAX_PENDING_SESSIONS_PER_CLIENT,
    sessionCreateRateLimitMax: e.MPP_SESSION_CREATE_RATE_LIMIT_MAX,
    pendingRetentionDays: e.MPP_PENDING_RETENTION_DAYS,
    settlementLeaseSeconds: e.MPP_SETTLEMENT_LEASE_SECONDS,
    maintenanceSecret: (e.MPP_MAINTENANCE_SECRET || e.CRON_SECRET).trim()
  };
  if (!enabled) return config;

  const fail = (message: string): never => { throw new MppConfigError(message); };
  if (e.MPP_PROVIDER.trim() !== "mppx") fail(`MPP_PROVIDER must be "mppx" (the official Machine Payments Protocol TypeScript SDK); got "${e.MPP_PROVIDER}"`);
  if (!(e.MPP_NETWORK in TEMPO_NETWORKS)) fail(`MPP_NETWORK must be one of ${Object.keys(TEMPO_NETWORKS).join(", ")}`);
  if (!modes.length || modes.some(m => !MPP_MODES.includes(m))) fail(`MPP_MODES must be a comma-separated subset of ${MPP_MODES.join(",")}`);
  if (e.MPP_CURRENCY.trim().toUpperCase() !== "USD") fail("MPP_CURRENCY must be USD (every Rafid capability is priced in USD and MPP settles in USD stablecoins 1:1)");
  if (Buffer.byteLength(e.MPP_SECRET_KEY, "utf8") < 32 || /replace|changeme/i.test(e.MPP_SECRET_KEY)) fail("MPP_SECRET_KEY must be at least 32 random bytes (e.g. openssl rand -base64 32) when MPP_ENABLED=true");
  if (!config.realm) fail("MPP_REALM must not be empty");
  if (config.maintenanceSecret && Buffer.byteLength(config.maintenanceSecret, "utf8") < 16) fail("MPP_MAINTENANCE_SECRET / CRON_SECRET must be at least 16 characters when set");
  if (e.MPP_TEMPO_CURRENCY.trim() && !evmAddress.test(e.MPP_TEMPO_CURRENCY.trim())) fail("MPP_TEMPO_CURRENCY must be a 0x-prefixed TIP-20 token address");
  if (config.tempo.rpcUrl) {
    let u: URL | null = null;
    try { u = new URL(config.tempo.rpcUrl); } catch { fail("MPP_TEMPO_RPC_URL must be a valid URL"); }
    if (u && u.protocol !== "https:") fail("MPP_TEMPO_RPC_URL must use https");
  }
  if (tempoKey && !privateKey.test(tempoKey)) fail("MPP_TEMPO_PRIVATE_KEY must be a 0x-prefixed 32-byte hex private key");
  if (e.MPP_TEMPO_RECIPIENT.trim() && !evmAddress.test(e.MPP_TEMPO_RECIPIENT.trim())) fail("MPP_TEMPO_RECIPIENT must be a 0x-prefixed 40-hex-character address");

  if (modes.includes("charge")) {
    if (!chargeMethods.length || chargeMethods.some(m => !MPP_CHARGE_METHODS.includes(m))) fail(`MPP_CHARGE_METHODS must be a comma-separated subset of ${MPP_CHARGE_METHODS.join(",")}`);
    if (chargeMethods.includes("tempo") && !config.tempo.recipient) fail("MPP_TEMPO_RECIPIENT (or MPP_TEMPO_PRIVATE_KEY) is required for tempo/charge");
    if (chargeMethods.includes("evm")) {
      if (!(e.MPP_EVM_NETWORK in EVM_NETWORKS)) fail(`MPP_EVM_NETWORK must be one of ${Object.keys(EVM_NETWORKS).join(", ")}`);
      if (!caip2.test(e.MPP_EVM_NETWORK)) fail("MPP_EVM_NETWORK must be a CAIP-2 eip155 network id");
      if (!config.evm.recipient) fail("MPP_EVM_RECIPIENT (or X402_WALLET_ADDRESS) must be a valid address for evm/charge");
      // Same facilitator rule as x402 (config/env.ts): the free public facilitator only settles
      // Base Sepolia; any real-money EVM network needs the authenticated CDP facilitator.
      if (evmNetwork !== "eip155:84532" && !shared.cdpConfigured) fail(`evm/charge on ${evmNetwork} needs CDP_API_KEY_ID/CDP_API_KEY_SECRET (the public x402 facilitator only settles eip155:84532)`);
    }
  }
  if (modes.includes("session")) {
    // TIP-1034 close/settle transactions are submitted by the payee, so session mode cannot work
    // without the payee key — fail closed instead of accepting vouchers that could never settle.
    if (!config.tempo.privateKey) fail("MPP_TEMPO_PRIVATE_KEY is required for MPP session mode (the payee submits TIP-1034 close/settle transactions)");
    if (!config.tempo.recipient) fail("MPP_TEMPO_RECIPIENT could not be resolved for session mode");
    if (config.minSessionBudgetUsd > config.maxSessionBudgetUsd) fail("MPP_MIN_SESSION_BUDGET_USD must not exceed MPP_MAX_SESSION_BUDGET_USD");
  }
  // Session budgets, single-use charge credentials and idempotency keys must be shared across
  // serverless instances — an in-process store would let a credential be replayed (or a budget
  // overspent) on a different instance.
  if (shared.nodeEnv === "production" && !shared.databaseUrl && !env.MPP_DATABASE_URL) fail("MPP_ENABLED=true in production requires DATABASE_URL (or MPP_DATABASE_URL) for session/replay/idempotency persistence");
  return config;
}

/** Public, secret-free view of the MPP configuration for status/discovery endpoints. */
export function describeMppConfig(config: MppConfig) {
  return {
    enabled: config.enabled,
    provider: config.enabled ? config.provider : null,
    modes: config.enabled ? [...config.modes] : [],
    currency: config.currency,
    charge: config.enabled && config.modes.includes("charge")
      ? { methods: config.chargeMethods.map(m => m === "tempo"
          ? { method: "tempo", intent: "charge", network: config.tempo.network, chainId: config.tempo.chainId, asset: config.tempo.asset, currency: config.tempo.currency, recipient: config.tempo.recipient }
          : { method: "evm", intent: "charge", network: config.evm.network, asset: "USDC", recipient: config.evm.recipient }) }
      : null,
    session: config.enabled && config.modes.includes("session")
      ? { method: "tempo", intent: "session", network: config.tempo.network, chainId: config.tempo.chainId, asset: config.tempo.asset, currency: config.tempo.currency, recipient: config.tempo.recipient,
          ttlSeconds: config.sessionTtlSeconds, maxBudgetUsd: config.maxSessionBudgetUsd, minBudgetUsd: config.minSessionBudgetUsd, idempotencyRequired: config.requireIdempotency }
      : null,
    mcp: config.enabled && config.mcpEnabled
  };
}
