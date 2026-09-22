import type { RequestHandler } from "express";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { createMcpServer } from "./server.js";
import { capabilities } from "../domain/capabilities.js";
import type { Logger } from "../utils/logging.js";
import type { BillingService } from "../billing/service.js";
import type { CapabilityName } from "../billing/catalog.js";
import type { Config } from "../config/env.js";

/** Public path for the remote (Streamable HTTP) MCP transport. Mounted only when
 *  MCP_REMOTE_ENABLED=true (see api/app.ts); otherwise this path simply 404s, exactly like the
 *  x402 route family when X402_ENABLED=false. */
export const mcpRemotePath = "/mcp";

/** GET /api/v1/mcp/status — always mounted, so a caller never has to guess whether the remote
 *  transport is live. Safe information only: no secret, no session data, just what a client
 *  needs to decide whether to connect over HTTP or fall back to stdio. */
export const mcpStatusBasePath = "/api/v1/mcp/status";

export function buildMcpStatus(config: Pick<Config, "mcpRemoteEnabled">) {
  return {
    enabled: config.mcpRemoteEnabled,
    transport: config.mcpRemoteEnabled ? ["stdio", "http"] : ["stdio"],
    tools: capabilities.length,
    endpoint: config.mcpRemoteEnabled ? mcpRemotePath : null
  };
}

/**
 * Builds the Express handler for the remote MCP transport.
 *
 * This calls the exact same createMcpServer() factory the local stdio entry point (src/mcp.ts)
 * uses. There is no second tool registry, schema set, description set, or execute() path for
 * remote MCP — both transports register identical tools from src/domain/capabilities.ts and run
 * identical src/services/property.ts code; only the transport differs. That also means any
 * future tool, schema or description change is automatically identical on both transports —
 * nothing here needs to be kept in sync by hand.
 *
 * Transport: NodeStreamableHTTPServerTransport in stateless mode (`sessionIdGenerator:
 * undefined`). Statelessness is required, not just simpler: on a serverless platform (Vercel) a
 * later request in the same "session" can land on a different, unrelated warm instance with no
 * shared memory, so any server-side session state would silently break. `enableJsonResponse:
 * true` returns a plain JSON body instead of an SSE stream for the simple, non-streaming
 * request/response calculators this API exposes today.
 *
 * Errors: every registered tool already returns `publicError(error)` (see mcp/server.ts) rather
 * than a raw exception, so a validation failure or internal error never leaks internals to a
 * remote caller — identical to stdio. Usage: every tool call is additionally recorded through
 * the same UsageRepository as REST/x402 calls (`accessMode: "mcp-remote"`, `billableAmount: 0`
 * — remote MCP is not a paid channel in this phase), on top of the normal structured log line.
 * Local stdio intentionally stays unmetered, as it always has: an MCP client's own OS user
 * launched that process directly, with no shared server resource to protect.
 */
export function createRemoteMcpHandler(billingService: BillingService, baseLogger: Logger): RequestHandler {
  const logger: Logger = event => {
    baseLogger({ ...event, endpoint: mcpRemotePath });
    if (event.toolName) {
      void billingService.recordUsage({
        requestId: event.requestId,
        keyIdentifier: "mcp-remote",
        toolName: event.toolName as CapabilityName,
        accessMode: "mcp-remote",
        status: event.status,
        durationMs: event.durationMs,
        billableAmount: 0,
        currency: "USD"
      });
    }
  };
  const server = createMcpServer(logger);
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  // start()/connect() do no real I/O for this transport (requests are handled per-call below,
  // not over a long-lived connection) — see WebStandardStreamableHTTPServerTransport's own doc
  // comment. The promise resolves as a microtask well before any real network request can reach
  // the handler returned here, so it is safe not to block route registration on it.
  void server.connect(transport);
  return (req, res) => {
    void transport.handleRequest(req, res).catch(error => {
      baseLogger({
        timestamp: new Date().toISOString(),
        requestId: typeof res.locals.requestId === "string" ? res.locals.requestId : "unknown",
        endpoint: mcpRemotePath,
        status: 500,
        durationMs: 0
      });
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred" }, meta: { requestId: res.locals.requestId } });
      }
      void error;
    });
  };
}
