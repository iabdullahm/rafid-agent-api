import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMcpServer } from "./mcp/server.js";
import { loadConfig } from "./config/env.js";
import { createLogger } from "./utils/logging.js";
// stdio is local and inherits the launching OS user's permissions, not REST API keys.
const config = loadConfig(process.env, { requireApiKeys: false });
serveStdio(() => createMcpServer(createLogger(config.logLevel)));
