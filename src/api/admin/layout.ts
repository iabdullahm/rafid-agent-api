/**
 * Admin & Data Operations Dashboard — shared page shell (Section 34/35).
 *
 * Plain, dependency-free server-rendered HTML — no frontend framework, no build step, no bundler
 * — mirroring the exact idiom src/api/landing.ts already uses for the public landing page (the
 * repository has no templating engine, no views/public/static directory and no React/Vite/Next
 * anywhere; see docs/business-admin.md's "Why plain server-rendered HTML" section for the full
 * reasoning). Every mutation on every page is a plain HTML `<form method="post">` with a hidden
 * CSRF field, so the dashboard works with JavaScript disabled; the one exception (the Import
 * Center's client-side file preview) is documented at its own page.
 */

export const NAV_ITEMS: readonly { key: string; label: string; href: string }[] = [
  { key: "dashboard", label: "Overview", href: "/admin/business/dashboard" },
  { key: "companies", label: "Companies", href: "/admin/business/companies" },
  { key: "imports", label: "Imports", href: "/admin/business/imports" },
  { key: "review", label: "Review Queue", href: "/admin/business/review" },
  { key: "tax", label: "Tax Verification", href: "/admin/business/tax-verification" },
  { key: "conflicts", label: "Conflicts", href: "/admin/business/conflicts" },
  { key: "stale", label: "Stale Data", href: "/admin/business/stale" },
  { key: "unmatched", label: "Unmatched Records", href: "/admin/business/unmatched" },
  { key: "procurement", label: "Procurement", href: "/admin/business/procurement" },
  { key: "awards", label: "Awards", href: "/admin/business/awards" },
  { key: "dataQuality", label: "Data Quality", href: "/admin/business/data-quality" },
  { key: "sources", label: "Sources", href: "/admin/business/sources" },
  { key: "audit", label: "Audit Log", href: "/admin/business/audit" },
  { key: "system", label: "System", href: "/admin/system" }
];

