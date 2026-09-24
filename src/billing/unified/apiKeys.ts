import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { ApiKeyEnvironment } from "./types.js";

/**
 * Billing API keys: `raf_live_<secret>` / `raf_test_<secret>` (and the compatible public
 * `rafid_live_<secret>` / `rafid_test_<secret>` spelling), where <secret> is 32 bytes from
 * the OS CSPRNG, base64url-encoded (43 chars, 256 bits). Deliberately a different prefix from the
 * legacy customer keys (`rafid_<hex>`, X-API-Key header, src/db/store.ts), so the two systems can
 * never be confused.
 *
 * Only a SHA-256 hash of the full key is stored. A salted slow hash (bcrypt/scrypt) is not needed
 * and would be the wrong tool here: the secret is 256 bits of uniform randomness, so it cannot be
 * brute-forced or looked up in a dictionary, and a fast deterministic hash is what allows an
 * indexed O(1) lookup on every request. The raw key is returned exactly once, at creation.
 */
const KEY_PATTERN = /^(raf|rafid)_(live|test)_([A-Za-z0-9_-]{43})$/;

export function generateApiKey(environment: ApiKeyEnvironment) {
  const key = `raf_${environment}_${randomBytes(32).toString("base64url")}`;
  return { key, keyHash: hashApiKey(key), keyPrefix: key.slice(0, 13), id: "key_" + randomUUID().replace(/-/g, "") };
}

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

export function parseApiKey(key: string): { environment: ApiKeyEnvironment } | null {
  const m = KEY_PATTERN.exec(key);
  return m ? { environment: m[2] as ApiKeyEnvironment } : null;
}

/** True for anything shaped like a billing key's prefix — used to decide that the caller
 *  *meant* to present one (and should get a 401 if it's wrong) rather than no key at all. */
export function looksLikeBillingKey(value: string): boolean {
  return /^(?:raf|rafid)_(live|test)_/.test(value);
}

/** Extracts `Authorization: Bearer raf_…`. Returns undefined for any other scheme (L402,
 *  Payment, a non-Rafid bearer) so those keep flowing to their own rails untouched. */
export function bearerBillingKey(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
  if (!m || !looksLikeBillingKey(m[1]!)) return undefined;
  return m[1];
}

export const newId = (prefix: "acct" | "txn" | "sub") => `${prefix}_${randomUUID().replace(/-/g, "")}`;
