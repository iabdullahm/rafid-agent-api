import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { capabilities, capabilityCategory } from "../src/domain/capabilities.js";

/** Generates a registry-derived coverage matrix for the production-readiness audit.
 * It intentionally reports route families as projections of the canonical registry rather than
 * maintaining a second capability list. Run `npm run audit:capabilities` after registry changes. */
const root = resolve(import.meta.dirname, "..");
const out = resolve(root, "docs", "capability-coverage-matrix.md");
const esc = (value: unknown) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const yes = (value: boolean) => value ? "PASS" : "WARN";

const rows = capabilities.map((c, index) => {
  const issues = [
    !c.description || c.description.length < 45 ? "weak description" : "",
    !c.whenToUse ? "missing whenToUse" : "",
    c.useCases.length === 0 ? "no use cases" : "",
    c.example === undefined || c.exampleOutput === undefined ? "missing example" : "",
    !c.input || !c.output ? "missing schema" : "",
    c.price < 0 ? "invalid price" : ""
  ].filter(Boolean).join(", ");
  return `| ${index + 1} | \`${esc(c.name)}\` | ${esc(capabilityCategory(c))} | $${c.price.toFixed(2)} ${esc(c.currency)} | ${yes(Boolean(c.path))} | PASS | PASS | PASS | ${yes(Boolean(c.preview))} | PASS | ${yes(Boolean(c.agentGuidance))} | ${esc(issues || "—")} |`;
}).join("\n");

mkdirSync(resolve(root, "docs"), { recursive: true });
writeFileSync(out, `# Capability coverage matrix\n\nGenerated from \`src/domain/capabilities.ts\` on ${new Date().toISOString()}. Counts and route-family status are derived from the canonical registry; PASS means the public route family is registry-driven, not that a live deployment has been verified.\n\n- Canonical capabilities: **${capabilities.length}**\n- REST routes: **${capabilities.length}**\n- MCP tools: **${capabilities.length}**\n- OpenAPI operations: **${capabilities.length}**\n- A2A/agent-card skills: **${capabilities.length}**\n- Public tool pages: **${capabilities.length}**\n- Preview-enabled: **${capabilities.filter(c => Boolean(c.preview)).length}**\n- Paid: **${capabilities.filter(c => c.price > 0).length}**\n\n| # | Capability | Category | Price | REST | MCP | OpenAPI | A2A | Preview | Tool page | Guidance | Notes |\n|---:|---|---|---:|---|---|---|---|---|---|---|---|\n${rows}\n`);
console.log(`Wrote ${out} (${capabilities.length} capabilities)`);
