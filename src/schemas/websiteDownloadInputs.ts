import { z } from "zod";

export const websiteDownloadInput = z.strictObject({
  url: z.string().trim().min(1).max(2048),
  maxDepth: z.number().int().min(0).max(10).default(3),
  includeAssets: z.boolean().default(true),
  convertLinks: z.boolean().default(true),
  adjustExtensions: z.boolean().default(true),
  sameDomainOnly: z.boolean().default(true),
  maxSizeMb: z.number().int().min(1).max(1024).default(100),
  maxFiles: z.number().int().min(1).max(10000).default(2000),
  timeoutSeconds: z.number().int().min(5).max(900).default(120),
  output: z.enum(["manifest", "archive", "archive_and_manifest"]).default("archive_and_manifest")
});

export type WebsiteDownloadInput = z.infer<typeof websiteDownloadInput>;
