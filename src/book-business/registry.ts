import type { AgentCapability } from "../domain/capabilities.js";
import { z, type ZodType } from "zod";
import { bookOutput, breakEvenInput, competitorInput, contentInput, customerInput, finalPlanInput, financialReportInput, firstCustomersInput, goToMarketInput, guideInput, ideaInput, launchAdvisorInput, modelInput, offerInput, planGeneratorInput, pricingInput, profitabilityInput, readinessInput, riskInput, salesInput, startupCostInput, validationInput, whatsappInput } from "./schemas.js";
import { executeBookCapability } from "./service.js";

const SOURCE = { publisher: "Creative Techno" as const, title: "كيف تبدأ مشروعك الصغير في عُمان؟" as const, edition: "2026" as const };

type Input = ZodType;
const exampleByName: Record<string, unknown> = {
  startup_readiness_score: { answers: Array(15).fill(true) },
  business_idea_validate: { idea: "Mobile car wash", problem: "Busy owners lack time", customer: "Car owners", solution: "On-site washing", paymentEvidence: [] },
  business_idea_generator: { observedProblems: ["Slow local delivery"], skills: ["delivery"] },
  business_validation_plan: { idea: "Mobile car wash", problem: "No time", customer: "Car owners", solution: "On-site wash" },
  ideal_customer_profile: { business: "Home bakery" },
  competitor_analysis: { competitors: [{ name: "A", strengths: [], weaknesses: [] }, { name: "B", strengths: [], weaknesses: [] }, { name: "C", strengths: [], weaknesses: [] }] },
  business_model_builder: { product: "Gift boxes", customer: "Families", problem: "Need convenient gifts", value: "Curated delivery", channels: ["Instagram"], pricing: "Per box", revenue: "Direct sales" },
  startup_cost_estimate: { setupCostsOMR: 225, monthlyFixedCostsOMR: 23, initialInventoryOMR: 120, reservePercent: 10, runwayMonths: 3 },
  product_pricing_calculator: { productCostOMR: 2, packagingOMR: 0, deliveryOMR: 0, marketingOMR: 0, commissionOMR: 0, laborOMR: 0, otherVariableCostsOMR: 0, desiredMarginPercent: 40 },
  break_even_calculator: { sellingPriceOMR: 4.5, variableCostPerUnitOMR: 2, monthlyFixedCostsOMR: 23, targetProfitOMR: 0 },
  business_profitability_analysis: { unitsSold: 10, sellingPriceOMR: 4.5, variableCostPerUnitOMR: 2, monthlyFixedCostsOMR: 23, marketingOMR: 0, otherExpensesOMR: 0 },
  offer_builder: { product: "Gift box", customer: "Families", coreOutcome: "A ready gift", deliveryPromise: "Within 24 hours", priceOMR: 15 },
  oman_go_to_market_plan: { business: "Home bakery", customer: "Families", problem: "Need convenient desserts", offer: "Fresh box", channels: ["instagram", "whatsapp_business"] },
  content_plan_generator: { business: "Home bakery", icp: "Families", channels: ["Instagram"], postingFrequencyPerWeek: 3, offer: "Fresh box", days: 14 },
  first_10_customers_plan: { business: "Home bakery", customer: "Families", offer: "Fresh box" },
  sales_response_builder: { case: "price_inquiry", business: "Home bakery", product: "Fresh box", customerMessage: "How much?", priceOMR: 15 },
  whatsapp_business_setup: { businessName: "Example", productOrService: "Gift boxes" },
  monthly_business_financial_report: { revenueOMR: 500, directCostsOMR: 200, fixedCostsOMR: 100, marketingOMR: 0, otherExpensesOMR: 0, reinvestmentPercent: 20, reservePercent: 10 },
  oman_business_launch_plan: {}, business_90_day_growth_plan: {},
  business_risk_check: { business: "Example", signals: {} },
  final_business_plan_builder: { businessName: "Example", idea: "Gift boxes", customer: "Families", problem: "Gift convenience", product: "Gift box", differentiation: "Fast delivery", sellingPriceOMR: 15, unitCostOMR: 8, startupCapitalOMR: 500, monthlySalesTarget: 30, breakEvenUnits: 15, profitGoalOMR: 100, marketingChannels: ["Instagram"], salesChannels: ["WhatsApp"], immediateNextStep: "Interview 5 customers" },
  oman_business_launch_advisor: { business: "Example", idea: "Gift boxes", customer: "Families", problem: "Gift convenience", solution: "Gift box", answers: Array(15).fill(true), setupCostsOMR: 225, monthlyFixedCostsOMR: 23, initialInventoryOMR: 120, sellingPriceOMR: 15, variableCostPerUnitOMR: 8, targetProfitOMR: 0 },
  oman_business_plan_generator: { business: "Example", idea: "Gift boxes", customer: "Families", problem: "Gift convenience", solution: "Gift box", answers: Array(15).fill(true), setupCostsOMR: 225, monthlyFixedCostsOMR: 23, initialInventoryOMR: 120, sellingPriceOMR: 15, variableCostPerUnitOMR: 8, targetProfitOMR: 0, channels: ["instagram", "whatsapp_business"] },
  oman_small_business_guide: { question: "How do I calculate break even?" }
};

