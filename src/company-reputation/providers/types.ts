import type { NormalizedCountry } from "../normalization.js";
import type { ProviderCategory, ProviderFetchResult } from "../types.js";

/** The normalized request every provider receives (never the raw API input). */
export interface ReputationQuery {
  companyName: string;
  legalName: string | null;
  /** Normalized matching key of companyName (normalization.ts). */
  nameKey: string;
  country: NormalizedCountry | null;
  website: string | null;
  domain: string | null;
  registrationNumber: string | null;
  lei: string | null;
  city: string | null;
  industry: string | null;
  /** Optional additional names to screen (trade names, former names). Used by the sanctions-list
   *  adapter only; absent for company_reputation_check, whose behaviour and cache keys are unchanged. */
  aliases?: readonly string[];
}

export type Applicability =
  | { status: "ready" }
  | { status: "not_configured" | "not_applicable"; reason: string };

export interface ProviderContext {
  now: Date;
  signal: AbortSignal;
}

/**
 * A source of normalized evidence. Providers COLLECT only: they never score, never decide whether a
 * name is a sanctions match, never label anything adverse. They must not throw for an ordinary
 * outage — return status "unavailable"/"timeout"/"rate_limited" so the investigation degrades to a
 * partial result. They must never fabricate evidence.
 */
export interface ReputationProvider {
  readonly id: string;
  readonly name: string;
  readonly category: ProviderCategory;
  /** Safe to retry once on a transient failure (idempotent GETs with no per-call fee). */
  readonly retryable: boolean;
  applicability(query: ReputationQuery): Applicability;
  /** Identity-scoped evidence-cache key for this query. */
  cacheKey(query: ReputationQuery): string;
  fetch(query: ReputationQuery, context: ProviderContext): Promise<ProviderFetchResult>;
}

export function outage(status: "unavailable" | "timeout" | "rate_limited", reason: string, requests = 1): ProviderFetchResult {
  return { status, evidence: [], reason, requests, estimatedCostUSD: 0 };
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/** Combine the runner's abort signal with a per-request timeout. */
export async function fetchWithSignal(fetchImpl: typeof fetch, url: string, init: RequestInit, signal: AbortSignal, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  }
}
