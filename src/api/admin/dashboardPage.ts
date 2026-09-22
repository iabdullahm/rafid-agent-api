import { adminLayout, chip, csrfField, esc, fmtDate, kpiCard, progressBar, table } from "./layout.js";
import type { DashboardStats, SourceCoverageCard } from "../../business-data/admin/adminService.js";
import type { SyncRunRecord } from "../../business-data/sources/companyRepository.js";

export function dashboardPageHtml(opts: { adminUser: string; csrfToken: string; stats: DashboardStats; sources: SourceCoverageCard[] }): string {
  const s = opts.stats;
  const kpis = [
    kpiCard("Total Companies", s.totalCompanies),
    kpiCard("Real Companies", s.realCompanies),
    kpiCard("Demo Companies", s.demoCompanies),
    kpiCard("Identity Verified", s.identityVerified),
    kpiCard("Tax Verified", s.taxVerified),
    kpiCard("Government Suppliers", s.governmentSuppliers),
    kpiCard("With Procurement History", s.companiesWithProcurementHistory),
    kpiCard("With Awards", s.companiesWithAwards),
    kpiCard("Stale Company Records", s.staleCompanyRecords),
    kpiCard("Conflicting Companies", s.conflictingCompanies),
    kpiCard("Failed Imports", s.failedImports),
    kpiCard("Imports (Last 24h)", s.importsLast24Hours)
  ].join("");

  const progress = [
    progressBar("Real companies", s.realCompanies, s.targets.realCompanies, s.progress.realCompanies),
    progressBar("Identity verified", s.identityVerified, s.targets.identityVerified, s.progress.identityVerified),
    progressBar("Tax verified", s.taxVerified, s.targets.taxVerified, s.progress.taxVerified),
    progressBar("Tender Board suppliers", s.governmentSuppliers, s.targets.tenderBoardSuppliers, s.progress.tenderBoardSuppliers),
    progressBar("With procurement history", s.companiesWithProcurementHistory, s.targets.withProcurementHistory, s.progress.withProcurementHistory)
  ].join("");

  const importRows = (Object.entries(s.lastImportPerSource) as [string, SyncRunRecord | null][])
    .map(([key, run]) => `<tr><td>${esc(key)}</td><td>${run ? chip(run.status) : chip("never", "unknown")}</td><td>${run ? fmtDate(run.startedAt) : "—"}</td><td>${run ? esc(run.recordsInserted + run.recordsUpdated) : "—"}</td></tr>`)
    .join("\n");

  const sourceTable = table(
    [
      { header: "Source", render: (c: SourceCoverageCard) => esc(c.label) },
      { header: "Records", render: (c: SourceCoverageCard) => String(c.records), align: "right" },
      { header: "Companies", render: (c: SourceCoverageCard) => String(c.companiesCovered), align: "right" },
      { header: "Latest Observed", render: (c: SourceCoverageCard) => fmtDate(c.latestObservedAt) },
      { header: "Latest Import", render: (c: SourceCoverageCard) => c.latestImport ? `${fmtDate(c.latestImport.startedAt)} ${chip(c.latestImport.status)}` : "—" },
      { header: "Fresh", render: (c: SourceCoverageCard) => String(c.freshRecords), align: "right" },
      { header: "Stale", render: (c: SourceCoverageCard) => String(c.staleRecords), align: "right" }
    ],
    opts.sources
  );

  const banner = s.demoCompanies > 0
    ? `<div class="warning-banner">This dataset includes ${s.demoCompanies} compan${s.demoCompanies === 1 ? "y" : "ies"} backed only by the built-in curated demo dataset — never presented as real, verified Oman business data. See the "Real / Demo" filter on the Companies page.</div>`
    : "";

  const body = `
${banner}
<div class="kpi-grid">${kpis}</div>
<div class="detail-grid">
  <div class="panel">
    <h2>Dataset Progress Toward Targets</h2>
    ${progress}
    <p style="color:var(--muted);font-size:12px;">Targets are configurable — see <code>src/business-data/config/datasetTargets.ts</code> or the <code>OMAN_BUSINESS_TARGET_*</code> environment variables.</p>
  </div>
  <div class="panel">
    <h2>Last Import Per Source</h2>
    <table><thead><tr><th>Source</th><th>Status</th><th>Started</th><th>Rows Written</th></tr></thead><tbody>${importRows}</tbody></table>
    <p style="color:var(--muted);font-size:12px;margin-top:10px;">
      ${s.latestSuccessfulImport ? `Latest successful import: ${fmtDate(s.latestSuccessfulImport.startedAt)} (${esc(s.latestSuccessfulImport.sourceName)})` : "No successful imports yet."}<br>
      ${s.latestFailedImport ? `Latest failed import: ${fmtDate(s.latestFailedImport.startedAt)} (${esc(s.latestFailedImport.sourceName)})` : "No failed imports on record."}
    </p>
  </div>
</div>
<div class="panel">
  <h2>Source Coverage</h2>
  ${sourceTable}
</div>
<div class="panel">
  <h2>Bulk Recalculate Intelligence</h2>
  <p style="color:var(--muted);font-size:12px;">Re-runs the deterministic scoring/merge engine over current evidence for the chosen scope — never re-fetches an external site, never edits stored data.</p>
  <form method="post" action="/api/admin/business/recalculate-bulk" class="filters">
    ${csrfField(opts.csrfToken)}
    <input type="hidden" name="redirectTo" value="/admin/business/dashboard">
    <div><label>Scope</label><select name="scope">
      <option value="all">All companies</option>
      <option value="stale">Stale records only</option>
      <option value="conflicts">Conflicting records only</option>
    </select></div>
    <div><button type="submit">Recalculate</button></div>
  </form>
</div>
`;
  return adminLayout({ title: "Overview", activeNav: "dashboard", adminUser: opts.adminUser, csrfToken: opts.csrfToken, body });
}
