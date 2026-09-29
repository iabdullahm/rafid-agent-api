import { loadPlans, type PlanDefinition } from "./plans.js";

/**
 * Unified billing configuration (API keys, prepaid API credits, subscriptions). Inert by
 * default, exactly like X402_ENABLED / L402_ENABLED / MPP_ENABLED: with every flag at its
 * default the canonical REST routes behave byte-for-byte as before (X-API-Key only).
 *
 *   API_CREDITS_ENABLED=true        prepaid balances on billing accounts
 *   SUBSCRIPTIONS_ENABLED=true      monthly included allowance per account
 *   API_KEY_AUTH_ENABLED=true       (default true) accept `Authorization: Bearer raf_…` keys —
 *                                   only meaningful when credits and/or subscriptions are on
 *   BILLING_DATABASE_URL            PostgreSQL for accounts/keys/ledger (falls back to DATABASE_URL);
 *                                   required in production, in-memory otherwise
 *   BILLING_ADMIN_SECRET            ≥32 chars; enables /api/internal/billing/* (503 until set)
 *   BILLING_PLANS_JSON              optional plan overrides (see plans.ts)
 *   BILLING_SUBSCRIPTION_CREDIT_FALLBACK=true   auto mode falls back from an exhausted
 *                                   allowance to prepaid credits (default true)
 *   BILLING_RESERVATION_TTL_SECONDS  pending reservations older than this are released by
 *                                   `npm run billing -- release-stale` (default 900)
 */
export interface BillingConfig {
  enabled: boolean;
  apiKeyAuthEnabled: boolean;
  apiCreditsEnabled: boolean;
  subscriptionsEnabled: boolean;
  subscriptionCreditFallback: boolean;
  databaseUrl: string | undefined;
  adminSecret: string | null;
  plans: Record<string, PlanDefinition>;
  reservationTtlSeconds: number;
}

const bool = (value: string | undefined, fallback: boolean, name: string): boolean => {
  if (value === undefined || value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be "true" or "false"`);
};

export function loadBillingConfig(env: NodeJS.ProcessEnv, opts: { nodeEnv: string; databaseUrl?: string }): BillingConfig {
  const apiCreditsEnabled = bool(env.API_CREDITS_ENABLED, false, "API_CREDITS_ENABLED");
  const subscriptionsEnabled = bool(env.SUBSCRIPTIONS_ENABLED, false, "SUBSCRIPTIONS_ENABLED");
  const apiKeyAuthEnabled = bool(env.API_KEY_AUTH_ENABLED, true, "API_KEY_AUTH_ENABLED");
  const subscriptionCreditFallback = bool(env.BILLING_SUBSCRIPTION_CREDIT_FALLBACK, true, "BILLING_SUBSCRIPTION_CREDIT_FALLBACK");
  const enabled = apiKeyAuthEnabled && (apiCreditsEnabled || subscriptionsEnabled);
  const databaseUrl = env.BILLING_DATABASE_URL || opts.databaseUrl || undefined;
  if (enabled && opts.nodeEnv === "production" && !databaseUrl) {
    throw new Error("API_CREDITS_ENABLED/SUBSCRIPTIONS_ENABLED in production require BILLING_DATABASE_URL (or DATABASE_URL): balances must never live in process memory");
  }
  const adminSecret = env.BILLING_ADMIN_SECRET?.trim() || null;
  if (adminSecret && adminSecret.length < 32) throw new Error("BILLING_ADMIN_SECRET must be at least 32 characters (openssl rand -hex 32)");
  const ttl = env.BILLING_RESERVATION_TTL_SECONDS ? Number(env.BILLING_RESERVATION_TTL_SECONDS) : 900;
  if (!Number.isInteger(ttl) || ttl < 60 || ttl > 86400) throw new Error("BILLING_RESERVATION_TTL_SECONDS must be an integer between 60 and 86400");
  return {
    enabled, apiKeyAuthEnabled, apiCreditsEnabled, subscriptionsEnabled, subscriptionCreditFallback,
    databaseUrl, adminSecret, plans: loadPlans(env.BILLING_PLANS_JSON), reservationTtlSeconds: ttl
  };
}

/** The disabled configuration — what every existing caller of createApp() gets by default. */
export const disabledBillingConfig: BillingConfig = {
  enabled: false, apiKeyAuthEnabled: true, apiCreditsEnabled: false, subscriptionsEnabled: false, subscriptionCreditFallback: true,
  databaseUrl: undefined, adminSecret: null, plans: loadPlans(undefined), reservationTtlSeconds: 900
};
