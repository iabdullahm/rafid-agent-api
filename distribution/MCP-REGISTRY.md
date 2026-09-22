# Official MCP Registry Publishing Guide

Rafid's remote MCP endpoint (`POST /mcp`, see [`MCP.md`](MCP.md)) can be listed in the official, protocol-maintained [MCP Registry](https://registry.modelcontextprotocol.io) (`modelcontextprotocol/registry` on GitHub). Downstream aggregators (Smithery, Glama, PulseMCP, mcp.so and others) are expected to ingest from this registry's own API on a regular cadence, so publishing once here is the highest-leverage single action for MCP-client discovery — more leverage than submitting to each downstream directory separately.

**This step needs your own GitHub OAuth login** (the `io.github.iabdullahm/*` namespace can only be claimed by proving ownership of the `iabdullahm` GitHub account via an interactive browser login) — it cannot be done from this session. Everything short of that login is already prepared below.

## What's already prepared

[`server.json`](../server.json) at the repository root — Rafid's registry entry, matching the official schema (`2025-12-11`):

```json
{
  "$schema": "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
  "name": "io.github.iabdullahm/rafid-agent-api",
  "title": "Rafid Property Intelligence",
  "description": "Oman property and facility intelligence for AI agents: rental yield/income/payback metrics, multi-property comparison, an annual maintenance-reserve estimate, and Al Mouj Muscat market analysis (price positioning, historical contracted-price context, comparable sales) using real partner-fed sale records where configured. Pay per call over x402, or authenticate with an API key.",
  "version": "0.1.0",
  "websiteUrl": "https://api.rafidsystem.com",
  "repository": { "url": "https://github.com/iabdullahm/rafid-agent-api", "source": "github" },
  "remotes": [ { "type": "streamable-http", "url": "https://api.rafidsystem.com/mcp" } ]
}
```

Notes on the choices made here:

- **`name`** uses the `io.github.iabdullahm/` namespace (matching the GitHub account that owns the source repository) rather than a custom domain — the simplest namespace to prove ownership of, via GitHub OAuth alone, no DNS/HTTP verification needed.
- **`remotes`** only — no `packages` entry. Rafid isn't published as an installable npm/PyPI/Docker package; the stdio fallback in `MCP.md` is `git clone` + `npm run mcp`, not `npm install` from a registry, so a `packages` entry would misrepresent how it's actually distributed. If that changes (e.g. Rafid is published to npm later), add a `packages` entry alongside `remotes` — the registry supports both on the same listing.
- **`version`** (`0.1.0`) matches `package.json` exactly — keep them in sync on every future publish (the registry rejects a republish with a version that doesn't increase).
- Every fact in the `description` is the same wording already used in `MCP.md`/`MARKETPLACE-LISTING.md`, not a new claim.

## What you need to run yourself

1. **Install `mcp-publisher`** (pick one):
   ```bash
   # Homebrew (macOS/Linux/WSL)
   brew install mcp-publisher

   # Or build from source
   git clone https://github.com/modelcontextprotocol/registry.git
   cd registry
   make publisher
   # add the resulting ./bin/mcp-publisher to your PATH
   ```
   Windows: download the prebuilt `mcp-publisher` binary (arm64 or amd64) from the [registry repo's GitHub releases](https://github.com/modelcontextprotocol/registry/releases) — there's no native Windows installer today, so this is the simplest path from PowerShell.

2. **Authenticate with GitHub** (proves you own `iabdullahm`, which is what authorizes the `io.github.iabdullahm/*` namespace):
   ```bash
   mcp-publisher login github
   ```
   This opens your browser for OAuth. Run it from `C:\Projects\rafid-agent-api` (or `cd` there first) so the CLI picks up the `server.json` in the next step from the right place.

3. **Publish**, from the repository root (where `server.json` already is):
   ```bash
   cd C:\Projects\rafid-agent-api
   mcp-publisher publish
   ```
   This validates `server.json` against the live schema and against the repository (it checks that `repository.url` really is `https://github.com/iabdullahm/rafid-agent-api` and that you're authenticated as its owner) and creates the listing.

4. **Verify** it's live:
   ```bash
   curl -s "https://registry.modelcontextprotocol.io/v0/servers?search=rafid" 
   ```
   or browse `https://registry.modelcontextprotocol.io` and search "Rafid".

## Keeping it current

Any time `package.json`'s version changes, bump `version` in `server.json` to match and re-run `mcp-publisher publish` — the registry treats each publish as a new version of the same `name`, and won't accept a version that doesn't increase. There's no need to touch `server.json` for a change that doesn't affect the MCP surface (e.g. a doc-only edit).

## Source

- [Publishing Remote Servers](https://modelcontextprotocol.io/registry/remote-servers) — the `remotes` field, used above.
- [`server.json` reference](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/generic-server-json.md) — full field list.
- [Publishing guide](https://github.com/modelcontextprotocol/registry/blob/main/docs/guides/publishing/publish-server.md) — `mcp-publisher` install/auth/publish steps.
