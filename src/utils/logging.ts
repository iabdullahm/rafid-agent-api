import type { Config } from "../config/env.js";
export type LogEvent = { timestamp: string; requestId: string; endpoint?: string; toolName?: string; status: number; durationMs: number };
export type Logger = (event: LogEvent) => void;
export function createLogger(level: Config["logLevel"]): Logger {
  return event => {
    if (level === "silent" || (level === "error" && event.status < 500)) return;
    process.stderr.write(`${JSON.stringify(event)}\n`);
  };
}
