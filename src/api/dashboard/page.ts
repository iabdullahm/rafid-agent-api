import { esc } from "../admin/layout.js";
import type { DashboardData, DashboardPeriod } from "./service.js";

/**
 * Rafid Property Intelligence — "AI Agent Operations Command Center" internal dashboard.
 *
 * Still a plain, dependency-free server-rendered HTML shell, matching the exact idiom every other
 * internal/documentation page in this codebase already uses (src/api/swagger.ts, src/api/
 * landing.ts, src/api/admin/*Page.ts) — no frontend framework, no build step, no bundler, no
 * charting/animation library added for this redesign. The page renders once server-side with the
 * caller's initial period's data (embedded as JSON, never re-fetched on first paint); period
 * changes and a lightweight background poll afterwards fetch GET /internal/dashboard/data?period=
 * (same-origin, cookie-authenticated — the SAME existing route as before this redesign, no new
 * endpoint was added) and re-render client-side with the SAME rendering functions — no full page
 * reload, no server secrets ever reach this page or that JSON response (see dashboardRoutes.ts's
 * doc comment, and the "no dashboard secrets exposed" tests in tests/dashboard.test.ts).
 *
 * Every visual element that looks "live" is driven by real fields on DashboardData (see service.ts:
 * agents, activityFeed, systemHealth, sparklines, toolConversion, x402Funnel, etc.) — nothing here
 * fabricates a number. Where the underlying data genuinely doesn't exist yet (e.g. no per-call
 * intermediate telemetry is ever recorded — see analytics/types.ts's privacy doc comment), the
 * "Live Analysis" and "Calculation" panels show the REAL last-call outcome (success/fail, latency,
 * data source, call counts) next to a generic, clearly-labeled reference pipeline/formula — never
 * an invented result value. The one exception is the optional ?demo=1 illustrative activity-feed
 * rows, which are rendered client-side only, always tagged "DEMO ACTIVITY", and never influence any
 * KPI, table, or chart on the page — see renderActivityFeed()/DEMO_FEED_ITEMS below.
 */

