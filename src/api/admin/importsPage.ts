import { adminLayout, chip, csrfField, esc, fmtDate, table } from "./layout.js";
import type { SyncRunRecord } from "../../business-data/sources/companyRepository.js";

const SOURCE_OPTIONS: readonly { value: string; label: string }[] = [
  { value: "mociip", label: "MOCIIP (Oman Business company register)" },
  { value: "tax-oman", label: "Tax Oman (VATIN verification)" },
  { value: "tender-board-suppliers", label: "Tender Board / Esnad — Suppliers" },
  { value: "tender-board-awards", label: "Tender Board / Esnad — Awards" },
  { value: "generic", label: "Generic Business Import" }
];

/** Section 8/9/10/30: the Import Center. This is the one page in the whole dashboard that needs
 *  client-side JavaScript — reading the operator's chosen file happens entirely in the browser
 *  via FileReader and is POSTed as JSON text to the preview/execute API, so there is never a
 *  server-side temporary file to validate, name safely or clean up (Section 30's file-upload
 *  safety requirements are satisfied by construction: nothing is ever written to disk on this
 *  server). Every other page in this dashboard works with JavaScript disabled; this one degrades
 *  to "cannot select a file" without it, which is stated on the page. The CSRF token and a fresh
 *  per-file `previewToken` (a hash of the exact bytes just previewed) are required by
 *  /api/admin/business/imports/execute, so an operator can never execute a file that was not just
 *  previewed with these exact contents (Section 9: "never import immediately after upload"). */
