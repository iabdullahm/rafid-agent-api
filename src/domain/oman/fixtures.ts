import { daysSince, type FurnishedStatus, type PropertyType, type RentPeriod, type RentalComparable, type SaleComparable } from "./types.js";

/**
 * Section 15 / Section 4 (ManualDatasetProvider): a small, explicitly curated benchmark dataset
 * for demonstration and MVP purposes only.
 *
 * THESE ARE NOT LIVE LISTINGS, NOT OFFICIAL STATISTICS, AND NOT COMPLETED-TRANSACTION PRICES.
 * Every figure below is an illustrative, hand-authored approximation of plausible Muscat rental/
 * sale ranges by area and property type, assembled to make the comparable-selection, outlier-
 * removal, confidence-scoring and provenance machinery in this capability fully exercisable and
 * production-shaped. It must be replaced with a real licensed/official feed (see
 * OfficialOmanDataProvider / ListingDataProvider in dataProviders.ts) before this capability's
 * output should be treated as real market evidence. Every record's provenance says so explicitly
 * (sourceType: "manual_benchmark", sourceName below) — see this capability's "remaining work"
 * report for exactly what replacing this dataset requires.
 *
 * `sourceDate` is a fixed ISO date per record; `listedDaysAgo` is computed from it at query time
 * (see daysSince below), not stored statically — so as real time passes, this demo dataset
 * honestly ages and will eventually and correctly start surfacing as stale via riskFlags,
 * instead of pretending to be permanently fresh.
 *
 * Coverage is deliberately uneven across areas/property types/bedroom counts — some buckets have
 * a healthy sample, some have only one or two records, and at least one recognized area+type
 * combination (Qurum villas) has none at all. This is intentional: it is what a real, honestly
 * reported MVP dataset looks like, and it is what exercises this capability's
 * insufficientMarketData and small-sample-size code paths.
 */
export const DATASET_SOURCE_NAME =
  "Rafid curated Muscat benchmark dataset (demo/MVP — illustrative figures, not sourced from live listings or completed transactions)";

let nextRentalId = 1;
function rental(
  area: string, propertyType: PropertyType, bedrooms: number, sizeSqm: number,
  rentAmountOMR: number, rentPeriod: RentPeriod, furnished: FurnishedStatus, sourceDate: string
): RentalComparable {
  return {
    id: `rent-${nextRentalId++}`, area, propertyType, bedrooms, sizeSqm, furnished,
    listedDaysAgo: daysSince(sourceDate), sourceType: "manual_benchmark", sourceName: DATASET_SOURCE_NAME, sourceDate,
    rentAmountOMR, rentPeriod
  };
}

let nextSaleId = 1;
function sale(
  area: string, propertyType: PropertyType, bedrooms: number, sizeSqm: number,
  askingPriceOMR: number, furnished: FurnishedStatus, sourceDate: string
): SaleComparable {
  return {
    id: `sale-${nextSaleId++}`, area, propertyType, bedrooms, sizeSqm, furnished,
    listedDaysAgo: daysSince(sourceDate), sourceType: "manual_benchmark", sourceName: DATASET_SOURCE_NAME, sourceDate,
    askingPriceOMR
  };
}

