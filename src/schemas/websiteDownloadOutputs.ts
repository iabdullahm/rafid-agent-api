import { z } from "zod";

const manifestFile = z.strictObject({
  localPath: z.string(),
  type: z.enum(["html", "css", "javascript", "image", "font", "json", "document", "media", "other"]),
  contentType: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative()
});

export const websiteDownloadOutput = z.strictObject({
  success: z.literal(true),
  sourceUrl: z.string(),
  finalUrl: z.string(),
  pagesDownloaded: z.number().int().nonnegative(),
  assetsDownloaded: z.number().int().nonnegative(),
  totalFiles: z.number().int().nonnegative(),
  totalSizeBytes: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  archive: z.strictObject({ available: z.literal(true), format: z.literal("zip"), sizeBytes: z.number().int().nonnegative(), fileId: z.string(), downloadUrl: z.string() }).nullable(),
  manifest: z.strictObject({ files: z.array(manifestFile) }),
  warnings: z.array(z.string())
});

export type WebsiteDownloadOutput = z.infer<typeof websiteDownloadOutput>;