const CSS = `
:root {
  color-scheme: dark;
  --bg:#070b14; --bg-grid: rgba(37,99,235,0.05);
  --panel:#0f1729cc; --panel-solid:#0f1729; --panel2:#0c1322; --border:#1c2942; --border-soft:#16213a;
  --text:#e8edf7; --muted:#8ea0c0; --muted-dim:#5d6d8a;
  --accent:#2f6bff; --accent-soft:#1a3a7a; --cyan:#22d3ee; --cyan-soft:#0e3b45;
  --green:#34e0a1; --green-soft:#0f2a1f; --amber:#f2b84b; --amber-soft:#2c220f; --red:#ff6b7a; --red-soft:#2c1420;
  --sidebar-w: 224px; --radius: 12px;
  --glow-blue: 0 0 0 1px rgba(47,107,255,0.35), 0 0 24px rgba(47,107,255,0.12);
  --glow-cyan: 0 0 0 1px rgba(34,211,238,0.3), 0 0 20px rgba(34,211,238,0.10);
  --glow-green: 0 0 0 1px rgba(52,224,161,0.3), 0 0 20px rgba(52,224,161,0.10);
  --glow-red: 0 0 0 1px rgba(255,107,122,0.35), 0 0 20px rgba(255,107,122,0.12);
}
* { box-sizing: border-box; }
html, body { height:100%; }
body {
  margin:0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  background:
    radial-gradient(900px 480px at 85% -10%, rgba(47,107,255,0.10), transparent 60%),
    radial-gradient(700px 420px at -5% 10%, rgba(34,211,238,0.07), transparent 60%),
    var(--bg);
  color:var(--text);
}
a { color:#8ab4ff; text-decoration:none; }
a:hover { text-decoration:underline; }
button { font-family:inherit; }
.shell { display:flex; min-height:100vh; }

/* ---------------------------------------------------------------- Sidebar ------------------- */
.sidebar {
  width:var(--sidebar-w); flex:0 0 var(--sidebar-w); background:var(--panel-solid); border-right:1px solid var(--border);
  display:flex; flex-direction:column; padding:18px 14px; position:sticky; top:0; height:100vh; overflow-y:auto; z-index:20;
}
.sidebar .brand { display:flex; align-items:center; gap:10px; padding:6px 8px 18px; }
.sidebar .brand .mark {
  width:30px; height:30px; border-radius:9px; background:linear-gradient(135deg, var(--accent), var(--cyan));
  display:flex; align-items:center; justify-content:center; font-weight:800; font-size:14px; color:#04121f; flex:none;
}
.sidebar .brand .name { font-weight:700; font-size:14px; line-height:1.2; }
.sidebar .brand .sub { color:var(--muted); font-size:10.5px; letter-spacing:0.02em; }
.sidebar nav { display:flex; flex-direction:column; gap:2px; margin-top:4px; }
.sidebar nav a {
  display:flex; align-items:center; gap:10px; color:var(--muted); text-decoration:none; padding:9px 10px; border-radius:8px; font-size:13px; font-weight:500;
}
.sidebar nav a svg { width:16px; height:16px; flex:none; opacity:0.85; }
.sidebar nav a:hover { background:var(--panel2); color:var(--text); }
.sidebar nav a.active { background:linear-gradient(90deg, var(--accent-soft), transparent); color:#fff; box-shadow: inset 2px 0 0 var(--accent); }
.sidebar .spacer { flex:1; }
.workforce-status {
  margin-top:16px; padding:12px; border-radius:10px; background:var(--panel2); border:1px solid var(--border-soft);
}
.workforce-status .row { display:flex; align-items:center; gap:8px; font-size:12px; font-weight:600; }
.workforce-status .label { color:var(--muted); font-size:10.5px; text-transform:uppercase; letter-spacing:0.05em; margin-bottom:6px; }
.dot { width:8px; height:8px; border-radius:50%; flex:none; }
.dot-green { background:var(--green); box-shadow:0 0 0 3px rgba(52,224,161,0.18); }
.dot-blue { background:var(--accent); box-shadow:0 0 0 3px rgba(47,107,255,0.18); }
.dot-amber { background:var(--amber); box-shadow:0 0 0 3px rgba(242,184,75,0.18); }
.dot-red { background:var(--red); box-shadow:0 0 0 3px rgba(255,107,122,0.18); }
.dot-gray { background:var(--muted-dim); }
.pulse { animation: pulseDot 1.8s ease-in-out infinite; }
@keyframes pulseDot { 0%,100% { opacity:1; transform:scale(1); } 50% { opacity:0.55; transform:scale(1.25); } }

/* ---------------------------------------------------------------- Layout -------------------- */
.content { flex:1; min-width:0; }
main { max-width:1400px; margin:0 auto; padding:22px 26px 72px; }
.mobile-topbar { display:none; }

/* ---------------------------------------------------------------- Hero ---------------------- */
.hero { display:flex; justify-content:space-between; align-items:flex-start; gap:20px; margin-bottom:18px; flex-wrap:wrap; }
.hero h1 { font-size:22px; margin:0; letter-spacing:-0.01em; }
.hero .sub { color:var(--muted); font-size:13px; margin-top:4px; }
.hero-right { display:flex; flex-direction:column; align-items:flex-end; gap:8px; }
.live-indicator { display:flex; align-items:center; gap:7px; font-size:12px; color:var(--green); font-weight:600; }
.user-chip { color:var(--muted); font-size:12px; display:flex; align-items:center; gap:8px; }
.user-chip button.link { background:none; border:none; color:#8ab4ff; cursor:pointer; padding:0; font-size:12px; }
.meta-row { color:var(--muted-dim); font-size:11.5px; margin-bottom:14px; }

.period-bar { display:flex; gap:6px; margin:0 0 18px; flex-wrap:wrap; }
.period-bar button {
  background:var(--panel2); border:1px solid var(--border); color:var(--muted); border-radius:999px; padding:6px 15px;
  font-size:12.5px; cursor:pointer; transition:background .15s, color .15s, box-shadow .15s;
}
.period-bar button.active { background:linear-gradient(90deg, var(--accent), #4f8bff); border-color:transparent; color:#fff; font-weight:600; box-shadow:var(--glow-blue); }
.period-bar button:hover:not(.active) { color:var(--text); border-color:var(--muted-dim); }

/* ---------------------------------------------------------------- Panels -------------------- */
.panel {
  background:var(--panel); backdrop-filter: blur(6px); border:1px solid var(--border); border-radius:var(--radius);
  padding:18px 20px; margin-bottom:18px; position:relative; overflow:hidden;
}
.panel.glow-blue { box-shadow:var(--glow-blue); }
.panel h2 { font-size:12.5px; margin:0 0 14px; color:var(--muted); text-transform:uppercase; letter-spacing:0.06em; font-weight:700; }
.panel-head { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:14px; flex-wrap:wrap; }
.panel-head h2 { margin:0; }
.panel-desc { color:var(--muted-dim); font-size:11.5px; margin:-8px 0 14px; }
.sort-control { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--muted); }
.sort-control select, .search-input {
  background:var(--panel2); border:1px solid var(--border); color:var(--text); border-radius:6px; padding:5px 9px; font-size:12px;
}
.search-input { min-width:180px; }
.toolbar-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
.grid-2 { display:grid; grid-template-columns: 1fr 1fr; gap:18px; }
.grid-3 { display:grid; grid-template-columns: repeat(3, 1fr); gap:18px; }
@media (max-width: 1100px) { .grid-3 { grid-template-columns: 1fr 1fr; } }
@media (max-width: 900px) { .grid-2, .grid-3 { grid-template-columns: 1fr; } main { padding:16px; } }

/* ---------------------------------------------------------------- KPI cards ----------------- */
.kpi-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap:12px; }
.kpi {
  background:var(--panel2); border:1px solid var(--border); border-radius:10px; padding:14px 16px;
  transition: box-shadow .2s, transform .15s; position:relative;
}
.kpi:hover { transform:translateY(-1px); border-color:var(--border-soft); }
.kpi.glow { box-shadow:var(--glow-blue); }
.kpi-value { font-size:22px; font-weight:700; font-variant-numeric:tabular-nums; }
.kpi-label { color:var(--muted); font-size:11.5px; margin-top:2px; }
.kpi-sub { color:var(--muted-dim); font-size:10.5px; margin-top:4px; }
.kpi-spark { margin-top:8px; height:26px; }
.kpi-spark svg { width:100%; height:100%; display:block; }

/* ---------------------------------------------------------------- Active Agents ------------- */
.agent-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap:12px; }
.agent-card {
  background:var(--panel2); border:1px solid var(--border); border-radius:10px; padding:13px 14px;
  display:flex; gap:11px; align-items:flex-start; transition: box-shadow .2s, border-color .2s;
}
.agent-card.status-active { border-color: rgba(52,224,161,0.35); }
.agent-card.status-active:hover { box-shadow:var(--glow-green); }
.agent-card.status-processing { border-color: rgba(47,107,255,0.4); }
.agent-card.status-processing:hover { box-shadow:var(--glow-blue); }
.agent-card.status-error { border-color: rgba(255,107,122,0.4); }
.agent-card.status-error:hover { box-shadow:var(--glow-red); }
.agent-card.status-waiting { border-color: var(--border); }
.agent-avatar {
  width:34px; height:34px; border-radius:9px; background:var(--panel-solid); border:1px solid var(--border-soft);
  display:flex; align-items:center; justify-content:center; flex:none; position:relative;
}
.agent-avatar svg { width:18px; height:18px; }
.agent-avatar .dot { position:absolute; bottom:-2px; right:-2px; border:2px solid var(--panel2); }
.agent-card.status-processing .agent-avatar { animation: breathe 2.2s ease-in-out infinite; }
.agent-body { min-width:0; flex:1; }
.agent-name { font-size:12.5px; font-weight:700; }
.agent-task { color:var(--muted); font-size:11.5px; margin-top:2px; line-height:1.4; }
.agent-metric { color:var(--muted-dim); font-size:10.5px; margin-top:6px; }
@keyframes breathe { 0%,100% { box-shadow:0 0 0 0 rgba(47,107,255,0.25); } 50% { box-shadow:0 0 0 5px rgba(47,107,255,0); } }

/* ---------------------------------------------------------------- Workflow diagram ---------- */
.workflow-wrap { overflow-x:auto; }
.workflow-diagram { width:100%; min-width:640px; height:132px; display:block; }
.workflow-node-label { font-size:10.5px; fill:var(--muted); font-weight:600; letter-spacing:0.02em; }
.workflow-idle { color:var(--muted-dim); font-size:12.5px; text-align:center; padding:18px 0; }
.workflow-particle { animation: flowParticle 2.4s linear infinite; }
@keyframes flowParticle { 0% { offset-distance:0%; opacity:0; } 8% { opacity:1; } 92% { opacity:1; } 100% { offset-distance:100%; opacity:0; } }

/* ---------------------------------------------------------------- Activity feed ------------- */
.activity-feed { max-height:340px; overflow-y:auto; display:flex; flex-direction:column-reverse; gap:0; }
.activity-item {
  display:flex; gap:10px; padding:8px 2px; border-bottom:1px solid var(--border-soft); font-size:12px; align-items:baseline;
  animation: slideIn .35s ease-out;
}
@keyframes slideIn { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:translateY(0); } }
.activity-time { color:var(--muted-dim); font-variant-numeric:tabular-nums; flex:none; width:64px; }
.activity-label { color:var(--text); flex:1; }
.activity-label .fail { color:var(--red); }
.activity-demo-badge {
  font-size:9.5px; font-weight:700; letter-spacing:0.04em; color:var(--amber); background:var(--amber-soft);
  border:1px solid #4a3a1d; border-radius:4px; padding:1px 5px; flex:none;
}

/* ---------------------------------------------------------------- Tables -------------------- */
table { width:100%; border-collapse:collapse; font-size:12.5px; }
.table-wrap { overflow-x:auto; }
th { text-align:left; color:var(--muted); font-weight:600; font-size:10.5px; text-transform:uppercase; letter-spacing:0.03em; padding:8px 10px; border-bottom:1px solid var(--border); white-space:nowrap; }
td { padding:8px 10px; border-bottom:1px solid var(--border-soft); vertical-align:top; }
td.right, th.right { text-align:right; }
tr.clickable { cursor:pointer; }
tr.clickable:hover td { background:var(--panel2); }
.chip { display:inline-flex; align-items:center; gap:4px; padding:2px 8px; border-radius:999px; font-size:10.5px; font-weight:700; border:1px solid transparent; white-space:nowrap; }
.chip-green { color:var(--green); background:var(--green-soft); border-color:#1d4a30; }
.chip-blue { color:#8ab4ff; background:#101f36; border-color:#1f3a5c; }
.chip-amber { color:var(--amber); background:var(--amber-soft); border-color:#4a3a1d; }
.chip-red { color:var(--red); background:var(--red-soft); border-color:#4a1f1f; }
.chip-gray { color:var(--muted); background:var(--panel2); border-color:var(--border); }
.chip .dot { width:6px; height:6px; }
.empty { color:var(--muted-dim); font-size:12.5px; padding:14px 4px; }
.warning-banner { background:var(--amber-soft); border:1px solid #4a3a1d; color:var(--amber); border-radius:8px; padding:12px 14px; margin-bottom:10px; font-size:12.5px; }
.ok-banner { background:var(--green-soft); border:1px solid #1d4a30; color:var(--green); border-radius:8px; padding:12px 14px; font-size:13px; display:flex; align-items:center; gap:10px; }
.ok-banner .scan { width:14px; height:14px; border-radius:50%; border:2px solid var(--green); border-top-color:transparent; animation: spin 1.1s linear infinite; }
@keyframes spin { to { transform:rotate(360deg); } }
.error-banner { background:var(--red-soft); border:1px solid #4a1f1f; color:var(--red); border-radius:8px; padding:12px 14px; margin-bottom:14px; font-size:13px; }
tr.row-highlight { background:rgba(52,224,161,0.04); }
tr.row-highlight td:first-child { box-shadow: inset 3px 0 0 #1d4a30; }
tr.row-new { animation: rowFlashIn .9s ease-out; }
@keyframes rowFlashIn { 0% { background:rgba(52,224,161,0.22); } 100% { background:transparent; } }
tr.row-new.failed { animation-name: rowFlashInRed; }
@keyframes rowFlashInRed { 0% { background:rgba(255,107,122,0.22); } 100% { background:transparent; } }
tr.row-idle td { opacity:0.5; }

/* ---------------------------------------------------------------- Bars (Revenue by capability) */
.bar-list { display:flex; flex-direction:column; gap:9px; }
.bar-row { cursor:pointer; }
.bar-row-head { display:flex; justify-content:space-between; font-size:12px; margin-bottom:4px; }
.bar-row-head .name { font-weight:600; }
.bar-row-head .value { color:var(--muted); font-variant-numeric:tabular-nums; }
.bar-track { height:8px; border-radius:999px; background:var(--panel2); border:1px solid var(--border-soft); overflow:hidden; }
.bar-fill { height:100%; border-radius:999px; background:linear-gradient(90deg, var(--accent), var(--cyan)); width:0; transition:width .8s cubic-bezier(.2,.8,.2,1); }
.bar-fill.zero { background:var(--border-soft); }

/* ---------------------------------------------------------------- x402 funnel pipeline ------ */
.funnel { display:flex; align-items:stretch; gap:0; overflow-x:auto; }
.funnel-stage { flex:1; min-width:150px; padding:14px 16px; border-right:1px dashed var(--border); position:relative; }
.funnel-stage:last-child { border-right:none; }
.funnel-stage .n { font-size:20px; font-weight:700; font-variant-numeric:tabular-nums; }
.funnel-stage .lbl { color:var(--muted); font-size:11px; margin-top:2px; }
.funnel-stage .conv { color:var(--cyan); font-size:11px; margin-top:8px; font-weight:600; }
.funnel-stage.drop::after { content:"drop-off"; position:absolute; top:6px; right:10px; font-size:9px; color:var(--red); font-weight:700; letter-spacing:0.03em; }
.funnel-arrow { display:flex; align-items:center; color:var(--muted-dim); padding:0 2px; }

/* ---------------------------------------------------------------- System health ring --------- */
.health-wrap { display:flex; align-items:center; gap:18px; flex-wrap:wrap; }
.health-ring { width:112px; height:112px; flex:none; }
.health-ring circle.track { stroke:var(--border); fill:none; }
.health-ring circle.fill { stroke:var(--green); fill:none; stroke-linecap:round; transition:stroke-dashoffset 1s cubic-bezier(.2,.8,.2,1); }
.health-ring text { fill:var(--text); font-size:20px; font-weight:700; }
.health-ring .sub { fill:var(--muted); font-size:8.5px; }
.health-checks { display:flex; flex-direction:column; gap:5px; font-size:11.5px; color:var(--muted); flex:1; min-width:160px; }

/* ---------------------------------------------------------------- Live Analysis / Calculation */
.tab-row { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:14px; }
.tab-btn {
  background:var(--panel2); border:1px solid var(--border); color:var(--muted); border-radius:7px; padding:6px 11px;
  font-size:11.5px; cursor:pointer;
}
.tab-btn.active { background:var(--accent-soft); border-color:var(--accent); color:#fff; }
.stage-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:6px; }
.stage-list li {
  display:flex; align-items:center; gap:9px; font-size:12.5px; color:var(--muted); opacity:0; transform:translateX(-6px);
  animation: stageIn .4s ease-out forwards;
}
.stage-list li .n { width:18px; height:18px; border-radius:50%; background:var(--panel2); border:1px solid var(--border-soft); font-size:9.5px; display:flex; align-items:center; justify-content:center; color:var(--muted-dim); flex:none; }
.stage-list li.done { color:var(--text); }
.stage-list li.done .n { background:var(--green-soft); border-color:#1d4a30; color:var(--green); }
@keyframes stageIn { to { opacity:1; transform:translateX(0); } }
.last-run-badge { display:flex; gap:16px; flex-wrap:wrap; margin-top:14px; padding-top:12px; border-top:1px solid var(--border-soft); font-size:11.5px; color:var(--muted); }
.last-run-badge b { color:var(--text); }
.formula-card { background:var(--panel2); border:1px solid var(--border-soft); border-radius:9px; padding:12px 14px; margin-bottom:8px; }
.formula-card .fname { font-size:12px; font-weight:700; margin-bottom:6px; }
.formula-row { display:flex; align-items:center; gap:10px; font-size:12.5px; flex-wrap:wrap; }
.formula-term { background:var(--panel-solid); border:1px solid var(--border-soft); border-radius:6px; padding:5px 10px; opacity:0; animation: stageIn .4s ease-out forwards; }
.formula-op { color:var(--cyan); font-weight:700; }

/* ---------------------------------------------------------------- Drawer -------------------- */
.drawer-backdrop { position:fixed; inset:0; background:rgba(4,8,16,0.6); backdrop-filter:blur(2px); z-index:40; display:none; }
.drawer-backdrop.open { display:block; }
.drawer {
  position:fixed; top:0; right:0; height:100vh; width:min(420px, 92vw); background:var(--panel-solid); border-left:1px solid var(--border);
  z-index:41; transform:translateX(100%); transition:transform .25s ease-out; padding:20px; overflow-y:auto;
}
.drawer.open { transform:translateX(0); }
.drawer h3 { margin:0 0 4px; font-size:16px; }
.drawer .close { position:absolute; top:16px; right:16px; background:none; border:none; color:var(--muted); font-size:18px; cursor:pointer; }
dl.fieldlist { margin:0; display:grid; grid-template-columns: 190px 1fr; gap:9px 12px; font-size:12.5px; }
dl.fieldlist dt { color:var(--muted); }
dl.fieldlist dd { margin:0; }
code.hash { font-family: ui-monospace, monospace; cursor: help; }
svg.trend-chart { width:100%; height:220px; display:block; }
.legend { display:flex; gap:14px; flex-wrap:wrap; margin-top:8px; font-size:11.5px; color:var(--muted); }
.legend .swatch { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:5px; vertical-align:middle; }

/* ---------------------------------------------------------------- Responsive ----------------- */
@media (max-width: 860px) {
  .sidebar { position:fixed; left:0; top:0; transform:translateX(-100%); transition:transform .2s; box-shadow:0 0 40px rgba(0,0,0,0.5); }
  .sidebar.open { transform:translateX(0); }
  .mobile-topbar {
    display:flex; align-items:center; gap:10px; padding:12px 16px; border-bottom:1px solid var(--border); background:var(--panel-solid); position:sticky; top:0; z-index:15;
  }
  .mobile-topbar button { background:var(--panel2); border:1px solid var(--border); color:var(--text); border-radius:7px; padding:6px 10px; font-size:13px; }
  main { padding:14px; }
  .hero { flex-direction:column; }
  .hero-right { align-items:flex-start; }
}

/* ---------------------------------------------------------------- Reduced motion ------------- */
.reduced-motion .pulse, .reduced-motion .agent-card.status-processing .agent-avatar, .reduced-motion .ok-banner .scan,
.reduced-motion .activity-item, .reduced-motion .stage-list li, .reduced-motion .formula-term,
.reduced-motion tr.row-new, .reduced-motion tr.row-new.failed, .reduced-motion .workflow-particle {
  animation:none !important;
}
.reduced-motion .bar-fill, .reduced-motion .health-ring circle.fill { transition:none !important; }
`;

