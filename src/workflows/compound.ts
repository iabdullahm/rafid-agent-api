import { z } from "zod";
import { omanSupplierCheckInput } from "../schemas/supplierCheckInputs.js";
import { omanSupplierCheck } from "../services/omanSupplierCheck.js";
import { companyReputationCheckInput } from "../schemas/companyReputationInputs.js";
import { businessRiskScoreInput } from "../schemas/businessRiskInputs.js";
import { companyReputationCheck } from "../services/companyReputationCheck.js";
import { businessRiskScore } from "../services/businessRiskScore.js";
import { companyDueDiligenceInput } from "../schemas/companyDueDiligenceInputs.js";
import { companyDueDiligence, previewCompanyDueDiligenceCapability } from "../services/companyDueDiligence.js";
import { omanPropertyInput } from "../schemas/omanInputs.js";
import { propertySchema, compareSchema } from "../schemas/inputs.js";
import { analyzeOmanProperty } from "../services/omanProperty.js";
import { analyzeProperty } from "../services/property.js";
import { parseCsv } from "../domain/oman/importPipeline.js";

const workflowOutput = z.strictObject({ workflow: z.string(), result: z.unknown(), limitations: z.array(z.string()) });

export const supplierDueDiligenceReportInput = omanSupplierCheckInput;
export const supplierDueDiligenceReportOutput = workflowOutput;
export async function supplierDueDiligenceReport(input: unknown) {
  const result = await omanSupplierCheck(supplierDueDiligenceReportInput.parse(input));
  return { workflow: "supplier_due_diligence_report", result, limitations: ["Screening is decision support, not KYC/AML or an automated vendor-approval decision."] };
}

export const companyRiskReportInput = companyReputationCheckInput.extend({ includeNews: z.boolean().optional(), includeDigitalSignals: z.boolean().optional() });
export const companyRiskReportOutput = workflowOutput;
export async function companyRiskReport(input: unknown) {
  const parsed = companyRiskReportInput.parse(input);
  const reputationInput = { companyName: parsed.companyName, country: parsed.country, website: parsed.website, domain: parsed.domain, registrationNumber: parsed.registrationNumber, lei: parsed.lei, legalName: parsed.legalName, city: parsed.city, industry: parsed.industry };
  const riskInput = businessRiskScoreInput.parse({ companyName: parsed.companyName, country: parsed.country, website: parsed.website, registrationNumber: parsed.registrationNumber, lei: parsed.lei, city: parsed.city, industry: parsed.industry, includeNews: parsed.includeNews, includeDigitalSignals: parsed.includeDigitalSignals });
  const [reputation, risk] = await Promise.all([companyReputationCheck(reputationInput), businessRiskScore(riskInput)]);
  return { workflow: "company_risk_report", result: { reputation, businessRisk: risk }, limitations: ["Risk signals are evidence-backed decision support, not a legal, compliance or transaction decision."] };
}


export const companyDueDiligencePackInput = companyDueDiligenceInput;
export const companyDueDiligencePackOutput = z.strictObject({
  workflow: z.literal("company_due_diligence_pack"),
  includedCapabilities: z.tuple([
    z.literal("company_due_diligence"),
    z.literal("business_risk_score"),
    z.literal("company_reputation_check")
  ]),
  company: z.object({
    name: z.string(),
    domain: z.string().nullable(),
    country: z.string().nullable(),
    registrationNumber: z.string().nullable()
  }).strict(),
  decisionSummary: z.object({
    riskScore: z.number().int().min(0).max(100).nullable(),
    riskLevel: z.enum(["low", "moderate", "high", "critical"]).nullable(),
    confidence: z.number().min(0).max(1),
    recommendation: z.string(),
    action: z.string(),
    requiresHumanReview: z.boolean()
  }).strict(),
  dueDiligence: z.unknown(),
  businessRisk: z.unknown().nullable(),
  reputation: z.unknown().nullable(),
  limitations: z.array(z.string())
}).strict();

