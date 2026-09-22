# Integrating with Cursor

Cursor connects to MCP servers via a `mcpServers` entry in a `mcp.json` file — project-level at `.cursor/mcp.json`, or global at `~/.cursor/mcp.json`. This format and both file locations are verified against Cursor's own documentation (cursor.com/docs/mcp) as of this pack's writing.

## Local (stdio) config — verified format

```json
{
  "mcpServers": {
    "rafid": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/rafid-agent-api/dist/mcp.js"]
    }
  }
}
```

`command`/`args` point at the same stdio entry point documented in [`MCP.md`](../MCP.md#client-configuration-examples); adjust the path for your deployment. Cursor also supports `env` and `envFile` for stdio servers, and interpolation like `${workspaceFolder}`/`${userHome}` in these values, per Cursor's docs — Rafid's stdio server needs no environment variables to run against the built-in demo dataset.

## Remote (HTTP) config — illustrative

Cursor's remote-server config shape (`url`, `headers`, `auth`) is documented for HTTP/SSE MCP servers generally. **This is shown as illustrative**, not verified end-to-end against Rafid's own remote MCP endpoint from inside Cursor specifically:

```json
{
  "mcpServers": {
    "rafid-remote": {
      "url": "https://api.rafidsystem.com/mcp"
    }
  }
}
```

Rafid's remote MCP endpoint (`/mcp`, Streamable HTTP, stateless, unmetered in this phase) is documented in [`MCP.md`](../MCP.md#remote-streamable-http) — that document carries the same "illustrative, not vendor-verified" caveat for any specific client's remote-server config, since Cursor's remote MCP support is a fast-moving area and this pack does not claim to have tested every client against it.

## What to expect

Once configured, Cursor's agent can call any of the four tools (`analyze_property`, `compare_properties`, `estimate_maintenance`, `analyze_oman_property`) the same way it calls any other MCP tool in its tool picker — no API key, no x402 wallet, no separate sign-in. See [`al-mouj-agent-flow.md`](al-mouj-agent-flow.md) for a worked example of the resulting tool call and how to read its result.

Sources:
- [Model Context Protocol (MCP) | Cursor Docs](https://cursor.com/docs/mcp)
