import type { ProviderResult, SupplierDataProvider } from "../types.js";
import type { SanctionsListEvidence } from "../../shared/sanctions/listProviders.js";

/** Moved to src/shared/sanctions/listProviders.ts (shared with company_reputation_check).
 *  Re-exported unchanged so existing imports keep working. The provider interface is re-declared
 *  here in supplier-check's own ProviderResult vocabulary (the shared classes satisfy it
 *  structurally), so supplier-check's fakes and evidence cache keep their original types. */
export * from "../../shared/sanctions/listProviders.js";

export interface SanctionsListProvider extends SupplierDataProvider {
  readonly kind: "sanctions";
  readonly listName: string;
  screenName(companyName: string, now: Date): Promise<ProviderResult<SanctionsListEvidence>>;
}
