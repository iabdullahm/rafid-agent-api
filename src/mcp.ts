import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { createMcpServer } from "./mcp/server.js";
import { createHostedExecutor } from "./mcp/hosted.js";
import { loadConfig } from "./config/env.js";
import { createLogger } from "./utils/logging.js";
// stdio is local and inherits the launching OS user's permissions, not REST API keys.
const config = loadConfig(process.env, { requireApiKeys: false });
// Hosted mode (opt-in): with RAFID_API_KEY set, every tool call is forwarded to the hosted Rafid
// API and billed to that key's account (API credits / subscription). See mcp/hosted.ts.
const apiKey = process.env.RAFID_API_KEY?.trim();
const execute = apiKey ? createHostedExecutor({ apiKey, baseUrl: process.env.RAFID_API_URL, paymentMethod: process.env.RAFID_PAYMENT_METHOD }) : undefined;
serveStdio(() => createMcpServer(createLogger(config.logLevel), { execute, previewConfig: config }));
