import { capabilities } from "../domain/capabilities.js";
import { prices } from "../billing/catalog.js";
import { x402BasePath } from "../billing/x402.js";

/** Lightweight, dependency-free landing page for browsers visiting "/". Machine clients get
 *  JSON instead via content negotiation (see api/app.ts) — this file has no framework, no
 *  build step and no external assets beyond system fonts.
 *
 *  Positioning: this product is agent-native. The primary message is what an AI agent can do
 *  here (discover, pay per call, execute); API-key/REST access is documented as a
 *  compatibility layer, never as the lead. */
export function landingHtml(config: { x402Enabled: boolean }): string {
  const rows = capabilities
    .map(
      c => `        <tr>
          <td><code>${c.name}</code></td>
          <td>${c.description}</td>
          <td>$${prices[c.name].toFixed(2)}</td>
        </tr>`
    )
    .join("\n");
  const escapeHtml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const exampleTool = capabilities[0]!;
  const curlX402 = `curl -X POST ${x402BasePath}${exampleTool.path} \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(exampleTool.example)}'`;
  const curlApiKey = `curl -X POST /api/v1${exampleTool.path} \\
  -H "X-API-Key: <your-key>" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(exampleTool.example)}'`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rafid Property Intelligence API</title>
<meta name="description" content="Property intelligence built for AI agents. Discover. Pay per call. Execute.">
<style>
  :root { color-scheme: light dark; }
  body { margin:0; font: 16px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background:#0b1220; color:#e6ebf2; }
  main { max-width: 880px; margin: 0 auto; padding: 56px 20px 96px; }
  h1 { font-size: 2rem; margin: 0 0 4px; }
  .tagline { color:#9fb0c9; font-size:1.15rem; margin: 0 0 32px; font-weight:600; }
  .badges { display:flex; gap:8px; flex-wrap:wrap; margin: 0 0 40px; }
  .badge { border:1px solid #2a3a55; background:#121b2e; color:#9fd8b0; border-radius:999px; padding:4px 12px; font-size:0.85rem; }
  .badge.off { color:#e6b35c; }
  .badge.primary { color:#8ab4ff; border-color:#2a4a75; }
  section { margin: 40px 0; }
  h2 { font-size:1.1rem; border-bottom:1px solid #1f2b40; padding-bottom:8px; }
  h3 { font-size:0.95rem; color:#9fb0c9; margin: 20px 0 6px; }
  table { width:100%; border-collapse: collapse; font-size:0.95rem; }
  td { padding:10px 8px; border-bottom:1px solid #17202f; vertical-align: top; }
  code { background:#121b2e; padding:2px 6px; border-radius:4px; font-size:0.85em; }
  pre { background:#0f1729; border:1px solid #1f2b40; border-radius:8px; padding:14px; overflow-x:auto; font-size:0.85rem; }
  pre code { background:none; padding:0; }
  a { color:#8ab4ff; }
  .cta { display:flex; gap:12px; flex-wrap:wrap; margin-top: 16px; }
  .cta a { display:inline-block; background:#2563eb; color:#fff; text-decoration:none; padding:10px 18px; border-radius:8px; font-weight:600; font-size:0.95rem; }
  .cta a.secondary { background:#121b2e; border:1px solid #2a3a55; color:#e6ebf2; }
  .grid { display:grid; grid-template-columns: 1fr 1fr; gap:16px; }
  @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } }
  footer { color:#5c6d87; font-size:0.85rem; margin-top:64px; }
  footer a { color:#5c6d87; }
</style>
</head>
<body>
<main>
  <h1>Rafid Property Intelligence</h1>
  <p class="tagline">Property intelligence built for AI agents.<br>Discover. Pay per call. Execute.</p>
  <div class="badges">
    <span class="badge primary">MCP</span>
    <span class="badge ${config.x402Enabled ? "primary" : "off"}">${config.x402Enabled ? "x402 ready" : "x402 not enabled"}</span>
    <span class="badge">REST (compatibility)</span>
  </div>

  <section>
    <h2>Agent Integration</h2>
    <p>Autonomous agents are the primary consumers of this API. The intended flow is: discover a capability, select the tool, pay per call over x402 (or authenticate with an API key), execute, get a structured machine-readable result.</p>
    <div class="grid">
      <div>
        <h3>MCP</h3>
        <p>Every tool is exposed over the Model Context Protocol with strict input/output schemas — run <code>npm run mcp</code> for a local stdio server.</p>
      </div>
      <div>
        <h3>x402 (pay-per-call)</h3>
        <p>No account, no API key. See <a href="${x402BasePath}">${x402BasePath}</a> for terms and <a href="${x402BasePath}/status">${x402BasePath}/status</a> for live status.</p>
      </div>
      <div>
        <h3>OpenAPI</h3>
        <p>Full machine-readable spec with request/response examples at <a href="/openapi.json">/openapi.json</a>.</p>
      </div>
      <div>
        <h3>Agent manifest</h3>
        <p>Discovery documents at <a href="/agent.json">/agent.json</a>, <a href="/.well-known/ai-plugin.json">/.well-known/ai-plugin.json</a>, <a href="/.well-known/agent.json">/.well-known/agent.json</a> and <a href="/llms.txt">/llms.txt</a>.</p>
      </div>
    </div>
    <h3>Pay per call, no wallet setup shown here</h3>
    <pre><code>${escapeHtml(curlX402)}</code></pre>
    <h3>Or authenticate with an API key</h3>
    <pre><code>${escapeHtml(curlApiKey)}</code></pre>
  </section>

  <section>
    <h2>Available tools</h2>
    <table>
      <tbody>
${rows}
      </tbody>
    </table>
    <p>Full capability registry — schemas, pricing, when to use each tool — at <a href="/api/v1/capabilities">/api/v1/capabilities</a>.</p>
  </section>

  <section>
    <h2>Access models</h2>
    <p>Two independent access models, never combined on one request: an <code>X-API-Key</code> header on <code>/api/v1/...</code>, or an unauthenticated <code>${x402BasePath}/...</code> call settled per call via the x402 protocol. Machine-readable pricing at <a href="/api/v1/pricing">/api/v1/pricing</a>. Full REST reference: <a href="/openapi.json">/openapi.json</a>.</p>
  </section>

  <section>
    <h2>Developer documentation</h2>
    <div class="cta">
      <a href="/docs">Open API Docs</a>
      <a class="secondary" href="/openapi.json">View OpenAPI</a>
      <a class="secondary" href="/api/v1/health">API Health</a>
    </div>
  </section>

  <footer>Rafid Property Intelligence &middot; v0.1.0 &middot; <a href="/agent.json">agent manifest</a></footer>
</main>
</body>
</html>
`;
}
