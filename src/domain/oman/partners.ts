import { randomBytes, createHash, randomUUID } from "node:crypto";
import type { SourceType } from "./types.js";

/**
 * Partner Data Feed layer — lets a real estate company, brokerage or property manager in Oman
 * supply Rafid with authorized, attributable property-level market data (CSV, JSON, or an
 * authenticated HTTP feed — see src/api/marketDataRoutes.ts), instead of every production record
 * coming only from a manually curated fixture or a database seeded by hand.
 *
 * `PropertyDataPartner` intentionally holds only what's needed to attribute and administer a feed
 * — no personal data about individual people at the partner (Section 1: "Do not store unnecessary
 * personal data"). `contactReference` is a free-text pointer (an email alias, a contract/ticket
 * number) chosen by the operator when onboarding the partner — never a person's name, phone
 * number or other PII; this module never validates or requires a particular shape for it, but
 * `docs`/onboarding guidance says so explicitly.
 *
 * Authentication is a SEPARATE concern from this domain type, exactly like the customer/billing
 * store keeps `Principal` (src/db/store.ts) separate from the SHA-256 digest of an issued API key:
 * a partner's bearer token is generated once at creation time, returned to the operator exactly
 * once, and only its digest is ever persisted (`token_digest` in db/partnerSchema.ts) — never a
 * field on `PropertyDataPartner` itself, so nothing sensitive can leak through a `list()`/
 * `findById()` read.
 */

export const PARTNER_FEED_TYPES = ["csv", "json", "http_feed"] as const;
export type PartnerFeedType = (typeof PARTNER_FEED_TYPES)[number];

/** Production Feed Runner (Section 1): the file/wire format of a partner's SCHEDULED feed —
 *  distinct from `feedType` above (which is "how this partner is set up to work with Rafid in
 *  general" — csv/json/http_feed, chosen at onboarding). A partner with `feedType: "http_feed"`
 *  sets `feedFormat` to say whether the URL Rafid polls on a schedule serves JSON or CSV. */
export const PARTNER_FEED_FORMATS = ["json", "csv"] as const;
export type PartnerFeedFormat = (typeof PARTNER_FEED_FORMATS)[number];

/** A partner identifier is a short, human-chosen slug (e.g. "gulf-realty-om") — stable, used in
 *  the (partnerId, sourceRecordId) idempotency key (Section 5) and safe to appear in logs/CSVs. */
const PARTNER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function isValidPartnerId(id: string): boolean {
  return PARTNER_ID_PATTERN.test(id);
}

export interface PropertyDataPartner {
  partnerId: string;
  partnerName: string;
  feedType: PartnerFeedType;
  /** The sourceType every record ingested under this partner is attributed with — see
   *  types.ts's SOURCE_TYPES. Almost always "partner_feed" for a commercial partner, but kept as
   *  its own field (rather than hardcoded) so, e.g., a government-affiliated data-sharing partner
   *  could be modeled with sourceType "official_statistics" without a schema change. */
  sourceType: SourceType;
  enabled: boolean;
  dataLicenseReference: string | null;
  contactReference: string | null;
  createdAt: string;
  /** Production Feed Runner (Section 1): optional scheduled-feed configuration. `feedUrl` is
   *  untrusted, partner-supplied input — every fetch against it goes through feedSecurity.ts's SSRF
   *  checks (never trusted just because it was stored here). Authentication for this URL is
   *  deliberately NOT stored on this type — see PartnerFeedCredentialRepository
   *  (partnerFeedCredentials.ts) in its own table, resolved only at fetch time. */
  feedUrl: string | null;
  feedFormat: PartnerFeedFormat | null;
  scheduleEnabled: boolean;
  scheduleIntervalMinutes: number | null;
  /** ISO timestamp of the most recent scheduled feed run that completed successfully (imported
   *  without a transport/validation-batch-level failure — individual rejected rows still count as
   *  success at this level, exactly like the manual ingestion audit does). */
  lastSuccessfulRunAt: string | null;
  /** ISO timestamp of the most recent scheduled feed run ATTEMPT, successful or not — the anchor
   *  `computeNextDueAt()` schedules the next attempt from. */
  lastAttemptAt: string | null;
  /** Consecutive FAILED scheduled runs since the last success; reset to 0 on any successful run.
   *  Drives `feedHealth: "degraded"` at >= 3 (Section 9) — a signal PartnerFeedRunner maintains,
   *  never inferred after the fact from the audit log. */
  consecutiveFailures: number;
}