export function importsPageHtml(opts: { adminUser: string; csrfToken: string; runs: SyncRunRecord[] }): string {
  const historyRows = table<SyncRunRecord>([
    { header: "Run ID", render: r => `<code>${esc(r.id.slice(0, 8))}</code>` },
    { header: "Source", render: r => esc(r.sourceName) },
    { header: "Started", render: r => fmtDate(r.startedAt) },
    { header: "Completed", render: r => fmtDate(r.finishedAt) },
    { header: "Status", render: r => chip(r.status) },
    { header: "Read", render: r => String(r.recordsSeen), align: "right" },
    { header: "Inserted", render: r => String(r.recordsInserted), align: "right" },
    { header: "Updated", render: r => String(r.recordsUpdated), align: "right" },
    { header: "Skipped", render: r => String(r.recordsSkipped), align: "right" },
    { header: "Error Summary", render: r => r.errorMessage ? esc(r.errorMessage) : "—" }
  ], opts.runs, "No imports have been run yet.");

  const sourceOptions = SOURCE_OPTIONS.map(s => `<option value="${s.value}">${esc(s.label)}</option>`).join("");

  const body = `
<div class="panel">
  <h2>1. Select source and file</h2>
  <noscript><p class="alert-error">The Import Center's preview step requires JavaScript to read the file you choose, entirely in your browser (nothing is uploaded until you click Preview). Please enable JavaScript, or use <code>npm run business:import</code> from a terminal instead.</p></noscript>
  <div class="filters">
    <div><label>Source</label><select id="importSource">${sourceOptions}</select></div>
    <div><label>File (.csv or .json)</label><input id="importFile" type="file" accept=".csv,.json"></div>
    <div><button id="previewBtn" type="button">Preview (dry run)</button></div>
  </div>
  <p id="importError" class="alert-error" style="display:none;"></p>
</div>

<div class="panel" id="previewPanel" style="display:none;">
  <h2>2. Preview result</h2>
  <div class="kpi-grid" id="previewKpis"></div>
  <div id="previewWarnings"></div>
  <h3 style="font-size:13px;color:var(--muted);">Sample normalized rows</h3>
  <div id="previewSample"></div>
  <h3 style="font-size:13px;color:var(--muted);">Rejected rows</h3>
  <div id="previewRejected"></div>
  <form id="executeForm" method="post" action="/api/admin/business/imports/execute">
    ${csrfField(opts.csrfToken)}
    <input type="hidden" name="redirectTo" value="/admin/business/imports">
    <input type="hidden" name="source" id="executeSource">
    <input type="hidden" name="fileName" id="executeFileName">
    <input type="hidden" name="content" id="executeContent">
    <input type="hidden" name="previewToken" id="executeToken">
    <button type="submit" id="executeBtn">3. Confirm and execute import</button>
    <span style="color:var(--muted);font-size:12px;">This writes to the production dataset through the same import pipeline <code>npm run business:import</code> uses, and records a sync-run.</span>
  </form>
</div>

<div class="panel">
  <h2>Import History</h2>
  ${historyRows}
</div>

<script>
(function () {
  var previewToken = null, previewedSource = null, previewedFileName = null, previewedContent = null;
  function kpi(label, value) { return '<div class="kpi"><div class="kpi-value">' + value + '</div><div class="kpi-label">' + label + '</div></div>'; }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  document.getElementById('previewBtn').addEventListener('click', function () {
    var fileInput = document.getElementById('importFile');
    var errEl = document.getElementById('importError');
    errEl.style.display = 'none';
    if (!fileInput.files || !fileInput.files[0]) { errEl.textContent = 'Choose a .csv or .json file first.'; errEl.style.display = 'block'; return; }
    var file = fileInput.files[0];
    if (!/\\.(csv|json)$/i.test(file.name)) { errEl.textContent = 'Only .csv and .json files are supported.'; errEl.style.display = 'block'; return; }
    if (file.size > 10 * 1024 * 1024) { errEl.textContent = 'File exceeds the 10 MB import limit.'; errEl.style.display = 'block'; return; }
    var reader = new FileReader();
    reader.onload = function () {
      var source = document.getElementById('importSource').value;
      var content = reader.result;
      fetch('/api/admin/business/imports/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ source: source, fileName: file.name, content: content })
      }).then(function (r) { return r.json(); }).then(function (json) {
        if (!json.success) { errEl.textContent = (json.error && json.error.message) || 'Preview failed.'; errEl.style.display = 'block'; return; }
        var d = json.data;
        previewToken = d.previewToken; previewedSource = source; previewedFileName = file.name; previewedContent = content;
        document.getElementById('previewPanel').style.display = 'block';
        document.getElementById('previewKpis').innerHTML = [
          kpi('Rows detected', d.totalRows), kpi('Valid rows', d.validRows), kpi('Invalid rows', d.invalidRows),
          kpi('New companies (approx.)', d.newCompanies), kpi('Matched companies', d.matchedCompanies),
          kpi('Records to update', d.recordsToUpdate), kpi('Duplicates skipped', d.duplicatesSkipped),
          kpi('Identity conflicts', d.identityConflicts)
        ].join('');
        document.getElementById('previewWarnings').innerHTML = (d.warnings || []).map(function (w) { return '<div class="warning-banner">' + esc(w) + '</div>'; }).join('');
        document.getElementById('previewSample').innerHTML = '<pre style="white-space:pre-wrap;font-size:11px;">' + esc(JSON.stringify(d.sample, null, 2)) + '</pre>';
        document.getElementById('previewRejected').innerHTML = (d.rejected && d.rejected.length)
          ? '<table><thead><tr><th>Row</th><th>Reason</th></tr></thead><tbody>' + d.rejected.map(function (e) { return '<tr><td>' + e.row + '</td><td>' + esc(e.reason) + '</td></tr>'; }).join('') + '</tbody></table>'
          : '<p class="empty">No rejected rows.</p>';
        document.getElementById('executeSource').value = previewedSource;
        document.getElementById('executeFileName').value = previewedFileName;
        document.getElementById('executeContent').value = previewedContent;
        document.getElementById('executeToken').value = previewToken;
      }).catch(function () { errEl.textContent = 'Preview request failed.'; errEl.style.display = 'block'; });
    };
    reader.readAsText(file);
  });
})();
</script>
`;
  return adminLayout({ title: "Import Center", activeNav: "imports", adminUser: opts.adminUser, csrfToken: opts.csrfToken, body });
}
