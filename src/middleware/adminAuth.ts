import type { Request, RequestHandler, Response } from "express";
import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import type { Config } from "../config/env.js";
import { ApiError } from "../utils/errors.js";

/**
 * Oman Business Intelligence Admin & Data Operations Dashboard — authentication (Section 3).
 *
 * A minimal, dependency-free admin auth layer built for this app's existing stack (plain Express,
 * no session store, no bcrypt/jsonwebtoken dependency): a scrypt password hash checked against
 * ADMIN_USERNAME/ADMIN_PASSWORD_HASH, and a stateless, HMAC-signed session cookie carrying the
 * admin username, an expiry and a per-login CSRF token — verified with Node's built-in `crypto`
 * only, no new dependency. Mirrors this codebase's existing "503 if unconfigured, never silently
 * unprotected" convention (middleware/partnerAuth.ts's requireInternalAuth).
 *
 * Deliberately NOT the same mechanism as the rest of the API (X-API-Key / x402): this is a human
 * operator logging into a browser UI, so a cookie is the right primitive — see api/app.ts's own
 * CORS comment, which this module's cookie (SameSite=Strict, HttpOnly, and never sent to a
 * different origin) keeps true even though every other route on this app is cookie-free.
 */

const SESSION_COOKIE = "rafid_admin_session";
const CSRF_HEADER = "x-csrf-token";

export interface AdminSessionPayload {
  u: string; // admin username
  csrf: string; // per-login CSRF token
  exp: number; // epoch ms
}

// ---- Password hashing (scrypt, one-way, salted) --------------------------------------------

/** Generates a new `scrypt:<saltHex>:<hashHex>` string for ADMIN_PASSWORD_HASH — never logged,
 *  never stored in plaintext. Used by `npm run admin:hash-password -- <password>` (scripts/
 *  hashAdminPassword.ts) and by tests. */
export function hashAdminPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64);
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

/** Constant-time password check against a `scrypt:<saltHex>:<hashHex>` string. Never throws on a
 *  malformed stored hash (misconfiguration) — treated as "does not match" so a broken
 *  ADMIN_PASSWORD_HASH fails closed rather than crashing the login route. */
export function verifyAdminPassword(password: string, stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  try {
    const salt = Buffer.from(parts[1]!, "hex");
    const expected = Buffer.from(parts[2]!, "hex");
    const actual = scryptSync(password, salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

// ---- Session cookie (HMAC-signed, stateless) ------------------------------------------------

function sign(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function encodeSession(payload: AdminSessionPayload, secret: string): string {
  const json = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = sign(json, secret);
  return `${json}.${sig}`;
}

function decodeSession(token: string, secret: string): AdminSessionPayload | null {
  const dot = token.lastIndexOf(".");
  if (dot < 0) return null;
  const json = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expectedSig = sign(json, secret);
  const sigBuf = Buffer.from(sig, "hex");
  const expectedBuf = Buffer.from(expectedSig, "hex");
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(json, "base64url").toString("utf8")) as AdminSessionPayload;
    if (typeof payload.u !== "string" || typeof payload.csrf !== "string" || typeof payload.exp !== "number") return null;
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function setAdminSessionCookie(res: Response, config: Config, username: string): AdminSessionPayload {
  const payload: AdminSessionPayload = { u: username, csrf: randomUUID(), exp: Date.now() + config.adminSessionTtlMinutes * 60_000 };
  const token = encodeSession(payload, config.adminSessionSecret);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.nodeEnv === "production",
    // Strict, not Lax: this cookie must never be sent on a cross-site navigation or form post —
    // the only thing that keeps api/app.ts's wildcard Access-Control-Allow-Origin honest for the
    // rest of the app is that no route relies on ambient cookie auth; /admin/* is the one
    // exception, so its cookie compensates by refusing to travel cross-site at all.
    sameSite: "strict",
    maxAge: config.adminSessionTtlMinutes * 60_000,
    path: "/"
  });
  return payload;
}

export function clearAdminSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

function readSessionCookie(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (name === SESSION_COOKIE) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

export function readAdminSession(req: Request, config: Config): AdminSessionPayload | null {
  const token = readSessionCookie(req);
  if (!token) return null;
  return decodeSession(token, config.adminSessionSecret);
}

// ---- Middleware -------------------------------------------------------------------------------

/** 503s every request when the dashboard isn't configured, rather than silently having no auth
 *  (mirrors requireInternalAuth's pattern in middleware/partnerAuth.ts) — applied first, before
 *  any other admin middleware, on both the HTML and JSON route families. */
export function requireAdminConfigured(config: Config): RequestHandler {
  return (_req, _res, next) => {
    if (!config.adminEnabled) return next(new ApiError(503, "ADMIN_NOT_CONFIGURED", "The business admin dashboard is not configured on this deployment"));
    next();
  };
}

/** For the JSON admin API (/api/admin/business/*): 401s with the standard error envelope, since
 *  a fetch() call from the dashboard's own JS handles that itself (redirecting to /admin/login on
 *  a 401) rather than expecting a server-side redirect. */
export function requireAdminAuthApi(config: Config): RequestHandler {
  return (req, res, next) => {
    const session = readAdminSession(req, config);
    if (!session) return next(new ApiError(401, "UNAUTHENTICATED", "Admin login required"));
    res.locals.adminUser = session.u;
    res.locals.adminCsrf = session.csrf;
    next();
  };
}

/** For the server-rendered HTML pages (/admin/*): redirects to the login page instead of
 *  returning a bare 401, since a browser navigating directly to e.g. /admin/business/companies
 *  should land on a login form, not a JSON error body. */
export function requireAdminAuthHtml(config: Config): RequestHandler {
  return (req, res, next) => {
    const session = readAdminSession(req, config);
    if (!session) {
      const returnTo = encodeURIComponent(req.originalUrl);
      res.redirect(302, `/admin/login?returnTo=${returnTo}`);
      return;
    }
    res.locals.adminUser = session.u;
    res.locals.adminCsrf = session.csrf;
    next();
  };
}

/** Synchronizer-token CSRF check for every state-changing admin request (POST/PUT/DELETE on
 *  either the HTML forms or the JSON API) — the token embedded in the signed session cookie at
 *  login must be echoed back, either as a hidden `_csrf` form field (HTML forms) or an
 *  `X-CSRF-Token` header (JS fetch() calls from the dashboard's own pages). Requires
 *  requireAdminAuthApi/requireAdminAuthHtml to have already run (res.locals.adminCsrf set). */
export const requireCsrf: RequestHandler = (req, res, next) => {
  const expected = res.locals.adminCsrf as string | undefined;
  const provided = (req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>)._csrf : undefined) ?? req.header(CSRF_HEADER);
  if (!expected || typeof provided !== "string" || provided !== expected) {
    return next(new ApiError(403, "CSRF_TOKEN_INVALID", "Missing or invalid CSRF token"));
  }
  next();
};
