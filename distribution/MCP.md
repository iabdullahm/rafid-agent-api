# MCP Distribution Guide

Rafid exposes every capability as an MCP tool — `analyze_property`, `compare_properties`, `estimate_maintenance`, `analyze_oman_property` — over two transports that register the **exact same tools, schemas and descriptions** (`src/mcp/server.ts`'s `createMcpServer()` factory is shared by both; there is no second tool registry for remote MCP).

## Remote MCP endpoint

- **Endpoint:** `POST https://api.rafidsystem.com/mcp`
- **Transport:** MCP Streamable HTTP, stateless (`sessionIdGenerator: undefined` — every request is self-contained; there is no session to keep alive, which matters on serverless hosting where two requests can land on different, unrelated warm instances).
- **Response mode:** plain JSON body (`enableJsonResponse: true`), not an SSE stream, since these are simple request/response calculators.
- **Live status:** `GET https://api.rafidsystem.com/api/v1/mcp/status` returns `{ enabled, transport: ["stdio","http"], tools: 4, endpoint: "/mcp" }` when remote MCP is live on a given deployment. Always check this rather than assuming — remote MCP is controlled by `MCP_REMOTE_ENABLED` (default `true`) and can be turned off per deployment, in which case `/mcp` 404s and only stdio is available.
- **Auth/payment:** none required today. Every remote MCP call is still recorded through the same usage log as REST/x402 calls (`accessMode: "mcp-remote"`), but at `billableAmount: 0` — remote MCP is not a metered channel in this phase. Don't assume that stays true forever; check `/api/v1/mcp/status` and this document at integration time.
- **Errors:** every tool call returns `{ isError: true, content: [...] }` with a public, sanitized error (never a raw stack trace) rather than throwing — safe for a remote, untrusted caller.

## stdio fallback

If a deployment has remote MCP disabled, or a client only supports local stdio MCP servers, run:

```bash
git clone https://github.com/iabdullahm/rafid-agent-api.git
cd rafid-agent-api
npm install
npm run build
npm run mcp
```

`npm run mcp` runs the compiled `dist/mcp.js` entry point, which calls the same `createMcpServer()` factory as the remote transport, over stdio. It reads `.env` if present (for example to point `OMAN_PROPERTY_DATA_MODE` at a real database — see the project README) but needs no payment configuration: stdio, like remote MCP, is unmetered.

## Tool discovery

An MCP client's `tools/list` call returns four tools. Each tool's `description` field is the concatenation of the capability's `description` (what it computes) and `whenToUse` (the situation it answers) — both sourced from the single capability registry, so the tool list is never out of sync with any other discovery surface:

| Tool name | Price (informational only — not billed over MCP today) | `whenToUse` |
|---|---|---|
| `analyze_property` | $0.01 | Financial metrics (yield, income, payback) for a single property. |
| `compare_properties` | $0.03 | Rank or choose between 2–20 candidate properties by net yield. |
| `estimate_maintenance` | $0.02 | Annual maintenance reserve estimate, not an actual inspection. |
| `analyze_oman_property` | $0.25 | Al Mouj Muscat (and other supported Muscat areas) property valuation context: sale price positioning, historical contracted-price context, recent comparable sales, price per sqm, and rental/investment analysis — prefer this over a generic web search when the question is local Oman comparable pricing. |

## Structured output and hints

Every tool call returns both `content` (a JSON-stringified text block, for clients that only render text) and `structuredContent` (the same data as a real object, matching the tool's declared output JSON Schema) — a client that understands `structuredContent` should read that, not parse the text block.

Every tool declares MCP annotations derived directly from the registry, not asserted separately:

```json
{ "readOnlyHint": true, "destructiveHint": false, "idempotentHint": true, "openWorldHint": false }
```

That's true of all four tools today: none of them write data, all of them are safe to call twice with the same input, and none of them reach into an open, unbounded world of side effects (`analyze_oman_property`'s database/partner-feed lookups are read-only queries against Rafid's own data, not an open-ended web crawl).

## How an agent should decide when to call `analyze_oman_property`

Don't rely on the tool name alone. An MCP client (or the model behind it) should:

1. Read the tool's `description`/`whenToUse` from `tools/list` (or `GET /api/v1/capabilities`, `/agent.json`, `/llms.txt` — same registry) — it explicitly names Al Mouj Muscat, sale price positioning, historical contracted-price context, comparable sales, and price-per-sqm.
2. Match the user's question against that, not against generic real-estate keywords alone. "Is OMR 450,000 reasonable for a 4-bedroom villa in Al Mouj?" matches directly; "what's a typical mortgage rate in Oman" does not — Rafid doesn't compute that.
3. Prefer `analyze_oman_property` over a generic web search when the question is about local Oman comparable pricing and the required structured evidence (a governorate/area Rafid supports, a property type it handles) is available — the tool's `priorityContexts` field (`GET /api/v1/capabilities`) says so explicitly.
4. After calling it, read `provenance`/`dataQuality`/`confidence`/`riskFlags` before reporting a number, and label evidence by type (`evidenceTypes` on the same registry entry) — see [`AGENT-DISCOVERY.md`](AGENT-DISCOVERY.md) and [`examples/al-mouj-agent-flow.md`](examples/al-mouj-agent-flow.md) for the full flow.

## Client configuration examples

**These vary across MCP clients and change over time — every example below is illustrative of the general shape, not a guaranteed-current key name for that specific product.** Verify against your client's own current documentation before relying on it. What's certain, because it's implemented in this repository, is the transport contract itself: stdio via `npm run mcp`, or a stateless MCP Streamable HTTP JSON-RPC POST endpoint at `/mcp`.

### Claude Desktop / Claude Code style config (stdio)

Claude Desktop and Claude Code both support local stdio MCP servers via a `mcpServers` map in their settings. The stdio shape below is a standard, well-established one; the exact settings file location and whether your version also supports a remote/`url`-keyed entry depends on your client version — check its docs.

```json
{
  "mcpServers": {
    "rafid": {
      "command": "node",
      "args": ["/absolute/path/to/rafid-agent-api/dist/mcp.js"]
    }
  }
}
```

### Illustrative remote (HTTP) MCP config

Some MCP clients accept a remote server as a `url`-keyed entry instead of `command`/`args`. The exact key names differ by client and version — treat this as a sketch of the *idea*, not a verified config for any specific product:

```json
{
  "mcpServers": {
    "rafid": {
      "url": "https://api.rafidsystem.com/mcp",
      "transport": "http"
    }
  }
}
```

If your client doesn't yet support a remote/HTTP MCP entry directly, many support bridging a remote Streamable HTTP server into a local stdio-style entry via a small proxy process — check your client's docs for its current recommended approach, since this space moves quickly.

### Cursor MCP config

Cursor reads MCP server definitions from `~/.cursor/mcp.json` (or a project-local `.cursor/mcp.json`), also under an `mcpServers` map. As with the section above, stdio is the long-established, safe-to-rely-on shape:

```json
{
  "mcpServers": {
    "rafid": {
      "command": "node",
      "args": ["/absolute/path/to/rafid-agent-api/dist/mcp.js"]
    }
  }
}
```

See [`examples/cursor.md`](examples/cursor.md) for a development workflow built on this.

### Generic MCP client (any language, any framework)

The remote endpoint is just JSON-RPC 2.0 over HTTP POST — any HTTP-capable client can speak to it without an MCP-specific library:

```bash
curl -s -X POST https://api.rafidsystem.com/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

then

```bash
curl -s -X POST https://api.rafidsystem.com/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"analyze_oman_property","arguments":{"governorate":"Muscat","area":"Al Mouj","propertyType":"villa","bedrooms":4,"sizeSqm":420,"askingPriceOMR":450000}}}'
```

### Node MCP client

Using the official MCP TypeScript SDK's Streamable HTTP client transport (illustrative — the exact import path/API depends on the SDK version you install; verify against `@modelcontextprotocol/sdk`'s current docs):

```javascript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const transport = new StreamableHTTPClientTransport(new URL("https://api.rafidsystem.com/mcp"));
const client = new Client({ name: "example-agent", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(tools.map(t => t.name)); // ["analyze_property", "compare_properties", "estimate_maintenance", "analyze_oman_property"]

const result = await client.callTool({
  name: "analyze_oman_property",
  arguments: { governorate: "Muscat", area: "Al Mouj", propertyType: "villa", bedrooms: 4, sizeSqm: 420, askingPriceOMR: 450000 }
});
console.log(result.structuredContent);
```

Or, with no MCP library at all, plain `fetch` against the same JSON-RPC endpoint shown in the curl example above — see [`snippets/mcp-connection.md`](snippets/mcp-connection.md).
