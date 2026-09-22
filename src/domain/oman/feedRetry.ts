import { safeFeedFetch, FeedFetchError, type SafeFeedFetchOptions, type SafeFeedFetchResult } from "./safeFeedFetch.js";

/**
 * Production Feed Runner (Section 4): bounded exponential-backoff retry, layered on top of
 * safeFeedFetch.ts. Retries ONLY safe-to-retry failures — a network timeout/connection error, or
 * an HTTP 502/503/504 response (the server itself said "try again") — and NEVER a 4xx response or
 * any other outcome, since those indicate the request itself is wrong (bad auth, not found,
 * malformed) and repeating it identically will only fail identically.
 */

const RETRYABLE_HTTP_STATUSES = new Set([502, 503, 504]);

export interface FeedFetchWithRetryOptions extends SafeFeedFetchOptions {
  /** Total attempts, including the first — default 3 (Section 4: "Maximum 3 attempts"). */
  maxAttempts?: number;
  /** Injectable so tests exercise the real retry LOOP without real delays — defaults to a real
   *  bounded exponential backoff (200ms, 400ms, 800ms, capped at 4s). */
  delay?: (attempt: number) => Promise<void>;
}

function defaultDelay(attempt: number): Promise<void> {
  const ms = Math.min(200 * 2 ** (attempt - 1), 4000);
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function fetchFeedWithRetry(url: string, options: FeedFetchWithRetryOptions): Promise<SafeFeedFetchResult> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const delay = options.delay ?? defaultDelay;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await safeFeedFetch(url, options);
      if (RETRYABLE_HTTP_STATUSES.has(result.status) && attempt < maxAttempts) {
        await delay(attempt);
        continue;
      }
      return result;
    } catch (error) {
      lastError = error;
      const retryable = error instanceof FeedFetchError && (error.kind === "timeout" || error.kind === "network");
      if (!retryable || attempt >= maxAttempts) throw error;
      await delay(attempt);
    }
  }
  // Unreachable (the loop above always returns or throws) — satisfies TypeScript's control-flow
  // analysis and gives a sensible error if maxAttempts is ever misconfigured to 0.
  throw lastError instanceof Error ? lastError : new FeedFetchError("network", "feed request failed with no attempts made");
}
