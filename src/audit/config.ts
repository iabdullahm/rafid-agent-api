/**
 * Revenue Conversion Audit config — read directly from process.env, exactly like
 * analytics/config.ts's getAnalyticsInternalApiKey() and revenue/config.ts's
 * getRevenueInternalApiKey(): infrastructure config, not part of the per-request Config every
 * capability's execute(input) shares (see config/env.ts — deliberately not added to envSchema
 * there).
 *
 * A DEDICATED internal key, not a reuse of ANALYTICS_INTERNAL_API_KEY or REVENUE_INTERNAL_API_KEY
 * — matching this codebase's own established precedent of scoping internal keys by blast radius
 * (see revenue/config.ts's doc comment). The audit surface's own blast radius sits between the
 * two: broader than analytics alone (it can reveal, per request, which specific calls failed to
 * convert and why, including a coarse failure category) but it never exposes a raw payment proof,
 * signature, API key, or wallet secret — the same redaction discipline as revenueRoutes.ts.
 *
 * No getAuditDatabaseUrl(): this module deliberately has no database of its own (spec section 22:
 * "never a new source of truth") — every CallAuditRecord is computed on demand from the analytics
 * repository, revenue ledger, and unified billing store this deployment already has configured.
 */
export function getAuditInternalApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = env.AUDIT_INTERNAL_API_KEY?.trim();
  return raw ? raw : null;
}
