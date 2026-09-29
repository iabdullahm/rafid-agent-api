import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { websiteDownloadInput, type WebsiteDownloadInput } from "../schemas/websiteDownloadInputs.js";
import { websiteDownloadOutput, type WebsiteDownloadOutput } from "../schemas/websiteDownloadOutputs.js";
import { getWebsiteDownloadConfig } from "./config.js";
import { validatePublicUrl } from "./security.js";
import { buildManifest } from "./manifest.js";
import { createZip } from "./archive.js";
import { runWget, type WgetRunner } from "./wgetRunner.js";
import { LocalWebsiteDownloadStorage, type WebsiteDownloadStorage } from "./storage.js";
import { WebsiteDownloadError } from "./errors.js";

let runner: WgetRunner = runWget;
let validateUrl: typeof validatePublicUrl = validatePublicUrl;
let storage: WebsiteDownloadStorage | null = null;
export function configureWebsiteDownload(deps: { runner?: WgetRunner; storage?: WebsiteDownloadStorage; validateUrl?: typeof validatePublicUrl } = {}) { if (deps.runner) runner = deps.runner; if (deps.storage) storage = deps.storage; if (deps.validateUrl) validateUrl = deps.validateUrl; }
function getStorage() { return storage ??= new LocalWebsiteDownloadStorage(path.resolve(getWebsiteDownloadConfig().storageDir)); }

export async function websiteDownload(raw: unknown): Promise<WebsiteDownloadOutput> {
  const input = websiteDownloadInput.parse(raw) as WebsiteDownloadInput; const config = getWebsiteDownloadConfig();
  if (input.maxSizeMb > config.maxMb || input.maxFiles > config.maxFiles || input.maxDepth > config.maxDepth || input.timeoutSeconds * 1000 > config.maxTimeoutMs) throw new WebsiteDownloadError("DOWNLOAD_QUOTA_EXCEEDED", "Requested limits exceed the server policy.", 400);
  const url = await validateUrl(input.url); const started = performance.now(); const work = await mkdtemp(path.join(os.tmpdir(), "rafid-website-download-"));
  try {
    const run = await runner({ cwd: work, input: { ...input, url: url.toString() }, hostname: url.hostname, maxBytes: input.maxSizeMb * 1024 * 1024, maxFiles: input.maxFiles });
    const manifest = await buildManifest(work, input.maxFiles, input.maxSizeMb * 1024 * 1024); if (!manifest.files.length) throw new Error("empty download");
    let archive: Buffer | null = null;
    try { archive = input.output === "manifest" ? null : await createZip(work, manifest.files, input.maxSizeMb * 1024 * 1024); }
    catch (error) { if (error instanceof WebsiteDownloadError) throw error; throw new WebsiteDownloadError("ARCHIVE_FAILED", "The website archive could not be created.", 500); }
    let stored: { fileId: string; sizeBytes: number } | null = null;
    if (archive) { try { stored = await getStorage().put(archive); } catch { throw new WebsiteDownloadError("STORAGE_FAILED", "The website archive could not be stored.", 503); } }
    return websiteDownloadOutput.parse({ success: true, sourceUrl: url.toString(), finalUrl: run.finalUrl, pagesDownloaded: manifest.files.filter(f => f.type === "html").length, assetsDownloaded: manifest.files.filter(f => f.type !== "html").length, totalFiles: manifest.files.length, totalSizeBytes: manifest.totalSizeBytes, durationMs: Math.round(performance.now() - started), archive: stored ? { available: true, format: "zip", sizeBytes: stored.sizeBytes, fileId: stored.fileId, downloadUrl: `/api/v1/websites/download/artifacts/${stored.fileId}` } : null, manifest: { files: manifest.files }, warnings: run.stderr ? ["wget reported warnings; the manifest reflects files actually written."] : [] });
  } catch (error) {
    if (error instanceof Error && error.message === "empty download") throw new WebsiteDownloadError("DOWNLOAD_FAILED", "The website download produced no files.");
    throw error;
  } finally { await rm(work, { recursive: true, force: true }); }
}

export async function getWebsiteDownloadArtifact(fileId: string) { return getStorage().get(fileId); }
export async function previewWebsiteDownload(raw: unknown) { const input = websiteDownloadInput.parse(raw); return { capability: "website_download", status: "limited" as const, inputRecognized: true, preview: { availableSections: ["sourceUrl", "estimatedLimits"], dataCoverage: "low" as const, signals: { sourceUrl: input.url, maxDepth: 0, archive: false, completeDownloadWithheld: true } } }; }
