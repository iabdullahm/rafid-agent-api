import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { websiteDownload, configureWebsiteDownload } from "../src/website-download/service.js";
import { buildWgetArgs } from "../src/website-download/wgetRunner.js";
import { validatePublicUrl } from "../src/website-download/security.js";
import { WebsiteDownloadError } from "../src/website-download/errors.js";
import type { WebsiteDownloadStorage } from "../src/website-download/storage.js";
import type { WebsiteDownloadInput } from "../src/schemas/websiteDownloadInputs.js";

const input: WebsiteDownloadInput = { url: "https://fixture.test/", maxDepth: 2, includeAssets: true, convertLinks: true, adjustExtensions: true, sameDomainOnly: true, maxSizeMb: 10, maxFiles: 20, timeoutSeconds: 30, output: "archive_and_manifest" };

test("website download rejects unsupported protocols and private destinations", async () => {
  await assert.rejects(() => validatePublicUrl("file:///etc/passwd"), (e: unknown) => e instanceof WebsiteDownloadError && e.code === "UNSUPPORTED_PROTOCOL");
  await assert.rejects(() => validatePublicUrl("http://127.0.0.1"), (e: unknown) => e instanceof WebsiteDownloadError && e.code === "SSRF_BLOCKED");
  await assert.rejects(() => validatePublicUrl("http://169.254.169.254"), (e: unknown) => e instanceof WebsiteDownloadError && e.code === "SSRF_BLOCKED");
});

test("wget arguments are an array and never contain caller flags", () => {
  const args = buildWgetArgs(input, new URL(input.url), 10 * 1024 * 1024);
  assert.ok(args.includes("--max-redirect=0"));
  assert.ok(args.includes("--domains=fixture.test"));
  assert.equal(args.at(-1), input.url);
  assert.ok(!args.some(arg => arg.includes("&&") || arg.includes("$()")));
});

test("website download builds a manifest and zip with a mocked safe runner", async () => {
  const stored = new Map<string, Buffer>();
  const fakeStorage: WebsiteDownloadStorage = { async put(data) { const fileId = "a".repeat(36); stored.set(fileId, data); return { fileId, sizeBytes: data.length }; }, async get(fileId) { return stored.get(fileId)!; } };
  configureWebsiteDownload({
    validateUrl: async raw => new URL(raw), storage: fakeStorage,
    runner: async ({ cwd }) => { await mkdir(`${cwd}/fixture.test/assets`, { recursive: true }); await writeFile(`${cwd}/fixture.test/index.html`, "<html><body>fixture</body></html>"); await writeFile(`${cwd}/fixture.test/assets/app.js`, "console.log('ok')"); return { exitCode: 0, stderr: "", finalUrl: "https://fixture.test/" }; }
  });
  const result = await websiteDownload(input);
  assert.equal(result.success, true); assert.equal(result.totalFiles, 2); assert.equal(result.pagesDownloaded, 1); assert.equal(result.assetsDownloaded, 1); assert.equal(result.archive?.format, "zip"); assert.equal(stored.size, 1);
});

test("website download enforces file limits and cleans up through the service finally block", async () => {
  configureWebsiteDownload({ validateUrl: async raw => new URL(raw), runner: async ({ cwd }) => { await writeFile(`${cwd}/one.html`, "one"); await writeFile(`${cwd}/two.html`, "two"); return { exitCode: 0, stderr: "", finalUrl: "https://fixture.test/" }; } });
  await assert.rejects(() => websiteDownload({ ...input, output: "manifest", maxFiles: 1 }), (e: unknown) => e instanceof WebsiteDownloadError && e.code === "TOO_MANY_FILES");
});
