import { registrableDomain } from "../normalization.js";
import type { Signal } from "../types.js";
import { signal, strs, type AnalysisContext } from "./context.js";

/** Transparency: does the company publish the information a counterparty would expect? */
export function analyzeTransparency(ctx: AnalysisContext): Signal[] {
  const signals: Signal[] = [];
  const w = ctx.website;
  if (ctx.resolution.matched) {
    signals.push(signal("PUBLICLY_REGISTERED_ENTITY", "transparency", "positive", "low", "The entity has a public registry record.", [ctx.resolution.matched.evidenceId], 0.8, 1));
    if (ctx.resolution.matched.lei) signals.push(signal("HAS_LEI", "transparency", "positive", "low", `The entity holds a Legal Entity Identifier (${ctx.resolution.matched.lei}).`, [ctx.resolution.matched.evidenceId], 0.7, 1));
  }
  if (w && w.metadata.reachable === true) {
    if (w.metadata.hasContactLink === true && w.metadata.hasAboutLink === true) signals.push(signal("WEBSITE_CONTACT_AND_ABOUT", "transparency", "positive", "low", "The website links to contact and about/company pages.", [w], 0.5));
    if (w.metadata.hasPrivacyPolicy === true || w.metadata.hasTerms === true) signals.push(signal("WEBSITE_LEGAL_PAGES", "transparency", "positive", "low", "The website links to a privacy policy and/or terms.", [w], 0.5));
    if (w.metadata.mentionsRegistrationDetails === true) signals.push(signal("WEBSITE_PUBLISHES_REGISTRATION_DETAILS", "transparency", "positive", "low", "The website publishes company registration/VAT/registered-office details.", [w], 0.6));
    const emailDomains = strs(w.metadata.emailDomains);
    if (ctx.query.domain && emailDomains.some(d => registrableDomain(d) === registrableDomain(ctx.query.domain!))) {
      signals.push(signal("CORPORATE_EMAIL_ON_COMPANY_DOMAIN", "transparency", "positive", "info", "Contact email addresses on the website use the company's own domain.", [w], 0.4));
    }
    if (w.metadata.hasContactLink !== true && w.metadata.hasPhone !== true && emailDomains.length === 0) {
      signals.push(signal("WEBSITE_NO_CONTACT_DETAILS", "transparency", "negative", "low", "No contact page, phone number or email address was found on the website homepage.", [w], 0.4));
    }
  }
  return signals;
}