// A small, fixed color palette for multi-currency trend lines — never more than a handful of
// assets are expected (spec section 14), so a fixed palette is enough.
const TREND_COLORS = ["#2f6bff", "#f2b84b", "#34e0a1", "#ff6b7a", "#8ab4ff"];

const CLIENT_SCRIPT = `
(function () {
  "use strict";
  var reducedMotion = false;
  try { reducedMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches; } catch (e) {}
  if (reducedMotion) document.documentElement.classList.add("reduced-motion");

  var esc = function (s) {
    if (s === null || s === undefined) return "";
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  };
  var fmtDate = function (iso) {
    if (!iso) return "\u2014";
    try { return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC"; } catch (e) { return esc(iso); }
  };
  var fmtRelative = function (iso) {
    if (!iso) return "\u2014";
    var ms = Date.now() - new Date(iso).getTime();
    if (ms < 0) ms = 0;
    if (ms < 60000) return Math.max(1, Math.round(ms / 1000)) + "s ago";
    if (ms < 3600000) return Math.round(ms / 60000) + "m ago";
    if (ms < 86400000) return Math.round(ms / 3600000) + "h ago";
    return Math.round(ms / 86400000) + "d ago";
  };
  var fmtNum = function (n) { return (n === null || n === undefined) ? "\u2014" : Number(n).toLocaleString(); };
  var fmtPct = function (n) { return (n === null || n === undefined) ? "\u2014" : n + "%"; };
  var fmtMs = function (n) { return (n === null || n === undefined) ? "\u2014" : Math.round(n) + " ms"; };
  var fmtAmount = function (n) { return (n === null || n === undefined) ? "\u2014" : Number(n).toFixed(2); };

  var CHIP_CLASS = {
    settlement_succeeded: "chip-green", settlement_failed: "chip-red", payment_verified: "chip-blue",
    Enabled: "chip-green", Disabled: "chip-gray", Active: "chip-green", Unknown: "chip-gray"
  };
  var chip = function (label) {
    if (label === null || label === undefined || label === "") return '<span class="chip chip-gray">\u2014</span>';
    var cls = CHIP_CLASS[label] || "chip-gray";
    return '<span class="chip ' + cls + '">' + esc(label) + "</span>";
  };

  // ---- Count-up number animation (spec section 7) — animates only on first paint / value change,
  // never continuously; instant (no animation) under prefers-reduced-motion. --------------------
  var lastKpiValues = {};
  function animateNumber(el, target, formatter) {
    var key = el.getAttribute("data-kpi-key");
    var prev = key ? lastKpiValues[key] : undefined;
    if (typeof target !== "number" || isNaN(target)) { el.textContent = formatter(target); if (key) lastKpiValues[key] = target; return; }
    if (reducedMotion || prev === undefined) { el.textContent = formatter(target); if (key) lastKpiValues[key] = target; return; }
    if (prev === target) { el.textContent = formatter(target); return; }
    var start = prev, startTime = null, duration = 700;
    function step(ts) {
      if (startTime === null) startTime = ts;
      var p = Math.min(1, (ts - startTime) / duration);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = formatter(start + (target - start) * eased);
      if (p < 1) requestAnimationFrame(step); else el.textContent = formatter(target);
    }
    requestAnimationFrame(step);
    if (key) lastKpiValues[key] = target;
  }

  function sparklineSvg(values, color) {
    if (!values || values.length < 2) return "";
    var w = 120, h = 26, max = Math.max.apply(null, values.concat([1]));
    var pts = values.map(function (v, i) { return (i / (values.length - 1)) * w + "," + (h - (v / max) * (h - 3) - 1.5); }).join(" ");
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none"><polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>';
  }

  function kpiCard(opts) {
    var key = opts.key || opts.label;
    var sparkHtml = opts.spark && opts.spark.length > 1 ? '<div class="kpi-spark">' + sparklineSvg(opts.spark, opts.sparkColor || "#2f6bff") + "</div>" : "";
    return '<div class="kpi' + (opts.glow ? " glow" : "") + '"><div class="kpi-value" data-kpi-key="' + esc(key) + '">' + esc(opts.rawValue !== undefined ? "" : opts.value) + '</div>' +
      '<div class="kpi-label">' + esc(opts.label) + "</div>" +
      (opts.sub ? '<div class="kpi-sub">' + esc(opts.sub) + "</div>" : "") + sparkHtml + "</div>";
  }

  var table = function (columns, rows, emptyMessage, rowAttrs) {
    if (!rows.length) return '<p class="empty">' + esc(emptyMessage || "No data.") + "</p>";
    var head = columns.map(function (c) { return "<th" + (c.right ? ' class="right"' : "") + ">" + esc(c.header) + "</th>"; }).join("");
    var body = rows.map(function (r) {
      var attrs = rowAttrs ? rowAttrs(r) : "";
      return "<tr" + attrs + ">" + columns.map(function (c) { return "<td" + (c.right ? ' class="right"' : "") + ">" + c.render(r) + "</td>"; }).join("") + "</tr>";
    }).join("");
    return '<div class="table-wrap"><table><thead><tr>' + head + "</tr></thead><tbody>" + body + "</tbody></table></div>";
  };

  var TREND_COLORS = ${JSON.stringify(TREND_COLORS)};

  // =============================================================================================
  // Agent icons — minimal, dependency-free inline SVGs (no childish robot art).
  // =============================================================================================
  var AGENT_ICONS = {
    research: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="10.5" cy="10.5" r="6.5"/><line x1="15.5" y1="15.5" x2="21" y2="21"/></svg>',
    property: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 21V10l8-6 8 6v11"/><path d="M9 21v-7h6v7"/></svg>',
    supplier: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M21 8l-9-5-9 5 9 5 9-5z"/><path d="M3 8v8l9 5 9-5V8"/><line x1="12" y1="13" x2="12" y2="21"/></svg>',
    risk: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/></svg>',
    document: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M6 2h9l5 5v15H6z"/><path d="M15 2v5h5"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/></svg>',
    valuation: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 16v-3l2.5-5h13L21 13v3"/><path d="M3 16h18"/><circle cx="7" cy="16.5" r="2"/><circle cx="17" cy="16.5" r="2"/></svg>',
    payment: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="6" width="18" height="13" rx="2"/><path d="M3 10h18"/><circle cx="16.5" cy="14.5" r="1.2" fill="currentColor" stroke="none"/></svg>',
    reconciliation: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 6h13M4 12h9M4 18h13"/><path d="M18 15l2 2 4-4" transform="translate(-3 -3)"/></svg>'
  };
  var STATUS_DOT = { active: "dot-green", processing: "dot-blue", waiting: "dot-amber", error: "dot-red" };
  var STATUS_LABEL_ICON = { active: "\u25CF", processing: "\u25D0", waiting: "\u25CB", error: "\u2715" };

  // =============================================================================================
  // Hero: live indicator + compact AI pipeline + date range (period bar already existed)
  // =============================================================================================
  var PIPELINE_NODES = [
    { id: "request", label: "Request" }, { id: "agent", label: "Agent" }, { id: "tool", label: "Tool" },
    { id: "data", label: "Data" }, { id: "analysis", label: "Analysis" }, { id: "payment", label: "Payment" }, { id: "result", label: "Result" }
  ];

  function stageForFeedItem(item) {
    if (!item) return null;
    if (item.kind === "discovery") return "request";
    if (item.kind === "mcp") return "agent";
    if (item.kind === "x402") {
      if (item.label.indexOf("challenge") !== -1) return "payment";
      if (item.label.indexOf("Settlement succeeded") !== -1) return "result";
      return "payment";
    }
    if (item.kind === "tool") return item.success === false ? "analysis" : "result";
    return null;
  }

  function renderPipeline(containerId, data, compact) {
    var el = document.getElementById(containerId);
    if (!el) return;
    var latest = (data.activityFeed && data.activityFeed[0]) || null;
    var activeStage = stageForFeedItem(latest);
    if (!latest) {
      el.innerHTML = '<div class="workflow-idle">Waiting for agent requests\u2026</div>';
      return;
    }
    var w = compact ? 560 : 760, h = compact ? 90 : 132, n = PIPELINE_NODES.length;
    var padX = 50, gap = (w - padX * 2) / (n - 1);
    var y = h / 2 - (compact ? 6 : 14);
    var parts = [];
    parts.push('<line x1="' + padX + '" y1="' + y + '" x2="' + (w - padX) + '" y2="' + y + '" stroke="#1c2942" stroke-width="2"/>');
    PIPELINE_NODES.forEach(function (node, i) {
      var cx = padX + gap * i;
      var isActive = node.id === activeStage;
      var isPast = PIPELINE_NODES.findIndex(function (n2) { return n2.id === activeStage; }) > i;
      var fill = isActive ? "#2f6bff" : isPast ? "#233657" : "#0c1322";
      var stroke = isActive ? "#8ab4ff" : "#1c2942";
      parts.push('<circle cx="' + cx + '" cy="' + y + '" r="' + (compact ? 7 : 9) + '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="1.5"' + (isActive && !reducedMotion ? ' style="filter:drop-shadow(0 0 6px #2f6bff)"' : "") + '/>');
      if (isActive && !reducedMotion) parts.push('<circle cx="' + cx + '" cy="' + y + '" r="' + (compact ? 7 : 9) + '" fill="none" stroke="#8ab4ff" stroke-width="1.5"><animate attributeName="r" values="' + (compact ? 7 : 9) + ';' + (compact ? 14 : 18) + '" dur="1.6s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.8;0" dur="1.6s" repeatCount="indefinite"/></circle>');
      parts.push('<text x="' + cx + '" y="' + (y + (compact ? 20 : 26)) + '" text-anchor="middle" class="workflow-node-label">' + esc(node.label) + "</text>");
    });
    el.innerHTML = '<div class="workflow-wrap"><svg class="workflow-diagram" viewBox="0 0 ' + w + ' ' + h + '" style="height:' + h + 'px">' + parts.join("") + "</svg></div>" +
      '<div class="panel-desc" style="margin-top:6px">Last observed step: <b style="color:#e8edf7">' + esc((PIPELINE_NODES.filter(function (n2) { return n2.id === activeStage; })[0] || {}).label || "\u2014") + '</b> \u2014 ' + esc(latest.label) + " (" + fmtRelative(latest.at) + ")</div>";
  }

  function renderHero(data) {
    document.getElementById("generated-at").textContent = "Data as of " + fmtDate(data.generatedAt) + " \u00b7 period: " + data.period;
    var live = document.getElementById("live-indicator");
    if (live) live.innerHTML = '<span class="dot dot-green pulse"></span> Live';
    renderPipeline("hero-pipeline", data, true);
  }

  // =============================================================================================
  // Active Agents
  // =============================================================================================
  function renderAgents(data) {
    var el = document.getElementById("active-agents");
    var agents = data.agents || [];
    if (!agents.length) { el.innerHTML = '<p class="empty">No agent activity recorded yet.</p>'; return; }
    el.innerHTML = agents.map(function (a) {
      return '<div class="agent-card status-' + esc(a.status) + '">' +
        '<div class="agent-avatar">' + (AGENT_ICONS[a.id] || "") + '<span class="dot ' + STATUS_DOT[a.status] + (a.status === "processing" ? " pulse" : "") + '"></span></div>' +
        '<div class="agent-body">' +
        '<div class="agent-name">' + esc(a.name) + '</div>' +
        '<div class="agent-task">' + esc(a.currentTask) + '</div>' +
        '<div class="agent-metric">' + esc(a.metricLabel) + " \u00b7 " + (a.lastEventAt ? fmtRelative(a.lastEventAt) : "no recent activity") + '</div>' +
        "</div></div>";
    }).join("");
  }

  // =============================================================================================
  // Live Agent Activity feed (+ optional clearly-labeled ?demo=1 illustrative rows, client-only)
  // =============================================================================================
  var DEMO_FEED_ITEMS = [
    "Agent requested analyze_company_risk", "Searching company evidence across public sources",
    "3 sources cross-referenced", "Risk score computed", "x402 payment verified", "Response delivered to agent"
  ];
  function isDemoMode() {
    try { return /[?&]demo=1(&|$)/.test(window.location.search); } catch (e) { return false; }
  }

  function renderActivityFeed(data) {
    var el = document.getElementById("activity-feed");
    var items = data.activityFeed || [];
    var html = items.map(function (it) {
      var failCls = it.success === false ? ' class="fail"' : "";
      return '<div class="activity-item"><span class="activity-time">' + fmtRelative(it.at) + '</span><span class="activity-label"' + failCls + '>' + esc(it.label) + "</span></div>";
    }).join("");
    if (isDemoMode()) {
      var demoHtml = DEMO_FEED_ITEMS.map(function (label, i) {
        return '<div class="activity-item"><span class="activity-demo-badge">DEMO ACTIVITY</span><span class="activity-time">' + (DEMO_FEED_ITEMS.length - i) + 'm ago</span><span class="activity-label">' + esc(label) + "</span></div>";
      }).join("");
      html = html + demoHtml;
    }
    el.innerHTML = html || '<p class="empty">No activity recorded in this period.</p>';
  }

  // =============================================================================================
  // Revenue KPIs (+ sparklines + count-up)
  // =============================================================================================
  function renderRevenueKpis(data) {
    var el = document.getElementById("kpi-revenue");
    var r = data.revenue;
    var currencies = Object.keys(r.revenueByCurrency || {});
    var spark = (data.sparklines && data.sparklines.revenue) || [];
    var cards = [];
    if (r.settledPayments === 0 || currencies.length === 0) {
      cards.push('<div class="kpi"><div class="kpi-value">0.00 USDC</div><div class="kpi-label">Gross Revenue</div></div>');
    } else if (currencies.length === 1) {
      cards.push('<div class="kpi glow"><div class="kpi-value">' + fmtAmount(r.revenueByCurrency[currencies[0]]) + " " + esc(currencies[0]) + '</div><div class="kpi-label">Gross Revenue</div><div class="kpi-spark">' + sparklineSvg(spark, "#34e0a1") + "</div></div>");
    } else {
      currencies.forEach(function (c) { cards.push('<div class="kpi"><div class="kpi-value">' + fmtAmount(r.revenueByCurrency[c]) + " " + esc(c) + '</div><div class="kpi-label">Gross Revenue (' + esc(c) + ')</div></div>'); });
    }
    cards.push('<div class="kpi"><div class="kpi-value">' + fmtNum(r.settledPayments) + '</div><div class="kpi-label">Settled Payments</div><div class="kpi-spark">' + sparklineSvg(spark, "#2f6bff") + "</div></div>");
    cards.push('<div class="kpi"><div class="kpi-value">' + fmtNum(data.paidCalls) + '</div><div class="kpi-label">Paid Calls</div><div class="kpi-sub">successful x402 tool executions</div></div>');
    cards.push('<div class="kpi"><div class="kpi-value">' + (r.averageRevenuePerPaidCall !== null ? fmtAmount(r.averageRevenuePerPaidCall) + " " + esc(r.currency || "") : "\u2014") + '</div><div class="kpi-label">Avg Revenue / Paid Call</div></div>');
    cards.push('<div class="kpi' + (r.failedSettlements > 0 ? "" : "") + '"><div class="kpi-value">' + fmtNum(r.failedSettlements) + '</div><div class="kpi-label">Failed Settlements</div></div>');
    cards.push('<div class="kpi"><div class="kpi-value">' + fmtNum(data.reconciliation.anomalyCount) + '</div><div class="kpi-label">Reconciliation Anomalies</div></div>');
    el.innerHTML = cards.join("");
    var note = document.getElementById("revenue-empty-note");
    note.style.display = r.settledPayments === 0 ? "block" : "none";
  }

  // =============================================================================================
  // Revenue Trend (animated line-draw via CSS on first paint)
  // =============================================================================================
  function renderTrend(data) {
    var t = data.revenueTrend;
    var el = document.getElementById("trend-chart");
    var legendEl = document.getElementById("trend-legend");
    var currencies = {};
    t.buckets.forEach(function (b) { Object.keys(b.revenueByCurrency).forEach(function (c) { currencies[c] = true; }); });
    var currencyList = Object.keys(currencies);
    if (currencyList.length === 0) {
      el.innerHTML = '<p class="empty">No settled x402 payments in this period.</p>';
      legendEl.innerHTML = "";
      return;
    }
    var w = 900, h = 220, padL = 46, padB = 24, padT = 10, padR = 10;
    var innerW = w - padL - padR, innerH = h - padT - padB;
    var n = t.buckets.length || 1;
    var maxVal = 0;
    t.buckets.forEach(function (b) { currencyList.forEach(function (c) { maxVal = Math.max(maxVal, b.revenueByCurrency[c] || 0); }); });
    if (maxVal === 0) maxVal = 1;
    var x = function (i) { return padL + (n === 1 ? innerW / 2 : (i / (n - 1)) * innerW); };
    var y = function (v) { return padT + innerH - (v / maxVal) * innerH; };
    var parts = [];
    parts.push('<line x1="' + padL + '" y1="' + (padT + innerH) + '" x2="' + (padL + innerW) + '" y2="' + (padT + innerH) + '" stroke="#1c2942" stroke-width="1"/>');
    parts.push('<text x="4" y="' + (padT + 6) + '" fill="#8ea0c0" font-size="10">' + esc(maxVal.toFixed(2)) + '</text>');
    parts.push('<text x="4" y="' + (padT + innerH) + '" fill="#8ea0c0" font-size="10">0</text>');
    currencyList.forEach(function (currency, ci) {
      var color = TREND_COLORS[ci % TREND_COLORS.length];
      var points = t.buckets.map(function (b, i) { return x(i) + "," + y(b.revenueByCurrency[currency] || 0); }).join(" ");
      var lineAttrs = reducedMotion ? "" : ' style="stroke-dasharray:2000;stroke-dashoffset:2000;animation:drawLine 1.1s ease-out forwards"';
      parts.push('<polyline points="' + points + '" fill="none" stroke="' + color + '" stroke-width="2"' + lineAttrs + '/>');
      t.buckets.forEach(function (b, i) {
        if ((b.revenueByCurrency[currency] || 0) > 0) parts.push('<circle cx="' + x(i) + '" cy="' + y(b.revenueByCurrency[currency] || 0) + '" r="2.5" fill="' + color + '"><title>' + esc(b.label) + ": " + esc((b.revenueByCurrency[currency] || 0).toFixed(4)) + " " + esc(currency) + '</title></circle>');
      });
    });
    var labelStep = Math.max(1, Math.ceil(n / 8));
    t.buckets.forEach(function (b, i) {
      if (i % labelStep === 0 || i === n - 1) parts.push('<text x="' + x(i) + '" y="' + (h - 4) + '" fill="#8ea0c0" font-size="9" text-anchor="middle">' + esc(b.label) + "</text>");
    });
    el.innerHTML = '<svg class="trend-chart" viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="none"><style>@keyframes drawLine { to { stroke-dashoffset:0; } }</style>' + parts.join("") + "</svg>";
    legendEl.innerHTML = currencyList.map(function (c, i) {
      return '<span><span class="swatch" style="background:' + TREND_COLORS[i % TREND_COLORS.length] + '"></span>' + esc(c) + " (" + esc(t.granularity) + " buckets)</span>";
    }).join("");
  }

  // =============================================================================================
  // Revenue by Capability — animated horizontal bars + click-to-open drawer
  // =============================================================================================
  function renderRevenueByTool(data) {
    var el = document.getElementById("revenue-by-tool");
    var rows = data.revenueByTool || [];
    if (!rows.length) { el.innerHTML = '<p class="empty">No settled x402 payments in this period.</p>'; return; }
    var maxRevenue = Math.max.apply(null, rows.map(function (r) { return r.revenue || 0; }).concat([0.0001]));
    el.innerHTML = '<div class="bar-list">' + rows.map(function (r) {
      var pct = r.revenue ? Math.max(2, Math.round((r.revenue / maxRevenue) * 100)) : 0;
      return '<div class="bar-row" data-tool="' + esc(r.toolName) + '">' +
        '<div class="bar-row-head"><span class="name">' + esc(r.toolName) + '</span><span class="value">' +
        (r.revenue !== null ? fmtAmount(r.revenue) + " " + esc(r.currency) : "0.00 USDC") + " \u00b7 " + fmtNum(r.settledCalls) + ' settled</span></div>' +
        '<div class="bar-track"><div class="bar-fill' + (pct === 0 ? " zero" : "") + '" data-width="' + pct + '%"></div></div>' +
        "</div>";
    }).join("") + "</div>";
    requestAnimationFrame(function () {
      el.querySelectorAll(".bar-fill").forEach(function (b) { b.style.width = b.getAttribute("data-width"); });
    });
    el.querySelectorAll(".bar-row").forEach(function (row) {
      row.addEventListener("click", function () { openCapabilityDrawer(row.getAttribute("data-tool")); });
    });
  }

  // =============================================================================================
  // x402 Funnel — visual pipeline with conversion percentages and drop-off highlight
  // =============================================================================================
  function renderX402Funnel(data) {
    var f = data.x402Funnel;
    var el = document.getElementById("x402-funnel");
    var stages = [
      { n: f.challenges, lbl: "402 Challenge" },
      { n: f.paymentVerified, lbl: "Payment Verified", conv: f.conversion.challengeToVerifiedPct },
      { n: f.settlementSucceeded, lbl: "Settlement Succeeded", conv: f.conversion.verifiedToSettledPct },
      { n: f.settlementFailed, lbl: "Settlement Failed" }
    ];
    var maxN = Math.max(f.challenges, 1);
    el.innerHTML = '<div class="funnel">' + stages.map(function (s, i) {
      var isDrop = i > 0 && stages[i - 1].n > 0 && s.n < stages[i - 1].n * 0.5 && s.lbl !== "Settlement Failed";
      return '<div class="funnel-stage' + (isDrop ? " drop" : "") + '"><div class="n">' + fmtNum(s.n) + '</div><div class="lbl">' + esc(s.lbl) + "</div>" +
        (s.conv !== undefined ? '<div class="conv">' + fmtPct(s.conv) + " conversion</div>" : "") + "</div>";
    }).join("") + "</div>" +
      '<dl class="fieldlist" style="margin-top:14px">' +
      "<dt>Challenge \u2192 Settled (overall)</dt><dd>" + fmtPct(f.conversion.challengeToSettledPct) + "</dd>" +
      "</dl>";
  }

  // =============================================================================================
  // System Status + System Health ring
  // =============================================================================================
  function renderSystemStatus(data) {
    var s = data.systemStatus;
    var el = document.getElementById("system-status");
    el.innerHTML =
      '<dl class="fieldlist">' +
      "<dt>MCP</dt><dd>" + chip(s.mcp) + "</dd>" +
      "<dt>x402</dt><dd>" + chip(s.x402) + "</dd>" +
      "<dt>Analytics</dt><dd>" + chip(s.analytics) + "</dd>" +
      "<dt>Revenue Ledger</dt><dd>" + chip(s.revenueLedger) + "</dd>" +
      "<dt>Partner Data</dt><dd>" + esc(s.partnerData) + "</dd>" +
      "<dt>Database</dt><dd>" + esc(s.database) + "</dd>" +
      "<dt>Last Successful Settlement</dt><dd>" + fmtDate(s.lastSuccessfulSettlementAt) + "</dd>" +
      "<dt>Last analyze_oman_property Call</dt><dd>" + fmtDate(s.lastAnalyzeOmanPropertyCallAt) + "</dd>" +
      "<dt>Last Partner-Feed-Backed Analysis</dt><dd>" + fmtDate(s.lastPartnerFeedAnalysisAt) + "</dd>" +
      "</dl>";
  }

  function renderHealthRing(data) {
    var el = document.getElementById("system-health");
    var h = data.systemHealth;
    var r = 48, c = 2 * Math.PI * r;
    var offset = c - (h.scorePct / 100) * c;
    el.innerHTML =
      '<div class="health-wrap">' +
      '<svg class="health-ring" viewBox="0 0 120 120">' +
      '<circle class="track" cx="60" cy="60" r="' + r + '" stroke-width="10"/>' +
      '<circle class="fill" cx="60" cy="60" r="' + r + '" stroke-width="10" stroke-dasharray="' + c + '" stroke-dashoffset="' + (reducedMotion ? offset : c) + '" transform="rotate(-90 60 60)" data-offset="' + offset + '"/>' +
      '<text x="60" y="58" text-anchor="middle">' + h.scorePct + '%</text>' +
      '<text x="60" y="74" text-anchor="middle" class="sub">SYSTEM ONLINE</text>' +
      "</svg>" +
      '<div class="health-checks">' + h.checks.map(function (c2) {
        return '<div>' + (c2.measured ? (c2.healthy ? "\u2713" : "\u2715") : "\u2014") + " " + esc(c2.label) + (c2.measured ? "" : " (unmeasured)") + "</div>";
      }).join("") + '<div style="color:#5d6d8a">' + h.healthyCount + " / " + h.measuredCount + " measured checks healthy</div></div>" +
      "</div>";
    requestAnimationFrame(function () {
      var fillCircle = el.querySelector(".fill");
      if (fillCircle && !reducedMotion) fillCircle.setAttribute("stroke-dashoffset", fillCircle.getAttribute("data-offset"));
    });
  }

  // =============================================================================================
  // Agent / Tool Usage tiles (+ sparklines)
  // =============================================================================================
  function renderUsage(data) {
    var u = data.usage;
    var spark = data.sparklines || {};
    var el = document.getElementById("usage-metrics");
    function tile(label, value, sparkValues) {
      return '<div class="kpi"><div class="kpi-value">' + esc(value) + '</div><div class="kpi-label">' + esc(label) + '</div>' +
        (sparkValues && sparkValues.length > 1 ? '<div class="kpi-spark">' + sparklineSvg(sparkValues, "#22d3ee") + "</div>" : "") + "</div>";
    }
    el.innerHTML =
      '<div class="kpi-grid">' +
      tile("Discovery Hits", fmtNum(u.discoveryHits), spark.discoveryHits) +
      tile("Unique Clients", fmtNum(u.uniqueClients)) +
      tile("MCP initialize", fmtNum(u.mcpInitialize)) +
      tile("MCP tools/list", fmtNum(u.mcpToolsList)) +
      tile("MCP tools/call", fmtNum(u.mcpToolsCall)) +
      tile("Total Tool Calls", fmtNum(u.totalToolCalls), spark.toolCalls) +
      tile("analyze_oman_property Calls", fmtNum(u.analyzeOmanPropertyCalls)) +
      tile("Tool Success Rate", fmtPct(u.toolSuccessRatePct)) +
      tile("p50 Latency", fmtMs(u.p50LatencyMs)) +
      tile("p95 Latency", fmtMs(u.p95LatencyMs)) +
      tile("Partner Feed Usage", fmtPct(u.partnerFeedUsagePct)) +
      "</div>";
  }

  // =============================================================================================
  // Top Tools / Conversion by Tool — sort (existing) + search/filter (new) + click-to-drawer (new)
  // =============================================================================================
  var lastDashboardData = null;
  var toolSearchQuery = "";

  function sortToolConversion(rows, key) {
    var sorted = rows.slice();
    var byRevenue = function (a, b) { return (b.revenue !== null ? b.revenue : -1) - (a.revenue !== null ? a.revenue : -1) || b.settledCalls - a.settledCalls; };
    if (key === "settled") sorted.sort(function (a, b) { return b.settledCalls - a.settledCalls || byRevenue(a, b); });
    else if (key === "calls") sorted.sort(function (a, b) { return b.calls - a.calls || byRevenue(a, b); });
    else if (key === "conversion") sorted.sort(function (a, b) { return (b.conversionPct !== null ? b.conversionPct : -1) - (a.conversionPct !== null ? a.conversionPct : -1) || byRevenue(a, b); });
    else sorted.sort(byRevenue);
    return sorted;
  }

  function renderRevenueCell(r) {
    var currencies = Object.keys(r.revenueByCurrency || {});
    if (r.settledCalls === 0 || currencies.length === 0) return "0.00 USDC";
    if (currencies.length === 1) return fmtAmount(r.revenueByCurrency[currencies[0]]) + " " + currencies[0];
    return currencies.map(function (c) { return fmtAmount(r.revenueByCurrency[c]) + " " + c; }).join(", ");
  }

  function renderAvgCell(r) {
    if (r.settledCalls === 0) return "\u2014";
    var currencies = Object.keys(r.revenueByCurrency || {});
    if (currencies.length === 1) return fmtAmount(r.averageRevenuePerSettledCall) + " " + currencies[0];
    return currencies.map(function (c) { return fmtAmount(r.revenueByCurrency[c] / r.settledCalls) + " " + c; }).join(", ");
  }

  function renderToolConversion(data) {
    lastDashboardData = data;
    var el = document.getElementById("tool-conversion");
    var sortSelect = document.getElementById("tool-conversion-sort");
    var key = sortSelect ? sortSelect.value : "revenue";
    var rows = sortToolConversion(data.toolConversion || [], key);
    if (toolSearchQuery) {
      var q = toolSearchQuery.toLowerCase();
      rows = rows.filter(function (r) { return r.toolName.toLowerCase().indexOf(q) !== -1; });
    }
    el.innerHTML = table(
      [
        { header: "Tool", render: function (r) { return esc(r.toolName); } },
        { header: "Calls", right: true, render: function (r) { return fmtNum(r.calls); } },
        { header: "Success", right: true, render: function (r) { return fmtNum(r.successCount); } },
        { header: "402", right: true, render: function (r) { return fmtNum(r.challenges); } },
        { header: "Settled", right: true, render: function (r) { return fmtNum(r.settledCalls); } },
        { header: "Conversion", right: true, render: function (r) { return r.conversionPct === null ? "\u2014" : r.conversionPct + "%"; } },
        { header: "Revenue", right: true, render: function (r) { return renderRevenueCell(r); } },
        { header: "Avg / Paid Call", right: true, render: function (r) { return renderAvgCell(r); } },
        { header: "p50", right: true, render: function (r) { return fmtMs(r.p50LatencyMs); } },
        { header: "p95", right: true, render: function (r) { return fmtMs(r.p95LatencyMs); } }
      ],
      rows,
      toolSearchQuery ? "No tools match \u201c" + esc(toolSearchQuery) + "\u201d." : "No tool usage recorded in this period.",
      function (r) { return ' class="clickable' + (r.settledCalls > 0 ? " row-highlight" : "") + '" data-tool="' + esc(r.toolName) + '"'; }
    );
    el.querySelectorAll("tbody tr").forEach(function (tr) {
      tr.addEventListener("click", function () { openCapabilityDrawer(tr.getAttribute("data-tool")); });
    });
  }

  // =============================================================================================
  // All Capabilities Overview — every registered capability (server sends registry order, zero-
  // activity rows included — see service.ts's buildCapabilityOverview()). Default sort is
  // "registry" (registryIndex ascending, i.e. exactly the registry's own declared order); the
  // other keys mirror sortCapabilityOverviewRows() in service.ts exactly (kept in sync manually —
  // this is a dependency-free browser script with no import mechanism).
  // =============================================================================================
  function sortCapabilityOverview(rows, key) {
    var sorted = rows.slice();
    var byRevenue = function (a, b) { return (b.revenue !== null ? b.revenue : -1) - (a.revenue !== null ? a.revenue : -1) || b.settledCalls - a.settledCalls; };
    if (key === "calls") sorted.sort(function (a, b) { return b.calls - a.calls || byRevenue(a, b); });
    else if (key === "settled") sorted.sort(function (a, b) { return b.settledCalls - a.settledCalls || byRevenue(a, b); });
    else if (key === "conversion") sorted.sort(function (a, b) { return (b.conversionPct !== null ? b.conversionPct : -1) - (a.conversionPct !== null ? a.conversionPct : -1) || byRevenue(a, b); });
    else if (key === "revenue") sorted.sort(byRevenue);
    else sorted.sort(function (a, b) { return a.registryIndex - b.registryIndex; }); // "registry" (default)
    return sorted;
  }

  function fmtPrice(r) {
    // Every capability is priced in USD today (domain/capabilities.ts's CURRENCY const) — the "$"
    // prefix matches the existing convention in landing.ts/llms-txt.ts (a "$" + fixed-2 price).
    // Falls back to "<amount> <currency>" rather than assuming "$" for any future non-USD price.
    return r.priceCurrency === "USD" ? "$" + Number(r.price).toFixed(2) : Number(r.price).toFixed(2) + " " + esc(r.priceCurrency);
  }

  function renderCapabilityOverview(data) {
    lastDashboardData = data;
    var el = document.getElementById("capability-overview");
    var sortSelect = document.getElementById("capability-overview-sort");
    var key = sortSelect ? sortSelect.value : "registry";
    var rows = sortCapabilityOverview(data.capabilityOverview || [], key);
    el.innerHTML = table(
      [
        { header: "Capability", render: function (r) { return esc(r.toolName); } },
        { header: "Price", right: true, render: function (r) { return fmtPrice(r); } },
        { header: "Calls", right: true, render: function (r) { return fmtNum(r.calls); } },
        { header: "Success", right: true, render: function (r) { return fmtNum(r.successCount); } },
        { header: "Failed", right: true, render: function (r) { return fmtNum(r.failureCount); } },
        { header: "402", right: true, render: function (r) { return fmtNum(r.challenges); } },
        { header: "Settled", right: true, render: function (r) { return fmtNum(r.settledCalls); } },
        { header: "Conversion", right: true, render: function (r) { return r.conversionPct === null ? "—" : r.conversionPct + "%"; } },
        { header: "Revenue", right: true, render: function (r) { return renderRevenueCell(r); } },
        { header: "Avg / Paid", right: true, render: function (r) { return renderAvgCell(r); } },
        { header: "p50", right: true, render: function (r) { return fmtMs(r.p50LatencyMs); } },
        { header: "p95", right: true, render: function (r) { return fmtMs(r.p95LatencyMs); } }
      ],
      rows,
      "No registered capabilities.",
      function (r) {
        // Existing visual styling only: row-highlight (already used for settled-revenue rows in
        // Top Tools) for a capability with real settled revenue; row-idle (a plain opacity dim,
        // no new color) for a capability with zero calls AND zero 402 challenges this period;
        // otherwise the default row style (an "active calls, not yet settled" capability).
        var cls = "clickable";
        if (r.settledCalls > 0) cls += " row-highlight";
        else if (r.calls === 0 && r.challenges === 0) cls += " row-idle";
        return ' class="' + cls + '" data-tool="' + esc(r.toolName) + '"';
      }
    );
    el.querySelectorAll("tbody tr").forEach(function (tr) {
      tr.addEventListener("click", function () { openCapabilityDrawer(tr.getAttribute("data-tool")); });
    });
  }

  // =============================================================================================
  // Latest Settlements — success glow / failure pulse on newly-arrived rows
  // =============================================================================================
  var knownSettlementKeys = null;
  function settlementKey(r) { return r.time + "|" + r.capability + "|" + (r.transactionHashFull || ""); }

  function renderTransactions(data) {
    var el = document.getElementById("latest-transactions");
    var rows = data.transactions || [];
    var isFirstRender = knownSettlementKeys === null;
    var nextKeys = {};
    rows.forEach(function (r) { nextKeys[settlementKey(r)] = true; });
    el.innerHTML = table(
      [
        { header: "Time", render: function (r) { return fmtDate(r.time); } },
        { header: "Capability", render: function (r) { return esc(r.capability); } },
        { header: "Amount", right: true, render: function (r) { return r.amount !== null ? fmtAmount(r.amount) : "\u2014"; } },
        { header: "Currency", render: function (r) { return esc(r.currency || "\u2014"); } },
        { header: "Network", render: function (r) { return esc(r.network); } },
        { header: "Status", render: function (r) { return chip(r.status); } },
        {
          header: "Transaction Hash",
          render: function (r) {
            if (!r.transactionHashFull) return "\u2014";
            var inner = '<code class="hash" title="' + esc(r.transactionHashFull) + '" data-full="' + esc(r.transactionHashFull) + '">' + esc(r.transactionHashAbbrev) + "</code>";
            return r.explorerUrl ? '<a href="' + esc(r.explorerUrl) + '" target="_blank" rel="noopener noreferrer">' + inner + "</a>" : inner;
          }
        }
      ],
      rows,
      "No settlements recorded in this period.",
      function (r) {
        var isNew = !isFirstRender && knownSettlementKeys && !knownSettlementKeys[settlementKey(r)];
        return isNew ? ' class="row-new' + (r.status !== "settlement_succeeded" ? " failed" : "") + '"' : "";
      }
    );
    knownSettlementKeys = nextKeys;
  }

  // =============================================================================================
  // Reconciliation — animated scan / check state
  // =============================================================================================
  function renderReconciliation(data) {
    var el = document.getElementById("reconciliation");
    var rec = data.reconciliation;
    if (!rec.anomalies.length) {
      el.innerHTML = '<div class="ok-banner"><span class="scan"></span> \u2713 No anomalies detected</div>';
      return;
    }
    var rows = rec.anomalies.map(function (a) {
      return '<div class="warning-banner"><strong>' + esc(a.kind) + "</strong>" + (a.toolName ? " \u2014 " + esc(a.toolName) : "") + "<br>" + esc(a.detail) + "</div>";
    }).join("");
    el.innerHTML = rows;
  }

  // =============================================================================================
  // Live Analysis & Calculation preview — generic, real-data-badged (never fabricated numbers)
  // =============================================================================================
  var ANALYSIS_STAGES = {
    analyze_oman_property: ["Searching local comparable listings", "Reviewing rent & yield inputs", "Estimating operating cost", "Estimating maintenance allowance", "Checking risk flags", "Result ready"],
    search_oman_company: ["Searching the Oman business registry", "Matching company records", "Result ready"],
    get_oman_company_profile: ["Looking up company profile", "Compiling registry fields", "Result ready"],
    analyze_oman_company: ["Resolving company identity", "Reviewing registry & activity data", "Compiling analysis", "Result ready"],
    due_diligence_oman_company: ["Resolving company identity", "Checking registry records", "Checking address & contact consistency", "Compiling due-diligence summary", "Result ready"],
    research_company: ["Resolving company identity", "Checking website", "Checking business activity", "Searching public sources", "Analyzing evidence", "Returning sources"],
    find_companies: ["Interpreting search criteria", "Searching matching companies", "Ranking results", "Result ready"],
    analyze_company_risk: ["Resolving company identity", "Searching public risk signals", "Checking sanctions / public records", "Calculating risk assessment", "Returning sources"]
  };
  var CALC_FORMULAS = {
    analyze_property: [{ name: "Gross Yield", formula: ["Annual Rent", "\u00f7", "Property Value"] }, { name: "Net Yield", formula: ["Annual Rent \u2212 Operating Cost", "\u00f7", "Property Value"] }, { name: "Payback Period", formula: ["Property Value", "\u00f7", "Annual Net Income"] }],
    compare_properties: [{ name: "Price per sqm", formula: ["Property Value", "\u00f7", "Area (sqm)"] }, { name: "Gross Yield (per property)", formula: ["Annual Rent", "\u00f7", "Property Value"] }],
    estimate_maintenance: [{ name: "Maintenance Allowance", formula: ["Property Value", "\u00d7", "Age / Type Rate"] }]
  };
  // Fallback only, used when a server payload somehow has no capabilityOverview (should not
  // happen in practice). The real, always-current tab order below is derived from
  // data.capabilityOverview, which lists every registered capability in registry order (see
  // buildCapabilityOverview() in service.ts) - so a newly-added capability gets a tab here with
  // no edit to this file required.
  var CAPABILITY_ORDER_FALLBACK = ["analyze_oman_property", "analyze_property", "compare_properties", "estimate_maintenance",
    "research_company", "find_companies", "analyze_company_risk", "search_oman_company", "get_oman_company_profile", "analyze_oman_company", "due_diligence_oman_company"];

  function findToolConversionRow(data, toolName) {
    return (data.toolConversion || []).filter(function (r) { return r.toolName === toolName; })[0] || null;
  }

  function renderAnalysisPreview(data, selected) {
    var el = document.getElementById("analysis-preview-body");
    var tabsEl = document.getElementById("analysis-preview-tabs");
    var names = (data.capabilityOverview && data.capabilityOverview.length)
      ? data.capabilityOverview.map(function (r) { return r.toolName; })
      : CAPABILITY_ORDER_FALLBACK;
    var active = selected || (data.activityFeed && data.activityFeed[0] && data.activityFeed[0].toolName && names.indexOf(data.activityFeed[0].toolName) !== -1 ? data.activityFeed[0].toolName : names[0]);
    tabsEl.innerHTML = names.map(function (n) { return '<button type="button" class="tab-btn' + (n === active ? " active" : "") + '" data-tool="' + esc(n) + '">' + esc(n) + "</button>"; }).join("");
    tabsEl.querySelectorAll(".tab-btn").forEach(function (btn) {
      btn.addEventListener("click", function () { renderAnalysisPreview(data, btn.getAttribute("data-tool")); });
    });

    var row = findToolConversionRow(data, active);
    var badge = '<div class="last-run-badge">' +
      "<span>Calls this period: <b>" + (row ? fmtNum(row.calls) : "0") + "</b></span>" +
      "<span>Success: <b>" + (row ? fmtNum(row.successCount) : "0") + "</b></span>" +
      "<span>p50 latency: <b>" + (row ? fmtMs(row.p50LatencyMs) : "\u2014") + "</b></span>" +
      "<span>p95 latency: <b>" + (row ? fmtMs(row.p95LatencyMs) : "\u2014") + "</b></span>" +
      "</div>";

    if (CALC_FORMULAS[active]) {
      var cards = CALC_FORMULAS[active].map(function (f) {
        return '<div class="formula-card"><div class="fname">' + esc(f.name) + '</div><div class="formula-row">' +
          f.formula.map(function (term, i) {
            var isOp = term === "\u00f7" || term === "\u00d7" || term === "\u2212" || term === "=";
            return '<span class="' + (isOp ? "formula-op" : "formula-term") + '" style="animation-delay:' + (i * 0.12) + 's">' + esc(term) + "</span>";
          }).join('<span class="formula-op" style="animation-delay:' + (0.06) + 's">&nbsp;</span>') +
          "</div></div>";
      }).join("");
      el.innerHTML = '<p class="panel-desc">Formula reference \u2014 no per-call figures are stored for calculator capabilities, so exact numbers are shown only inside each real API response, never fabricated here.</p>' + cards + badge;
    } else {
      var stages = ANALYSIS_STAGES[active] || ["Processing request", "Result ready"];
      var lastFailed = row && row.calls > 0 && row.successCount < row.calls && (!data.activityFeed || !data.activityFeed.some(function (it) { return it.toolName === active && it.success === true; }));
      var html = '<p class="panel-desc">Typical execution pipeline for this capability \u2014 illustrative stage names only; the real last-call outcome is shown below.</p><ul class="stage-list">' +
        stages.map(function (s, i) {
          return '<li class="' + (row && row.calls > 0 ? "done" : "") + '" style="animation-delay:' + (i * 0.09) + 's"><span class="n">' + (i + 1) + '</span>' + esc(s) + "</li>";
        }).join("") + "</ul>";
      el.innerHTML = html + badge + (lastFailed ? '<div class="warning-banner" style="margin-top:10px">Last recorded call for this capability failed \u2014 see Live Agent Activity for details.</div>' : "");
    }
  }

  // =============================================================================================
  // Capability detail drawer (Revenue by Capability + Top Tools rows both open this)
  // =============================================================================================
  function openCapabilityDrawer(toolName) {
    if (!toolName || !lastDashboardData) return;
    var data = lastDashboardData;
    var row = findToolConversionRow(data, toolName);
    var revRow = (data.revenueByTool || []).filter(function (r) { return r.toolName === toolName; })[0] || null;
    var recentActivity = (data.activityFeed || []).filter(function (it) { return it.toolName === toolName; }).slice(0, 8);
    var body = document.getElementById("drawer-body");
    document.getElementById("drawer-title").textContent = toolName;
    var fields = '<dl class="fieldlist">' +
      "<dt>Calls (this period)</dt><dd>" + (row ? fmtNum(row.calls) : "0") + "</dd>" +
      "<dt>Success rate</dt><dd>" + (row && row.calls > 0 ? fmtPct(Math.round((row.successCount / row.calls) * 1000) / 10) : "\u2014") + "</dd>" +
      "<dt>402 Challenges</dt><dd>" + (row ? fmtNum(row.challenges) : "0") + "</dd>" +
      "<dt>Payments Verified</dt><dd>" + (row ? fmtNum(row.paymentVerified) : "0") + "</dd>" +
      "<dt>Settlements</dt><dd>" + (row ? fmtNum(row.settledCalls) : "0") + "</dd>" +
      "<dt>Conversion</dt><dd>" + (row && row.conversionPct !== null ? row.conversionPct + "%" : "\u2014") + "</dd>" +
      "<dt>Revenue</dt><dd>" + (revRow && revRow.revenue !== null ? fmtAmount(revRow.revenue) + " " + esc(revRow.currency) : "0.00 USDC") + "</dd>" +
      "<dt>p50 / p95 Latency</dt><dd>" + (row ? fmtMs(row.p50LatencyMs) + " / " + fmtMs(row.p95LatencyMs) : "\u2014") + "</dd>" +
      "</dl>";
    var activityHtml = recentActivity.length
      ? recentActivity.map(function (it) { return '<div class="activity-item"><span class="activity-time">' + fmtRelative(it.at) + '</span><span class="activity-label">' + esc(it.label) + "</span></div>"; }).join("")
      : '<p class="empty">No recent activity recorded for this capability.</p>';
    body.innerHTML = fields + '<h3 style="font-size:12px;margin:18px 0 8px;color:#8ea0c0;text-transform:uppercase;letter-spacing:0.05em">Recent Activity</h3>' + activityHtml;
    document.getElementById("drawer").classList.add("open");
    document.getElementById("drawer-backdrop").classList.add("open");
  }
  function closeCapabilityDrawer() {
    document.getElementById("drawer").classList.remove("open");
    document.getElementById("drawer-backdrop").classList.remove("open");
  }

  // =============================================================================================
  // Orchestration
  // =============================================================================================
  function renderDashboard(data) {
    renderHero(data);
    renderAgents(data);
    renderActivityFeed(data);
    renderRevenueKpis(data);
    renderTrend(data);
    renderRevenueByTool(data);
    renderCapabilityOverview(data);
    renderX402Funnel(data);
    renderUsage(data);
    renderToolConversion(data);
    renderAnalysisPreview(data);
    renderTransactions(data);
    renderReconciliation(data);
    renderSystemStatus(data);
    renderHealthRing(data);
    document.getElementById("dashboard-error").style.display = "none";
    document.querySelectorAll(".period-bar button").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-period") === data.period);
    });
  }

  function showError(message) {
    var el = document.getElementById("dashboard-error");
    el.textContent = message;
    el.style.display = "block";
  }

  var currentPeriod = null;
  function loadPeriod(period, silent) {
    currentPeriod = period;
    fetch("/internal/dashboard/data?period=" + encodeURIComponent(period), { credentials: "same-origin", headers: { Accept: "application/json" } })
      .then(function (res) {
        if (res.status === 401) { window.location.href = "/internal/dashboard/login"; return null; }
        if (!res.ok) { throw new Error("Dashboard data request failed (HTTP " + res.status + ")."); }
        return res.json();
      })
      .then(function (body) {
        if (!body) return;
        if (!body.success) { throw new Error((body.error && body.error.message) || "Dashboard data request failed."); }
        renderDashboard(body.data);
      })
      .catch(function (err) {
        if (!silent) showError("Unable to load dashboard data right now (" + (err && err.message ? err.message : "unknown error") + "). Showing the last successfully loaded data, if any.");
      });
  }

  // Lightweight polling (spec section 20) — reuses the exact same GET /internal/dashboard/data
  // route a period change already calls; no new endpoint, no WebSocket/SSE. Paused while the tab
  // is hidden to avoid wasted load (spec section 21).
  var POLL_MS = 12000;
  function startPolling() {
    setInterval(function () {
      if (document.hidden || !currentPeriod) return;
      loadPeriod(currentPeriod, true);
    }, POLL_MS);
  }

  document.addEventListener("DOMContentLoaded", function () {
    var initial = window.__DASHBOARD_INITIAL__;
    if (initial) { currentPeriod = initial.period; renderDashboard(initial); }
    document.querySelectorAll(".period-bar button").forEach(function (btn) {
      btn.addEventListener("click", function () { loadPeriod(btn.getAttribute("data-period")); });
    });
    var sortSelect = document.getElementById("tool-conversion-sort");
    if (sortSelect) {
      sortSelect.addEventListener("change", function () { if (lastDashboardData) renderToolConversion(lastDashboardData); });
    }
    var searchInput = document.getElementById("tool-search");
    if (searchInput) {
      searchInput.addEventListener("input", function () { toolSearchQuery = searchInput.value; if (lastDashboardData) renderToolConversion(lastDashboardData); });
    }
    var capabilitySortSelect = document.getElementById("capability-overview-sort");
    if (capabilitySortSelect) {
      capabilitySortSelect.addEventListener("change", function () { if (lastDashboardData) renderCapabilityOverview(lastDashboardData); });
    }
    var drawerClose = document.getElementById("drawer-close");
    if (drawerClose) drawerClose.addEventListener("click", closeCapabilityDrawer);
    var backdrop = document.getElementById("drawer-backdrop");
    if (backdrop) backdrop.addEventListener("click", closeCapabilityDrawer);
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeCapabilityDrawer(); });
    var menuBtn = document.getElementById("mobile-menu-btn");
    var sidebar = document.getElementById("sidebar");
    if (menuBtn && sidebar) menuBtn.addEventListener("click", function () { sidebar.classList.toggle("open"); });
    startPolling();
  });
})();
`;

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/-->/g, "--\\u003e");
}