export async function companyDueDiligencePack(input: unknown) {
  const parsed = companyDueDiligencePackInput.parse(input);
  // company_due_diligence already runs business_risk_score and company_reputation_check
  // internally against the shared provider/evidence pipeline. Reuse that single execution
  // rather than paying provider latency/cost three times.
  const dueDiligence = await companyDueDiligence(parsed) as any;
  return {
    workflow: "company_due_diligence_pack" as const,
    includedCapabilities: ["company_due_diligence", "business_risk_score", "company_reputation_check"] as const,
    company: dueDiligence.company,
    decisionSummary: {
      riskScore: dueDiligence.riskScore ?? null,
      riskLevel: dueDiligence.riskLevel ?? null,
      confidence: dueDiligence.confidence ?? 0,
      recommendation: dueDiligence.recommendation,
      action: dueDiligence.decision?.action ?? "insufficient_data",
      requiresHumanReview: Boolean(dueDiligence.decision?.requiresHumanReview)
    },
    dueDiligence,
    businessRisk: dueDiligence.businessRiskCheck?.success ? dueDiligence.businessRiskCheck.data ?? null : null,
    reputation: dueDiligence.reputationCheck?.success ? dueDiligence.reputationCheck.data ?? null : null,
    limitations: [
      "This bundle is decision support, not a legal, KYC/AML, credit or compliance determination.",
      "A clear or low-risk result is not a guarantee; provider coverage, confidence and unavailable checks must be reviewed.",
      "Potential sanctions or identity matches require source verification and human review."
    ]
  };
}

export async function previewCompanyDueDiligencePack(input: unknown) {
  const preview = await previewCompanyDueDiligenceCapability(input);
  return {
    ...preview,
    capability: "company_due_diligence_pack",
    preview: {
      ...preview.preview,
      signals: {
        ...(preview.preview?.signals ?? {}),
        includedCapabilities: ["company_due_diligence", "business_risk_score", "company_reputation_check"],
        fullBundleIncludes: ["decisionSummary", "dueDiligence", "businessRisk", "reputation"]
      }
    }
  };
}

const optionalFinancials = z.strictObject({
  propertyValue: z.number().min(0).optional(), annualRent: z.number().min(0).optional(), serviceCharge: z.number().min(0).optional(),
  maintenanceCost: z.number().min(0).optional(), maintenance: z.number().min(0).optional(), vacancyRatePct: z.number().min(0).max(100).optional(), otherAnnualCosts: z.number().min(0).optional()
});
export const propertyInvestmentReportInput = z.strictObject({ property: omanPropertyInput, financials: optionalFinancials.optional() });
export const propertyInvestmentReportOutput = workflowOutput;
export async function propertyInvestmentReport(input: unknown) {
  const parsed = propertyInvestmentReportInput.parse(input);
  const market = await analyzeOmanProperty(parsed.property);
  const estimatedRent = (market as any).market?.estimatedAnnualRentOMR ?? 0;
  const financials = propertySchema.parse({ propertyValue: parsed.property.askingPriceOMR, annualRent: parsed.financials?.annualRent ?? estimatedRent, serviceCharge: parsed.financials?.serviceCharge, maintenanceCost: parsed.financials?.maintenanceCost, vacancyRatePct: parsed.financials?.vacancyRatePct, otherAnnualCosts: parsed.financials?.otherAnnualCosts });
  const investment = await analyzeProperty(financials);
  return { workflow: "property_investment_report", result: { market, investment }, limitations: ["Market data coverage, freshness and provenance remain those reported by analyze_oman_property.", "Investment calculations are estimates and not investment advice."] };
}

