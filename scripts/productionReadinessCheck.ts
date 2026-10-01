import { capabilities } from "../src/domain/capabilities.js";

const baseUrl = (process.env.RAFID_PRODUCTION_BASE_URL ?? "https://api.rafidsystem.com").replace(/\/$/, "");
const strict = process.argv.includes("--strict");
const results: Array<{ label: string; status: "PASS" | "WARN" | "FAIL"; detail: string }> = [];

function report(label: string, status: "PASS" | "WARN" | "FAIL", detail: string) {
  results.push({ label, status, detail });
  console.log(`${status.padEnd(4)} ${label}: ${detail}`);
}

async function check(path: string, expected: (response: Response) => boolean, label = path, init?: RequestInit) {
  const started = Date.now();
  try {
    const response = await fetch(`${baseUrl}${path}`, { ...init, redirect: "manual", signal: AbortSignal.timeout(12_000) });
    const contentType = response.headers.get("content-type") ?? "";
    const detail = `${response.status} ${contentType.split(";")[0] || "unknown"} ${Date.now() - started}ms`;
    report(label, expected(response) ? "PASS" : "FAIL", detail);
    return response;
  } catch (error) {
    report(label, "WARN", `unreachable from this environment (${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
}

const health = await check("/api/v1/health", response => response.ok, "health");
const jsonEndpoints = ["/agent.json", "/.well-known/agent.json", "/.well-known/ai-plugin.json", "/api/v1/capabilities", "/api/v1/discovery", "/api/v1/discovery/search?q=property", "/api/v1/discovery/intents", "/openapi.json"];
for (const path of jsonEndpoints) await check(path, response => response.ok, path);
await check("/llms.txt", response => response.ok, "llms.txt");
await check("/robots.txt", response => response.ok, "robots.txt");
await check("/sitemap.xml", response => response.ok, "sitemap.xml");
await check("/tools", response => response.ok, "tool index");
if (capabilities[0]) await check(`/tools/${capabilities[0].name}`, response => response.ok, "first tool page");

if (health?.ok) {
  try {
    const body = await health.clone().json() as Record<string, unknown>;
    const data = body.data as Record<string, unknown> | undefined;
    report("health payload", data?.ok === true ? "PASS" : "WARN", JSON.stringify(body).slice(0, 240));
  } catch {
    report("health payload", "WARN", "health endpoint did not return JSON");
  }
}

const x402Status = await check("/api/v1/x402/status", response => response.ok, "x402 status");
let x402Enabled = false;
if (x402Status?.ok) {
  try {
    const body = await x402Status.clone().json() as { data?: { enabled?: boolean }; enabled?: boolean };
    x402Enabled = body.data?.enabled === true || body.enabled === true;
    if (!x402Enabled) report("x402 configuration", "WARN", "x402 is disabled in the deployment; unpaid challenge cannot be expected");
  } catch { report("x402 configuration", "WARN", "x402 status did not return JSON"); }
}
const unpaidProbe = capabilities.find(capability => capability.price > 0 && capability.path);
if (x402Enabled && unpaidProbe) {
  await check(`/api/v1/x402${unpaidProbe.path}`, response => response.status === 402, "x402 unpaid challenge", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(unpaidProbe.example)
  });
}

const failures = results.filter(result => result.status === "FAIL").length;
const warnings = results.filter(result => result.status === "WARN").length;
console.log(`\nProduction readiness probe complete: ${results.length} checks, ${failures} failures, ${warnings} warnings.`);
if (warnings > 0) console.log("No payment, signing operation, wallet interaction, or paid retry was attempted.");
if (strict && failures > 0) process.exitCode = 2;
