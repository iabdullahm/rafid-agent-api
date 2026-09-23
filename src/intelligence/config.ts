/**
 * Env-var configuration for the Rafid Agent Intelligence capabilities — follows the exact same
 * pattern as src/business-data/config.ts / src/analytics/config.ts / src/revenue/config.ts: a
 * plain `process.env` read (never threaded through the central src/config/env.ts `Config`
 * object, since every capability shares the same execute(input) contract and carries no config
 * of its own), an explicit mode enum, and a loud, fail-closed error on an invalid value rather
 * than silently falling back.
 *
 * EVERY one of these defaults to "off"/"not configured" — matching OMAN_PROPERTY_DATA_MODE's
 * default "manual" and NCSI's default "ncsi_not_configured": a brand-new deployment (and, just
 * as importantly, every automated test, which calls execute() directly with no way to inject a
 * mock provider) must never make a real network call or incur real cost until an operator
 * explicitly opts in.
 */

export type WebSearchProviderMode = "none" | "tavily";
const WEB_SEARCH_PROVIDER_MODES: readonly WebSearchProviderMode[] = ["none", "tavily"];

export function getWebSearchProviderMode(env: NodeJS.ProcessEnv = process.env): WebSearchProviderMode {
  const raw = (env.WEB_SEARCH_PROVIDER ?? "none").trim().toLowerCase();
  if (!WEB_SEARCH_PROVIDER_MODES.includes(raw as WebSearchProviderMode)) {
    throw new Error(`WEB_SEARCH_PROVIDER must be one of: ${WEB_SEARCH_PROVIDER_MODES.join(", ")}`);
  }
  return raw as WebSearchProviderMode;
}

export function getTavilyApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.TAVILY_API_KEY?.trim() || null;
}

export type IntelligenceLlmMode = "none" | "anthropic";
const INTELLIGENCE_LLM_MODES: readonly IntelligenceLlmMode[] = ["none", "anthropic"];

export function getIntelligenceLlmMode(env: NodeJS.ProcessEnv = process.env): IntelligenceLlmMode {
  const raw = (env.INTELLIGENCE_LLM_PROVIDER ?? "none").trim().toLowerCase();
  if (!INTELLIGENCE_LLM_MODES.includes(raw as IntelligenceLlmMode)) {
    throw new Error(`INTELLIGENCE_LLM_PROVIDER must be one of: ${INTELLIGENCE_LLM_MODES.join(", ")}`);
  }
  return raw as IntelligenceLlmMode;
}

export function getAnthropicApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.ANTHROPIC_API_KEY?.trim() || null;
}

/** Deliberately no default model id — guessing a model identifier wrong would fail loudly at
 *  call time anyway, so an operator enabling the synthesizer must name the exact model they want
 *  (and can change it without a code change). Both this AND the API key must be set for the
 *  Anthropic synthesizer to activate; either alone leaves the synthesizer "not configured". */
export function getIntelligenceLlmModel(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.INTELLIGENCE_LLM_MODEL?.trim() || null;
}

/** Gates analyze_company_risk's free-but-live checks (domain registration age via public RDAP,
 *  SSRF-safe website reachability, the public OFAC sanctions list) — these need no paid API key,
 *  but DO make real outbound network calls, so they still default to off. Off means each such
 *  check reports `status: "not_configured"` honestly rather than attempting the call — this is
 *  also what keeps `npm test`'s generic per-capability loops (tests/http.test.ts, tests/mcp.test.ts,
 *  tests/x402.test.ts — which call `c.execute(c.example)` directly, with no way to inject a mock
 *  fetch) network-free and deterministic by default. */
export function getRiskLiveChecksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.RISK_LIVE_CHECKS_ENABLED ?? "false").trim().toLowerCase() === "true";
}

/** How long a cached intelligence result is served before being treated as stale — Section
 *  "Caching". Only applied to results actually produced by a live, configured provider; the
 *  honest "not configured" result is cheap enough to recompute every time and is never cached
 *  (see cache.ts's doc comment for why that also keeps generic tests deterministic). */
export function getIntelligenceCacheTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.INTELLIGENCE_CACHE_TTL_MS ? Number(env.INTELLIGENCE_CACHE_TTL_MS) : NaN;
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 6 * 60 * 60 * 1000; // 6 hours default — company/web facts don't usually change faster than this.
}

/** Company research/risk analysis is inherently more time-sensitive; a shorter default TTL. */
export function getRiskCacheTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RISK_CACHE_TTL_MS ? Number(env.RISK_CACHE_TTL_MS) : NaN;
  if (Number.isFinite(raw) && raw > 0) return raw;
  return 30 * 60 * 1000; // 30 minutes default — risk signals (adverse news, sanctions) are time-sensitive.
}
