import { validateFeedUrl, type FeedUrlValidationOptions } from "./feedSecurity.js";

/**
 * Production Feed Runner (Section 3/4): the actual, bounded HTTP GET used to fetch a partner's
 * scheduled feed — timeout, response-size cap, and validated (never blindly followed) redirects,
 * layered on top of feedSecurity.ts's SSRF checks. `fetchImpl` is injectable (defaults to the
 * global `fetch`) purely so tests can supply a deterministic mock without any real network call —
 * mirrors services/ncsi/ncsiClient.ts's own `fetchImpl` pattern.
 */

export type FeedFetchErrorKind = "timeout" | "network" | "too_large" | "too_many_redirects" | "bad_redirect";

export class FeedFetchError extends Error {
  constructor(readonly kind: FeedFetchErrorKind, message: string) {
    super(message);
    this.name = "FeedFetchError";
  }
}

export interface SafeFeedFetchResult {
  status: number;
  contentType: string | null;
  body: string;
  finalUrl: string;
}

export interface SafeFeedFetchOptions extends FeedUrlValidationOptions {
  timeoutMs: number;
  maxResponseBytes: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** A single bounded GET — no retry logic here (see feedRetry.ts for that layer). Never throws for
 *  an ordinary non-2xx HTTP response (a 401, 404, 503, ...); the caller inspects `.status` itself,
 *  exactly like every other HTTP client in this codebase. Only throws a `FeedFetchError` for a
 *  transport-level problem (timeout, network failure, oversized body, an unsafe/malformed
 *  redirect) that never produced a usable response at all. */
export async function safeFeedFetch(url: string, options: SafeFeedFetchOptions): Promise<SafeFeedFetchResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const maxRedirects = options.maxRedirects ?? 3;
  let currentUrl = await validateFeedUrl(url, options);

  for (let redirectCount = 0; ; redirectCount++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(currentUrl.toString(), { method: "GET", redirect: "manual", signal: controller.signal, headers: options.headers });
    } catch (error) {
      const isAbort = error instanceof Error && error.name === "AbortError";
      throw isAbort
        ? new FeedFetchError("timeout", `feed request to ${currentUrl.hostname} timed out after ${options.timeoutMs}ms`)
        : new FeedFetchError("network", `feed request to ${currentUrl.hostname} failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new FeedFetchError("bad_redirect", `feed returned HTTP ${response.status} with no Location header`);
      if (redirectCount >= maxRedirects) throw new FeedFetchError("too_many_redirects", `feed redirected more than ${maxRedirects} times`);
      // Section 3: "do not blindly follow redirects to another hostname" — the redirect target is
      // re-validated through the EXACT same SSRF checks as the original URL, whether or not the
      // hostname changed. A redirect to an internal/private host is rejected here just like an
      // initial feedUrl pointed there directly would be.
      const redirectTarget = new URL(location, currentUrl);
      currentUrl = await validateFeedUrl(redirectTarget.toString(), options);
      continue;
    }

    const contentType = response.headers.get("content-type");
    const body = await readBodyWithLimit(response, options.maxResponseBytes);
    return { status: response.status, contentType, body, finalUrl: currentUrl.toString() };
  }
}

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new FeedFetchError("too_large", `feed response exceeded the ${maxBytes}-byte limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks.map(c => Buffer.from(c))).toString("utf8");
}
