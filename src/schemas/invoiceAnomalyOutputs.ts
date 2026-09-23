import { z } from "zod";
import { ANOMALY_CODES, SEVERITIES } from "../invoice-anomaly/types.js";

/** invoice_anomaly_check output — strongly typed and machine-readable; every score is backed by
 *  anomaly records with structured evidence and by the scoring breakdown. */
const amount = z.number().nullable();

export const invoiceAnomalyRecord = z.strictObject({
  code: z.enum(ANOMALY_CODES).describe("Stable machine code of the anomaly type."),
  severity: z.enum(SEVERITIES),
  confidence: z.number().min(0).max(1).describe("0–1 strength of the supporting evidence (not a probability of fraud)."),
  field: z.string().nullable().describe("Primary invoice field concerned (e.g. invoiceNumber, bankAccount, total), or null."),
  explanation: z.string().describe("One factual sentence, phrased as a risk indicator (never an accusation)."),
  evidence: z.record(z.string(), z.unknown()).describe("Structured, factual evidence for the finding (matched records, expected vs stated values, baselines, thresholds). Bank accounts appear only masked (****1234).")
});

export const invoiceAnomalyCheckOutput = z.strictObject({
  riskScore: z.number().int().min(0).max(100).describe("0–100, higher = more risk indicators; see scoring for the exact computation."),
  riskLevel: z.enum(["low", "medium", "high", "critical"]).describe("low 0–14, medium 15–39, high 40–64, critical 65–100."),
  decision: z.enum(["continue", "review", "hold"]).describe("Advisory only: low → continue, medium/high → review, critical → hold. Not a payment approval or rejection."),
  anomalyCount: z.number().int().min(0),
  anomalies: z.array(invoiceAnomalyRecord).describe("Most severe first. At most one record per anomaly code; sub-findings are in evidence.issues."),
  financialChecks: z.strictObject({
    subtotalValid: z.boolean().nullable().describe("Σ line totals ≈ subtotal; null when not checkable (no lines or no subtotal)."),
    taxValid: z.boolean().nullable().describe("Stated tax ≈ tax implied by the stated rate(s); null when no rate or no tax is stated."),
    totalValid: z.boolean().nullable().describe("subtotal − discount + tax + shipping ≈ total; null when not checkable."),
    lineTotalsValid: z.boolean().nullable().describe("quantity × unitPrice − discount ≈ line total for every line that states all three; null when none does."),
    computed: z.strictObject({ lineItemsSum: amount, expectedTax: amount, expectedTotal: amount, tolerance: z.number() })
  }),
  recommendedAction: z.string(),
  summary: z.string(),
  mode: z.enum(["standalone", "context_aware"]),
  contextUsed: z.strictObject({
    historicalInvoices: z.number().int(), supplierHistoryMatched: z.number().int(), paymentHistory: z.number().int(),
    supplierProfile: z.boolean(), purchaseOrder: z.boolean(), contract: z.boolean(), approvalContext: z.boolean()
  }),
  invoiceSummary: z.strictObject({
    invoiceNumber: z.string().nullable(), supplierName: z.string().nullable(), supplierId: z.string().nullable(),
    invoiceDate: z.string().nullable(), dueDate: z.string().nullable(), currency: z.string().nullable(), total: z.number(),
    lineItemCount: z.number().int(), bankAccountMasked: z.string().nullable()
  }).describe("Normalized key fields of the checked invoice (bank account masked)."),
  dataCompleteness: z.strictObject({ missingRequiredFields: z.array(z.string()), missingRecommendedFields: z.array(z.string()) }),
  scoring: z.strictObject({
    model: z.string(),
    components: z.array(z.strictObject({ code: z.string(), severity: z.string(), confidence: z.number(), basePoints: z.number(), points: z.number() })),
    lowSeverityPoints: z.number(), mediumSeverityPoints: z.number(), highSeverityPoints: z.number(),
    escalationBonus: z.number(), escalationReasons: z.array(z.string()), cappedBySeverity: z.boolean(), rawScore: z.number(),
    levelBands: z.strictObject({ low: z.string(), medium: z.string(), high: z.string(), critical: z.string() })
  }).describe("Exact score derivation: per-anomaly points = basePoints × confidence, severity-group caps, correlation bonus, severity ceiling."),
  limitations: z.array(z.string()),
  asOfDate: z.string().describe("Reference date (UTC) used for date checks."),
  checkedAt: z.string().describe("ISO timestamp of the as-of date (UTC start of day). Deliberately day-granular so identical inputs give identical output; pass options.asOfDate for full reproducibility.")
});

export type InvoiceAnomalyCheckOutput = z.infer<typeof invoiceAnomalyCheckOutput>;
