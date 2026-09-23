import { randomBytes, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type { MppSession, MppSessionStatus, MppSettlementStatus, MppUsageEvent, UsageByTool } from "./types.js";

/**
 * Persistence for Rafid's MPP session layer: `mpp_sessions` (one row per session — budget,
 * spend, status, the MPP channel it is bound to, settlement state) and `mpp_usage_events` (one
 * row per metered call attempt — reserved → charged | failed | released).
 *
 * The one invariant everything here protects: a session's spent + reserved can NEVER exceed
 * its max budget, even under concurrent calls on many serverless instances. reserve() runs as
 * one transaction holding the session row lock (SELECT … FOR UPDATE), so two simultaneous calls
 * that would together overspend are serialized and the second is refused BEFORE any tool
 * executes. commit()/release() move the held amount to spent (or back) in one transaction too.
 *
 * Idempotency: UNIQUE (session_id, request_id) on mpp_usage_events, where request_id is the
 * caller's Idempotency-Key — a retried call finds its own previous event instead of creating
 * (and charging) a second one.
 */

export type ReserveResult =
  | { ok: true; event: MppUsageEvent; session: MppSession }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "status"; session: MppSession }
  | { ok: false; reason: "budget"; session: MppSession }
  | { ok: false; reason: "duplicate"; session: MppSession; event: MppUsageEvent };

export interface ReserveArgs {
  sessionId: string;
  toolName: string;
  amountMicros: number;
  idempotencyKey: string;
  requestHash: string;
  now: Date;
}

export type CloseResult =
  | { ok: true; session: MppSession; alreadyClosed: boolean }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "busy" | "pending"; session: MppSession };

export interface MppSessionRepository {
  createPending(input: Pick<MppSession, "requestedBudgetMicros" | "maxBudgetMicros" | "allowedTools" | "paymentProvider" | "paymentMethod" | "termsDigest" | "expiresAt" | "metadata">): Promise<MppSession>;
  get(id: string): Promise<MppSession | null>;
  getByExternalId(externalSessionId: string): Promise<MppSession | null>;
  /** pending → active, binding the MPP channel. Returns null when the session isn't pending
   *  (already activated, failed, expired) — the caller re-reads it. */
  activate(id: string, fields: { externalSessionId: string; maxBudgetMicros: number; authorizationReference: string | null; expiresAt: string; metadata?: Record<string, unknown> }): Promise<MppSession | null>;
  markFailed(id: string, reason: string): Promise<MppSession | null>;
  /** Lazily expires a session whose expires_at has passed (active/exhausted/pending → expired). */
  expireIfDue(id: string, now: Date): Promise<MppSession | null>;
  reserve(args: ReserveArgs): Promise<ReserveResult>;
  /** reserved → charged: moves the held amount into spent, increments calls, stores the response
   *  for idempotent replay, and flips the session to "exhausted" when the budget left after
   *  committed spend can no longer pay for the cheapest allowed tool (in-flight reservations are
   *  not counted — one might still be released). */
  commit(eventId: string, args: { response: unknown; cheapestAllowedMicros: number; metadata?: Record<string, unknown> }): Promise<{ session: MppSession; event: MppUsageEvent }>;
  /** reserved → failed | released: returns the held amount to the budget; nothing is charged. */
  release(eventId: string, status: "failed" | "released", metadata?: Record<string, unknown>): Promise<void>;
  close(id: string, now: Date): Promise<CloseResult>;
  updateSettlement(id: string, fields: { settlementStatus: MppSettlementStatus; settlementReference?: string | null; settledMicros?: number }): Promise<MppSession | null>;
  usageByTool(sessionId: string): Promise<UsageByTool>;
  events(sessionId: string): Promise<MppUsageEvent[]>;
}

export function newSessionId(): string {
  // 128 bits of CSPRNG entropy: an MPP session id is unguessable. It is still not a bearer
  // credential on its own — every paid call must also carry a voucher signed by the channel's
  // payer (see service.ts).
  return "mpp_" + randomBytes(16).toString("hex");
}

const MICROS = 1_000_000;

function aggregateUsage(events: readonly MppUsageEvent[]): UsageByTool {
  const out: UsageByTool = {};
  for (const e of events) {
    if (e.status !== "charged") continue;
    const row = out[e.toolName] ?? { calls: 0, spent: 0 };
    row.calls += 1;
    row.spent = Math.round((row.spent * MICROS + e.amountMicros)) / MICROS;
    out[e.toolName] = row;
  }
  return out;
}