const PERIOD_LABELS: Record<DashboardPeriod, string> = { "24h": "24 Hours", "7d": "7 Days", "30d": "30 Days", all: "All Time" };

const SIDEBAR_ICONS: Record<string, string> = {
  dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="11" width="8" height="10" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/></svg>',
  agents: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="18" cy="7" r="2.4"/><path d="M14.5 13.2c2.9.4 5.5 2.8 5.5 6.3"/></svg>',
  analytics: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 19V9M11 19V5M18 19v-7"/><path d="M3 19h18"/></svg>',
  revenue: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v9M9.2 15c.3 1 1.3 1.6 2.8 1.6 1.8 0 2.8-.8 2.8-1.9 0-2.7-5.6-1.3-5.6-4 0-1.1 1-1.9 2.8-1.9 1.5 0 2.5.6 2.8 1.6"/></svg>',
  settlements: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="7" width="18" height="12" rx="2"/><path d="M3 11h18"/><path d="M7 15h4"/></svg>',
  reconciliation: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 11l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>',
  health: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 21s-7-4.35-9.5-9C.7 8 2.4 4 6.2 4c2 0 3.4 1 4.8 2.7C12.4 5 13.8 4 15.8 4c3.8 0 5.5 4 3.7 8-2.5 4.65-9.5 9-9.5 9z"/></svg>',
  settings: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.9 2.9l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1-1.6 1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.9-2.9l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1 1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.9-2.9l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.9 2.9l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1h.1a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/></svg>'
};

