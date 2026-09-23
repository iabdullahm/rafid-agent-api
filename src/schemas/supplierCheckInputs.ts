import { z } from "zod";
import { normalizeWebsite } from "../supplier-check/normalize.js";

/**
 * oman_supplier_check input. Only companyName is required; every other field is optional
 * evidence the procurement agent already holds (from the supplier's quotation, email signature,
 * letterhead...). Validation here is structural (lengths, character sets, plausible formats);
 * semantic normalization (Oman phone formats, domains, Arabic name variants) happens in
 * src/supplier-check/normalize.ts so the normalized form can be echoed back to the caller.
 */
export const omanSupplierCheckInput = z.strictObject({
  companyName: z.string().trim().min(2).max(200),
  crNumber: z.string().trim().min(3).max(30).regex(/^[0-9A-Za-z][0-9A-Za-z\s\-/.]*$/, "crNumber may contain only letters, digits, spaces, dashes, dots and slashes").optional(),
  website: z.string().trim().min(4).max(300).refine(v => normalizeWebsite(v) !== null, "website must be a valid http(s) URL or domain").optional(),
  email: z.string().trim().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, "email must be a valid email address").optional(),
  phone: z.string().trim().min(6).max(30).regex(/^[+0-9\s()\-.xX*]+$/, "phone may contain only digits, spaces, +, -, ., parentheses and placeholder X").optional(),
  address: z.string().trim().min(2).max(300).optional(),
  requiredProductOrService: z.string().trim().min(2).max(200).optional()
});

export type OmanSupplierCheckInput = z.input<typeof omanSupplierCheckInput>;
