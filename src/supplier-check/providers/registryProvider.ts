import type { CompanyDataProvider } from "../../business-data/sources/provider.js";
import type { CompanyRecord } from "../../business-data/sources/companyRepository.js";
import { rankCompanies } from "../../business-data/matching/search.js";
import { mergeCompanyRows } from "../../business-data/matching/merge.js";
import { sourceAuthority } from "../../business-data/scoring/sourceTrust.js";
import type { CompanySourceType } from "../../business-data/types.js";
import { normalizeCrNumber } from "../normalize.js";
import type { EvidenceSource, EvidenceSourceType, NormalizedSupplierInput, ProviderResult, SupplierDataProvider } from "../types.js";

/**
 * Company-identity provider backed by Rafid's EXISTING canonical Oman company registry — the same
 * CompanyDataProvider (demo / database / composite, per OMAN_BUSINESS_DATA_MODE) that
 * search_oman_company uses, the same deterministic ranking (rankCompanies) and the same
 * field-by-field merge with provenance (mergeCompanyRows). It creates no company records and no
 * second identity model: it resolves the submitted supplier to canonical companyIds and reports
 * the canonical merged view plus which sources back it.
 */

export interface RegistryCandidate {
  companyId: string;
  companyName: string;
  nameAr: string | null;
  nameEn: string | null;
  registrationNumber: string | null;
  legalType: string | null;
  status: string | null;
  industry: string | null;
  activities: string[];
  governorate: string | null;
  wilayat: string | null;
  area: string | null;
  address: string | null;
  website: string | null;
  email: string | null;
  phone: string | null;
  /** Deterministic name-match score (0-1) of this company against the SUBMITTED name — computed by
   *  the registry's own rankCompanies, best across the submitted name's variants. */
  nameScore: number;
  /** True when this company's registration number equals the submitted CR number. */
  crMatches: boolean;
  sourceTypes: CompanySourceType[];
  realSourceCount: number;
  demoOnly: boolean;
  /** Highest sourceAuthority among this company's non-demo rows (0 when demo-only). */
  maxRealAuthority: number;
  /** Sources disagree on the company's name / address (from mergeCompanyRows). */
  identityConflict: boolean;
  addressConflict: boolean;
  /** Per-source provenance. `ingestedAt` is when Rafid last imported that source's record into the
   *  registry — i.e. when that source was actually checked — used as the evidence's checkedAt. */
  provenance: { sourceName: string; sourceType: CompanySourceType; sourceUrl: string | null; observedAt: string; ingestedAt: string; fields: string[] }[];
}

export interface IdentityEvidence {
  /** Ranked candidates by nameScore (CR owner always included when found). */
  candidates: RegistryCandidate[];
  /** When a CR number was supplied: the company that registry data says owns it (or null). */
  crOwnerCompanyId: string | null;
  crSearched: boolean;
}

export interface SupplierIdentityProvider extends SupplierDataProvider {
  readonly kind: "company_registry";
  searchCompany(input: NormalizedSupplierInput, now: Date): Promise<ProviderResult<IdentityEvidence>>;
}

const MAX_CANDIDATES = 3;
const MIN_CANDIDATE_SCORE = 0.3;

function evidenceTypeFor(sourceType: CompanySourceType): EvidenceSourceType {
  if (sourceType === "demo") return "demo_dataset";
  if (sourceType === "company_website") return "company_website";
  if (sourceAuthority(sourceType) >= 0.9) return "company_registry";
  return "company_directory";
}

export class OmanRegistryIdentityProvider implements SupplierIdentityProvider {
  readonly kind = "company_registry" as const;
  readonly id = "oman_company_registry";
  readonly name: string;

  constructor(private readonly companies: CompanyDataProvider) {
    this.name = `Rafid Oman company registry — ${companies.name}`;
  }

