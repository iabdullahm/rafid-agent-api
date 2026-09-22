import { adminLayout, chip, csrfField, esc, fmtDate, table } from "./layout.js";
import type { CompanyAdminView, ReviewQueueItem } from "../../business-data/admin/adminService.js";
import type { CompanyRecord } from "../../business-data/sources/companyRepository.js";
import type { UnmatchedRecord } from "../../business-data/types.js";

// ---- Tax Oman manual verification queue (Section 12/13) --------------------------------------

export function taxVerificationPageHtml(opts: { adminUser: string; csrfToken: string; rows: CompanyAdminView[] }): string {
  const rows = opts.rows.map(v => `
    <tr>
      <td><a href="/admin/business/companies/${esc(v.companyId)}">${esc(v.companyName)}</a></td>
      <td>${esc(v.registrationNumber ?? "—")}</td>
      <td>${chip(v.taxVerificationStatus ?? "unknown", v.taxVerificationStatus ?? "unknown")}</td>
      <td>${fmtDate(v.lastVerifiedAt)}</td>
      <td>${chip(!v.registrationNumber ? "low" : v.registeredSupplier ? "high" : "medium")}</td>
      <td>
        <form method="post" action="/api/admin/business/tax-verification/${esc(v.companyId)}" class="filters" style="margin:0;gap:6px;">
          ${csrfField(opts.csrfToken)}
          <input type="hidden" name="redirectTo" value="/admin/business/tax-verification">
          <select name="outcome" required>
            <option value="verified">Verified</option>
            <option value="not_registered">Not Registered</option>
            <option value="pending">Could Not Verify</option>
            <option value="unknown">Needs Review</option>
          </select>
          <input name="vatNumber" placeholder="VAT number (optional)" style="width:120px">
          <input type="date" name="observedAt" value="${new Date().toISOString().slice(0, 10)}" required>
          <input name="note" placeholder="Note (optional)" style="width:140px">
          <button type="submit">Record</button>
        </form>
      </td>
    </tr>`).join("\n");

  const body = `
<div class="panel">
  <h2>Tax Oman Manual Verification Queue (${opts.rows.length})</h2>
  <p style="color:var(--muted);font-size:12px;">Tax Oman cannot be safely automated (CAPTCHA-gated, robots.txt disallowed). Perform the lookup yourself in a separate tab, then record the human-observed outcome below — it is written as new Tax Oman source evidence and the merged company view is recalculated from it, never applied as a direct edit.</p>
  <table><thead><tr><th>Company Name</th><th>CR Number</th><th>Current Status</th><th>Last Checked</th><th>Priority</th><th>Record Outcome</th></tr></thead>
  <tbody>${rows || `<tr><td colspan="6" class="empty">Queue is empty.</td></tr>`}</tbody></table>
</div>`;
  return adminLayout({ title: "Tax Verification", activeNav: "tax", adminUser: opts.adminUser, csrfToken: opts.csrfToken, body });
}

// ---- Conflict Review Queue (Section 14) -------------------------------------------------------

export function conflictsPageHtml(opts: { adminUser: string; csrfToken: string; rows: CompanyAdminView[] }): string {
  const sections = opts.rows.map(v => {
    const rowsTable = table([
      { header: "Row ID", render: (r: CompanyRecord) => `<code>${esc(r.id)}</code>` },
      { header: "Name", render: (r: CompanyRecord) => esc(r.companyName) },
      { header: "Address", render: (r: CompanyRecord) => esc(r.address ?? "—") },
      { header: "Source", render: (r: CompanyRecord) => `${esc(r.sourceName)} (${esc(r.sourceType)})` },
      { header: "Observed", render: (r: CompanyRecord) => fmtDate(r.observedAt) }
    ], v.activeRows);
    return `<div class="panel">
      <h2><a href="/admin/business/companies/${esc(v.companyId)}">${esc(v.companyName)}</a></h2>
      <p style="color:var(--muted);font-size:12px;">${v.hasIdentityConflict ? "Contributing sources report different company names. " : ""}${v.hasAddressConflict ? "Contributing sources report different addresses." : ""}</p>
      ${rowsTable}
      <form method="post" action="/api/admin/business/conflicts/${esc(v.companyId)}/resolve" class="filters" style="margin-top:10px;">
        ${csrfField(opts.csrfToken)}
        <input type="hidden" name="redirectTo" value="/admin/business/conflicts">
        <div><label>Row to act on (for "Keep separate" / "Flag incorrect")</label>
          <select name="rowId"><option value="">— none —</option>${v.activeRows.map(r => `<option value="${esc(r.id)}">${esc(r.sourceName)} — ${esc(r.companyName)}</option>`).join("")}</select>
        </div>
        <div><label>Note</label><input name="note"></div>
        <div><button type="submit" name="action" value="reviewed">Mark as reviewed</button></div>
        <div><button type="submit" name="action" value="confirmed_same" class="secondary">Confirm same company</button></div>
        <div><button type="submit" name="action" value="kept_separate" class="secondary">Keep separate (split selected row)</button></div>
        <div><button type="submit" name="action" value="rejected" class="danger">Flag selected row as incorrect</button></div>
        <div><button type="submit" name="action" value="needs_verification" class="secondary">Needs further verification</button></div>
      </form>
    </div>`;
  }).join("\n") || `<p class="empty">No unresolved conflicts.</p>`;
  const body = `<div class="panel"><h2>Conflict Review Queue (${opts.rows.length})</h2><p style="color:var(--muted);font-size:12px;">Every action here is conservative: nothing is auto-merged. "Keep separate" splits the selected row into its own company identity; "Flag incorrect" excludes that one source row from future calculations without deleting it. Every resolution is recorded in the audit trail.</p></div>${sections}`;
  return adminLayout({ title: "Conflicts", activeNav: "conflicts", adminUser: opts.adminUser, csrfToken: opts.csrfToken, body });
}

