import { adminLayout, boolChip, chip, csrfField, esc, fmtDate, pagination, table } from "./layout.js";
import type { CompanyAdminView, CompanyListFilters, CompanyListResult } from "../../business-data/admin/adminService.js";
import type { CompanyRecord } from "../../business-data/sources/companyRepository.js";
import { sourceAuthority } from "../../business-data/scoring/sourceTrust.js";

function filterForm(filters: CompanyListFilters): string {
  const f = (v: unknown) => (v === undefined || v === null ? "" : esc(v));
  return `<form class="filters" method="get">
    <div><label>Search</label><input name="q" value="${f(filters.q)}" placeholder="Name, CR, VAT, companyId"></div>
    <div><label>Source</label><select name="source"><option value="">Any</option>
      ${["government", "tax_authority", "government_procurement", "company_website", "licensed_feed", "directory", "news", "demo", "other", "admin_manual"].map(s => `<option value="${s}" ${filters.source === s ? "selected" : ""}>${s}</option>`).join("")}
    </select></div>
    <div><label>Verification</label><select name="verificationStatus"><option value="">Any</option>
      ${["verified", "reported", "estimated", "inferred", "stale", "conflicting", "unknown"].map(s => `<option value="${s}" ${filters.verificationStatus === s ? "selected" : ""}>${s}</option>`).join("")}
    </select></div>
    <div><label>Tax status</label><select name="taxStatus"><option value="">Any</option>
      ${["verified", "not_registered", "pending", "unknown", "none"].map(s => `<option value="${s}" ${filters.taxStatus === s ? "selected" : ""}>${s}</option>`).join("")}
    </select></div>
    <div><label>Supplier</label><select name="supplierStatus"><option value="">Any</option>
      ${[["supplier", "Registered supplier"], ["not_supplier", "Not a supplier"], ["unknown", "Unknown"]].map(([v, l]) => `<option value="${v}" ${filters.supplierStatus === v ? "selected" : ""}>${l}</option>`).join("")}
    </select></div>
    <div><label>Status</label><select name="status"><option value="">Any</option>
      ${["active", "inactive", "suspended", "unknown"].map(s => `<option value="${s}" ${filters.status === s ? "selected" : ""}>${s}</option>`).join("")}
    </select></div>
    <div><label>Governorate</label><input name="governorate" value="${f(filters.governorate)}"></div>
    <div><label>Industry</label><input name="industry" value="${f(filters.industry)}"></div>
    <div><label>Freshness</label><select name="freshness"><option value="">Any</option>
      ${["fresh", "stale"].map(s => `<option value="${s}" ${filters.freshness === s ? "selected" : ""}>${s}</option>`).join("")}
    </select></div>
    <div><label>Conflicts</label><select name="hasConflicts"><option value="">Any</option>
      <option value="true" ${filters.hasConflicts === true ? "selected" : ""}>Has conflicts</option>
      <option value="false" ${filters.hasConflicts === false ? "selected" : ""}>No conflicts</option>
    </select></div>
    <div><label>Awards</label><select name="hasAwards"><option value="">Any</option>
      <option value="true" ${filters.hasAwards === true ? "selected" : ""}>Has awards</option>
      <option value="false" ${filters.hasAwards === false ? "selected" : ""}>No awards</option>
    </select></div>
    <div><label>Real / Demo</label><select name="realOrDemo"><option value="">Any</option>
      <option value="real" ${filters.realOrDemo === "real" ? "selected" : ""}>Real</option>
      <option value="demo" ${filters.realOrDemo === "demo" ? "selected" : ""}>Demo only</option>
    </select></div>
    <div><button type="submit">Apply filters</button></div>
    <div><a class="btn secondary" href="/admin/business/companies">Reset</a></div>
  </form>`;
}

