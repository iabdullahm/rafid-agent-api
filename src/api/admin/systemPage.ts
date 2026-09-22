import { adminLayout, boolChip, chip, esc } from "./layout.js";

export interface SystemStatus {
  databaseConnected: boolean;
  businessMigrationsCurrent: boolean;
  adminAuthEnabled: boolean;
  businessProviderMode: string;
  demoDataEnabled: boolean;
  latestSyncStatus: string;
  nodeEnv: string;
  rateLimitEnabled: boolean;
}

/** Section 27: safe diagnostics only — every sensitive value is reported as configured/not
 *  configured, never its actual value. */
export function systemPageHtml(opts: { adminUser: string; csrfToken: string; status: SystemStatus }): string {
  const s = opts.status;
  const body = `
<div class="panel">
  <h2>Environment Status</h2>
  <dl class="fieldlist">
    <dt>Database</dt><dd>${boolChip(s.databaseConnected, "Connected", "Not connected")}</dd>
    <dt>Business migrations</dt><dd>${boolChip(s.businessMigrationsCurrent, "Current", "Out of date")}</dd>
    <dt>Admin auth</dt><dd>${boolChip(s.adminAuthEnabled, "Enabled", "Disabled")}</dd>
    <dt>Business provider mode</dt><dd>${esc(s.businessProviderMode)}</dd>
    <dt>Demo data</dt><dd>${s.demoDataEnabled ? chip("Enabled", "unknown") : chip("Disabled", "verified")}</dd>
    <dt>Latest sync status</dt><dd>${chip(s.latestSyncStatus)}</dd>
    <dt>Environment</dt><dd>${esc(s.nodeEnv)}</dd>
    <dt>Rate limiting</dt><dd>${boolChip(s.rateLimitEnabled, "Enabled", "Disabled")}</dd>
  </dl>
</div>
${s.demoDataEnabled ? `<div class="warning-banner">Demo data is present in this dataset. Demo records are never presented as real, government-verified Oman business data anywhere in the API or this dashboard — every demo-sourced company/field is labeled "Demo" and excluded from the "Real Companies" counts. This setting never deletes real records.</div>` : ""}
`;
  return adminLayout({ title: "System", activeNav: "system", adminUser: opts.adminUser, csrfToken: opts.csrfToken, body });
}
