import { z } from "zod";

// ISO 3166-1 alpha-2 codes. Kept as data (rather than accepting arbitrary two letters)
// so agents receive a useful validation error before a paid execution is admitted.
export const ISO_ALPHA2_CODES = new Set(`AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW`.split(/\s+/));

const text = (max: number) => z.string().trim().min(1).max(max);
const location = z.strictObject({
  country: text(2).refine(v => ISO_ALPHA2_CODES.has(v.toUpperCase()), "country must be an ISO 3166-1 alpha-2 code"),
  postalCode: text(20).optional(),
  city: text(100).optional()
});

export const shippingCostEstimateInput = z.strictObject({
  origin: location,
  destination: location,
  shipment: z.strictObject({
    weightKg: z.number().finite().positive().max(100_000),
    lengthCm: z.number().finite().positive().max(1_000).optional(),
    widthCm: z.number().finite().positive().max(1_000).optional(),
    heightCm: z.number().finite().positive().max(1_000).optional(),
    quantity: z.number().int().min(1).max(10_000).default(1),
    declaredValue: z.number().finite().min(0).max(100_000_000).optional(),
    category: text(60).optional()
  }),
  shippingMode: z.enum(["courier", "air", "sea", "road", "postal", "auto"]).default("auto"),
  serviceLevel: z.enum(["economy", "standard", "express", "auto"]).default("auto"),
  currency: text(3).refine(v => /^[A-Za-z]{3}$/.test(v), "currency must be a 3-letter ISO 4217 code").default("USD")
});

export type ShippingEstimateInput = z.infer<typeof shippingCostEstimateInput>;
