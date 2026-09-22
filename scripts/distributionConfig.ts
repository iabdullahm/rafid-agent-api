// The one place this project's production base URL is written for the distribution pack.
// Both scripts/generateDistributionManifest.ts and scripts/distributionCheck.ts import this
// constant from here (a side-effect-free module) rather than from each other, so importing one
// script's constant never triggers the other script's side effects (writing manifest.json).
export const PRODUCTION_BASE_URL = "https://api.rafidsystem.com";
