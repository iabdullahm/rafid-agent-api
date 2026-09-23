import { usdToMicros } from "./money.js";

/**
 * Subscription plan definitions. Internal entitlement model only — no payment processor is
 * integrated; an operator assigns a plan to an account (CLI or admin API) after collecting
 * payment however they choose.
 *
 * `allowance.type` is "usd" today (a monthly included USD credit consumed at each tool's
 * canonical price). The shape leaves room for a future `{ type: "calls", includedCalls }`
 * allowance without changing callers; it is intentionally not implemented yet.
 */
export interface PlanDefinition {
  id: string;
  name: string;
  allowance: { type: "usd"; monthlyIncludedMicros: number };
}

const DEFAULT_PLANS: Record<string, { name: string; monthlyIncludedUsd: string }> = {
  free: { name: "Free", monthlyIncludedUsd: "0" },
  developer: { name: "Developer", monthlyIncludedUsd: "10" },
  growth: { name: "Growth", monthlyIncludedUsd: "50" },
  enterprise: { name: "Enterprise", monthlyIncludedUsd: "500" }
};

/** Parses BILLING_PLANS_JSON (optional): `{"developer":{"monthlyIncludedUsd":"10"}, ...}`. Plans
 *  given there replace/extend the defaults above; the enterprise allowance can additionally be
 *  overridden per subscription at assignment time. */
export function loadPlans(json: string | undefined): Record<string, PlanDefinition> {
  let source: Record<string, { name?: string; monthlyIncludedUsd: string | number }> = { ...DEFAULT_PLANS };
  if (json && json.trim()) {
    let parsed: unknown;
    try { parsed = JSON.parse(json); } catch { throw new Error("BILLING_PLANS_JSON must be valid JSON"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("BILLING_PLANS_JSON must be an object of plan definitions");
    source = { ...source, ...(parsed as typeof source) };
  }
  const plans: Record<string, PlanDefinition> = {};
  for (const [id, def] of Object.entries(source)) {
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(id)) throw new Error(`BILLING_PLANS_JSON: invalid plan id "${id}"`);
    const micros = usdToMicros(def.monthlyIncludedUsd);
    if (micros < 0) throw new Error(`BILLING_PLANS_JSON: plan "${id}" allowance must not be negative`);
    plans[id] = { id, name: def.name ?? id, allowance: { type: "usd", monthlyIncludedMicros: micros } };
  }
  return plans;
}

/** Adds `months` calendar months in UTC, clamping the day (Jan 31 + 1 month → Feb 28/29). */
export function addMonthsUtc(date: Date, months: number): Date {
  const y = date.getUTCFullYear(), m = date.getUTCMonth() + months, d = date.getUTCDate();
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(d, lastDay), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCMilliseconds()));
}

/** The monthly billing period containing `now`, anchored on the subscription's first period
 *  start (periods roll forward automatically; there is no renewal job to run). */
export function currentPeriod(anchor: Date, now: Date): { start: Date; end: Date } {
  let start = anchor;
  let end = addMonthsUtc(anchor, 1);
  let i = 1;
  while (end.getTime() <= now.getTime() && i < 12 * 200) { start = end; i++; end = addMonthsUtc(anchor, i); }
  return { start, end };
}