export interface PartnerFeedStats {
  recordsReceived: number;
  recordsAccepted: number;
  recordsRejected: number;
  recordsUpdated: number;
  latestObservationDate: string | null;
}

/** Section 11: a partner whose feed has gone quiet is flagged `stale: true` here — a monitoring
 *  signal only. It never gates analyze_oman_property itself: a stale partner's previously-ingested
 *  records simply age through the SAME per-record freshness/staleness logic every other source
 *  already goes through (dataQuality.staleMarketData in services/omanProperty.ts), unchanged. */
export interface PropertyDataPartnerWithStats extends PropertyDataPartner, PartnerFeedStats {
  stale: boolean;
}

export interface CreatePartnerInput {
  partnerId: string;
  partnerName: string;
  feedType: PartnerFeedType;
  sourceType: SourceType;
  enabled?: boolean;
  dataLicenseReference?: string | null;
  contactReference?: string | null;
}

/** Production Feed Runner (Section 1): input to `PartnerRepository.setFeedConfig()`. A full
 *  replace, not a patch (mirrors setEnabled()'s "one explicit value" simplicity) — the admin CLI
 *  always supplies every field together, so there is never a partially-updated, inconsistent feed
 *  config. Setting `scheduleEnabled: false` (or `feedUrl: null`) is the supported way to pause a
 *  partner's schedule without losing the rest of its configuration; the CLI re-sends the other
 *  fields unchanged when doing so. */
export interface PartnerFeedConfigInput {
  feedUrl: string | null;
  feedFormat: PartnerFeedFormat | null;
  scheduleEnabled: boolean;
  scheduleIntervalMinutes: number | null;
}

export interface ImportStatsDelta {
  received: number;
  accepted: number;
  rejected: number;
  updated: number;
  /** The latest observedAt among accepted records in this batch, if any — merged with (not
   *  overwriting backwards from) the partner's existing latestObservationDate. */
  latestObservedAt: string | null;
}

export interface PartnerRepository {
  readonly name: string;
  /** Generates a new bearer token, stores only its digest, and returns the partner record plus
   *  the plaintext token — the ONLY time the plaintext token is ever available. Throws if
   *  `partnerId` already exists. */
  create(input: CreatePartnerInput): Promise<{ partner: PropertyDataPartner; token: string }>;
  findById(partnerId: string): Promise<PropertyDataPartner | null>;
  /** Resolves a presented bearer token to its partner, or null if the token is unknown/revoked.
   *  Never returns or logs the token/digest itself. */
  authenticate(token: string): Promise<PropertyDataPartner | null>;
  setEnabled(partnerId: string, enabled: boolean): Promise<void>;
  list(): Promise<readonly PropertyDataPartner[]>;
  listWithStats(staleDays: number): Promise<readonly PropertyDataPartnerWithStats[]>;
  recordImportStats(partnerId: string, delta: ImportStatsDelta): Promise<void>;
  /** Partner Operations layer (Section 2): invalidates the partner's current token immediately and
   *  issues exactly one new token, storing only its digest — mirroring create()'s "plaintext
   *  available exactly once" contract. Throws if `partnerId` does not exist. The old token must
   *  stop authenticating the instant this resolves (never a delayed/eventual cutover). */
  rotateToken(partnerId: string): Promise<{ partner: PropertyDataPartner; token: string }>;
  /** Production Feed Runner (Section 1): sets/replaces a partner's scheduled-feed configuration.
   *  Throws if `partnerId` does not exist. Never touches feed credentials (a separate repository —
   *  see partnerFeedCredentials.ts) or ingestion stats. */
  setFeedConfig(partnerId: string, config: PartnerFeedConfigInput): Promise<PropertyDataPartner>;
  /** Production Feed Runner (Section 2/9): records the outcome of one scheduled feed run attempt.
   *  Always sets `lastAttemptAt`; on success also sets `lastSuccessfulRunAt` and resets
   *  `consecutiveFailures` to 0; on failure increments `consecutiveFailures`. Called by
   *  PartnerFeedRunner exactly once per attempt, regardless of outcome — mirrors
   *  PartnerIngestionAuditRepository.record()'s "one row per attempt" discipline. */
  recordFeedAttempt(partnerId: string, outcome: { success: boolean; at: string }): Promise<void>;
}

/** Production Feed Runner (Section 5/9): the earliest ISO timestamp a partner's scheduled feed is
 *  next due to run, or null when the partner has no active schedule (scheduleEnabled is false, or
 *  scheduleIntervalMinutes is unset). A partner that has never been attempted is due immediately
 *  (the epoch) rather than waiting a full interval from "now" — a freshly-scheduled partner
 *  shouldn't have to wait an interval before its very first run. Pure and stateless so both the
 *  scheduling pass (which partner IS due) and the health endpoint (what to REPORT) always agree —
 *  neither recomputes this differently. */