const ACTIVE_LIKE: readonly MppSessionStatus[] = ["active", "exhausted"];

// -----------------------------------------------------------------------------------------------
// In-memory (tests, local development)
// -----------------------------------------------------------------------------------------------

export class MemoryMppSessionRepository implements MppSessionRepository {
  private readonly sessions = new Map<string, MppSession>();
  private readonly usage = new Map<string, MppUsageEvent>();
  private chain: Promise<unknown> = Promise.resolve();

  /** Serializes every mutation, mirroring the row lock the Postgres implementation takes. */
  private locked<T>(fn: () => T): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
  private clone<T>(v: T): T { return structuredClone(v); }
  private touch(s: MppSession): MppSession { s.updatedAt = new Date().toISOString(); return s; }

  async createPending(input: Parameters<MppSessionRepository["createPending"]>[0]): Promise<MppSession> {
    return this.locked(() => {
      const now = new Date().toISOString();
      const s: MppSession = {
        id: newSessionId(), externalSessionId: null, status: "pending", currency: "USD",
        maxBudgetMicros: input.maxBudgetMicros, requestedBudgetMicros: input.requestedBudgetMicros,
        spentMicros: 0, reservedMicros: 0, calls: 0, allowedTools: [...input.allowedTools],
        paymentProvider: input.paymentProvider, paymentMethod: input.paymentMethod, authorizationReference: null,
        termsDigest: input.termsDigest, settlementStatus: "not_started", settlementReference: null, settledMicros: 0,
        createdAt: now, updatedAt: now, expiresAt: input.expiresAt, closedAt: null, metadata: { ...input.metadata }
      };
      this.sessions.set(s.id, s);
      return this.clone(s);
    });
  }
  async get(id: string) { const s = this.sessions.get(id); return s ? this.clone(s) : null; }
  async getByExternalId(ext: string) {
    for (const s of this.sessions.values()) if (s.externalSessionId === ext) return this.clone(s);
    return null;
  }
  async activate(id: string, f: Parameters<MppSessionRepository["activate"]>[1]) {
    return this.locked(() => {
      const s = this.sessions.get(id);
      if (!s || s.status !== "pending") return null;
      for (const other of this.sessions.values()) if (other.externalSessionId === f.externalSessionId && other.id !== id) return null;
      Object.assign(s, { status: "active", externalSessionId: f.externalSessionId, maxBudgetMicros: f.maxBudgetMicros, authorizationReference: f.authorizationReference, expiresAt: f.expiresAt, metadata: { ...s.metadata, ...(f.metadata ?? {}) } });
      return this.clone(this.touch(s));
    });
  }
  async markFailed(id: string, reason: string) {
    return this.locked(() => {
      const s = this.sessions.get(id);
      if (!s || s.status !== "pending") return s ? this.clone(s) : null;
      s.status = "failed";
      s.metadata = { ...s.metadata, failureReason: reason };
      return this.clone(this.touch(s));
    });
  }
  async expireIfDue(id: string, now: Date) {
    return this.locked(() => {
      const s = this.sessions.get(id);
      if (!s) return null;
      if ((s.status === "active" || s.status === "exhausted" || s.status === "pending") && Date.parse(s.expiresAt) <= now.getTime() && s.reservedMicros === 0) {
        s.status = "expired";
        this.touch(s);
      }
      return this.clone(s);
    });
  }
  async reserve(a: ReserveArgs): Promise<ReserveResult> {
    return this.locked((): ReserveResult => {
      const s = this.sessions.get(a.sessionId);
      if (!s) return { ok: false, reason: "not_found" };
      const existing = [...this.usage.values()].find(e => e.sessionId === a.sessionId && e.requestId === a.idempotencyKey);
      if (existing && existing.status !== "failed" && existing.status !== "released") return { ok: false, reason: "duplicate", session: this.clone(s), event: this.clone(existing) };
      if (existing && (existing.requestHash !== a.requestHash)) return { ok: false, reason: "duplicate", session: this.clone(s), event: this.clone(existing) };
      if (s.status !== "active" || Date.parse(s.expiresAt) <= a.now.getTime()) return { ok: false, reason: "status", session: this.clone(s) };
      if (s.spentMicros + s.reservedMicros + a.amountMicros > s.maxBudgetMicros) return { ok: false, reason: "budget", session: this.clone(s) };
      s.reservedMicros += a.amountMicros;
      this.touch(s);
      const nowIso = new Date().toISOString();
      const event: MppUsageEvent = existing
        ? Object.assign(existing, { toolName: a.toolName, amountMicros: a.amountMicros, status: "reserved", updatedAt: nowIso, response: null })
        : { id: randomUUID(), sessionId: a.sessionId, toolName: a.toolName, requestId: a.idempotencyKey, requestHash: a.requestHash, amountMicros: a.amountMicros, currency: "USD", status: "reserved", createdAt: nowIso, updatedAt: nowIso, response: null, metadata: {} };
      this.usage.set(event.id, event);
      return { ok: true, event: this.clone(event), session: this.clone(s) };
    });
  }
  async commit(eventId: string, args: Parameters<MppSessionRepository["commit"]>[1]) {
    return this.locked(() => {
      const e = this.usage.get(eventId);
      if (!e || e.status !== "reserved") throw new Error("usage event is not reserved");
      const s = this.sessions.get(e.sessionId)!;
      s.reservedMicros -= e.amountMicros;
      s.spentMicros += e.amountMicros;
      s.calls += 1;
      if (s.status === "active" && s.maxBudgetMicros - s.spentMicros < args.cheapestAllowedMicros) s.status = "exhausted";
      e.status = "charged";
      e.response = args.response;
      e.metadata = { ...e.metadata, ...(args.metadata ?? {}) };
      e.updatedAt = new Date().toISOString();
      return { session: this.clone(this.touch(s)), event: this.clone(e) };
    });
  }
  async release(eventId: string, status: "failed" | "released", metadata?: Record<string, unknown>) {
    await this.locked(() => {
      const e = this.usage.get(eventId);
      if (!e || e.status !== "reserved") return;
      const s = this.sessions.get(e.sessionId)!;
      s.reservedMicros -= e.amountMicros;
      this.touch(s);
      e.status = status;
      e.metadata = { ...e.metadata, ...(metadata ?? {}) };
      e.updatedAt = new Date().toISOString();
    });
  }
  async close(id: string, now: Date): Promise<CloseResult> {
    return this.locked((): CloseResult => {
      const s = this.sessions.get(id);
      if (!s) return { ok: false, reason: "not_found" };
      if (s.status === "closed") return { ok: true, session: this.clone(s), alreadyClosed: true };
      if (s.status === "pending" || s.status === "failed") return { ok: false, reason: "pending", session: this.clone(s) };
      if (s.reservedMicros > 0) return { ok: false, reason: "busy", session: this.clone(s) };
      s.status = "closed";
      s.closedAt = now.toISOString();
      return { ok: true, session: this.clone(this.touch(s)), alreadyClosed: false };
    });
  }
  async updateSettlement(id: string, f: Parameters<MppSessionRepository["updateSettlement"]>[1]) {
    return this.locked(() => {
      const s = this.sessions.get(id);
      if (!s) return null;
      s.settlementStatus = f.settlementStatus;
      if (f.settlementReference !== undefined) s.settlementReference = f.settlementReference;
      if (f.settledMicros !== undefined) s.settledMicros = f.settledMicros;
      return this.clone(this.touch(s));
    });
  }
  async usageByTool(sessionId: string) { return aggregateUsage([...this.usage.values()].filter(e => e.sessionId === sessionId)); }
  async events(sessionId: string) { return [...this.usage.values()].filter(e => e.sessionId === sessionId).map(e => this.clone(e)); }
}

