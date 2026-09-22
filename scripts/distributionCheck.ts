import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve as resolvePath, join as joinPath, relative as relativePath } from "node:path";
import { capabilities } from "../src/domain/capabilities.js";
import { prices } from "../src/billing/catalog.js";
import { agentBasePath, pricingBasePath, toolsBasePath, capabilitiesBasePath } from "../src/api/agent.js";
import { x402BasePath } from "../src/billing/x402.js";
import { mcpRemotePath, mcpStatusBasePath } from "../src/mcp/remote.js";
import { PRODUCTION_BASE_URL } from "./distributionConfig.js";

/**
 * npm run distribution:check
 *
 * Validates the `distribution/` pack against the live capability registry and against a set
 * of hard "never say this" invariants, so a future edit to distribution/*.md (or to the
 * registry, without updating the docs) is caught here rather than shipped. Fails loudly
 * (non-zero exit, every violation printed) rather than warning and continuing — this is meant
 * to run in the same place `npm test`/`npm run build` do before anything is published.
 *
 * This script reads text and reports; it does not fix or rewrite anything.
 */

const ROOT = resolvePath(import.meta.dirname, "..");
const DIST_DIR = resolvePath(ROOT, "distribution");

type Violation = { invariant: string; file: string; detail: string };
const violations: Violation[] = [];

function fail(invariant: string, file: string, detail: string) {
  violations.push({ invariant, file, detail });
}

