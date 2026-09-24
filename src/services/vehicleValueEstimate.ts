import { previewVehicleValueEstimate, runVehicleValueEstimate } from "../vehicle-value/service.js";

/** vehicle_value_estimate's registry entry point (src/domain/capabilities.ts) — the one engine shared
 *  by REST, x402, L402, MPP and MCP (src/vehicle-value/service.ts). Deterministic valuation over the
 *  market evidence returned by the configured providers; no LLM. */
export async function vehicleValueEstimate(input: unknown) {
  return runVehicleValueEstimate(input);
}

/** vehicle_value_estimate's Free Preview entry point — coverage signals only (see
 *  previewVehicleValueEstimate's doc comment). Never queries a provider, never prices the vehicle. */
export async function previewVehicleValueEstimateCapability(input: unknown) {
  return previewVehicleValueEstimate(input);
}
