import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

export interface WebsiteDownloadStorage { put(data: Buffer): Promise<{ fileId: string; sizeBytes: number }>; get(fileId: string): Promise<Buffer>; }
export class LocalWebsiteDownloadStorage implements WebsiteDownloadStorage {
  constructor(private readonly root: string) {}
  async put(data: Buffer) { await mkdir(this.root, { recursive: true }); const fileId = randomBytes(18).toString("hex"); await writeFile(path.join(this.root, `${fileId}.zip`), data, { flag: "wx" }); return { fileId, sizeBytes: data.length }; }
  async get(fileId: string) { if (!/^[a-f0-9]{36}$/.test(fileId)) throw new Error("invalid artifact id"); return readFile(path.join(this.root, `${fileId}.zip`)); }
}
