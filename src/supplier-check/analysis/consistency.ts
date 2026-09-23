import { OMAN_GOVERNORATES } from "../../business-data/normalizers/location.js";
import { normalizePhone, normalizeWebsite, normalizeEmail, registrableDomain } from "../normalize.js";
import type { IdentityEvidence, RegistryCandidate } from "../providers/registryProvider.js";
import type { WebsiteEvidence } from "../providers/websiteProvider.js";
import type { AddressStatus, CheckStatus, IdentityMatchLevel, NormalizedSupplierInput, ProviderResult, SupplierRiskFlag } from "../types.js";
import { domainResemblesName, isLookalikeDomain, nameAppearsIn } from "./textMatch.js";

// =============================================================================================
// 1. Company identity
// =============================================================================================

/**
 * Identity score (0-1), computed transparently from registry evidence:
 *   name match      exact/near-exact (registry score >= 0.9) +0.40 · prefix (>= 0.75) +0.25 · fuzzy (>= 0.6) +0.10
 *   CR number       supplied CR equals the matched company's registration number        +0.30
 *   contact         each of website domain / corporate email domain / phone matching
 *                   the registry record                                                   +0.10 (max +0.20)
 *   multi-source    two or more distinct real sources back the matched company           +0.10
 * then multiplied by a SOURCE-TRUST factor, so weak sources can never produce "strong":
 *   government/registry-grade source (authority >= 0.9) ×1.00 · directory-grade (>= 0.5) ×0.85 ·
 *   other real source ×0.70 · demo dataset only ×0.30
 * and capped when evidence contradicts itself: CR conflict → max 0.30; sources disagree on the
 * company name → max 0.79.
 * Level: >= 0.80 strong · >= 0.60 moderate · >= 0.30 weak · otherwise unconfirmed.
 * identityConfirmed is true only for "strong". This is "identity appears consistent across
 * sources", never "legally verified".
 */
export interface IdentityAssessment {
  level: IdentityMatchLevel;
  score: number;
  identityConfirmed: boolean;
  status: CheckStatus;
  candidate: RegistryCandidate | null;
  crConflict: "cr_belongs_to_other_company" | "registry_cr_differs" | null;
  crOwnerName: string | null;
  corroborations: string[];
  explanation: string;
  flags: SupplierRiskFlag[];
}

export const IDENTITY_THRESHOLDS = { strong: 0.8, moderate: 0.6, weak: 0.3 } as const;
const NAME_MATCH_MIN = 0.6;

export function identityLevelFor(score: number): IdentityMatchLevel {
  if (score >= IDENTITY_THRESHOLDS.strong) return "strong";
  if (score >= IDENTITY_THRESHOLDS.moderate) return "moderate";
  if (score >= IDENTITY_THRESHOLDS.weak) return "weak";
  return "unconfirmed";
}

function domainOf(url: string | null): string | null {
  if (!url) return null;
  const w = normalizeWebsite(url);
  return w ? registrableDomain(w.domain) : null;
}

