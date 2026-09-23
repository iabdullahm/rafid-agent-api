/**
 * Exact money arithmetic for the unified billing ledger.
 *
 * Every balance, price, allowance and ledger amount is an INTEGER number of micro-USD
 * (1 USD = 1_000_000 micros). JavaScript floating-point is never used for a balance: prices
 * (declared once as a USD decimal on each capability in src/domain/capabilities.ts) are
 * converted to micros exactly once, through a decimal-string conversion rather than `x * 1e6`,
 * and all arithmetic afterwards is integer addition/subtraction (in SQL for the Postgres store,
 * in safe-integer JS for the in-memory store). Number.MAX_SAFE_INTEGER micros is ~9 billion USD,
 * so a safe JS integer comfortably holds any single account balance; every conversion asserts it.
 */
export const MICROS_PER_USD = 1_000_000;

export class MoneyError extends Error {}

function assertSafe(n: number): number {
  if (!Number.isSafeInteger(n)) throw new MoneyError("Amount is outside the exact integer range");
  return n;
}

/** Parses a decimal USD amount ("10", "0.15", "-2.5", 0.15) into integer micros, exactly.
 *  More than 6 fractional digits is rejected rather than silently rounded. */
export function usdToMicros(value: string | number): number {
  const text = typeof value === "number" ? numberToPlainString(value) : value.trim();
  const m = /^(-)?(\d+)(?:\.(\d{1,6}))?$/.exec(text);
  if (!m) throw new MoneyError(`Invalid USD amount "${String(value)}" (use a decimal with at most 6 fractional digits)`);
  const whole = Number(m[2]);
  const frac = Number((m[3] ?? "").padEnd(6, "0"));
  const micros = assertSafe(whole * MICROS_PER_USD + frac);
  return m[1] ? -micros : micros;
}

/** A JS number (e.g. a capability's `price: 0.15`) as a plain decimal string, rounded to 6
 *  fractional digits — the documented precision of every price in the registry. */
function numberToPlainString(n: number): string {
  if (!Number.isFinite(n)) throw new MoneyError("Amount must be finite");
  return n.toFixed(6).replace(/\.?0+$/, "") || "0";
}

/** Integer micros → decimal USD string with at least 2 and at most 6 fractional digits
 *  (150000 → "0.15", 8350000 → "8.35", 1 → "0.000001", -2000000 → "-2.00"). */
export function formatMicros(micros: number | bigint): string {
  const big = BigInt(micros);
  const negative = big < 0n;
  const abs = negative ? -big : big;
  const whole = abs / 1_000_000n;
  let frac = (abs % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${frac}`;
}

/** Parses a value read back from PostgreSQL BIGINT (node-postgres returns it as a string). */
export function microsFromDb(value: unknown): number {
  const n = typeof value === "number" ? value : Number(String(value));
  return assertSafe(n);
}

export const money = (micros: number) => ({ amount: formatMicros(micros), currency: "USD" as const });
