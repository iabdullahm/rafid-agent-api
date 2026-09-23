import type { CheckStatus } from "../types.js";

/**
 * Business-activity relevance: does what the supplier publicly appears to do cover the product or
 * service the procurement agent needs?
 *
 * Deterministic keyword taxonomy (English + common Arabic terms) — no model judgment. Both the
 * required service and each piece of supplier activity evidence (registry industry/activities,
 * website title/text) are mapped onto the same categories; the decision rule is:
 *   pass    — at least one required category is found in REGISTRY activity evidence, or in
 *             website evidence corroborated by at least two distinct keyword hits.
 *   partial — the only overlap is weak (a single website mention), OR the supplier is a broad
 *             "general trading / general contracting / general maintenance" business that may
 *             plausibly supply it but doesn't evidence it specifically.
 *   fail    — the supplier has categorizable activity evidence and NONE of it overlaps the
 *             required categories (e.g. IT consulting vs. fire-alarm maintenance).
 *   unknown — the required service couldn't be categorized AND no literal term overlap exists,
 *             or there is no supplier activity evidence at all.
 */

interface Category { id: string; label: string; keywords: readonly string[]; }

export const ACTIVITY_CATEGORIES: readonly Category[] = [
  { id: "hvac", label: "HVAC / air conditioning", keywords: ["hvac", "air condition", "air-condition", "a/c", "chiller", "ventilation", "refrigeration", "cooling", "duct", "split unit", "vrf", "تكييف", "تبريد", "تهوية"] },
  { id: "fire_safety", label: "Fire safety / fire alarm", keywords: ["fire alarm", "fire fighting", "firefighting", "fire protection", "fire safety", "sprinkler", "fire suppression", "extinguisher", "smoke detector", "انذار الحريق", "إنذار الحريق", "مكافحة الحريق", "إطفاء", "اطفاء", "حريق"] },
  { id: "security_systems", label: "CCTV / security systems", keywords: ["cctv", "surveillance", "security system", "access control", "camera", "intrusion", "alarm system", "كاميرات", "مراقبة", "أنظمة أمنية", "انظمة امنية"] },
  { id: "electrical", label: "Electrical works", keywords: ["electrical", "electric", "wiring", "switchgear", "lighting", "generator", "power distribution", "كهرباء", "كهربائية", "كهربائيه"] },
  { id: "plumbing", label: "Plumbing / water", keywords: ["plumbing", "pipes", "drainage", "water treatment", "pump", "سباكة", "مياه", "صرف"] },
  { id: "it_services", label: "IT / software / consulting", keywords: ["information technology", "it services", "it consulting", "software", "it solutions", "networking", "cloud", "cybersecurity", "erp", "web development", "digital transformation", "تقنية المعلومات", "برمجيات", "حلول تقنية"] },
  { id: "construction", label: "Construction / civil works", keywords: ["construction", "civil works", "building contractor", "contracting", "fit-out", "fit out", "renovation", "concrete", "مقاولات", "بناء", "إنشاءات", "انشاءات"] },
  { id: "cleaning", label: "Cleaning / facility services", keywords: ["cleaning", "janitorial", "pest control", "housekeeping", "تنظيف", "مكافحة الحشرات"] },
  { id: "facilities_management", label: "Facilities management / general maintenance", keywords: ["facilities management", "facility management", "maintenance services", "general maintenance", "building maintenance", "mep", "صيانة عامة", "إدارة المرافق", "صيانة المباني"] },
  { id: "logistics", label: "Logistics / transport", keywords: ["logistics", "freight", "shipping", "transport", "courier", "warehousing", "cargo", "نقل", "شحن", "لوجستي"] },
  { id: "catering", label: "Catering / food supply", keywords: ["catering", "food supply", "foodstuff", "restaurant", "bakery", "تموين", "مواد غذائية"] },
  { id: "medical", label: "Medical / pharmaceutical supply", keywords: ["medical", "pharmaceutical", "pharmacy", "healthcare", "hospital supplies", "laboratory", "طبية", "أدوية", "ادوية"] },
  { id: "office_supplies", label: "Office supplies / printing / stationery", keywords: ["stationery", "office supplies", "printing", "furniture", "قرطاسية", "طباعة", "أثاث", "اثاث"] },
  { id: "industrial_supply", label: "Industrial / oil & gas / steel supply", keywords: ["oil and gas", "oilfield", "steel", "valves", "industrial supplies", "manufacturing", "fabrication", "نفط", "حديد", "صناعية"] },
  { id: "manpower", label: "Manpower / recruitment", keywords: ["manpower", "recruitment", "staffing", "outsourcing", "توظيف", "قوى عاملة"] }
];

/** Broad business descriptions that can plausibly cover many specific services without
 *  evidencing any of them — they yield "partial", never "pass" or "fail". */
const BROAD_ACTIVITY_KEYWORDS = ["general trading", "general contracting", "general maintenance", "trading", "import and export", "multi activities", "تجارة عامة", "مقاولات عامة"];

function lower(text: string): string { return text.toLowerCase(); }

