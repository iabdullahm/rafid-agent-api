import { EuFinancialSanctionsProvider, OpenSanctionsProvider, UnConsolidatedListProvider, UsConsolidatedScreeningListProvider, type SanctionsListProvider } from "../../shared/sanctions/listProviders.js";
import { getReputationLiveChecksEnabled } from "../config.js";
import { evidenceId } from "../deduplication.js";
import type { NormalizedEvidence, ProviderFetchResult } from "../types.js";
import { outage, type Applicability, type ProviderContext, type ReputationProvider, type ReputationQuery } from "./types.js";

/**
 * Adapts a shared sanctions-list provider (src/shared/sanctions/listProviders.ts — the same list
 * clients oman_supplier_check uses) into normalized "sanctions" evidence: one evidence item per
 * CANDIDATE list entry returned for the company's name(s). Deciding whether a candidate is a
 * possible or high-confidence match is done in analyzers/sanctionsAnalyzer.ts — never here.
 */
export class SanctionsListReputationProvider implements ReputationProvider {
  readonly category = "sanctions" as const;
  readonly retryable: boolean;
  readonly id: string;
  readonly name: string;

  constructor(private readonly list: SanctionsListProvider, private readonly enabled: () => boolean | string, retryable = true) {
    this.id = list.id;
    this.name = list.name;
    this.retryable = retryable;
  }

  applicability(): Applicability {
    const e = this.enabled();
    return e === true ? { status: "ready" } : { status: "not_configured", reason: typeof e === "string" ? e : `${this.name} is not enabled for this deployment.` };
  }

  cacheKey(q: ReputationQuery): string {
    const aliases = q.aliases && q.aliases.length > 0 ? `|aliases:${[...q.aliases].map(a => a.toUpperCase()).sort().join("|")}` : "";
    return `names:${[q.nameKey, q.legalName ?? ""].join("|")}|${q.country?.code ?? "*"}${aliases}`;
  }

  async fetch(q: ReputationQuery, ctx: ProviderContext): Promise<ProviderFetchResult> {
    const names = [...new Set([q.companyName, q.legalName, ...(q.aliases ?? [])].filter((n): n is string => Boolean(n)))];
    const evidence = new Map<string, NormalizedEvidence>();
    let requests = 0;
    for (const queriedName of names) {
      const screen = this.list instanceof OpenSanctionsProvider
        ? this.list.screenName(queriedName, ctx.now, { country: q.country?.code ?? null, registrationNumber: q.registrationNumber })
        : this.list.screenName(queriedName, ctx.now);
      const result = await screen;
      requests++;
      if (result.status === "not_configured") return { status: "not_configured", evidence: [], reason: result.reason, requests, estimatedCostUSD: 0 };
      if (result.status !== "ok") return outage(result.timedOut ? "timeout" : "unavailable", result.reason ?? `${this.name} was unavailable.`, requests);
      for (const entry of result.evidence?.candidates ?? []) {
        const recordId = `${entry.listName}|${entry.reference ?? ""}|${entry.name}`;
        const id = evidenceId(this.id, recordId);
        const existing = evidence.get(id);
        const queried = existing ? [...(existing.metadata.queriedNames as string[]), queriedName] : [queriedName];
        evidence.set(id, {
          id, type: "sanctions", providerId: this.id, sourceName: entry.listName,
          sourceUrl: entry.sourceUrl ?? result.sources[0]?.url ?? null, sourceDomain: null, sourceRecordId: entry.reference,
          sourceTier: 1, title: entry.name, summary: `Listed entry returned by ${entry.listName} for a name search. Not a match determination.`,
          publishedAt: null, observedAt: ctx.now.toISOString(), jurisdiction: null,
          companyIdentifiers: { name: entry.name, country: entry.countries?.[0] ?? null },
          quality: 1, relevance: 1,
          metadata: {
            listName: entry.listName, reference: entry.reference, aliases: entry.aliases.slice(0, 25),
            countries: entry.countries ?? [], identifiers: entry.identifiers ?? [], subjectType: entry.subjectType ?? null,
            queriedNames: [...new Set(queried)]
          }
        });
      }
    }
    return { status: "ok", evidence: [...evidence.values()], reason: null, requests, estimatedCostUSD: 0 };
  }
}

export function buildSanctionsReputationProviders(): SanctionsListReputationProvider[] {
  const live = () => (getReputationLiveChecksEnabled() ? true : "Public sanctions lists are not enabled for this deployment (RISK_LIVE_CHECKS_ENABLED).");
  const providers: SanctionsListReputationProvider[] = [
    new SanctionsListReputationProvider(new UnConsolidatedListProvider(), live),
    new SanctionsListReputationProvider(new UsConsolidatedScreeningListProvider(), live),
    new SanctionsListReputationProvider(new EuFinancialSanctionsProvider(), () => (process.env.EU_SANCTIONS_LIST_URL ? true : "EU sanctions list is not configured (EU_SANCTIONS_LIST_URL).")),
    // Paid API — never retried automatically.
    new SanctionsListReputationProvider(new OpenSanctionsProvider(), () => (process.env.OPENSANCTIONS_API_KEY ? true : "OpenSanctions is not configured (OPENSANCTIONS_API_KEY)."), false)
  ];
  return providers;
}