export function assessIdentity(n: NormalizedSupplierInput, result: ProviderResult<IdentityEvidence>, website: WebsiteEvidence | null, registryName = "Rafid's Oman company registry"): IdentityAssessment {
  const flags: SupplierRiskFlag[] = [];
  if (result.status !== "ok" || !result.evidence) {
    const websiteSelf = website && website.reachable && nameAppearsIn(`${website.title ?? ""} ${website.textExcerpt}`, [n.companyName]);
    const score = websiteSelf ? 0.3 : 0;
    flags.push({ code: "IDENTITY_NOT_CONFIRMED", severity: "low", message: "Company identity could not be checked against registry data because the registry source was unavailable." });
    return {
      level: identityLevelFor(score), score, identityConfirmed: false, status: "unknown", candidate: null, crConflict: null, crOwnerName: null,
      corroborations: websiteSelf ? ["company name published on its own website (self-declared)"] : [],
      explanation: "Registry evidence was unavailable for this request; identity is not confirmed." + (websiteSelf ? " The supplier's own website presents the submitted name (self-declared only)." : ""),
      flags
    };
  }

  const { candidates, crOwnerCompanyId } = result.evidence;
  const owner = crOwnerCompanyId ? candidates.find(c => c.companyId === crOwnerCompanyId) ?? null : null;
  const bestByName = candidates.find(c => c.nameScore >= NAME_MATCH_MIN) ?? null;

  let candidate: RegistryCandidate | null = null;
  let crConflict: IdentityAssessment["crConflict"] = null;
  let crOwnerName: string | null = null;
  if (owner && owner.nameScore >= NAME_MATCH_MIN) {
    candidate = owner;
  } else if (owner) {
    crConflict = "cr_belongs_to_other_company";
    crOwnerName = owner.companyName;
    candidate = bestByName && bestByName.companyId !== owner.companyId ? bestByName : null;
  } else {
    candidate = bestByName;
    if (candidate && n.crNumber && candidate.registrationNumber && !candidate.crMatches) crConflict = "registry_cr_differs";
  }

  if (crConflict === "cr_belongs_to_other_company") {
    flags.push({ code: "CR_NUMBER_CONFLICT", severity: "high", message: `Registry data records the supplied CR number under a different company name ("${crOwnerName}"), not "${n.companyName}".` });
    flags.push({ code: "COMPANY_NAME_MISMATCH", severity: "medium", message: "The submitted company name does not match the name registry data holds for the supplied CR number." });
  } else if (crConflict === "registry_cr_differs") {
    flags.push({ code: "CR_NUMBER_CONFLICT", severity: "medium", message: `The matched registry company "${candidate!.companyName}" has a different registration number from the CR number supplied.` });
  }

  if (!candidate) {
    const websiteSelf = Boolean(website && website.reachable && nameAppearsIn(`${website.title ?? ""} ${website.textExcerpt}`, [n.companyName]));
    const score = crConflict ? 0 : websiteSelf ? 0.3 : 0;
    const level = identityLevelFor(score);
    flags.push({ code: "IDENTITY_NOT_CONFIRMED", severity: crConflict ? "medium" : "low", message: "No registry record could be confidently matched to the submitted company." });
    return {
      level, score, identityConfirmed: false, status: crConflict ? "fail" : level === "weak" ? "partial" : "unknown",
      candidate: null, crConflict, crOwnerName,
      corroborations: websiteSelf ? ["company name published on its own website (self-declared)"] : [],
      explanation: crConflict
        ? "The supplied CR number belongs to a different company in registry data and no registry record matches the submitted name."
        : websiteSelf
          ? "No registry match was found; the only identity evidence is the supplier's own website presenting the submitted name (self-declared)."
          : `No record in ${registryName} matched the submitted company name` + (n.crNumber ? " or CR number" : "") + ". This is not evidence that the company does not exist — registry coverage is incomplete.",
      flags
    };
  }

  // --- Score the matched candidate --------------------------------------------------------
  const corroborations: string[] = [];
  let score = candidate.nameScore >= 0.9 ? 0.4 : candidate.nameScore >= 0.75 ? 0.25 : 0.1;
  if (candidate.crMatches) { score += 0.3; corroborations.push("CR number matches registry"); }
  const registryDomains = new Set([domainOf(candidate.website), candidate.email ? (() => { const e = normalizeEmail(candidate.email!); return e && !e.free ? registrableDomain(e.domain) : null; })() : null].filter((d): d is string => Boolean(d)));
  let contactPoints = 0;
  const suppliedSiteDomain = n.websiteDomain ? registrableDomain(n.websiteDomain) : null;
  if (suppliedSiteDomain && registryDomains.has(suppliedSiteDomain)) { contactPoints += 0.1; corroborations.push("website domain matches registry"); }
  if (n.emailDomain && !n.freeEmailProvider && registryDomains.has(registrableDomain(n.emailDomain))) { contactPoints += 0.1; corroborations.push("email domain matches registry"); }
  if (n.phone?.isOman && candidate.phone && normalizePhone(candidate.phone).digits === n.phone.digits) { contactPoints += 0.1; corroborations.push("phone matches registry"); }
  score += Math.min(0.2, contactPoints);
  if (candidate.realSourceCount >= 2) { score += 0.1; corroborations.push(`${candidate.realSourceCount} independent real sources`); }

  const trust = candidate.demoOnly ? 0.3 : candidate.maxRealAuthority >= 0.9 ? 1 : candidate.maxRealAuthority >= 0.5 ? 0.85 : 0.7;
  score *= trust;
  if (crConflict) score = Math.min(score, 0.3);
  if (candidate.identityConflict) {
    score = Math.min(score, 0.79);
    flags.push({ code: "REGISTRY_IDENTITY_CONFLICT", severity: "low", message: "Registry sources for the matched company record the company name differently; identity should be confirmed from the commercial registration certificate." });
  }
  score = Math.round(Math.min(1, score) * 100) / 100;
  const level = identityLevelFor(score);

  if (candidate.demoOnly) flags.push({ code: "DEMO_DATA_ONLY", severity: "low", message: "The only registry evidence for this company is Rafid's illustrative demo dataset, which is not real registry data." });
  if (candidate.status === "inactive" || candidate.status === "suspended") {
    flags.push({ code: "SUPPLIER_STATUS_NOT_ACTIVE", severity: "medium", message: `Registry data records the matched company's status as "${candidate.status}".` });
  }
  if (level === "weak" || level === "unconfirmed") {
    flags.push({ code: "IDENTITY_NOT_CONFIRMED", severity: crConflict ? "medium" : "low", message: "Available evidence does not confirm the supplier's identity strongly enough for procurement reliance." });
  }

  // A matched registry company is at least partial evidence, even when its score stays low (e.g.
  // demo-only data); only a CR registered to a different company is a "fail".
  const status: CheckStatus = crConflict === "cr_belongs_to_other_company" ? "fail" : level === "strong" ? "pass" : "partial";
  const trustLabel = candidate.demoOnly ? "demo dataset only" : candidate.maxRealAuthority >= 0.9 ? "registry-grade source" : candidate.maxRealAuthority >= 0.5 ? "directory-grade source" : "lower-trust source";
  return {
    level, score, identityConfirmed: level === "strong", status, candidate, crConflict, crOwnerName, corroborations,
    explanation: `Matched registry company "${candidate.companyName}" (name-match score ${candidate.nameScore.toFixed(2)}, ${trustLabel})` +
      (corroborations.length ? `; corroborated by: ${corroborations.join(", ")}` : "; no independent corroborating identifiers") +
      `. Identity evidence is ${level}.`,
    flags
  };
}

