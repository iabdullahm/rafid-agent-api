import { ApiError } from "../../utils/errors.js";
import type { VideoGenerationOutput } from "../../schemas/videoGenerationOutputs.js";
import type { NewsVideoGenerateInput, ProductPromoVideoInput, SocialVideoGenerateInput } from "../../schemas/videoGenerationInputs.js";

export type VideoRequest = SocialVideoGenerateInput | NewsVideoGenerateInput | ProductPromoVideoInput;
export interface MoneyPrinterTurboConfig { baseUrl: string; apiKey: string; timeoutMs: number; enabled: boolean; pollIntervalMs: number; }
export interface MoneyPrinterTurboClient { generate(capability: string, input: VideoRequest, priceUsd: number, requestId?: string): Promise<VideoGenerationOutput>; }

export class MoneyPrinterTurboError extends Error {
  constructor(public readonly code: "VIDEO_ENGINE_UNAVAILABLE" | "VIDEO_GENERATION_FAILED" | "VIDEO_GENERATION_TIMEOUT" | "INVALID_VIDEO_PARAMETERS" | "UPSTREAM_TASK_FAILED", message: string) { super(message); }
}

export function loadMoneyPrinterTurboConfig(env: NodeJS.ProcessEnv = process.env): MoneyPrinterTurboConfig {
  const rawTimeout = Number(env.MPT_TIMEOUT_MS || 900000);
  const rawPoll = Number(env.MPT_POLL_INTERVAL_MS || 2000);
  return {
    baseUrl: (env.MPT_BASE_URL || "").trim().replace(/\/$/, ""),
    apiKey: (env.MPT_API_KEY || "").trim(),
    timeoutMs: Number.isFinite(rawTimeout) ? Math.min(Math.max(rawTimeout, 5000), 3_600_000) : 900000,
    pollIntervalMs: Number.isFinite(rawPoll) ? Math.min(Math.max(rawPoll, 250), 30_000) : 2000,
    enabled: env.MPT_ENABLED === "true"
  };
}

function upstreamInput(capability: string, input: VideoRequest): Record<string, unknown> {
  let subject: string;
  let script: string;
  if (capability === "social_video_generate") {
    const value = input as SocialVideoGenerateInput;
    subject = value.topic ?? "";
    script = value.script ?? "";
    return { ...baseParams(value, subject, script), video_source: value.materialSource === "auto" ? "pexels" : value.materialSource, video_script_prompt: value.style === "viral" ? "Use a concise, energetic short-form social video style." : value.style };
  }
  if (capability === "news_video_generate") {
    const value = input as NewsVideoGenerateInput;
    subject = value.headline;
    script = [value.headline, value.summary, ...value.facts].join("\n");
    return baseParams(value, subject, script);
  }
  const value = input as ProductPromoVideoInput;
  subject = value.productName;
  script = [value.description, ...value.features, `Call to action: ${value.callToAction}`, value.website ? `Website: ${value.website}` : ""].filter(Boolean).join("\n");
  return baseParams(value, subject, script);
}

function baseParams(input: { language: string; aspectRatio: string; durationSeconds: number; voice: string; subtitles: boolean; backgroundMusic: boolean }, subject: string, script: string) {
  return {
    video_subject: subject || "Short video",
    video_script: script,
    video_aspect: input.aspectRatio,
    video_clip_duration: Math.min(Math.max(Math.round(input.durationSeconds / 6), 1), 30),
    video_source: "pexels",
    video_language: input.language,
    voice_name: input.voice === "auto" ? "" : input.voice,
    bgm_type: input.backgroundMusic ? "random" : "none",
    subtitle_enabled: input.subtitles,
    match_materials_to_script: true,
    video_count: 1
  };
}

function normalizedUrl(baseUrl: string, value: unknown): string | null {
  if (typeof value !== "string" || !value || value.startsWith("file:") || value.includes("\\")) return null;
  try { return new URL(value, `${baseUrl}/`).toString(); } catch { return null; }
}

function responseData(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") throw new MoneyPrinterTurboError("VIDEO_GENERATION_FAILED", "MoneyPrinterTurbo returned an invalid response.");
  const record = body as Record<string, unknown>;
  if (record.status !== undefined && typeof record.data === "object" && record.data) return record.data as Record<string, unknown>;
  return record;
}

export class HttpMoneyPrinterTurboClient implements MoneyPrinterTurboClient {
  constructor(private readonly config: MoneyPrinterTurboConfig = loadMoneyPrinterTurboConfig(), private readonly fetchImpl: typeof fetch = fetch) {}

