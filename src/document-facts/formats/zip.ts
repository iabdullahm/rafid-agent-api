import { inflateRawSync } from "node:zlib";
import { DOCUMENT_FACTS_LIMITS as L } from "../config.js";

/**
 * Minimal read-only ZIP reader for DOCX (stored + DEFLATE entries only). Zip-bomb safe: an entry's
 * declared and actual inflated size are both capped (inflateRawSync maxOutputLength). Nothing in
 * the archive is ever executed — entries are only inspected by name or read as XML text.
 */
export interface ZipEntryInfo { name: string; method: number; compressedSize: number; uncompressedSize: number; localOffset: number }

export class ZipFormatError extends Error {}

export function listZipEntries(buf: Buffer): Map<string, ZipEntryInfo> {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipFormatError("no ZIP end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, ZipEntryInfo>();
  if (count > 5000) throw new ZipFormatError("too many ZIP entries");
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipFormatError("malformed ZIP central directory");
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const uncompressedSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen).replace(/^\//, "");
    out.set(name, { name, method, compressedSize, uncompressedSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

export function readZipText(buf: Buffer, entry: ZipEntryInfo, maxBytes = L.maxDocxPartBytes): string {
  if (entry.uncompressedSize > maxBytes) throw new ZipFormatError(`ZIP part ${entry.name} is too large`);
  const lo = entry.localOffset;
  if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== 0x04034b50) throw new ZipFormatError(`malformed ZIP local header for ${entry.name}`);
  const start = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
  const data = buf.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data.toString("utf8");
  if (entry.method === 8) {
    try { return inflateRawSync(data, { maxOutputLength: maxBytes }).toString("utf8"); }
    catch { throw new ZipFormatError(`could not inflate ZIP part ${entry.name}`); }
  }
  throw new ZipFormatError(`unsupported ZIP compression method ${entry.method}`);
}