// ---------------------------------------------------------------------------------------------
// Gather every file under distribution/, split by extension so each check only reads what it
// needs. Markdown files carry prose/examples; .sh/.mjs/.json are the snippets and manifest.
// ---------------------------------------------------------------------------------------------
function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = joinPath(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const allFiles = walk(DIST_DIR);
const textFiles = allFiles.filter(f => /\.(md|sh|mjs|js|json|txt)$/.test(f));
const fileContents = new Map<string, string>(textFiles.map(f => [f, readFileSync(f, "utf8")]));
const rel = (f: string) => relativePath(ROOT, f);

// ===================================== (a) Endpoints exist =====================================
// Build the set of every real, currently-routed path from the same registry/route-prefix
// constants src/api/app.ts itself uses — never a second hand-maintained list.
const staticEndpoints = new Set<string>([
  "/", "/health", "/api/v1/health", "/openapi.json", "/docs",
  "/agent.json", "/.well-known/ai-plugin.json", "/.well-known/agent.json", "/llms.txt",
  agentBasePath, pricingBasePath, toolsBasePath, capabilitiesBasePath,
  mcpStatusBasePath, mcpRemotePath,
  x402BasePath, x402BasePath + "/status",
]);
const capabilityEndpoints = new Set<string>();
for (const c of capabilities) {
  capabilityEndpoints.add("/api/v1" + c.path);
  capabilityEndpoints.add("/v1" + c.path);
  capabilityEndpoints.add(x402BasePath + c.path);
}
const knownEndpoints = new Set<string>([...staticEndpoints, ...capabilityEndpoints]);

// Match a path immediately following the production base URL, or a bare path after GET/POST,
// restricted to the known route-prefix shapes so we don't false-positive on unrelated strings
// like a local filesystem path (e.g. "/path/to/rafid-agent-api/dist/mcp.js").
const ENDPOINT_PATTERN = new RegExp(
  String.raw`(?:${PRODUCTION_BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}|\b(?:GET|POST)\s+)` +
  String.raw`(\/(?:api\/v1|v1|\.well-known|mcp\b|llms\.txt|openapi\.json|docs\b|health\b|agent\.json)[^\s"'` + "`" + String.raw`)>,]*)`,
  "g"
);

function normalizeEndpoint(raw: string): string {
  // Strip trailing punctuation a sentence might leave attached, and any query string.
  return raw.replace(/[.,;:!?]+$/, "").split("?")[0];
}

for (const [file, content] of fileContents) {
  if (!/\.(md|sh|mjs)$/.test(file)) continue;
  for (const match of content.matchAll(ENDPOINT_PATTERN)) {
    const path = normalizeEndpoint(match[1]);
    if (path.includes("<")) continue; // template placeholder, not a literal claimed endpoint
    if (path === "/mcp" || path === mcpRemotePath) continue; // exact match already in knownEndpoints
    if (!knownEndpoints.has(path)) {
      fail("a-endpoints-exist", rel(file), `references "${path}", which is not a route this API registers (checked against src/api/app.ts's own route prefixes)`);
    }
  }
}

// =============================== (b) Capability names match registry ===============================
const realNames = new Set(capabilities.map(c => c.name));
// The exact fictitious tool names a WebFetch hallucination invented for this project's roadmap
// section during this pack's own research phase (verified absent from src/domain/roadmap.ts) —
// a permanent regression guard against that specific failure re-entering the docs.
const knownHallucinatedNames = [
  "search_oman_tenders", "analyze_oman_tender", "match_company_to_tender",
  "discover_oman_business_opportunities", "find_oman_suppliers", "compare_oman_companies",
];
const SUSPICIOUS_TOOL_PATTERN = /\b[a-z]+_oman_(?:tender|business|companies|company|supplier|suppliers)\b/gi;

for (const [file, content] of fileContents) {
  if (!/\.md$/.test(file)) continue;
  for (const bad of knownHallucinatedNames) {
    if (content.includes(bad)) {
      fail("b-capability-names", rel(file), `contains "${bad}", a fictitious tool name that does not exist in the capability registry`);
    }
  }
  for (const match of content.matchAll(SUSPICIOUS_TOOL_PATTERN)) {
    if (!realNames.has(match[0])) {
      fail("b-capability-names", rel(file), `contains suspicious tool-shaped name "${match[0]}" that is not in the capability registry`);
    }
  }
}
// Every real capability name should be documented somewhere in the pack.
const allDistText = [...fileContents.values()].join("\n");
for (const name of realNames) {
  if (!allDistText.includes(name)) {
    fail("b-capability-names", "distribution/", `registry capability "${name}" is not mentioned anywhere in the distribution pack`);
  }
}

// ===================================== (c) Prices match registry =====================================
const priceByName: Record<string, number> = { ...prices };
const TOOL_NAME_ALTERNATION = [...realNames].join("|");
const PRICE_LINE_PATTERN = new RegExp(
  String.raw`\`(${TOOL_NAME_ALTERNATION})\`[^\n]*?\$([0-9]+(?:\.[0-9]+)?)`, "g"
);
for (const [file, content] of fileContents) {
  if (!/\.md$/.test(file)) continue;
  for (const match of content.matchAll(PRICE_LINE_PATTERN)) {
    const [, toolName, priceStr] = match;
    const claimed = Number.parseFloat(priceStr);
    const expected = priceByName[toolName];
    if (expected !== undefined && Math.abs(claimed - expected) > 1e-9) {
      fail("c-prices-match", rel(file), `states $${claimed} for \`${toolName}\`, but the registry price is $${expected}`);
    }
  }
}

// ============================ (d) Production base URL is centralized ============================
const URL_PATTERN = /https?:\/\/[a-zA-Z0-9.-]+(?:\/[^\s"'`)]*)?/g;
// Legitimate external documentation citations that are not this API's own base URL.
// github.com: the project's own public source repository (distinct from PRODUCTION_BASE_URL,
// the deployed API's origin) — linked for `git clone` in MCP.md's stdio fallback section.
const ALLOWED_EXTERNAL_HOSTS = ["cursor.com", "github.com"];
for (const [file, content] of fileContents) {
  if (!/\.(md|sh|mjs|json)$/.test(file)) continue;
  for (const match of content.matchAll(URL_PATTERN)) {
    const url = match[0];
    if (url.startsWith(PRODUCTION_BASE_URL)) continue;
    let host = "";
    try { host = new URL(url).host; } catch { /* ignore unparseable */ }
    if (ALLOWED_EXTERNAL_HOSTS.includes(host)) continue;
    fail("d-base-url-centralized", rel(file), `hardcodes a base URL ("${url}") other than PRODUCTION_BASE_URL (${PRODUCTION_BASE_URL}) or an allow-listed external doc citation`);
  }
}

// =============================== (e) No partner token exposed ===============================
const PARTNER_TOKEN_PATTERNS = [/al-mouj-muscat/i, /rafid_partner_/i];
for (const [file, content] of fileContents) {
  for (const pattern of PARTNER_TOKEN_PATTERNS) {
    if (pattern.test(content)) {
      fail("e-no-partner-token", rel(file), `matches banned partner-identifier pattern ${pattern}`);
    }
  }
}

// ===================================== (f) No API secrets =====================================
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9]{16,}\b/,          // OpenAI-style secret key
  /\bsk_live_[A-Za-z0-9]{16,}\b/,     // Stripe-style live secret key
  /\bpk_live_[A-Za-z0-9]{16,}\b/,
  /\bghp_[A-Za-z0-9]{20,}\b/,         // GitHub personal access token
  /\bAIza[A-Za-z0-9_-]{20,}\b/,       // Google API key
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, // Slack token
  /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,             // AWS access key id
];
for (const [file, content] of fileContents) {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      fail("f-no-api-secrets", rel(file), `matches a known secret-value pattern (${pattern})`);
    }
  }
}

