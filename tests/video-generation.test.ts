import assert from "node:assert/strict";
import { test } from "node:test";
import { capabilities } from "../src/domain/capabilities.js";
import { runCapabilityPreview } from "../src/preview/service.js";
import { HttpMoneyPrinterTurboClient } from "../src/integrations/moneyPrinterTurbo/index.js";

const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("video capabilities are registry-native and centrally priced", () => {
  const entries = capabilities.filter(c => ["social_video_generate", "news_video_generate", "product_promo_video"].includes(c.name));
  assert.equal(entries.length, 3);
  assert.deepEqual(Object.fromEntries(entries.map(c => [c.name, c.price])), { social_video_generate: 1.5, news_video_generate: 1.5, product_promo_video: 2 });
  assert.ok(entries.every(c => c.preview));
});

test("video preview plans without calling the upstream engine", async () => {
  const result = await runCapabilityPreview("news_video_generate", { headline: "Headline", summary: "Verified summary", facts: ["Fact"], sourceUrls: ["https://example.com/source"], language: "ar" });
  assert.equal(result.status, "available");
  assert.equal(result.fullResult.price.amount, "1.50");
  assert.equal(result.preview.signals?.fullGenerationRequiresPayment, true);
  assert.match(String(result.preview.signals?.plannedScript), /Headline/);
});

test("MoneyPrinterTurbo adapter uses POST /api/v1/videos then polls /api/v1/tasks/{id}", async () => {
  const calls: string[] = [];
  const client = new HttpMoneyPrinterTurboClient({ baseUrl: "https://mpt.example", apiKey: "secret", enabled: true, timeoutMs: 5000, pollIntervalMs: 250 }, async (url, init) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (String(url).endsWith("/videos")) return response({ status: 200, data: { task_id: "task-1" } });
    return response({ status: 200, data: { task_id: "task-1", state: 1, videos: ["/tasks/task-1/final.mp4"] } });
  });
  const result = await client.generate("news_video_generate", { headline: "Headline", summary: "Summary", facts: ["Fact"], sourceUrls: ["https://example.com/source"], language: "en", durationSeconds: 30, aspectRatio: "9:16", voice: "auto", subtitles: true, backgroundMusic: true }, 1.5);
  assert.equal(result.video.url, "https://mpt.example/tasks/task-1/final.mp4");
  assert.deepEqual(result.metadata, { sourceUrls: ["https://example.com/source"] });
  assert.deepEqual(calls, ["POST https://mpt.example/api/v1/videos", "GET https://mpt.example/api/v1/tasks/task-1"]);
});

test("MoneyPrinterTurbo adapter normalizes upstream failures without leaking details", async () => {
  const client = new HttpMoneyPrinterTurboClient({ baseUrl: "https://mpt.example", apiKey: "secret", enabled: true, timeoutMs: 5000, pollIntervalMs: 250 }, async url => String(url).endsWith("/videos") ? response({ status: 200, data: { task_id: "task-1" } }) : response({ status: 200, data: { task_id: "task-1", state: -1, error: "private stack trace" } }));
  await assert.rejects(() => client.generate("social_video_generate", { topic: "Topic", script: null, platform: "tiktok", style: "viral", materialSource: "auto", language: "en", durationSeconds: 30, aspectRatio: "9:16", voice: "auto", subtitles: true, backgroundMusic: true }, 1.5), /failed to generate/i);
});
