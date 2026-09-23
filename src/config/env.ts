import { z } from "zod";
import { privateKeyToAccount } from "viem/accounts";
import { loadMppConfig, MppConfigError } from "../billing/mpp/config.js";
import { loadBillingConfig } from "../billing/unified/config.js";
const evmAddress = /^0x[0-9a-fA-F]{40}$/;
const caip2Network = /^[-a-z0-9]{3,8}:[-a-zA-Z0-9]{1,32}$/;
const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  RAFID_API_KEYS: z.string().default(""), API_KEY: z.string().optional(),
  AUTH_MODE: z.enum(["env", "postgres"]).default("env"),
  DATABASE_URL: z.string().optional(),
  LOG_LEVEL: z.enum(["info", "error", "silent"]).default("info"),
  X402_ENABLED: z.enum(["true", "false"]).default("false"),
  X402_NETWORK: z.string().default("eip155:84532"), X402_WALLET_ADDRESS: z.string().default(""),
  X402_FACILITATOR_URL: z.string().default("https://x402.org/facilitator"),
  CDP_API_KEY_ID: z.string().optional(), CDP_API_KEY_SECRET: z.string().optional(),
  // L402 (Lightning HTTP 402) pay-per-call — a second, independent payment rail alongside x402.
  // Inert by default: nothing under /api/v1/l402/<tool> is mounted until L402_ENABLED=true, and
  // loadConfig() refuses to start with L402 enabled but its LND backend/root key misconfigured.
  // See src/billing/l402/ for the full design.
  L402_ENABLED: z.enum(["true", "false"]).default("false"),
  L402_NETWORK: z.enum(["mainnet", "testnet", "signet", "regtest"]).default("mainnet"),
  // Which Lightning backend creates invoices: a self-run/hosted LND node, or a Voltage Payments
  // wallet (hosted, API-key based — see src/billing/l402/voltage.ts).
  L402_BACKEND: z.enum(["lnd", "voltage"]).default("lnd"),
  VOLTAGE_API_URL: z.string().default("https://voltageapi.com/v1"),
  VOLTAGE_API_KEY: z.string().default(""),
  VOLTAGE_ORGANIZATION_ID: z.string().default(""),
  VOLTAGE_ENVIRONMENT_ID: z.string().default(""),
  VOLTAGE_WALLET_ID: z.string().default(""),
  LND_REST_URL: z.string().default(""),
  LND_INVOICE_MACAROON: z.string().default(""),
  LND_TLS_CERT: z.string().default(""),
  L402_ROOT_KEY: z.string().default(""),
  L402_INVOICE_EXPIRY_SECONDS: z.coerce.number().int().min(60).max(86400).default(600),
  L402_RATE_CACHE_MS: z.coerce.number().int().min(5000).max(3600000).default(60000),
  L402_BTC_USD_FALLBACK: z.string().default(""),
  // Remote MCP: a Streamable HTTP transport at /mcp, mounted only when this is true, sharing
  // the exact same capability registry/service layer/tool schemas as local stdio (src/mcp.ts).
  MCP_REMOTE_ENABLED: z.enum(["true", "false"]).default("true"),
  // Discovery metadata (ai-plugin.json): left blank by default rather than fabricated. See
  // src/api/manifest.ts.
  RAFID_LOGO_URL: z.string().default(""), RAFID_CONTACT_EMAIL: z.string().default(""), RAFID_LEGAL_INFO_URL: z.string().default(""),
  // Durable usage tracking (src/billing/usage.ts). "postgres" requires DATABASE_URL (the same
  // variable AUTH_MODE=postgres uses; the usage table is independent of customer auth mode).
  USAGE_REPOSITORY: z.enum(["console", "memory", "postgres"]).default("console"),
  // Rate limiting for public, unauthenticated agent endpoints (discovery, x402, remote MCP).
  // Per-process, in-memory and IP-keyed by default — see src/middleware/rateLimit.ts for why
  // that's an honest "reasonable default" rather than a distributed limiter.
  RATE_LIMIT_ENABLED: z.enum(["true", "false"]).default("true"),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).max(3600000).default(60000),
  RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(1000000).default(60),
  // Oman Business Intelligence Admin & Data Operations Dashboard (internal-only, never exposed to
  // MCP/discovery/OpenAPI — see src/api/adminRoutes.ts). All three unset means the dashboard is
  // disabled entirely (its routes 503 rather than silently having no auth — see
  // middleware/adminAuth.ts, mirroring requireInternalAuth's pattern in middleware/partnerAuth.ts).
  // ADMIN_PASSWORD_HASH is never a plaintext password — see docs/business-admin.md for how to
  // generate one (`npm run admin:hash-password -- <password>`, scrypt, one-way).
  ADMIN_USERNAME: z.string().default(""),
  ADMIN_PASSWORD_HASH: z.string().default(""),
  ADMIN_SESSION_SECRET: z.string().default(""),
  ADMIN_SESSION_TTL_MINUTES: z.coerce.number().int().min(5).max(1440).default(60),
  ADMIN_LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().min(1).max(1000).default(10),
  ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).max(3600000).default(15 * 60 * 1000)
});
/** Networks the free public x402.org facilitator actually settles for the EVM "exact" scheme.
 *  Anything else (Base mainnet included) requires an authenticated Coinbase Developer
 *  Platform facilitator via CDP_API_KEY_ID/CDP_API_KEY_SECRET. */
