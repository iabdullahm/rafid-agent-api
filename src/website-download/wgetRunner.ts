import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import type { WebsiteDownloadInput } from "../schemas/websiteDownloadInputs.js";
import { WebsiteDownloadError } from "./errors.js";

export interface WgetRunOptions { cwd: string; input: WebsiteDownloadInput; hostname: string; maxBytes: number; maxFiles: number; }
export interface WgetRunResult { exitCode: number; stderr: string; finalUrl: string; }
export type WgetRunner = (options: WgetRunOptions) => Promise<WgetRunResult>;

export function buildWgetArgs(input: WebsiteDownloadInput, url: URL, maxBytes: number): string[] {
  const args = ["--mirror", "--page-requisites", "--no-parent", "--level=" + input.maxDepth, "--quota=" + maxBytes, "--timeout=" + Math.ceil(input.timeoutSeconds), "--tries=1", "--max-redirect=0", "--no-if-modified-since"];
  if (input.convertLinks) args.push("--convert-links");
  if (input.adjustExtensions) args.push("--adjust-extension");
  if (input.sameDomainOnly) args.push("--domains=" + url.hostname);
  if (!input.includeAssets) args.splice(args.indexOf("--page-requisites"), 1);
  args.push(url.toString());
  return args;
}

export const runWget: WgetRunner = ({ cwd, input, hostname, maxBytes, maxFiles }) => new Promise((resolve, reject) => {
  const url = new URL(input.url);
  const child = spawn(process.platform === "win32" ? "wget.exe" : "wget", buildWgetArgs(input, url, maxBytes), { cwd, windowsHide: true });
  let stderr = ""; let tooManyFiles = false;
  let settled = false;
  const timer = setTimeout(() => { child.kill("SIGTERM"); setTimeout(() => child.kill("SIGKILL"), 1000).unref(); }, input.timeoutSeconds * 1000);
  const fileMonitor = setInterval(() => { void readdir(cwd, { recursive: true, withFileTypes: true }).then(entries => { if (entries.filter(entry => entry.isFile()).length > maxFiles) { tooManyFiles = true; child.kill("SIGTERM"); } }).catch(() => {}); }, 100);
  child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-16_000); });
  child.on("error", error => { if (settled) return; settled = true; clearTimeout(timer); clearInterval(fileMonitor); reject((error as NodeJS.ErrnoException).code === "ENOENT" ? new WebsiteDownloadError("WGET_NOT_AVAILABLE", "The downloader worker does not have wget installed.", 503) : new WebsiteDownloadError("WGET_FAILED", "The downloader process could not be started.", 503)); });
  child.on("close", code => { if (settled) return; settled = true; clearTimeout(timer); clearInterval(fileMonitor); if (tooManyFiles) return reject(new WebsiteDownloadError("TOO_MANY_FILES", "The website exceeded the maximum file count.")); if (code === null) return reject(new WebsiteDownloadError("DOWNLOAD_TIMEOUT", "The website download exceeded the allowed execution time.")); if (/too many redirects|redirect|location:/i.test(stderr) && code !== 0) return reject(new WebsiteDownloadError("REDIRECT_BLOCKED", "Redirects are disabled unless separately validated.")); if (code !== 0) return reject(new WebsiteDownloadError("WGET_FAILED", `The website download failed for ${hostname}.`)); resolve({ exitCode: code, stderr, finalUrl: url.toString() }); });
});