const SIDEBAR_ITEMS: { key: string; label: string; active?: boolean }[] = [
  { key: "dashboard", label: "Dashboard", active: true },
  { key: "agents", label: "Agents & Tools" },
  { key: "analytics", label: "Analytics" },
  { key: "revenue", label: "Revenue" },
  { key: "settlements", label: "Settlements" },
  { key: "reconciliation", label: "Reconciliation" },
  { key: "health", label: "System Health" },
  { key: "settings", label: "Settings" }
];

export function dashboardPageHtml(opts: { adminUser: string; csrfToken: string; initialData: DashboardData }): string {
  const periodButtons = (["24h", "7d", "30d", "all"] as DashboardPeriod[])
    .map(p => `<button type="button" data-period="${p}" class="${p === opts.initialData.period ? "active" : ""}">${esc(PERIOD_LABELS[p])}</button>`)
    .join("\n");

  const sidebarNav = SIDEBAR_ITEMS
    .map(item => `<a href="#" class="${item.active ? "active" : ""}">${SIDEBAR_ICONS[item.key] ?? ""}<span>${esc(item.label)}</span></a>`)
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dashboard · Rafid Property Intelligence</title>
<meta name="robots" content="noindex, nofollow">
<style>${CSS}</style>
</head>
<body>
<div class="drawer-backdrop" id="drawer-backdrop"></div>
<aside class="drawer" id="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title">
  <button type="button" class="close" id="drawer-close" aria-label="Close">&times;</button>
  <h3 id="drawer-title">&nbsp;</h3>
  <div id="drawer-body"></div>
</aside>
<div class="shell">
  <nav class="sidebar" id="sidebar" aria-label="Primary">
    <div class="brand">
      <div class="mark">R</div>
      <div><div class="name">Rafid</div><div class="sub">Property Intelligence</div></div>
    </div>
    <nav>${sidebarNav}</nav>
    <div class="spacer"></div>
    <div class="workforce-status">
      <div class="label">AI Workforce</div>
      <div class="row"><span class="dot dot-green pulse"></span> AI Workforce Online</div>
    </div>
  </nav>
  <div class="content">
    <div class="mobile-topbar">
      <button type="button" id="mobile-menu-btn" aria-label="Open menu">&#9776;</button>
      <strong>Rafid Property Intelligence</strong>
    </div>
    <main>
      <div class="hero">
        <div>
          <h1>Rafid Property Intelligence</h1>
          <div class="sub">AI-powered real estate &amp; business operations, analytics and revenue</div>
        </div>
        <div class="hero-right">
          <div class="live-indicator" id="live-indicator"><span class="dot dot-green pulse"></span> Live</div>
          <div class="user-chip">${esc(opts.adminUser)} &middot; <form method="post" action="/internal/dashboard/logout" style="display:inline">${csrfField(opts.csrfToken)}<button type="submit" class="link">Log out</button></form></div>
        </div>
      </div>
      <div id="generated-at" class="meta-row">Data as of ${esc(opts.initialData.generatedAt)} &middot; period: ${esc(opts.initialData.period)}</div>

      <div class="period-bar">${periodButtons}</div>

      <div id="dashboard-error" class="error-banner" style="display:none"></div>

      <div class="panel">
        <h2>AI Operations Pipeline</h2>
        <div id="hero-pipeline"></div>
      </div>

      <div class="panel">
        <h2>Active Agents</h2>
        <div id="active-agents" class="agent-grid"></div>
      </div>

      <div class="panel">
        <h2>Live Agent Activity</h2>
        <div id="activity-feed" class="activity-feed"></div>
      </div>

      <div class="panel">
        <h2>Revenue</h2>
        <div id="kpi-revenue" class="kpi-grid"></div>
        <p id="revenue-empty-note" class="empty" style="display:none">No settled x402 payments in this period.</p>
      </div>

      <div class="panel">
        <h2>Revenue Trend</h2>
        <div id="trend-chart"></div>
        <div id="trend-legend" class="legend"></div>
      </div>

      <div class="panel">
        <h2>Revenue by Capability</h2>
        <div id="revenue-by-tool"></div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <h2>All Capabilities Overview</h2>
          <label class="sort-control">Sort by
            <select id="capability-overview-sort">
              <option value="registry">Registry Order</option>
              <option value="calls">Calls</option>
              <option value="revenue">Revenue</option>
              <option value="settled">Settled Payments</option>
              <option value="conversion">Conversion</option>
            </select>
          </label>
        </div>
        <p class="panel-desc">Every registered capability &mdash; including ones with zero activity yet. The row list comes from the capability registry, not from analytics or revenue.</p>
        <div id="capability-overview"></div>
      </div>

      <div class="grid-2">
        <div class="panel">
          <h2>x402 Funnel</h2>
          <div id="x402-funnel"></div>
        </div>
        <div class="panel">
          <h2>System Status</h2>
          <div id="system-status"></div>
        </div>
      </div>

      <div class="panel">
        <h2>System Health</h2>
        <div id="system-health"></div>
      </div>

      <div class="panel">
        <h2>Agent / Tool Usage</h2>
        <div id="usage-metrics"></div>
      </div>

      <div class="panel">
        <div class="panel-head">
          <h2>Top Tools / Conversion by Tool</h2>
          <div class="toolbar-row">
            <input type="text" id="tool-search" class="search-input" placeholder="Search tools&hellip;" aria-label="Search tools">
            <label class="sort-control">Sort by
              <select id="tool-conversion-sort">
                <option value="revenue">Revenue</option>
                <option value="settled">Settled Calls</option>
                <option value="calls">Total Calls</option>
                <option value="conversion">Conversion Rate</option>
              </select>
            </label>
          </div>
        </div>
        <div id="tool-conversion"></div>
      </div>

      <div class="panel">
        <h2>Live Analysis &amp; Calculation Preview</h2>
        <p class="panel-desc">Real per-capability call counts and latency from this period, paired with a generic reference pipeline / formula &mdash; no per-call result numbers are stored, so none are invented here.</p>
        <div id="analysis-preview-tabs" class="tab-row"></div>
        <div id="analysis-preview-body"></div>
      </div>

      <div class="panel">
        <h2>Latest Settlements</h2>
        <div id="latest-transactions"></div>
      </div>

      <div class="panel">
        <h2>Reconciliation</h2>
        <div id="reconciliation"></div>
      </div>
    </main>
  </div>
</div>
<script>window.__DASHBOARD_INITIAL__ = ${safeJson(opts.initialData)};</script>
<script>${CLIENT_SCRIPT}</script>
</body>
</html>`;
}

function csrfField(csrfToken: string): string {
  return `<input type="hidden" name="_csrf" value="${esc(csrfToken)}">`;
}
