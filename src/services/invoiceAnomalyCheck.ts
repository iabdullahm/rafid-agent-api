import { previewInvoiceAnomalyCheck, runInvoiceAnomalyCheck } from "../invoice-anomaly/service.js";

/** invoice_anomaly_check's registry entry point (src/domain/capabilities.ts) — the one engine shared
 *  by REST, x402, L402, MPP and MCP (src/invoice-anomaly/service.ts). Deterministic, in-process,
 *  no external calls. */
export async function invoiceAnomalyCheck(input: unknown) {
  return runInvoiceAnomalyCheck(input);
}

/** invoice_anomaly_check's Free Preview entry point (src/domain/capabilities.ts) — see
 *  previewInvoiceAnomalyCheck's own doc comment in src/invoice-anomaly/service.ts. */
export async function previewInvoiceAnomalyCheckCapability(input: unknown) {
  return previewInvoiceAnomalyCheck(input);
}