// ---- Stale Records Queue (Section 15) ---------------------------------------------------------

export function stalePageHtml(opts: { adminUser: string; csrfToken: string; groups: { sourceType: string; rows: CompanyRecord[] }[] }): string {
  const sections = opts.groups.map(g => {
    const rowsTable = table([
      { header: "Company", render: (r: CompanyRecord) => `<a href="/admin/business/companies/${esc(r.companyId)}">${esc(r.companyName)}</a>` },
      { header: "Source", render: (r: CompanyRecord) => esc(r.sourceName) },
      { header: "Last Verified", render: (r: CompanyRecord) => fmtDate(r.lastVerifiedAt) },
      { header: "Days Old", render: (r: CompanyRecord) => String(Math.round((Date.now() - Date.parse(r.observedAt)) / 86_400_000)), align: "right" },
      { header: "Action", render: (r: CompanyRecord) => `<form method="post" action="/api/admin/business/companies/${esc(r.companyId)}/flag" style="display:inline">${csrfField(opts.csrfToken)}<input type="hidden" name="rowId" value="${esc(r.id)}"><input type="hidden" name="flag" value="needs_verification"><input type="hidden" name="redirectTo" value="/admin/business/stale"><button type="submit" class="secondary">Mark for follow-up</button></form>` }
    ], g.rows);
    return `<div class="panel"><h2>${esc(g.sourceType)} (${g.rows.length})</h2>${rowsTable}</div>`;
  }).join("\n") || `<p class="empty">No stale records.</p>`;
  const body = `<div class="panel"><h2>Stale Records Queue</h2><p style="color:var(--muted);font-size:12px;">Grouped by source. A record only becomes fresh again when real new evidence is imported or verified — this queue never lets you fake a refresh by editing a timestamp. Use <a href="/admin/business/companies">Export CSV</a> from the Companies page (with the Freshness=stale filter) for a re-verification worklist.</p></div>${sections}`;
  return adminLayout({ title: "Stale Data", activeNav: "stale", adminUser: opts.adminUser, csrfToken: opts.csrfToken, body });
}

// ---- Verification Work Queue (Section 16) ------------------------------------------------------

export function reviewPageHtml(opts: { adminUser: string; csrfToken: string; items: ReviewQueueItem[] }): string {
  const rows = table<ReviewQueueItem>([
    { header: "Company", render: i => `<a href="/admin/business/companies/${esc(i.companyId)}">${esc(i.companyName)}</a>` },
    { header: "Priority", render: i => chip(i.priority) },
    { header: "Reasons", render: i => i.reasons.map(r => `<code>${esc(r)}</code>`).join(" ") },
    { header: "Recommended Action", render: i => esc(i.recommendedAction) }
  ], opts.items, "Nothing needs review right now.");
  const body = `<div class="panel"><h2>Verification Work Queue (${opts.items.length})</h2><p style="color:var(--muted);font-size:12px;">Priority is computed deterministically from fixed rules (identity conflicts and stale government records are High; low confidence or unknown tax status are Medium; everything else is Low) — never an LLM judgment call.</p>${rows}</div>`;
  return adminLayout({ title: "Review Queue", activeNav: "review", adminUser: opts.adminUser, csrfToken: opts.csrfToken, body });
}

// ---- Unmatched Records (Section 19) ------------------------------------------------------------

export function unmatchedPageHtml(opts: { adminUser: string; csrfToken: string; records: UnmatchedRecord[] }): string {
  const rows = opts.records.map(u => `
    <tr>
      <td>${esc(u.sourceType)}</td>
      <td>${esc(u.sourceName)}</td>
      <td>${esc(u.reason)}</td>
      <td>${esc(u.reasonDetail)}</td>
      <td><code>${esc(JSON.stringify(u.rawPayload)).slice(0, 200)}</code></td>
      <td>${fmtDate(u.createdAt)}</td>
      <td>
        <form method="post" action="/api/admin/business/unmatched/${esc(u.id)}/resolve" class="filters" style="margin:0;gap:6px;">
          ${csrfField(opts.csrfToken)}
          <input type="hidden" name="redirectTo" value="/admin/business/unmatched">
          <input name="linkedCompanyId" placeholder="companyId to link (optional)" style="width:180px">
          <input name="note" placeholder="Note" style="width:120px">
          <button type="submit" name="status" value="linked">Link</button>
          <button type="submit" name="status" value="rejected" class="danger">Reject</button>
        </form>
      </td>
    </tr>`).join("\n");
  const body = `<div class="panel">
    <h2>Unmatched Records (${opts.records.length} unresolved)</h2>
    <p style="color:var(--muted);font-size:12px;">Import rows that could not be safely auto-linked to a company — never fuzzy-auto-linked from this screen. Enter an existing companyId to link the row's evidence to it, or reject the row outright. Both actions are audited.</p>
    <table><thead><tr><th>Source Type</th><th>Source Name</th><th>Reason</th><th>Detail</th><th>Raw Payload</th><th>Created</th><th>Resolve</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="7" class="empty">No unresolved unmatched records.</td></tr>`}</tbody></table>
  </div>`;
  return adminLayout({ title: "Unmatched Records", activeNav: "unmatched", adminUser: opts.adminUser, csrfToken: opts.csrfToken, body });
}
