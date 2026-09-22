import type { Config } from "../config/env.js";
export type LogEvent = {
  timestamp: string; requestId: string; endpoint?: string; toolName?: string; status: number; durationMs: number;
  /** Set only by mcp/server.ts's per-tool logger call, for the capabilities that publish a
   *  provenance/coverage field (see analytics/dataSource.ts's classifyDataSource()) — carried
   *  through so mcp/remote.ts's wrapping logger can forward it into analytics without a second
   *  execute() call or a second copy of the classification logic. Absent (not just null) for any
   *  event that isn't a tool call, and for stdio's default no-op logger, which never reads it. */
  dataSource?: string | null;
};
export type Logger = (event: LogEvent) => void;
export function createLogger(level: Config["logLevel"]): Logger {
  return event => {
    if (level === "silent" || (level === "error" && event.status < 500)) return;
    process.stderr.write(`${JSON.stringify(event)}\n`);
  };
}
