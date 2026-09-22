import { adminLayout, esc, fmtDate, kpiCard, table } from "./layout.js";
import type { ProcurementStats } from "../../business-data/admin/adminService.js";
import type { CompanyAwardRecord } from "../../business-data/types.js";

export function procurementPageHtml(opts: { adminUser: string; csrfToken: string; stats: ProcurementStats }): string {
  const s = opts.stats;
  const kpis = [
    kpiCard("Registered Suppliers", s.registeredSuppliers),
    kpiCard("Companies With Tender Activity", s.companiesWithTenderActivity),
    kpiCard("Companies With Awards", s.companiesWithAwards),
    kpiCard("Total Award Records", s.totalAwardRecords),
    kpiCard("Known Government Buyers", s.knownGovernmentBuyers),
    kpiCard("Recent Activity (90d)", s.recentProcurementActivity),
    kpiCard("Known Award Value (OMR)", s.knownAwardValueOMR.toLocaleString(), `${s.awardsMissingValueCount} award(s) with no recorded value excluded`),
    kpiCard("Suppliers Without CR Match", s.suppliersWithoutCRMatch)
  ].join("");

  const topCompanies = table(
    [
      { header: "Company", render: (c: ProcurementStats["topCompaniesByAwardCount"][number]) => `<a href="/admin/business/companies/${esc(c.companyId)}">${esc(c.companyName)}</a>` },
      { header: "Award Count", render: (c: ProcurementStats["topCompaniesByAwardCount"][number]) => String(c.awardCount), align: "right" },
      { header: "Known Value (OMR)", render: (c: ProcurementStats["topCompaniesByAwardCount"][number]) => c.knownAwardValueOMR.toLocaleString(), align: "right" }
    ],
    s.topCompaniesByAwardCount
  );

  const recentAwards = table(
    [
      { header: "Company ID", render: (a: CompanyAwardRecord) => `<a href="/admin/business/companies/${esc(a.companyId)}"><code>${esc(a.companyId.slice(0, 8))}</code></a>` },
      { header: "Tender #", render: (a: CompanyAwardRecord) => esc(a.tenderNumber) },
      { header: "Buyer", render: (a: CompanyAwardRecord) => esc(a.buyer ?? "—") },
      { header: "Value (OMR)", render: (a: CompanyAwardRecord) => a.awardValueOMR !== null ? a.awardValueOMR.toLocaleString() : "unknown", align: "right" },
      { header: "Observed", render: (a: CompanyAwardRecord) => fmtDate(a.observedAt) }
    ],
    s.recentAwards
  );

  const recentImports = table(
    [
      { header: "Source", render: r => esc(r.sourceName) },
      { header: "Started", render: r => fmtDate(r.startedAt) },
      { header: "Status", render: r => esc(r.status) }
    ],
    s.recentImports
  );

  const body = `
<div class="kpi-grid">${kpis}</div>
<div class="panel"><h2>Top Companies By Award Count</h2>${topCompanies}</div>
<div class="panel"><h2>Recent Awards</h2>${recentAwards}</div>
<div class="panel"><h2>Recent Tender Board Imports</h2>${recentImports}</div>
<p style="color:var(--muted);font-size:12px;">"Known award value" totals only awards with a recorded value on file — it is never inflated to imply completeness.</p>
`;
  return adminLayout({ title: "Procurement", activeNav: "procurement", adminUser: opts.adminUser, csrfToken: opts.csrfToken, body });
}

export function awardsPageHtml(opts: { adminUser: string; csrfToken: string; awards: CompanyAwardRecord[]; filters: { buyer?: string; category?: string; hasValue?: boolean } }): string {
  const rows = table<CompanyAwardRecord>([
    { header: "Company ID", render: a => `<a href="/admin/business/companies/${esc(a.companyId)}"><code>${esc(a.companyId.slice(0, 8))}</code></a>` },
    { header: "Tender #", render: a => esc(a.tenderNumber) },
    { header: "Buyer", render: a => esc(a.buyer ?? "—") },
    { header: "Title", render: a => esc(a.title ?? "—") },
    { header: "Category", render: a => esc(a.category ?? "—") },
    { header: "Value (OMR)", render: a => a.awardValueOMR !== null ? a.awardValueOMR.toLocaleString() : "unknown", align: "right" },
    { header: "Observed", render: a => fmtDate(a.observedAt) },
    { header: "Source", render: a => esc(a.sourceName) }
  ], opts.awards);

  const body = `
<form class="filters" method="get">
  <div><label>Buyer</label><input name="buyer" value="${esc(opts.filters.buyer ?? "")}"></div>
  <div><label>Category</label><input name="category" value="${esc(opts.filters.category ?? "")}"></div>
  <div><button type="submit">Filter</button></div>
</form>
<div class="panel"><h2>Awards (${opts.awards.length})</h2>${rows}</div>
`;
  return adminLayout({ title: "Awards", activeNav: "awards", adminUser: opts.adminUser, csrfToken: opts.csrfToken, body });
}
