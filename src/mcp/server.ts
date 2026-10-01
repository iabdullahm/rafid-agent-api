import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { capabilities, discoveryCapabilities, toolSelectionMetadata } from "../domain/capabilities.js";
import { publicError } from "../utils/errors.js";
import type { Logger } from "../utils/logging.js";
import { classifyDataSource } from "../analytics/dataSource.js";
import { runCapabilityPreview } from "../preview/service.js";
import { buildMcpPaymentRequired, isMcpPaidConversionTool, mcpPaymentRequiredOutput } from "./paidConversion.js";
import type { PaymentDiscoveryConfig } from "../billing/paymentMethods.js";
/** Optional execution override (hosted mode — see mcp/hosted.ts): instead of running a
 *  capability in-process, run it somewhere else (e.g. the hosted REST API, billed to a Rafid API
 *  key) and optionally attach result `_meta`. Tool names, schemas and descriptions are unchanged. */
export interface McpServerOptions {
  execute?: (capability: (typeof capabilities)[number], input: unknown) => Promise<{ data: unknown; meta?: Record<string, unknown> }>;
  /** Enables real payment-rail discovery on the preview_capability tool's fullResult.paymentMethods
   *  (see src/billing/paymentMethods.ts). Omitted in stdio/local mode, where no rail is reachable. */
  previewConfig?: PaymentDiscoveryConfig;
  paidConversionEnabled?: boolean;
  publicBaseUrl?: string;
}
export function createMcpServer(logger: Logger = () => {}, options: McpServerOptions = {}) {
  const server = new McpServer({ name: "rafid-agent-api", version: "0.1.0" });
  for (const c of discoveryCapabilities) {
    const selection = toolSelectionMetadata(c);
    // Do not eagerly convert every Zod schema to JSON Schema while constructing the stdio
    // server. With the full registry this added several seconds before the first initialize
    // response and made MCP clients time out. The SDK performs the authoritative conversion
    // when it serializes tools/list; the registry schema remains the single source of truth.
    const required = " Input is a strict JSON object; see the schema.";
    server.registerTool(c.name, {
      // Both sentences come straight from the shared capability registry (no prose written
      // here): `description` is the factual "what it computes", `whenToUse` is the
      // recommendation-layer sentence naming the situation this tool answers, so an MCP
      // client (or the model behind it) can pick the right tool from the tool list alone.
      description: `${c.description} When: ${c.whenToUse} Selection: ${selection.toolRole}; prefer for ${selection.recommendedFor.slice(0, 2).join(" or ")}.${selection.notFor.length ? ` Do not use for ${selection.notFor.slice(0, 2).join(" or ")}.` : ""}${required} Price: $${c.price.toFixed(2)} ${c.currency} per call.${c.preview ? " A free preview is available through preview_capability before payment." : " No free preview is advertised for this capability."}${options.paidConversionEnabled && isMcpPaidConversionTool(c.name) ? " Full execution is paid per call via x402; an unpaid MCP call returns payment instructions." : ""}`, inputSchema: c.input, outputSchema: options.paidConversionEnabled && isMcpPaidConversionTool(c.name) ? z.union([c.output, mcpPaymentRequiredOutput]) : c.output,
      annotations: { readOnlyHint: !c.sideEffects, destructiveHint: c.sideEffects, idempotentHint: c.idempotent, openWorldHint: false }
    }, async (input: unknown) => {
      const start = performance.now();
      const requestId = randomUUID();
      let status = 200;
      let dataSource: string | null = null;
      try {
        // Validate before any paid handoff. Invalid calls must never be charged or instructed
        // to pay, and every transport should preserve the same capability input contract.
        const validatedInput = c.input.parse(input);
        if (options.paidConversionEnabled && isMcpPaidConversionTool(c.name)) {
          status = 402;
          const paymentRequired = buildMcpPaymentRequired(c, requestId, options.publicBaseUrl);
          return { content: [{ type: "text" as const, text: JSON.stringify(paymentRequired) }], structuredContent: paymentRequired };
        }
        const executed = options.execute ? await options.execute(c, validatedInput) : { data: await c.execute(validatedInput), meta: undefined };
        const data = executed.data;
        // Analytics only (never changes the response): the same real-vs-demo classification
        // every REST/x402 call site also computes — see analytics/dataSource.ts's doc comment.
        // Read-only over the already-computed result; never a second execute() call.
        dataSource = classifyDataSource(c.name, data);
        return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data, ...(executed.meta ? { _meta: executed.meta } : {}) };
      } catch (error) {
        const result = publicError(error);
        status = result.status;
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: result.error }) }] };
      } finally {
        logger({ timestamp: new Date().toISOString(), requestId, toolName: c.name, status, durationMs: Math.round(performance.now() - start), dataSource });
      }
    });
  }
  // Free Preview (src/preview/): ONE generic tool covering every capability, mirroring
  // previewRoutes.ts's single generic REST route — never a second `<tool>_preview` tool per
  // capability. FREE: this never touches billing/payment and never calls a capability's own
  // execute(); it only delegates to runCapabilityPreview() (src/preview/service.ts), which looks
  // the capability up in the same registry and calls its optional `preview()` function.
  const previewInputSchema = z.strictObject({
    capability: z.string().describe("A capability name from this tool list, e.g. \"research_company\"."),
    input: z.unknown().optional().describe("The same input the paid capability accepts. Optional for a capability whose preview needs no input fields.")
  });
  const previewOutputSchema = z.object({
    capability: z.string(),
    status: z.enum(["available", "limited", "unavailable", "invalid_input"]),
    inputRecognized: z.boolean(),
    leakageClass: z.enum(["SAFE", "LOW", "MEDIUM", "HIGH"]).optional(),
    preview: z.record(z.string(), z.unknown()),
    fullResult: z.object({
      capability: z.string(),
      price: z.object({ amount: z.string(), currency: z.string() }),
      paymentMethods: z.array(z.object({ id: z.string(), enabled: z.literal(true), endpoint: z.string() })).optional(),
      endpoint: z.string().optional()
    })
  });
  server.registerTool("preview_capability", {
    description: "Free preview of a paid capability: checks whether useful data/analysis is available for a given input, before paying — proof of \"I have information for this request,\" never the paid analysis itself. No payment, charge or account is ever involved. Not every capability supports preview (status is \"unavailable\" when it doesn't). Recommended flow: discover -> preview -> evaluate -> pay -> execute.",
    inputSchema: previewInputSchema, outputSchema: previewOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async (raw: unknown) => {
    const start = performance.now();
    let status = 200;
    try {
      const { capability, input } = previewInputSchema.parse(raw);
      const data = await runCapabilityPreview(capability, input ?? {}, { config: options.previewConfig });
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data };
    } catch (error) {
      const result = publicError(error);
      status = result.status;
      return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: result.error }) }] };
    } finally {
      logger({ timestamp: new Date().toISOString(), requestId: randomUUID(), toolName: "preview_capability", status, durationMs: Math.round(performance.now() - start), dataSource: null });
    }
  });
  return server;
}