  async generate(capability: string, input: VideoRequest, priceUsd: number, requestId?: string): Promise<VideoGenerationOutput> {
    if (!this.config.enabled || !this.config.baseUrl) throw new MoneyPrinterTurboError("VIDEO_ENGINE_UNAVAILABLE", "Video generation is not configured.");
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.apiKey) headers["x-api-key"] = this.config.apiKey;
    if (requestId) headers["x-request-id"] = requestId;
    const deadline = Date.now() + this.config.timeoutMs;
    let taskId: string;
    try {
      const response = await this.fetchImpl(`${this.config.baseUrl}/api/v1/videos`, { method: "POST", headers, body: JSON.stringify(upstreamInput(capability, input)), signal: AbortSignal.timeout(this.config.timeoutMs) });
      if (!response.ok) throw new MoneyPrinterTurboError(response.status === 400 ? "INVALID_VIDEO_PARAMETERS" : "VIDEO_GENERATION_FAILED", "MoneyPrinterTurbo rejected the video request.");
      const data = responseData(await response.json());
      taskId = typeof data.task_id === "string" ? data.task_id : "";
      if (!taskId) throw new MoneyPrinterTurboError("VIDEO_GENERATION_FAILED", "MoneyPrinterTurbo did not return a task id.");
    } catch (error) {
      if (error instanceof MoneyPrinterTurboError) throw error;
      if (error instanceof DOMException && error.name === "TimeoutError") throw new MoneyPrinterTurboError("VIDEO_GENERATION_TIMEOUT", "Video generation timed out.");
      throw new MoneyPrinterTurboError("VIDEO_ENGINE_UNAVAILABLE", "The video engine could not be reached.");
    }
    while (Date.now() < deadline) {
      try {
        const response = await this.fetchImpl(`${this.config.baseUrl}/api/v1/tasks/${encodeURIComponent(taskId)}`, { headers, signal: AbortSignal.timeout(Math.min(this.config.pollIntervalMs + 5000, Math.max(1000, deadline - Date.now()))) });
        if (!response.ok) throw new MoneyPrinterTurboError("VIDEO_GENERATION_FAILED", "The video engine task could not be read.");
        const task = responseData(await response.json());
        const state = Number(task.state);
        if (state === -1) throw new MoneyPrinterTurboError("UPSTREAM_TASK_FAILED", "The video engine failed to generate the video.");
        if (state === 1) return normalizeCompleted(capability, input, task, taskId, priceUsd, this.config.baseUrl);
      } catch (error) {
        if (error instanceof MoneyPrinterTurboError) throw error;
        if (error instanceof DOMException && error.name === "TimeoutError") throw new MoneyPrinterTurboError("VIDEO_GENERATION_TIMEOUT", "Video generation timed out.");
        throw new MoneyPrinterTurboError("VIDEO_GENERATION_FAILED", "The video engine task could not be read.");
      }
      await new Promise(resolve => setTimeout(resolve, this.config.pollIntervalMs));
    }
    throw new MoneyPrinterTurboError("VIDEO_GENERATION_TIMEOUT", "Video generation timed out.");
  }
}

function normalizeCompleted(capability: string, input: VideoRequest, task: Record<string, unknown>, taskId: string, priceUsd: number, baseUrl: string): VideoGenerationOutput {
  const values = (Array.isArray(task.videos) ? task.videos : Array.isArray(task.combined_videos) ? task.combined_videos : []) as unknown[];
  const url = normalizedUrl(baseUrl, values[0]);
  if (!url) throw new MoneyPrinterTurboError("VIDEO_GENERATION_FAILED", "The video engine returned no public video URL.");
  const ratio = input.aspectRatio as "9:16" | "16:9" | "1:1";
  const resolution = ratio === "9:16" ? "1080x1920" : ratio === "16:9" ? "1920x1080" : "1080x1080";
  const output: VideoGenerationOutput = { success: true, capability, task: { id: taskId, status: "completed" }, video: { url, durationSeconds: null, aspectRatio: ratio, resolution }, content: { script: "script" in input ? (input as SocialVideoGenerateInput).script : null, language: input.language }, assets: { audioUrl: null, subtitleUrl: null, materialUrls: [] }, engine: { provider: "MoneyPrinterTurbo", upstreamTaskId: taskId }, billing: { priceUsd }, generatedAt: new Date().toISOString() };
  if ("sourceUrls" in input) output.metadata = { sourceUrls: input.sourceUrls };
  return output;
}

export function mapMoneyPrinterTurboError(error: unknown): ApiError {
  if (error instanceof MoneyPrinterTurboError) {
    const status = error.code === "INVALID_VIDEO_PARAMETERS" ? 400 : error.code === "VIDEO_ENGINE_UNAVAILABLE" ? 503 : error.code === "VIDEO_GENERATION_TIMEOUT" ? 504 : 502;
    return new ApiError(status, error.code, error.message);
  }
  return new ApiError(502, "VIDEO_GENERATION_FAILED", "Video generation failed.");
}
