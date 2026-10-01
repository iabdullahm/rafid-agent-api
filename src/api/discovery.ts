import { z } from "zod";
import { capabilities, capabilityCategory, discoveryCapabilities, TOOL_SELECTION_HIERARCHY, toolSelectionMetadata } from "../domain/capabilities.js";
import { buildCapabilitiesRegistry, paymentMethodsFor, type PaymentDiscoveryConfig } from "./agent.js";
import { PLATFORM_DESCRIPTION, PLATFORM_NAME } from "../brand.js";
import { x402BasePath } from "../billing/x402.js";
import { previewBasePath } from "./previewRoutes.js";

export const discoveryBasePath = "/api/v1/discovery";
export const discoverySearchPath = `${discoveryBasePath}/search`;
export const discoveryIntentsPath = `${discoveryBasePath}/intents`;
export const publicToolsPath = "/tools";

const CATEGORY_LABELS: Record<string, string> = {
  risk_intelligence: "Company & Risk Intelligence",
  finance_risk: "Finance Intelligence",
  document_intelligence: "Document Intelligence",
  automotive: "Automotive Intelligence",
  logistics: "Logistics Intelligence",
  property: "Property Intelligence",
  website_services: "Website Intelligence",
  recruitment: "Recruitment Intelligence",
  supplier: "Supplier Intelligence",
  trading: "Trading Intelligence",
  voice: "Voice / Communication",
  video_generation: "Video Generation",
  book_business: "Business Planning",
  other: "Other Intelligence"
};

type DiscoveryConfig = PaymentDiscoveryConfig & { mcpRemoteEnabled?: boolean };

const slug = (value: string) => value
  .normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "_")
  .replace(/^_+|_+$/g, "");

const tokenize = (value: string) => slug(value).split("_").filter(token => token.length > 1);

function absolute(baseUrl: string | undefined, path: string): string {
  return baseUrl ? new URL(path, baseUrl).toString() : path;
}

function hierarchyFor(c: (typeof capabilities)[number]) {
  const category = capabilityCategory(c);
  const hierarchy = TOOL_SELECTION_HIERARCHY[category] ?? TOOL_SELECTION_HIERARCHY.other;
  const role = toolSelectionMetadata(c).toolRole;
  return { category, role, primary: hierarchy.primary || c.name, supporting: [...hierarchy.supporting], specialized: [...hierarchy.specialized] };
}

export function buildCategoryIndex() {
  const counts = new Map<string, number>();
  for (const c of capabilities) counts.set(capabilityCategory(c), (counts.get(capabilityCategory(c)) ?? 0) + 1);
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([id, count]) => ({ id, name: CATEGORY_LABELS[id] ?? id, count }));
}

function intentEntries() {
  const entries = new Map<string, { capabilities: Set<string>; labels: Set<string> }>();
  const add = (intent: string, c: (typeof capabilities)[number], label = intent) => {
    const key = slug(intent);
    if (!key) return;
    const entry = entries.get(key) ?? { capabilities: new Set<string>(), labels: new Set<string>() };
    entry.capabilities.add(c.name);
    entry.labels.add(label);
    entries.set(key, entry);
  };
  for (const c of capabilities) {
    add(c.name, c, c.name);
    for (const useCase of c.useCases) add(useCase, c, useCase);
    for (const phrase of toolSelectionMetadata(c).recommendedFor) add(phrase, c, phrase);
  }
  return entries;
}

export function buildIntentIndex() {
  return [...intentEntries()].sort(([a], [b]) => a.localeCompare(b)).map(([intent, entry]) => {
    const tools = [...entry.capabilities].map(name => capabilities.find(c => c.name === name)!).filter(Boolean);
    const primary = tools.find(c => hierarchyFor(c).role === "primary") ?? tools[0];
    const primaryName = primary?.name ?? intent;
    const hierarchy = primary ? hierarchyFor(primary) : { supporting: [], specialized: [] };
    const related = [...new Set([...(hierarchy.supporting ?? []), ...(hierarchy.specialized ?? [])])].filter(name => entry.capabilities.has(name));
    return { intent, labels: [...entry.labels].slice(0, 8), primary: primaryName, supporting: related, capabilities: [...entry.capabilities] };
  });
}

