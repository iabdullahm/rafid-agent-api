import { adminLayout, esc, fmtDate, table } from "./layout.js";
import type { AuditLogEntry } from "../../business-data/types.js";

export function auditPageHtml(opts: { adminUser: string; csrfToken: string; entries: AuditLogEntry[] }): string {
  const rows = table<AuditLogEntry>([
    { header: "Time", render: e => fmtDate(e.occurredAt) },
    { header: "Admin User", render: e => esc(e.adminUser) },
    { header: "Action", render: e => `<code>${esc(e.action)}</code>` },
    { header: "Entity", render: e => e.entityType ? `${esc(e.entityType)}${e.entityId ? ` / ${esc(e.entityId.slice(0, 12))}` : ""}` : "—" },
    { header: "Details", render: e => `<code style="white-space:pre-wrap;">${esc(JSON.stringify(e.metadata))}</code>` }
  ], opts.entries, "No audit log entries yet.");
  const body = `<div class="panel"><h2>Audit Log (most recent ${opts.entries.length})</h2><p style="color:var(--muted);font-size:12px;">Every admin login, import, manual verification, manual evidence entry, conflict resolution, company link/creation, record rejection and bulk recalculation is recorded here. Passwords, cookies, tokens and full uploaded-file contents are never logged.</p>${rows}</div>`;
  return adminLayout({ title: "Audit Log", activeNav: "audit", adminUser: opts.adminUser, csrfToken: opts.csrfToken, body });
}