// =============================================================================================
// 3. Website
// =============================================================================================

export interface WebsiteAssessment {
  status: CheckStatus;
  explanation: string;
  inspectedUrl: string | null;
  urlSource: "supplied" | "registry" | null;
  signals: {
    websiteExists: boolean | null;
    https: boolean | null;
    domainMatchesCompanyName: boolean | null;
    domainMatchesRegistry: boolean | null;
    companyNameOnWebsite: boolean | null;
    corporateEmailOnWebsite: boolean | null;
    phoneOnWebsite: boolean | null;
    physicalAddressOnWebsite: boolean | null;
    redirectedToDifferentDomain: boolean | null;
  };
  flags: SupplierRiskFlag[];
}

const EMPTY_SIGNALS: WebsiteAssessment["signals"] = {
  websiteExists: null, https: null, domainMatchesCompanyName: null, domainMatchesRegistry: null, companyNameOnWebsite: null,
  corporateEmailOnWebsite: null, phoneOnWebsite: null, physicalAddressOnWebsite: null, redirectedToDifferentDomain: null
};

export function mentionsOmanLocation(text: string): boolean {
  const hay = text.toLowerCase();
  if (/\boman\b|sultanate|سلطنة عمان|عُمان|p\.?\s?o\.?\s?box|\bpc\s?\d{3}\b|postal code/.test(hay)) return true;
  return OMAN_GOVERNORATES.some(g => g.aliases.some(a => a.length >= 4 && hay.includes(a.toLowerCase())));
}