// -----------------------------------------------------------------------------------------------
// PostgreSQL (production)
// -----------------------------------------------------------------------------------------------

interface SessionRow {
  id: string; external_session_id: string | null; status: MppSessionStatus; currency: "USD";
  max_budget_micros: string; requested_budget_micros: string; spent_micros: string; reserved_micros: string; calls: number;
  allowed_tools: string[]; payment_provider: string; payment_method: string; authorization_reference: string | null;
  terms_digest: string; settlement_status: MppSettlementStatus; settlement_reference: string | null; settled_micros: string;
  created_at: Date; updated_at: Date; expires_at: Date; closed_at: Date | null; metadata: Record<string, unknown>;
}
interface EventRow {
  id: string; session_id: string; tool_name: string; request_id: string; request_hash: string; amount_micros: string;
  currency: "USD"; status: MppUsageEvent["status"]; created_at: Date; updated_at: Date; response: unknown; metadata: Record<string, unknown>;
}

const toSession = (r: SessionRow): MppSession => ({
  id: r.id, externalSessionId: r.external_session_id, status: r.status, currency: r.currency,
  maxBudgetMicros: Number(r.max_budget_micros), requestedBudgetMicros: Number(r.requested_budget_micros),
  spentMicros: Number(r.spent_micros), reservedMicros: Number(r.reserved_micros), calls: r.calls,
  allowedTools: r.allowed_tools, paymentProvider: r.payment_provider, paymentMethod: r.payment_method,
  authorizationReference: r.authorization_reference, termsDigest: r.terms_digest,
  settlementStatus: r.settlement_status, settlementReference: r.settlement_reference, settledMicros: Number(r.settled_micros),
  createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(), expiresAt: r.expires_at.toISOString(),
  closedAt: r.closed_at ? r.closed_at.toISOString() : null, metadata: r.metadata ?? {}
});
const toEvent = (r: EventRow): MppUsageEvent => ({
  id: r.id, sessionId: r.session_id, toolName: r.tool_name, requestId: r.request_id, requestHash: r.request_hash,
  amountMicros: Number(r.amount_micros), currency: r.currency, status: r.status,
  createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString(), response: r.response ?? null, metadata: r.metadata ?? {}
});

