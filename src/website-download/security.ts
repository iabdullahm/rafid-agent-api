import dns from "node:dns/promises";
import net from "node:net";
import { WebsiteDownloadError } from "./errors.js";

function ipv4ToNumber(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some(p => !/^\d+$/.test(p) || Number(p) > 255)) return null;
  return parts.reduce((n, p) => n * 256 + Number(p), 0) >>> 0;
}

function blockedAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/, "");
  const v4 = ipv4ToNumber(normalized);
  if (v4 !== null) {
    const inRange = (start: number, end: number) => v4 >= start && v4 <= end;
    return inRange(0, 0x00ffffff) || inRange(0x0a000000, 0x0affffff) || inRange(0x64400000, 0x647fffff)
      || inRange(0x7f000000, 0x7fffffff) || inRange(0xa9fe0000, 0xa9feffff) || inRange(0xac100000, 0xac1fffff)
      || inRange(0xc0a80000, 0xc0a8ffff) || inRange(0xe0000000, 0xffffffff);
  }
  if (!net.isIPv6(normalized)) return true;
  const first = normalized.split(":").filter(Boolean)[0] ?? "";
  const firstWord = parseInt(first, 16);
  return normalized === "::1" || normalized === "::" || (firstWord >= 0xfc00 && firstWord <= 0xfdff)
    || (firstWord >= 0xfe80 && firstWord <= 0xfebf) || firstWord >= 0xff00;
}

export async function validatePublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw new WebsiteDownloadError("INVALID_URL", "The URL is invalid.", 400); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new WebsiteDownloadError("UNSUPPORTED_PROTOCOL", "Only http and https URLs are supported.", 400);
  if (!url.hostname || url.username || url.password) throw new WebsiteDownloadError("INVALID_URL", "The URL must contain a hostname and no credentials.", 400);
  if (net.isIP(url.hostname) && blockedAddress(url.hostname)) throw new WebsiteDownloadError("SSRF_BLOCKED", "The destination resolves to a private or reserved network.");
  let addresses: Array<{ address: string; family: number }>;
  try { addresses = await dns.lookup(url.hostname, { all: true, verbatim: true }); }
  catch { throw new WebsiteDownloadError("DNS_RESOLUTION_FAILED", "The destination hostname could not be resolved.", 422); }
  if (!addresses.length || addresses.some(a => blockedAddress(a.address))) throw new WebsiteDownloadError("SSRF_BLOCKED", "The destination resolves to a private or reserved network.");
  url.hash = "";
  return url;
}
