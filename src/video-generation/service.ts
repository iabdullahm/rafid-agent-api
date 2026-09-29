import { z } from "zod";
import { ApiError } from "../utils/errors.js";
import { newsVideoGenerateInput, productPromoVideoInput, socialVideoGenerateInput, type NewsVideoGenerateInput, type ProductPromoVideoInput, type SocialVideoGenerateInput } from "../schemas/videoGenerationInputs.js";
import { HttpMoneyPrinterTurboClient, mapMoneyPrinterTurboError, type MoneyPrinterTurboClient } from "../integrations/moneyPrinterTurbo/index.js";
import type { CapabilityPreviewBody } from "../preview/types.js";

const client: MoneyPrinterTurboClient = new HttpMoneyPrinterTurboClient();

export async function generateSocialVideo(input: unknown) { return generate("social_video_generate", socialVideoGenerateInput, input, 1.5); }
export async function generateNewsVideo(input: unknown) { return generate("news_video_generate", newsVideoGenerateInput, input, 1.5); }
export async function generateProductPromoVideo(input: unknown) { return generate("product_promo_video", productPromoVideoInput, input, 2); }

async function generate<T extends z.ZodType>(capability: string, schema: T, rawInput: unknown, price: number) {
  const input = schema.parse(rawInput);
  try { return await client.generate(capability, input as never, price); }
  catch (error) { throw mapMoneyPrinterTurboError(error); }
}

export function previewSocialVideo(input: unknown): Promise<CapabilityPreviewBody> { return planningPreview("social_video_generate", socialVideoGenerateInput, input); }
export function previewNewsVideo(input: unknown): Promise<CapabilityPreviewBody> { return planningPreview("news_video_generate", newsVideoGenerateInput, input); }
export function previewProductPromoVideo(input: unknown): Promise<CapabilityPreviewBody> { return planningPreview("product_promo_video", productPromoVideoInput, input); }

async function planningPreview<T extends z.ZodType>(capability: string, schema: T, rawInput: unknown): Promise<CapabilityPreviewBody> {
  const input = schema.parse(rawInput) as SocialVideoGenerateInput | NewsVideoGenerateInput | ProductPromoVideoInput;
  const plannedScript = "topic" in input ? input.script ?? `Create a ${input.style} short-form video about ${input.topic}.` : "headline" in input ? [input.headline, input.summary, ...input.facts].join("\n") : [ (input as ProductPromoVideoInput).description, ...(input as ProductPromoVideoInput).features, (input as ProductPromoVideoInput).callToAction ].join("\n");
  return { capability, status: "available", inputRecognized: true, preview: { signals: { plannedScript, estimatedDurationSeconds: input.durationSeconds, aspectRatio: input.aspectRatio, estimatedScenes: Math.max(3, Math.ceil(input.durationSeconds / 5)), fullGenerationRequiresPayment: true } } };
}
