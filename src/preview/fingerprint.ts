import { createHash, createHmac } from "node:crypto";

/**
 * Free Preview — privacy-safe request fingerprinting.
 *
 * A "request fingerprint" identifies WHAT was asked (capability + the identity-relevant fields of
 * the input), never WHO asked or the raw content of what they sent. It is the join key for two
 * things: preview response caching (preview/cache.ts) and preview→paid conversion correlation
 * (preview/analytics.ts) — both need "is this the same logical request as an earlier one?" without
 * ever storing (or being able to reconstruct) the caller's actual input.
 *
 * Per-capability normalization picks only the fields that define the request's IDENTITY (a company
 * name, a country, a property's location/size) — never financial amounts, line items, free-text
 * document content, or other content that varies between otherwise-equivalent requests but isn't
 * part of what's being asked about. Two document-shaped capabilities (document_facts_extract,
 * invoice_anomaly_check) never have their raw document/invoice content included at all: only a
 * one-way hash of the text (never the text itself) and small structural metadata (document type,
 * whether optional context blocks were supplied, how many historical records) — see each
 * normalizer below for exactly what is and isn't included.
 *
 * The fingerprint itself is a SHA-256 (or, when PREVIEW_FINGERPRINT_SECRET is configured, an
 * HMAC-SHA256 keyed by that server-only secret) of the canonicalized normalized input — a one-way
 * digest, so even the full normalized object can never be recovered from a fingerprint, cache key,
 * or analytics row that only ever stores this string. HMAC is preferred when a secret is
 * configured because it also resists offline enumeration (trying every plausible company
 * name/country combination and comparing hashes) — plain SHA-256 of a small, guessable input space
 * doesn't. See config/env.ts's PREVIEW_FINGERPRINT_SECRET.
 */

function str(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim().toLowerCase();
  return t.length ? t : undefined;
}
function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}
function bool(v: unknown): boolean {
  return Boolean(v);
}
function count(v: unknown): number {
  return Array.isArray(v) ? v.length : 0;
}
function strArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const arr = v.map(str).filter((x): x is string => Boolean(x)).sort();
  return arr.length ? arr : undefined;
}
/** Drops undefined-valued keys so two inputs that differ only in "field omitted" vs. "field
 *  explicitly undefined" always normalize identically. */
function compact(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v;
  return out;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** Deterministic string form of a normalized value with sorted object keys, so field insertion
 *  order in a capability's normalizer below can never change the resulting fingerprint. */
function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalize(record[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

type Normalizer = (input: Record<string, unknown>) => Record<string, unknown>;

/** One normalizer per previewable capability's identity-defining input fields — see each
 *  capability's schema in src/schemas/*.ts for the full field list this deliberately narrows. */
const NORMALIZERS: Readonly<Record<string, Normalizer>> = Object.freeze({
  research_company: input => compact({ company: str(input.company), website: str(input.website), country: str(input.country) }),
  analyze_oman_property: input => compact({
    governorate: str(input.governorate), wilayat: str(input.wilayat), area: str(input.area),
    propertyType: str(input.propertyType), bedrooms: num(input.bedrooms), sizeSqm: num(input.sizeSqm)
  }),
  oman_supplier_check: input => compact({ companyName: str(input.companyName), crNumber: str(input.crNumber), website: str(input.website), email: str(input.email) }),
  company_reputation_check: input => compact({
    companyName: str(input.companyName), country: str(input.country), website: str(input.website),
    domain: str(input.domain), registrationNumber: str(input.registrationNumber), lei: str(input.lei)
  }),
  business_risk_score: input => compact({
    companyName: str(input.companyName), country: str(input.country), registrationNumber: str(input.registrationNumber),
    lei: str(input.lei), website: str(input.website)
  }),
  // Document content is NEVER included — only a one-way hash of `text` (never `text` itself) and
  // small structural metadata. documentUrl is a caller-supplied pointer, not document content, so
  // it is safe to normalize directly (lowercased/trimmed like any other identifier field).
  document_facts_extract: input => compact({
    documentUrl: str(input.documentUrl),
    textHash: typeof input.text === "string" && input.text.trim() ? sha256Hex(input.text) : undefined,
    documentType: str(input.documentType), mode: str(input.mode), language: str(input.language),
    requestedFacts: strArray(input.requestedFacts)
  }),
  // Invoice line items, supplier/contract/PO details and payment history are NEVER included —
  // only a handful of coarse identity fields plus whether each optional context block was
  // supplied at all (and how large), which is enough to tell a standalone preview apart from a
  // context-aware one without fingerprinting any of that context's actual content.
  invoice_anomaly_check: input => {
    const invoice = input.invoice && typeof input.invoice === "object" ? (input.invoice as Record<string, unknown>) : {};
    return compact({
      total: num(invoice.total), currency: str(invoice.currency), invoiceNumber: str(invoice.invoiceNumber),
      supplierName: str(invoice.supplierName), supplierId: str(invoice.supplierId), poNumber: str(invoice.poNumber),
      invoiceDate: str(invoice.invoiceDate), historicalCount: count(input.historicalInvoices),
      hasSupplierProfile: bool(input.supplierProfile), hasPurchaseOrder: bool(input.purchaseOrder),
      hasContract: bool(input.contract), hasApprovalContext: bool(input.approvalContext), paymentsCount: count(input.paymentHistory)
    });
  }
});

/** True only for the capabilities this module knows how to normalize safely (the seven
 *  previewable capabilities). preview/cache.ts and preview/analytics.ts must never attempt to
 *  fingerprint/cache a capability without a defined normalizer — falling back to "fingerprint the
 *  whole raw input" would risk folding raw sensitive fields into what gets hashed for an unknown
 *  future capability's shape; simply not caching/correlating it is the safe default instead. */
export function hasFingerprintSupport(capabilityName: string): boolean {
  return capabilityName in NORMALIZERS;
}

export function normalizeForFingerprint(capabilityName: string, rawInput: unknown): Record<string, unknown> {
  const normalizer = NORMALIZERS[capabilityName];
  if (!normalizer) return {};
  const input = rawInput && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : {};
  return normalizer(input);
}

/** capability + canonicalized normalized input, hashed. Never includes raw input in the output —
 *  only this digest. See this module's doc comment for the HMAC-vs-plain-hash choice. */
export function computePreviewFingerprint(capabilityName: string, rawInput: unknown, secret: string | null): string {
  const payload = `${capabilityName}:${canonicalize(normalizeForFingerprint(capabilityName, rawInput))}`;
  return secret ? createHmac("sha256", secret).update(payload, "utf8").digest("hex") : sha256Hex(payload);
}
