export interface WebsiteDownloadConfig {
  maxMb: number;
  maxFiles: number;
  maxTimeoutMs: number;
  maxDepth: number;
  maxRedirects: number;
  storageDir: string;
}

const positive = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

export function getWebsiteDownloadConfig(): WebsiteDownloadConfig {
  return {
    maxMb: positive("WEBSITE_DOWNLOAD_MAX_MB", 100),
    maxFiles: positive("WEBSITE_DOWNLOAD_MAX_FILES", 2000),
    maxTimeoutMs: positive("WEBSITE_DOWNLOAD_TIMEOUT_MS", 120_000),
    maxDepth: positive("WEBSITE_DOWNLOAD_MAX_DEPTH", 3),
    maxRedirects: positive("WEBSITE_DOWNLOAD_MAX_REDIRECTS", 0),
    storageDir: process.env.WEBSITE_DOWNLOAD_STORAGE_DIR || ".data/website-downloads"
  };
}
