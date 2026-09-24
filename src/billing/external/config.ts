/**
 * Configuration for the external payment-collection layer (Stripe Checkout + USDC on Base).
 * Inert by default, exactly like every other optional rail in this codebase (X402_ENABLED,
 * API_CREDITS_ENABLED, …): with no Stripe/USDC env vars set, GET /api/v1/payment-options simply
 * reports both funding methods as unavailable and the new POST routes 503 rather than being
 * silently absent — see http.ts's requireStripe()/requireUsdc() guards.
 *
 * Stripe and USDC are independently optional — a deployment can enable one, both, or neither.
 * Both require unified billing's prepaid credits to be enabled (API_CREDITS_ENABLED=true): there
 * is nothing to fund otherwise (see app.ts's wiring).
 *
 *   STRIPE_SECRET_KEY          server-only; never logged, never returned by any endpoint
 *   STRIPE_WEBHOOK_SECRET      whsec_… — required to verify webhook signatures; never exposed
 *   STRIPE_PUBLISHABLE_KEY     pk_… — safe to expose; echoed back only if a frontend needs it
 *   STRIPE_TOPUP_MIN_USD       default 5
 *   STRIPE_TOPUP_MAX_USD       default 1000
 *   STRIPE_SUCCESS_URL         Checkout Session success_url (must NOT itself fund the balance —
 *                              see service.ts's doc comment: only a verified webhook does)
 *   STRIPE_CANCEL_URL          Checkout Session cancel_url
 *
 *   BASE_RPC_URL               EVM JSON-RPC endpoint for chain id 8453 (Base mainnet)
 *   BASE_USDC_CONTRACT         the USDC ERC-20 contract address on Base
 *   TOPUP_RECEIVING_ADDRESS    the single shared wallet customers send USDC top-ups to (this
 *                              deployment has no per-customer address derivation — see
 *                              usdcTopup.ts's doc comment for the correlation strategy this
 *                              implies)
 *   TOPUP_CONFIRMATIONS        block confirmations required before a transfer counts as
 *                              confirmed (default 3)
 *   USDC_TOPUP_MIN_USD         default 5
 *   USDC_TOPUP_MAX_USD         default 1000
 *   TOPUP_EXPIRY_MINUTES       how long a USDC top-up intent stays open (default 45; suggested
 *                              range 30-60)
 *
 *   EXTERNAL_PAYMENTS_DATABASE_URL   falls back to BILLING_DATABASE_URL, then DATABASE_URL;
 *                                    required in production (balances-adjacent records must
 *                                    never live only in process memory)
 */
export interface ExternalPaymentsConfig {
  stripe: { enabled: boolean; secretKey: string | null; webhookSecret: string | null; publishableKey: string | null; minUsd: number; maxUsd: number; successUrl: string | null; cancelUrl: string | null };
  usdc: { enabled: boolean; rpcUrl: string | null; usdcContract: string | null; receivingAddress: string | null; confirmations: number; minUsd: number; maxUsd: number; chainId: 8453; network: "eip155:8453" };
  topupExpiryMinutes: number;
  databaseUrl: string | undefined;
}

function num(value: string | undefined, fallback: number, name: string, opts: { min?: number; max?: number } = {}): number {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  if (opts.min !== undefined && n < opts.min) throw new Error(`${name} must be >= ${opts.min}`);
  if (opts.max !== undefined && n > opts.max) throw new Error(`${name} must be <= ${opts.max}`);
  return n;
}

export function loadExternalPaymentsConfig(env: NodeJS.ProcessEnv, opts: { nodeEnv: string; databaseUrl?: string }): ExternalPaymentsConfig {
  const stripeSecretKey = env.STRIPE_SECRET_KEY?.trim() || null;
  const stripeWebhookSecret = env.STRIPE_WEBHOOK_SECRET?.trim() || null;
  const stripeMin = num(env.STRIPE_TOPUP_MIN_USD, 5, "STRIPE_TOPUP_MIN_USD", { min: 0.5 });
  const stripeMax = num(env.STRIPE_TOPUP_MAX_USD, 1000, "STRIPE_TOPUP_MAX_USD", { min: stripeMin });
  const usdcRpcUrl = env.BASE_RPC_URL?.trim() || null;
  const usdcContract = env.BASE_USDC_CONTRACT?.trim() || null;
  const receivingAddress = env.TOPUP_RECEIVING_ADDRESS?.trim() || null;
  const confirmations = Math.trunc(num(env.TOPUP_CONFIRMATIONS, 3, "TOPUP_CONFIRMATIONS", { min: 0, max: 100 }));
  const usdcMin = num(env.USDC_TOPUP_MIN_USD, 5, "USDC_TOPUP_MIN_USD", { min: 0.5 });
  const usdcMax = num(env.USDC_TOPUP_MAX_USD, 1000, "USDC_TOPUP_MAX_USD", { min: usdcMin });
  const topupExpiryMinutes = Math.trunc(num(env.TOPUP_EXPIRY_MINUTES, 45, "TOPUP_EXPIRY_MINUTES", { min: 5, max: 24 * 60 }));
  const databaseUrl = env.EXTERNAL_PAYMENTS_DATABASE_URL || env.BILLING_DATABASE_URL || opts.databaseUrl || undefined;
  const stripeEnabled = Boolean(stripeSecretKey && stripeWebhookSecret);
  const usdcEnabled = Boolean(usdcRpcUrl && usdcContract && receivingAddress);
  if ((stripeEnabled || usdcEnabled) && opts.nodeEnv === "production" && !databaseUrl) {
    throw new Error("Stripe/USDC top-ups in production require EXTERNAL_PAYMENTS_DATABASE_URL (or BILLING_DATABASE_URL/DATABASE_URL): payment records must never live only in process memory");
  }
  return {
    stripe: { enabled: stripeEnabled, secretKey: stripeSecretKey, webhookSecret: stripeWebhookSecret, publishableKey: env.STRIPE_PUBLISHABLE_KEY?.trim() || null, minUsd: stripeMin, maxUsd: stripeMax, successUrl: env.STRIPE_SUCCESS_URL?.trim() || null, cancelUrl: env.STRIPE_CANCEL_URL?.trim() || null },
    usdc: { enabled: usdcEnabled, rpcUrl: usdcRpcUrl, usdcContract, receivingAddress, confirmations, minUsd: usdcMin, maxUsd: usdcMax, chainId: 8453, network: "eip155:8453" },
    topupExpiryMinutes, databaseUrl
  };
}

export const disabledExternalPaymentsConfig: ExternalPaymentsConfig = {
  stripe: { enabled: false, secretKey: null, webhookSecret: null, publishableKey: null, minUsd: 5, maxUsd: 1000, successUrl: null, cancelUrl: null },
  usdc: { enabled: false, rpcUrl: null, usdcContract: null, receivingAddress: null, confirmations: 3, minUsd: 5, maxUsd: 1000, chainId: 8453, network: "eip155:8453" },
  topupExpiryMinutes: 45, databaseUrl: undefined
};
