import { esc } from "../admin/layout.js";
import type { DashboardData, DashboardPeriod } from "./service.js";

/**
 * Rafid Property Intelligence — Internal Dashboard (spec sections 1, 12, 13).
 *
 * Plain, dependency-free server-rendered HTML shell, matching the exact idiom every other
 * internal/documentation page in this codebase already uses (src/api/swagger.ts, src/api/
 * landing.ts, src/api/admin/*Page.ts) — no frontend framework, no build step, no bundler, no
 * charting library. The page itself renders once server-side with the caller's initial period's
 * data (embedded as JSON, never re-fetched on first paint); period changes afterwards fetch
 * GET /internal/dashboard/data?period=... (same-origin, cookie-authenticated) and re-render
 * client-side with the SAME rendering functions — no full page reload, no server secrets ever
 * reach this page or that JSON response (see dashboardRoutes.ts's doc comment).
 */

const CSS = `
:root { color-scheme: dark; --bg:#0b1220; --panel:#121b2e; --panel2:#0f1729; --border:#1f2b40; --text:#e6ebf2; --muted:#9fb0c9; --accent:#2563eb; }
* { box-sizing: border-box; }
body { margin:0; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background:var(--bg); color:var(--text); }
a { color:#8ab4ff; text-decoration:none; }
a:hover { text-decoration:underline; }
main { max-width:1320px; margin:0 auto; padding:20px 24px 64px; }
.topbar { display:flex; justify-content:space-between; align-items:center; gap:16px; margin-bottom:6px; flex-wrap:wrap; }
.topbar h1 { font-size:20px; margin:0; }
.topbar .brand-sub { color:var(--muted); font-size:12px; margin-top:2px; }
.topbar .user { color:var(--muted); font-size:12px; white-space:nowrap; }
.topbar form.logout { display:inline; }
.topbar button.link { background:none; border:none; color:#8ab4ff; cursor:pointer; padding:0; font-size:12px; }
.meta-row { color:var(--muted); font-size:12px; margin-bottom:18px; }
.period-bar { display:flex; gap:8px; margin:14px 0 20px; flex-wrap:wrap; }
.period-bar button { background:var(--panel2); border:1px solid var(--border); color:var(--text); border-radius:999px; padding:6px 16px; font-size:13px; cursor:pointer; }
.period-bar button.active { background:var(--accent); border-color:var(--accent); font-weight:600; }
.panel { background:var(--panel); border:1px solid var(--border); border-radius:10px; padding:18px 20px; margin-bottom:20px; }
.panel h2 { font-size:13px; margin:0 0 14px; color:var(--muted); text-transform:uppercase; letter-spacing:0.04em; }
.kpi-grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap:12px; margin-bottom:20px; }
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
.empty { color:var(--muted); font-size:13px; padding:12px 0; }
.warning-banner { background:#2c220f; border:1px solid #4a3a1d; color:#e6b35c; border-radius:8px; padding:12px 14px; margin-bottom:14px; font-size:13px; }
.ok-banner { background:#0f2a1c; border:1px solid #1d4a30; color:#7fe0a4; border-radius:8px; padding:10px 14px; font-size:13px; }
.error-banner { background:#2c1414; border:1px solid #4a1f1f; color:#ff8f8f; border-radius:8px; padding:12px 14px; margin-bottom:14px; font-size:13px; }
.grid-2 { display:grid; grid-template-columns: 1fr 1fr; gap:20px; }
@media (max-width: 900px) { .grid-2 { grid-template-columns: 1fr; } main { padding:16px; } }
dl.fieldlist { margin:0; display:grid; grid-template-columns: 220px 1fr; gap:8px 12px; font-size:13px; }
dl.fieldlist dt { color:var(--muted); }
dl.fieldlist dd { margin:0; }
code.hash { font-family: ui-monospace, monospace; cursor: help; }
svg.trend-chart { width:100%; height:220px; display:block; }
.legend { display:flex; gap:14px; flex-wrap:wrap; margin-top:8px; font-size:12px; color:var(--muted); }
.legend .swatch { display:inline-block; width:10px; height:10px; border-radius:2px; margin-right:5px; vertical-align:middle; }
.panel-head { display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:14px; flex-wrap:wrap; }
.panel-head h2 { margin:0; }
.sort-control { display:flex; align-items:center; gap:6px; font-size:12px; color:var(--muted); }
.sort-control select { background:var(--panel2); border:1px solid var(--border); color:var(--text); border-radius:6px; padding:4px 8px; font-size:12px; }
tr.row-highlight { background:rgba(127,224,164,0.05); }
tr.row-highlight td:first-child { box-shadow: inset 3px 0 0 #1d4a30; }
`;

