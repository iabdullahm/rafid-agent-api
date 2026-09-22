/**
 * Future high-value agent tools this project is architected for but has not implemented yet.
 * Each entry is metadata only — no route, no MCP registration, no schema, no price, and
 * nothing here is callable. Its only job is to let agents and integrators discover what's
 * coming (via GET /agent.json's `roadmap` field and llms.txt) without mistaking a name on a
 * list for a working endpoint. Promoting one of these to a real capability means adding a
 * full `AgentCapability` entry to src/domain/capabilities.ts — that is the only registry that
 * drives actual behavior; this file never does.
 */
export interface PlannedCapability {
  name: string;
  description: string;
  status: "planned";
}

export const plannedCapabilities: readonly PlannedCapability[] = [
  { name: "estimate_property_rent", description: "Estimate achievable market rent for a property from comparable listings.", status: "planned" },
  { name: "analyze_lease", description: "Extract and evaluate key terms, obligations and risk flags from a lease document.", status: "planned" },
  { name: "check_contract_risk", description: "Flag risky or unusual clauses in a property-related contract.", status: "planned" },
  { name: "diagnose_maintenance_issue", description: "Triage a described maintenance issue toward likely cause and urgency.", status: "planned" },
  { name: "estimate_repair_cost", description: "Estimate the cost of a specific repair, as a calibrated alternative to the general maintenance reserve heuristic.", status: "planned" },
  { name: "generate_property_report", description: "Compose a structured report document from one or more other tool results.", status: "planned" },

  // Section 20: future Oman business-intelligence capabilities. Each is designed to reuse the
  // same companyId/industry/location/provenance/risk/confidence building blocks already shipped
  // for search_oman_company/get_oman_company_profile/analyze_oman_company/due_diligence_oman_company
  // (src/business-data/) — no new schema domain, only new query/matching logic over the same
  // oman_companies data model plus a future oman_tenders table.
  { name: "search_oman_tenders", description: "Search structured Oman public/private tender opportunities by industry, location and value.", status: "planned" },
  { name: "analyze_oman_tender", description: "Deterministic structured analysis of a single tender: requirements, deadlines, eligibility signals.", status: "planned" },
  { name: "match_company_to_tender", description: "Score how well a known Oman company (by companyId) fits a given tender's stated requirements.", status: "planned" },
  { name: "discover_oman_business_opportunities", description: "Surface Oman business opportunities (tenders, partnerships, supplier gaps) matching a stated profile.", status: "planned" },
  { name: "find_oman_suppliers", description: "Find candidate Oman supplier companies for a given industry/location/capability, reusing search_oman_company's matching engine.", status: "planned" },
  { name: "compare_oman_companies", description: "Side-by-side deterministic comparison of two or more Oman companies (by companyId) across signals, risk and confidence.", status: "planned" }
];