// =================================== (g) No private keys ===================================
// A bare 64-hex-char sequence is the shape of a raw Ethereum/secp256k1 private key. Skip
// matches that are clearly something else shaped like hex (e.g. inside a longer alphanumeric
// token) by requiring a non-hex-word-char boundary on both sides.
const PRIVATE_KEY_HEX_PATTERN = /(?<![0-9a-fA-F])0x[0-9a-fA-F]{64}(?![0-9a-fA-F])|(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g;
for (const [file, content] of fileContents) {
  for (const match of content.matchAll(PRIVATE_KEY_HEX_PATTERN)) {
    fail("g-no-private-keys", rel(file), `contains a 64-hex-character sequence ("${match[0].slice(0, 10)}…"), the shape of a raw private key`);
  }
}

// ============================== (h) No stale demo-only wording ==============================
// Phrasing that would have been accurate before real Al Mouj Muscat partner data existed, and
// is now false as a blanket claim.
const STALE_DEMO_PATTERNS = [
  /\bno real (?:market )?data\b/i,
  /\bpurely (?:a )?demo(?:nstration)?\b/i,
  /\balways uses? demo data\b/i,
  /\bentirely (?:a )?demo dataset\b/i,
  /\bno partner integration\b/i,
];
for (const [file, content] of fileContents) {
  if (!/\.md$/.test(file)) continue;
  for (const pattern of STALE_DEMO_PATTERNS) {
    if (pattern.test(content)) {
      fail("h-no-stale-demo-wording", rel(file), `matches stale pre-partner-data phrasing pattern ${pattern} — analyze_oman_property now has real partner-fed data on configured deployments`);
    }
  }
}

// ================= (i) analyze_oman_property mentions Al Mouj partner-fed coverage =================
const omanCapability = capabilities.find(c => c.name === "analyze_oman_property");
if (!omanCapability) {
  fail("i-al-mouj-coverage", "src/domain/capabilities.ts", `analyze_oman_property is missing from the capability registry entirely`);
} else {
  if (!/al mouj/i.test(omanCapability.description)) {
    fail("i-al-mouj-coverage", "src/domain/capabilities.ts", `analyze_oman_property's description no longer mentions Al Mouj`);
  }
  if (!omanCapability.agentGuidance) {
    fail("i-al-mouj-coverage", "src/domain/capabilities.ts", `analyze_oman_property has lost its agentGuidance (priorityContexts/evidenceTypes/limitations/sampleQueries) block`);
  } else if (!omanCapability.agentGuidance.priorityContexts.some(p => /al mouj/i.test(p))) {
    fail("i-al-mouj-coverage", "src/domain/capabilities.ts", `analyze_oman_property's priorityContexts no longer mentions Al Mouj`);
  }
  if (!allDistText.toLowerCase().includes("al mouj")) {
    fail("i-al-mouj-coverage", "distribution/", `no distribution file mentions Al Mouj coverage for analyze_oman_property`);
  }
}

// ============== (j) Marketplace pack does not overclaim nationwide coverage ==============
const NATIONWIDE_PATTERNS = [
  /nationwide/i, /all of oman/i, /entire (?:country|nation)/i, /every governorate/i, /countrywide/i,
];
// A line containing one of the patterns above is only a violation if it *asserts* nationwide
// coverage. Every legitimate use in this pack is the opposite — a disclaimer telling the reader
// coverage is NOT nationwide (that's the whole point of section 13's "don't overstate" instruction)
// — so a line carrying a nearby negation cue is the disclaimer working as intended, not a violation.
const NEGATION_CUE = /\b(not|n't|never|no claim|without|isn't|shouldn't|don't|avoid|excludes?)\b/i;
for (const [file, content] of fileContents) {
  if (!/\.md$/.test(file)) continue;
  for (const line of content.split("\n")) {
    for (const pattern of NATIONWIDE_PATTERNS) {
      if (pattern.test(line) && !NEGATION_CUE.test(line)) {
        fail("j-no-nationwide-overclaim", rel(file), `line asserts nationwide-shaped coverage without a negation/disclaimer nearby (pattern ${pattern}): "${line.trim().slice(0, 140)}"`);
      }
    }
  }
}

// ================= manifest.json freshness (extends b/c to the generated file) =================
// distribution/manifest.json is generated (npm run distribution:manifest, run automatically
// before this check via the predistribution:check npm script) — verify what's on disk right now
// actually matches what generating it again would produce, so a hand-edit or a stale commit is
// caught rather than silently drifting from the registry it's supposed to be a projection of.
try {
  const manifestPath = resolvePath(DIST_DIR, "manifest.json");
  const onDisk = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (onDisk.capabilities?.length !== capabilities.length) {
    fail("manifest-freshness", "distribution/manifest.json", `has ${onDisk.capabilities?.length} capabilities on disk but the registry has ${capabilities.length} — run npm run distribution:manifest`);
  }
  for (const c of capabilities) {
    const entry = onDisk.capabilities?.find((m: { name: string }) => m.name === c.name);
    if (!entry) {
      fail("manifest-freshness", "distribution/manifest.json", `is missing registry capability "${c.name}" — run npm run distribution:manifest`);
    } else if (entry.price !== c.price || entry.description !== c.description) {
      fail("manifest-freshness", "distribution/manifest.json", `"${c.name}" entry is stale relative to the registry (price/description mismatch) — run npm run distribution:manifest`);
    }
  }
} catch (err) {
  fail("manifest-freshness", "distribution/manifest.json", `could not be read/parsed: ${(err as Error).message}`);
}

// ===================================================================================================
if (violations.length > 0) {
  process.stderr.write(`\ndistribution:check FAILED — ${violations.length} violation(s):\n\n`);
  for (const v of violations) {
    process.stderr.write(`  [${v.invariant}] ${v.file}\n      ${v.detail}\n`);
  }
  process.stderr.write("\n");
  process.exit(1);
} else {
  process.stdout.write(
    `distribution:check passed — ${textFiles.length} files scanned, ${capabilities.length} capabilities, ` +
    `${knownEndpoints.size} known endpoints, 10 invariants, 0 violations.\n`
  );
}
