import { promises as dns } from "node:dns";

/**
 * Production Feed Runner (Section 3): SSRF protection for partner-supplied feed URLs. A partner
 * chooses their own `feedUrl` at onboarding time (Section 1), so this is untrusted input exactly
 * like any other partner-supplied value — the runner must never let it be used to reach the
 * server's own internal network, localhost, or a file on disk.
 *
 * Deliberately split from the actual HTTP fetch (safeFeedFetch.ts) so it can be unit tested with
 * plain URL strings and a fake `HostResolver` — no real network or DNS lookup needed to exercise
 * every rejection path (Section 11: "Normal tests must use mock HTTP only").
 */

export type FeedUrlRejectionReason =
  | "invalid_url" | "unsupported_scheme" | "blocked_hostname" | "not_in_allowlist"
  | "private_ip_literal" | "private_ip_resolved";

export class FeedUrlRejectedError extends Error {
  constructor(readonly reason: FeedUrlRejectionReason, message: string) {
    super(message);
    this.name = "FeedUrlRejectedError";
  }
}

/** Resolves a hostname to its IP addresses — abstracted so tests can inject a deterministic fake
 *  resolver instead of performing a real DNS lookup (which the sandboxed test environment's
 *  network egress may not even permit, and which would make tests flaky/slow regardless). */
export interface HostResolver {
  resolve(hostname: string): Promise<readonly string[]>;
}

export class DnsHostResolver implements HostResolver {
  async resolve(hostname: string): Promise<readonly string[]> {
    const results = await dns.lookup(hostname, { all: true });
    return results.map(r => r.address);
  }
}

export interface FeedUrlValidationOptions {
  /** When non-empty, ONLY these exact hostnames (case-insensitive) may be fetched — every other
   *  check below still applies on top of this. Empty/undefined means "any public hostname that
   *  passes the private-IP checks", not "anything goes". */
  allowlist?: readonly string[];
  resolver?: HostResolver;
  /** Test/dev-only escape hatch to permit plain `http://` — production always requires `https://`.
   *  Never read from an environment variable that a partner could influence. */
  allowInsecureHttp?: boolean;
}

const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "0.0.0.0", "0", "[::]", "::"]);

function isIpv4Literal(host: string): boolean {
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

function isPrivateOrReservedIpv4(host: string): boolean {
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return true; // malformed -> treat as unsafe
  const [a, b] = parts as [number, number, number, number];
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT (RFC6598)
  if (a === 192 && b === 0 && parts[2] === 2) return true; // documentation (TEST-NET-1)
  if (a === 198 && b === 51 && parts[2] === 100) return true; // documentation (TEST-NET-2)
  if (a === 203 && b === 0 && parts[2] === 113) return true; // documentation (TEST-NET-3)
  if (a >= 224) return true; // multicast (224/4) + reserved (240/4) + broadcast
  return false;
}

function isPrivateOrReservedIpv6(hostRaw: string): boolean {
  const host = hostRaw.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "::1" || host === "::" || host === "0:0:0:0:0:0:0:1" || host === "0:0:0:0:0:0:0:0") return true;
  // IPv4-mapped (::ffff:a.b.c.d) — check the embedded IPv4 address by its own rules.
  const mapped = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateOrReservedIpv4(mapped[1]!);
  const firstHextet = host.split(":")[0] ?? "";
  if (/^fe[89ab][0-9a-f]$/.test(firstHextet)) return true; // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}$/.test(firstHextet)) return true; // fc00::/7 unique local
  return false;
}

function isIpLiteral(host: string): boolean {
  return isIpv4Literal(host) || host.includes(":");
}

function isPrivateOrLinkLocalIp(host: string): boolean {
  return host.includes(":") ? isPrivateOrReservedIpv6(host) : isPrivateOrReservedIpv4(host);
}

/**
 * Validates a feed URL against every SSRF control this layer enforces, returning the parsed `URL`
 * on success. Called both before the initial request AND before following any redirect (Section 3:
 * "do not blindly follow redirects to another hostname") — a caller must re-validate the redirect
 * target through this same function, never assume a `Location` header is safe.
 */
export async function validateFeedUrl(rawUrl: string, options: FeedUrlValidationOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FeedUrlRejectedError("invalid_url", `feed URL "${rawUrl}" is not a valid URL`);
  }
  if (url.protocol === "https:") {
    // fine
  } else if (url.protocol === "http:" && options.allowInsecureHttp) {
    // fine — explicit test/dev opt-in only
  } else {
    throw new FeedUrlRejectedError("unsupported_scheme", `feed URL scheme "${url.protocol}" is not allowed — only https:// is permitted`);
  }

  const hostname = url.hostname.toLowerCase();

  if (options.allowlist && options.allowlist.length > 0) {
    const allowed = options.allowlist.map(h => h.toLowerCase());
    if (!allowed.includes(hostname)) {
      throw new FeedUrlRejectedError("not_in_allowlist", `host "${hostname}" is not in the configured feed host allowlist`);
    }
  }

  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith(".localhost")) {
    throw new FeedUrlRejectedError("blocked_hostname", `host "${hostname}" is not allowed (localhost/loopback)`);
  }

  if (isIpLiteral(hostname)) {
    if (isPrivateOrLinkLocalIp(hostname)) {
      throw new FeedUrlRejectedError("private_ip_literal", `IP address "${hostname}" is in a private, loopback, link-local or reserved range and is not allowed`);
    }
    return url;
  }

  const resolver = options.resolver ?? new DnsHostResolver();
  const addresses = await resolver.resolve(hostname);
  for (const address of addresses) {
    if (isPrivateOrLinkLocalIp(address)) {
      throw new FeedUrlRejectedError("private_ip_resolved", `host "${hostname}" resolves to a private, loopback, link-local or reserved IP address and is not allowed`);
    }
  }
  return url;
}
