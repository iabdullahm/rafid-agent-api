/**
 * invoice_anomaly_check — every threshold, weight and limit in one place, each with the
 * assumption behind it. The engine is deterministic: identical input (with options.asOfDate
 * supplied) always yields identical output. Callers can override the most context-dependent
 * thresholds per request via `options` (roundingTolerance, duplicateWindowDays,
 * minHistoryForPatterns) and `approvalContext.splitWindowDays`.
 */

export const INVOICE_ANOMALY_LIMITS = {
  maxLineItems: 500,
  maxHistoricalInvoices: 1000,
  maxHistoricalLineItems: 200,
  maxPayments: 1000,
  /** JSON body limit for this capability's routes: 1000 historical invoices fit comfortably. */
  requestBodyLimit: "1mb",
  defaultDuplicateWindowDays: 14,
  defaultSplitWindowDays: 7,
  defaultMinHistory: 3
} as const;

export const SCORING_MODEL_VERSION = "iac-1.0.0";

export const THRESHOLDS = {
  // ---- arithmetic -------------------------------------------------------------------------
  /** Rounding tolerance is expressed in currency minor units (0.01 USD, 0.001 OMR, 1 JPY). Each
   *  rounded line can differ by up to half a minor unit, so a sum of N lines is allowed
   *  ceil(N/2) minor units (never less than 1); a single product or total is allowed 1. */
  perLineRoundingMinorUnits: 0.5,
  /** Arithmetic materiality: difference as a share of the reference amount. ≤ 0.5% → low,
   *  above → medium. Arithmetic errors never exceed medium on their own (they are usually
   *  clerical); correlation with other anomalies raises the overall score instead. */
  arithmeticMediumPct: 0.5,

  // ---- duplicates -------------------------------------------------------------------------
  /** Near-duplicate needs ≥ 1 corroborating signal inside the window; an uncorroborated same
   *  supplier + same amount match is only reported within this tighter window. */
  uncorroboratedDuplicateDays: 3,
  /** Line-item description similarity (token Jaccard over line sets) treated as "same goods". */
  lineSimilarityStrong: 0.9,
  /** Levenshtein similarity on the compacted invoice number treated as "similar". */
  invoiceNumberSimilar: 0.8,
  /** Trailing-number gap still considered an ordinary next-in-sequence invoice (not a variant). */
  sequentialGapMax: 20,
  /** Supplier name similarity (company-reputation's deterministic companyNameSimilarity) at which
   *  two records without ids are treated as the same supplier. */
  supplierNameMatch: 0.9,
  /** ≥ this many OTHER same-amount invoices from the supplier = a recurring fixed-fee pattern
   *  (rent, subscriptions); near-duplicate matching then requires a strong number signal. */
  recurringSameAmountMin: 2,

  // ---- supplier behavior ------------------------------------------------------------------
  /** UNUSUAL_AMOUNT: above the historical maximum AND ≥ 2× the median AND (robust z ≥ 3.5 or a
   *  zero-dispersion history). ≥ 5× median → high. Robust z uses 1.4826 × MAD (consistent with
   *  the standard deviation under normality) so a few past outliers do not mask a new one. */
  unusualAmountRatioMedium: 2,
  unusualAmountRatioHigh: 5,
  unusualAmountRobustZ: 3.5,
  /** UNUSUAL_PAYMENT_TERMS: at most half the expected terms AND at least 10 days shorter. */
  paymentTermsShorterRatio: 0.5,
  paymentTermsShorterMinDays: 10,
  /** INVOICE_NUMBER_ANOMALY: a format shared by ≥ 80% of the supplier's history is "established". */
  numberFormatDominance: 0.8,
  /** SUPPLIER_PATTERN_DEVIATION (frequency): ≥ 3 invoices in the last 30 days and ≥ 3× the
   *  supplier's prior monthly rate, measured over ≥ 90 days of prior history. */
  frequencyRecentDays: 30,
  frequencyMinRecent: 3,
  frequencyMultiple: 3,
  frequencyMinBaselineDays: 90,
  /** Supplier record created this recently before the invoice date. */
  newSupplierDays: 30,

  // ---- payment details --------------------------------------------------------------------
  /** A profile account added this recently (and never used in history) counts as a change. */
  recentAccountChangeDays: 30,

  // ---- PO / contract ----------------------------------------------------------------------
  /** Excess above remaining PO / contract balance, as % of the PO / contract value, that makes
   *  the finding high rather than medium. */
  limitExcessHighPct: 10,
  /** Unit price above PO unit price by more than this % (beyond rounding) is a mismatch. */
  poUnitPriceTolerancePct: 0.5,
  /** Description similarity for matching an invoice line to a PO line (when no SKU). */
  poLineMatchSimilarity: 0.5,

  // ---- split invoices ---------------------------------------------------------------------
  /** Pieces all ≥ 85% of the threshold look "just under" the limit. */
  splitJustUnderShare: 0.85,
  /** Repeated just-below pattern: ≥ 3 invoices in [90%, 100%] of the threshold within 90 days. */
  repeatedBelowShare: 0.9,
  repeatedBelowMinCount: 3,
  repeatedBelowWindowDays: 90,

  // ---- dates ------------------------------------------------------------------------------
  futureInvoiceToleranceDays: 1,
  staleInvoiceDays: 365,
  dueTermsToleranceDays: 3,
  maxReasonableTermsDays: 365
} as const;

