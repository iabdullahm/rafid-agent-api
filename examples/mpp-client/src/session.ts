/**
 * MPP session: reusable authorization + metered usage.
 *
 *   npm run session
 *
 * create $10 session → analyze_oman_property → oman_supplier_check → read remaining → close
 *
 * Opening the session opens a Tempo payment channel whose deposit is the budget (the payer's
 * funds stay in escrow). Each call signs one cumulative voucher; Rafid meters a call only after
 * it succeeded. Closing settles exactly the metered spend; the rest of the deposit returns to
 * the payer when the channel closes.
 */
import { assertMppEnabled, createPayingFetch, idempotencyKey, json, postJson } from "./lib.js";

await assertMppEnabled("session");
const { fetch: payingFetch, address } = createPayingFetch();
console.log("Agent wallet:", address);

// 1. Create a $10 session (402 → mppx opens the channel → 201).
const created = await json(await postJson(payingFetch, "/api/v1/mpp/sessions", {
  maxBudget: 10, currency: "USD", allowedTools: ["analyze_oman_property", "oman_supplier_check"]
}));
if (!created.success) throw new Error("Session creation failed: " + JSON.stringify(created.error));
const sessionId: string = created.data.sessionId;
console.log(`Session ${sessionId}: ${created.data.status}, budget ${created.data.maxBudget} USD`);

// 2. Calls under the session (each 402 voucher challenge is answered automatically by mppx).
const call = async (tool: string, input: unknown) => {
  const res = await postJson(payingFetch, `/api/v1/mpp/sessions/${sessionId}/tools/${tool}`, input, { "Idempotency-Key": idempotencyKey(tool) });
  const body = await json(res);
  if (!body.success) throw new Error(`${tool} failed: ${JSON.stringify(body.error)}`);
  console.log(`${tool}: charged ${body.usage.charge}, spent ${body.usage.spent}, remaining ${body.usage.remaining}`);
  return body.data;
};
await call("analyze_oman_property", { governorate: "Muscat", area: "Al Mouj", propertyType: "villa", bedrooms: 4, sizeSqm: 420, askingPriceOMR: 450000 });
await call("oman_supplier_check", { companyName: "Dhofar Poultry", requiredProductOrService: "Frozen poultry supply" });

// 3. Read remaining budget.
const view = await json(await fetch(`${process.env.RAFID_BASE_URL ?? "https://api.rafidsystem.com"}/api/v1/mpp/sessions/${sessionId}`));
console.log("Remaining:", view.data.remaining, "USD; usage by tool:", view.data.usageByTool);

// 4. Close + settle.
const closed = await json(await postJson(payingFetch, `/api/v1/mpp/sessions/${sessionId}/close`, {}));
console.log("Closed:", closed.data.status, "settlement:", closed.data.settlement);