export function companiesListPageHtml(opts: { adminUser: string; csrfToken: string; filters: CompanyListFilters; result: CompanyListResult; queryString: URLSearchParams }): string {
  const rows = table<CompanyAdminView>([
    { header: "Company Name", render: v => `<a href="/admin/business/companies/${esc(v.companyId)}">${esc(v.companyName)}</a>` },
    { header: "CR Number", render: v => esc(v.registrationNumber ?? "—") },
    { header: "Status", render: v => chip(v.status ?? "unknown") },
    { header: "Governorate", render: v => esc(v.governorate ?? "—") },
    { header: "Industry", render: v => esc(v.industry ?? "—") },
    { header: "Verification", render: v => chip(v.verificationStatus) },
    { header: "Confidence", render: v => v.confidence.toFixed(2), align: "right" },
    { header: "Tax Status", render: v => chip(v.taxVerificationStatus ?? "unknown", v.taxVerificationStatus ?? "unknown") },
    { header: "Supplier", render: v => boolChip(v.registeredSupplier, "Supplier", "Not registered") },
    { header: "Awards", render: v => String(v.awardCount), align: "right" },
    { header: "Last Verified", render: v => fmtDate(v.lastVerifiedAt) },
    { header: "Freshness", render: v => chip(v.freshness) },
    { header: "Sources", render: v => String(v.sourceCount), align: "right" }
  ], opts.result.rows);

  const csv = new URLSearchParams(opts.queryString); csv.delete("page");
  const manualCreateForm = `<details class="panel">
    <summary style="cursor:pointer;color:var(--muted);font-size:13px;">+ Create company manually (use only when necessary)</summary>
    <form method="post" action="/api/admin/business/companies/manual" class="filters" style="margin-top:14px;">
      ${csrfField(opts.csrfToken)}
      <input type="hidden" name="redirectTo" value="/admin/business/companies">
      <div><label>Company name (required)</label><input name="companyName" required></div>
      <div><label>CR number (recommended)</label><input name="registrationNumber"></div>
      <div><label>Governorate (recommended)</label><input name="governorate"></div>
      <div><label>Industry</label><input name="industry"></div>
      <div><label>Note</label><input name="note"></div>
      <div><button type="submit">Create</button></div>
    </form>
    <p style="color:var(--muted);font-size:12px;margin-top:8px;">Created with sourceType <code>admin_manual</code> and verificationStatus <code>reported</code> — never treated as government-verified.</p>
  </details>`;
  const body = `
${filterForm(opts.filters)}
${manualCreateForm}
<div class="panel">
  <h2>Companies (${opts.result.total} match${opts.result.total === 1 ? "" : "es"})</h2>
  <div class="actions-row"><a class="btn secondary" href="/api/admin/business/companies/export.csv?${csv.toString()}">Export CSV</a></div>
  ${rows}
  ${pagination("/admin/business/companies", opts.queryString, opts.result.page, opts.result.totalPages)}
</div>`;
  return adminLayout({ title: "Companies", activeNav: "companies", adminUser: opts.adminUser, csrfToken: opts.csrfToken, body });
}

function sourceRowsTable(rows: readonly CompanyRecord[]): string {
  return table([
    { header: "Source Name", render: (r: CompanyRecord) => esc(r.sourceName) },
    { header: "Type", render: (r: CompanyRecord) => chip(r.sourceType, r.sourceType === "demo" ? "demo" : undefined) },
    { header: "Authority", render: (r: CompanyRecord) => sourceAuthority(r.sourceType).toFixed(2), align: "right" },
    { header: "Record ID", render: (r: CompanyRecord) => esc(r.sourceRecordId ?? "—") },
    { header: "Observed", render: (r: CompanyRecord) => fmtDate(r.observedAt) },
    { header: "Last Seen", render: (r: CompanyRecord) => fmtDate(r.lastSeenAt) },
    { header: "Verification", render: (r: CompanyRecord) => chip(r.verificationStatus) },
    { header: "Version", render: (r: CompanyRecord) => String(r.recordVersion), align: "right" },
    { header: "Admin Flag", render: (r: CompanyRecord) => r.adminFlag ? chip(r.adminFlag) : "—" }
  ], rows);
}

