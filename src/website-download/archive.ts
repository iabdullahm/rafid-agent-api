import { readFile } from "node:fs/promises";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import type { WebsiteDownloadOutput } from "../schemas/websiteDownloadOutputs.js";
import { WebsiteDownloadError } from "./errors.js";

function crc32(data: Buffer): number { let crc = 0xffffffff; for (const byte of data) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
function u16(n: number) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n: number) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }

export async function createZip(root: string, files: ReadonlyArray<WebsiteDownloadOutput["manifest"]["files"][number]>, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = []; const central: Buffer[] = []; let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.localPath, "utf8"); const source = await readFile(path.join(root, ...file.localPath.split("/"))); const compressed = deflateRawSync(source); const crc = crc32(source);
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0), u16(8), u16(0), u16(0), u32(crc), u32(compressed.length), u32(source.length), u16(name.length), u16(0), name, compressed]);
    chunks.push(local); central.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(8), u16(0), u16(0), u32(crc), u32(compressed.length), u32(source.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name])); offset += local.length;
  }
  const centralData = Buffer.concat(central); const end = Buffer.concat([u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(centralData.length), u32(offset), u16(0)]); const result = Buffer.concat([...chunks, centralData, end]);
  if (result.length > maxBytes) throw new WebsiteDownloadError("ARCHIVE_FAILED", "The generated archive exceeded the maximum archive size.");
  return result;
}