  async searchCompany(input: NormalizedSupplierInput, now: Date): Promise<ProviderResult<IdentityEvidence>> {
    try {
      const scores = new Map<string, number>();
      for (const variant of input.nameVariants.slice(0, 4)) {
        const rows = await this.companies.search({ query: variant, candidateLimit: 200 });
        for (const match of rankCompanies(rows, { query: variant, limit: 10 })) {
          scores.set(match.record.companyId, Math.max(scores.get(match.record.companyId) ?? 0, match.confidence));
        }
      }

      let crOwnerCompanyId: string | null = null;
      if (input.crNumber) {
        const rows = await this.companies.search({ query: input.crNumber, candidateLimit: 200 });
        const owner = rows.find(r => r.registrationNumber && normalizeCrNumber(r.registrationNumber) === input.crNumber);
        crOwnerCompanyId = owner?.companyId ?? null;
      }

      const ranked = [...scores.entries()].filter(([, s]) => s >= MIN_CANDIDATE_SCORE).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const ids = ranked.slice(0, MAX_CANDIDATES).map(([id]) => id);
      if (crOwnerCompanyId && !ids.includes(crOwnerCompanyId)) ids.push(crOwnerCompanyId);

      // Registry evidence is Rafid's own imported copy of each source, so a source's checkedAt is
      // when Rafid last ingested it (not the request time) — which also makes the result for the
      // same registry state byte-identical across calls and processes (idempotency). A search
      // that matches nothing contributes no source entry; the identity check's explanation
      // attributes the "no match" finding to this provider by name.
      void now;
      const candidates: RegistryCandidate[] = [];
      const sources: EvidenceSource[] = [];
      for (const companyId of ids) {
        const rows = await this.companies.getByCompanyId(companyId);
        if (rows.length === 0) continue;
        const candidate = this.toCandidate(companyId, rows, input);
        candidates.push(candidate);
        for (const p of candidate.provenance) {
          sources.push({ type: evidenceTypeFor(p.sourceType), name: p.sourceName, url: p.sourceUrl, checkedAt: p.ingestedAt, observedAt: p.observedAt });
        }
      }
      candidates.sort((a, b) => b.nameScore - a.nameScore || Number(b.crMatches) - Number(a.crMatches) || a.companyId.localeCompare(b.companyId));
      return { status: "ok", evidence: { candidates, crOwnerCompanyId, crSearched: Boolean(input.crNumber) }, sources: dedupeSources(sources), reason: null };
    } catch {
      return { status: "unavailable", evidence: null, sources: [], reason: "The Oman company registry could not be queried." };
    }
  }

  private toCandidate(companyId: string, rows: readonly CompanyRecord[], input: NormalizedSupplierInput): RegistryCandidate {
    const merge = mergeCompanyRows(companyId, rows);
    const c = merge.company;
    let nameScore = 0;
    for (const variant of input.nameVariants.slice(0, 4)) {
      const best = rankCompanies(rows, { query: variant, limit: 1 })[0];
      if (best) nameScore = Math.max(nameScore, best.confidence);
    }
    const real = rows.filter(r => r.sourceType !== "demo");
    const realSourceKeys = new Set(real.map(r => `${r.sourceType}::${r.sourceName}`));
    return {
      companyId,
      companyName: c.companyName, nameAr: c.nameAr, nameEn: c.nameEn,
      registrationNumber: c.registrationNumber, legalType: c.legalType, status: c.status,
      industry: c.industry, activities: [...c.activities],
      governorate: c.governorate, wilayat: c.wilayat, area: c.area, address: c.address,
      website: c.website, email: c.email, phone: c.phone,
      nameScore,
      crMatches: Boolean(input.crNumber && rows.some(r => r.registrationNumber && normalizeCrNumber(r.registrationNumber) === input.crNumber)),
      sourceTypes: [...new Set(rows.map(r => r.sourceType))],
      realSourceCount: realSourceKeys.size,
      demoOnly: real.length === 0,
      maxRealAuthority: real.reduce((m, r) => Math.max(m, sourceAuthority(r.sourceType)), 0),
      identityConflict: merge.identityConflict,
      addressConflict: merge.addressConflict,
      provenance: merge.provenance.map(p => ({
        sourceName: p.sourceName, sourceType: p.sourceType, sourceUrl: p.sourceUrl, observedAt: p.observedAt,
        ingestedAt: rows.filter(r => r.sourceType === p.sourceType && r.sourceName === p.sourceName && (r.sourceRecordId ?? null) === (p.sourceRecordId ?? null))
          .reduce((latest, r) => (r.ingestedAt > latest ? r.ingestedAt : latest), p.observedAt),
        fields: [...p.fields]
      }))
    };
  }
}

export function dedupeSources(sources: readonly EvidenceSource[]): EvidenceSource[] {
  const seen = new Set<string>();
  const out: EvidenceSource[] = [];
  for (const s of sources) {
    const key = `${s.type}|${s.name}|${s.url ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}
