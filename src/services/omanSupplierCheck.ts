import { previewOmanSupplierCheck, runOmanSupplierCheck } from "../supplier-check/service.js";

/** oman_supplier_check's registry entry point (src/domain/capabilities.ts) — runs against the
 *  default, env-configured providers and evidence cache (src/supplier-check/service.ts). */
export async function omanSupplierCheck(input: unknown) {
  return runOmanSupplierCheck(input);
}

/** oman_supplier_check's Free Preview entry point (src/domain/capabilities.ts) — see
 *  previewOmanSupplierCheck's own doc comment in src/supplier-check/service.ts. */
export async function previewOmanSupplierCheckCapability(input: unknown) {
  return previewOmanSupplierCheck(input);
}
