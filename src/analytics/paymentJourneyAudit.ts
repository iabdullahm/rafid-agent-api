import type { AnalyticsEvent } from "./types.js";

export type PaymentTrafficClass =
  | "REAL_EXTERNAL_AGENT" | "EXTERNAL_UNKNOWN" | "CRAWLER" | "INTERNAL_TEST"
  | "HEALTH_CHECK" | "MONITORING" | "MANUAL" | "UNKNOWN";

export interface PaymentTrafficAudit {
  rawRequests: number;
  uniqueJourneys: number;
  uniqueClients: number;
  duplicateRequests: number;
  classifications: Record<PaymentTrafficClass, number>;
  uniqueUserAgents: number;
  uniqueBodiesUnavailable: boolean;
}

const CLASSES: readonly PaymentTrafficClass[] = [
  "REAL_EXTERNAL_AGENT", "EXTERNAL_UNKNOWN", "CRAWLER", "INTERNAL_TEST",
  "HEALTH_CHECK", "MONITORING", "MANUAL", "UNKNOWN"
];

function classify(event: AnalyticsEvent): PaymentTrafficClass {
  const ua = event.userAgent ?? "";
  const trafficType = event.trafficType;
  if (event.isInternalTest === true || event.trafficClass === "internal_test" || trafficType === "internal_test" || trafficType === "payment_test") return "INTERNAL_TEST";
  if (/health|readiness|liveness|monitor/i.test(event.path ?? "")) return "MONITORING";
  if (trafficType === "crawler" || /bot|crawler|spider|slurp|headless/i.test(ua)) return "CRAWLER";
  if (trafficType === "mcp_agent" || trafficType === "rest_agent" || trafficType === "sdk_client" || event.clientType === "sdk" || event.clientType === "mcp-client") return "REAL_EXTERNAL_AGENT";
  if (trafficType === "browser_or_human" || event.clientType === "browser") return "MANUAL";
  if (event.trafficClass === "production_external") return "EXTERNAL_UNKNOWN";
  return "UNKNOWN";
}

/** Conservative classification of challenge traffic. Missing evidence remains UNKNOWN. */
export function auditPaymentTraffic(events: readonly AnalyticsEvent[]): PaymentTrafficAudit {
  const challenges = events.filter(event => event.category === "x402" && (event.eventType === "challenge" || event.eventType === "payment_challenge"));
  const journeys = new Set(challenges.map(event => event.paymentJourneyId).filter(Boolean));
  const clients = new Set(challenges.map(event => event.clientHash ?? `${event.userAgent ?? "unknown"}|${event.clientName ?? ""}`));
  const userAgents = new Set(challenges.map(event => event.userAgent).filter(Boolean));
  const classifications = Object.fromEntries(CLASSES.map(name => [name, 0])) as Record<PaymentTrafficClass, number>;
  for (const event of challenges) classifications[classify(event)]++;
  return {
    rawRequests: challenges.length,
    uniqueJourneys: journeys.size,
    uniqueClients: clients.size,
    duplicateRequests: Math.max(0, challenges.length - journeys.size),
    classifications,
    uniqueUserAgents: userAgents.size,
    uniqueBodiesUnavailable: true
  };
}
