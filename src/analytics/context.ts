import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Why this exists: the remote MCP transport (mcp/remote.ts) builds ONE McpServer instance and
 * its per-tool `logger` callback ONCE, at module/handler-factory time (`createMcpServer(logger)`
 * — see mcp/remote.ts's doc comment on why: this deployment is stateless, so there is no
 * long-lived per-connection object to hang per-call data off). That shared logger later fires
 * from inside mcp/server.ts's `registerTool()` callback — deep inside the MCP SDK, with no
 * `req`/`res` in scope — once per tool call, for every concurrent request sharing that one
 * server instance. Client attribution (User-Agent/Referer/X-Client-Name, coarse client hash) is
 * only known at the HTTP layer, per request. AsyncLocalStorage is the standard, concurrency-safe
 * way to carry that per-request context down through the SDK's own async call chain to the
 * shared logger, without a mutable shared variable that would race across concurrent requests
 * (Node can and does interleave separate requests' promise chains) and without threading a new
 * parameter through the third-party SDK's own registerTool() signature (which this codebase does
 * not control).
 *
 * Used only for MCP tool-call client attribution — discovery and x402 events are recorded with
 * direct `req` access at the point they happen (api/app.ts), so they never need this.
 */

export interface RequestClientContext {
  clientHash: string | null;
  userAgent: string | null;
  referer: string | null;
  clientName: string | null;
}

export const mcpClientContext = new AsyncLocalStorage<RequestClientContext>();
