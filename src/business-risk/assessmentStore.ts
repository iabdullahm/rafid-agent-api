import { Pool } from "pg";

/**
 * Persisted business_risk_score assessments — the audit trail that lets an operator (or a later
 * agent) answer "why was this company scored 67 on that date?" without re-running anything.
 *
 * Evidence itself is NOT duplicated here: it lives, normalized and shared with
 * company_reputation_check, in rafid_company_evidence_cache. This table stores only the compact,
 * explainable assessment (score, components, flags, evidence ids, weights, scoring version) plus the
 * full structured result for audit.
 *
 * Deduplication: one row per (identity_key, scoring_model_version, evidence_fingerprint). Re-scoring
 * the same evidence snapshot under the same model is idempotent (ON CONFLICT DO NOTHING, and the
 * memory store keys identically); new evidence or a new model version produces a new row.
 * Schema is created on first use (CREATE TABLE IF NOT EXISTS — this project's migration convention
 * for self-contained stores). Writes are best-effort and never fail the API call.
 */

export interface AssessmentRecord {
  assessmentId: string;
  identityKey: string;
  scoringModelVersion: string;
  evidenceFingerprint: string;
  status: string;
  riskScore: number | null;
  riskLevel: string | null;
  confidence: number;
  action: string;
  components: Record<string, number | null>;
  flagCodes: string[];
  evidenceIds: string[];
  evaluatedAt: string | null;
  result: unknown;
}

export interface AssessmentStore {
  readonly name: string;
  /** Idempotent: returns false when this exact assessment already exists. */
  save(record: AssessmentRecord): Promise<boolean>;
  latest(identityKey: string): Promise<AssessmentRecord | null>;
}

export class MemoryAssessmentStore implements AssessmentStore {
  readonly name = "memory";
  private readonly rows = new Map<string, AssessmentRecord>();
  constructor(private readonly maxRows = 2000) {}
  async save(record: AssessmentRecord): Promise<boolean> {
    if (this.rows.has(record.assessmentId)) return false;
    if (this.rows.size >= this.maxRows) {
      const oldest = this.rows.keys().next().value;
      if (oldest !== undefined) this.rows.delete(oldest);
    }
    this.rows.set(record.assessmentId, record);
    return true;
  }
  async latest(identityKey: string): Promise<AssessmentRecord | null> {
    const matches = [...this.rows.values()].filter(r => r.identityKey === identityKey);
    return matches.at(-1) ?? null;
  }
  get size(): number { return this.rows.size; }
}

export class PostgresAssessmentStore implements AssessmentStore {
  readonly name = "postgres";
  private readonly pool: Pool;
  private readonly ready: Promise<void>;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5000, statement_timeout: 8000, idle_in_transaction_session_timeout: 8000 });
    this.pool.on("error", () => process.stderr.write("Business risk assessment database connection failure\n"));
    this.ready = this.pool.query(
      `CREATE TABLE IF NOT EXISTS rafid_business_risk_assessments (
        assessment_id text PRIMARY KEY,
        identity_key text NOT NULL,
        scoring_model_version text NOT NULL,
        evidence_fingerprint text NOT NULL,
        status text NOT NULL,
        risk_score integer,
        risk_level text,
        confidence numeric(4,2) NOT NULL,
        action text NOT NULL,
        components jsonb NOT NULL,
        flag_codes text[] NOT NULL,
        evidence_ids text[] NOT NULL,
        evaluated_at timestamptz,
        result jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (identity_key, scoring_model_version, evidence_fingerprint)
      )`
    ).then(() => this.pool.query(
      `CREATE INDEX IF NOT EXISTS rafid_business_risk_assessments_identity_idx ON rafid_business_risk_assessments (identity_key, created_at DESC)`
    )).then(() => undefined);
    this.ready.catch(() => {});
  }

  async save(r: AssessmentRecord): Promise<boolean> {
    await this.ready;
    const result = await this.pool.query(
      `INSERT INTO rafid_business_risk_assessments
        (assessment_id, identity_key, scoring_model_version, evidence_fingerprint, status, risk_score, risk_level, confidence, action, components, flag_codes, evidence_ids, evaluated_at, result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14::jsonb)
       ON CONFLICT DO NOTHING`,
      [r.assessmentId, r.identityKey, r.scoringModelVersion, r.evidenceFingerprint, r.status, r.riskScore, r.riskLevel, r.confidence, r.action,
        JSON.stringify(r.components), r.flagCodes, r.evidenceIds, r.evaluatedAt, JSON.stringify(r.result)]
    );
    return (result.rowCount ?? 0) > 0;
  }

  async latest(identityKey: string): Promise<AssessmentRecord | null> {
    await this.ready;
    const result = await this.pool.query(
      `SELECT * FROM rafid_business_risk_assessments WHERE identity_key = $1 ORDER BY created_at DESC LIMIT 1`, [identityKey]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      assessmentId: row.assessment_id, identityKey: row.identity_key, scoringModelVersion: row.scoring_model_version, evidenceFingerprint: row.evidence_fingerprint,
      status: row.status, riskScore: row.risk_score, riskLevel: row.risk_level, confidence: Number(row.confidence), action: row.action,
      components: row.components, flagCodes: row.flag_codes, evidenceIds: row.evidence_ids,
      evaluatedAt: row.evaluated_at ? new Date(row.evaluated_at).toISOString() : null, result: row.result
    };
  }

  async close(): Promise<void> { await this.pool.end(); }
}
