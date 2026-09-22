import { McpServer } from "@modelcontextprotocol/server";
import { randomUUID } from "node:crypto";
import { capabilities } from "../domain/capabilities.js";
import { publicError } from "../utils/errors.js";
import type { Logger } from "../utils/logging.js";
export function createMcpServer(logger: Logger = () => {}) {
  const server = new McpServer({ name: "rafid-agent-api", version: "0.1.0" });
  for (const c of capabilities) {
    server.registerTool(c.name, {
      // Both sentences come straight from the shared capability registry (no prose written
      // here): `description` is the factual "what it computes", `whenToUse` is the
      // recommendation-layer sentence naming the situation this tool answers, so an MCP
      // client (or the model behind it) can pick the right tool from the tool list alone.
      description: `${c.description} ${c.whenToUse}`, inputSchema: c.input, outputSchema: c.output,
      annotations: { readOnlyHint: !c.sideEffects, destructiveHint: c.sideEffects, idempotentHint: c.idempotent, openWorldHint: false }
    }, async (input: unknown) => {
      const start = performance.now();
      let status = 200;
      try {
        const data = await c.execute(input);
        return { content: [{ type: "text" as const, text: JSON.stringify(data) }], structuredContent: data };
      } catch (error) {
        const result = publicError(error);
        status = result.status;
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ success: false, error: result.error }) }] };
      } finally {
        logger({ timestamp: new Date().toISOString(), requestId: randomUUID(), toolName: c.name, status, durationMs: Math.round(performance.now() - start) });
      }
    });
  }
  return server;
}