export const RENTAL_FIXTURES: readonly RentalComparable[] = [
  // Al Mouj — apartments: a healthy sample across 1/2/3 bedrooms, including one deliberate
  // outlier (rent-9, far above the rest for its size) and two annual-quoted contracts (rent-6,
  // rent-10) to exercise monthly/annual normalization.
  rental("Al Mouj", "apartment", 1, 78, 480, "monthly", "furnished", "2026-05-01"),
  rental("Al Mouj", "apartment", 1, 82, 510, "monthly", "unfurnished", "2026-04-10"),
  rental("Al Mouj", "apartment", 1, 85, 520, "monthly", "furnished", "2026-06-15"),
  rental("Al Mouj", "apartment", 2, 128, 720, "monthly", "furnished", "2026-03-20"),
  rental("Al Mouj", "apartment", 2, 135, 760, "monthly", "semi_furnished", "2026-05-25"),
  rental("Al Mouj", "apartment", 2, 140, 9_000, "annual", "furnished", "2026-02-01"), // 750/mo equivalent
  rental("Al Mouj", "apartment", 3, 195, 1050, "monthly", "unfurnished", "2026-04-01"),
  rental("Al Mouj", "apartment", 3, 205, 1100, "monthly", "furnished", "2026-06-01"),
  rental("Al Mouj", "apartment", 2, 130, 2400, "monthly", "furnished", "2026-05-10"), // deliberate outlier
  rental("Al Mouj", "apartment", 3, 210, 13_200, "annual", "semi_furnished", "2026-03-05"), // 1100/mo equivalent

  // Al Mouj — villas
  rental("Al Mouj", "villa", 3, 320, 1450, "monthly", "unfurnished", "2026-04-12"),
  rental("Al Mouj", "villa", 4, 380, 1850, "monthly", "furnished", "2026-05-18"),
  rental("Al Mouj", "villa", 4, 410, 2050, "monthly", "semi_furnished", "2026-02-22"),
  rental("Al Mouj", "villa", 4, 440, 2250, "monthly", "unfurnished", "2026-06-08"),

  // Al Mouj — townhouses: only two records on file (small comparable sample scenario).
  rental("Al Mouj", "townhouse", 3, 235, 1050, "monthly", "furnished", "2026-05-02"),
  rental("Al Mouj", "townhouse", 3, 245, 1120, "monthly", "unfurnished", "2026-03-28"),

  // Muscat Hills — villas
  rental("Muscat Hills", "villa", 4, 360, 1650, "monthly", "unfurnished", "2026-04-05"),
  rental("Muscat Hills", "villa", 4, 390, 1780, "monthly", "furnished", "2026-05-14"),
  rental("Muscat Hills", "villa", 5, 460, 2350, "monthly", "semi_furnished", "2026-02-18"),
  rental("Muscat Hills", "villa", 5, 480, 2500, "monthly", "unfurnished", "2026-06-20"),
  rental("Muscat Hills", "villa", 4, 370, 1700, "monthly", "unfurnished", "2026-03-11"),

  // Muscat Hills — townhouses
  rental("Muscat Hills", "townhouse", 3, 235, 980, "monthly", "furnished", "2026-04-22"),
  rental("Muscat Hills", "townhouse", 3, 250, 1050, "monthly", "unfurnished", "2026-05-30"),
  rental("Muscat Hills", "townhouse", 3, 245, 1020, "monthly", "semi_furnished", "2026-03-02"),

  // Qurum — apartments. Note: Qurum VILLAS have no fixture data at all (see below) — the
  // "no comparable data" test case exercises Qurum + villa.
  rental("Qurum", "apartment", 1, 72, 420, "monthly", "unfurnished", "2026-05-06"),
  rental("Qurum", "apartment", 1, 76, 440, "monthly", "furnished", "2026-04-16"),
  rental("Qurum", "apartment", 2, 118, 620, "monthly", "unfurnished", "2026-03-24"),
  rental("Qurum", "apartment", 2, 125, 650, "monthly", "furnished", "2026-06-02"),
  rental("Qurum", "apartment", 3, 175, 890, "monthly", "semi_furnished", "2026-02-14"),
  rental("Qurum", "apartment", 3, 185, 930, "monthly", "unfurnished", "2026-05-28"),

  // Bausher — apartments and villas
  rental("Bausher", "apartment", 1, 68, 340, "monthly", "unfurnished", "2026-04-08"),
  rental("Bausher", "apartment", 1, 72, 360, "monthly", "furnished", "2026-05-19"),
  rental("Bausher", "apartment", 2, 110, 500, "monthly", "unfurnished", "2026-03-15"),
  rental("Bausher", "apartment", 2, 118, 530, "monthly", "semi_furnished", "2026-06-11"),
  rental("Bausher", "villa", 3, 290, 820, "monthly", "unfurnished", "2026-04-27"),
  rental("Bausher", "villa", 4, 340, 980, "monthly", "furnished", "2026-05-09"),
  rental("Bausher", "villa", 3, 300, 850, "monthly", "unfurnished", "2026-02-26"),
  rental("Bausher", "villa", 4, 355, 1010, "monthly", "semi_furnished", "2026-06-17"),

  // Azaiba — apartments
  rental("Azaiba", "apartment", 1, 70, 350, "monthly", "unfurnished", "2026-04-03"),
  rental("Azaiba", "apartment", 1, 74, 365, "monthly", "furnished", "2026-05-21"),
  rental("Azaiba", "apartment", 2, 112, 480, "monthly", "unfurnished", "2026-03-08"),
  rental("Azaiba", "apartment", 2, 120, 510, "monthly", "semi_furnished", "2026-06-05"),
  rental("Azaiba", "apartment", 2, 116, 495, "monthly", "unfurnished", "2026-02-11"),

  // Al Khuwair — apartments
  rental("Al Khuwair", "apartment", 1, 66, 320, "monthly", "unfurnished", "2026-04-19"),
  rental("Al Khuwair", "apartment", 1, 70, 335, "monthly", "furnished", "2026-05-07"),
  rental("Al Khuwair", "apartment", 2, 108, 460, "monthly", "unfurnished", "2026-03-30"),
  rental("Al Khuwair", "apartment", 2, 115, 485, "monthly", "semi_furnished", "2026-06-13"),
  rental("Al Khuwair", "apartment", 3, 165, 680, "monthly", "unfurnished", "2026-02-20"),
  rental("Al Khuwair", "apartment", 3, 172, 705, "monthly", "furnished", "2026-05-27"),

  // Madinat Al Irfan — apartments and townhouses (newer development)
  rental("Madinat Al Irfan", "apartment", 1, 74, 380, "monthly", "furnished", "2026-04-24"),
  rental("Madinat Al Irfan", "apartment", 2, 118, 540, "monthly", "unfurnished", "2026-05-15"),
  rental("Madinat Al Irfan", "apartment", 2, 122, 560, "monthly", "semi_furnished", "2026-03-18"),
  rental("Madinat Al Irfan", "townhouse", 3, 210, 780, "monthly", "unfurnished", "2026-06-09"),
  rental("Madinat Al Irfan", "townhouse", 3, 220, 810, "monthly", "furnished", "2026-04-30"),

  // Ghubrah — apartments
  rental("Ghubrah", "apartment", 1, 64, 300, "monthly", "unfurnished", "2026-04-14"),
  rental("Ghubrah", "apartment", 1, 68, 315, "monthly", "furnished", "2026-05-23"),
  rental("Ghubrah", "apartment", 2, 106, 420, "monthly", "unfurnished", "2026-03-06"),
  rental("Ghubrah", "apartment", 2, 112, 440, "monthly", "semi_furnished", "2026-06-16")
];