export function assessWebsite(
  n: NormalizedSupplierInput, inspectedUrl: string | null, urlSource: "supplied" | "registry" | null,
  result: ProviderResult<import("../providers/websiteProvider.js").WebsiteEvidence> | null, candidate: RegistryCandidate | null
): WebsiteAssessment {
  const flags: SupplierRiskFlag[] = [];
  if (!inspectedUrl) {
    return { status: "unknown", inspectedUrl: null, urlSource: null, signals: { ...EMPTY_SIGNALS, websiteExists: false }, flags, explanation: "No website was supplied or found in registry data. Many legitimate Omani suppliers operate without a website; this is not treated as a risk on its own." };
  }
  if (!result || result.status === "not_configured") {
    return { status: "unknown", inspectedUrl, urlSource, signals: EMPTY_SIGNALS, flags, explanation: `A website (${inspectedUrl}) was ${urlSource === "registry" ? "found in registry data" : "supplied"}, but live website inspection is not enabled for this deployment.` };
  }
  const ev = result.evidence;
  if (result.status === "unavailable" || !ev) {
    flags.push({ code: "WEBSITE_UNREACHABLE", severity: "low", message: "The website could not be reached during screening. This can be temporary and is not evidence of wrongdoing." });
    return { status: "unknown", inspectedUrl, urlSource, signals: { ...EMPTY_SIGNALS, websiteExists: null }, flags, explanation: `The website could not be reached (${result.reason ?? "unknown reason"}).` };
  }
  if (ev.fetchError?.startsWith("url_rejected")) {
    const insecure = ev.fetchError.endsWith("unsupported_scheme");
    flags.push(insecure
      ? { code: "WEBSITE_NO_HTTPS", severity: "low", message: "The website redirected to a non-HTTPS address, which was not followed." }
      : { code: "WEBSITE_UNREACHABLE", severity: "medium", message: "The website address failed network-safety checks (e.g. it points to a private or local address) and was not fetched." });
    return { status: insecure ? "partial" : "fail", inspectedUrl, urlSource, signals: { ...EMPTY_SIGNALS, websiteExists: null, https: insecure ? false : null }, flags, explanation: `The website URL was not fetched (${ev.fetchError.replace("url_rejected:", "")}).` };
  }

  const text = `${ev.title ?? ""} ${ev.textExcerpt}`;
  const siteDomain = ev.finalDomain ? registrableDomain(ev.finalDomain) : null;
  const requestedDomain = n.websiteDomain && urlSource === "supplied" ? registrableDomain(n.websiteDomain) : domainOf(inspectedUrl);
  const registryDomain = candidate ? domainOf(candidate.website) : null;
  const names = [n.companyName, candidate?.companyName, candidate?.nameEn, candidate?.nameAr];
  const signals: WebsiteAssessment["signals"] = {
    websiteExists: ev.reachable,
    https: ev.https,
    domainMatchesCompanyName: siteDomain ? names.some(nm => nm && domainResemblesName(siteDomain, nm)) : null,
    domainMatchesRegistry: registryDomain && siteDomain ? registryDomain === siteDomain : null,
    companyNameOnWebsite: ev.reachable ? nameAppearsIn(text, names) : null,
    corporateEmailOnWebsite: ev.reachable ? ev.emails.some(e => siteDomain !== null && registrableDomain(e.split("@")[1] ?? "") === siteDomain) : null,
    phoneOnWebsite: ev.reachable ? ev.phones.length > 0 : null,
    physicalAddressOnWebsite: ev.reachable ? mentionsOmanLocation(text) : null,
    redirectedToDifferentDomain: siteDomain && requestedDomain ? siteDomain !== requestedDomain : null
  };

  if (!ev.reachable) {
    flags.push({ code: "WEBSITE_UNREACHABLE", severity: "low", message: `The website responded with HTTP ${ev.httpStatus ?? "error"}.` });
    return { status: "partial", inspectedUrl, urlSource, signals, flags, explanation: `The website responded with HTTP ${ev.httpStatus}; its content could not be assessed.` };
  }

  const identityOk = Boolean(signals.companyNameOnWebsite) || Boolean(signals.domainMatchesRegistry);
  const domainOk = Boolean(signals.domainMatchesCompanyName) || Boolean(signals.domainMatchesRegistry);
  const contactOk = Boolean(signals.corporateEmailOnWebsite || signals.phoneOnWebsite);
  const conflict = !signals.companyNameOnWebsite && !domainOk;
  const offDomain = signals.redirectedToDifferentDomain === true && !domainOk;

  if (conflict || offDomain) {
    flags.push({ code: "WEBSITE_IDENTITY_CONFLICT", severity: "medium", message: offDomain
      ? "The supplied website redirects to a different domain that does not correspond to the company name."
      : "The website neither presents the submitted company name nor uses a domain corresponding to it." });
    return { status: "fail", inspectedUrl, urlSource, signals, flags, explanation: "The website was reachable but its content/domain does not correspond to the submitted company identity." };
  }
  const passed = identityOk && domainOk && contactOk && ev.https;
  const found: string[] = [];
  if (signals.companyNameOnWebsite) found.push("company name");
  if (signals.corporateEmailOnWebsite) found.push("corporate email");
  if (signals.phoneOnWebsite) found.push("phone number");
  if (signals.physicalAddressOnWebsite) found.push("Oman address/location");
  return {
    status: passed ? "pass" : "partial", inspectedUrl, urlSource, signals, flags,
    explanation: `Website ${siteDomain} is reachable over ${ev.https ? "HTTPS" : "HTTP"}` + (found.length ? ` and shows: ${found.join(", ")}.` : ", but shows little identifying or contact information.")
  };
}

