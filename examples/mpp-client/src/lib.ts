import { Mppx, tempo, evm } from "mppx/client";
import { Assets } from "mppx/evm";
import { privateKeyToAccount } from "viem/accounts";

/**
 * Shared setup for the example agents. The payer key comes ONLY from the environment
 * (MPP_CLIENT_PRIVATE_KEY) and never leaves this process — mppx signs locally and sends only the
 * resulting credential (Authorization: Payment …).
 */
// Load examples/mpp-client/.env (Node >= 20.12). Real environment variables take precedence.
try { (process as { loadEnvFile?: (path?: string) => void }).loadEnvFile?.(".env"); } catch { /* no .env: use the environment */ }

export const BASE_URL = (process.env.RAFID_BASE_URL ?? "https://api.rafidsystem.com").replace(/\/$/, "");

export function requireKey(): `0x${string}` {
  const key = process.env.MPP_CLIENT_PRIVATE_KEY?.trim();
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
    console.error("Set MPP_CLIENT_PRIVATE_KEY (0x-prefixed 32-byte hex) in .env — a dedicated payer wallet, never your main one.");
    process.exit(1);
  }
  return key as `0x${string}`;
}

/** An MPP-aware fetch: on HTTP 402 it picks a supported challenge, pays/signs it and retries
 *  the same request with `Authorization: Payment <credential>`. Tempo covers charge + session;
 *  evm/charge (Base USDC) is included for deployments that offer it. */
export function createPayingFetch() {
  const account = privateKeyToAccount(requireKey());
  const mppx = Mppx.create({
    polyfill: false,
    methods: [
      tempo({ account, maxDeposit: process.env.MPP_CLIENT_MAX_DEPOSIT ?? "10" }),
      evm.charge({ account, currencies: [Assets.base.USDC, Assets.baseSepolia.USDC] })
    ] as never
  });
  return { fetch: mppx.fetch as typeof fetch, address: account.address };
}

export async function json(res: Response): Promise<any> {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

export function postJson(f: typeof fetch, path: string, body: unknown, headers: Record<string, string> = {}) {
  return f(BASE_URL + path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
}

/** One Idempotency-Key per logical call: a retry of the SAME call reuses it and is never charged twice. */
export const idempotencyKey = (label: string) => `${label}-${crypto.randomUUID()}`;

export async function assertMppEnabled(mode: "charge" | "session") {
  const status = await json(await fetch(BASE_URL + "/api/v1/mpp/status"));
  if (!status?.data?.enabled || !status.data.modes.includes(mode)) {
    console.error(`MPP ${mode} mode is not enabled on ${BASE_URL} (GET /api/v1/mpp/status →`, JSON.stringify(status?.data), ")");
    process.exit(1);
  }
}
