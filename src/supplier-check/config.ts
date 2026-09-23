import { getRiskLiveChecksEnabled } from "../intelligence/config.js";

/**
 * Env-var configuration for oman_supplier_check — same plain `process.env` pattern as
 * src/intelligence/config.ts / src/business-data/config.ts, with every live/networked source OFF
 * by default so a fresh deployment and `npm test`'s generic per-capability loops (which call
 * `c.execute(c.example)` with no way to inject mocks) never make a real network call.
 *
 * Live sources reuse the switches operators already set for the Rafid Agent Intelligence
 * capabilities — no new "turn it on" flag to forget:
 *  - Website inspection + sanctions lists:  RISK_LIVE_CHECKS_ENABLED=true
 *  - Public-web risk signals:               WEB_SEARCH_PROVIDER=tavily (+ TAVILY_API_KEY)
 *  - Company identity:                      OMAN_BUSINESS_DATA_MODE (the existing registry switch)
 */

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

function ttl(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name] ? Number(env[name]) : NaN;
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/** Cache TTLs per evidence type (spec: identity 7–30 days, website 1–7 days, sanctions shorter). */
export function getSupplierCacheTtls(env: NodeJS.ProcessEnv = process.env) {
  return {
    identityMs: ttl(env, "SUPPLIER_IDENTITY_CACHE_TTL_MS", 7 * DAY),
    websiteMs: ttl(env, "SUPPLIER_WEBSITE_CACHE_TTL_MS", 3 * DAY),
    sanctionsMs: ttl(env, "SUPPLIER_SANCTIONS_CACHE_TTL_MS", 12 * HOUR),
    publicRiskMs: ttl(env, "SUPPLIER_PUBLIC_RISK_CACHE_TTL_MS", 1 * DAY)
  };
}

export function getSupplierWebsiteChecksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return getRiskLiveChecksEnabled(env);
}

export type SanctionsProviderId = "un" | "csl";
const SANCTIONS_IDS: readonly SanctionsProviderId[] = ["un", "csl"];

/** Which sanctions list providers to query. Default: none unless RISK_LIVE_CHECKS_ENABLED=true,
 *  then both the UN Security Council Consolidated List and the US Consolidated Screening List
 *  (which includes OFAC SDN). Override explicitly with SUPPLIER_SANCTIONS_PROVIDERS=un,csl or
 *  "none". Unknown ids fail loudly, like every other mode switch in this codebase. */
export function getSanctionsProviderIds(env: NodeJS.ProcessEnv = process.env): SanctionsProviderId[] {
  const raw = env.SUPPLIER_SANCTIONS_PROVIDERS?.trim().toLowerCase();
  if (!raw) return getRiskLiveChecksEnabled(env) ? ["un", "csl"] : [];
  if (raw === "none") return [];
  const ids = raw.split(",").map(s => s.trim()).filter(Boolean);
  for (const id of ids) {
    if (!SANCTIONS_IDS.includes(id as SanctionsProviderId)) throw new Error(`SUPPLIER_SANCTIONS_PROVIDERS entries must be one of: ${SANCTIONS_IDS.join(", ")}, or "none"`);
  }
  return [...new Set(ids)] as SanctionsProviderId[];
}

/** UN Security Council Consolidated List (public XML, no key). */
export function getUnSanctionsListUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.SUPPLIER_UN_SANCTIONS_URL?.trim() || "https://scsanctions.un.org/resources/xml/en/consolidated.xml";
}

/** US Consolidated Screening List search API (trade.gov; includes OFAC SDN). The ITA developer
 *  portal issues a free subscription key; when SANCTIONS_CSL_API_KEY is set it is sent as the
 *  `subscription-key` header. Endpoint is overridable because ITA has moved it before. */
export function getCslApiUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.SANCTIONS_CSL_API_URL?.trim() || "https://data.trade.gov/consolidated_screening_list/v1/search";
}
export function getCslApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.SANCTIONS_CSL_API_KEY?.trim() || null;
}

/** Evidence cache backend: "postgres" when a database URL is available (SUPPLIER_EVIDENCE_DATABASE_URL,
 *  falling back to DATABASE_URL — same fallback convention as ANALYTICS_DATABASE_URL), else
 *  in-process memory. SUPPLIER_EVIDENCE_STORE=memory forces memory. */
export function getSupplierEvidenceDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  if ((env.SUPPLIER_EVIDENCE_STORE ?? "").trim().toLowerCase() === "memory") return null;
  return env.SUPPLIER_EVIDENCE_DATABASE_URL?.trim() || env.DATABASE_URL?.trim() || null;
}