export function categorize(text: string): Map<string, number> {
  const hay = lower(text);
  const hits = new Map<string, number>();
  for (const cat of ACTIVITY_CATEGORIES) {
    let count = 0;
    for (const kw of cat.keywords) {
      if (containsTerm(hay, kw)) count++;
    }
    if (count > 0) hits.set(cat.id, count);
  }
  return hits;
}

function containsTerm(hay: string, term: string): boolean {
  const t = term.toLowerCase();
  if (/[؀-ۿ]/.test(t) || t.includes(" ")) return hay.includes(t);
  return new RegExp(`(^|[^a-z0-9])${t.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}($|[^a-z0-9])`).test(hay);
}

export function categoryLabel(id: string): string {
  return ACTIVITY_CATEGORIES.find(c => c.id === id)?.label ?? id;
}

export interface ActivityAssessment {
  status: CheckStatus;
  /** true pass, false fail, null when not determinable or not requested. */
  activityMatch: boolean | null;
  requiredCategories: string[];
  supplierCategories: string[];
  explanation: string;
  evidenceBasis: ("registry" | "website")[];
}

export function assessActivity(required: string | null, registryText: string | null, websiteText: string | null): ActivityAssessment {
  if (!required) {
    return { status: "unknown", activityMatch: null, requiredCategories: [], supplierCategories: [], evidenceBasis: [], explanation: "No requiredProductOrService was supplied, so business-activity relevance was not assessed." };
  }
  const requiredCats = categorize(required);
  const registryCats = registryText ? categorize(registryText) : new Map<string, number>();
  const websiteCats = websiteText ? categorize(websiteText) : new Map<string, number>();
  const supplierCats = new Set([...registryCats.keys(), ...websiteCats.keys()]);
  const basis: ("registry" | "website")[] = [];
  if (registryText) basis.push("registry");
  if (websiteText) basis.push("website");
  const reqIds = [...requiredCats.keys()];
  const supplierIds = [...supplierCats];
  const combined = lower(`${registryText ?? ""} ${websiteText ?? ""}`);

  if (!registryText && !websiteText) {
    return { status: "unknown", activityMatch: null, requiredCategories: reqIds, supplierCategories: [], evidenceBasis: basis, explanation: "No registry activity or website content was available to compare against the requested product/service." };
  }

  if (reqIds.length === 0) {
    // Uncategorized request: fall back to a literal phrase check only.
    const literal = combined.includes(lower(required));
    return literal
      ? { status: "partial", activityMatch: null, requiredCategories: [], supplierCategories: supplierIds, evidenceBasis: basis, explanation: `The requested "${required}" is mentioned in the supplier's public information, but it could not be mapped to a known activity category for a stronger assessment.` }
      : { status: "unknown", activityMatch: null, requiredCategories: [], supplierCategories: supplierIds, evidenceBasis: basis, explanation: `The requested "${required}" could not be mapped to a known activity category and is not mentioned in the available supplier information.` };
  }

  const registryOverlap = reqIds.filter(id => registryCats.has(id));
  const websiteOverlap = reqIds.filter(id => (websiteCats.get(id) ?? 0) > 0);
  const strongWebsite = reqIds.filter(id => (websiteCats.get(id) ?? 0) >= 2 || combined.includes(lower(required)));
  const labels = (ids: readonly string[]) => ids.map(categoryLabel).join(", ");

  if (registryOverlap.length > 0 || strongWebsite.length > 0) {
    const where = registryOverlap.length > 0 ? "registry activity records" : "the supplier's website";
    return { status: "pass", activityMatch: true, requiredCategories: reqIds, supplierCategories: supplierIds, evidenceBasis: basis, explanation: `The requested ${labels(reqIds)} matches activity found in ${where}.` };
  }
  if (websiteOverlap.length > 0) {
    return { status: "partial", activityMatch: null, requiredCategories: reqIds, supplierCategories: supplierIds, evidenceBasis: basis, explanation: `The supplier's website mentions ${labels(websiteOverlap)} only briefly; relevance is plausible but weakly evidenced.` };
  }
  const broad = BROAD_ACTIVITY_KEYWORDS.some(k => combined.includes(k));
  if (broad) {
    return { status: "partial", activityMatch: null, requiredCategories: reqIds, supplierCategories: supplierIds, evidenceBasis: basis, explanation: `The supplier describes a broad activity (e.g. general trading/contracting) that may cover ${labels(reqIds)}, but no specific evidence of it was found.` };
  }
  if (supplierIds.length === 0) {
    return { status: "unknown", activityMatch: null, requiredCategories: reqIds, supplierCategories: [], evidenceBasis: basis, explanation: `The available supplier information does not describe its business activity clearly enough to compare with ${labels(reqIds)}.` };
  }
  return { status: "fail", activityMatch: false, requiredCategories: reqIds, supplierCategories: supplierIds, evidenceBasis: basis, explanation: `The supplier's publicly identified activity (${labels(supplierIds)}) does not clearly match the requested ${labels(reqIds)}.` };
}
