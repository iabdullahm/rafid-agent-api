# MCP connection snippets

Referenced from [`../MCP.md`](../MCP.md#generic-mcp-client-any-language-any-framework). The remote MCP endpoint (`/mcp`) is a stateless MCP Streamable HTTP JSON-RPC 2.0 POST endpoint — any HTTP-capable client can speak to it, with or without an MCP-specific SDK.

## Plain HTTP (no MCP library)

```bash
# 1. List tools
curl -s -X POST https://api.rafidsystem.com/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# 2. Call a tool
curl -s -X POST https://api.rafidsystem.com/mcp \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"analyze_oman_property","arguments":{"governorate":"Muscat","area":"Al Mouj","propertyType":"apartment","bedrooms":2,"sizeSqm":130,"askingPriceOMR":118000}}}'
```

Each response is a standard JSON-RPC 2.0 envelope; the tool result lives at `result.structuredContent` (structured) and `result.content` (a JSON-stringified text block, for clients that only render text) — see [`MCP.md`](../MCP.md#structured-output-and-hints).

## Node, no MCP library — plain fetch

```javascript
async function callTool(name, args) {
  const res = await fetch("https://api.rafidsystem.com/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const { result } = await res.json();
  return result.structuredContent;
}

const analysis = await callTool("analyze_oman_property", {
  governorate: "Muscat", area: "Al Mouj", propertyType: "apartment",
  bedrooms: 2, sizeSqm: 130, askingPriceOMR: 118000,
});
```

## Node, official MCP SDK

See [`MCP.md`](../MCP.md#node-mcp-client) for the full example using `@modelcontextprotocol/sdk`'s `Client` and `StreamableHTTPClientTransport` — the same connect/`listTools`/`callTool` pattern any MCP-SDK-based client uses, illustrative of the SDK's general API shape rather than pinned to one exact SDK version.

## stdio (local process, no network)

```bash
npm run build && npm run mcp
```

Then speak MCP over the process's stdin/stdout exactly as any stdio MCP client does — see [`MCP.md`](../MCP.md#stdio-fallback) and [`examples/claude.md`](../examples/claude.md) for client-side config examples.