const portfolioBatchProperties = z.array(propertySchema.safeExtend({ name: z.string().trim().min(1).max(120) })).min(2).max(100);
export const portfolioScreenInput = z.strictObject({ properties: portfolioBatchProperties });
export const portfolioScreenOutput = workflowOutput;
export async function portfolioScreen(input: unknown) {
  const parsed = portfolioScreenInput.parse(input);
  const results = parsed.properties.map(({ name, ...property }) => ({ name, ...analyzeProperty(property) }));
  const result = { properties: results, sortedByNetYield: [...results].sort((a, b) => b.netYield - a.netYield).map(p => p.name) };
  return { workflow: "portfolio_screen", result, limitations: ["This screen compares supplied properties; it does not verify ownership, financing, taxes or transaction costs."] };
}

export const procurementVendorShortlistInput = z.strictObject({ suppliers: z.array(omanSupplierCheckInput).min(2).max(100).optional(), csv: z.string().trim().min(1).max(2_000_000).optional(), maxResults: z.number().int().min(1).max(100).optional() }).refine(v => Boolean(v.suppliers || v.csv), "Supply suppliers or csv");
export const procurementVendorShortlistOutput = workflowOutput;
export async function procurementVendorShortlist(input: unknown) {
  const parsed = procurementVendorShortlistInput.parse(input);
  const csvSuppliers = parsed.csv ? parseCsv(parsed.csv).map(row => ({ companyName: row.companyName ?? row.company_name ?? "", crNumber: row.crNumber || row.cr_number, website: row.website, email: row.email, phone: row.phone, address: row.address, requiredProductOrService: row.requiredProductOrService || row.required_product_or_service })) : [];
  const suppliers = [...(parsed.suppliers ?? []), ...csvSuppliers];
  if (suppliers.length < 2 || suppliers.length > 100) throw new Error("supplier batch must contain 2 to 100 rows");
  const screened = await runLimited(suppliers, supplier => omanSupplierCheck(omanSupplierCheckInput.parse(supplier)), 8);
  const ranked = screened.map((result, index) => ({ inputIndex: index, result, riskScore: (result as any).screeningResult?.riskScore ?? 100, procurementSuitability: (result as any).screeningResult?.procurementSuitability ?? "manual_review" }))
    .sort((a, b) => a.riskScore - b.riskScore).slice(0, parsed.maxResults ?? suppliers.length);
  return { workflow: "procurement_vendor_shortlist", result: { vendors: ranked, screenedCount: screened.length }, limitations: ["Ranking is decision support; procurement agents must review evidence, conflicts and unavailable checks before selecting a vendor."] };
}

export const companyRiskBatchInput = z.strictObject({ companies: z.array(companyRiskReportInput).min(1).max(100).optional(), csv: z.string().trim().min(1).max(2_000_000).optional() }).refine(v => Boolean(v.companies || v.csv), "Supply companies or csv");
export const companyRiskBatchOutput = workflowOutput;
export async function companyRiskBatch(input: unknown) {
  const parsed = companyRiskBatchInput.parse(input);
  const csvCompanies = parsed.csv ? parseCsv(parsed.csv).map(row => ({ companyName: row.companyName ?? row.company_name ?? "", country: row.country, website: row.website, registrationNumber: row.registrationNumber || row.registration_number, industry: row.industry })) : [];
  const companies = [...(parsed.companies ?? []), ...csvCompanies];
  if (companies.length < 1 || companies.length > 100) throw new Error("company batch must contain 1 to 100 rows");
  const results = await runLimited(companies, async company => {
    try { return { ok: true as const, result: await companyRiskReport(company) }; }
    catch (error) { return { ok: false as const, error: error instanceof Error ? error.message : "company assessment failed" }; }
  }, 6);
  return { workflow: "company_risk_batch", result: { rows: results, processedCount: results.length, successfulCount: results.filter(r => r.ok).length }, limitations: ["Batch results preserve per-row provider failures and do not make automated approval or rejection decisions."] };
}

async function runLimited<T, R>(items: readonly T[], fn: (item: T, index: number) => Promise<R>, concurrency: number): Promise<R[]> {
  const output = new Array<R>(items.length); let next = 0;
  async function worker() { while (true) { const index = next++; if (index >= items.length) return; output[index] = await fn(items[index]!, index); } }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return output;
}