export function buildIntentDetail(intent: string) {
  const key = slug(intent);
  const match = buildIntentIndex().find(item => item.intent === key);
  if (match) return match;
  const capability = capabilities.find(c => c.name === key);
  if (!capability) return null;
  const hierarchy = hierarchyFor(capability);
  return { intent: key, labels: [capability.whenToUse], primary: hierarchy.primary, supporting: hierarchy.supporting, capabilities: [capability.name, ...hierarchy.supporting, ...hierarchy.specialized].filter(name => capabilities.some(c => c.name === name)) };
}

function searchText(c: (typeof capabilities)[number]) {
  const selection = toolSelectionMetadata(c);
  return [c.name, capabilityCategory(c), c.description, c.whenToUse, ...c.useCases, ...selection.recommendedFor, ...selection.notFor, ...selection.preferOver].join(" ").toLowerCase();
}

export function searchCapabilities(query: string, config: DiscoveryConfig, baseUrl?: string) {
  const normalized = query.trim().toLowerCase();
  const tokens = tokenize(normalized);
  const matches = discoveryCapabilities.map(c => {
    const text = searchText(c);
    const exactPhrase = normalized && text.includes(normalized) ? 8 : 0;
    const overlap = tokens.reduce((score, token) => score + (text.includes(token) ? 1 : 0), 0);
    const selection = toolSelectionMetadata(c);
    const score = exactPhrase + overlap + (selection.toolRole === "primary" ? 0.35 : 0) + selection.selectionPriority / 10000;
    return { c, score, selection };
  }).filter(item => !normalized || item.score > 0)
    .sort((a, b) => b.score - a.score || b.selection.selectionPriority - a.selection.selectionPriority || a.c.name.localeCompare(b.c.name))
    .slice(0, 8);
  return {
    query,
    methodology: "Deterministic lexical matching over capability name, category, description, whenToUse, useCases and selection guidance. Results are not semantic AI judgments and are not ranked by price.",
    matches: matches.map(({ c, selection }) => {
      const category = capabilityCategory(c);
      return {
        capability: c.name,
        category,
        categoryName: CATEGORY_LABELS[category] ?? category,
        hierarchy: selection.toolRole,
        reason: selection.recommendedFor[0] ?? c.whenToUse,
        price: c.price,
        currency: c.currency,
        paymentProtocols: paymentMethodsFor(config),
        endpoint: absolute(baseUrl, `/api/v1${c.path}`),
        x402Endpoint: config.x402Enabled ? absolute(baseUrl, `${x402BasePath}${c.path}`) : null,
        mcpTool: c.name,
        mcpAvailable: true,
        previewAvailable: Boolean(c.preview)
      };
    })
  };
}

export function buildDiscoveryIndex(config: DiscoveryConfig, baseUrl?: string) {
  return {
    platform: PLATFORM_NAME,
    description: PLATFORM_DESCRIPTION,
    capabilityCount: capabilities.length,
    categories: buildCategoryIndex(),
    intents: absolute(baseUrl, discoveryIntentsPath),
    search: absolute(baseUrl, discoverySearchPath),
    capabilities: absolute(baseUrl, "/api/v1/capabilities"),
    mcp: { stdio: "npm run mcp", remote: config.mcpRemoteEnabled ? absolute(baseUrl, "/mcp") : null, status: absolute(baseUrl, "/api/v1/mcp/status") },
    a2a: absolute(baseUrl, "/.well-known/agent.json"),
    openapi: absolute(baseUrl, "/openapi.json"),
    llms: absolute(baseUrl, "/llms.txt"),
    tools: absolute(baseUrl, publicToolsPath),
    payments: { x402: Boolean(config.x402Enabled), l402: Boolean(config.l402Enabled), mpp: Boolean(config.mpp?.enabled), apiCredits: Boolean(config.billing?.enabled), methods: paymentMethodsFor(config) },
    selection: "Use /api/v1/discovery/search for a small deterministic candidate set; then inspect the selected capability's schema and preview before payment."
  };
}

