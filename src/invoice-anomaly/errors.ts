import { ApiError } from "../utils/errors.js";

/**
 * Structured invoice_anomaly_check errors. Each is an ApiError rendered by the shared
 * publicError() on every channel (REST, x402, L402, MPP, MCP) as { code, message, details }; being
 * non-2xx, none of them settles a payment on the paid route families. Schema violations and unknown
 * fields are the shared INVALID_INPUT (400); malformed JSON is the shared INVALID_JSON (400).
 *
 *   INVALID_MONETARY_VALUE       400  an amount/quantity is not a finite number or plain decimal string
 *   INVALID_DATE                 400  a date is not a valid ISO 8601 calendar date
 *   UNSUPPORTED_CURRENCY_FORMAT  400  a currency is not a 3-letter ISO 4217-style code
 *   ANALYSIS_FAILED              500  the engine failed unexpectedly (no internal detail exposed)
 *
 * `details.path` names the offending field (e.g. "historicalInvoices.3.invoiceDate"); the offending
 * value itself is never echoed (it may be a bank or payment identifier).
 */
export const INVOICE_ANOMALY_ERROR_CODES = ["INVALID_INPUT", "INVALID_JSON", "INVALID_MONETARY_VALUE", "INVALID_DATE", "UNSUPPORTED_CURRENCY_FORMAT", "ANALYSIS_FAILED"] as const;

const NO_CHARGE = "No payment was taken.";

export const invalidMonetaryValue = (path: string) => new ApiError(400, "INVALID_MONETARY_VALUE",
  `${path} must be a finite number or a plain decimal string such as "1234.50" (no thousands separators or currency symbols). ${NO_CHARGE}`,
  { path });

export const invalidDate = (path: string) => new ApiError(400, "INVALID_DATE",
  `${path} must be a valid ISO 8601 date (YYYY-MM-DD) or date-time. ${NO_CHARGE}`, { path });

export const unsupportedCurrencyFormat = (path: string) => new ApiError(400, "UNSUPPORTED_CURRENCY_FORMAT",
  `${path} must be a 3-letter ISO 4217 currency code such as USD, EUR or OMR. ${NO_CHARGE}`, { path });

export const analysisFailed = () => new ApiError(500, "ANALYSIS_FAILED",
  `The invoice could not be analyzed due to an internal error. ${NO_CHARGE}`, { status: "analysis_failed" });
