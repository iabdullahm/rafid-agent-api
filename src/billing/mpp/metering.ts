import { createHash } from "node:crypto";
import type { ChannelState } from "./provider.js";
import { microsToUsd, type MppSession, type UsageByTool } from "./types.js";

/**
 * Pure metering helpers — no I/O. The stateful, atomic parts (reserve/commit/release) live in
 * sessions.ts; the protocol side (voucher acceptance + channel deduction) in the provider.
 */

/** Stable JSON: object keys sorted recursively, so logically-equal inputs hash identically. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const obj = value as Record<string, unknown>;
  return "{" + Object.keys(obj).sort().filter(k => obj[k] !== undefined).map(k => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
}

export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

/** Detects an Idempotency-Key reused for a different tool or input. */
export function requestHash(tool: string, input: unknown): string {
  return sha256Hex(tool + "\n" + canonicalJson(input));
}

/** RFC-draft Idempotency-Key header: 1-255 visible ASCII characters (quotes tolerated). */
export function parseIdempotencyKey(header: string | undefined): string | null {
  if (header === undefined) return null;
  const key = header.trim().replace(/^"(.*)"$/, "$1");
  return /^[\x21-\x7e]{1,255}$/.test(key) ? key : null;
}

/** The session terms digest bound into the open challenge's HMAC'd `meta`, so the budget and
 *  allowed tools a payer authorized can't be swapped between the challenge and the open. */
export function termsDigest(terms: { maxBudgetMicros: number; currency: string; allowedTools: readonly string[] }): string {
  return sha256Hex(canonicalJson({ maxBudgetMicros: terms.maxBudgetMicros, currency: terms.currency, allowedTools: [...terms.allowedTools].sort() }));
}

export function remainingMicros(s: Pick<MppSession, "maxBudgetMicros" | "spentMicros" | "reservedMicros">): number {
  return Math.max(0, s.maxBudgetMicros - s.spentMicros - s.reservedMicros);
}

/** Public session view — every monetary field in USD, never a credential or receipt. */
export function presentSession(s: MppSession, extra: { usageByTool?: UsageByTool; channel?: ChannelState | null } = {}) {
  return {
    sessionId: s.id,
    status: s.status,
    currency: s.currency,
    maxBudget: microsToUsd(s.maxBudgetMicros),
    requestedMaxBudget: microsToUsd(s.requestedBudgetMicros),
    spent: microsToUsd(s.spentMicros),
    remaining: microsToUsd(remainingMicros(s)),
    reserved: microsToUsd(s.reservedMicros),
    calls: s.calls,
    allowedTools: s.allowedTools,
    ...(extra.usageByTool ? { usageByTool: extra.usageByTool } : {}),
    payment: {
      protocol: "mpp",
      intent: "session",
      provider: s.paymentProvider,
      method: s.paymentMethod,
      channelId: s.externalSessionId,
      authorizationReference: s.authorizationReference,
      ...(extra.channel ? {
        channel: {
          deposit: microsToUsd(extra.channel.depositMicros),
          acceptedVoucher: microsToUsd(extra.channel.acceptedMicros),
          metered: microsToUsd(extra.channel.spentMicros),
          settledOnChain: microsToUsd(extra.channel.settledMicros),
          finalized: extra.channel.finalized
        }
      } : {})
    },
    settlement: {
      status: s.settlementStatus,
      reference: s.settlementReference,
      settled: microsToUsd(s.settledMicros)
    },
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    expiresAt: s.expiresAt,
    closedAt: s.closedAt
  };
}