// A small, fixed color palette for multi-currency trend lines — never more than a handful of
// assets are expected (spec section 14), so a fixed palette is enough.
const TREND_COLORS = ["#2563eb", "#e6b35c", "#7fe0a4", "#ff8f8f", "#8ab4ff"];

const CLIENT_SCRIPT = `
(function () {
  "use strict";
  var esc = function (s) {
    if (s === null || s === undefined) return "";
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  };
  var fmtDate = function (iso) {
    if (!iso) return "\u2014";
    try { return new Date(iso).toISOString().replace("T", " ").slice(0, 16) + " UTC"; } catch (e) { return esc(iso); }
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

  var kpiCard = function (label, value, sub) {
    return '<div class="kpi"><div class="kpi-value">' + esc(value) + '</div><div class="kpi-label">' + esc(label) + "</div>" +
      (sub ? '<div class="kpi-sub">' + esc(sub) + "</div>" : "") + "</div>";
  };

  var table = function (columns, rows, emptyMessage) {
    if (!rows.length) return '<p class="empty">' + esc(emptyMessage || "No data.") + "</p>";
    var head = columns.map(function (c) { return "<th" + (c.right ? ' class="right"' : "") + ">" + esc(c.header) + "</th>"; }).join("");
    var body = rows.map(function (r) {
      return "<tr>" + columns.map(function (c) { return "<td" + (c.right ? ' class="right"' : "") + ">" + c.render(r) + "</td>"; }).join("") + "</tr>";
    }).join("");
    return '<div class="table-wrap"><table><thead><tr>' + head + "</tr></thead><tbody>" + body + "</tbody></table></div>";
  };

  var TREND_COLORS = ${JSON.stringify(TREND_COLORS)};

  function renderRevenueKpis(data) {
    var el = document.getElementById("kpi-revenue");
    var r = data.revenue;
    var currencies = Object.keys(r.revenueByCurrency || {});
    var cards = [];
    if (r.settledPayments === 0 || currencies.length === 0) {
      cards.push(kpiCard("Gross Revenue", "0.00 USDC"));
    } else if (currencies.length === 1) {
      cards.push(kpiCard("Gross Revenue", fmtAmount(r.revenueByCurrency[currencies[0]]) + " " + currencies[0]));
    } else {
      currencies.forEach(function (c) { cards.push(kpiCard("Gross Revenue (" + c + ")", fmtAmount(r.revenueByCurrency[c]) + " " + c)); });
    }
    cards.push(kpiCard("Settled Payments", fmtNum(r.settledPayments)));
    cards.push(kpiCard("Paid Calls", fmtNum(data.paidCalls), "successful x402 tool executions"));
    cards.push(kpiCard("Avg Revenue / Paid Call", r.averageRevenuePerPaidCall !== null ? fmtAmount(r.averageRevenuePerPaidCall) + " " + (r.currency || "") : "\u2014"));
    cards.push(kpiCard("Failed Settlements", fmtNum(r.failedSettlements)));
    cards.push(kpiCard("Reconciliation Anomalies", fmtNum(data.reconciliation.anomalyCount)));
    el.innerHTML = cards.join("");
    var note = document.getElementById("revenue-empty-note");
    note.style.display = r.settledPayments === 0 ? "block" : "none";
  }

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
    parts.push('<line x1="' + padL + '" y1="' + (padT + innerH) + '" x2="' + (padL + innerW) + '" y2="' + (padT + innerH) + '" stroke="#1f2b40" stroke-width="1"/>');
    parts.push('<text x="4" y="' + (padT + 6) + '" fill="#9fb0c9" font-size="10">' + esc(maxVal.toFixed(2)) + '</text>');
    parts.push('<text x="4" y="' + (padT + innerH) + '" fill="#9fb0c9" font-size="10">0</text>');
    currencyList.forEach(function (currency, ci) {
      var color = TREND_COLORS[ci % TREND_COLORS.length];
      var points = t.buckets.map(function (b, i) { return x(i) + "," + y(b.revenueByCurrency[currency] || 0); }).join(" ");
      parts.push('<polyline points="' + points + '" fill="none" stroke="' + color + '" stroke-width="2"/>');
      t.buckets.forEach(function (b, i) {
        if ((b.revenueByCurrency[currency] || 0) > 0) parts.push('<circle cx="' + x(i) + '" cy="' + y(b.revenueByCurrency[currency] || 0) + '" r="2.5" fill="' + color + '"><title>' + esc(b.label) + ": " + esc((b.revenueByCurrency[currency] || 0).toFixed(4)) + " " + esc(currency) + '</title></circle>');
      });
    });
    var labelStep = Math.max(1, Math.ceil(n / 8));
    t.buckets.forEach(function (b, i) {
      if (i % labelStep === 0 || i === n - 1) parts.push('<text x="' + x(i) + '" y="' + (h - 4) + '" fill="#9fb0c9" font-size="9" text-anchor="middle">' + esc(b.label) + "</text>");
    });
    el.innerHTML = '<svg class="trend-chart" viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="none">' + parts.join("") + "</svg>";
    legendEl.innerHTML = currencyList.map(function (c, i) {
      return '<span><span class="swatch" style="background:' + TREND_COLORS[i % TREND_COLORS.length] + '"></span>' + esc(c) + " (" + esc(t.granularity) + " buckets)</span>";
    }).join("");
  }

  function renderRevenueByTool(data) {
    var el = document.getElementById("revenue-by-tool");
    el.innerHTML = table(
      [
        { header: "Capability", render: function (r) { return esc(r.toolName); } },
        { header: "Settled Calls", right: true, render: function (r) { return fmtNum(r.settledCalls); } },
        { header: "Revenue", right: true, render: function (r) { return r.revenue !== null ? fmtAmount(r.revenue) + " " + esc(r.currency) : "\u2014"; } },
        { header: "Share of Revenue", right: true, render: function (r) { return fmtPct(r.sharePct); } },
        { header: "Failed Settlements", right: true, render: function (r) { return fmtNum(r.failedSettlements); } }
      ],
      data.revenueByTool,
      "No settled x402 payments in this period."
    );
  }

  // ---- Top Tools / Conversion by Tool ----------------------------------------------------
  // Sorting is a pure client-side re-order of the already-fetched data.toolConversion array —
  // no re-fetch, matching how a period change (the only thing that DOES re-fetch) already works.
  var lastDashboardData = null;

  function sortToolConversion(rows, key) {
    var sorted = rows.slice();
    var byRevenue = function (a, b) { return (b.revenue !== null ? b.revenue : -1) - (a.revenue !== null ? a.revenue : -1) || b.settledCalls - a.settledCalls; };
    if (key === "settled") sorted.sort(function (a, b) { return b.settledCalls - a.settledCalls || byRevenue(a, b); });
    else if (key === "calls") sorted.sort(function (a, b) { return b.calls - a.calls || byRevenue(a, b); });
    else if (key === "conversion") sorted.sort(function (a, b) { return (b.conversionPct !== null ? b.conversionPct : -1) - (a.conversionPct !== null ? a.conversionPct : -1) || byRevenue(a, b); });
    else sorted.sort(byRevenue);
    return sorted;
  }

  // Never combines currencies (spec section on multiple assets): a tool with zero settled calls
  // shows the literal "0.00 USDC" empty state; one settled currency shows that currency's amount;
  // more than one shows each currency's amount separately, comma-joined, never summed.
  function renderRevenueCell(r) {
    var currencies = Object.keys(r.revenueByCurrency || {});
    if (r.settledCalls === 0 || currencies.length === 0) return "0.00 USDC";
    if (currencies.length === 1) return fmtAmount(r.revenueByCurrency[currencies[0]]) + " " + currencies[0];
    return currencies.map(function (c) { return fmtAmount(r.revenueByCurrency[c]) + " " + c; }).join(", ");
  }

  function renderAvgCell(r) {
    if (r.settledCalls === 0) return "—";
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
    el.innerHTML = table(
      [
        { header: "Tool", render: function (r) { return esc(r.toolName); } },
        { header: "Calls", right: true, render: function (r) { return fmtNum(r.calls); } },
        { header: "Success", right: true, render: function (r) { return fmtNum(r.successCount); } },
        { header: "402", right: true, render: function (r) { return fmtNum(r.challenges); } },
        { header: "Settled", right: true, render: function (r) { return fmtNum(r.settledCalls); } },
        { header: "Conversion", right: true, render: function (r) { return r.conversionPct === null ? "—" : r.conversionPct + "%"; } },
        { header: "Revenue", right: true, render: function (r) { return renderRevenueCell(r); } },
        { header: "Avg / Paid Call", right: true, render: function (r) { return renderAvgCell(r); } },
        { header: "p50", right: true, render: function (r) { return fmtMs(r.p50LatencyMs); } },
        { header: "p95", right: true, render: function (r) { return fmtMs(r.p95LatencyMs); } }
      ],
      rows,
      "No tool usage recorded in this period."
    );
    if (rows.length) {
      var trs = el.querySelectorAll("tbody tr");
      rows.forEach(function (r, i) { if (r.settledCalls > 0 && trs[i]) trs[i].classList.add("row-highlight"); });
    }
  }

  function renderX402Funnel(data) {
    var f = data.x402Funnel;
    var el = document.getElementById("x402-funnel");
    el.innerHTML =
      '<div class="kpi-grid">' +
      kpiCard("402 Challenges", fmtNum(f.challenges)) +
      kpiCard("Payment Verified", fmtNum(f.paymentVerified)) +
      kpiCard("Settlement Succeeded", fmtNum(f.settlementSucceeded)) +
      kpiCard("Settlement Failed", fmtNum(f.settlementFailed)) +
      "</div>" +
      '<dl class="fieldlist">' +
      "<dt>Challenge \u2192 Verified</dt><dd>" + fmtPct(f.conversion.challengeToVerifiedPct) + "</dd>" +
      "<dt>Verified \u2192 Settled</dt><dd>" + fmtPct(f.conversion.verifiedToSettledPct) + "</dd>" +
      "<dt>Challenge \u2192 Settled</dt><dd>" + fmtPct(f.conversion.challengeToSettledPct) + "</dd>" +
      "</dl>";
  }

  function renderUsage(data) {
    var u = data.usage;
    var el = document.getElementById("usage-metrics");
    el.innerHTML =
      '<div class="kpi-grid">' +
      kpiCard("Discovery Hits", fmtNum(u.discoveryHits)) +
      kpiCard("Unique Clients", fmtNum(u.uniqueClients)) +
      kpiCard("MCP initialize", fmtNum(u.mcpInitialize)) +
      kpiCard("MCP tools/list", fmtNum(u.mcpToolsList)) +
      kpiCard("MCP tools/call", fmtNum(u.mcpToolsCall)) +
      kpiCard("Total Tool Calls", fmtNum(u.totalToolCalls)) +
      kpiCard("analyze_oman_property Calls", fmtNum(u.analyzeOmanPropertyCalls)) +
      kpiCard("Tool Success Rate", fmtPct(u.toolSuccessRatePct)) +
      kpiCard("p50 Latency", fmtMs(u.p50LatencyMs)) +
      kpiCard("p95 Latency", fmtMs(u.p95LatencyMs)) +
      kpiCard("Partner Feed Usage", fmtPct(u.partnerFeedUsagePct)) +
      "</div>";
  }

  function renderTransactions(data) {
    var el = document.getElementById("latest-transactions");
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
      data.transactions,
      "No settlements recorded in this period."
    );
  }

  function renderReconciliation(data) {
    var el = document.getElementById("reconciliation");
    var rec = data.reconciliation;
    if (!rec.anomalies.length) {
      el.innerHTML = '<div class="ok-banner">\u2713 No anomalies</div>';
      return;
    }
    var rows = rec.anomalies.map(function (a) {
      return '<div class="warning-banner"><strong>' + esc(a.kind) + "</strong>" + (a.toolName ? " \u2014 " + esc(a.toolName) : "") + "<br>" + esc(a.detail) + "</div>";
    }).join("");
    el.innerHTML = rows;
  }

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

  function renderDashboard(data) {
    document.getElementById("generated-at").textContent = "Data as of " + fmtDate(data.generatedAt) + " \u00b7 period: " + data.period;
    renderRevenueKpis(data);
    renderTrend(data);
    renderRevenueByTool(data);
    renderX402Funnel(data);
    renderUsage(data);
    renderToolConversion(data);
    renderTransactions(data);
    renderReconciliation(data);
    renderSystemStatus(data);
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

  function loadPeriod(period) {
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
        showError("Unable to load dashboard data right now (" + (err && err.message ? err.message : "unknown error") + "). Showing the last successfully loaded data, if any.");
      });
  }

  document.addEventListener("DOMContentLoaded", function () {
    var initial = window.__DASHBOARD_INITIAL__;
    if (initial) renderDashboard(initial);
    document.querySelectorAll(".period-bar button").forEach(function (btn) {
      btn.addEventListener("click", function () { loadPeriod(btn.getAttribute("data-period")); });
    });
    var sortSelect = document.getElementById("tool-conversion-sort");
    if (sortSelect) {
      sortSelect.addEventListener("change", function () {
        if (lastDashboardData) renderToolConversion(lastDashboardData);
      });
    }
  });
})();
`;

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/-->/g, "--\\u003e");
}

