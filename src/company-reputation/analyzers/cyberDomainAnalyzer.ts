import type { Signal } from "../types.js";
import { signal, str, strs, yearsBetween, type AnalysisContext } from "./context.js";

/** Cyber / domain hygiene. Conservative by design: a young domain is a weak indicator only. */
export function analyzeCyberDomain(ctx: AnalysisContext): Signal[] {
  const signals: Signal[] = [];
  const d = ctx.domain;
  if (d) {
    if (d.metadata.found === false) {
      signals.push(signal("DOMAIN_NOT_IN_RDAP", "cyberDomain", "neutral", "info", "No RDAP record was returned for the domain (some registries do not publish RDAP).", [d], 0));
    } else {
      const registeredAt = str(d.metadata.registeredAt);
      const age = yearsBetween(registeredAt, ctx.now);
      if (age !== null) {
        if (age >= 5) signals.push(signal("DOMAIN_ESTABLISHED", "cyberDomain", "positive", "low", `Domain registered ${registeredAt!.slice(0, 10)} (${Math.floor(age)} years ago).`, [d], 1));
        else if (age >= 2) signals.push(signal("DOMAIN_REGISTERED_2_PLUS_YEARS", "cyberDomain", "positive", "info", `Domain registered ${registeredAt!.slice(0, 10)}.`, [d], 1));
        else if (age < 0.5) signals.push(signal("DOMAIN_RECENTLY_REGISTERED", "cyberDomain", "negative", "low", `Domain registered ${registeredAt!.slice(0, 10)} (under 6 months ago). Weak indicator on its own; new businesses and rebrands register new domains.`, [d], 0.4));
      }
      const statuses = strs(d.metadata.statuses);
      if (statuses.some(s => /hold/.test(s))) signals.push(signal("DOMAIN_ON_HOLD", "cyberDomain", "negative", "medium", `Domain status indicates a registry/registrar hold (${statuses.filter(s => /hold/.test(s)).join(", ")}).`, [d], 0.8));
      if (statuses.some(s => /pending delete|redemption/.test(s))) signals.push(signal("DOMAIN_PENDING_DELETION", "cyberDomain", "negative", "medium", "Domain status indicates pending deletion/redemption.", [d], 0.8));
    }
  }
  const w = ctx.website;
  if (w && w.metadata.reachable === true) {
    if (w.metadata.https === true) signals.push(signal("WEBSITE_HTTPS", "cyberDomain", "positive", "info", "The website is served over HTTPS.", [w], 0.6));
    else signals.push(signal("WEBSITE_NO_HTTPS", "cyberDomain", "negative", "low", "The website is not served over HTTPS.", [w], 0.5));
  }
  return signals;
}
