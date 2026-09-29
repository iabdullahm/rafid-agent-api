import { z } from "zod";

export const videoGenerationOutput = z.strictObject({
  success: z.literal(true),
  capability: z.string(),
  task: z.object({ id: z.string(), status: z.enum(["processing", "completed"]) }),
  video: z.object({
    url: z.string().url(),
    durationSeconds: z.number().nonnegative().nullable(),
    aspectRatio: z.enum(["9:16", "16:9", "1:1"]),
    resolution: z.string().nullable()
  }),
  content: z.object({ script: z.string().nullable(), language: z.string() }),
  assets: z.object({ audioUrl: z.string().url().nullable(), subtitleUrl: z.string().url().nullable(), materialUrls: z.array(z.string().url()) }),
  metadata: z.object({ sourceUrls: z.array(z.string().url()) }).optional(),
  engine: z.object({ provider: z.literal("MoneyPrinterTurbo"), upstreamTaskId: z.string() }),
  billing: z.object({ priceUsd: z.number().positive() }),
  generatedAt: z.string().datetime()
});

export type VideoGenerationOutput = z.infer<typeof videoGenerationOutput>;
