import { z } from "zod";
import type { AgentCapability } from "../domain/capabilities.js";

/**
 * Premium tools that should convert free MCP discovery into a paid x402 execution.
 * Keep this list intentionally small: free MCP tools remain useful for discovery and
 * qualification, while these higher-value decision tools hand the agent to x402.
 */
export const MCP_PAID_CONVERSION_TOOLS = new Set([
  "due_diligence_oman_company",
  "business_risk_score",
  "company_reputation_check",
  "document_facts_extract",
  "invoice_anomaly_check"
] as const);

export const mcpPaymentRequiredOutput = z.object({
  status: z.literal("payment_required"),
  tool: z.string(),
  requestId: z.string(),
  price: z.object({
    amount: z.number().nonnegative(),
    currency: z.string(),
    protocol: z.literal("x402")
  }).strict(),
  preview: z.object({
    inputAccepted: z.literal(true),
    fullResultAvailable: z.literal(true),
    summary: z.string(),
    useCases: z.array(z.string())
  }).strict(),
  payment: z.object({
    endpoint: z.string(),
    method: z.literal("POST"),
    retrySameBody: z.literal(true)
  }).strict(),
  nextAction: z.object({
    type: z.literal("pay_and_retry"),
    target: z.literal("x402_endpoint"),
    instruction: z.string()
  }).strict()
}).strict();

export function isMcpPaidConversionTool(name: string): boolean {
  return MCP_PAID_CONVERSION_TOOLS.has(name as never);
}

export function buildMcpPaymentRequired(
  capability: AgentCapability,
  requestId: string,
  publicBaseUrl = "https://api.rafidsystem.com"
) {
  const endpoint = `${publicBaseUrl.replace(/\/$/, "")}/api/v1/x402${capability.path}`;
  return {
    status: "payment_required" as const,
    tool: capability.name,
    requestId,
    price: {
      amount: capability.price,
      currency: capability.currency,
      protocol: "x402" as const
    },
    preview: {
      inputAccepted: true as const,
      fullResultAvailable: true as const,
      summary: capability.description,
      useCases: [...capability.useCases.slice(0, 4)]
    },
    payment: {
      endpoint,
      method: "POST" as const,
      retrySameBody: true as const
    },
    nextAction: {
      type: "pay_and_retry" as const,
      target: "x402_endpoint" as const,
      instruction: "POST the same JSON input to payment.endpoint, complete the x402 challenge, then retry that same endpoint with the payment proof to receive the full structured result."
    }
  };
}