export function computeNextDueAt(partner: Pick<PropertyDataPartner, "scheduleEnabled" | "scheduleIntervalMinutes" | "lastAttemptAt">): string | null {
  if (!partner.scheduleEnabled || !partner.scheduleIntervalMinutes || partner.scheduleIntervalMinutes <= 0) return null;
  if (!partner.lastAttemptAt) return new Date(0).toISOString();
  return new Date(Date.parse(partner.lastAttemptAt) + partner.scheduleIntervalMinutes * 60_000).toISOString();
}

export function isFeedDue(partner: Pick<PropertyDataPartner, "scheduleEnabled" | "scheduleIntervalMinutes" | "lastAttemptAt" | "feedUrl">, now: Date = new Date()): boolean {
  if (!partner.feedUrl) return false;
  const nextDueAt = computeNextDueAt(partner);
  return nextDueAt !== null && Date.parse(nextDueAt) <= now.getTime();
}

export type FeedHealth = "healthy" | "degraded" | "stale";

/** Production Feed Runner (Section 9): "If consecutiveFailures >= 3: degraded. If stale threshold
 *  exceeded: stale. Otherwise: healthy" — evaluated in exactly that order, so a partner that is
 *  BOTH failing repeatedly AND stale is reported "degraded" (the more actionable signal: something
 *  is actively broken, not just quiet). Deliberately reuses the SAME `stale` flag every other part
 *  of the system already computes from `latestObservationDate`/`PARTNER_FEED_STALE_DAYS` (Section
 *  5 of the prior phase) rather than inventing a second staleness definition tied to feed-run
 *  timestamps — one partner's feed health never depends on, or affects, any other partner's. */
export function computeFeedHealth(partner: { consecutiveFailures: number; stale: boolean }): FeedHealth {
  if (partner.consecutiveFailures >= 3) return "degraded";
  if (partner.stale) return "stale";
  return "healthy";
}

export function generatePartnerToken(): string {
  return "rafid_partner_" + randomBytes(32).toString("hex");
}
export function partnerTokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function isStale(latestObservationDate: string | null, staleDays: number): boolean {
  if (!latestObservationDate) return true;
  const ageDays = Math.max(0, Math.round((Date.now() - Date.parse(latestObservationDate)) / 86_400_000));
  return ageDays > staleDays;
}

/** In-memory PartnerRepository — a full implementation (not a stub) for tests and non-Postgres
 *  local development, mirroring MemoryPropertyMarketRepository's role for market records. */
export class MemoryPartnerRepository implements PartnerRepository {
  readonly name = "In-memory partner repository (non-durable)";
  private partners = new Map<string, PropertyDataPartner>();
  private tokenDigests = new Map<string, string>(); // digest -> partnerId
  private stats = new Map<string, PartnerFeedStats>();

