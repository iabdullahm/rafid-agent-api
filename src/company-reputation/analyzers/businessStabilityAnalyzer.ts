import type { Signal } from "../types.js";
import { signal, str, yearsBetween, type AnalysisContext } from "./context.js";

/** Business stability from the RESOLVED registry record(s) only — never from an ambiguous or
 *  unmatched candidate. Insolvency news is routed here by the adverse-media analyzer. */
export function analyzeBusinessStability(ctx: AnalysisContext): Signal[] {
  const r = ctx.resolution;
  if (!r.matched) return [];
  const ids = [r.matched.evidenceId, ...r.corroboratingRecords.map(c => c.evidenceId)];
  const records = ctx.registry.filter(e => ids.includes(e.id));
  const signals: Signal[] = [];
  const statuses = new Set(records.map(e => str(e.metadata.status) ?? "unknown"));
  if (statuses.has("dissolved")) signals.push(signal("REGISTRY_STATUS_DISSOLVED", "businessStability", "negative", "high", "An official registry record shows the entity as dissolved/removed.", records, 1));
  else if (statuses.has("liquidation")) signals.push(signal("REGISTRY_STATUS_INSOLVENCY_OR_LIQUIDATION", "businessStability", "negative", "high", "An official registry record shows liquidation, administration or other insolvency status.", records, 1));
  else if (statuses.has("inactive")) signals.push(signal("REGISTRY_STATUS_INACTIVE", "businessStability", "negative", "medium", "An official registry record shows the entity as inactive.", records, 0.9));
  else if (statuses.has("active")) signals.push(signal("REGISTRY_STATUS_ACTIVE", "businessStability", "positive", "medium", "Official registry records show the entity as active.", records, 1));

  if (records.some(e => e.metadata.hasInsolvencyHistory === true)) {
    signals.push(signal("REGISTRY_INSOLVENCY_HISTORY", "businessStability", "negative", "medium", "The registry reports past insolvency history for this entity (may be historic/resolved).", records.filter(e => e.metadata.hasInsolvencyHistory === true), 0.8));
  }
  const incorporation = records.map(e => str(e.metadata.incorporationDate)).filter((d): d is string => Boolean(d)).sort()[0] ?? null;
  const years = yearsBetween(incorporation, ctx.now);
  if (years !== null) {
    if (years >= 10) signals.push(signal("ESTABLISHED_10_PLUS_YEARS", "businessStability", "positive", "medium", `Registered/created ${incorporation} (${Math.floor(years)} years).`, records, 1));
    else if (years >= 3) signals.push(signal("ESTABLISHED_3_PLUS_YEARS", "businessStability", "positive", "low", `Registered/created ${incorporation} (${Math.floor(years)} years).`, records, 0.8));
    else if (years < 1) signals.push(signal("RECENTLY_INCORPORATED", "businessStability", "neutral", "info", `Registered/created ${incorporation} (less than a year ago). Not a risk indicator on its own; less operating history is publicly observable.`, records, 0));
  }
  const lapsed = records.filter(e => str(e.metadata.leiRegistrationStatus) === "LAPSED");
  if (lapsed.length > 0) signals.push(signal("LEI_REGISTRATION_LAPSED", "businessStability", "negative", "low", "The entity's LEI registration has lapsed (not renewed). This is often administrative, not a solvency indicator.", lapsed, 0.3));
  return signals;
}
