import { createHash, randomUUID } from "node:crypto";
import type { AnalyticsRepository } from "./types.js";
import type { RequestClientContext } from "./context.js";

export const PAYMENT_JOURNEY_HEADER = "x-rafid-payment-journey";
export const PAYMENT_ATTEMPT_HEADER = "x-rafid-payment-attempt";
export const PAYMENT_CHALLENGE_REQUEST_HEADER = "x-rafid-payment-challenge-request";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PaymentJourneySnapshot = RequestClientContext & {
  paymentJourneyId: string;
  challengeRequestId: string;
  isInternalTest: boolean;
  testMarkerHash: string | null;
};

const snapshots = new Map<string, PaymentJourneySnapshot>();

export function validPaymentJourneyId(value: string | null | undefined): string | null {
  return value && UUID.test(value) ? value : null;
}

export function journeyIdFrom(value: string | null | undefined): string {
  return validPaymentJourneyId(value) ?? randomUUID();
}

export function newPaymentAttemptId(): string { return randomUUID(); }

export function testMarkerHash(value: string | null | undefined): string | null {
  if (!value) return null;
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function rememberPaymentJourney(snapshot: PaymentJourneySnapshot): void {
  snapshots.set(snapshot.paymentJourneyId, snapshot);
  if (snapshots.size > 10_000) snapshots.delete(snapshots.keys().next().value as string);
}

export function localPaymentJourney(id: string): PaymentJourneySnapshot | null {
  return snapshots.get(id) ?? null;
}

/** Durable fallback for retries handled by a different serverless instance. */
export async function findPaymentJourney(repository: AnalyticsRepository, id: string): Promise<PaymentJourneySnapshot | null> {
  const local = localPaymentJourney(id);
  if (local) return local;
  try {
    const events = await repository.queryEvents(new Date(Date.now() - 24 * 60 * 60 * 1000));
    const event = events.find(item => item.paymentJourneyId === id && item.eventType === "challenge");
    if (!event || !event.challengeRequestId) return null;
    const snapshot: PaymentJourneySnapshot = {
      paymentJourneyId: id,
      challengeRequestId: event.challengeRequestId,
      clientHash: event.clientHash,
      userAgent: event.userAgent,
      referer: event.referer,
      clientName: event.clientName,
      source: event.source,
      utmMedium: event.utmMedium,
      campaign: event.campaign,
      utmContent: event.utmContent,
      referrerHost: event.referrerHost,
      clientType: event.clientType,
      trafficClass: event.trafficClass,
      normalizedClient: event.normalizedClient,
      attributionConfidence: event.attributionConfidence,
      trafficType: event.trafficType,
      interactionType: event.interactionType,
      mcpClient: event.mcpClient,
      sdk: event.sdk,
      isInternalTest: event.isInternalTest === true,
      testMarkerHash: event.testMarkerHash ?? null
    };
    rememberPaymentJourney(snapshot);
    return snapshot;
  } catch {
    return null;
  }
}

export function journeyFields(args: {
  paymentJourneyId?: string | null;
  paymentAttemptId?: string | null;
  requestId?: string | null;
  challengeRequestId?: string | null;
  paidRetryRequestId?: string | null;
  paymentStatus?: "unpaid" | "paid" | "free" | "internal" | "other" | null;
  paymentMode?: string | null;
}) {
  return {
    paymentJourneyId: args.paymentJourneyId ?? null,
    paymentAttemptId: args.paymentAttemptId ?? null,
    parentRequestId: args.challengeRequestId ?? null,
    challengeRequestId: args.challengeRequestId ?? null,
    paidRetryRequestId: args.paidRetryRequestId ?? null,
    paymentStatus: args.paymentStatus ?? null,
    paymentMode: args.paymentMode ?? null
  };
}
