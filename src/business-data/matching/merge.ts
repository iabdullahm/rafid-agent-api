import type { CompanyRecord } from "../sources/companyRepository.js";
import type { CompanyProvenanceEntry, VerificationStatus } from "../types.js";
import { sourceAuthority } from "../scoring/sourceTrust.js";
import { mergedVerificationStatus } from "../scoring/verification.js";

/**
 * Merges every contributing-source row for one companyId into a single canonical view, field by
 * field — deterministic priority order per field (a more authoritative source's value over a less
 * authoritative one, using the continuous sourceAuthority() score rather than a binary
 * authoritative/not split — Phase 2; the most recently observed value among equally-authoritative
 * rows), never an average or a guess. Also reports which fields came from which source (Section 5
 * provenance) and whether sources disagree on the company's identity (name) or address — surfaced
 * as risk flags by scoring/risk.ts, never silently resolved.
 */

const MERGED_FIELDS = [
  "companyName", "normalizedName", "nameAr", "nameEn", "registrationNumber", "legalType", "status",
  "registrationDate", "industry", "activities", "governorate", "wilayat", "area", "address",
  "website", "email", "phone", "vatNumber", "vatStatus", "employeeRange", "estimatedCompanySize",
  // Phase 6/5: procurement + tax snapshot fields merge exactly like every other field — the most
  // authoritative/most recent contributing row wins.
  "registeredSupplier", "supplierCategory", "supplierClassification", "governmentProcurementPresence",
  "tendersParticipated", "awardedContractCount", "lastTenderActivityAt",
  "taxVerificationStatus", "taxVerifiedAt"
] as const satisfies readonly (keyof CompanyRecord)[];

export type MergedCompanyFields = Pick<CompanyRecord, (typeof MERGED_FIELDS)[number]> & { companyId: string };

export interface MergeResult {
  company: MergedCompanyFields;
  provenance: CompanyProvenanceEntry[];
  /** True when contributing sources report different companyName values for the same companyId —
   *  Section 7's "conflicting identity information" risk indicator. */
  identityConflict: boolean;
  /** True when contributing sources report different non-null address values. */
  addressConflict: boolean;
  /** Phase 3/9: the company-level verification status — "conflicting" when identity or address
   *  disagree across sources, otherwise the best individual contributing row's status. */
  verificationStatus: VerificationStatus;
}

function priority(row: CompanyRecord): [number, string] {
  return [sourceAuthority(row.sourceType), row.observedAt];
}

export function mergeCompanyRows(companyId: string, rows: readonly CompanyRecord[]): MergeResult {
  const ordered = [...rows].sort((a, b) => {
    const [aAuth, aDate] = priority(a);
    const [bAuth, bDate] = priority(b);
    if (aAuth !== bAuth) return bAuth - aAuth;
    return bDate.localeCompare(aDate);
  });

  const company: Record<string, unknown> = { companyId };
  const fieldSourceRow = new Map<string, CompanyRecord>();
  for (const field of MERGED_FIELDS) {
    for (const row of ordered) {
      const value = row[field];
      const isPresent = Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined;
      if (isPresent) { company[field] = value; fieldSourceRow.set(field, row); break; }
    }
    if (!(field in company)) company[field] = field === "activities" ? [] : null;
  }

  const groups = new Map<string, CompanyProvenanceEntry & { rowKey: string }>();
  for (const [field, row] of fieldSourceRow) {
    const rowKey = `${row.sourceType}::${row.sourceName}::${row.sourceRecordId ?? ""}`;
    const existing = groups.get(rowKey);
    if (existing) {
      existing.fields = [...existing.fields, field];
      if (row.observedAt > existing.observedAt) existing.observedAt = row.observedAt;
    } else {
      groups.set(rowKey, {
        rowKey, sourceName: row.sourceName, sourceType: row.sourceType,
        sourceAuthority: sourceAuthority(row.sourceType),
        sourceUrl: row.sourceUrl, sourceRecordId: row.sourceRecordId, observedAt: row.observedAt,
        verificationStatus: row.verificationStatus, fields: [field]
      });
    }
  }
  const provenance = [...groups.values()].map(({ rowKey, ...entry }) => { void rowKey; return entry; });

  const distinctNames = new Set(rows.map(r => r.companyName.trim().toLowerCase()));
  const distinctAddresses = new Set(rows.map(r => r.address?.trim().toLowerCase()).filter((v): v is string => Boolean(v)));
  const hasConflict = distinctNames.size > 1 || distinctAddresses.size > 1;

  return {
    company: company as MergedCompanyFields,
    provenance,
    identityConflict: distinctNames.size > 1,
    addressConflict: distinctAddresses.size > 1,
    verificationStatus: mergedVerificationStatus(rows.map(r => r.verificationStatus), hasConflict)
  };
}
