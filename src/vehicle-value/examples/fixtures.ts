import { StaticVehicleMarketProvider } from "../providers/providers.js";
import type { VehicleComparable } from "../types.js";

/**
 * EXPLICITLY SYNTHETIC vehicle market evidence for deterministic tests and the documented
 * example. Every listing is generated from a fixed formula plus a fixed deviation table (no
 * randomness), sources are fictional ("synthetic-…") and URLs use the reserved .example TLD. These
 * are NOT real listings and are never registered as a provider in production.
 *
 * Price model used to generate the Oman Land Cruiser set (OMR): 2022 GXR at 60,000 km ≈ 23,000;
 * ×1.10 per newer model year; −1 % per +10,000 km; trims EXR ×0.86, GXR ×1.00, VXR ×1.24; plus a
 * fixed ±3 % deviation per listing.
 */

export const FIXTURE_AS_OF = "2026-09-23";
const DAY = 86_400_000;
const asOfMs = Date.parse(`${FIXTURE_AS_OF}T12:00:00Z`);
const daysAgo = (d: number) => new Date(asOfMs - d * DAY).toISOString();

const DEVIATIONS = [0.012, -0.018, 0.025, -0.006, 0.0, 0.019, -0.027, 0.008, -0.013, 0.021, -0.004, 0.015, -0.022, 0.003, 0.027, -0.009, 0.011, -0.016, 0.006, -0.025, 0.017, -0.002, 0.009, -0.011];
const TRIM_FACTOR: Record<string, number> = { EXR: 0.86, GXR: 1.0, VXR: 1.24 };
const CITIES = ["Muscat", "Muscat", "Muscat", "Sohar", "Muscat", "Salalah", "Muscat", "Nizwa"];
const SOURCES = ["synthetic-listings-a", "synthetic-listings-b", "synthetic-dealer-feed"];

function lcPrice(year: number, trim: string, km: number, i: number): number {
  const p = 23_000 * Math.pow(1.10, year - 2022) * (1 - 0.01 * ((km - 60_000) / 10_000)) * (TRIM_FACTOR[trim] ?? 1) * (1 + DEVIATIONS[i % DEVIATIONS.length]!);
  return Math.round(p / 50) * 50;
}

/** [year, trim, km, daysAgo] */
const OMAN_LC_SPECS: readonly (readonly [number, string, number, number])[] = [
  [2022, "GXR", 62_000, 3], [2022, "GXR", 55_000, 6], [2022, "GXR", 71_000, 9], [2022, "GXR", 48_000, 12], [2022, "GXR", 80_000, 15],
  [2022, "GXR", 66_000, 18], [2022, "GXR", 59_000, 22], [2022, "GXR", 74_000, 26], [2022, "GXR", 52_000, 31], [2022, "GXR", 90_000, 35],
  [2021, "GXR", 88_000, 8], [2021, "GXR", 76_000, 20], [2023, "GXR", 41_000, 11], [2023, "GXR", 35_000, 28],
  [2022, "VXR", 58_000, 7], [2022, "VXR", 69_000, 17], [2022, "EXR", 64_000, 10], [2022, "EXR", 72_000, 24],
  [2021, "VXR", 83_000, 14], [2020, "GXR", 110_000, 19], [2024, "GXR", 21_000, 5]
];

export const OMAN_LAND_CRUISER_LISTINGS: readonly VehicleComparable[] = OMAN_LC_SPECS.map(([year, trim, km, ago], i) => ({
  make: "Toyota", model: "Land Cruiser", year, trim, mileageKm: km,
  condition: i % 5 === 0 ? "very_good" : "good", fuelType: "petrol", transmission: "automatic", bodyType: "suv", drivetrain: "4wd",
  askingPrice: lcPrice(year, trim, km, i), currency: "OMR", country: "OM", city: CITIES[i % CITIES.length]!,
  sourceName: SOURCES[i % SOURCES.length]!, sourceRecordId: `lc-om-${String(i + 1).padStart(3, "0")}`,
  sourceUrl: `https://${SOURCES[i % SOURCES.length]!.replace("synthetic-", "")}.example/listing/lc-om-${i + 1}`,
  observedAt: daysAgo(ago), priceType: "listing"
}));

/** Two implausible listings (a likely data-entry error and a likely salvage/damaged unit) that the
 *  outlier stage must exclude without any hard-coded price threshold. */
