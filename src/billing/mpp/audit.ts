/**
 * Structured MPP audit events (one JSON line each, through the app's existing logger). The
 * event vocabulary is fixed; every field is an allow-listed, safe operational value. Payment
 * credentials, Authorization header values, voucher signatures, receipts, private keys and
 * secrets are never accepted by this function's signature, and any string field that looks like
 * a signature/credential is dropped defensively as well.
 */
export type MppAuditEvent =
  // charge intent
  | "mpp.charge.challenge"
  | "mpp.charge.verified"
  | "mpp.charge.settled"
  | "mpp.charge.replay_rejected"
  // session intent
  | "mpp.session.pending"
  | "mpp.session.pending_rejected"
  | "mpp.session.activated"
  | "mpp.session.expired"
  | "mpp.session.call"
  | "mpp.session.usage_recorded"
  | "mpp.session.exhausted"
  | "mpp.session.budget_rejected"
  | "mpp.session.closed"
  | "mpp.session.settlement_pending"
  | "mpp.session.settled"
  | "mpp.session.settlement_failed"
  // shared
  | "mpp.payment.failed"
  | "mpp.maintenance.run";

export interface MppAuditFields {
  requestId?: string;
  tool?: string;
  sessionId?: string;
  /** Public identifiers only: channel id, challenge id, on-chain tx hash. */
  channelId?: string | null;
  challengeId?: string;
  reference?: string | null;
  method?: string;
  amountUsd?: number;
  spentUsd?: number;
  remainingUsd?: number;
  status?: string;
  reason?: string;
  idempotentReplay?: boolean;
  settlementStatus?: string;
  attempts?: number;
  count?: number;
}

export type MppAuditSink = (entry: Record<string, unknown>) => void;

const ALLOWED: ReadonlyArray<keyof MppAuditFields> = [
  "requestId", "tool", "sessionId", "channelId", "challengeId", "reference", "method", "amountUsd", "spentUsd", "remainingUsd", "status", "reason", "idempotentReplay",
  "settlementStatus", "attempts", "count"
];
// Hex blobs longer than a 32-byte hash (signatures are 65 bytes), base64 credential blobs, and
// the Payment auth scheme itself never belong in an audit line.
const LOOKS_SECRET = /(^Payment\s)|(0x[0-9a-fA-F]{100,})|([A-Za-z0-9_-]{200,})/;

export function mppAudit(sink: MppAuditSink, event: MppAuditEvent, fields: MppAuditFields = {}): void {
  const entry: Record<string, unknown> = { timestamp: new Date().toISOString(), event };
  for (const key of ALLOWED) {
    const value = fields[key];
    if (value === undefined) continue;
    if (typeof value === "string" && LOOKS_SECRET.test(value)) continue;
    entry[key] = value;
  }
  try { sink(entry); } catch { /* audit logging must never break a payment flow */ }
}
