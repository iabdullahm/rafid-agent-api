import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { capabilities } from "../domain/capabilities.js";
import { publicError } from "../utils/errors.js";
import type { Logger } from "../utils/logging.js";
import { classifyDataSource } from "../analytics/dataSource.js";
import { buildMcpPaymentRequired, isMcpPaidConversionTool, mcpPaymentRequiredOutput } from "./paidConversion.js";
export interface McpServerOptions {
  paidConversionEnabled?: boolean;
  publicBaseUrl?: string;
}

export function createMcpServer(logger: Logger = () => {}, options: McpServerOptions = {}) {
  const server = new McpServer({ name: "rafid-agent-api", version: "0.1.0" });
  for (const c of capabilities) {
    server.registerTool(c.name, {
      // Both sentences come straight from the shared capability registry (no prose written
      // here): `description` is the factual "what it computes", `whenToUse` is the
      // recommendation-layer sentence naming the situation this tool answers, so an MCP
      // client (or the model behind it) can pick the right tool from the tool list alone.
      description: `${c.description} ${c.whenToUse}${options.paidConversionEnabled && isMcpPaidConversionTool(c.name) ? " Full execution is paid per call via x402; an unpaid MCP call returns payment instructions and a free qualification preview." : ""}`, inputSchema: c.input, outputSchema: options.paidConversionEnabled && isMcpPaidConversionTool(c.name) ? z.union([c.output, mcpPaymentRequiredOutput]) : c.output,
      annotations: { readOnlyHint: !c.sideEffects, destructiveHint: c.sideEffects, idempotentHint: c.idempotent, openWorldHint: false }
    }, async (input: unknown) => {
      const start = performance.now();
      const requestId = randomUUID();
      let status = 200;
      let dataSource: string | null = null;
      try {
        if (options.paidConversionEnabled && isMcpPaidConversionTool(c.name)) {
          status = 402;
          const paymentRequired = buildMcpPaymentRequired(c, requestId, options.publicBaseUrl);
          return { content: [{ type: "text" as const, text: JSON.stringify(paymentRequired) }], structuredContent: paymentRequired };
        }
        const data = await c.execute(input);
        // Analytics only (never changes the response): the same real-vs-demo classification
        // every REST/x402 call site also computes — see analytics/dataSource.ts's doc comment.
        // Read-only over the already-computed result; never a second execute() call.
        dataSource = classifyDataSource(c.name, data);
        return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data };
      } catch (error) {
        const result = publicError(error);
        status = result.status;
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: result.error }) }] };
      } finally {
        logger({ timestamp: new Date().toISOString(), requestId, toolName: c.name, status, durationMs: Math.round(performance.now() - start), dataSource });
      }
    });
  }
  return server;
}
