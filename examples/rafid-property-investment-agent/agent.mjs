#!/usr/bin/env node
// Rafid Property Investment AI Agent — transparent rule-based agent workflow.
// Calls all three live RapidAPI endpoints; no hidden AI model or extra paid APIs.
import { randomUUID } from "node:crypto";

export const RAPIDAPI_HOST = "rafid-intelligence-network2.p.rapidapi.com";
export const RAPIDAPI_BASE = `https://${RAPIDAPI_HOST}`;
const PATHS = {
  analyze: "/rapidapi/v1/property/analyze",
  compare: "/rapidapi/v1/property/compare",
  maintenance: "/rapidapi/v1/maintenance/estimate"
};

export async function rafidRequest(path, payload, { key, fetcher = fetch, baseUrl = RAPIDAPI_BASE } = {}) {
  if (!key) throw new Error("Missing RAPIDAPI_KEY. Set it in your shell (never commit it).");
  const response = await fetcher(baseUrl + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-RapidAPI-Key": key,
      "X-RapidAPI-Host": RAPIDAPI_HOST,
      "Idempotency-Key": randomUUID()
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(30000)
  });
  const raw = await response.text();
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error(`Rafid HTTP ${response.status}: invalid JSON response`); }
  if (!response.ok || parsed?.success !== true) {
    const code = parsed?.error?.code ?? parsed?.message ?? "UNKNOWN_ERROR";
    throw new Error(`Rafid HTTP ${response.status}: ${code}`);
  }
  return parsed.data;
}

export async function runPropertyAgent({ key, fetcher = fetch } = {}) {
  const properties = [
    { name: "Apartment A", propertyValue: 85000, annualRent: 7200, serviceCharge: 650, maintenanceCost: 400 },
    { name: "Apartment B", propertyValue: 100000, annualRent: 7000, serviceCharge: 500, maintenanceCost: 450 }
  ];
  // Sequential calls are friendlier to the free plan's request-rate limits.
  const comparison = await rafidRequest(PATHS.compare, { properties }, { key, fetcher });
  const winnerName = comparison.sortedByNetYield?.[0];
  const winner = properties.find(p => p.name === winnerName);
  if (!winner) throw new Error("Unexpected comparison result: winning property not found");
  const analysis = await rafidRequest(PATHS.analyze, {
    propertyValue: winner.propertyValue,
    annualRent: winner.annualRent,
    serviceCharge: winner.serviceCharge,
    maintenanceCost: winner.maintenanceCost
  }, { key, fetcher });
  const maintenance = await rafidRequest(PATHS.maintenance, {
    propertyValue: winner.propertyValue,
    ageYears: 12,
    units: 1
  }, { key, fetcher });
  return {
    preferredProperty: winner.name,
    ranking: comparison.sortedByNetYield,
    annualNetIncomeOMR: analysis.annualNetIncome,
    netYieldPct: analysis.netYieldPct,
    estimatedAnnualMaintenanceOMR: maintenance.estimatedAnnualMaintenance,
    monthlyMaintenanceReserveOMR: maintenance.monthlyReserve,
    disclaimer: "Input-driven calculations only; maintenance is an uncalibrated estimate, not an inspection or investment recommendation."
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  runPropertyAgent({ key: process.env.RAPIDAPI_KEY })
    .then(result => { console.log(JSON.stringify(result, null, 2)); })
    .catch(err => { console.error(err.message); process.exitCode = 1; });
}