export const MPP_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS mpp_sessions (
    id text PRIMARY KEY,
    external_session_id text,
    status text NOT NULL CHECK (status IN ('pending','active','exhausted','closed','expired','failed')),
    currency text NOT NULL DEFAULT 'USD',
    max_budget_micros bigint NOT NULL CHECK (max_budget_micros >= 0),
    requested_budget_micros bigint NOT NULL CHECK (requested_budget_micros > 0),
    spent_micros bigint NOT NULL DEFAULT 0 CHECK (spent_micros >= 0),
    reserved_micros bigint NOT NULL DEFAULT 0 CHECK (reserved_micros >= 0),
    calls integer NOT NULL DEFAULT 0,
    allowed_tools text[] NOT NULL,
    payment_provider text NOT NULL,
    payment_method text NOT NULL,
    authorization_reference text,
    terms_digest text NOT NULL,
    settlement_status text NOT NULL DEFAULT 'not_started',
    settlement_reference text,
    settled_micros bigint NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    closed_at timestamptz,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT mpp_sessions_budget_invariant CHECK (spent_micros + reserved_micros <= max_budget_micros)
  )`,
  // One MPP channel backs at most one Rafid session (a replayed open credential can never create
  // a second session over the same deposit).
  `CREATE UNIQUE INDEX IF NOT EXISTS mpp_sessions_external_session_id_key ON mpp_sessions (external_session_id) WHERE external_session_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS mpp_sessions_status_expires_idx ON mpp_sessions (status, expires_at)`,
  `CREATE TABLE IF NOT EXISTS mpp_usage_events (
    id uuid PRIMARY KEY,
    session_id text NOT NULL REFERENCES mpp_sessions(id),
    tool_name text NOT NULL,
    request_id text NOT NULL,
    request_hash text NOT NULL,
    amount_micros bigint NOT NULL CHECK (amount_micros >= 0),
    currency text NOT NULL DEFAULT 'USD',
    status text NOT NULL CHECK (status IN ('reserved','charged','failed','released')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    response jsonb,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb
  )`,
  // Idempotency: one event per (session, Idempotency-Key) — a retry can never create a second charge.
  `CREATE UNIQUE INDEX IF NOT EXISTS mpp_usage_events_idempotency_key ON mpp_usage_events (session_id, request_id)`,
  `CREATE INDEX IF NOT EXISTS mpp_usage_events_session_created_idx ON mpp_usage_events (session_id, created_at)`,
  // Backing store for the mppx SDK's own state (channel records, replay markers) — see store.ts.
  `CREATE TABLE IF NOT EXISTS mpp_kv (
    key text PRIMARY KEY,
    value text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
  )`,
  // Single-use enforcement for MPP charge credentials (one paid challenge buys one call).
  `CREATE TABLE IF NOT EXISTS mpp_charge_redemptions (
    challenge_id text PRIMARY KEY,
    tool_name text NOT NULL,
    status text NOT NULL CHECK (status IN ('in_flight','redeemed')),
    claimed_at timestamptz NOT NULL DEFAULT now(),
    redeemed_at timestamptz,
    settlement_reference text
  )`
];

const schemaReady = new WeakMap<Pool, Promise<void>>();
/** Creates the MPP tables once per pool. Concurrent CREATE TABLE IF NOT EXISTS statements can
 *  race inside Postgres's catalog (two serverless instances cold-starting together), so the DDL
 *  runs in one transaction under a fixed advisory lock (the same approach as the market store's
 *  migration lock). */
export function ensureMppSchema(pool: Pool): Promise<void> {
  let ready = schemaReady.get(pool);
  if (!ready) {
    ready = (async () => {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query("SELECT pg_advisory_xact_lock(74382003)");
        for (const sql of MPP_SCHEMA_SQL) await c.query(sql);
        await c.query("COMMIT");
      } catch (error) {
        await c.query("ROLLBACK").catch(() => undefined);
        schemaReady.delete(pool);
        throw error;
      } finally { c.release(); }
    })();
    schemaReady.set(pool, ready);
  }
  return ready;
}

export class PostgresMppSessionRepository implements MppSessionRepository {
  private get ready(): Promise<void> { return ensureMppSchema(this.pool); }
  constructor(private readonly pool: Pool) { void this.ready.catch(() => undefined); }

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    await this.ready;
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const out = await fn(c);
      await c.query("COMMIT");
      return out;
    } catch (error) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { c.release(); }
  }

  async createPending(input: Parameters<MppSessionRepository["createPending"]>[0]): Promise<MppSession> {
    await this.ready;
    const r = await this.pool.query<SessionRow>(
      `INSERT INTO mpp_sessions (id, status, max_budget_micros, requested_budget_micros, allowed_tools, payment_provider, payment_method, terms_digest, expires_at, metadata)
       VALUES ($1, 'pending', $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [newSessionId(), input.maxBudgetMicros, input.requestedBudgetMicros, input.allowedTools, input.paymentProvider, input.paymentMethod, input.termsDigest, input.expiresAt, input.metadata]
    );
    return toSession(r.rows[0]!);
  }
  async get(id: string) {
    await this.ready;
    const r = await this.pool.query<SessionRow>("SELECT * FROM mpp_sessions WHERE id = $1", [id]);
    return r.rows[0] ? toSession(r.rows[0]) : null;
  }
  async getByExternalId(ext: string) {
    await this.ready;
    const r = await this.pool.query<SessionRow>("SELECT * FROM mpp_sessions WHERE external_session_id = $1", [ext]);
    return r.rows[0] ? toSession(r.rows[0]) : null;
  }
  async activate(id: string, f: Parameters<MppSessionRepository["activate"]>[1]) {
    await this.ready;
    try {
      const r = await this.pool.query<SessionRow>(
        `UPDATE mpp_sessions SET status = 'active', external_session_id = $2, max_budget_micros = $3, authorization_reference = $4,
           expires_at = $5, metadata = metadata || $6::jsonb, updated_at = now()
         WHERE id = $1 AND status = 'pending' RETURNING *`,
        [id, f.externalSessionId, f.maxBudgetMicros, f.authorizationReference, f.expiresAt, JSON.stringify(f.metadata ?? {})]
      );
      return r.rows[0] ? toSession(r.rows[0]) : null;
    } catch (error) {
      if ((error as { code?: string }).code === "23505") return null; // channel already bound to another session
      throw error;
    }
  }
  async markFailed(id: string, reason: string) {
    await this.ready;
    const r = await this.pool.query<SessionRow>(
      `UPDATE mpp_sessions SET status = 'failed', metadata = metadata || jsonb_build_object('failureReason', $2::text), updated_at = now()
       WHERE id = $1 AND status = 'pending' RETURNING *`, [id, reason]);
    return r.rows[0] ? toSession(r.rows[0]) : this.get(id);
  }
  async expireIfDue(id: string, now: Date) {
    await this.ready;
    await this.pool.query(
      `UPDATE mpp_sessions SET status = 'expired', updated_at = now()
       WHERE id = $1 AND status IN ('active','exhausted','pending') AND expires_at <= $2 AND reserved_micros = 0`, [id, now]);
    return this.get(id);
  }
  async reserve(a: ReserveArgs): Promise<ReserveResult> {
    return this.tx(async c => {
      const sr = await c.query<SessionRow>("SELECT * FROM mpp_sessions WHERE id = $1 FOR UPDATE", [a.sessionId]);
      if (!sr.rows[0]) return { ok: false, reason: "not_found" } as const;
      const s = toSession(sr.rows[0]);
      const er = await c.query<EventRow>("SELECT * FROM mpp_usage_events WHERE session_id = $1 AND request_id = $2", [a.sessionId, a.idempotencyKey]);
      const existing = er.rows[0] ? toEvent(er.rows[0]) : null;
      if (existing && ((existing.status !== "failed" && existing.status !== "released") || existing.requestHash !== a.requestHash)) return { ok: false, reason: "duplicate", session: s, event: existing } as const;
      if (s.status !== "active" || Date.parse(s.expiresAt) <= a.now.getTime()) return { ok: false, reason: "status", session: s } as const;
      if (s.spentMicros + s.reservedMicros + a.amountMicros > s.maxBudgetMicros) return { ok: false, reason: "budget", session: s } as const;
      const ur = await c.query<SessionRow>("UPDATE mpp_sessions SET reserved_micros = reserved_micros + $2, updated_at = now() WHERE id = $1 RETURNING *", [a.sessionId, a.amountMicros]);
      const evr = existing
        ? await c.query<EventRow>(
            `UPDATE mpp_usage_events SET tool_name = $2, amount_micros = $3, status = 'reserved', response = NULL, updated_at = now() WHERE id = $1 RETURNING *`,
            [existing.id, a.toolName, a.amountMicros])
        : await c.query<EventRow>(
            `INSERT INTO mpp_usage_events (id, session_id, tool_name, request_id, request_hash, amount_micros, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'reserved') RETURNING *`,
            [randomUUID(), a.sessionId, a.toolName, a.idempotencyKey, a.requestHash, a.amountMicros]);
      return { ok: true, event: toEvent(evr.rows[0]!), session: toSession(ur.rows[0]!) } as const;
    });
  }
  async commit(eventId: string, args: Parameters<MppSessionRepository["commit"]>[1]) {
    return this.tx(async c => {
      const er = await c.query<EventRow>("SELECT * FROM mpp_usage_events WHERE id = $1 FOR UPDATE", [eventId]);
      const e = er.rows[0];
      if (!e || e.status !== "reserved") throw new Error("usage event is not reserved");
      const sr = await c.query<SessionRow>(
        `UPDATE mpp_sessions SET reserved_micros = reserved_micros - $2, spent_micros = spent_micros + $2, calls = calls + 1,
           status = CASE WHEN status = 'active' AND max_budget_micros - (spent_micros + $2) < $3 THEN 'exhausted' ELSE status END,
           updated_at = now()
         WHERE id = $1 RETURNING *`, [e.session_id, e.amount_micros, args.cheapestAllowedMicros]);
      const ur = await c.query<EventRow>(
        `UPDATE mpp_usage_events SET status = 'charged', response = $2::jsonb, metadata = metadata || $3::jsonb, updated_at = now() WHERE id = $1 RETURNING *`,
        [eventId, JSON.stringify(args.response ?? null), JSON.stringify(args.metadata ?? {})]);
      return { session: toSession(sr.rows[0]!), event: toEvent(ur.rows[0]!) };
    });
  }
  async release(eventId: string, status: "failed" | "released", metadata?: Record<string, unknown>) {
    await this.tx(async c => {
      const er = await c.query<EventRow>("SELECT * FROM mpp_usage_events WHERE id = $1 FOR UPDATE", [eventId]);
      const e = er.rows[0];
      if (!e || e.status !== "reserved") return;
      await c.query("UPDATE mpp_sessions SET reserved_micros = reserved_micros - $2, updated_at = now() WHERE id = $1", [e.session_id, e.amount_micros]);
      await c.query("UPDATE mpp_usage_events SET status = $2, metadata = metadata || $3::jsonb, updated_at = now() WHERE id = $1", [eventId, status, JSON.stringify(metadata ?? {})]);
    });
  }
  async close(id: string, now: Date): Promise<CloseResult> {
    return this.tx(async c => {
      const sr = await c.query<SessionRow>("SELECT * FROM mpp_sessions WHERE id = $1 FOR UPDATE", [id]);
      if (!sr.rows[0]) return { ok: false, reason: "not_found" } as const;
      const s = toSession(sr.rows[0]);
      if (s.status === "closed") return { ok: true, session: s, alreadyClosed: true } as const;
      if (s.status === "pending" || s.status === "failed") return { ok: false, reason: "pending", session: s } as const;
      if (s.reservedMicros > 0) return { ok: false, reason: "busy", session: s } as const;
      const ur = await c.query<SessionRow>("UPDATE mpp_sessions SET status = 'closed', closed_at = $2, updated_at = now() WHERE id = $1 RETURNING *", [id, now]);
      return { ok: true, session: toSession(ur.rows[0]!), alreadyClosed: false } as const;
    });
  }
  async updateSettlement(id: string, f: Parameters<MppSessionRepository["updateSettlement"]>[1]) {
    await this.ready;
    const r = await this.pool.query<SessionRow>(
      `UPDATE mpp_sessions SET settlement_status = $2,
         settlement_reference = COALESCE($3, settlement_reference),
         settled_micros = GREATEST(settled_micros, COALESCE($4, settled_micros)), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, f.settlementStatus, f.settlementReference ?? null, f.settledMicros ?? null]);
    return r.rows[0] ? toSession(r.rows[0]) : null;
  }
  async usageByTool(sessionId: string) { return aggregateUsage(await this.events(sessionId)); }
  async events(sessionId: string) {
    await this.ready;
    const r = await this.pool.query<EventRow>("SELECT * FROM mpp_usage_events WHERE session_id = $1 ORDER BY created_at", [sessionId]);
    return r.rows.map(toEvent);
  }
}

// -----------------------------------------------------------------------------------------------
// Single-use charge credentials
// -----------------------------------------------------------------------------------------------

/**
 * One paid MPP charge challenge buys exactly one successful call — the same economics as x402
 * and L402. The SDK already refuses to settle the same payment twice (tempo/charge replay
 * markers, EIP-3009 on-chain nonces); this table is Rafid's own, method-independent guarantee
 * on top, and it closes the window between verification and settlement: two concurrent requests
 * presenting the same credential race on one PRIMARY KEY insert and exactly one runs the tool.
 * A failed call releases its claim so the payer can retry the call they authorized.
 */
export interface MppChargeRedemptionStore {
  claim(challengeId: string, toolName: string): Promise<boolean>;
  markRedeemed(challengeId: string, reference: string): Promise<void>;
  release(challengeId: string): Promise<void>;
}

export class MemoryMppChargeRedemptionStore implements MppChargeRedemptionStore {
  private readonly claimed = new Map<string, "in_flight" | "redeemed">();
  async claim(id: string) { if (this.claimed.has(id)) return false; this.claimed.set(id, "in_flight"); return true; }
  async markRedeemed(id: string) { this.claimed.set(id, "redeemed"); }
  async release(id: string) { if (this.claimed.get(id) === "in_flight") this.claimed.delete(id); }
}

export class PostgresMppChargeRedemptionStore implements MppChargeRedemptionStore {
  private get ready(): Promise<void> { return ensureMppSchema(this.pool); }
  constructor(private readonly pool: Pool) { void this.ready.catch(() => undefined); }
  async claim(id: string, toolName: string) {
    await this.ready;
    const r = await this.pool.query(
      `INSERT INTO mpp_charge_redemptions (challenge_id, tool_name, status) VALUES ($1, $2, 'in_flight')
       ON CONFLICT (challenge_id) DO UPDATE SET status = 'in_flight', claimed_at = now()
         WHERE mpp_charge_redemptions.status = 'in_flight' AND mpp_charge_redemptions.claimed_at < now() - interval '5 minutes'
       RETURNING challenge_id`, [id, toolName]);
    return (r.rowCount ?? 0) === 1;
  }
  async markRedeemed(id: string, reference: string) {
    await this.ready;
    await this.pool.query("UPDATE mpp_charge_redemptions SET status = 'redeemed', redeemed_at = now(), settlement_reference = $2 WHERE challenge_id = $1", [id, reference]);
  }
  async release(id: string) {
    await this.ready;
    await this.pool.query("DELETE FROM mpp_charge_redemptions WHERE challenge_id = $1 AND status = 'in_flight'", [id]);
  }
}

export { ACTIVE_LIKE };
