import { z } from "zod";
import { daysSince } from "./types.js";

/**
 * "Official market context" (NCSI integration) — aggregate, governorate-level statistics from
 * Oman's National Centre for Statistics and Information, kept strictly separate from
 * property-level comparable records (Section 5 of this feature's spec):
 *
 *  - PropertyMarketRepository / RentalComparable / SaleComparable (marketRepository.ts, types.ts)
 *    hold individual property records used by comparables.ts's selection/outlier/confidence
 *    engine, completely unchanged by this feature.
 *  - OfficialMarketContext (this file) holds a single governorate-level snapshot — a price index,
 *    traded value, contract counts — that is never a comparable, never enters
 *    PropertyMarketRepository, and never influences comparable selection or the comparable-side
 *    confidence score. It is additional context an agent can use however it judges appropriate.
 *
 * Every field name from a real NCSI dataset record is read through an operator-supplied
 * `NcsiFieldMap` (see getNcsiFieldMap in config.ts) rather than a hardcoded/guessed key — the live
 * catalog could not be queried during development (see ncsiClient.ts's header and this
 * capability's completion report), so no field name has been verified against real data. Until an
 * operator configures NCSI_REAL_ESTATE_DATASET_ID and NCSI_FIELD_MAP_JSON from a verified live
 * response, `OfficialOmanDataProvider.getMarketContext` always reports `available: false` — never
 * a fabricated or guessed figure.
 */

export const NCSI_SOURCE_NAME = "National Centre for Statistics and Information (NCSI)";
export const NCSI_LICENSE = "Open Government License – Sultanate of Oman";

export const ncsiFieldMapSchema = z.strictObject({
  /** Field in the raw NCSI record holding the governorate name (e.g. "Muscat"). Required — without
   *  it, records can't be matched to the property's governorate at all. */
  governorate: z.string(),
  /** Field holding the period/date the record represents (e.g. "2026 Q2", "2026-06"). Optional —
   *  reported as `period: null` when not configured or not present on a matched record. */
  period: z.string().optional(),
  /** Field holding the real estate price index value for the period. */
  priceIndexValue: z.string().optional(),
  /** Field holding the price index's own period label, if distinct from `period`. */
  priceIndexPeriod: z.string().optional(),
  /** Field holding total traded real-estate value in OMR for the period. */
  tradedValueOMR: z.string().optional(),
  /** Field holding the number of sale contracts registered for the period. */
  saleContracts: z.string().optional(),
  /** Field holding the number of mortgage contracts registered for the period. */
  mortgageContracts: z.string().optional(),
  /** Field holding this record's own publication/last-updated timestamp (ISO 8601 preferred). */
  publishedAt: z.string().optional()
});
export type NcsiFieldMap = z.infer<typeof ncsiFieldMapSchema>;

export type OfficialContextUnavailableReason =
  | "ncsi_not_configured"
  | "no_data_for_governorate"
  | "ncsi_timeout"
  | "ncsi_malformed_response"
  | "official_source_temporarily_unavailable";

export interface OfficialMarketContext {
  available: boolean;
  reason: OfficialContextUnavailableReason | null;
  source: string;
  sourceType: "official_statistics";
  governorate: string;
  period: string | null;
  realEstatePriceIndex: { value: number | null; period: string | null };
  marketActivity: {
    tradedValueOMR: number | null;
    saleContracts: number | null;
    mortgageContracts: number | null;
  };
  dataFreshnessDays: number | null;
  /** Section 9: confidence in this official aggregate context specifically — deliberately never
   *  merged into (or used to boost) the comparable-based `confidence` field elsewhere in the
   *  response. "unavailable" whenever `available` is false. */
  confidence: { level: "unavailable" | "low" | "medium" | "high"; reasons: string[] };
  provenance: {
    source: string;
    sourceType: "official_statistics";
    datasetId: string | null;
    datasetTitle: string | null;
    /** When NCSI was actually queried for this response — null only when no request was made at
     *  all (e.g. `ncsi_not_configured`, where there is nothing to timestamp). */
    retrievedAt: string | null;
    publishedAt: string | null;
    sourceUrl: string | null;
    license: string;
  };
}

/** A record is only ever treated as "fresh enough for high confidence" up to this many days old;
 *  beyond it (but still present), confidence is "medium" rather than "high" — mirrors the spirit
 *  of OMAN_MARKET_STALE_DAYS without literally reusing the comparable-side threshold, since
 *  official statistics are published on a much slower cadence (quarterly/annual) than listings. */
const OFFICIAL_CONTEXT_HIGH_CONFIDENCE_DAYS = 400;

