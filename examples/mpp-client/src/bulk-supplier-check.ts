/**
 * A realistic procurement agent: screen a list of Omani suppliers under one budgeted MPP
 * session, stop automatically when the remaining budget can't pay for another check, then close
 * and settle.
 *
 *   npm run bulk-supplier-check
 *
 * Each successful oman_supplier_check consumes $0.50 (Rafid's registry price). The agent never
 * computes prices itself: it reads `usage.remaining` from every response, and Rafid refuses
 * (before executing) any call that would exceed the budget with MPP_SESSION_BUDGET_EXCEEDED.
 */
import { assertMppEnabled, createPayingFetch, idempotencyKey, json, postJson } from "./lib.js";

const BUDGET_USD = Number(process.env.BULK_BUDGET_USD ?? "2");
const SUPPLIERS = [
  "Dhofar Poultry", "Oman Cables Industry", "Al Maha Petroleum Products", "Muscat Overseas", "Galfar Engineering",
  "Oman Flour Mills", "Renaissance Services", "Voltamp Energy", "National Aluminium Products", "Oman Chlorine"
];

await assertMppEnabled("session");
const { fetch: payingFetch } = createPayingFetch();

const created = await json(await postJson(payingFetch, "/api/v1/mpp/sessions", { maxBudget: BUDGET_USD, currency: "USD", allowedTools: ["oman_supplier_check"] }));
if (!created.success) throw new Error("Session creation failed: " + JSON.stringify(created.error));
const sessionId: string = created.data.sessionId;
console.log(`Session ${sessionId} open with ${created.data.maxBudget} USD`);

const results: { supplier: string; status: string; detail?: unknown }[] = [];
let remaining: number = created.data.remaining;
const PRICE_HINT = 0.5; // only used to stop early; Rafid remains authoritative

for (const supplier of SUPPLIERS) {
  if (remaining < PRICE_HINT) { console.log(`Stopping: remaining ${remaining} USD < ${PRICE_HINT}`); break; }
  const key = idempotencyKey("supplier");
  let res: Response | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    // Same Idempotency-Key on every retry: a network retry is never charged twice.
    try { res = await postJson(payingFetch, `/api/v1/mpp/sessions/${sessionId}/tools/oman_supplier_check`, { companyName: supplier }, { "Idempotency-Key": key }); break; }
    catch (error) { if (attempt === 3) throw error; }
  }
  const body = await json(res!);
  if (body.success) {
    remaining = body.usage.remaining;
    results.push({ supplier, status: "screened", detail: body.data?.screeningResult ?? null });
    console.log(`✓ ${supplier}: charged ${body.usage.charge}, remaining ${remaining}`);
  } else if (body.error?.code === "MPP_SESSION_BUDGET_EXCEEDED" || body.error?.code === "MPP_SESSION_EXHAUSTED") {
    console.log(`Budget reached (${body.error.code}); stopping.`);
    break;
  } else {
    results.push({ supplier, status: "error", detail: body.error });
    console.log(`✗ ${supplier}:`, body.error);
  }
}

const closed = await json(await postJson(payingFetch, `/api/v1/mpp/sessions/${sessionId}/close`, {}));
console.log("\nScreened:", results.filter(r => r.status === "screened").length, "of", SUPPLIERS.length);
console.table(results);
console.log("Final:", { spent: closed.data.spent, remaining: closed.data.remaining, calls: closed.data.calls, usageByTool: closed.data.usageByTool, settlement: closed.data.settlement });
