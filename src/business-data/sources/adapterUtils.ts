/**
 * Small, shared parsing/sanitization helpers used by every source-specific import adapter
 * (omanBusinessProvider.ts, taxOmanProvider.ts, tenderBoardProvider.ts) and by the generic CSV/JSON
 * pipeline (ingestion/importPipeline.ts) — one implementation of "strip control characters", "treat
 * an empty string as null" and "parse a date safely", never copy-pasted per adapter.
 */

export interface RowError { row: number; reason: string }

const MAX_TEXT_FIELD_LENGTH = 300;

export function sanitizeText(value: string, maxLength = MAX_TEXT_FIELD_LENGTH): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, maxLength);
}

export function emptyToNull(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

/** Parses a required observed-at date/timestamp, rejecting anything unparsable or more than a day
 *  in the future (never silently defaulted to "now" — a manual import must state when the operator
 *  actually observed the source, so a stale export is never misrepresented as fresh). */
export function parseObservedAt(raw: string, fieldName: string): string {
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw new Error(`${fieldName} "${raw}" is not a valid date`);
  if (ms > Date.now() + 86_400_000) throw new Error(`${fieldName} cannot be more than a day in the future`);
  return new Date(ms).toISOString();
}

/** Parses an optional date that must not be in the future (registration dates, verification
 *  dates) — returns null for an absent value, throws for an unparsable or future one. */
export function parseOptionalPastDate(raw: string | null, fieldName: string): string | null {
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) throw new Error(`${fieldName} "${raw}" is not a valid date`);
  if (ms > Date.now()) throw new Error(`${fieldName} cannot be in the future`);
  return new Date(ms).toISOString().slice(0, 10);
}