export function unavailableOfficialContext(governorate: string, reason: OfficialContextUnavailableReason, retrievedAt: string | null = null): OfficialMarketContext {
  return {
    available: false,
    reason,
    source: NCSI_SOURCE_NAME,
    sourceType: "official_statistics",
    governorate,
    period: null,
    realEstatePriceIndex: { value: null, period: null },
    marketActivity: { tradedValueOMR: null, saleContracts: null, mortgageContracts: null },
    dataFreshnessDays: null,
    confidence: { level: "unavailable", reasons: [unavailableReasonText(reason)] },
    provenance: {
      source: NCSI_SOURCE_NAME, sourceType: "official_statistics",
      datasetId: null, datasetTitle: null, retrievedAt, publishedAt: null, sourceUrl: null, license: NCSI_LICENSE
    }
  };
}

function unavailableReasonText(reason: OfficialContextUnavailableReason): string {
  switch (reason) {
    case "ncsi_not_configured": return "No verified NCSI dataset/field mapping is configured for this deployment.";
    case "no_data_for_governorate": return "The configured NCSI dataset returned no record for this governorate.";
    case "ncsi_timeout": return "The NCSI API did not respond within the configured timeout.";
    case "ncsi_malformed_response": return "The NCSI API returned a response this client could not parse.";
    case "official_source_temporarily_unavailable": return "The NCSI API was temporarily unavailable.";
  }
}

/** Reads a numeric field out of a raw NCSI record via the configured field map, tolerating string
 *  numbers (many open-data APIs serialize numbers as strings) and returning null for anything
 *  absent, non-numeric, or not configured — never a guessed/default figure. */
function readNumber(record: Record<string, unknown>, field: string | undefined): number | null {
  if (!field) return null;
  const raw = record[field];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) return Number(raw);
  return null;
}

function readString(record: Record<string, unknown>, field: string | undefined): string | null {
  if (!field) return null;
  const raw = record[field];
  return typeof raw === "string" && raw.trim() !== "" ? raw : null;
}

export interface MapNcsiRecordMeta {
  datasetId: string;
  datasetTitle: string | null;
  retrievedAt: string;
  sourceUrl: string | null;
}

/** Maps one raw NCSI record (already matched to the requested governorate — see
 *  OfficialOmanDataProvider.getMarketContext) into the response shape, via the operator-supplied
 *  field map. Every field not present in the map, or not present/parseable on the record itself,
 *  is reported as null rather than guessed — "Only populate fields actually supported by
 *  retrieved data" (Section 4 of this feature's spec). */
export function mapNcsiRecordToContext(record: Record<string, unknown>, fieldMap: NcsiFieldMap, governorate: string, meta: MapNcsiRecordMeta): OfficialMarketContext {
  const period = readString(record, fieldMap.period);
  const publishedAt = readString(record, fieldMap.publishedAt);
  const dataFreshnessDays = publishedAt && !Number.isNaN(Date.parse(publishedAt)) ? daysSince(publishedAt) : null;

  const confidence = dataFreshnessDays === null
    ? { level: "low" as const, reasons: ["This record's publication date could not be determined; freshness cannot be assessed."] }
    : dataFreshnessDays <= OFFICIAL_CONTEXT_HIGH_CONFIDENCE_DAYS
      ? { level: "high" as const, reasons: [`Official record is ${dataFreshnessDays} day(s) old, within this deployment's expected publication cadence.`] }
      : { level: "medium" as const, reasons: [`Official record is ${dataFreshnessDays} day(s) old; treat as directional context rather than current-quarter fact.`] };

  return {
    available: true,
    reason: null,
    source: NCSI_SOURCE_NAME,
    sourceType: "official_statistics",
    governorate,
    period,
    realEstatePriceIndex: {
      value: readNumber(record, fieldMap.priceIndexValue),
      period: readString(record, fieldMap.priceIndexPeriod) ?? period
    },
    marketActivity: {
      tradedValueOMR: readNumber(record, fieldMap.tradedValueOMR),
      saleContracts: readNumber(record, fieldMap.saleContracts),
      mortgageContracts: readNumber(record, fieldMap.mortgageContracts)
    },
    dataFreshnessDays,
    confidence,
    provenance: {
      source: NCSI_SOURCE_NAME, sourceType: "official_statistics",
      datasetId: meta.datasetId, datasetTitle: meta.datasetTitle, retrievedAt: meta.retrievedAt,
      publishedAt, sourceUrl: meta.sourceUrl, license: NCSI_LICENSE
    }
  };
}

/** Finds the record whose configured governorate field matches the requested governorate
 *  (case-insensitive, trimmed) among a page of raw records. Returns null when none match — the
 *  caller reports this as `no_data_for_governorate` rather than falling back to an unrelated
 *  record. */
export function findGovernorateRecord(records: readonly Record<string, unknown>[], fieldMap: NcsiFieldMap, governorate: string): Record<string, unknown> | null {
  const needle = governorate.trim().toLowerCase();
  return records.find(r => readString(r, fieldMap.governorate)?.trim().toLowerCase() === needle) ?? null;
}
