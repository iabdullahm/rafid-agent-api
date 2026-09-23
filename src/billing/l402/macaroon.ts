import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Minimal, dependency-free macaroon implementation — just what L402 needs: first-party caveats
 * only, the libmacaroons/go-macaroon HMAC-SHA256 signature chain, and the standard V2 binary
 * serialization (base64-encoded on the wire). Deliberately interoperable with go-macaroon (what
 * Lightning Labs' Aperture and lnd use) and js-macaroon, so any L402-aware client can carry a
 * Rafid token unchanged — see tests/l402.test.ts for the known-answer vectors.
 *
 * Signature chain (same as libmacaroons):
 *   key  = HMAC-SHA256(key = "macaroons-key-generator", msg = rootKey)
 *   sig0 = HMAC-SHA256(key, identifier)
 *   sigN = HMAC-SHA256(sigN-1, caveatN)
 *
 * V2 binary format: 0x02, [location field (type 1)], identifier field (type 2), EOS; then per
 * caveat: identifier field (type 2), EOS; then EOS; then signature field (type 6). Each field is
 * type byte + unsigned varint length + bytes; EOS is a single 0x00.
 */

const KEY_GENERATOR = Buffer.from("macaroons-key-generator", "utf8");
const FIELD_EOS = 0, FIELD_LOCATION = 1, FIELD_IDENTIFIER = 2, FIELD_VID = 4, FIELD_SIGNATURE = 6;

export interface Macaroon {
  location: string;
  identifier: Buffer;
  caveats: string[];
  signature: Buffer;
}

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

function deriveKey(rootKey: Buffer): Buffer {
  return hmac(KEY_GENERATOR, rootKey);
}

function computeSignature(rootKey: Buffer, identifier: Buffer, caveats: readonly string[]): Buffer {
  let sig = hmac(deriveKey(rootKey), identifier);
  for (const caveat of caveats) sig = hmac(sig, Buffer.from(caveat, "utf8"));
  return sig;
}

export function mintMacaroon(args: { rootKey: Buffer; identifier: Buffer; location: string; caveats: readonly string[] }): Macaroon {
  return {
    location: args.location,
    identifier: Buffer.from(args.identifier),
    caveats: [...args.caveats],
    signature: computeSignature(args.rootKey, args.identifier, args.caveats)
  };
}

/** Constant-time check that `m` was minted with `rootKey` and its caveat list is unmodified. Does
 *  NOT evaluate what the caveats say — the caller does that (see gate.ts's checkCaveats()). */
export function verifyMacaroonSignature(m: Macaroon, rootKey: Buffer): boolean {
  const expected = computeSignature(rootKey, m.identifier, m.caveats);
  return m.signature.length === expected.length && timingSafeEqual(m.signature, expected);
}

function writeUvarint(n: number, out: number[]): void {
  while (n >= 0x80) { out.push((n & 0x7f) | 0x80); n >>>= 7; }
  out.push(n);
}

function writeField(type: number, data: Buffer, out: number[]): void {
  out.push(type);
  writeUvarint(data.length, out);
  for (const b of data) out.push(b);
}

export function serializeMacaroon(m: Macaroon): string {
  const out: number[] = [2];
  if (m.location) writeField(FIELD_LOCATION, Buffer.from(m.location, "utf8"), out);
  writeField(FIELD_IDENTIFIER, m.identifier, out);
  out.push(FIELD_EOS);
  for (const caveat of m.caveats) {
    writeField(FIELD_IDENTIFIER, Buffer.from(caveat, "utf8"), out);
    out.push(FIELD_EOS);
  }
  out.push(FIELD_EOS);
  writeField(FIELD_SIGNATURE, m.signature, out);
  return Buffer.from(out).toString("base64");
}

/** Hard cap on a decoded macaroon — an attacker-supplied Authorization header must never make
 *  this parser allocate or loop unboundedly. Real Rafid tokens are ~250 bytes. */
const MAX_MACAROON_BYTES = 4096;

class Reader {
  private pos = 0;
  constructor(private readonly buf: Buffer) {}
  byte(): number {
    if (this.pos >= this.buf.length) throw new Error("truncated macaroon");
    return this.buf[this.pos++]!;
  }
  peek(): number {
    if (this.pos >= this.buf.length) throw new Error("truncated macaroon");
    return this.buf[this.pos]!;
  }
  uvarint(): number {
    let result = 0, shift = 0;
    for (let i = 0; i < 5; i++) {
      const b = this.byte();
      result |= (b & 0x7f) << shift;
      if (b < 0x80) return result >>> 0;
      shift += 7;
    }
    throw new Error("varint too long");
  }
  bytes(n: number): Buffer {
    if (n < 0 || this.pos + n > this.buf.length) throw new Error("truncated macaroon field");
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return Buffer.from(b);
  }
  done(): boolean { return this.pos === this.buf.length; }
}

/** Parses a base64 (standard or URL-safe) V2 binary macaroon. Returns null — never throws — on
 *  anything malformed, oversized, or using features L402 never needs (third-party caveats). */
export function deserializeMacaroon(encoded: string): Macaroon | null {
  try {
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(encoded)) return null;
    const buf = Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (buf.length === 0 || buf.length > MAX_MACAROON_BYTES) return null;
    const r = new Reader(buf);
    if (r.byte() !== 2) return null;
    let location = "";
    let type = r.byte();
    if (type === FIELD_LOCATION) { location = r.bytes(r.uvarint()).toString("utf8"); type = r.byte(); }
    if (type !== FIELD_IDENTIFIER) return null;
    const identifier = r.bytes(r.uvarint());
    if (r.byte() !== FIELD_EOS) return null;
    const caveats: string[] = [];
    while (r.peek() !== FIELD_EOS) {
      let t = r.byte();
      if (t === FIELD_LOCATION) return null; // third-party caveat — never issued by Rafid
      if (t !== FIELD_IDENTIFIER) return null;
      const cid = r.bytes(r.uvarint());
      t = r.byte();
      if (t === FIELD_VID) return null; // third-party caveat
      if (t !== FIELD_EOS) return null;
      caveats.push(cid.toString("utf8"));
      if (caveats.length > 32) return null;
    }
    r.byte(); // end of caveats
    if (r.byte() !== FIELD_SIGNATURE) return null;
    const signature = r.bytes(r.uvarint());
    if (signature.length !== 32 || !r.done()) return null;
    return { location, identifier, caveats, signature };
  } catch {
    return null;
  }
}

/**
 * L402 token identifier (Lightning Labs' L402 spec / Aperture): version (uint16 big-endian, 0) ||
 * payment_hash (32 bytes) || token_id (32 bytes). Binding the payment hash into the signed
 * identifier is what lets the server verify a token with nothing but the preimage — no Lightning
 * node lookup on the hot path.
 */
export function encodeL402Identifier(paymentHash: Buffer, tokenId: Buffer): Buffer {
  if (paymentHash.length !== 32 || tokenId.length !== 32) throw new Error("paymentHash and tokenId must be 32 bytes");
  const version = Buffer.alloc(2);
  version.writeUInt16BE(0);
  return Buffer.concat([version, paymentHash, tokenId]);
}

export function decodeL402Identifier(identifier: Buffer): { version: number; paymentHash: Buffer; tokenId: Buffer } | null {
  if (identifier.length !== 66) return null;
  const version = identifier.readUInt16BE(0);
  if (version !== 0) return null;
  return { version, paymentHash: identifier.subarray(2, 34), tokenId: identifier.subarray(34, 66) };
}