export function esc(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try { return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC"; } catch { return esc(iso); }
}

const CHIP_CLASSES: Record<string, string> = {
  verified: "chip chip-green", reported: "chip chip-blue", estimated: "chip chip-amber", inferred: "chip chip-amber",
  stale: "chip chip-red", conflicting: "chip chip-red", unknown: "chip chip-gray",
  active: "chip chip-green", inactive: "chip chip-gray", suspended: "chip chip-red",
  fresh: "chip chip-green", high: "chip chip-red", medium: "chip chip-amber", low: "chip chip-gray",
  real: "chip chip-green", demo: "chip chip-amber",
  succeeded: "chip chip-green", failed: "chip chip-red", running: "chip chip-blue", partial: "chip chip-amber", dry_run: "chip chip-gray",
  not_registered: "chip chip-red", pending: "chip chip-amber"
};

/** Section 34's status-chip vocabulary (Verified/Unknown/Stale/Conflict/Real/Demo/Tax Verified/
 *  Supplier, etc.) — one shared renderer so every page's chips look identical. */
export function chip(label: string | null | undefined, key?: string): string {
  if (label === null || label === undefined || label === "") return `<span class="chip chip-gray">—</span>`;
  const cls = CHIP_CLASSES[(key ?? String(label)).toLowerCase()] ?? "chip chip-gray";
  return `<span class="${cls}">${esc(label)}</span>`;
}

export function boolChip(value: boolean | null | undefined, trueLabel: string, falseLabel: string): string {
  if (value === null || value === undefined) return chip("Unknown", "unknown");
  return value ? chip(trueLabel, "verified") : chip(falseLabel, "unknown");
}

export interface TableColumn<T> { header: string; render: (row: T) => string; align?: "left" | "right" }

/** One shared, dependency-free table renderer used by nearly every list/queue page — Section
 *  34's "dense but readable" table look, defined once. */
export function table<T>(columns: readonly TableColumn<T>[], rows: readonly T[], emptyMessage = "No records match the current filters."): string {
  if (rows.length === 0) return `<p class="empty">${esc(emptyMessage)}</p>`;
  const head = columns.map(c => `<th${c.align === "right" ? ' class="right"' : ""}>${esc(c.header)}</th>`).join("");
  const body = rows.map(r => `<tr>${columns.map(c => `<td${c.align === "right" ? ' class="right"' : ""}>${c.render(r)}</td>`).join("")}</tr>`).join("\n");
  return `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function kpiCard(label: string, value: string | number, sub?: string): string {
  return `<div class="kpi"><div class="kpi-value">${esc(value)}</div><div class="kpi-label">${esc(label)}</div>${sub ? `<div class="kpi-sub">${esc(sub)}</div>` : ""}</div>`;
}

export function progressBar(label: string, value: number, target: number, percent: number): string {
  return `<div class="progress-row"><div class="progress-label">${esc(label)} <span class="progress-figures">${esc(value)} / ${esc(target)} (${esc(percent)}%)</span></div>
  <div class="progress-track"><div class="progress-fill" style="width:${Math.max(0, Math.min(100, percent))}%"></div></div></div>`;
}

export function csrfField(csrfToken: string): string {
  return `<input type="hidden" name="_csrf" value="${esc(csrfToken)}">`;
}

export function pagination(baseHref: string, params: URLSearchParams, page: number, totalPages: number): string {
  if (totalPages <= 1) return "";
  const linkFor = (p: number) => { const sp = new URLSearchParams(params); sp.set("page", String(p)); return `${baseHref}?${sp.toString()}`; };
  const parts: string[] = [];
  if (page > 1) parts.push(`<a href="${esc(linkFor(page - 1))}">&larr; Previous</a>`);
  parts.push(`<span class="page-indicator">Page ${page} of ${totalPages}</span>`);
  if (page < totalPages) parts.push(`<a href="${esc(linkFor(page + 1))}">Next &rarr;</a>`);
  return `<nav class="pagination">${parts.join(" ")}</nav>`;
}

const CSS = `
:root { color-scheme: light dark; --bg:#0b1220; --panel:#121b2e; --panel2:#0f1729; --border:#1f2b40; --text:#e6ebf2; --muted:#9fb0c9; --accent:#2563eb; }
* { box-sizing: border-box; }
body { margin:0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background:var(--bg); color:var(--text); }
a { color:#8ab4ff; text-decoration:none; }
a:hover { text-decoration:underline; }
.shell { display:flex; min-height:100vh; }
nav.sidebar { width:220px; flex:0 0 220px; background:var(--panel); border-right:1px solid var(--border); padding:20px 0; position:sticky; top:0; height:100vh; overflow-y:auto; }
nav.sidebar .brand { padding:0 18px 16px; font-weight:700; font-size:15px; border-bottom:1px solid var(--border); margin-bottom:8px; }
nav.sidebar .brand small { display:block; color:var(--muted); font-weight:400; font-size:11px; margin-top:2px; }
nav.sidebar a { display:block; padding:8px 18px; color:var(--muted); font-size:13px; }
nav.sidebar a.active { color:var(--text); background:var(--panel2); border-left:3px solid var(--accent); font-weight:600; }
nav.sidebar a:hover { color:var(--text); text-decoration:none; }
main.content { flex:1; padding:24px 32px 64px; max-width:1400px; }
.topbar { display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; }
.topbar h1 { font-size:20px; margin:0; }
.topbar .user { color:var(--muted); font-size:12px; }
.topbar form { display:inline; }
.topbar button.link { background:none; border:none; color:#8ab4ff; cursor:pointer; padding:0; font-size:12px; }
.panel { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:18px 20px; margin-bottom:20px; }
.panel h2 { font-size:14px; margin:0 0 12px; color:var(--muted); text-transform:uppercase; letter-spacing:0.04em; }
.kpi-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap:12px; margin-bottom:20px; }
.kpi { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:14px 16px; }
.kpi-value { font-size:22px; font-weight:700; }
.kpi-label { color:var(--muted); font-size:12px; margin-top:2px; }
.kpi-sub { color:var(--muted); font-size:11px; margin-top:4px; }
table { width:100%; border-collapse:collapse; font-size:13px; }
.table-wrap { overflow-x:auto; }
th { text-align:left; color:var(--muted); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:0.03em; padding:8px 10px; border-bottom:1px solid var(--border); white-space:nowrap; }
td { padding:8px 10px; border-bottom:1px solid var(--panel2); vertical-align:top; }
td.right, th.right { text-align:right; }
tr:hover td { background:var(--panel2); }
.chip { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; border:1px solid transparent; white-space:nowrap; }
.chip-green { color:#7fe0a4; background:#0f2a1c; border-color:#1d4a30; }
.chip-blue { color:#8ab4ff; background:#101f36; border-color:#1f3a5c; }
.chip-amber { color:#e6b35c; background:#2c220f; border-color:#4a3a1d; }
.chip-red { color:#ff8f8f; background:#2c1414; border-color:#4a1f1f; }
.chip-gray { color:var(--muted); background:var(--panel2); border-color:var(--border); }
.progress-row { margin-bottom:14px; }
.progress-label { font-size:12px; color:var(--muted); margin-bottom:4px; display:flex; justify-content:space-between; }
.progress-figures { color:var(--text); }
.progress-track { background:var(--panel2); border-radius:6px; height:8px; overflow:hidden; }
.progress-fill { background:var(--accent); height:100%; }
form.filters { display:flex; flex-wrap:wrap; gap:10px; margin-bottom:16px; align-items:end; }
form.filters label { display:block; font-size:11px; color:var(--muted); margin-bottom:4px; }
form.filters input, form.filters select { background:var(--panel2); border:1px solid var(--border); color:var(--text); border-radius:6px; padding:6px 8px; font-size:13px; }
button, .btn { background:var(--accent); color:#fff; border:none; border-radius:6px; padding:7px 14px; font-size:13px; cursor:pointer; font-weight:600; }
button.secondary, .btn.secondary { background:var(--panel2); border:1px solid var(--border); color:var(--text); }
button.danger, .btn.danger { background:#7a2323; }
.empty { color:var(--muted); font-size:13px; padding:20px 0; }
.pagination { margin-top:14px; display:flex; gap:14px; align-items:center; font-size:13px; }
.page-indicator { color:var(--muted); }
.detail-grid { display:grid; grid-template-columns: 1fr 1fr; gap:20px; }
@media (max-width: 900px) { .detail-grid { grid-template-columns: 1fr; } .shell { flex-direction:column; } nav.sidebar { width:100%; height:auto; position:relative; } }
dl.fieldlist { margin:0; display:grid; grid-template-columns: 140px 1fr; gap:6px 12px; font-size:13px; }
dl.fieldlist dt { color:var(--muted); }
dl.fieldlist dd { margin:0; }
.warning-banner { background:#2c220f; border:1px solid #4a3a1d; color:#e6b35c; border-radius:8px; padding:10px 14px; margin-bottom:16px; font-size:13px; }
.alert-error { background:#2c1414; border:1px solid #4a1f1f; color:#ff8f8f; border-radius:8px; padding:10px 14px; margin-bottom:16px; font-size:13px; }
.alert-success { background:#0f2a1c; border:1px solid #1d4a30; color:#7fe0a4; border-radius:8px; padding:10px 14px; margin-bottom:16px; font-size:13px; }
textarea { width:100%; background:var(--panel2); border:1px solid var(--border); color:var(--text); border-radius:6px; padding:8px; font-family:ui-monospace,monospace; font-size:12px; }
code { background:var(--panel2); padding:1px 5px; border-radius:4px; font-size:12px; }
.actions-row { display:flex; gap:8px; flex-wrap:wrap; margin-top:10px; }
`;

export interface LayoutOptions {
  title: string;
  activeNav: string;
  adminUser?: string;
  csrfToken?: string;
  body: string;
  banner?: string;
}

export function adminLayout(opts: LayoutOptions): string {
  const navHtml = NAV_ITEMS.map(item => `<a class="${item.key === opts.activeNav ? "active" : ""}" href="${item.href}">${esc(item.label)}</a>`).join("\n");
  const topbarRight = opts.adminUser
    ? `<span class="user">${esc(opts.adminUser)} &middot; <form method="post" action="/admin/logout" style="display:inline">${csrfField(opts.csrfToken ?? "")}<button type="submit" class="link">Log out</button></form></span>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)} · Oman Business Admin</title>
<meta name="robots" content="noindex, nofollow">
<style>${CSS}</style>
</head>
<body>
<div class="shell">
  <nav class="sidebar">
    <div class="brand">Oman Business Admin<small>Data Operations Console</small></div>
    ${navHtml}
  </nav>
  <main class="content">
    <div class="topbar"><h1>${esc(opts.title)}</h1>${topbarRight}</div>
    ${opts.banner ?? ""}
    ${opts.body}
  </main>
</div>
</body>
</html>`;
}
