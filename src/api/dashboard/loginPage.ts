import { esc } from "../admin/layout.js";

/**
 * Sign-in page for the internal Rafid Property Intelligence dashboard (/internal/dashboard).
 *
 * Deliberately its own page rather than a reuse of admin/loginPage.ts: that page's form posts to
 * the hard-coded "/admin/login" path and carries "Oman Business Admin" branding, and — more
 * importantly — the router that serves it (adminRoutes.ts) only mounts when a business
 * intelligence database is configured (see app.ts's `config.adminEnabled && businessRepository`
 * condition), which this dashboard must not depend on (spec section 1: "Use the project's
 * existing frontend/server architecture where practical", not "requires the business-intelligence
 * database to exist"). The AUTHENTICATION MECHANISM is still fully reused, unchanged: the same
 * `rafid_admin_session` HMAC-signed cookie, the same ADMIN_USERNAME/ADMIN_PASSWORD_HASH/
 * ADMIN_SESSION_SECRET credentials, the same middleware/adminAuth.ts functions — an operator who
 * signs in here is also signed in to /admin/business/* (when configured) and vice versa, since
 * both read/write the identical cookie.
 */
export function dashboardLoginPageHtml(opts: { error?: string; returnTo?: string }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in · Rafid Property Intelligence</title>
<meta name="robots" content="noindex, nofollow">
<style>
:root { color-scheme: dark; }
body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:#0b1220; color:#e6ebf2; font:14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
form { background:#121b2e; border:1px solid #1f2b40; border-radius:12px; padding:32px; width:320px; }
h1 { font-size:18px; margin:0 0 4px; }
p.sub { color:#9fb0c9; font-size:12px; margin:0 0 20px; }
label { display:block; font-size:12px; color:#9fb0c9; margin:14px 0 4px; }
input { width:100%; background:#0f1729; border:1px solid #1f2b40; color:#e6ebf2; border-radius:6px; padding:9px 10px; font-size:14px; }
button { margin-top:20px; width:100%; background:#2563eb; color:#fff; border:none; border-radius:6px; padding:10px; font-size:14px; font-weight:600; cursor:pointer; }
.error { background:#2c1414; border:1px solid #4a1f1f; color:#ff8f8f; border-radius:8px; padding:10px 12px; font-size:12px; margin-bottom:6px; }
</style>
</head>
<body>
<form method="post" action="/internal/dashboard/login">
  <h1>Rafid Property Intelligence</h1>
  <p class="sub">Internal revenue &amp; operations dashboard — authorized operators only.</p>
  ${opts.error ? `<div class="error">${esc(opts.error)}</div>` : ""}
  <input type="hidden" name="returnTo" value="${esc(opts.returnTo ?? "")}">
  <label for="username">Username</label>
  <input id="username" name="username" autocomplete="username" required autofocus>
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" required>
  <button type="submit">Sign in</button>
</form>
</body>
</html>`;
}