// =============================================================================================
// 4. Contact consistency
// =============================================================================================

export interface ContactAssessment {
  status: CheckStatus;
  explanation: string;
  flags: SupplierRiskFlag[];
  lookalikeDomain: string | null;
  comparisons: number;
}

export function assessContacts(n: NormalizedSupplierInput, candidate: RegistryCandidate | null, website: WebsiteEvidence | null): ContactAssessment {
  const flags: SupplierRiskFlag[] = [];
  const notes: string[] = [];
  let consistent = 0, mismatched = 0, lookalikeDomain: string | null = null;

  const referenceDomains = new Map<string, string>(); // registrable domain -> where it came from
  if (n.websiteDomain) referenceDomains.set(registrableDomain(n.websiteDomain), "supplied website");
  if (website?.reachable && website.finalDomain) referenceDomains.set(registrableDomain(website.finalDomain), "inspected website");
  const regSite = candidate ? domainOf(candidate.website) : null;
  if (regSite) referenceDomains.set(regSite, "registry website");
  if (candidate?.email) { const e = normalizeEmail(candidate.email); if (e && !e.free) referenceDomains.set(registrableDomain(e.domain), "registry email"); }

  if (n.emailDomain) {
    const emailReg = registrableDomain(n.emailDomain);
    if (n.freeEmailProvider) {
      flags.push({ code: "FREE_EMAIL_PROVIDER", severity: "low", message: "The supplied email uses a free/consumer mailbox provider, so it cannot corroborate a corporate domain. This is common for small businesses and is not a risk on its own." });
      notes.push("email is a free mailbox (cannot be compared to a corporate domain)");
    } else if (referenceDomains.size === 0) {
      notes.push("no website or registry domain available to compare the email domain against");
    } else if (referenceDomains.has(emailReg)) {
      consistent++;
      notes.push(`email domain matches ${referenceDomains.get(emailReg)}`);
    } else {
      mismatched++;
      const look = [...referenceDomains.keys()].find(d => isLookalikeDomain(emailReg, d));
      if (look) {
        lookalikeDomain = emailReg;
        flags.push({ code: "LOOKALIKE_DOMAIN", severity: "medium", message: `The email domain "${emailReg}" closely resembles, but differs from, "${look}" (${referenceDomains.get(look)}). Confirm the correct domain directly with the supplier.` });
      }
      flags.push({ code: "EMAIL_DOMAIN_MISMATCH", severity: "medium", message: `The email domain "${emailReg}" does not match the supplier's known domain(s): ${[...referenceDomains.keys()].join(", ")}.` });
      notes.push("email domain differs from known domains");
    }
  }

  if (n.phone) {
    if (!n.phone.isOman) {
      const intlDigits = n.phone.input.replace(/\D/g, "").replace(/^00/, "");
      const explicitForeign = /^(\+|00)/.test(n.phone.input.trim()) && !intlDigits.startsWith("968") && intlDigits.length >= 8;
      if (explicitForeign) {
        flags.push({ code: "PHONE_NOT_OMAN", severity: "low", message: "The supplied phone number is not an Oman number." });
        notes.push("phone is not an Oman number");
      } else {
        notes.push("phone number could not be parsed as a valid Oman number");
      }
    } else {
      const refs = new Set<string>();
      if (candidate?.phone) { const p = normalizePhone(candidate.phone); if (p.isOman) refs.add(p.digits); }
      for (const p of website?.phones ?? []) refs.add(p);
      if (refs.size === 0) notes.push("no registry or website phone available to compare");
      else if (refs.has(n.phone.digits)) { consistent++; notes.push("phone matches registry/website"); }
      else {
        mismatched++;
        flags.push({ code: "PHONE_MISMATCH", severity: "low", message: "The supplied phone number does not appear in the registry record or on the supplier's website. Companies often have several numbers; confirm through an independently sourced number." });
        notes.push("phone differs from registry/website numbers");
      }
    }
  }

  if (n.websiteDomain && candidate) {
    if (regSite) {
      if (regSite === registrableDomain(n.websiteDomain)) { consistent++; notes.push("supplied website matches registry website"); }
      else {
        mismatched++;
        if (isLookalikeDomain(registrableDomain(n.websiteDomain), regSite) && !lookalikeDomain) {
          lookalikeDomain = registrableDomain(n.websiteDomain);
          flags.push({ code: "LOOKALIKE_DOMAIN", severity: "medium", message: `The supplied website domain closely resembles, but differs from, the registry website "${regSite}".` });
        }
        notes.push("supplied website differs from the registry website");
      }
    }
  }

  const comparisons = consistent + mismatched;
  const status: CheckStatus = comparisons === 0 ? (n.freeEmailProvider ? "partial" : "unknown") : mismatched === 0 ? "pass" : consistent === 0 ? "fail" : "partial";
  return { status, flags, lookalikeDomain, comparisons, explanation: notes.length ? `${notes.join("; ")}.` : "No contact details were supplied to compare." };
}