const escapeHtml = (value: unknown) => String(value ?? "")
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function jsonLd(value: unknown): string {
  // Keep JSON-LD safe inside an HTML script element even when registry text contains markup-like
  // characters. The data still parses as JSON and remains derived from the canonical registry.
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function pageShell(title: string, description: string, canonical: string, body: string, headExtra = "") {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><meta name="description" content="${escapeHtml(description)}"><meta name="robots" content="index,follow"><link rel="canonical" href="${escapeHtml(canonical)}"><meta property="og:type" content="website"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta name="twitter:card" content="summary"><meta name="twitter:title" content="${escapeHtml(title)}"><meta name="twitter:description" content="${escapeHtml(description)}">${headExtra}</head><body><main>${body}</main></body></html>`;
}

export function renderToolIndex(config: DiscoveryConfig, baseUrl?: string, filters: { q?: string; category?: string; intent?: string } = {}) {
  const q = filters.q?.trim() ?? "";
  const search = q ? searchCapabilities(q, config, baseUrl).matches.map(item => item.capability) : null;
  const intent = filters.intent ? buildIntentDetail(filters.intent) : null;
  const rows = discoveryCapabilities.filter(c => (!search || search.includes(c.name)) && (!filters.category || capabilityCategory(c) === filters.category) && (!intent || intent.capabilities.includes(c.name)));
  const categoryLinks = buildCategoryIndex().map(category => `<a href="${publicToolsPath}?category=${encodeURIComponent(category.id)}">${escapeHtml(category.name)} (${category.count})</a>`).join(" | ");
  const cards = rows.map(c => {
    const category = capabilityCategory(c);
    const selection = toolSelectionMetadata(c);
    return `<article><h2><a href="${publicToolsPath}/${encodeURIComponent(c.name)}">${escapeHtml(c.name)}</a></h2><p>${escapeHtml(c.description)}</p><p><strong>${escapeHtml(CATEGORY_LABELS[category] ?? category)}</strong> · $${c.price.toFixed(2)} ${escapeHtml(c.currency)} · ${selection.toolRole} · ${c.preview ? "preview" : "no preview"} · MCP</p></article>`;
  }).join("\n");
  const canonical = absolute(baseUrl, publicToolsPath);
  const description = `Browse ${capabilities.length} structured capabilities by category, intent and use case.`;
  const structuredData = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: `${PLATFORM_NAME} tools`,
    description,
    url: canonical,
    isPartOf: { "@type": "WebSite", name: PLATFORM_NAME, url: baseUrl ?? canonical },
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: rows.length,
      itemListElement: rows.map((c, index) => ({ "@type": "ListItem", position: index + 1, name: c.name, url: absolute(baseUrl, `${publicToolsPath}/${c.name}`) }))
    },
    potentialAction: { "@type": "SearchAction", target: `${canonical}?q={search_term_string}`, "query-input": "required name=search_term_string" }
  };
  return pageShell(`${PLATFORM_NAME} tools`, description, canonical, `<h1>${escapeHtml(PLATFORM_NAME)} tools</h1><p>${escapeHtml(PLATFORM_DESCRIPTION)}</p><form method="get" action="${publicToolsPath}"><label>Search <input name="q" value="${escapeHtml(q)}"></label><button>Search</button></form><p>Capabilities: ${rows.length} of ${capabilities.length}</p><nav>${categoryLinks}</nav>${cards || "<p>No matching capabilities.</p>"}`, `<script type="application/ld+json">${jsonLd(structuredData)}</script>`);
}

export function renderToolPage(name: string, config: DiscoveryConfig, baseUrl?: string) {
  const c = capabilities.find(item => item.name === name);
  if (!c) return null;
  const category = capabilityCategory(c);
  const selection = toolSelectionMetadata(c);
  const hierarchy = hierarchyFor(c);
  const related = [...new Set([...hierarchy.supporting, ...hierarchy.specialized])].filter(name => name !== c.name && capabilities.some(item => item.name === name));
  const endpoint = absolute(baseUrl, `/api/v1${c.path}`);
  const x402 = absolute(baseUrl, `${x402BasePath}${c.path}`);
  const preview = c.preview ? absolute(baseUrl, `${previewBasePath}/${c.name}`) : null;
  const exampleOutput = JSON.stringify(c.exampleOutput, null, 2);
  const relatedHtml = related.length ? `<h2>Related tools</h2><ul>${related.map(name => `<li><a href="${publicToolsPath}/${encodeURIComponent(name)}">${escapeHtml(name)}</a></li>`).join("")}</ul>` : "";
  const canonical = absolute(baseUrl, `${publicToolsPath}/${c.name}`);
  const keywords = [...new Set([c.name, ...c.useCases, ...selection.recommendedFor, CATEGORY_LABELS[category] ?? category])];
  const structuredData = [
    { "@context": "https://schema.org", "@type": "SoftwareApplication", name: c.name, description: c.description, url: canonical, applicationCategory: CATEGORY_LABELS[category] ?? category, operatingSystem: "Web API", featureList: c.useCases, provider: { "@type": "Organization", name: PLATFORM_NAME, url: baseUrl ?? canonical }, offers: { "@type": "Offer", price: c.price.toFixed(2), priceCurrency: c.currency, url: canonical } },
    { "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: `${PLATFORM_NAME} tools`, item: absolute(baseUrl, publicToolsPath) }, { "@type": "ListItem", position: 2, name: c.name, item: canonical }] },
    { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: [{ "@type": "Question", name: "When should an agent use this tool?", acceptedAnswer: { "@type": "Answer", text: c.whenToUse } }, { "@type": "Question", name: "How is this tool accessed?", acceptedAnswer: { "@type": "Answer", text: `Use the REST endpoint ${endpoint}, the MCP tool ${c.name}, or the x402 endpoint ${x402}.` } }, { "@type": "Question", name: "What does it cost?", acceptedAnswer: { "@type": "Answer", text: `The registry price is ${c.price.toFixed(2)} ${c.currency} per call.` } }] }
  ];
  const body = `<h1>${escapeHtml(c.name)}</h1><p>${escapeHtml(c.description)}</p><h2>When to use</h2><p>${escapeHtml(c.whenToUse)}</p><h2>Selection guidance</h2><p>Role: ${escapeHtml(selection.toolRole)}. ${escapeHtml(selection.recommendedFor.join("; "))}</p>${selection.notFor.length ? `<p>Not for: ${escapeHtml(selection.notFor.join("; "))}</p>` : ""}<h2>Use cases</h2><ul>${c.useCases.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul><h2>Access</h2><ul><li>REST: <code>POST ${escapeHtml(endpoint)}</code></li><li>x402: <code>POST ${escapeHtml(x402)}</code></li><li>MCP tool: <code>${escapeHtml(c.name)}</code></li>${preview ? `<li>Free preview: <code>POST ${escapeHtml(preview)}</code></li>` : ""}</ul><p>Price: <strong>$${c.price.toFixed(2)} ${escapeHtml(c.currency)}</strong> per call. Payment options are deployment-configured; inspect /api/v1/payment-methods. Prices and payment semantics are unchanged from the canonical registry.</p>${relatedHtml}<h2>Example input</h2><pre>${escapeHtml(JSON.stringify(c.example, null, 2))}</pre><h2>Example output</h2><pre>${escapeHtml(exampleOutput)}</pre><h2>Input schema</h2><pre>${escapeHtml(JSON.stringify(z.toJSONSchema(c.input), null, 2))}</pre><h2>Output schema</h2><pre>${escapeHtml(JSON.stringify(z.toJSONSchema(c.output), null, 2))}</pre><p>Category: ${escapeHtml(CATEGORY_LABELS[category] ?? category)} · hierarchy: ${escapeHtml(hierarchy.role)} · idempotent: ${c.idempotent ? "yes" : "no"} · side effects: ${c.sideEffects ? "yes" : "no"}</p>`;
  return pageShell(`${c.name} · ${PLATFORM_NAME}`, c.description, canonical, body, `<meta name="keywords" content="${escapeHtml(keywords.join(", "))}"><script type="application/ld+json">${jsonLd(structuredData)}</script>`);
}

export function buildRobotsTxt(baseUrl?: string) {
  return `User-agent: *\nAllow: /agent.json\nAllow: /.well-known/agent.json\nAllow: /.well-known/ai-plugin.json\nAllow: /llms.txt\nAllow: /openapi.json\nAllow: /api/v1/capabilities\nAllow: /api/v1/discovery\nAllow: /api/v1/discovery/intents/\nAllow: /api/v1/mcp/status\nAllow: /tools/\nDisallow: /api/v1/internal/\nDisallow: /internal/\nSitemap: ${absolute(baseUrl, "/sitemap.xml")}\n`;
}

export function buildSitemapXml(baseUrl?: string) {
  const intentPaths = buildIntentIndex().map(item => `${discoveryIntentsPath}/${item.intent}`);
  const paths = ["/agent.json", "/.well-known/agent.json", "/.well-known/ai-plugin.json", "/llms.txt", "/openapi.json", "/api/v1/capabilities", "/api/v1/mcp/status", discoveryBasePath, discoverySearchPath, discoveryIntentsPath, ...intentPaths, publicToolsPath, ...capabilities.map(c => `${publicToolsPath}/${c.name}`)];
  const urls = paths.map(path => `<url><loc>${escapeHtml(absolute(baseUrl, path))}</loc><changefreq>${path.startsWith("/tools/") ? "weekly" : "daily"}</changefreq><priority>${path.startsWith("/tools/") ? "0.8" : "0.6"}</priority></url>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`;
}

export function buildDiscoveryOpenapiPaths(config: DiscoveryConfig) {
  const json = (example: unknown) => ({ "application/json": { schema: { type: "object" }, example: { success: true, data: example, meta: { requestId: "example-request" } } } });
  return {
    [discoveryBasePath]: { get: { operationId: "discovery_index", tags: ["Agent"], summary: "Compact platform discovery index", description: "Links the platform identity, categories, intent index, deterministic search, protocols and public tool pages. No internal endpoints or secrets.", security: [], responses: { "200": { description: "Discovery index", content: json(buildDiscoveryIndex(config)) } } } },
    [discoverySearchPath]: { get: { operationId: "discovery_search", tags: ["Agent"], summary: "Deterministic capability search", description: "Lexically matches capability metadata and selection guidance. This is not semantic AI ranking and does not rank by price.", security: [], parameters: [{ name: "q", in: "query", required: true, schema: { type: "string", minLength: 1 } }], responses: { "200": { description: "Candidate capabilities", content: json(searchCapabilities("check a supplier before onboarding", config)) } } } },
    [discoveryIntentsPath]: { get: { operationId: "discovery_intents", tags: ["Agent"], summary: "Machine-readable intent index", description: "Intent keys are derived from capability names, use cases and selection guidance.", security: [], responses: { "200": { description: "Intent index", content: json(buildIntentIndex()) } } } },
    [`${discoveryIntentsPath}/{intent}`]: { get: { operationId: "discovery_intent", tags: ["Agent"], summary: "Resolve one intent", security: [], parameters: [{ name: "intent", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Intent resolution", content: json(buildIntentDetail("company_due_diligence")) }, "404": { description: "Unknown intent" } } } },
    [publicToolsPath]: { get: { operationId: "public_tool_index", tags: ["Agent"], summary: "Browsable public capability index", security: [], responses: { "200": { description: "HTML tool index" } } } },
    [`${publicToolsPath}/{capability}`]: { get: { operationId: "public_tool_page", tags: ["Agent"], summary: "Public capability detail page", security: [], parameters: [{ name: "capability", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "HTML capability page" }, "404": { description: "Unknown capability" } } } }
  };
}
