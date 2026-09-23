/**
 * Rafid Agent API — pay for a tool call with prepaid API credits (no crypto wallet).
 *
 *   RAFID_API_KEY=raf_live_… node call-paid-tool.ts            (Node 24 runs .ts directly)
 *   RAFID_API_KEY=raf_live_… TOOL_PATH=/finance/invoice-anomaly-check TOOL_INPUT='{…}' node call-paid-tool.ts
 *
 * Prints the balance before, the charge the server reports, and the balance after, so you can
 * see the debit happen exactly once. Re-running with the same IDEMPOTENCY_KEY replays the first
 * response instead of charging again.
 */
const BASE_URL = (process.env.RAFID_BASE_URL ?? "https://api.rafidsystem.com").replace(/\/+$/, "");
const API_KEY = process.env.RAFID_API_KEY;
const TOOL_PATH = process.env.TOOL_PATH ?? "/intelligence/research-company";
const TOOL_INPUT = process.env.TOOL_INPUT ?? JSON.stringify({ company: "Stripe", country: "United States", depth: "standard" });
const IDEMPOTENCY_KEY = process.env.IDEMPOTENCY_KEY ?? crypto.randomUUID();
const PAYMENT_METHOD = process.env.RAFID_PAYMENT_METHOD ?? "auto"; // auto | credits | subscription

if (!API_KEY) {
  console.error("Set RAFID_API_KEY=raf_live_… (ask the Rafid operator for a key, or see docs/billing.md)");
  process.exit(1);
}
const auth = { Authorization: `Bearer ${API_KEY}` };

async function balance(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/v1/account/balance`, { headers: auth });
  const body = await res.json() as { data?: { credits: { available: string } } };
  return body.data?.credits.available ?? `unavailable (HTTP ${res.status})`;
}

const before = await balance();
const response = await fetch(`${BASE_URL}/api/v1${TOOL_PATH}`, {
  method: "POST",
  headers: { ...auth, "Content-Type": "application/json", "Idempotency-Key": IDEMPOTENCY_KEY, "X-Rafid-Payment-Method": PAYMENT_METHOD },
  body: TOOL_INPUT
});
const body = await response.json() as {
  success: boolean;
  data?: unknown;
  meta?: { tool: string; billing?: { rail: string; amount: string; remainingBalance?: string; subscriptionRemaining?: string; transactionId?: string } };
  error?: { code: string; message: string };
  price?: { amount: string }; balance?: { amount: string }; paymentOptions?: unknown;
};

console.log(`POST ${TOOL_PATH} → HTTP ${response.status}${response.headers.get("idempotent-replay") ? " (idempotent replay — not charged again)" : ""}`);
if (response.ok && body.success) {
  const b = body.meta?.billing;
  console.log(`tool:            ${body.meta?.tool}`);
  console.log(`rail:            ${b?.rail}`);
  console.log(`charged:         $${b?.amount}`);
  if (b?.remainingBalance) console.log(`balance (server): $${b.remainingBalance}`);
  if (b?.subscriptionRemaining) console.log(`allowance left:  $${b.subscriptionRemaining}`);
  console.log(`transaction:     ${b?.transactionId}`);
  console.log(`idempotency key: ${IDEMPOTENCY_KEY}`);
  console.log(`balance:         $${before} → $${await balance()}`);
  console.log("result:", JSON.stringify(body.data, null, 2).slice(0, 800));
} else if (response.status === 402) {
  console.log(`payment needed:  ${body.error?.code} — price $${body.price?.amount}, balance $${body.balance?.amount ?? "n/a"}`);
  console.log("other options:  ", JSON.stringify(body.paymentOptions));
  process.exitCode = 2;
} else {
  console.log(`error:           ${body.error?.code}: ${body.error?.message}`);
  process.exitCode = 1;
}
