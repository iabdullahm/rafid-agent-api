import { Pool } from "pg";
import type { AnalyticsEvent, AnalyticsEventInput, AnalyticsRepository } from "../analytics/types.js";
import { MAX_QUERY_EVENTS } from "../analytics/types.js";

/**
 * Durable, queryable analytics event log backed by PostgreSQL. Independent of every other store
 * in src/db/ (its own `rafid_analytics_events` table, no shared schema, no migration ledger —
 * one additive `CREATE TABLE IF NOT EXISTS` is enough for an append-only event log with no prior
 * versions to migrate from, exactly like PostgresUsageRepository in billing/usage.ts, which this
 * class deliberately mirrors in structure).
 *
 * Only the fields AnalyticsEvent already restricts itself to are ever written or read back —
 * see analytics/types.ts's doc comment for the full "never store a secret" discipline. This
 * class has no column for a raw API key, private key, payment proof, or authorization header,
 * even if a caller tried to pass one.
 */
export class PostgresAnalyticsRepository implements AnalyticsRepository {
  private readonly pool: Pool;
  private readonly ready: Promise<void>;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 5000, statement_timeout: 10000, idle_in_transaction_session_timeout: 10000 });
    this.pool.on("error", () => process.stderr.write("Analytics database connection failure\n"));
    this.ready = this.pool.query(
      `CREATE TABLE IF NOT EXISTS rafid_analytics_events (
        id bigserial PRIMARY KEY,
        category text NOT NULL,
        event_type text NOT NULL,
        path text,
        tool_name text,
        success boolean,
        duration_ms double precision,
        amount numeric(12,4),
        currency text,
        tx_hash text,
        data_source text,
        client_hash text,
        user_agent text,
        referer text,
        client_name text,
        created_at timestamptz NOT NULL DEFAULT now()
      )`
    ).then(() => this.pool.query(
      // Every query filters by created_at (queryEvents) — one index covers the whole read path.
      `CREATE INDEX IF NOT EXISTS rafid_analytics_events_created_at_idx ON rafid_analytics_events (created_at DESC)`
    )).then(() => this.pool.query(
      // Additive column for an already-shipped table (see analytics/types.ts's AnalyticsChannel
      // doc comment — added for the revenue ledger's reconciliation endpoint). ADD COLUMN IF NOT
      // EXISTS rather than a second CREATE TABLE, so an already-deployed table picks it up
      // without a separate migration step; existing rows simply read back with channel = null.
      `ALTER TABLE rafid_analytics_events ADD COLUMN IF NOT EXISTS channel text`
    )).then(() => this.pool.query(
      // Additive columns for the Free Preview funnel + preview->paid conversion tracking (see
      // analytics/types.ts's requestFingerprint/paymentRail/previewSeen/conversionLatencyMs doc
      // comments) — same ADD COLUMN IF NOT EXISTS discipline as `channel` above; existing rows
      // simply read back with these as null.
      `ALTER TABLE rafid_analytics_events
        ADD COLUMN IF NOT EXISTS request_fingerprint text,
        ADD COLUMN IF NOT EXISTS payment_rail text,
        ADD COLUMN IF NOT EXISTS preview_seen boolean,
        ADD COLUMN IF NOT EXISTS conversion_latency_ms double precision`
    )).then(() => this.pool.query(
      // Additive column for the "funding" category (src/billing/external/) — see
      // analytics/types.ts's `provider` doc comment. Same ADD COLUMN IF NOT EXISTS discipline;
      // existing rows simply read back with provider = null.
      `ALTER TABLE rafid_analytics_events ADD COLUMN IF NOT EXISTS provider text`
    )).then(() => this.pool.query(
      // Additive column for the Revenue Conversion Audit (src/audit/) — see analytics/types.ts's
      // `requestId` doc comment. Same ADD COLUMN IF NOT EXISTS discipline; existing rows simply
      // read back with request_id = null (correctly meaning "recorded before this field existed").
      `ALTER TABLE rafid_analytics_events ADD COLUMN IF NOT EXISTS request_id text`
    )).then(() => this.pool.query(
      `ALTER TABLE rafid_analytics_events
        ADD COLUMN IF NOT EXISTS payment_guidance_version text,
        ADD COLUMN IF NOT EXISTS payment_docs_url text,
        ADD COLUMN IF NOT EXISTS challenge_parseable boolean`
    )).then(() => this.pool.query(
      `ALTER TABLE rafid_analytics_events
        ADD COLUMN IF NOT EXISTS source text,
        ADD COLUMN IF NOT EXISTS utm_medium text,
        ADD COLUMN IF NOT EXISTS campaign text,
        ADD COLUMN IF NOT EXISTS utm_content text,
        ADD COLUMN IF NOT EXISTS referrer_host text,
        ADD COLUMN IF NOT EXISTS client_type text,
        ADD COLUMN IF NOT EXISTS traffic_class text`
    )).then(() => this.pool.query(
      `ALTER TABLE rafid_analytics_events ADD COLUMN IF NOT EXISTS presented_capabilities jsonb`
    )).then(() => this.pool.query(
      `ALTER TABLE rafid_analytics_events
        ADD COLUMN IF NOT EXISTS validation_error_code text,
        ADD COLUMN IF NOT EXISTS validation_failure_kind text`
    )).then(() => this.pool.query(
      `ALTER TABLE rafid_analytics_events
        ADD COLUMN IF NOT EXISTS normalized_client text,
        ADD COLUMN IF NOT EXISTS attribution_confidence text,
        ADD COLUMN IF NOT EXISTS traffic_type text,
        ADD COLUMN IF NOT EXISTS interaction_type text,
        ADD COLUMN IF NOT EXISTS mcp_client text,
        ADD COLUMN IF NOT EXISTS sdk text,
        ADD COLUMN IF NOT EXISTS is_internal_test boolean,
        ADD COLUMN IF NOT EXISTS test_marker_hash text,
        ADD COLUMN IF NOT EXISTS payment_journey_id text,
        ADD COLUMN IF NOT EXISTS payment_attempt_id text,
        ADD COLUMN IF NOT EXISTS parent_request_id text,
        ADD COLUMN IF NOT EXISTS challenge_request_id text,
        ADD COLUMN IF NOT EXISTS paid_retry_request_id text,
        ADD COLUMN IF NOT EXISTS payment_status text,
        ADD COLUMN IF NOT EXISTS payment_mode text,
        ADD COLUMN IF NOT EXISTS challenge_issued_at timestamptz,
        ADD COLUMN IF NOT EXISTS payment_attempted_at timestamptz,
        ADD COLUMN IF NOT EXISTS payment_verified_at timestamptz,
        ADD COLUMN IF NOT EXISTS facilitator_verified_at timestamptz,
        ADD COLUMN IF NOT EXISTS chain_settled_at timestamptz,
        ADD COLUMN IF NOT EXISTS settlement_recorded_at timestamptz,
        ADD COLUMN IF NOT EXISTS paid_retry_received_at timestamptz,
        ADD COLUMN IF NOT EXISTS execution_started_at timestamptz,
        ADD COLUMN IF NOT EXISTS execution_completed_at timestamptz,
        ADD COLUMN IF NOT EXISTS settlement_observation_lag_ms double precision`
    )).then(() => this.pool.query(
      `CREATE INDEX IF NOT EXISTS rafid_analytics_events_payment_journey_idx ON rafid_analytics_events (payment_journey_id) WHERE payment_journey_id IS NOT NULL`
    )).then(() => this.pool.query(
      `CREATE INDEX IF NOT EXISTS rafid_analytics_events_payment_attempt_idx ON rafid_analytics_events (payment_attempt_id) WHERE payment_attempt_id IS NOT NULL`
    )).then(() => this.pool.query(
      `CREATE INDEX IF NOT EXISTS rafid_analytics_events_tx_hash_idx ON rafid_analytics_events (tx_hash) WHERE tx_hash IS NOT NULL`
    )).then(() => this.pool.query(
      // One request can emit several analytics rows across categories (a "tool" invocation row
      // plus an "x402"/"l402" funnel row for the same physical HTTP request) that the audit layer
      // must join efficiently — this index makes that join a fast lookup rather than a table scan.
      `CREATE INDEX IF NOT EXISTS rafid_analytics_events_request_id_idx ON rafid_analytics_events (request_id) WHERE request_id IS NOT NULL`
    )).then(() => this.verifyPaymentJourneyColumns());
  }

  private async verifyPaymentJourneyColumns(): Promise<void> {
    const result = await this.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'rafid_analytics_events'
         AND column_name = ANY($1::text[])`,
      [["payment_journey_id", "payment_attempt_id", "challenge_request_id"]]
    );
    const found = new Set(result.rows.map(row => row.column_name));
    const missing = ["payment_journey_id", "payment_attempt_id", "challenge_request_id"].filter(column => !found.has(column));
    if (missing.length) throw new Error(`Analytics migration verification failed; missing columns: ${missing.join(", ")}`);
  }

  async record(event: AnalyticsEventInput): Promise<void> {
    await this.ready;
    await this.pool.query(
      `INSERT INTO rafid_analytics_events(
        category, event_type, path, tool_name, channel, success, duration_ms, amount, currency, tx_hash,
        data_source, client_hash, user_agent, referer, client_name, request_fingerprint, payment_rail,
        preview_seen, conversion_latency_ms, provider, request_id, payment_guidance_version, payment_docs_url,
        challenge_parseable, source, utm_medium, campaign, utm_content, referrer_host, client_type, traffic_class, presented_capabilities, validation_error_code, validation_failure_kind,
        normalized_client, attribution_confidence, traffic_type, interaction_type, mcp_client, sdk, is_internal_test, test_marker_hash,
        payment_journey_id, payment_attempt_id, parent_request_id, challenge_request_id, paid_retry_request_id, payment_status, payment_mode,
        challenge_issued_at, payment_attempted_at, payment_verified_at, facilitator_verified_at, chain_settled_at, settlement_recorded_at,
        paid_retry_received_at, execution_started_at, execution_completed_at, settlement_observation_lag_ms, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,$46,$47,$48,$49,$50,$51)` ,
      [
        event.category, event.eventType, event.path, event.toolName, event.channel, event.success, event.durationMs,
        event.amount, event.currency, event.txHash, event.dataSource, event.clientHash, event.userAgent,
        event.referer, event.clientName, event.requestFingerprint ?? null, event.paymentRail ?? null,
        event.previewSeen ?? null, event.conversionLatencyMs ?? null, event.provider ?? null, event.requestId ?? null,
        event.paymentGuidanceVersion ?? null, event.paymentDocsUrl ?? null, event.challengeParseable ?? null,
        event.source ?? null, event.utmMedium ?? null, event.campaign ?? null, event.utmContent ?? null,
        event.referrerHost ?? null, event.clientType ?? null, event.trafficClass ?? null,
        event.presentedCapabilities ?? null, event.validationErrorCode ?? null, event.validationFailureKind ?? null,
        event.normalizedClient ?? null, event.attributionConfidence ?? null, event.trafficType ?? null, event.interactionType ?? null,
        event.mcpClient ?? null, event.sdk ?? null, event.isInternalTest ?? null, event.testMarkerHash ?? null,
        event.paymentJourneyId ?? null, event.paymentAttemptId ?? null, event.parentRequestId ?? null, event.challengeRequestId ?? null,
        event.paidRetryRequestId ?? null, event.paymentStatus ?? null, event.paymentMode ?? null,
        event.challengeIssuedAt ?? null, event.paymentAttemptedAt ?? null, event.paymentVerifiedAt ?? null, event.facilitatorVerifiedAt ?? null,
        event.chainSettledAt ?? null, event.settlementRecordedAt ?? null, event.paidRetryReceivedAt ?? null,
        event.executionStartedAt ?? null, event.executionCompletedAt ?? null, event.settlementObservationLagMs ?? null,
        event.createdAt ?? new Date().toISOString()
      ]
    );
  }

  async queryEvents(since: Date): Promise<AnalyticsEvent[]> {
    await this.ready;
    const result = await this.pool.query(
      `SELECT category, event_type, path, tool_name, channel, success, duration_ms, amount, currency, tx_hash,
              data_source, client_hash, user_agent, referer, client_name, request_fingerprint, payment_rail,
              preview_seen, conversion_latency_ms, provider, request_id, payment_guidance_version, payment_docs_url,
              challenge_parseable, source, utm_medium, campaign, utm_content, referrer_host, client_type, traffic_class, presented_capabilities, validation_error_code, validation_failure_kind,
              normalized_client, attribution_confidence, traffic_type, interaction_type, mcp_client, sdk, is_internal_test, test_marker_hash,
              payment_journey_id, payment_attempt_id, parent_request_id, challenge_request_id, paid_retry_request_id, payment_status, payment_mode,
              challenge_issued_at, payment_attempted_at, payment_verified_at, facilitator_verified_at, chain_settled_at, settlement_recorded_at,
              paid_retry_received_at, execution_started_at, execution_completed_at, settlement_observation_lag_ms, created_at
       FROM rafid_analytics_events WHERE created_at >= $1 ORDER BY created_at DESC LIMIT $2`,
      [since.toISOString(), MAX_QUERY_EVENTS]
    );
    return result.rows.map(r => ({
      category: r.category, eventType: r.event_type, path: r.path, toolName: r.tool_name, channel: r.channel,
      success: r.success, durationMs: r.duration_ms === null ? null : Number(r.duration_ms),
      amount: r.amount === null ? null : Number(r.amount), currency: r.currency, txHash: r.tx_hash,
      dataSource: r.data_source, clientHash: r.client_hash, userAgent: r.user_agent, referer: r.referer,
      clientName: r.client_name, requestFingerprint: r.request_fingerprint, paymentRail: r.payment_rail,
      previewSeen: r.preview_seen, conversionLatencyMs: r.conversion_latency_ms === null ? null : Number(r.conversion_latency_ms),
      provider: r.provider, requestId: r.request_id, paymentGuidanceVersion: r.payment_guidance_version,
      paymentDocsUrl: r.payment_docs_url, challengeParseable: r.challenge_parseable,
      source: r.source, utmMedium: r.utm_medium, campaign: r.campaign, utmContent: r.utm_content,
        referrerHost: r.referrer_host, clientType: r.client_type, trafficClass: r.traffic_class,
      presentedCapabilities: Array.isArray(r.presented_capabilities) ? r.presented_capabilities : null,
      validationErrorCode: r.validation_error_code, validationFailureKind: r.validation_failure_kind,
      normalizedClient: r.normalized_client, attributionConfidence: r.attribution_confidence, trafficType: r.traffic_type,
      interactionType: r.interaction_type, mcpClient: r.mcp_client, sdk: r.sdk, isInternalTest: r.is_internal_test,
      testMarkerHash: r.test_marker_hash, paymentJourneyId: r.payment_journey_id, paymentAttemptId: r.payment_attempt_id,
      parentRequestId: r.parent_request_id, challengeRequestId: r.challenge_request_id, paidRetryRequestId: r.paid_retry_request_id,
      paymentStatus: r.payment_status, paymentMode: r.payment_mode, challengeIssuedAt: r.challenge_issued_at,
      paymentAttemptedAt: r.payment_attempted_at, paymentVerifiedAt: r.payment_verified_at, facilitatorVerifiedAt: r.facilitator_verified_at,
      chainSettledAt: r.chain_settled_at, settlementRecordedAt: r.settlement_recorded_at, paidRetryReceivedAt: r.paid_retry_received_at,
      executionStartedAt: r.execution_started_at, executionCompletedAt: r.execution_completed_at,
      settlementObservationLagMs: r.settlement_observation_lag_ms === null ? null : Number(r.settlement_observation_lag_ms),
      createdAt: (r.created_at as Date).toISOString()
    }));
  }

  async findByPaymentJourneyId(paymentJourneyId: string): Promise<AnalyticsEvent[]> {
    return (await this.queryEvents(new Date(Date.now() - 24 * 60 * 60 * 1000)))
      .filter(event => event.paymentJourneyId === paymentJourneyId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