  async create(input: CreatePartnerInput): Promise<{ partner: PropertyDataPartner; token: string }> {
    if (this.partners.has(input.partnerId)) throw new Error(`Partner "${input.partnerId}" already exists`);
    if (!isValidPartnerId(input.partnerId)) throw new Error(`Partner id "${input.partnerId}" must be lowercase alphanumeric/hyphen, 2-64 characters`);
    const partner: PropertyDataPartner = {
      partnerId: input.partnerId, partnerName: input.partnerName, feedType: input.feedType, sourceType: input.sourceType,
      enabled: input.enabled ?? true, dataLicenseReference: input.dataLicenseReference ?? null,
      contactReference: input.contactReference ?? null, createdAt: new Date().toISOString(),
      feedUrl: null, feedFormat: null, scheduleEnabled: false, scheduleIntervalMinutes: null,
      lastSuccessfulRunAt: null, lastAttemptAt: null, consecutiveFailures: 0
    };
    const token = generatePartnerToken();
    this.partners.set(partner.partnerId, partner);
    this.tokenDigests.set(partnerTokenDigest(token), partner.partnerId);
    this.stats.set(partner.partnerId, { recordsReceived: 0, recordsAccepted: 0, recordsRejected: 0, recordsUpdated: 0, latestObservationDate: null });
    this.auditLog.push({ partnerId: partner.partnerId, eventType: "created", occurredAt: new Date().toISOString() });
    return { partner, token };
  }
  async findById(partnerId: string): Promise<PropertyDataPartner | null> { return this.partners.get(partnerId) ?? null; }
  async authenticate(token: string): Promise<PropertyDataPartner | null> {
    const partnerId = this.tokenDigests.get(partnerTokenDigest(token));
    if (!partnerId) return null;
    const partner = this.partners.get(partnerId);
    return partner && partner.enabled ? partner : null;
  }
  async setEnabled(partnerId: string, enabled: boolean): Promise<void> {
    const partner = this.partners.get(partnerId);
    if (!partner) throw new Error(`Partner "${partnerId}" not found`);
    this.partners.set(partnerId, { ...partner, enabled });
    this.auditLog.push({ partnerId, eventType: enabled ? "enabled" : "disabled", occurredAt: new Date().toISOString() });
  }
  async list(): Promise<readonly PropertyDataPartner[]> { return [...this.partners.values()]; }
  async listWithStats(staleDays: number): Promise<readonly PropertyDataPartnerWithStats[]> {
    return [...this.partners.values()].map(p => {
      const s = this.stats.get(p.partnerId) ?? { recordsReceived: 0, recordsAccepted: 0, recordsRejected: 0, recordsUpdated: 0, latestObservationDate: null };
      return { ...p, ...s, stale: isStale(s.latestObservationDate, staleDays) };
    });
  }
  async recordImportStats(partnerId: string, delta: ImportStatsDelta): Promise<void> {
    const existing = this.stats.get(partnerId) ?? { recordsReceived: 0, recordsAccepted: 0, recordsRejected: 0, recordsUpdated: 0, latestObservationDate: null };
    const latestObservationDate = [existing.latestObservationDate, delta.latestObservedAt].filter((d): d is string => !!d).sort().at(-1) ?? null;
    this.stats.set(partnerId, {
      recordsReceived: existing.recordsReceived + delta.received,
      recordsAccepted: existing.recordsAccepted + delta.accepted,
      recordsRejected: existing.recordsRejected + delta.rejected,
      recordsUpdated: existing.recordsUpdated + delta.updated,
      latestObservationDate
    });
  }
  async rotateToken(partnerId: string): Promise<{ partner: PropertyDataPartner; token: string }> {
    const partner = this.partners.get(partnerId);
    if (!partner) throw new Error(`Partner "${partnerId}" not found`);
    // Remove every existing digest mapped to this partner (normally exactly one) before issuing
    // the new one, so the old token stops authenticating immediately — never a window where both
    // work at once.
    for (const [digest, id] of this.tokenDigests) if (id === partnerId) this.tokenDigests.delete(digest);
    const token = generatePartnerToken();
    this.tokenDigests.set(partnerTokenDigest(token), partnerId);
    this.auditLog.push({ partnerId, eventType: "token_rotated", occurredAt: new Date().toISOString() });
    return { partner, token };
  }
  async setFeedConfig(partnerId: string, config: PartnerFeedConfigInput): Promise<PropertyDataPartner> {
    const partner = this.partners.get(partnerId);
    if (!partner) throw new Error(`Partner "${partnerId}" not found`);
    const updated: PropertyDataPartner = {
      ...partner,
      feedUrl: config.feedUrl, feedFormat: config.feedFormat,
      scheduleEnabled: config.scheduleEnabled, scheduleIntervalMinutes: config.scheduleIntervalMinutes
    };
    this.partners.set(partnerId, updated);
    return updated;
  }
  async recordFeedAttempt(partnerId: string, outcome: { success: boolean; at: string }): Promise<void> {
    const partner = this.partners.get(partnerId);
    if (!partner) throw new Error(`Partner "${partnerId}" not found`);
    this.partners.set(partnerId, {
      ...partner,
      lastAttemptAt: outcome.at,
      lastSuccessfulRunAt: outcome.success ? outcome.at : partner.lastSuccessfulRunAt,
      consecutiveFailures: outcome.success ? 0 : partner.consecutiveFailures + 1
    });
  }
  private auditLog: { partnerId: string; eventType: "created" | "enabled" | "disabled" | "token_rotated"; occurredAt: string }[] = [];
  /** Test/dev-only escape hatch to inspect recorded partner administration events — not part of
   *  the interface. Mirrors MemoryPartnerIngestionAuditRepository's `.all()`. */
  auditEvents(): readonly { partnerId: string; eventType: "created" | "enabled" | "disabled" | "token_rotated"; occurredAt: string }[] { return this.auditLog; }
  /** Test-only convenience — not part of the interface. */
  static newId(): string { return randomUUID().slice(0, 8); }
}
