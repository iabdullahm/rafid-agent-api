import { z } from "zod";

export const bookLanguage = z.enum(["ar", "en"]).default("en");
export const omr = z.number().finite().min(0).max(1_000_000).describe("OMR; calculations use integer baisa internally");
export const percent = z.number().finite().min(0).max(100);
export const text = (min = 1, max = 2_000) => z.string().trim().min(min).max(max);
export const stringList = z.array(text(1, 500)).max(100);

export const sourceMeta = z.strictObject({
  publisher: z.literal("Creative Techno"),
  title: z.literal("كيف تبدأ مشروعك الصغير في عُمان؟"),
  edition: z.literal("2026")
});

const languageOnly = z.strictObject({ language: bookLanguage.optional() });
export const readinessInput = languageOnly.extend({ answers: z.array(z.boolean()).length(15) });
export const ideaInput = languageOnly.extend({
  problem: text().optional(), customer: text().optional(), solution: text().optional(),
  observedProblems: stringList.optional(), skills: stringList.optional(), city: text(1, 100).optional(),
  budgetOMR: omr.optional(), availableHoursPerWeek: z.number().finite().min(0).max(168).optional(),
  preferredBusinessModel: text(1, 100).optional(), paymentEvidence: stringList.optional(),
  startupDifficulty: z.enum(["low", "medium", "high"]).optional()
});
export const validationInput = languageOnly.extend({
  idea: text(), customer: text(), problem: text(), solution: text(),
  prospects: z.array(text()).min(1).max(100).optional(), paymentEvidence: stringList.optional()
});
export const customerInput = languageOnly.extend({
  business: text(), ageRange: text(1, 100).optional(), gender: text(1, 50).optional(),
  governorate: text(1, 100).optional(), city: text(1, 100).optional(), incomeLevel: text(1, 100).optional(),
  occupation: text(1, 200).optional(), need: text().optional(), problem: text().optional(),
  buyingBehavior: text().optional(), onlineChannels: stringList.optional(), triggers: stringList.optional(), objections: stringList.optional()
});
export const competitorInput = languageOnly.extend({
  competitors: z.array(z.strictObject({ name: text(1, 200), product: text().optional(), priceOMR: omr.optional(), strengths: stringList.optional(), weaknesses: stringList.optional(), complaints: stringList.optional(), positioning: text().optional() })).min(3).max(20)
});
export const modelInput = languageOnly.extend({ product: text(), customer: text(), problem: text(), value: text(), channels: stringList, pricing: text(), costs: stringList.optional(), revenue: text(), suppliersPartners: stringList.optional(), keyActivities: stringList.optional() });
export const startupCostInput = languageOnly.extend({ setupCostsOMR: omr, monthlyFixedCostsOMR: omr, initialInventoryOMR: omr, reservePercent: percent.default(10), runwayMonths: z.number().int().min(0).max(120).default(3) });
export const pricingInput = languageOnly.extend({ productCostOMR: omr, packagingOMR: omr.default(0), deliveryOMR: omr.default(0), marketingOMR: omr.default(0), commissionOMR: omr.default(0), laborOMR: omr.default(0), otherVariableCostsOMR: omr.default(0), desiredProfitOMR: omr.optional(), desiredMarginPercent: percent.optional(), desiredMarkupPercent: percent.optional() }).refine(v => v.desiredProfitOMR !== undefined || v.desiredMarginPercent !== undefined || v.desiredMarkupPercent !== undefined, "Provide one target: desiredProfitOMR, desiredMarginPercent or desiredMarkupPercent");
export const breakEvenInput = languageOnly.extend({ sellingPriceOMR: omr, variableCostPerUnitOMR: omr, monthlyFixedCostsOMR: omr, targetProfitOMR: omr.default(0) });
export const profitabilityInput = languageOnly.extend({ unitsSold: z.number().finite().min(0), sellingPriceOMR: omr, variableCostPerUnitOMR: omr, monthlyFixedCostsOMR: omr, marketingOMR: omr.default(0), otherExpensesOMR: omr.default(0), priorRevenueOMR: omr.optional() });
export const offerInput = languageOnly.extend({ product: text(), customer: text(), coreOutcome: text(), bundle: stringList.optional(), bonuses: stringList.optional(), guarantee: text().optional(), deliveryPromise: text(), priceOMR: omr, genuineScarcity: text().optional() });
export const goToMarketInput = languageOnly.extend({ business: text(), customer: text(), problem: text(), offer: text(), channels: z.array(z.enum(["instagram", "tiktok", "whatsapp_business", "google_maps", "content", "short_video", "influencers", "partnerships", "referrals", "events", "paid_ads"])).min(1).max(11), availableBudgetOMR: omr.optional() });
export const contentInput = languageOnly.extend({ business: text(), icp: text(), channels: stringList, postingFrequencyPerWeek: z.number().int().min(1).max(30), offer: text(), days: z.union([z.literal(14), z.literal(30)]).default(14) });
export const firstCustomersInput = languageOnly.extend({ business: text(), customer: text(), offer: text(), prospects: z.array(text()).min(1).max(100).optional(), priceOMR: omr.optional() });
export const salesInput = languageOnly.extend({ case: z.enum(["price_inquiry", "price_objection", "undecided", "close_sale", "post_purchase", "upsell", "complaint"]), business: text(), product: text(), customerMessage: text(), priceOMR: omr.optional() });
export const whatsappInput = languageOnly.extend({ businessName: text(), productOrService: text(), location: text(1, 100).optional(), delivery: text().optional(), paymentMethods: stringList.optional() });
export const financialReportInput = languageOnly.extend({ revenueOMR: omr, directCostsOMR: omr, fixedCostsOMR: omr, marketingOMR: omr.default(0), otherExpensesOMR: omr.default(0), reinvestmentPercent: percent.default(20), reservePercent: percent.default(10), priorRevenueOMR: omr.optional() });
export const riskInput = languageOnly.extend({ business: text(), signals: z.record(z.string(), z.union([z.boolean(), text(), z.number().finite()])).default({}) });
export const finalPlanInput = languageOnly.extend({ businessName: text(), idea: text(), customer: text(), problem: text(), product: text(), competitors: stringList.optional(), differentiation: text(), sellingPriceOMR: omr, unitCostOMR: omr, startupCapitalOMR: omr, monthlySalesTarget: z.number().int().min(0), breakEvenUnits: z.number().int().min(0), profitGoalOMR: omr, marketingChannels: stringList, salesChannels: stringList, immediateNextStep: text() });
export const launchAdvisorInput = languageOnly.extend({ business: text(), idea: text(), customer: text(), problem: text(), solution: text(), answers: z.array(z.boolean()).length(15), setupCostsOMR: omr, monthlyFixedCostsOMR: omr, initialInventoryOMR: omr, sellingPriceOMR: omr, variableCostPerUnitOMR: omr, targetProfitOMR: omr.default(0), offer: text().optional() });
export const planGeneratorInput = launchAdvisorInput.extend({ businessName: text().optional(), channels: stringList.default(["instagram", "whatsapp_business"]) });
export const guideInput = languageOnly.extend({ question: text() });

export const bookOutput = z.strictObject({
  frameworkSource: sourceMeta,
  language: z.enum(["ar", "en"]),
  result: z.record(z.string(), z.unknown())
});
export type BookOutput = z.infer<typeof bookOutput>;