export const SALE_FIXTURES: readonly SaleComparable[] = [
  // Al Mouj — apartments
  sale("Al Mouj", "apartment", 1, 78, 68_000, "furnished", "2026-04-01"),
  sale("Al Mouj", "apartment", 1, 84, 72_000, "unfurnished", "2026-05-10"),
  sale("Al Mouj", "apartment", 2, 130, 118_000, "furnished", "2026-03-15"),
  sale("Al Mouj", "apartment", 2, 138, 128_000, "semi_furnished", "2026-06-01"),
  sale("Al Mouj", "apartment", 3, 200, 175_000, "unfurnished", "2026-02-20"),

  // Al Mouj — villas
  sale("Al Mouj", "villa", 4, 400, 320_000, "unfurnished", "2026-04-18"),
  sale("Al Mouj", "villa", 4, 430, 355_000, "furnished", "2026-05-22"),
  sale("Al Mouj", "villa", 4, 420, 340_000, "semi_furnished", "2026-03-09"),

  // Al Mouj — townhouses: only one record on file.
  sale("Al Mouj", "townhouse", 3, 240, 195_000, "unfurnished", "2026-05-12"),

  // Muscat Hills — villas
  sale("Muscat Hills", "villa", 4, 370, 330_000, "unfurnished", "2026-04-06"),
  sale("Muscat Hills", "villa", 5, 470, 420_000, "furnished", "2026-05-16"),
  sale("Muscat Hills", "villa", 4, 385, 345_000, "semi_furnished", "2026-02-25"),

  // Qurum — apartments (Qurum villas: no sale fixtures either, same "no comparable data" case)
  sale("Qurum", "apartment", 1, 74, 58_000, "unfurnished", "2026-04-11"),
  sale("Qurum", "apartment", 2, 122, 98_000, "furnished", "2026-05-20"),
  sale("Qurum", "apartment", 3, 180, 138_000, "semi_furnished", "2026-03-01"),

  // Bausher — apartments and villas (villas: only two records)
  sale("Bausher", "apartment", 1, 70, 47_000, "unfurnished", "2026-04-23"),
  sale("Bausher", "apartment", 2, 114, 72_000, "furnished", "2026-05-04"),
  sale("Bausher", "villa", 3, 295, 205_000, "unfurnished", "2026-03-27"),
  sale("Bausher", "villa", 4, 345, 235_000, "semi_furnished", "2026-06-06")
];