const PUBLIC_FACILITATOR_EVM_NETWORKS = new Set(["eip155:84532"]);
export function loadConfig(env: NodeJS.ProcessEnv = process.env, options = { requireApiKeys: true }) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) throw new Error("Invalid environment configuration; check PORT, NODE_ENV, LOG_LEVEL, X402_ENABLED and L402_* settings");
  const e = parsed.data;
  const apiKeys = (e.RAFID_API_KEYS || e.API_KEY || "").split(",").map(k => k.trim()).filter(Boolean);
  if (options.requireApiKeys && e.AUTH_MODE === "env" && e.NODE_ENV === "production") throw new Error("Production REST requires AUTH_MODE=postgres");
  if (options.requireApiKeys && e.AUTH_MODE === "postgres" && !e.DATABASE_URL) throw new Error("DATABASE_URL is required for PostgreSQL authentication");
  if (options.requireApiKeys && e.AUTH_MODE === "env" && (!apiKeys.length || apiKeys.some(k => k.length < 24 || k === "replace-with-a-random-key"))) {
    throw new Error("Set RAFID_API_KEYS to comma-separated random API keys of at least 24 characters");
  }
  const x402Enabled = e.X402_ENABLED === "true";
  if (x402Enabled && !evmAddress.test(e.X402_WALLET_ADDRESS)) {
    throw new Error("X402_WALLET_ADDRESS must be a 0x-prefixed 40-hex-character EVM address when X402_ENABLED=true");
  }
  if (x402Enabled && !caip2Network.test(e.X402_NETWORK)) {
    throw new Error("X402_NETWORK must be a CAIP-2 network id, e.g. eip155:84532 (Base Sepolia) or eip155:8453 (Base)");
  }
  if (x402Enabled) {
    let facilitatorUrl: URL;
    try { facilitatorUrl = new URL(e.X402_FACILITATOR_URL); } catch { throw new Error("X402_FACILITATOR_URL must be a valid URL"); }
    if (facilitatorUrl.protocol !== "https:") throw new Error("X402_FACILITATOR_URL must use https");
  }
  if (Boolean(e.CDP_API_KEY_ID) !== Boolean(e.CDP_API_KEY_SECRET)) {
    throw new Error("Set both CDP_API_KEY_ID and CDP_API_KEY_SECRET together, or neither");
  }
  const cdpConfigured = Boolean(e.CDP_API_KEY_ID && e.CDP_API_KEY_SECRET);
  if (x402Enabled && !PUBLIC_FACILITATOR_EVM_NETWORKS.has(e.X402_NETWORK) && !cdpConfigured) {
    throw new Error(
      `The public x402.org facilitator only settles ${[...PUBLIC_FACILITATOR_EVM_NETWORKS].join(", ")} for EVM payments; ` +
      `set CDP_API_KEY_ID and CDP_API_KEY_SECRET (from a Coinbase Developer Platform account) to use X402_NETWORK=${e.X402_NETWORK}`
    );
  }
  // L402: fail closed at startup on any misconfiguration, exactly like the x402 checks above —
  // there must never be a state where L402 is "enabled" but can't create a real invoice or
  // verify a real token.
  const l402Enabled = e.L402_ENABLED === "true";
  let l402BtcUsdFallback: number | null = null;
  if (e.L402_BTC_USD_FALLBACK) {
    const n = Number(e.L402_BTC_USD_FALLBACK);
    if (!Number.isFinite(n) || n <= 0) throw new Error("L402_BTC_USD_FALLBACK must be a positive number (USD per 1 BTC) when set");
    l402BtcUsdFallback = n;
  }
  if (l402Enabled && e.L402_BACKEND === "lnd") {
    let lndUrl: URL;
    try { lndUrl = new URL(e.LND_REST_URL); } catch { throw new Error("LND_REST_URL must be a valid URL (e.g. https://your-node.m.voltageapp.io:8080) when L402_ENABLED=true and L402_BACKEND=lnd"); }
    if (lndUrl.protocol !== "https:") throw new Error("LND_REST_URL must use https");
    if (!/^[0-9a-fA-F]{20,}$/.test(e.LND_INVOICE_MACAROON)) throw new Error("LND_INVOICE_MACAROON must be the hex-encoded invoice macaroon (invoice.macaroon) when L402_ENABLED=true and L402_BACKEND=lnd");
  }
  if (l402Enabled && e.L402_BACKEND === "voltage") {
    let voltageUrl: URL;
    try { voltageUrl = new URL(e.VOLTAGE_API_URL); } catch { throw new Error("VOLTAGE_API_URL must be a valid URL"); }
    if (voltageUrl.protocol !== "https:") throw new Error("VOLTAGE_API_URL must use https");
    const missing = (["VOLTAGE_API_KEY", "VOLTAGE_ORGANIZATION_ID", "VOLTAGE_ENVIRONMENT_ID", "VOLTAGE_WALLET_ID"] as const).filter(k => !e[k].trim());
    if (missing.length) throw new Error(`Set ${missing.join(", ")} when L402_ENABLED=true and L402_BACKEND=voltage`);
  }
  if (l402Enabled) {
    if (!/^[0-9a-fA-F]{64,}$/.test(e.L402_ROOT_KEY)) throw new Error("L402_ROOT_KEY must be at least 32 random bytes, hex-encoded (openssl rand -hex 32), when L402_ENABLED=true");
    // Single-use token enforcement must be shared across serverless instances in production — an
    // in-process redemption set would let the same paid token be replayed on another instance.
    if (e.NODE_ENV === "production" && !e.DATABASE_URL && !env.L402_DATABASE_URL) {
      throw new Error("L402_ENABLED=true in production requires DATABASE_URL (or L402_DATABASE_URL) for single-use token enforcement");
    }
  }
  if (e.USAGE_REPOSITORY === "postgres" && !e.DATABASE_URL) {
    throw new Error("DATABASE_URL is required when USAGE_REPOSITORY=postgres");
  }
  // Admin dashboard: either all three of USERNAME/PASSWORD_HASH/SESSION_SECRET are set (enabled)
  // or none are (disabled) — a partially-configured admin login is always a misconfiguration, never
  // silently half-protected. Production additionally requires a session secret long enough to be a
  // real HMAC key, and rejects the literal placeholder from .env.example.
  const adminConfiguredCount = [e.ADMIN_USERNAME, e.ADMIN_PASSWORD_HASH, e.ADMIN_SESSION_SECRET].filter(Boolean).length;
  if (adminConfiguredCount > 0 && adminConfiguredCount < 3) {
    throw new Error("Set ADMIN_USERNAME, ADMIN_PASSWORD_HASH and ADMIN_SESSION_SECRET together to enable the business admin dashboard, or leave all three unset to disable it");
  }
  const adminEnabled = adminConfiguredCount === 3;
  if (adminEnabled && e.NODE_ENV === "production") {
    if (e.ADMIN_SESSION_SECRET.length < 32) throw new Error("ADMIN_SESSION_SECRET must be at least 32 characters in production");
    if (e.ADMIN_SESSION_SECRET === "replace-with-a-random-secret") throw new Error("ADMIN_SESSION_SECRET must not be the placeholder value");
    if (!/^scrypt:[0-9a-f]+:[0-9a-f]+$/.test(e.ADMIN_PASSWORD_HASH)) throw new Error('ADMIN_PASSWORD_HASH must be a scrypt hash generated by "npm run admin:hash-password"');
  }
  // MPP (Machine Payments Protocol) — a third, independent payment rail next to x402 and L402.
  // Parsed and validated in billing/mpp/config.ts, failing closed exactly like the checks above.
  let mpp;
  try {
    mpp = loadMppConfig(env, {
      nodeEnv: e.NODE_ENV, databaseUrl: e.DATABASE_URL, x402WalletAddress: e.X402_WALLET_ADDRESS, x402Network: e.X402_NETWORK, cdpConfigured,
      derivePayeeAddress: key => privateKeyToAccount(key).address
    });
  } catch (error) {
    if (error instanceof MppConfigError) throw new Error(error.message);
    throw error;
  }
  // Unified billing (API keys, prepaid API credits, subscriptions) — inert by default; parsed and
  // validated in billing/unified/config.ts, failing closed like every rail above.
  const billing = loadBillingConfig(env, { nodeEnv: e.NODE_ENV, databaseUrl: e.DATABASE_URL });
  return { port: e.PORT, nodeEnv: e.NODE_ENV, apiKeys, authMode: e.AUTH_MODE, databaseUrl: e.DATABASE_URL, logLevel: e.LOG_LEVEL,
    x402Enabled, x402Network: e.X402_NETWORK, x402WalletAddress: e.X402_WALLET_ADDRESS, x402FacilitatorUrl: e.X402_FACILITATOR_URL,
    cdpApiKeyId: e.CDP_API_KEY_ID, cdpApiKeySecret: e.CDP_API_KEY_SECRET, cdpConfigured,
    l402Enabled, l402Network: e.L402_NETWORK, l402Backend: e.L402_BACKEND,
    voltageApiUrl: e.VOLTAGE_API_URL, voltageApiKey: e.VOLTAGE_API_KEY.trim(), voltageOrganizationId: e.VOLTAGE_ORGANIZATION_ID.trim(),
    voltageEnvironmentId: e.VOLTAGE_ENVIRONMENT_ID.trim(), voltageWalletId: e.VOLTAGE_WALLET_ID.trim(), lndRestUrl: e.LND_REST_URL, lndInvoiceMacaroon: e.LND_INVOICE_MACAROON,
    lndTlsCert: e.LND_TLS_CERT, l402RootKey: e.L402_ROOT_KEY, l402InvoiceExpirySeconds: e.L402_INVOICE_EXPIRY_SECONDS,
    l402RateCacheMs: e.L402_RATE_CACHE_MS, l402BtcUsdFallback,
    mcpRemoteEnabled: e.MCP_REMOTE_ENABLED === "true",
    logoUrl: e.RAFID_LOGO_URL, contactEmail: e.RAFID_CONTACT_EMAIL, legalInfoUrl: e.RAFID_LEGAL_INFO_URL,
    usageRepository: e.USAGE_REPOSITORY,
    rateLimitEnabled: e.RATE_LIMIT_ENABLED === "true", rateLimitWindowMs: e.RATE_LIMIT_WINDOW_MS, rateLimitMax: e.RATE_LIMIT_MAX,
    adminEnabled, adminUsername: e.ADMIN_USERNAME, adminPasswordHash: e.ADMIN_PASSWORD_HASH, adminSessionSecret: e.ADMIN_SESSION_SECRET,
    adminSessionTtlMinutes: e.ADMIN_SESSION_TTL_MINUTES,
    adminLoginRateLimitMax: e.ADMIN_LOGIN_RATE_LIMIT_MAX, adminLoginRateLimitWindowMs: e.ADMIN_LOGIN_RATE_LIMIT_WINDOW_MS,
    mpp, billing };
}
export type Config = ReturnType<typeof loadConfig>;