export function companyDetailPageHtml(opts: { adminUser: string; csrfToken: string; view: CompanyAdminView; recalcMessage?: string }): string {
  const v = opts.view;
  const c = v.merge.company;
  const identity = `<dl class="fieldlist">
    <dt>companyId</dt><dd><code>${esc(v.companyId)}</code></dd>
    <dt>Name</dt><dd>${esc(v.companyName)}</dd>
    <dt>CR Number</dt><dd>${esc(v.registrationNumber ?? "—")}</dd>
    <dt>Legal type</dt><dd>${esc(v.legalType ?? "—")}</dd>
    <dt>Status</dt><dd>${chip(v.status ?? "unknown")}</dd>
    <dt>Registered</dt><dd>${esc(v.registrationDate ?? "—")}</dd>
    <dt>Industry</dt><dd>${esc(v.industry ?? "—")}</dd>
    <dt>Activities</dt><dd>${esc(c.activities.join(", ") || "—")}</dd>
    <dt>Governorate</dt><dd>${esc(v.governorate ?? "—")}</dd>
    <dt>Wilayat</dt><dd>${esc(v.wilayat ?? "—")}</dd>
  </dl>`;

  const verification = `<dl class="fieldlist">
    <dt>Verification</dt><dd>${chip(v.verificationStatus)}</dd>
    <dt>Identity verified</dt><dd>${boolChip(v.identityVerified, "Yes", "No")}</dd>
    <dt>Confidence</dt><dd>${v.confidence.toFixed(2)}</dd>
    <dt>Last verified</dt><dd>${fmtDate(v.lastVerifiedAt)}</dd>
    <dt>Freshness</dt><dd>${chip(v.freshness)}</dd>
    <dt>Real / Demo</dt><dd>${v.isReal ? chip("Real", "real") : chip("Demo only", "demo")}</dd>
  </dl>`;

  const tax = `<dl class="fieldlist">
    <dt>VAT number</dt><dd>${esc(v.vatNumber ?? "—")}</dd>
    <dt>Tax status</dt><dd>${chip(v.taxVerificationStatus ?? "unknown", v.taxVerificationStatus ?? "unknown")}</dd>
    <dt>Tax verified at</dt><dd>${fmtDate(c.taxVerifiedAt)}</dd>
  </dl>`;

  const procurement = `<dl class="fieldlist">
    <dt>Registered supplier</dt><dd>${boolChip(v.registeredSupplier, "Yes", "No")}</dd>
    <dt>Supplier category</dt><dd>${esc(c.supplierCategory ?? "—")}</dd>
    <dt>Classification</dt><dd>${esc(c.supplierClassification ?? "—")}</dd>
    <dt>Tenders participated</dt><dd>${esc(v.tendersParticipated ?? "—")}</dd>
    <dt>Award count</dt><dd>${v.awardCount}</dd>
    <dt>Known award value</dt><dd>${v.knownAwardValueOMR.toLocaleString()} OMR</dd>
    <dt>Last tender activity</dt><dd>${fmtDate(c.lastTenderActivityAt)}</dd>
  </dl>`;

  const risk = `<dl class="fieldlist">
    <dt>Risk level</dt><dd>${chip(v.riskLevel)}</dd>
    <dt>Risk score</dt><dd>${v.riskScore}</dd>
  </dl>
  <ul>${v.riskFlags.map(f => `<li>${chip(f.severity)} <strong>${esc(f.code)}</strong> — ${esc(f.message)}</li>`).join("") || "<li>No risk flags.</li>"}</ul>
  <p style="color:var(--muted);font-size:12px;">Risk is always computed by the deterministic risk engine from stored evidence — it cannot be edited directly here.</p>`;

  const awardsTable = table([
    { header: "Tender #", render: (a: typeof v.awards[number]) => esc(a.tenderNumber) },
    { header: "Buyer", render: (a: typeof v.awards[number]) => esc(a.buyer ?? "—") },
    { header: "Title", render: (a: typeof v.awards[number]) => esc(a.title ?? "—") },
    { header: "Category", render: (a: typeof v.awards[number]) => esc(a.category ?? "—") },
    { header: "Value (OMR)", render: (a: typeof v.awards[number]) => a.awardValueOMR !== null ? a.awardValueOMR.toLocaleString() : "unknown", align: "right" },
    { header: "Observed", render: (a: typeof v.awards[number]) => fmtDate(a.observedAt) },
    { header: "Source", render: (a: typeof v.awards[number]) => esc(a.sourceName) }
  ], v.awards, "No award/contract records on file.");

  const fieldEvidence = v.merge.provenance.map(p =>
    `<li><code>${esc(p.fields.join(", "))}</code> — source = ${esc(p.sourceName)}, authority = ${p.sourceAuthority.toFixed(2)}, verified = ${p.verificationStatus === "verified" ? "yes" : "no"}, observed = ${fmtDate(p.observedAt)}</li>`
  ).join("") || "<li>No provenance recorded.</li>";

  const manualEvidenceForm = `<form method="post" action="/api/admin/business/evidence" class="panel">
    <h2>Manual Evidence Entry</h2>
    ${csrfField(opts.csrfToken)}
    <input type="hidden" name="companyId" value="${esc(v.companyId)}">
    <input type="hidden" name="redirectTo" value="/admin/business/companies/${esc(v.companyId)}">
    <div class="filters" style="margin-bottom:10px;">
      <div><label>Field</label><select name="field">
        ${["status", "industry", "governorate", "wilayat", "address", "website", "email", "phone", "employeeRange", "legalType"].map(f => `<option value="${f}">${f}</option>`).join("")}
      </select></div>
      <div><label>Value</label><input name="value" required></div>
      <div><label>Source name</label><input name="sourceName" value="Admin manual entry" required></div>
      <div><label>Source record id (optional)</label><input name="sourceRecordId"></div>
      <div><label>Observed at</label><input type="date" name="observedAt" value="${new Date().toISOString().slice(0, 10)}" required></div>
      <div><label>Note</label><input name="note"></div>
    </div>
    <button type="submit">Add evidence</button>
    <p style="color:var(--muted);font-size:12px;margin-top:8px;">Recorded with sourceType <code>admin_manual</code> (authority 0.20) — never treated as government verification.</p>
  </form>`;

  const recalcForm = `<form method="post" action="/api/admin/business/companies/${esc(v.companyId)}/recalculate">
    ${csrfField(opts.csrfToken)}
    <input type="hidden" name="redirectTo" value="/admin/business/companies/${esc(v.companyId)}">
    <button type="submit">Recalculate Intelligence</button>
  </form>`;

  const body = `
${opts.recalcMessage ? `<div class="alert-success">${esc(opts.recalcMessage)}</div>` : ""}
<div class="actions-row">${recalcForm}</div>
<div class="detail-grid">
  <div class="panel"><h2>Identity</h2>${identity}</div>
  <div class="panel"><h2>Verification</h2>${verification}</div>
  <div class="panel"><h2>Tax</h2>${tax}</div>
  <div class="panel"><h2>Procurement</h2>${procurement}</div>
</div>
<div class="panel"><h2>Risk</h2>${risk}</div>
<div class="panel"><h2>Sources (${v.rows.length})</h2>${sourceRowsTable(v.rows)}</div>
<div class="panel"><h2>Field Evidence</h2><ul>${fieldEvidence}</ul></div>
<div class="panel"><h2>Awards</h2>${awardsTable}</div>
${manualEvidenceForm}
`;
  return adminLayout({ title: v.companyName, activeNav: "companies", adminUser: opts.adminUser, csrfToken: opts.csrfToken, body });
}