const PERIOD_LABELS: Record<DashboardPeriod, string> = { "24h": "24 Hours", "7d": "7 Days", "30d": "30 Days", all: "All Time" };

export function dashboardPageHtml(opts: { adminUser: string; csrfToken: string; initialData: DashboardData }): string {
  const periodButtons = (["24h", "7d", "30d", "all"] as DashboardPeriod[])
    .map(p => `<button type="button" data-period="${p}" class="${p === opts.initialData.period ? "active" : ""}">${esc(PERIOD_LABELS[p])}</button>`)
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
<main>
  <div class="topbar">
    <div>
      <h1>Rafid Property Intelligence</h1>
      <div class="brand-sub">Internal revenue &amp; operations dashboard</div>
    </div>
    <span class="user">${esc(opts.adminUser)} &middot; <form method="post" action="/internal/dashboard/logout" class="logout">${csrfField(opts.csrfToken)}<button type="submit" class="link">Log out</button></form></span>
  </div>
  <div id="generated-at" class="meta-row">Data as of ${esc(opts.initialData.generatedAt)} &middot; period: ${esc(opts.initialData.period)}</div>

  <div class="period-bar">${periodButtons}</div>

  <div id="dashboard-error" class="error-banner" style="display:none"></div>

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
    <h2>Agent / Tool Usage</h2>
    <div id="usage-metrics"></div>
  </div>

  <div class="panel">
    <div class="panel-head">
      <h2>Top Tools / Conversion by Tool</h2>
      <label class="sort-control">Sort by
        <select id="tool-conversion-sort">
          <option value="revenue">Revenue</option>
          <option value="settled">Settled Calls</option>
          <option value="calls">Total Calls</option>
          <option value="conversion">Conversion Rate</option>
        </select>
      </label>
    </div>
    <div id="tool-conversion"></div>
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
<script>window.__DASHBOARD_INITIAL__ = ${safeJson(opts.initialData)};</script>
<script>${CLIENT_SCRIPT}</script>
</body>
</html>`;
}

function csrfField(csrfToken: string): string {
  return `<input type="hidden" name="_csrf" value="${esc(csrfToken)}">`;
}
