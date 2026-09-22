import { searchOmanCompany, getOmanCompanyProfile, analyzeOmanCompany, dueDiligenceOmanCompany } from "../src/services/omanBusiness.js";

async function main() {
  const search = await searchOmanCompany({ query: "Al Noor Trading" });
  const profile = await getOmanCompanyProfile({ companyId: "demo-co-1" });
  const analyze = await analyzeOmanCompany({ companyId: "demo-co-1", purpose: "supplier" });
  const dueDiligence = await dueDiligenceOmanCompany({ companyId: "demo-co-1", transactionType: "supplier_contract", transactionValueOMR: 50000 });

  console.log("=====SEARCH=====");
  console.log(JSON.stringify(search, null, 2));
  console.log("=====PROFILE=====");
  console.log(JSON.stringify(profile, null, 2));
  console.log("=====ANALYZE=====");
  console.log(JSON.stringify(analyze, null, 2));
  console.log("=====DUE_DILIGENCE=====");
  console.log(JSON.stringify(dueDiligence, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
