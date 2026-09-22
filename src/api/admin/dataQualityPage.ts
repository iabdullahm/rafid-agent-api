import { adminLayout, kpiCard, table } from "./layout.js";
import type { CoverageBreakdownRow, CoverageBreakdowns, DataQualityStats } from "../../business-data/admin/adminService.js";

export function dataQualityPageHtml(opts: { adminUser: string; csrfToken: string; stats: DataQualityStats; coverage: CoverageBreakdowns }): string {
  const s = opts.stats;
  const kpis = [
    kpiCard("Missing CR", s.missingCR), kpiCard("Missing Industry", s.missingIndustry), kpiCard("Missing Governorate", s.missingGovernorate),
    kpiCard("Missing Registration Date", s.missingRegistrationDate), kpiCard("Missing Tax Status", s.missingTaxStatus),
    kpiCard("Low Confidence", s.lowConfidence), kpiCard("Stale Records", s.staleRecords), kpiCard("Conflicting Records", s.conflictingRecords),
    kpiCard("Unmatched Source Records", s.unmatchedSourceRecords), kpiCard("Single-Source Companies", s.companiesWithOnlySource),
    kpiCard("Data Completeness", `${s.dataCompletenessPercent}%`, "Mean % of important fields populated per company — a different metric from confidence")
  ].join("");

  const breakdownTable = (rows: readonly CoverageBreakdownRow[]) => table(
    [
      { header: "Key", render: (r: CoverageBreakdownRow) => r.key },
      { header: "Companies", render: (r: CoverageBreakdownRow) => String(r.companies), align: "right" },
      { header: "Real", render: (r: CoverageBreakdownRow) => String(r.realCompanies), align: "right" },
      { header: "Identity Verified", render: (r: CoverageBreakdownRow) => String(r.identityVerified), align: "right" }
    ],
    rows
  );

  const body = `
<div class="kpi-grid">${kpis}</div>
<div class="panel"><h2>Current Dataset Coverage — By Governorate</h2>${breakdownTable(opts.coverage.byGovernorate)}</div>
<div class="panel"><h2>Current Dataset Coverage — By Industry</h2>${breakdownTable(opts.coverage.byIndustry)}</div>
<div class="panel"><h2>Current Dataset Coverage — By Source Type</h2>${breakdownTable(opts.coverage.bySourceType)}</div>
<div class="panel"><h2>Current Dataset Coverage — By Verification Status</h2>${breakdownTable(opts.coverage.byVerificationStatus)}</div>
<p style="color:var(--muted);font-size:12px;">These breakdowns describe the CURRENT dataset only — they do not represent the true distribution of all companies in Oman.</p>
`;
  return adminLayout({ title: "Data Quality", activeNav: "dataQuality", adminUser: opts.adminUser, csrfToken: opts.csrfToken, body });
}
