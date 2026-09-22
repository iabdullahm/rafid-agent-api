import { createHash } from "node:crypto";
import type { Request } from "express";
import type { RequestClientContext } from "./context.js";

/** Applied to every stored User-Agent/Referer/X-Client-Name value — bounds how much of an
 *  arbitrary, caller-controlled header this table will ever hold, and keeps analytics rows small.
 *  Not a security boundary (these fields are already advisory/self-reported, never used for
 *  authorization) — just a sane cap on untrusted input length. */
export const MAX_ATTRIBUTION_FIELD_LENGTH = 200;

function truncate(value: string | undefined | null, max = MAX_ATTRIBUTION_FIELD_LENGTH): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

/** Strips the query string and fragment from a Referer header before it is ever stored — a
 *  referring page's query string can carry the caller's own secrets (session tokens, ids, API
 *  keys passed as a query param elsewhere), and only the origin+path is safe, coarse attribution
 *  data. Returns null for a missing or malformed header rather than storing raw, unparsed text. */
function sanitizeReferer(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return truncate(`${url.origin}${url.pathname}`);
  } catch {
    return null;
  }
}

/** A coarse, one-way client identity for grouping repeat callers in analytics — never a raw IP,
 *  never reversible. Hashes IP + User-Agent together (sha256, truncated to 16 hex characters) so
 *  the same caller's requests can be correlated without this table ever holding an actual
 *  address. Exported (rather than inlined into extractClientContext) so tests can assert the
 *  same input always hashes to the same coarse identity without needing a real Express Request. */
export function hashClientIdentity(ip: string, userAgent: string): string {
  return createHash("sha256").update(`${ip}|${userAgent}`).digest("hex").slice(0, 16);
}

/** Reads the caller's IP the same way the rest of this codebase already does: Vercel's Node
 *  runtime does not set Express's "trust proxy", so `req.ip`/`req.socket.remoteAddress` alone
 *  reports the platform's own edge, not the real caller — read X-Forwarded-For directly instead,
 *  exactly like api/app.ts's getOrigin() reads X-Forwarded-Proto for the same reason. Falls back
 *  to the raw socket address (correct for local dev / direct connections, where there is no
 *  proxy to forward from) rather than fabricating a value. */
function clientIp(req: Request): string {
  const forwarded = req.header("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}

/** Everything analytics ever learns about "who called this" — deliberately narrow: a coarse
 *  hash, three advisory/self-reported headers, nothing that could double as a credential or a
 *  reversible identifier. Called once per HTTP request wherever an analytics event is about to
 *  be recorded (api/app.ts for discovery/x402; mcp/remote.ts for MCP, which also stashes the
 *  result in mcpClientContext — see context.ts's doc comment on why). */
export function extractClientContext(req: Request): RequestClientContext {
  const userAgent = req.header("user-agent") ?? "";
  return {
    clientHash: hashClientIdentity(clientIp(req), userAgent),
    userAgent: truncate(userAgent),
    referer: sanitizeReferer(req.header("referer")),
    clientName: truncate(req.header("x-client-name") ?? req.header("x-agent-name"))
  };
}