export const OMAN_LAND_CRUISER_OUTLIERS: readonly VehicleComparable[] = [
  { make: "Toyota", model: "Land Cruiser", year: 2022, trim: "GXR", mileageKm: 63_000, askingPrice: 45_500, currency: "OMR", country: "OM", city: "Muscat", sourceName: "synthetic-listings-a", sourceRecordId: "lc-om-out-1", observedAt: daysAgo(4), priceType: "listing" },
  { make: "Toyota", model: "Land Cruiser", year: 2022, trim: "GXR", mileageKm: 61_000, askingPrice: 9_800, currency: "OMR", country: "OM", city: "Muscat", sourceName: "synthetic-listings-b", sourceRecordId: "lc-om-out-2", observedAt: daysAgo(6), priceType: "listing" }
];

/** UAE (AED) listings of the same model — regional evidence for Oman that needs FX to be usable. */
export const UAE_LAND_CRUISER_LISTINGS: readonly VehicleComparable[] = ([
  [2022, "GXR", 60_000, 4], [2022, "GXR", 70_000, 9], [2022, "GXR", 52_000, 13], [2021, "GXR", 85_000, 16], [2023, "GXR", 38_000, 21], [2022, "VXR", 61_000, 25]
] as const).map(([year, trim, km, ago], i) => ({
  make: "Toyota", model: "Land Cruiser", year, trim, mileageKm: km, fuelType: "petrol", transmission: "automatic", bodyType: "suv", drivetrain: "4wd",
  askingPrice: Math.round(lcPrice(year, trim, km, i + 3) * 9.55 * 1.02 / 100) * 100, currency: "AED", country: "AE", city: i % 2 ? "Abu Dhabi" : "Dubai",
  sourceName: "synthetic-uae-listings", sourceRecordId: `lc-ae-${i + 1}`, observedAt: daysAgo(ago), priceType: "listing"
}));

/** Only two Oman Nissan Patrol listings — a sparse market that must NOT produce an estimate. */
export const SPARSE_PATROL_LISTINGS: readonly VehicleComparable[] = [
  { make: "Nissan", model: "Patrol", year: 2019, trim: "LE", mileageKm: 120_000, askingPrice: 14_200, currency: "OMR", country: "OM", city: "Muscat", sourceName: "synthetic-listings-a", sourceRecordId: "pt-om-1", observedAt: daysAgo(10), priceType: "listing" },
  { make: "Nissan", model: "Patrol", year: 2019, trim: "LE", mileageKm: 98_000, askingPrice: 15_100, currency: "OMR", country: "OM", city: "Sohar", sourceName: "synthetic-listings-b", sourceRecordId: "pt-om-2", observedAt: daysAgo(20), priceType: "listing" }
];

/** The Oman Land Cruiser set re-observed ~7–10 months ago (still inside the 365-day window) — stale evidence. */
export const STALE_LAND_CRUISER_LISTINGS: readonly VehicleComparable[] = OMAN_LAND_CRUISER_LISTINGS.slice(0, 10).map((c, i) => ({
  ...c, sourceRecordId: `stale-${c.sourceRecordId}`, observedAt: daysAgo(210 + i * 9)
}));

/** Canonical valuation request from the capability specification. */
export const LAND_CRUISER_REQUEST = {
  make: "Toyota", model: "Land Cruiser", year: 2022, trim: "GXR", mileageKm: 68_000, condition: "good", country: "Oman", city: "Muscat",
  currency: "OMR", fuelType: "petrol", transmission: "automatic", bodyType: "suv", engine: "4.0L V6", drivetrain: "4WD",
  accidentHistory: false, serviceHistory: "full", owners: 1, color: "white", options: ["sunroof", "leather seats", "360 camera"], askingPrice: 22_500
} as const;

export const fixtureToday = () => new Date(`${FIXTURE_AS_OF}T12:00:00Z`);

/** The provider set the documented example is generated from. */
export function syntheticOmanProviders(): StaticVehicleMarketProvider[] {
  return [
    new StaticVehicleMarketProvider("synthetic-oman-listings", [...OMAN_LAND_CRUISER_LISTINGS, ...OMAN_LAND_CRUISER_OUTLIERS, ...SPARSE_PATROL_LISTINGS], { coverage: ["OM"] })
  ];
}
