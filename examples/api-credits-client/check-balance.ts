/**
 * Rafid Agent API — show the API key's prepaid credit balance, subscription allowance, usage
 * per tool, and the most recent ledger transactions.
 *
 *   RAFID_API_KEY=raf_live_… node check-balance.ts
 */
const BASE_URL = (process.env.RAFID_BASE_URL ?? "https://api.rafidsystem.com").replace(/\/+$/, "");
const API_KEY = process.env.RAFID_API_KEY;
if (!API_KEY) { console.error("Set RAFID_API_KEY=raf_live_…"); process.exit(1); }

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, { headers: { Authorization: `Bearer ${API_KEY}` } });
  const body = await res.json() as { success: boolean; data: T; error?: { code: string; message: string } };
  if (!res.ok || !body.success) throw new Error(`${path}: HTTP ${res.status} ${body.error?.code ?? ""} ${body.error?.message ?? ""}`);
  return body.data;
}

type Balance = { accountId: string; credits: { available: string; currency: string }; subscription: null | { plan: string; periodEndsAt: string; included: string; used: string; remaining: string } };
type Usage = { since: string; tools: { tool: string; rail: string; calls: number; charged: { amount: string } }[]; total: { amount: string } };
type Txns = { transactions: { id: string; createdAt: string; type: string; rail: string; tool: string | null; amount: string; direction: string; status: string }[] };

const balance = await get<Balance>("/api/v1/account/balance");
console.log(`account ${balance.accountId}`);
console.log(`prepaid credits: $${balance.credits.available} ${balance.credits.currency}`);
if (balance.subscription) {
  const s = balance.subscription;
  console.log(`subscription:    ${s.plan} — $${s.used} of $${s.included} used, $${s.remaining} left (period ends ${s.periodEndsAt})`);
} else console.log("subscription:    none");

const usage = await get<Usage>("/api/v1/account/usage");
console.log(`\nusage since ${usage.since}: $${usage.total.amount}`);
for (const u of usage.tools) console.log(`  ${u.tool.padEnd(28)} ${u.rail.padEnd(13)} ${String(u.calls).padStart(4)} calls  $${u.charged.amount}`);

const { transactions } = await get<Txns>("/api/v1/account/transactions?limit=10");
console.log("\nrecent transactions:");
for (const t of transactions) console.log(`  ${t.createdAt}  ${t.type.padEnd(18)} ${(t.direction === "debit" ? "-" : "+") + "$" + t.amount}`.padEnd(70) + ` ${t.status.padEnd(9)} ${t.tool ?? ""}`);
