import { adminLayout, fmtDate, table } from "./layout.js";
import type { SourceCoverageCard } from "../../business-data/admin/adminService.js";

/** Section 26: makes each source's real limitations obvious — never says "Live API" unless one
 *  genuinely exists (none of the three production sources do; see docs/business-intelligence.md's
 *  Source Feasibility Report). */
export function sourcesPageHtml(opts: { adminUser: string; csrfToken: string; sources: SourceCoverageCard[] }): string {
  const rows = table<SourceCoverageCard>([
    { header: "Source Name", render: c => c.label },
    { header: "Access Mode", render: c => c.accessMode },
    { header: "Automation Status", render: c => c.automationStatus },
    { header: "Records", render: c => String(c.records), align: "right" },
    { header: "Companies Covered", render: c => String(c.companiesCovered), align: "right" },
    { header: "Latest Import", render: c => c.latestImport ? fmtDate(c.latestImport.startedAt) : "—" },
    { header: "Status", render: c => c.records > 0 ? "Active — has records" : "No records imported yet" }
  ], opts.sources);
  const body = `<div class="panel"><h2>Source Management</h2><p style="color:var(--muted);font-size:12px;">Every real Oman source in this deployment is manual/admin import only — none offers a legitimate, unauthenticated bulk API (see the Source Feasibility Report in docs/business-intelligence.md). This page exists specifically so that limitation is never hidden from an operator.</p>${rows}</div>`;
  return adminLayout({ title: "Sources", activeNav: "sources", adminUser: opts.adminUser, csrfToken: opts.csrfToken, body });
}