// =============================================================================================
// 5. Address consistency
// =============================================================================================

export interface AddressAssessment { status: AddressStatus; explanation: string; flags: SupplierRiskFlag[]; }

const FOREIGN_LOCATIONS = ["dubai", "abu dhabi", "sharjah", "united arab emirates", "uae", "saudi", "riyadh", "jeddah", "qatar", "doha", "kuwait", "bahrain", "manama", "india", "pakistan", "china", "egypt", "iran", "united kingdom", "usa", "united states"];

function governoratesIn(text: string): Set<string> {
  const hay = ` ${text.toLowerCase()} `;
  const found = new Set<string>();
  for (const g of OMAN_GOVERNORATES) {
    for (const a of [g.canonical, ...g.aliases]) {
      const al = a.toLowerCase();
      if (/[؀-ۿ]/.test(al) ? hay.includes(al) : new RegExp(`[^a-z]${al.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^a-z]`).test(hay)) { found.add(g.canonical); break; }
    }
  }
  return found;
}

export function assessAddress(n: NormalizedSupplierInput, candidate: RegistryCandidate | null, website: WebsiteEvidence | null): AddressAssessment {
  const flags: SupplierRiskFlag[] = [];
  if (!n.address) return { status: "unknown", flags, explanation: "No address was supplied, so address consistency was not assessed." };
  const supplied = n.address.toLowerCase();
  const suppliedGovs = governoratesIn(n.address);
  const foreign = FOREIGN_LOCATIONS.find(f => new RegExp(`(^|[^a-z])${f}([^a-z]|$)`).test(supplied));
  if (foreign && suppliedGovs.size === 0 && !/\boman\b|عمان/.test(supplied)) {
    flags.push({ code: "ADDRESS_OUTSIDE_OMAN", severity: "low", message: "The supplied address appears to be outside Oman. The supplier may operate through a foreign entity; confirm which legal entity will contract." });
    return { status: "conflict", flags, explanation: "The supplied address appears to be outside Oman." };
  }

  const regParts = candidate ? [candidate.area, candidate.wilayat, candidate.address].filter((v): v is string => Boolean(v)) : [];
  const regGovs = new Set<string>();
  if (candidate?.governorate) regGovs.add(candidate.governorate);
  for (const p of regParts) for (const g of governoratesIn(p)) regGovs.add(g);

  if (candidate && (regParts.length > 0 || regGovs.size > 0)) {
    const specific = [candidate.area, candidate.wilayat].filter((v): v is string => Boolean(v)).find(p => supplied.includes(p.toLowerCase()));
    if (specific) return { status: "pass", flags, explanation: `The supplied address mentions "${specific}", consistent with the registry record.` };
    const sharedGov = [...suppliedGovs].find(g => regGovs.has(g));
    if (sharedGov) return { status: "partial", flags, explanation: `The supplied address is in the same governorate (${sharedGov}) as the registry record, but the specific location could not be matched.` };
    if (suppliedGovs.size > 0 && regGovs.size > 0) {
      flags.push({ code: "ADDRESS_MISMATCH", severity: "medium", message: `The supplied address (${[...suppliedGovs].join(", ")}) is in a different governorate from the registry record (${[...regGovs].join(", ")}). The supplier may have moved or have several branches.` });
      return { status: "conflict", flags, explanation: "The supplied address and the registry record point to different governorates." };
    }
  }

  if (website?.reachable) {
    const siteText = website.textExcerpt.toLowerCase();
    const siteGovs = governoratesIn(website.textExcerpt);
    const sharedGov = [...suppliedGovs].find(g => siteGovs.has(g));
    if (sharedGov || (n.address.length >= 6 && siteText.includes(supplied))) {
      return { status: "partial", flags, explanation: "The supplied address location also appears on the supplier's website (self-declared, not registry-confirmed)." };
    }
  }
  return { status: "unknown", flags, explanation: "No independent public address evidence was available to compare with the supplied address." };
}
