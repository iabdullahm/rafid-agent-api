/**
 * Production Feed Runner (Section 1): a partner feed's authentication configuration, stored
 * completely separately from `PropertyDataPartner` and from the partner's OWN ingestion bearer
 * token (`data_partners.token_digest` — used for the partner CALLING Rafid; this is for Rafid
 * calling THEM). Deliberately never holds a raw secret value: `secretRef` is a REFERENCE (an
 * environment variable name today; a future SecretProvider's own key format tomorrow), resolved to
 * an actual value only at fetch time, by `resolveFeedAuthHeaders()` below — the database, the
 * admin CLI's output, every log line and every test fixture can freely handle a
 * `PartnerFeedCredentialConfig` without ever touching the secret itself.
 */

export const FEED_AUTH_TYPES = ["bearer", "api_key_header", "none"] as const;
export type FeedAuthType = (typeof FEED_AUTH_TYPES)[number];

export interface PartnerFeedCredentialConfig {
  partnerId: string;
  authType: FeedAuthType;
  /** Where the ACTUAL secret value lives — an environment variable name for the bundled
   *  `EnvSecretProvider`. Never the secret itself. Required (non-null) for "bearer" and
   *  "api_key_header"; ignored for "none". */
  secretRef: string | null;
  /** The HTTP header name to send the resolved secret in. Required for "api_key_header" (e.g.
   *  "X-Api-Key"); ignored otherwise ("bearer" always uses the standard `Authorization: Bearer
   *  <token>` header). */
  headerName: string | null;
}

export interface SetPartnerFeedCredentialInput {
  authType: FeedAuthType;
  secretRef?: string | null;
  headerName?: string | null;
}

export interface PartnerFeedCredentialRepository {
  readonly name: string;
  setCredential(partnerId: string, input: SetPartnerFeedCredentialInput): Promise<PartnerFeedCredentialConfig>;
  getCredential(partnerId: string): Promise<PartnerFeedCredentialConfig | null>;
}

/** In-memory PartnerFeedCredentialRepository — a full implementation (not a stub), mirroring every
 *  other Memory* repository in this codebase. */
export class MemoryPartnerFeedCredentialRepository implements PartnerFeedCredentialRepository {
  readonly name = "In-memory partner feed credential repository (non-durable)";
  private credentials = new Map<string, PartnerFeedCredentialConfig>();

  async setCredential(partnerId: string, input: SetPartnerFeedCredentialInput): Promise<PartnerFeedCredentialConfig> {
    const config: PartnerFeedCredentialConfig = {
      partnerId, authType: input.authType, secretRef: input.secretRef ?? null, headerName: input.headerName ?? null
    };
    this.credentials.set(partnerId, config);
    return config;
  }
  async getCredential(partnerId: string): Promise<PartnerFeedCredentialConfig | null> {
    return this.credentials.get(partnerId) ?? null;
  }
}

/**
 * Where a feed credential's ACTUAL value is fetched from at request time — deliberately a small,
 * swappable interface (Section 1: "a secure secret provider abstraction") so a future deployment
 * can back it with a real secrets manager (AWS Secrets Manager, HashiCorp Vault, ...) without
 * touching `PartnerFeedRunner` or the credential config shape above; only `secretRef`'s meaning
 * changes (from "an env var name" to whatever key format the new provider expects).
 */
export interface SecretProvider {
  readonly name: string;
  getSecret(secretRef: string): Promise<string | null>;
}

/** The only implementation this phase ships: reads `process.env[secretRef]`. Matches the
 *  explicit requirement "Secrets must only come from environment variables or a secure secret
 *  provider abstraction" — this class never accepts a secret value directly, only a reference to
 *  where one already lives in the process environment. */
export class EnvSecretProvider implements SecretProvider {
  readonly name = "Environment variable secret provider";
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}
  async getSecret(secretRef: string): Promise<string | null> {
    const value = this.env[secretRef];
    return value && value.trim() ? value : null;
  }
}

export class FeedCredentialError extends Error {}

/**
 * Resolves a partner's feed credential config into the HTTP headers to send on the outbound feed
 * request — the ONLY place a real secret value ever exists in memory, and only for the duration of
 * one fetch call. Never logged, never returned, never stored (Section 8/10: "credentials are
 * redacted everywhere"). Throws (rather than silently sending an unauthenticated request) when a
 * partner's credential is misconfigured — a missing secret should surface as a loud, immediate
 * operational failure, not a quiet 401 from the partner's server. */
export async function resolveFeedAuthHeaders(config: PartnerFeedCredentialConfig | null, secretProvider: SecretProvider): Promise<Record<string, string>> {
  if (!config || config.authType === "none") return {};
  if (!config.secretRef) throw new FeedCredentialError(`feed credential for partner "${config.partnerId}" has authType "${config.authType}" but no secret reference configured`);
  const secret = await secretProvider.getSecret(config.secretRef);
  if (!secret) throw new FeedCredentialError(`feed credential secret "${config.secretRef}" for partner "${config.partnerId}" is not set (check the secret provider / environment)`);
  if (config.authType === "bearer") return { Authorization: `Bearer ${secret}` };
  if (config.authType === "api_key_header") {
    if (!config.headerName) throw new FeedCredentialError(`feed credential for partner "${config.partnerId}" has authType "api_key_header" but no header name configured`);
    return { [config.headerName]: secret };
  }
  return {};
}

/** A one-line, safe-to-log description of a credential config — names the auth mechanism and
 *  which secret REFERENCE (never value) is configured. Used by the CLI and structured logs so an
 *  operator can see "this partner's feed is configured for bearer auth via RAFID_PARTNER_X_TOKEN"
 *  without any risk of the actual token appearing anywhere. */
export function describeFeedCredential(config: PartnerFeedCredentialConfig | null): string {
  if (!config || config.authType === "none") return "none";
  if (config.authType === "bearer") return `bearer (secret ref: ${config.secretRef ?? "unset"})`;
  return `api_key_header "${config.headerName ?? "unset"}" (secret ref: ${config.secretRef ?? "unset"})`;
}
