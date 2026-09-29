import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { WebsiteDownloadOutput } from "../schemas/websiteDownloadOutputs.js";
import { WebsiteDownloadError } from "./errors.js";

type ManifestFile = WebsiteDownloadOutput["manifest"]["files"][number];
const classify = (name: string): ManifestFile["type"] => {
  const ext = path.extname(name).toLowerCase();
  if ([".html", ".htm", ".xhtml"].includes(ext)) return "html";
  if (ext === ".css") return "css";
  if ([".js", ".mjs", ".cjs", ".map"].includes(ext)) return "javascript";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".ico", ".avif"].includes(ext)) return "image";
  if ([".woff", ".woff2", ".ttf", ".otf", ".eot"].includes(ext)) return "font";
  if ([".json", ".xml", ".webmanifest"].includes(ext)) return "json";
  if ([".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv"].includes(ext)) return "document";
  if ([".mp3", ".mp4", ".webm", ".wav", ".ogg", ".mov"].includes(ext)) return "media";
  return "other";
};
const contentType = (name: string): string | null => ({ ".html": "text/html", ".htm": "text/html", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".woff2": "font/woff2", ".pdf": "application/pdf" }[path.extname(name).toLowerCase()] ?? null);

export async function buildManifest(root: string, maxFiles: number, maxBytes: number) {
  const files: ManifestFile[] = []; let totalSizeBytes = 0;
  async function visit(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { await visit(full); continue; }
      if (!entry.isFile()) continue;
      if (files.length >= maxFiles) throw new WebsiteDownloadError("TOO_MANY_FILES", "The website exceeded the maximum file count.");
      const sizeBytes = (await stat(full)).size; totalSizeBytes += sizeBytes;
      if (totalSizeBytes > maxBytes) throw new WebsiteDownloadError("DOWNLOAD_QUOTA_EXCEEDED", "The website exceeded the maximum download size.");
      files.push({ localPath: path.relative(root, full).split(path.sep).join("/"), type: classify(entry.name), contentType: contentType(entry.name), sizeBytes });
    }
  }
  await visit(root);
  return { files, totalSizeBytes };
}
