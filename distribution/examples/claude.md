# Integrating with Claude Desktop and Claude Code

Both connect to Rafid the same way: as an MCP server. Claude Desktop and Claude Code both support the stdio MCP transport documented in [`MCP.md`](../MCP.md); this file shows the config for each and what a tool call/result looks like in that setting.

## Claude Desktop

Add to Claude Desktop's `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`; Windows: `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "rafid": {
      "command": "node",
      "args": ["/path/to/rafid-agent-api/dist/mcp.js"]
    }
  }
}
```

This is the same stdio entry point documented in [`MCP.md`](../MCP.md#client-configuration-examples) — adjust the path to wherever the built server lives in your deployment. Restart Claude Desktop after editing the config; the four Rafid tools then appear in its tool picker like any other MCP server's tools.

## Claude Code

Claude Code reads the same kind of stdio MCP server configuration (via `claude mcp add` or a project-level MCP config file, per Claude Code's own documentation). Once configured, Claude Code can call any of the four tools — `analyze_property`, `compare_properties`, `estimate_maintenance`, `analyze_oman_property` — the same way it calls any other MCP tool, with no separate authentication step (MCP calls are unmetered in this phase; see [`MCP.md`](../MCP.md)).

## What a tool call looks like

Given a question like *"Is this villa in Al Mouj reasonably priced?"*, either client issues an MCP `tools/call` for `analyze_oman_property` with the property's fields as `arguments`, matching the tool's own schema (see `/openapi.json` or `GET /api/v1/capabilities` for the full JSON Schema):

```json
{ "name": "analyze_oman_property", "arguments": { "governorate": "Muscat", "area": "Al Mouj", "propertyType": "villa", "bedrooms": 4, "askingPriceOMR": 450000 } }
```

The tool result is the same JSON object every other transport returns for this capability (`pricePosition`, `historicalSalesContext`, `provenance`, `dataQuality`, `confidence`, `riskFlags`, …) — MCP adds no separate response shape of its own. Read `provenance[].sourceType` before treating any comparable as a real market figure: `partner_feed` means a genuine Al Mouj Muscat sale record; `manual_benchmark` means an illustrative demo figure. See [`al-mouj-agent-flow.md`](al-mouj-agent-flow.md) for the full worked flow from question to a labeled answer.
