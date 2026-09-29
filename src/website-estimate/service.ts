import { websiteProjectEstimateInput, type WebsiteProjectEstimateInput } from "../schemas/websiteEstimateInputs.js";
import { websiteProjectEstimateOutput, type WebsiteProjectEstimateOutput } from "../schemas/websiteEstimateOutputs.js";
import type { CapabilityPreviewBody } from "../preview/types.js";

const VERSION = "website-estimate-v1";
const CURRENCY_FACTORS: Record<string, number> = { USD: 1, OMR: 0.3845, AED: 3.6725, SAR: 3.75, GBP: 0.79, EUR: 0.92 };
const MARKET_HOURLY_USD: Record<string, number> = { oman: 28, uae: 42, saudi: 35, uk: 65, us: 85, global: 40 };
const FEATURE_HOURS: Record<string, number> = { contact_form: 4, cms: 18, blog: 14, seo: 10, analytics: 4, authentication: 24, payments: 28, booking: 32, search: 18, multilingual: 12, rtl: 10, migration: 24, content_entry: 20, custom_api: 28, crm: 24, chat: 18, admin_dashboard: 30, notifications: 12, testing: 12, deployment: 8 };
const round = (n: number) => Math.round(n * 100) / 100;
const range = (min: number, max: number) => ({ min: Math.ceil(min), max: Math.ceil(max) });

function marketRate(market: string, currency: string): number {
  const key = market.toLowerCase().replace(/[^a-z]/g, "");
  const usd = MARKET_HOURLY_USD[key] ?? MARKET_HOURLY_USD.global!;
  const factor = CURRENCY_FACTORS[currency] ?? 1;
  return round(usd * factor);
}

export function calculateWebsiteProjectEstimate(raw: unknown): WebsiteProjectEstimateOutput {
  const input = websiteProjectEstimateInput.parse(raw) as WebsiteProjectEstimateInput;
  const features = new Set(input.features.map(v => v.toLowerCase().replace(/[- ]/g, "_")));
  if (input.ecommerce) { features.add("payments"); features.add("cms"); }
  if (input.languages.length > 1) features.add("multilingual");
  if (input.languages.some(v => /^(ar|arabic)$/i.test(v))) features.add("rtl");
  const designFactor = { template: 0.75, standard: 1, custom: 1.35, highly_custom: 1.8 }[input.designComplexity];
  const pageFactor = input.projectType === "web_application" || input.projectType === "marketplace" ? 2.8 : input.projectType === "ecommerce" ? 2.2 : 1.7;
  const baseUi = 10 + input.pages * pageFactor * designFactor;
  const featureHours = [...features].reduce((sum, feature) => sum + (FEATURE_HOURS[feature] ?? 8), 0);
  const uiUx = baseUi * (input.languages.length > 1 ? 1.15 : 1);
  const frontend = input.pages * (input.ecommerce || input.projectType === "web_application" ? 3.1 : 2.2) + featureHours * 0.55;
  const backend = (input.projectType === "landing_page" || input.projectType === "portfolio" ? 4 : 12) + featureHours * 0.8 + input.integrations.length * 12;
  const contentAndSeo = 4 + input.pages * 0.45 + (features.has("content_entry") ? input.pages * 0.8 : 0) + (features.has("seo") ? 8 : 0);
  const core = uiUx + frontend + backend + contentAndSeo;
  const testing = core * 0.15 + (features.has("testing") ? 12 : 0);
  const deployment = 6 + (features.has("deployment") ? 8 : 0) + (input.integrations.length ? 4 : 0);
  const projectManagement = (core + testing + deployment) * 0.12;
  const total = core + testing + deployment + projectManagement;
  const deadlineFactor = input.deadlineDays !== undefined && input.deadlineDays < Math.max(14, Math.ceil(total / 5)) ? 1.15 : 1;
  const lowHours = total * 0.85 * deadlineFactor;
  const highHours = total * 1.2 * deadlineFactor;
  const complexity = highHours > 300 || input.pages > 80 || input.integrations.length > 5 ? "very_high" : highHours > 170 || input.ecommerce || input.projectType === "web_application" ? "high" : highHours > 75 ? "medium" : "low";
  const rate = marketRate(input.market, input.currency.toUpperCase());
  const assumptions = ["Estimate is deterministic and based on the documented v1 effort weights; it is not a fixed quotation.", "Client supplies or approves copy, imagery and third-party credentials unless content_entry is requested.", "Taxes, hosting, domain fees and third-party licence charges are excluded."];
  const riskFlags: string[] = [];
  if (input.languages.length > 1) riskFlags.push("MULTILINGUAL_SCOPE");
  if (features.has("rtl")) riskFlags.push("ARABIC_RTL_SCOPE");
  if (input.integrations.length) riskFlags.push("THIRD_PARTY_INTEGRATIONS");
  if (deadlineFactor > 1) riskFlags.push("DEADLINE_PRESSURE");
  if (input.pages > 100) riskFlags.push("LARGE_PAGE_COUNT");
  const maintenanceHours = range(Math.max(2, total * 0.04), Math.max(4, total * 0.1));
  const output: WebsiteProjectEstimateOutput = {
    estimatedCost: { ...range(lowHours * rate, highHours * rate), currency: input.currency.toUpperCase() },
    estimatedTimelineDays: range(Math.max(7, lowHours / 6), Math.max(10, highHours / 5)),
    estimatedHours: range(lowHours, highHours), complexity,
    breakdown: { uiUx: range(uiUx * .85, uiUx * 1.15), frontend: range(frontend * .85, frontend * 1.2), backend: range(backend * .8, backend * 1.25), contentAndSeo: range(contentAndSeo * .8, contentAndSeo * 1.2), testing: range(testing * .8, testing * 1.25), deployment: range(deployment * .8, deployment * 1.2), projectManagement: range(projectManagement * .8, projectManagement * 1.2) },
    maintenance: { available: true, monthlyHours: maintenanceHours, monthlyCost: { min: round(maintenanceHours.min * rate), max: round(maintenanceHours.max * rate), currency: input.currency.toUpperCase() } },
    riskFlags, assumptions, confidenceScore: input.integrations.length > 4 || input.pages > 100 ? 0.68 : input.deadlineDays !== undefined && input.deadlineDays < 14 ? 0.7 : 0.84,
    methodology: { version: VERSION, hourlyRate: rate, currency: input.currency.toUpperCase(), factors: ["page count", "project type", "design complexity", "feature weights", "integration count", "language/RTL scope", "deadline pressure", "market hourly-rate profile"] }
  };
  return websiteProjectEstimateOutput.parse(output);
}

export async function websiteProjectEstimate(raw: unknown) { return calculateWebsiteProjectEstimate(raw); }

export async function previewWebsiteProjectEstimate(raw: unknown): Promise<CapabilityPreviewBody> {
  const full = calculateWebsiteProjectEstimate(raw);
  return { capability: "website_project_estimate", status: "available", inputRecognized: true, preview: { availableSections: ["complexity", "estimatedCost", "estimatedTimelineDays", "riskFlags"], dataCoverage: "high", signals: { complexity: full.complexity, broadCostMin: full.estimatedCost.min, broadCostMax: full.estimatedCost.max, broadTimelineMin: full.estimatedTimelineDays.min, broadTimelineMax: full.estimatedTimelineDays.max, majorCostDrivers: full.methodology.factors.slice(0, 3).join(", ") } } };
}