/** Points an anomaly contributes at confidence 1.0, by severity; multiplied by its confidence. */
export const SEVERITY_POINTS = { info: 0, low: 5, medium: 20, high: 35, critical: 50 } as const;

/** Code-specific overrides of SEVERITY_POINTS (payment-detail changes and duplicates weigh most:
 *  they are the typical signatures of invoice-redirection fraud and duplicate payment). */
export const CODE_POINTS: Partial<Record<string, Partial<Record<keyof typeof SEVERITY_POINTS, number>>>> = {
  DUPLICATE_INVOICE: { high: 50, critical: 60 },
  POSSIBLE_DUPLICATE: { medium: 20, high: 40 },
  BANK_ACCOUNT_CHANGED: { medium: 25, high: 55, critical: 70 },
  UNKNOWN_BANK_ACCOUNT: { medium: 20, high: 40, critical: 60 },
  SPLIT_INVOICE_PATTERN: { medium: 20, high: 40 },
  MISSING_REQUIRED_FIELD: { low: 3, medium: 8 }
};

export const SCORING = {
  /** All low/info contributions together can add at most this much. */
  lowSeverityCap: 10,
  /** All medium contributions together can add at most this much. */
  mediumSeverityCap: 45,
  /** Escalation: + per additional risk family with a ≥ medium anomaly (max familyBonusMax). */
  familyBonusPerExtra: 8,
  familyBonusMax: 24,
  /** Escalation: payment-detail anomaly (≥ high) together with a duplicate, PO/contract or split
   *  anomaly (≥ medium) — the classic redirection-fraud combination. */
  paymentCorrelationBonus: 10,
  /** The overall score cannot exceed the band of the most severe anomaly's ceiling, so a pile of
   *  trivial warnings can never produce a critical result: only-low → ≤ lowMax; max medium → ≤ highMax. */
  levels: { lowMax: 14, mediumMax: 39, highMax: 64 }
} as const;

/** ISO 4217 minor-unit exponents that differ from the default of 2. */
export const MINOR_UNITS: Record<string, number> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0, UGX: 0, UYI: 0,
  VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  CLF: 4, UYW: 4
};

/** Active ISO 4217 codes (2026). A well-formed but unlisted code is reported as UNUSUAL_CURRENCY
 *  (low), never rejected. */
export const ISO_4217 = new Set(("AED AFN ALL AMD ANG AOA ARS AUD AWG AZN BAM BBD BDT BGN BHD BIF BMD BND BOB BOV BRL BSD BTN BWP BYN BZD " +
  "CAD CDF CHE CHF CHW CLF CLP CNY COP COU CRC CUP CVE CZK DJF DKK DOP DZD EGP ERN ETB EUR FJD FKP GBP GEL GHS GIP GMD GNF GTQ GYD " +
  "HKD HNL HTG HUF IDR ILS INR IQD IRR ISK JMD JOD JPY KES KGS KHR KMF KPW KRW KWD KYD KZT LAK LBP LKR LRD LSL LYD MAD MDL MGA MKD " +
  "MMK MNT MOP MRU MUR MVR MWK MXN MXV MYR MZN NAD NGN NIO NOK NPR NZD OMR PAB PEN PGK PHP PKR PLN PYG QAR RON RSD RUB RWF SAR SBD " +
  "SCR SDG SEK SGD SHP SLE SOS SRD SSP STN SVC SYP SZL THB TJS TMT TND TOP TRY TTD TWD TZS UAH UGX USD USN UYI UYU UYW UZS VED VES " +
  "VND VUV WST XAF XCD XCG XOF XPF YER ZAR ZMW ZWG").split(" "));
