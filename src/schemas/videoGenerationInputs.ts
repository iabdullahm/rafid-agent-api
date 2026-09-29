import { z } from "zod";

const language = z.string().trim().min(2).max(32).default("en");
const durationSeconds = z.number().int().min(5).max(120).default(30);
const aspectRatio = z.enum(["9:16", "16:9", "1:1"]).default("9:16");
const common = {
  language,
  durationSeconds,
  aspectRatio,
  voice: z.string().trim().max(128).default("auto"),
  subtitles: z.boolean().default(true),
  backgroundMusic: z.boolean().default(true)
};

export const socialVideoGenerateInput = z.strictObject({
  topic: z.string().trim().min(1).max(500).optional(),
  script: z.string().trim().min(1).max(8000).nullable().default(null),
  platform: z.enum(["tiktok", "instagram_reels", "youtube_shorts", "generic"]).default("generic"),
  style: z.string().trim().max(120).default("viral"),
  materialSource: z.enum(["auto", "pexels", "pixabay", "coverr", "local"]).default("auto"),
  ...common
}).refine(value => Boolean(value.topic || value.script), { message: "topic or script must be supplied", path: ["topic"] });

export const newsVideoGenerateInput = z.strictObject({
  headline: z.string().trim().min(1).max(500),
  summary: z.string().trim().min(1).max(4000),
  facts: z.array(z.string().trim().min(1).max(1000)).min(1).max(20),
  sourceUrls: z.array(z.string().url().max(2048)).max(20),
  ...common
});

export const productPromoVideoInput = z.strictObject({
  productName: z.string().trim().min(1).max(300),
  description: z.string().trim().min(1).max(3000),
  features: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
  callToAction: z.string().trim().min(1).max(300),
  website: z.string().url().max(2048).optional(),
  ...common
});

export type SocialVideoGenerateInput = z.infer<typeof socialVideoGenerateInput>;
export type NewsVideoGenerateInput = z.infer<typeof newsVideoGenerateInput>;
export type ProductPromoVideoInput = z.infer<typeof productPromoVideoInput>;