const entries: readonly [string, string, string, Input, number, boolean][] = [
  ["startup_readiness_score", "/book/startup-readiness-score", "Score the book's 15-question readiness assessment deterministically; does not predict business success.", readinessInput, .05, true],
  ["business_idea_validate", "/book/business-idea-validate", "Evaluate problem, customer, solution and willingness-to-pay evidence; does not independently verify live demand.", validationInput, .25, true],
  ["business_idea_generator", "/book/business-idea-generator", "Generate candidate ideas from user-observed problems and constraints; does not claim market demand.", ideaInput, .20, false],
  ["business_validation_plan", "/book/business-validation-plan", "Create the book's structured seven-day validation workflow; execution and evidence collection remain with the caller.", validationInput, .25, false],
  ["ideal_customer_profile", "/book/ideal-customer-profile", "Structure an ideal-customer profile from supplied observations; does not infer verified demographics.", customerInput, .20, false],
  ["competitor_analysis", "/book/competitor-analysis", "Compare 3-20 user-supplied competitors; does not discover or verify competitors without live evidence.", competitorInput, .30, false],
  ["business_model_builder", "/book/business-model-builder", "Build the book's ten-element one-page business map from supplied inputs.", modelInput, .25, false],
  ["startup_cost_estimate", "/book/startup-cost-estimate", "Calculate startup capital, runway and reserve in OMR using integer baisa internally.", startupCostInput, .10, true],
  ["product_pricing_calculator", "/book/product-pricing-calculator", "Calculate unit cost, price, margin and markup in OMR; does not validate market willingness to pay.", pricingInput, .10, true],
  ["break_even_calculator", "/book/break-even-calculator", "Calculate break-even and target-profit units from supplied fixed and variable costs.", breakEvenInput, .10, true],
  ["business_profitability_analysis", "/book/business-profitability-analysis", "Calculate revenue, gross profit, net profit and margins from monthly supplied data.", profitabilityInput, .15, false],
  ["offer_builder", "/book/offer-builder", "Construct a commercial offer from supplied outcome, bundle and delivery terms; never invents scarcity.", offerInput, .20, false],
  ["oman_go_to_market_plan", "/book/oman-go-to-market-plan", "Select supplied Oman-relevant channels for an ICP and create a 14-day action plan; live popularity is not checked.", goToMarketInput, .40, false],
  ["content_plan_generator", "/book/content-plan-generator", "Generate a 14- or 30-day structured content calendar from an offer and selected channels.", contentInput, .20, false],
  ["first_10_customers_plan", "/book/first-10-customers-plan", "Create a non-spammy plan for 20 prospects and the first 10 paying customers.", firstCustomersInput, .25, false],
  ["sales_response_builder", "/book/sales-response-builder", "Draft a customer-facing response for a supplied sales situation; does not send messages.", salesInput, .10, false],
  ["whatsapp_business_setup", "/book/whatsapp-business-setup", "Create Arabic/English WhatsApp Business profile, reply and order-message templates.", whatsappInput, .20, false],
  ["monthly_business_financial_report", "/book/monthly-business-financial-report", "Generate a monthly business financial report from supplied OMR figures; not accounting advice.", financialReportInput, .15, false],
  ["oman_business_launch_plan", "/book/oman-business-launch-plan", "Generate the book's 30-day launch workflow with dependencies and status placeholders.", languageOnlySchema(), .40, false],
  ["business_90_day_growth_plan", "/book/business-90-day-growth-plan", "Generate the book's three-month post-launch goals, milestones, KPIs and review gates.", languageOnlySchema(), .40, false],
  ["business_risk_check", "/book/business-risk-check", "Diagnose the book's common mistakes from supplied signals; no unsupported probabilities are assigned.", riskInput, .20, false],
  ["final_business_plan_builder", "/book/final-business-plan-builder", "Assemble the book's final project plan from supplied business and financial inputs.", finalPlanInput, .50, false],
  ["oman_business_launch_advisor", "/book/oman-business-launch-advisor", "Combine readiness, idea validation, finance and launch logic for an Oman-oriented founder workflow.", launchAdvisorInput, .50, false],
  ["oman_business_plan_generator", "/book/oman-business-plan-generator", "Generate a premium structured business plan from supplied assumptions; not legal, tax, accounting or investment advice.", planGeneratorInput, 1.00, false],
  ["oman_small_business_guide", "/book/oman-small-business-guide", "Answer a question using book-grounded frameworks; current legal, tax and regulatory details require official verification.", guideInput, .15, false]
];

function languageOnlySchema(): Input { return z.strictObject({ language: z.enum(["ar", "en"]).default("en").optional() }); }
function preview(name: string, schema: Input) { return async (raw: unknown) => { schema.parse(raw); return { capability: name, status: "available" as const, inputRecognized: true, preview: { availableSections: ["structured_result", "frameworkSource"], signals: { bookFramework: true, liveMarketResearch: false } } }; }; }

export const bookCapabilities: readonly AgentCapability[] = entries.map(([name, path, description, input, price, previewable]) => ({
  name, path, description, whenToUse: `Use when an agent needs the Creative Techno book framework for ${name.replaceAll("_", " ")}.`, useCases: [name.replaceAll("_", " "), "small business planning", "Oman entrepreneurship"], input, output: bookOutput,
  example: exampleByName[name] ?? {}, exampleOutput: { frameworkSource: { ...SOURCE }, language: "en", result: { sourceChapter: "book" } },
  execute: (raw: unknown) => executeBookCapability(name, raw), price, currency: "USD", paymentProtocol: "x402", idempotent: true, sideEffects: false,
  category: "book_business", limitations: ["Framework output is based on supplied inputs and the attached book.", "No live market demand, legal, tax or regulatory fact is silently inferred."],
  ...(previewable ? { preview: preview(name, input) } : {})
} satisfies AgentCapability));
