import { getRiskLiveChecksEnabled } from "../../intelligence/config.js";

/**
 * Sanctions-list source configuration shared by every capability that screens names against
 * public sanctions lists (oman_supplier_check, company_reputation_check). Extracted unchanged
 * from src/supplier-check/config.ts (which now re-exports these) so the list providers are not
 * owned by one capability. Env var names are unchanged for backward compatibility.
 */

export type SanctionsProviderId = "un" | "csl";
const SANCTIONS_IDS: readonly SanctionsProviderId[] = ["un", "csl"];

/** Which sanctions list providers oman_supplier_check queries. Default: none unless
 *  RISK_LIVE_CHECKS_ENABLED=true, then both the UN Security Council Consolidated List and the US
 *  Consolidated Screening List (which includes OFAC SDN). Override explicitly with
 *  SUPPLIER_SANCTIONS_PROVIDERS=un,csl or "none". Unknown ids fail loudly. */
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

/** US Consolidated Screening List search API (trade.gov; includes OFAC SDN). When
 *  SANCTIONS_CSL_API_KEY is set it is sent as the `subscription-key` header. */
export function getCslApiUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.SANCTIONS_CSL_API_URL?.trim() || "https://data.trade.gov/consolidated_screening_list/v1/search";
}
export function getCslApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.SANCTIONS_CSL_API_KEY?.trim() || null;
}

/** EU Financial Sanctions Files (FSF) full XML list. The EU publishes it behind a per-user token
 *  embedded in the download URL, so there is no safe default: set EU_SANCTIONS_LIST_URL to the
 *  complete URL (including the token) issued to you. Unset = EU list not screened. */
export function getEuSanctionsListUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.EU_SANCTIONS_LIST_URL?.trim() || null;
}

/** OpenSanctions matching API (aggregates UN, EU, UK, US and many national lists). Commercial use
 *  requires a paid OpenSanctions licence/API key; unset = provider disabled. */
export function getOpenSanctionsApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  return env.OPENSANCTIONS_API_KEY?.trim() || null;
}
export function getOpenSanctionsApiUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.OPENSANCTIONS_API_URL?.trim() || "https://api.opensanctions.org/match/default";
}
