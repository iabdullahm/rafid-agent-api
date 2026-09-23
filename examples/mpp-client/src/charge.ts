/**
 * MPP charge: one-time machine payment for exactly one tool call.
 *
 *   npm run charge
 *
 * 1. POST /api/v1/mpp/charge/analyze_oman_property without payment → 402 + WWW-Authenticate: Payment
 * 2. mppx pays the challenge ($0.25 — the price comes from Rafid's capability registry)
 * 3. retried request → 200 with the normal tool output and a Payment-Receipt header
 */
import { BASE_URL, assertMppEnabled, createPayingFetch, json, postJson } from "./lib.js";

await assertMppEnabled("charge");

// Unpaid probe with plain fetch: see exactly what the agent is asked to pay.
const quote = await postJson(fetch, "/api/v1/mpp/charge/analyze_oman_property", EXAMPLE());
const q = await json(quote);
console.log(`402 quote: ${q.tool} costs ${q.amount} ${q.currency}; offered methods:`, q.challenges?.map((c: any) => `${c.method}/${c.intent}`));

const { fetch: payingFetch, address } = createPayingFetch();
console.log("Paying from", address, "→", BASE_URL);
const res = await postJson(payingFetch, "/api/v1/mpp/charge/analyze_oman_property", EXAMPLE());
const body = await json(res);
console.log("status:", res.status);
console.log("payment:", body.payment);
console.log("receipt header present:", Boolean(res.headers.get("payment-receipt")));
console.log("result keys:", body.data ? Object.keys(body.data) : body);

function EXAMPLE() {
  return { governorate: "Muscat", area: "Al Mouj", propertyType: "villa", bedrooms: 4, sizeSqm: 420, askingPriceOMR: 450000 };
}
